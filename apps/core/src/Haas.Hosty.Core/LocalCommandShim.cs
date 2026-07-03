using System.Runtime.InteropServices;

namespace Haas.Hosty.Core;

// A tiny in-process supervisor Core re-execs ITSELF into (same binary, hidden verb) so a spawned
// localCommand root becomes a POSIX process-group leader. .NET cannot call setsid between fork and
// exec, so the leader identity is established here, in the child, before it launches the shell.
internal static class LocalCommandShim
{
    public const string Verb = "__local-command-shim";

    public static async Task<int> RunAsync(string[] args)
    {
        var command = args[1];

        // Detach into a new session/process group so this shim is the group leader; the shell and its
        // descendants inherit the group. A later Core reclaims the whole tree via kill(-pgid). setsid
        // fails (-1) only when we are already a leader, which is fine — the group id still equals our pid.
        UnixProcessControl.SetSid();

        // No stream redirection: the shim inherits Core's stdio, which are the pipes Core attached to
        // this process, so `/bin/sh` writes straight into Core's log-capture pipes as before. Working
        // directory and environment are inherited from the shim (which inherited them from Core).
        using var child = new System.Diagnostics.Process
        {
            StartInfo = new System.Diagnostics.ProcessStartInfo
            {
                FileName = "/bin/sh",
                UseShellExecute = false,
            },
            EnableRaisingEvents = true,
        };
        child.StartInfo.ArgumentList.Add("-c");
        child.StartInfo.ArgumentList.Add(command);

        try
        {
            child.Start();
        }
        catch (Exception ex)
        {
            await Console.Error.WriteLineAsync($"[hosty] local command shim failed to start: {ex.Message}");
            return 127;
        }

        await child.WaitForExitAsync();
        return child.ExitCode;
    }

    // The shim path is the running binary itself. Null (adapter falls back to a direct spawn) when the
    // verb cannot be served: on Windows, or under a dll-hosted run where ProcessPath is the `dotnet`
    // muxer rather than a single-file Core that re-execs into RunAsync.
    public static string? ResolveShimPath()
    {
        if (OperatingSystem.IsWindows())
        {
            return null;
        }

        var path = Environment.ProcessPath;
        if (string.IsNullOrEmpty(path))
        {
            return null;
        }

        return string.Equals(Path.GetFileNameWithoutExtension(path), "dotnet", StringComparison.OrdinalIgnoreCase)
            ? null
            : path;
    }
}

// libc process-group primitives. Blittable ints only — AOT-clean, no marshalling. The whole reclaim
// rests on one POSIX guarantee: a PID cannot be recycled while it is the process-group id of any live
// group. So once our spawned root is a group leader (its pgid == its pid), kill(-pgid, ...) can only
// ever reach members of OUR group or fail with ESRCH — never an unrelated process.
internal static class UnixProcessControl
{
    private const int EPERM = 1;

    [DllImport("libc", SetLastError = true)]
    private static extern int setsid();

    [DllImport("libc", SetLastError = true)]
    private static extern int kill(int pid, int sig);

    public static void SetSid()
    {
        if (!OperatingSystem.IsWindows())
        {
            _ = setsid();
        }
    }

    public static void TryKillProcessGroup(int pgid)
    {
        // Guard pgid > 1: kill(-1, ...) signals every process the caller may signal, and kill(0, ...)
        // targets the caller's own group. Neither is ever a legitimate reclaim target.
        if (OperatingSystem.IsWindows() || pgid <= 1)
        {
            return;
        }

        _ = kill(-pgid, 9);
    }

    // Probes whether a process group still has live members. kill(-pgid, 0) sends no signal; it only
    // resolves the group. A distinct "exists but not ours" result (EPERM) lets the caller warn and skip
    // rather than blindly attempting a kill on a group it does not own.
    public static ProcessGroupProbe ProbeProcessGroup(int pgid)
    {
        if (OperatingSystem.IsWindows() || pgid <= 1)
        {
            return ProcessGroupProbe.Absent;
        }

        if (kill(-pgid, 0) == 0)
        {
            return ProcessGroupProbe.Present;
        }

        return Marshal.GetLastPInvokeError() == EPERM ? ProcessGroupProbe.Foreign : ProcessGroupProbe.Absent;
    }

    public static bool ProcessGroupExists(int pgid)
        => ProbeProcessGroup(pgid) == ProcessGroupProbe.Present;
}

internal enum ProcessGroupProbe
{
    // No live member resolves (ESRCH) — the group is gone.
    Absent,
    // At least one live member; the group is ours to reclaim.
    Present,
    // Members exist but signalling is denied (EPERM) — not our group; skip and warn, never kill.
    Foreign,
}

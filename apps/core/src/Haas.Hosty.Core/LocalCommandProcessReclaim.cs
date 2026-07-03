using System.Text.Json;
using Microsoft.Extensions.Logging;

namespace Haas.Hosty.Core;

// A durable record of a spawned localCommand root, written under {AppRoot}/run/{serviceKey}.json. It
// survives a Core crash (macOS sleep/wake, kill -9, abandoned shutdown) so a future Core can find and
// kill an orphaned process tree the in-memory registry lost. ProcessGroup records whether Pid is a
// process-group leader (spawned through the setsid shim), which selects the reclaim path.
internal sealed record LocalCommandPidFile(
    int Pid,
    DateTimeOffset StartedAtUtc,
    string AppId,
    string ServiceKey,
    bool ProcessGroup);

internal static class LocalCommandProcessReclaim
{
    private static readonly TimeSpan StartTimeTolerance = TimeSpan.FromSeconds(2);
    private static readonly TimeSpan KillWaitTimeout = TimeSpan.FromSeconds(5);
    private static readonly TimeSpan GroupPollInterval = TimeSpan.FromMilliseconds(100);

    public static string PidFilePath(string appRoot, string serviceKey)
        => Path.Combine(appRoot, "run", $"{serviceKey}.json");

    public static Task WriteAsync(string appRoot, LocalCommandPidFile pidFile, CancellationToken cancellationToken = default)
        => JsonStorage.WriteAsync(PidFilePath(appRoot, pidFile.ServiceKey), pidFile, cancellationToken);

    // PID-reuse guard: the recorded start time must match the live process's, within a tolerance that
    // absorbs the sub-second rounding difference between what we recorded and what the OS reports.
    public static bool StartTimeMatches(DateTimeOffset recorded, DateTime processStartTime)
        => (processStartTime.ToUniversalTime() - recorded.UtcDateTime).Duration() <= StartTimeTolerance;

    // Reads {AppRoot}/run/{serviceKey}.json and kills the recorded process tree if it is still ours,
    // then always removes the file. Returns whether anything was killed. Safe to call when no pidfile
    // exists (returns false) — it is both the startup-sweep entry point and the stop-time fallback that
    // reaps orphans a previous Core left behind.
    public static async Task<bool> ReclaimAsync(string appRoot, string serviceKey, ILogger? logger = null, CancellationToken cancellationToken = default)
    {
        var path = PidFilePath(appRoot, serviceKey);
        LocalCommandPidFile? pidFile;
        try
        {
            pidFile = await JsonStorage.ReadAsync<LocalCommandPidFile>(path, cancellationToken);
        }
        catch (JsonException)
        {
            TryDeleteFile(path);
            return false;
        }

        if (pidFile is null)
        {
            return false;
        }

        if (pidFile.Pid <= 1)
        {
            TryDeleteFile(path);
            return false;
        }

        try
        {
            return await ReclaimRecordedProcessAsync(pidFile, logger, cancellationToken);
        }
        finally
        {
            TryDeleteFile(path);
        }
    }

    private static async Task<bool> ReclaimRecordedProcessAsync(LocalCommandPidFile pidFile, ILogger? logger, CancellationToken cancellationToken)
    {
        var leader = TryGetProcess(pidFile.Pid);
        var leaderStartTime = TryReadStartTime(leader);

        if (pidFile.ProcessGroup && !OperatingSystem.IsWindows())
        {
            if (leader is not null && leaderStartTime is { } started)
            {
                if (!StartTimeMatches(pidFile.StartedAtUtc, started))
                {
                    // The pid was recycled onto an unrelated process. By the pgid-pinning guarantee our
                    // group could not have outlived its leader, so the whole tree is already dead — do
                    // NOT kill the impostor.
                    return false;
                }

                UnixProcessControl.TryKillProcessGroup(pidFile.Pid);
                await WaitForProcessExitAsync(leader, cancellationToken);
                return true;
            }

            // Leader gone but the group may still have survivors reparented to PID 1. Pgid pinning keeps
            // the id reserved while any member lives, so a live group here is provably OURS to reap.
            var probe = UnixProcessControl.ProbeProcessGroup(pidFile.Pid);
            if (probe == ProcessGroupProbe.Present)
            {
                UnixProcessControl.TryKillProcessGroup(pidFile.Pid);
                await WaitForGroupExitAsync(pidFile.Pid, cancellationToken);
                return true;
            }

            if (probe == ProcessGroupProbe.Foreign)
            {
                // The recorded pid was recycled into a process group owned by another user (the kill
                // probe returned EPERM). By pgid pinning our own tree is already gone, so we leave the
                // foreign group untouched and only clear our stale record below.
                logger?.LogWarning(
                    "localCommand reclaim for {AppId}/{Service}: pgid {Pid} resolves to a process group this Core cannot signal (EPERM); leaving it untouched.",
                    pidFile.AppId, pidFile.ServiceKey, pidFile.Pid);
            }

            return false;
        }

        // Non-group path (a direct spawn, or Windows): only the recorded leader is reachable. Verify the
        // start time before killing so a recycled pid is never mistaken for our process.
        if (leader is not null && leaderStartTime is { } directStart && StartTimeMatches(pidFile.StartedAtUtc, directStart))
        {
            try
            {
                leader.Kill(entireProcessTree: true);
            }
            catch (Exception ex) when (ex is InvalidOperationException or System.ComponentModel.Win32Exception)
            {
                // Already exited between the liveness read and the kill, or could not be terminated;
                // reclaim is best-effort, so this must not surface to the stop/start flow.
            }

            await WaitForProcessExitAsync(leader, cancellationToken);
            return true;
        }

        return false;
    }

    private static System.Diagnostics.Process? TryGetProcess(int pid)
    {
        try
        {
            return System.Diagnostics.Process.GetProcessById(pid);
        }
        catch (Exception ex) when (ex is ArgumentException or InvalidOperationException)
        {
            // ArgumentException = no process with this id (dead); InvalidOperationException = it could
            // not be located. Either way there is no handle to verify/kill — on the real (process-group)
            // path the pgid probe still reaps any surviving member, so no orphan is missed.
            return null;
        }
    }

    // Reading StartTime (or HasExited) can throw if the process exits mid-read or is no longer
    // inspectable; treat any failure as "not a live process we can verify".
    private static DateTime? TryReadStartTime(System.Diagnostics.Process? process)
    {
        if (process is null)
        {
            return null;
        }

        try
        {
            return process.HasExited ? null : process.StartTime;
        }
        catch (Exception ex) when (ex is InvalidOperationException or System.ComponentModel.Win32Exception)
        {
            return null;
        }
    }

    private static async Task WaitForProcessExitAsync(System.Diagnostics.Process process, CancellationToken cancellationToken)
    {
        try
        {
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            timeout.CancelAfter(KillWaitTimeout);
            await process.WaitForExitAsync(timeout.Token);
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            // The kill was issued; a stubborn exit within the window is best-effort only.
        }
        catch (Exception ex) when (ex is InvalidOperationException or SystemException)
        {
            // The handle may already be gone — that is the outcome we wanted.
        }
    }

    private static async Task WaitForGroupExitAsync(int pgid, CancellationToken cancellationToken)
    {
        // Monotonic clock so a wall-clock adjustment (NTP step, sleep/wake) cannot skew the deadline.
        var stopwatch = System.Diagnostics.Stopwatch.StartNew();
        while (stopwatch.Elapsed < KillWaitTimeout && UnixProcessControl.ProcessGroupExists(pgid))
        {
            try
            {
                await Task.Delay(GroupPollInterval, cancellationToken);
            }
            catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
            {
                return;
            }
        }
    }

    private static void TryDeleteFile(string path)
    {
        try
        {
            File.Delete(path);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            // Best-effort: a lingering pidfile is re-evaluated (and re-deleted) on the next reclaim.
        }
    }
}

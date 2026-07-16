using System.Diagnostics;

namespace Haas.Hosty.Core;

// Spawns the managed `hosty` CLI detached from Core so it outlives the current process — Core is an
// unsupervised detached process and cannot relaunch/replace itself from inside a request. Used by the
// admin restart (`hosty core restart --keep-apps`) and update (`hosty update`) endpoints. The child
// inherits Core's environment (HOSTY_DATA_ROOT etc.), so it finds the same control discovery and launch
// settings. Mirrors the CLI's own detached-start pattern: nohup + shell on Unix, a non-awaited cmd.exe on
// Windows.
internal static class CoreCliLauncher
{
    // How long the Windows spawn watches the helper for an immediate death. `cmd /c` runs the whole
    // helper command (an update takes minutes), so a healthy spawn is still alive after this probe —
    // only an instant failure (the log redirect, a bad CLI path) exits this fast.
    private static readonly TimeSpan WindowsSpawnFailureProbe = TimeSpan.FromMilliseconds(1500);

    // Locates the managed `hosty` CLI: the launcher passes its own path via HOSTY_CLI_PATH when it starts
    // Core (survives across light restarts because each restart re-launches Core through the CLI), with a
    // PATH lookup as a fallback for a Core that predates that env or was started by other means.
    public static string? ResolveCliPath()
    {
        var configured = Environment.GetEnvironmentVariable("HOSTY_CLI_PATH");
        if (!string.IsNullOrWhiteSpace(configured) && File.Exists(configured))
        {
            return configured;
        }

        var executableName = OperatingSystem.IsWindows() ? "hosty.exe" : "hosty";
        var pathVariable = Environment.GetEnvironmentVariable("PATH");
        if (string.IsNullOrEmpty(pathVariable))
        {
            return null;
        }

        foreach (var directory in pathVariable.Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            var candidate = Path.Combine(directory, executableName);
            if (File.Exists(candidate))
            {
                return candidate;
            }
        }

        return null;
    }

    // Spawns `<cli> <args...>` detached, streaming its output to a fresh, uniquely named log file in
    // {DataRoot}/core/logs (derived from logFileName; the path is returned). Every spawn gets its own
    // file: the redirect handle leaks into whatever the helper starts — on Windows the replacement Core
    // and the app trees it spawns can keep it open long after the helper exits — so reusing one name
    // would fail the next spawn's redirect with a sharing violation, the same wedge PR #192 fixed for
    // core.log. Logs of earlier spawns are deleted best-effort; a file a surviving tree still holds just
    // stays until that tree exits.
    public static string SpawnDetached(string cliPath, IReadOnlyList<string> args, HostyCoreRuntimeConfig config, string logFileName)
    {
        var logDirectory = Path.Combine(config.DataRoot, "core", "logs");
        Directory.CreateDirectory(logDirectory);
        CleanUpStaleLogs(logDirectory, logFileName);
        var logPath = Path.Combine(logDirectory, BuildLogFileName(logFileName, DateTimeOffset.UtcNow));
        var workingDirectory = Path.GetDirectoryName(cliPath) ?? config.DataRoot;

        if (OperatingSystem.IsWindows())
        {
            var command = $"{CmdQuote(cliPath)} {string.Join(' ', args.Select(CmdQuote))} > {CmdQuote(logPath)} 2>&1";
            var startInfo = new ProcessStartInfo
            {
                FileName = Environment.GetEnvironmentVariable("ComSpec") ?? "cmd.exe",
                Arguments = $"/d /s /c \"{command}\"",
                UseShellExecute = false,
                CreateNoWindow = true,
                WorkingDirectory = workingDirectory,
            };
            using var process = Process.Start(startInfo) ?? throw new InvalidOperationException("Unable to start the hosty helper process.");
            // cmd /c cannot be awaited from a request (the helper runs for minutes), but an immediate
            // exit is always a failure — without this probe the caller has already answered "updating"
            // and the operator waits forever on a helper that never ran.
            if (process.WaitForExit((int)WindowsSpawnFailureProbe.TotalMilliseconds) && process.ExitCode != 0)
            {
                throw new InvalidOperationException(
                    $"Helper exited immediately with code {process.ExitCode} before the operation could start; check {logPath} if it exists.");
            }

            return logPath;
        }

        var quotedArgs = string.Join(' ', args.Select(ShellQuote));
        var shellCommand = $"nohup {ShellQuote(cliPath)} {quotedArgs} > {ShellQuote(logPath)} 2>&1 &";
        var unixStartInfo = new ProcessStartInfo
        {
            FileName = "/bin/sh",
            UseShellExecute = false,
            CreateNoWindow = true,
            WorkingDirectory = workingDirectory,
        };
        unixStartInfo.ArgumentList.Add("-c");
        unixStartInfo.ArgumentList.Add(shellCommand);

        using var unixProcess = Process.Start(unixStartInfo) ?? throw new InvalidOperationException("Unable to start the hosty helper process.");
        // The `&` returns immediately from the shell wrapper; the nohup'd CLI is detached and survives.
        unixProcess.WaitForExit();
        if (unixProcess.ExitCode != 0)
        {
            throw new InvalidOperationException($"Helper launch shell exited with code {unixProcess.ExitCode}.");
        }

        return logPath;
    }

    // The stamp appended to each spawn's log name; also the exact shape CleanUpStaleLogs requires
    // before deleting anything, so the two stay in sync through this constant.
    private const string SpawnLogTimestampFormat = "yyyyMMdd-HHmmssfff";

    // "core-update.log" + 2026-07-16T13:00:45.123Z -> "core-update-20260716-130045123.log". The stamp
    // keeps concurrent/consecutive spawns off each other's redirect handles; millisecond precision is
    // enough because a same-instant duplicate only reproduces the shared-name failure the probe reports.
    internal static string BuildLogFileName(string baseFileName, DateTimeOffset timestamp)
    {
        var stem = Path.GetFileNameWithoutExtension(baseFileName);
        var extension = Path.GetExtension(baseFileName);
        var stamp = timestamp.UtcDateTime.ToString(SpawnLogTimestampFormat, System.Globalization.CultureInfo.InvariantCulture);
        return $"{stem}-{stamp}{extension}";
    }

    // Deletes earlier spawns' logs for this base name (timestamped ones and the legacy fixed name) so
    // they do not accumulate. Only names BuildLogFileName could have produced are touched — an
    // operator's own file that happens to share the prefix (say core-update-notes.log) is not ours to
    // delete. Best-effort: a log still held open by a surviving helper tree cannot be deleted on
    // Windows and is simply left for a later pass.
    internal static void CleanUpStaleLogs(string logDirectory, string baseFileName)
    {
        var stem = Path.GetFileNameWithoutExtension(baseFileName);
        var extension = Path.GetExtension(baseFileName);
        IEnumerable<string> staleLogs;
        try
        {
            staleLogs =
            [
                .. Directory.EnumerateFiles(logDirectory, $"{stem}-*{extension}")
                    .Where(path => HasSpawnLogTimestamp(Path.GetFileName(path), stem, extension)),
                Path.Combine(logDirectory, baseFileName),
            ];
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return;
        }

        foreach (var staleLog in staleLogs)
        {
            try
            {
                File.Delete(staleLog);
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                // Still open (e.g. inherited by a process tree that outlived its helper) — leave it.
            }
        }
    }

    // True when fileName is exactly "{stem}-{SpawnLogTimestampFormat}{extension}". The enumeration
    // pattern already pins the prefix and suffix; this pins the middle to a real stamp.
    private static bool HasSpawnLogTimestamp(string fileName, string stem, string extension)
    {
        var stampStart = stem.Length + 1;
        var stampLength = fileName.Length - stampStart - extension.Length;
        return stampLength == SpawnLogTimestampFormat.Length &&
            DateTime.TryParseExact(
                fileName.AsSpan(stampStart, stampLength),
                SpawnLogTimestampFormat,
                System.Globalization.CultureInfo.InvariantCulture,
                System.Globalization.DateTimeStyles.None,
                out _);
    }

    private static string ShellQuote(string value)
        => $"'{value.Replace("'", "'\"'\"'", StringComparison.Ordinal)}'";

    private static string CmdQuote(string value)
        => $"\"{value}\"";
}

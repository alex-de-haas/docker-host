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

    // Spawns `<cli> <args...>` detached, streaming its output to {DataRoot}/core/logs/{logFileName}.
    public static void SpawnDetached(string cliPath, IReadOnlyList<string> args, HostyCoreRuntimeConfig config, string logFileName)
    {
        var logDirectory = Path.Combine(config.DataRoot, "core", "logs");
        Directory.CreateDirectory(logDirectory);
        var logPath = Path.Combine(logDirectory, logFileName);
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
            using var _ = Process.Start(startInfo) ?? throw new InvalidOperationException("Unable to start the hosty helper process.");
            return;
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

        using var process = Process.Start(unixStartInfo) ?? throw new InvalidOperationException("Unable to start the hosty helper process.");
        // The `&` returns immediately from the shell wrapper; the nohup'd CLI is detached and survives.
        process.WaitForExit();
        if (process.ExitCode != 0)
        {
            throw new InvalidOperationException($"Helper launch shell exited with code {process.ExitCode}.");
        }
    }

    private static string ShellQuote(string value)
        => $"'{value.Replace("'", "'\"'\"'", StringComparison.Ordinal)}'";

    private static string CmdQuote(string value)
        => $"\"{value}\"";
}

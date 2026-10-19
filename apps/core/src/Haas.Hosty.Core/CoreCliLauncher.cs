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

    public static string SpawnDetached(string cliPath, IReadOnlyList<string> args, HostyCoreRuntimeConfig config,
        string logFileName, string? outputPath = null) =>
        Haas.Hosty.Launch.DetachedCliProcess.SpawnDetached(cliPath, args, config.DataRoot, logFileName, outputPath);

    internal static string BuildLogFileName(string name, DateTimeOffset time) =>
        Haas.Hosty.Launch.DetachedCliProcess.BuildLogFileName(name, time);

    internal static void CleanUpStaleLogs(string directory, string name) =>
        Haas.Hosty.Launch.DetachedCliProcess.CleanUpStaleLogs(directory, name);
}

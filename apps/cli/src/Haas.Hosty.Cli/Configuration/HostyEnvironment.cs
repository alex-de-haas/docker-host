namespace Haas.Hosty.Cli.Configuration;

using System.Runtime.InteropServices;

// The CLI's view of one Hosty environment: a data root and the paths derived from it. The root IS
// the environment's identity — a client addresses an instance by its data root alone and discovers
// everything else (endpoint, PID) from the root's own control.json. Resolution: the global
// `--data-root` flag → HOSTY_DATA_ROOT → HOSTY_HOME (the legacy override Core also still honors) →
// the hardcoded per-platform default ~/.hosty.
internal sealed class HostyEnvironment
{
    private const string DataRootVariable = "HOSTY_DATA_ROOT";
    private const string LegacyOverrideRootVariable = "HOSTY_HOME";
    private const string PreferredRootDirectoryName = ".hosty";

    private HostyEnvironment(
        string homeDirectory,
        string rootDirectory,
        string preferredRootDirectory,
        bool isWindows,
        bool hasRootOverride)
    {
        HomeDirectory = homeDirectory;
        RootDirectory = rootDirectory;
        PreferredRootDirectory = preferredRootDirectory;
        ConfigDirectory = Path.Combine(rootDirectory, "config");
        BinDirectory = Path.Combine(rootDirectory, "bin");
        AppsDirectory = Path.Combine(rootDirectory, "apps");
        LaunchConfigPath = Path.Combine(ConfigDirectory, "launch.env");
        AuthConfigPath = Path.Combine(ConfigDirectory, "auth.json");
        IsWindows = isWindows;
        HasRootOverride = hasRootOverride;
    }

    public string HomeDirectory { get; }

    public string RootDirectory { get; }

    public string PreferredRootDirectory { get; }

    public string ConfigDirectory { get; }

    public string BinDirectory { get; }

    public string AppsDirectory { get; }

    public string LaunchConfigPath { get; }

    public string AuthConfigPath { get; }

    public bool IsWindows { get; }

    public bool HasRootOverride { get; }

    public static HostyEnvironment Current(string? dataRootOverride = null)
    {
        var homeDirectory = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        if (string.IsNullOrWhiteSpace(homeDirectory))
        {
            homeDirectory = Environment.GetEnvironmentVariable(RuntimeInformation.IsOSPlatform(OSPlatform.Windows) ? "USERPROFILE" : "HOME")
                ?? throw new ConfigurationException("Unable to resolve the current user home directory.");
        }

        var preferredRootDirectory = Path.GetFullPath(Path.Combine(homeDirectory, PreferredRootDirectoryName));
        var rootOverride = NormalizeOptional(dataRootOverride) ??
            NormalizeOptional(Environment.GetEnvironmentVariable(DataRootVariable)) ??
            NormalizeOptional(Environment.GetEnvironmentVariable(LegacyOverrideRootVariable));
        var hasRootOverride = rootOverride is not null;
        var rootDirectory = rootOverride ?? preferredRootDirectory;
        var resolvedRootDirectory = Path.GetFullPath(ExpandHome(rootDirectory, homeDirectory));

        return new HostyEnvironment(
            Path.GetFullPath(homeDirectory),
            resolvedRootDirectory,
            preferredRootDirectory,
            RuntimeInformation.IsOSPlatform(OSPlatform.Windows),
            hasRootOverride);
    }

    private static string? NormalizeOptional(string? value)
        => string.IsNullOrWhiteSpace(value) ? null : value.Trim();

    public string ResolvePath(string value)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return value;
        }

        var expanded = ExpandHome(value, HomeDirectory);
        expanded = expanded.Replace("${HOME}", HomeDirectory, StringComparison.Ordinal);
        expanded = expanded.Replace("$HOME", HomeDirectory, StringComparison.Ordinal);
        expanded = Environment.ExpandEnvironmentVariables(expanded);

        return Path.GetFullPath(expanded);
    }

    private static string ExpandHome(string value, string homeDirectory)
    {
        if (value == "~")
        {
            return homeDirectory;
        }

        if (value.StartsWith("~/", StringComparison.Ordinal) || value.StartsWith("~\\", StringComparison.Ordinal))
        {
            return Path.Combine(homeDirectory, value[2..]);
        }

        return value;
    }
}

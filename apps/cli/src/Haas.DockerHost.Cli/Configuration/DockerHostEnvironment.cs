namespace Haas.DockerHost.Cli.Configuration;

using System.Runtime.InteropServices;

internal sealed class DockerHostEnvironment
{
    private const string OverrideRootVariable = "HOSTY_HOME";
    private const string LegacyOverrideRootVariable = "DOCKER_HOST_HOME";
    private const string PreferredRootDirectoryName = ".hosty";
    private const string LegacyRootDirectoryName = ".docker-host";

    private DockerHostEnvironment(
        string homeDirectory,
        string rootDirectory,
        string preferredRootDirectory,
        string legacyRootDirectory,
        bool isWindows,
        bool hasRootOverride,
        bool usesLegacyRoot)
    {
        HomeDirectory = homeDirectory;
        RootDirectory = rootDirectory;
        PreferredRootDirectory = preferredRootDirectory;
        LegacyRootDirectory = legacyRootDirectory;
        ConfigDirectory = Path.Combine(rootDirectory, "config");
        BinDirectory = Path.Combine(rootDirectory, "bin");
        AppsDirectory = Path.Combine(rootDirectory, "apps");
        ModulesDirectory = Path.Combine(rootDirectory, "modules");
        LaunchConfigPath = Path.Combine(ConfigDirectory, "launch.env");
        AuthConfigPath = Path.Combine(ConfigDirectory, "auth.json");
        IsWindows = isWindows;
        HasRootOverride = hasRootOverride;
        UsesLegacyRoot = usesLegacyRoot;
    }

    public string HomeDirectory { get; }

    public string RootDirectory { get; }

    public string PreferredRootDirectory { get; }

    public string LegacyRootDirectory { get; }

    public string ConfigDirectory { get; }

    public string BinDirectory { get; }

    public string AppsDirectory { get; }

    public string ModulesDirectory { get; }

    public string LaunchConfigPath { get; }

    public string AuthConfigPath { get; }

    public bool IsWindows { get; }

    public bool HasRootOverride { get; }

    public bool UsesLegacyRoot { get; }

    public static DockerHostEnvironment Current()
    {
        var homeDirectory = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        if (string.IsNullOrWhiteSpace(homeDirectory))
        {
            homeDirectory = Environment.GetEnvironmentVariable(RuntimeInformation.IsOSPlatform(OSPlatform.Windows) ? "USERPROFILE" : "HOME")
                ?? throw new ConfigurationException("Unable to resolve the current user home directory.");
        }

        var preferredRootDirectory = Path.GetFullPath(Path.Combine(homeDirectory, PreferredRootDirectoryName));
        var legacyRootDirectory = Path.GetFullPath(Path.Combine(homeDirectory, LegacyRootDirectoryName));
        var rootOverride = Environment.GetEnvironmentVariable(OverrideRootVariable);
        var legacyRootOverride = Environment.GetEnvironmentVariable(LegacyOverrideRootVariable);
        var hasRootOverride = !string.IsNullOrWhiteSpace(rootOverride) || !string.IsNullOrWhiteSpace(legacyRootOverride);
        var rootDirectory = !string.IsNullOrWhiteSpace(rootOverride)
            ? rootOverride
            : !string.IsNullOrWhiteSpace(legacyRootOverride)
                ? legacyRootOverride
                : ResolveDefaultRootDirectory(preferredRootDirectory, legacyRootDirectory);
        var resolvedRootDirectory = Path.GetFullPath(ExpandHome(rootDirectory, homeDirectory));

        return new DockerHostEnvironment(
            Path.GetFullPath(homeDirectory),
            resolvedRootDirectory,
            preferredRootDirectory,
            legacyRootDirectory,
            RuntimeInformation.IsOSPlatform(OSPlatform.Windows),
            hasRootOverride,
            !hasRootOverride && string.Equals(resolvedRootDirectory, legacyRootDirectory, StringComparison.Ordinal));
    }

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

    internal static string ResolveDefaultRootDirectory(string preferredRootDirectory, string legacyRootDirectory)
    {
        if (Directory.Exists(preferredRootDirectory))
        {
            return preferredRootDirectory;
        }

        if (Directory.Exists(legacyRootDirectory))
        {
            return legacyRootDirectory;
        }

        return preferredRootDirectory;
    }
}

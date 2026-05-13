namespace Haas.DockerHost.Cli.Configuration;

using System.Runtime.InteropServices;

internal sealed class DockerHostEnvironment
{
    private const string OverrideRootVariable = "DOCKER_HOST_HOME";

    private DockerHostEnvironment(string homeDirectory, string rootDirectory, bool isWindows, bool hasRootOverride)
    {
        HomeDirectory = homeDirectory;
        RootDirectory = rootDirectory;
        ConfigDirectory = Path.Combine(rootDirectory, "config");
        BinDirectory = Path.Combine(rootDirectory, "bin");
        ModulesDirectory = Path.Combine(rootDirectory, "modules");
        LaunchConfigPath = Path.Combine(ConfigDirectory, "launch.env");
        IsWindows = isWindows;
        HasRootOverride = hasRootOverride;
    }

    public string HomeDirectory { get; }

    public string RootDirectory { get; }

    public string ConfigDirectory { get; }

    public string BinDirectory { get; }

    public string ModulesDirectory { get; }

    public string LaunchConfigPath { get; }

    public bool IsWindows { get; }

    public bool HasRootOverride { get; }

    public static DockerHostEnvironment Current()
    {
        var homeDirectory = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        if (string.IsNullOrWhiteSpace(homeDirectory))
        {
            homeDirectory = Environment.GetEnvironmentVariable(RuntimeInformation.IsOSPlatform(OSPlatform.Windows) ? "USERPROFILE" : "HOME")
                ?? throw new ConfigurationException("Unable to resolve the current user home directory.");
        }

        var rootDirectory = Environment.GetEnvironmentVariable(OverrideRootVariable);
        if (string.IsNullOrWhiteSpace(rootDirectory))
        {
            rootDirectory = Path.Combine(homeDirectory, ".docker-host");
        }

        return new DockerHostEnvironment(
            Path.GetFullPath(homeDirectory),
            Path.GetFullPath(ExpandHome(rootDirectory, homeDirectory)),
            RuntimeInformation.IsOSPlatform(OSPlatform.Windows),
            !string.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable(OverrideRootVariable)));
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
}

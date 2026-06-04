namespace Haas.DockerHost.Cli.Configuration;

using System.Globalization;

internal static class LaunchSettingDefinitions
{
    public const string HostContainerName = "HOST_CONTAINER_NAME";
    public const string HostDataRootHost = "HOST_DATA_ROOT_HOST";
    public const string HostUiPort = "HOST_UI_PORT";
    public const string HostPublicOrigin = "HOST_PUBLIC_ORIGIN";
    public const string HostCorePublicOrigin = "HOST_CORE_PUBLIC_ORIGIN";
    public const string HostShellPublicOrigin = "HOST_SHELL_PUBLIC_ORIGIN";
    public const string HostDockerEndpoint = "HOST_DOCKER_ENDPOINT";

    public static readonly IReadOnlyList<LaunchSettingDefinition> All =
    [
        new(HostContainerName, _ => "docker-host", true, ValidateContainerName),
        new(HostDataRootHost, DefaultDataRootHost, true, ValidateHostPath),
        new(HostUiPort, _ => "auto", true, ValidateHostPort),
        new(HostPublicOrigin, _ => "", true, ValidateOptionalHttpOrigin),
        new(HostCorePublicOrigin, _ => "", true, ValidateOptionalHttpOrigin),
        new(HostShellPublicOrigin, _ => "", true, ValidateOptionalHttpOrigin),
        new(HostDockerEndpoint, env => env.IsWindows ? "npipe:////./pipe/docker_engine" : "unix:///var/run/docker.sock", true, ValidateDockerEndpoint),
    ];

    private static readonly Dictionary<string, LaunchSettingDefinition> ByKey = All.ToDictionary(x => x.Key, StringComparer.Ordinal);

    private static string DefaultDataRootHost(DockerHostEnvironment environment)
    {
        if (environment.HasRootOverride)
        {
            return environment.RootDirectory;
        }

        if (environment.UsesLegacyRoot)
        {
            return environment.IsWindows ? environment.LegacyRootDirectory : "$HOME/.docker-host";
        }

        return environment.IsWindows ? environment.PreferredRootDirectory : "$HOME/.hosty";
    }

    public static LaunchSettingDefinition Get(string key)
    {
        if (!ByKey.TryGetValue(key, out var definition))
        {
            throw new ConfigurationException($"Unknown launch setting '{key}'. Run 'hosty config list' to see supported settings.");
        }

        return definition;
    }

    public static bool Contains(string key) => ByKey.ContainsKey(key);

    private static string? ValidateContainerName(string value, DockerHostEnvironment _)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return "Container name cannot be empty.";
        }

        return value.Any(char.IsWhiteSpace) ? "Container name cannot contain whitespace." : null;
    }

    private static string? ValidateHostPath(string value, DockerHostEnvironment environment)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return "Host path cannot be empty.";
        }

        var resolved = environment.ResolvePath(value);
        return Path.IsPathFullyQualified(resolved) ? null : "Host path must resolve to an absolute path.";
    }

    private static string? ValidateHostPort(string value, DockerHostEnvironment _)
    {
        if (string.Equals(value, "auto", StringComparison.OrdinalIgnoreCase))
        {
            return null;
        }

        if (!int.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture, out var port))
        {
            return "Host UI port must be 'auto' or a TCP port number.";
        }

        return port is > 0 and <= 65535 ? null : "Host UI port must be between 1 and 65535.";
    }

    private static string? ValidateOptionalHttpOrigin(string value, DockerHostEnvironment _)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return null;
        }

        return Uri.TryCreate(value, UriKind.Absolute, out var uri) &&
            (uri.Scheme == Uri.UriSchemeHttp || uri.Scheme == Uri.UriSchemeHttps) &&
            string.IsNullOrEmpty(uri.PathAndQuery.Trim('/'))
            ? null
            : "Host public origin must be an absolute http(s) origin without a path.";
    }

    private static string? ValidateDockerEndpoint(string value, DockerHostEnvironment environment)
    {
        if (environment.IsWindows)
        {
            return value.StartsWith("npipe:////./pipe/", StringComparison.OrdinalIgnoreCase)
                ? null
                : "Native Windows supports only npipe:////./pipe/docker_engine for the local Host launch model.";
        }

        return value.StartsWith("unix:///", StringComparison.OrdinalIgnoreCase)
            ? null
            : "macOS, Linux, and WSL support only unix:/// local Docker endpoints for the local Host launch model.";
    }

}

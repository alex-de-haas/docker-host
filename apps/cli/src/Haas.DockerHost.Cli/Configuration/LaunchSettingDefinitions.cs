namespace Haas.DockerHost.Cli.Configuration;

using System.Globalization;

internal static class LaunchSettingDefinitions
{
    public const string HostImage = "HOST_IMAGE";
    public const string HostContainerName = "HOST_CONTAINER_NAME";
    public const string HostDataRootHost = "HOST_DATA_ROOT_HOST";
    public const string HostDataRootContainer = "HOST_DATA_ROOT_CONTAINER";
    public const string HostUiPort = "HOST_UI_PORT";
    public const string HostRestartPolicy = "HOST_RESTART_POLICY";
    public const string HostDockerEndpoint = "HOST_DOCKER_ENDPOINT";
    public const string HostDockerSocket = "HOST_DOCKER_SOCKET";
    public const string HostModuleNetwork = "HOST_MODULE_NETWORK";

    public static readonly IReadOnlyList<LaunchSettingDefinition> All =
    [
        new(HostImage, _ => "ghcr.io/alex-de-haas/docker-host:latest", true, Required),
        new(HostContainerName, _ => "docker-host", true, ValidateContainerName),
        new(HostDataRootHost, DefaultDataRootHost, true, ValidateHostPath),
        new(HostDataRootContainer, _ => "/data", false, ValidateContainerPath),
        new(HostUiPort, _ => "auto", true, ValidateHostPort),
        new(HostRestartPolicy, _ => "unless-stopped", true, ValidateRestartPolicy),
        new(HostDockerEndpoint, env => env.IsWindows ? "npipe:////./pipe/docker_engine" : "unix:///var/run/docker.sock", true, ValidateDockerEndpoint),
        new(HostDockerSocket, _ => "/var/run/docker.sock", true, ValidateContainerPath),
        new(HostModuleNetwork, _ => "docker-host-modules", true, Required),
    ];

    private static readonly Dictionary<string, LaunchSettingDefinition> ByKey = All.ToDictionary(x => x.Key, StringComparer.Ordinal);

    private static string DefaultDataRootHost(DockerHostEnvironment environment)
    {
        if (environment.HasRootOverride)
        {
            return environment.RootDirectory;
        }

        return environment.IsWindows ? Path.Combine(environment.HomeDirectory, ".docker-host") : "$HOME/.docker-host";
    }

    public static LaunchSettingDefinition Get(string key)
    {
        if (!ByKey.TryGetValue(key, out var definition))
        {
            throw new ConfigurationException($"Unknown launch setting '{key}'. Run 'docker-host config list' to see supported settings.");
        }

        return definition;
    }

    public static bool Contains(string key) => ByKey.ContainsKey(key);

    private static string? Required(string value, DockerHostEnvironment _)
        => string.IsNullOrWhiteSpace(value) ? "Value cannot be empty." : null;

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

    private static string? ValidateContainerPath(string value, DockerHostEnvironment _)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return "Container path cannot be empty.";
        }

        return value.StartsWith("/", StringComparison.Ordinal) ? null : "Container path must be an absolute Unix path.";
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

    private static string? ValidateRestartPolicy(string value, DockerHostEnvironment _)
    {
        var allowed = new[] { "no", "always", "unless-stopped", "on-failure" };
        return allowed.Contains(value, StringComparer.Ordinal)
            ? null
            : "Restart policy must be one of: no, always, unless-stopped, on-failure.";
    }

    private static string? ValidateDockerEndpoint(string value, DockerHostEnvironment environment)
    {
        if (environment.IsWindows)
        {
            return value.StartsWith("npipe:////./pipe/", StringComparison.OrdinalIgnoreCase)
                ? null
                : "Native Windows supports only npipe:////./pipe/docker_engine for Phase 2.";
        }

        return value.StartsWith("unix:///", StringComparison.OrdinalIgnoreCase)
            ? null
            : "macOS, Linux, and WSL support only unix:/// local Docker endpoints for Phase 2.";
    }
}

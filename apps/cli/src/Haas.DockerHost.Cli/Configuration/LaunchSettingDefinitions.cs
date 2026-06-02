namespace Haas.DockerHost.Cli.Configuration;

using System.Globalization;

internal static class LaunchSettingDefinitions
{
    public const string HostImage = "HOST_IMAGE";
    public const string HostContainerName = "HOST_CONTAINER_NAME";
    public const string HostDataRootHost = "HOST_DATA_ROOT_HOST";
    public const string HostDataRootContainer = "HOST_DATA_ROOT_CONTAINER";
    public const string HostUiPort = "HOST_UI_PORT";
    public const string HostBindAddress = "HOST_BIND_ADDRESS";
    public const string HostPublicOrigin = "HOST_PUBLIC_ORIGIN";
    public const string HostGatewayBaseDomain = "HOST_GATEWAY_BASE_DOMAIN";
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
        new(HostBindAddress, _ => "127.0.0.1", true, ValidateBindAddress),
        new(HostPublicOrigin, _ => "", true, ValidateOptionalHttpOrigin),
        new(HostGatewayBaseDomain, _ => "", true, ValidateOptionalDnsName),
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

    private static string? ValidateOptionalHostPath(string value, DockerHostEnvironment environment)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return null;
        }

        return ValidateHostPath(value, environment);
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

    private static string? ValidateTcpPort(string value, DockerHostEnvironment _)
    {
        if (!int.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture, out var port))
        {
            return "Value must be a TCP port number.";
        }

        return port is > 0 and <= 65535 ? null : "Value must be between 1 and 65535.";
    }

    private static string? ValidateBindAddress(string value, DockerHostEnvironment _)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return "Host bind address cannot be empty.";
        }

        return value is "127.0.0.1" or "0.0.0.0" ? null : "Host bind address must be 127.0.0.1 or 0.0.0.0.";
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

    private static string? ValidateOptionalDnsName(string value, DockerHostEnvironment _)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return null;
        }

        var trimmed = value.Trim().Trim('.');
        var labels = trimmed.Split('.', StringSplitOptions.RemoveEmptyEntries);
        if (labels.Length == 0 || trimmed.Length > 253)
        {
            return "Gateway base domain must be a valid DNS name.";
        }

        return labels.All(label =>
            label.Length is > 0 and <= 63 &&
            char.IsLetterOrDigit(label[0]) &&
            char.IsLetterOrDigit(label[^1]) &&
            label.All(character => char.IsLetterOrDigit(character) || character == '-'))
            ? null
            : "Gateway base domain must be a valid DNS name.";
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
                : "Native Windows supports only npipe:////./pipe/docker_engine for the local Host launch model.";
        }

        return value.StartsWith("unix:///", StringComparison.OrdinalIgnoreCase)
            ? null
            : "macOS, Linux, and WSL support only unix:/// local Docker endpoints for the local Host launch model.";
    }

    private static string? ValidateEnabledDisabled(string value, DockerHostEnvironment _)
        => value is "enabled" or "disabled"
            ? null
            : "Value must be enabled or disabled.";
}

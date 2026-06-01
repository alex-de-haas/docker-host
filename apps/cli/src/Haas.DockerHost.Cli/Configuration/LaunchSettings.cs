namespace Haas.DockerHost.Cli.Configuration;

using System.Globalization;

internal sealed class LaunchSettings
{
    private readonly Dictionary<string, string> values;

    public LaunchSettings(IReadOnlyDictionary<string, string> values)
    {
        this.values = new Dictionary<string, string>(values, StringComparer.Ordinal);
    }

    public IReadOnlyDictionary<string, string> Values => values;

    public string this[string key] => values[key];

    public string HostImage => this[LaunchSettingDefinitions.HostImage];

    public string HostContainerName => this[LaunchSettingDefinitions.HostContainerName];

    public string HostDataRootHostRaw => this[LaunchSettingDefinitions.HostDataRootHost];

    public string HostDataRootContainer => this[LaunchSettingDefinitions.HostDataRootContainer];

    public string HostUiPort => this[LaunchSettingDefinitions.HostUiPort];

    public string HostBindAddress => this[LaunchSettingDefinitions.HostBindAddress];

    public string HostPublicOrigin => this[LaunchSettingDefinitions.HostPublicOrigin];

    public string HostGatewayBaseDomain => this[LaunchSettingDefinitions.HostGatewayBaseDomain];

    public string HostRestartPolicy => this[LaunchSettingDefinitions.HostRestartPolicy];

    public string HostDockerEndpoint => this[LaunchSettingDefinitions.HostDockerEndpoint];

    public string HostDockerSocket => this[LaunchSettingDefinitions.HostDockerSocket];

    public string HostModuleNetwork => this[LaunchSettingDefinitions.HostModuleNetwork];

    public string HostModuleDevMode => this[LaunchSettingDefinitions.HostModuleDevMode];

    public string HostDevRepositoryPathRaw => this[LaunchSettingDefinitions.HostDevRepositoryPath];

    public string HostDevPort => this[LaunchSettingDefinitions.HostDevPort];

    public string ResolveHostDataRoot(DockerHostEnvironment environment)
        => environment.ResolvePath(HostDataRootHostRaw);

    public string? ResolveHostDevRepositoryPath(DockerHostEnvironment environment)
        => string.IsNullOrWhiteSpace(HostDevRepositoryPathRaw)
            ? null
            : environment.ResolvePath(HostDevRepositoryPathRaw);

    public int? GetFixedHostPort()
    {
        if (string.Equals(HostUiPort, "auto", StringComparison.OrdinalIgnoreCase))
        {
            return null;
        }

        return int.Parse(HostUiPort, CultureInfo.InvariantCulture);
    }

    public int GetHostDevPort()
        => int.Parse(HostDevPort, CultureInfo.InvariantCulture);

    public void Validate(DockerHostEnvironment environment)
    {
        foreach (var definition in LaunchSettingDefinitions.All)
        {
            if (!values.TryGetValue(definition.Key, out var value))
            {
                throw new ConfigurationException($"Missing launch setting '{definition.Key}'. Run 'hosty install' to repair launch.env.");
            }

            var error = definition.Validate(value, environment);
            if (error is not null)
            {
                throw new ConfigurationException($"Invalid {definition.Key}: {error}");
            }
        }
    }

    public LaunchSettings WithValue(string key, string value)
    {
        var next = new Dictionary<string, string>(values, StringComparer.Ordinal)
        {
            [key] = value,
        };

        return new LaunchSettings(next);
    }
}

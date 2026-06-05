namespace Haas.Hosty.Cli.Configuration;

internal sealed class LaunchSettings
{
    private readonly Dictionary<string, string> values;

    public LaunchSettings(IReadOnlyDictionary<string, string> values)
    {
        this.values = new Dictionary<string, string>(values, StringComparer.Ordinal);
    }

    public IReadOnlyDictionary<string, string> Values => values;

    public string this[string key] => values[key];

    public string HostDataRootHostRaw => this[LaunchSettingDefinitions.HostDataRootHost];

    public string HostPublicOrigin => this[LaunchSettingDefinitions.HostPublicOrigin];

    public string HostCorePublicOrigin => this[LaunchSettingDefinitions.HostCorePublicOrigin];

    public string HostShellPublicOrigin => this[LaunchSettingDefinitions.HostShellPublicOrigin];

    public string HostyShellManifestPath => this[LaunchSettingDefinitions.HostyShellManifestPath];

    public string HostyShellBootstrapRuntime => this[LaunchSettingDefinitions.HostyShellBootstrapRuntime];

    public string ResolveHostDataRoot(HostyEnvironment environment)
        => environment.ResolvePath(HostDataRootHostRaw);

    public string ResolveHostyShellManifestPath(HostyEnvironment environment)
    {
        var manifestPath = HostyShellManifestPath.Trim();
        return Uri.TryCreate(manifestPath, UriKind.Absolute, out var uri) &&
            (uri.Scheme == Uri.UriSchemeHttp || uri.Scheme == Uri.UriSchemeHttps)
            ? manifestPath
            : environment.ResolvePath(manifestPath);
    }

    public void Validate(HostyEnvironment environment)
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

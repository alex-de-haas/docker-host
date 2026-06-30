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

    public string HostyDataRootRaw => this[LaunchSettingDefinitions.HostyDataRoot];

    public string HostyCorePort => this[LaunchSettingDefinitions.HostyCorePort];

    public string HostyShellPort => this[LaunchSettingDefinitions.HostyShellPort];

    public string HostyCorePublicOrigin => this[LaunchSettingDefinitions.HostyCorePublicOrigin];

    public string HostyShellPublicOrigin => this[LaunchSettingDefinitions.HostyShellPublicOrigin];

    public string HostyShellManifestPath => this[LaunchSettingDefinitions.HostyShellManifestPath];

    public string HostyShellBootstrapRuntime => this[LaunchSettingDefinitions.HostyShellBootstrapRuntime];

    public string HostyObservabilityEnabled => this[LaunchSettingDefinitions.HostyObservabilityEnabled];

    public string HostyCollectorAutostart => this[LaunchSettingDefinitions.HostyCollectorAutostart];

    public string HostyCollectorManifestPath => this[LaunchSettingDefinitions.HostyCollectorManifestPath];

    public string ResolveHostDataRoot(HostyEnvironment environment)
        => environment.ResolvePath(HostyDataRootRaw);

    public string ResolveHostyShellManifestPath(HostyEnvironment environment)
        => ResolveManifestReference(HostyShellManifestPath, environment);

    public string ResolveHostyCollectorManifestPath(HostyEnvironment environment)
        => ResolveManifestReference(HostyCollectorManifestPath, environment);

    // A manifest reference is either an http(s) URL (used verbatim) or a local path (resolved against
    // the host environment). Shared by the Shell and the telemetry collector bootstrap references.
    private static string ResolveManifestReference(string reference, HostyEnvironment environment)
    {
        var manifestPath = reference.Trim();
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

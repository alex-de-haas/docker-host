namespace Haas.Hosty.Cli.Configuration;

internal static class LaunchSettingDefinitions
{
    // Pre-generic-bootstrap default manifest URLs. No longer defaults: the distribution list owns
    // manifest locations now (docs/ideas/generic-bootstrap.md), and these settings are deprecated
    // explicit overrides. Kept so LaunchSettingsStore can scrub values an older CLI materialized
    // into launch.env — a value equal to the old default was never operator intent, and leaving it
    // would re-pin a location that goes stale the next time a release moves a manifest.
    internal const string LegacyDefaultShellManifestPath = "https://raw.githubusercontent.com/alex-de-haas/docker-host/main/apps/shell/manifest.json";
    internal const string LegacyDefaultCollectorManifestPath = "https://raw.githubusercontent.com/alex-de-haas/docker-host/main/apps/telemetry/manifest.json";
    internal const string LegacyDefaultMarketplaceManifestPath = "https://raw.githubusercontent.com/alex-de-haas/docker-host/main/apps/marketplace/manifest.json";

    internal static readonly IReadOnlyDictionary<string, string> ScrubbedLegacyDefaults = new Dictionary<string, string>(StringComparer.Ordinal)
    {
        [HostyShellManifestPath] = LegacyDefaultShellManifestPath,
        [HostyCollectorManifestPath] = LegacyDefaultCollectorManifestPath,
        [HostyMarketplaceManifestPath] = LegacyDefaultMarketplaceManifestPath,
    };
    public const string HostyDataRoot = "HOSTY_DATA_ROOT";
    public const string HostyCorePort = "HOSTY_CORE_PORT";
    public const string HostyShellPort = "HOSTY_SHELL_PORT";
    public const string HostyCorePublicOrigin = "HOSTY_CORE_PUBLIC_ORIGIN";
    public const string HostyShellPublicOrigin = "HOSTY_SHELL_PUBLIC_ORIGIN";
    public const string HostyShellManifestPath = "HOSTY_SHELL_MANIFEST_PATH";
    public const string HostyShellBootstrapRuntime = "HOSTY_SHELL_BOOTSTRAP_RUNTIME";
    public const string HostyCollectorManifestPath = "HOSTY_COLLECTOR_MANIFEST_PATH";
    public const string HostyMarketplaceManifestPath = "HOSTY_MARKETPLACE_MANIFEST_PATH";

    public static readonly IReadOnlyList<LaunchSettingDefinition> All =
    [
        new(HostyDataRoot, DefaultDataRootHost, true, ValidateHostPath),
        new(HostyCorePort, _ => "7070", true, ValidatePort),
        new(HostyShellPort, _ => "7171", true, ValidatePort),
        new(HostyCorePublicOrigin, _ => "", true, ValidateOptionalHttpOrigin),
        new(HostyShellPublicOrigin, _ => "", true, ValidateOptionalHttpOrigin),
        // Deprecated (generic bootstrap): manifest locations resolve from the release-owned
        // distribution list at every Core boot; these settings remain only as explicit legacy
        // overrides that Core honors with a deprecation warning. Empty means "not set".
        new(HostyShellManifestPath, _ => "", true, ValidateOptionalManifestReference, IsDeprecated: true),
        new(HostyShellBootstrapRuntime, _ => "docker", true, ValidateRuntimeKey),
        // HOSTY_OBSERVABILITY_ENABLED and HOSTY_COLLECTOR_AUTOSTART are gone: Core derives its
        // telemetry producers from the telemetry app being installed, and autostart is a normal
        // per-app setting. Which apps bootstrap is decided by `hosty setup`, not here.
        new(HostyCollectorManifestPath, _ => "", true, ValidateOptionalManifestReference, IsDeprecated: true),
        new(HostyMarketplaceManifestPath, _ => "", true, ValidateOptionalManifestReference, IsDeprecated: true),
    ];

    private static readonly Dictionary<string, LaunchSettingDefinition> ByKey = All.ToDictionary(x => x.Key, StringComparer.Ordinal);

    private static string DefaultDataRootHost(HostyEnvironment environment)
    {
        if (environment.HasRootOverride)
        {
            return environment.RootDirectory;
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

    private static string? ValidateHostPath(string value, HostyEnvironment environment)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return "Host path cannot be empty.";
        }

        var resolved = environment.ResolvePath(value);
        return Path.IsPathFullyQualified(resolved) ? null : "Host path must resolve to an absolute path.";
    }

    private static string? ValidateOptionalHttpOrigin(string value, HostyEnvironment _)
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

    private static string? ValidatePort(string value, HostyEnvironment _)
        => int.TryParse(value.Trim(), System.Globalization.NumberStyles.None, System.Globalization.CultureInfo.InvariantCulture, out var port) &&
            port is > 0 and <= 65535
            ? null
            : "Port must be an integer between 1 and 65535.";

    private static string? ValidateManifestReference(string value, HostyEnvironment environment)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return "Manifest path cannot be empty.";
        }

        var trimmed = value.Trim();
        if (Uri.TryCreate(trimmed, UriKind.Absolute, out var uri) &&
            (uri.Scheme == Uri.UriSchemeHttp || uri.Scheme == Uri.UriSchemeHttps))
        {
            if (!string.IsNullOrWhiteSpace(uri.UserInfo))
            {
                return "Manifest URL must not include credentials.";
            }

            return null;
        }

        if (trimmed.Contains("://", StringComparison.Ordinal))
        {
            return "Manifest URL must use http or https.";
        }

        var resolved = environment.ResolvePath(trimmed);
        return Path.IsPathFullyQualified(resolved) ? null : "Manifest path must resolve to an absolute path or be an http(s) URL.";
    }

    private static string? ValidateOptionalManifestReference(string value, HostyEnvironment environment)
        => string.IsNullOrWhiteSpace(value) ? null : ValidateManifestReference(value, environment);

    private static string? ValidateRuntimeKey(string value, HostyEnvironment _)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return "Shell bootstrap runtime cannot be empty.";
        }

        var trimmed = value.Trim();
        if (!char.IsAsciiLetterLower(trimmed[0]))
        {
            return "Shell bootstrap runtime must start with a lowercase letter.";
        }

        return trimmed.Length <= 63 && trimmed.All(character => char.IsAsciiLetterLower(character) || char.IsAsciiDigit(character) || character == '-')
            ? null
            : "Shell bootstrap runtime must match ^[a-z][a-z0-9-]{0,62}$.";
    }

}

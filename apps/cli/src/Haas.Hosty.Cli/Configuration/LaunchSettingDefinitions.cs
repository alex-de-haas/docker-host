namespace Haas.Hosty.Cli.Configuration;

internal static class LaunchSettingDefinitions
{
    private const string DefaultShellManifestPath = "https://raw.githubusercontent.com/alex-de-haas/docker-host/main/apps/shell/manifest.json";
    private const string DefaultCollectorManifestPath = "https://raw.githubusercontent.com/alex-de-haas/docker-host/main/apps/telemetry/manifest.json";
    private const string DefaultMarketplaceManifestPath = "https://raw.githubusercontent.com/alex-de-haas/docker-host/main/apps/marketplace/manifest.json";
    public const string HostyDataRoot = "HOSTY_DATA_ROOT";
    public const string HostyCorePort = "HOSTY_CORE_PORT";
    public const string HostyShellPort = "HOSTY_SHELL_PORT";
    public const string HostyCorePublicOrigin = "HOSTY_CORE_PUBLIC_ORIGIN";
    public const string HostyShellPublicOrigin = "HOSTY_SHELL_PUBLIC_ORIGIN";
    public const string HostyShellManifestPath = "HOSTY_SHELL_MANIFEST_PATH";
    public const string HostyShellBootstrapRuntime = "HOSTY_SHELL_BOOTSTRAP_RUNTIME";
    public const string HostyObservabilityEnabled = "HOSTY_OBSERVABILITY_ENABLED";
    public const string HostyCollectorAutostart = "HOSTY_COLLECTOR_AUTOSTART";
    public const string HostyCollectorManifestPath = "HOSTY_COLLECTOR_MANIFEST_PATH";
    public const string HostyMarketplaceManifestPath = "HOSTY_MARKETPLACE_MANIFEST_PATH";

    public static readonly IReadOnlyList<LaunchSettingDefinition> All =
    [
        new(HostyDataRoot, DefaultDataRootHost, true, ValidateHostPath),
        new(HostyCorePort, _ => "7070", true, ValidatePort),
        new(HostyShellPort, _ => "7171", true, ValidatePort),
        new(HostyCorePublicOrigin, _ => "", true, ValidateOptionalHttpOrigin),
        new(HostyShellPublicOrigin, _ => "", true, ValidateOptionalHttpOrigin),
        new(HostyShellManifestPath, _ => DefaultShellManifestPath, true, ValidateManifestReference),
        new(HostyShellBootstrapRuntime, _ => "docker", true, ValidateRuntimeKey),
        // Observability (P4): the collector is installed/started only when enabled. Mirrors Core's
        // HOSTY_OBSERVABILITY_ENABLED / HOSTY_COLLECTOR_AUTOSTART env vars. The collector manifest path
        // carries a remote default (like the Shell) so an installed standalone Core — which has no repo
        // layout on disk to discover apps/telemetry/manifest.json — can still bootstrap the collector;
        // only HOSTY_COLLECTOR_BOOTSTRAP_RUNTIME stays an advanced ambient-env-only knob.
        new(HostyObservabilityEnabled, _ => "false", true, ValidateBoolean),
        new(HostyCollectorAutostart, _ => "true", true, ValidateBoolean),
        new(HostyCollectorManifestPath, _ => DefaultCollectorManifestPath, true, ValidateManifestReference),
        // Temporary bootstrap reference while Marketplace is a first-party optional system app. Unlike
        // Shell/collector, an explicit empty value is meaningful: pass it through so Core disables the
        // Marketplace bootstrap instead of inheriting an ambient reference.
        new(HostyMarketplaceManifestPath, _ => DefaultMarketplaceManifestPath, true, ValidateOptionalManifestReference),
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

    private const string BooleanError = "Value must be a boolean (true/false, 1/0, yes/no, enabled/disabled, on/off).";
    private static readonly HashSet<string> TruthyBooleanTokens = new(StringComparer.OrdinalIgnoreCase) { "1", "true", "yes", "enabled", "on" };
    private static readonly HashSet<string> FalsyBooleanTokens = new(StringComparer.OrdinalIgnoreCase) { "0", "false", "no", "disabled", "off" };

    // True when a (validated) boolean setting value is one of the truthy tokens. Used to canonicalize
    // the stored value and to decide whether to inject the override into the Core process environment.
    public static bool IsTruthy(string? value) => value is not null && TruthyBooleanTokens.Contains(value.Trim());

    private static string? ValidateBoolean(string value, HostyEnvironment _)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return BooleanError;
        }

        var token = value.Trim();
        return TruthyBooleanTokens.Contains(token) || FalsyBooleanTokens.Contains(token) ? null : BooleanError;
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

namespace Haas.Hosty.Cli.Configuration;

internal static class LaunchSettingDefinitions
{
    private const string DefaultShellManifestPath = "https://raw.githubusercontent.com/alex-de-haas/docker-host/main/apps/shell/manifest.json";
    public const string HostDataRootHost = "HOST_DATA_ROOT_HOST";
    public const string HostPublicOrigin = "HOST_PUBLIC_ORIGIN";
    public const string HostCorePublicOrigin = "HOST_CORE_PUBLIC_ORIGIN";
    public const string HostShellPublicOrigin = "HOST_SHELL_PUBLIC_ORIGIN";
    public const string HostyShellManifestPath = "HOSTY_SHELL_MANIFEST_PATH";
    public const string HostyShellBootstrapRuntime = "HOSTY_SHELL_BOOTSTRAP_RUNTIME";

    public static readonly IReadOnlyList<LaunchSettingDefinition> All =
    [
        new(HostDataRootHost, DefaultDataRootHost, true, ValidateHostPath),
        new(HostPublicOrigin, _ => "", true, ValidateOptionalHttpOrigin),
        new(HostCorePublicOrigin, _ => "", true, ValidateOptionalHttpOrigin),
        new(HostShellPublicOrigin, _ => "http://127.0.0.1:3000", true, ValidateOptionalHttpOrigin),
        new(HostyShellManifestPath, _ => DefaultShellManifestPath, true, ValidateManifestReference),
        new(HostyShellBootstrapRuntime, _ => "docker", true, ValidateRuntimeKey),
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

    private static string? ValidateManifestReference(string value, HostyEnvironment environment)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return "Shell manifest path cannot be empty.";
        }

        var trimmed = value.Trim();
        if (Uri.TryCreate(trimmed, UriKind.Absolute, out var uri) &&
            (uri.Scheme == Uri.UriSchemeHttp || uri.Scheme == Uri.UriSchemeHttps))
        {
            if (!string.IsNullOrWhiteSpace(uri.UserInfo))
            {
                return "Shell manifest URL must not include credentials.";
            }

            return null;
        }

        if (trimmed.Contains("://", StringComparison.Ordinal))
        {
            return "Shell manifest URL must use http or https.";
        }

        var resolved = environment.ResolvePath(trimmed);
        return Path.IsPathFullyQualified(resolved) ? null : "Shell manifest path must resolve to an absolute path or be an http(s) URL.";
    }

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

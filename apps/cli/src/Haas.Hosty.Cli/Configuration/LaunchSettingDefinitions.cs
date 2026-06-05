namespace Haas.Hosty.Cli.Configuration;

internal static class LaunchSettingDefinitions
{
    public const string HostDataRootHost = "HOST_DATA_ROOT_HOST";
    public const string HostPublicOrigin = "HOST_PUBLIC_ORIGIN";
    public const string HostCorePublicOrigin = "HOST_CORE_PUBLIC_ORIGIN";
    public const string HostShellPublicOrigin = "HOST_SHELL_PUBLIC_ORIGIN";

    public static readonly IReadOnlyList<LaunchSettingDefinition> All =
    [
        new(HostDataRootHost, DefaultDataRootHost, true, ValidateHostPath),
        new(HostPublicOrigin, _ => "", true, ValidateOptionalHttpOrigin),
        new(HostCorePublicOrigin, _ => "", true, ValidateOptionalHttpOrigin),
        new(HostShellPublicOrigin, _ => "", true, ValidateOptionalHttpOrigin),
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

}

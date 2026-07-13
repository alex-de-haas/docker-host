namespace Haas.Hosty.Cli.Configuration;

internal static class LaunchSettingDefinitions
{
    public const string HostyDataRoot = "HOSTY_DATA_ROOT";
    public const string HostyCorePort = "HOSTY_CORE_PORT";
    public const string HostyShellPort = "HOSTY_SHELL_PORT";
    public const string HostyCorePublicOrigin = "HOSTY_CORE_PUBLIC_ORIGIN";
    public const string HostyShellPublicOrigin = "HOSTY_SHELL_PUBLIC_ORIGIN";

    public static readonly IReadOnlyList<LaunchSettingDefinition> All =
    [
        new(HostyDataRoot, DefaultDataRootHost, true, ValidateHostPath),
        new(HostyCorePort, _ => "7070", true, ValidatePort),
        new(HostyShellPort, _ => "7171", true, ValidatePort),
        new(HostyCorePublicOrigin, _ => "", true, ValidateOptionalHttpOrigin),
        new(HostyShellPublicOrigin, _ => "", true, ValidateOptionalHttpOrigin),
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
}

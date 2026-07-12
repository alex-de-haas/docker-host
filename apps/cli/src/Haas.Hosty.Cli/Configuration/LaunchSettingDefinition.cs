namespace Haas.Hosty.Cli.Configuration;

internal sealed record LaunchSettingDefinition(
    string Key,
    Func<HostyEnvironment, string> DefaultValue,
    bool IsEditable,
    Func<string, HostyEnvironment, string?> Validate,
    // Deprecated settings still validate and persist (Core honors them as legacy overrides for one
    // release) but `hosty config` points the operator at the replacement instead.
    bool IsDeprecated = false);


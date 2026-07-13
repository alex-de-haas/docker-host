namespace Haas.Hosty.Cli.Configuration;

internal sealed record LaunchSettingDefinition(
    string Key,
    Func<HostyEnvironment, string> DefaultValue,
    bool IsEditable,
    Func<string, HostyEnvironment, string?> Validate);


namespace Haas.DockerHost.Cli.Configuration;

internal sealed record LaunchSettingDefinition(
    string Key,
    Func<DockerHostEnvironment, string> DefaultValue,
    bool IsEditable,
    Func<string, DockerHostEnvironment, string?> Validate);


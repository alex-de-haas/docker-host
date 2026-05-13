namespace Haas.DockerHost.Cli.Commands;

using Haas.DockerHost.Cli.Configuration;
using Haas.DockerHost.Cli.Docker;
using Spectre.Console;

internal sealed record CommandContext(
    IAnsiConsole Console,
    DockerHostEnvironment Environment,
    LaunchSettingsStore SettingsStore,
    DockerEngineClientFactory DockerFactory);


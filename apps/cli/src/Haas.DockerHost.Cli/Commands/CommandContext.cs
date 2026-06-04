namespace Haas.DockerHost.Cli.Commands;

using Haas.DockerHost.Cli.Configuration;
using Spectre.Console;

internal sealed record CommandContext(
    IAnsiConsole Console,
    DockerHostEnvironment Environment,
    LaunchSettingsStore SettingsStore);

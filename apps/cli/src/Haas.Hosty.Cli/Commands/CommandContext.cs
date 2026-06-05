namespace Haas.Hosty.Cli.Commands;

using Haas.Hosty.Cli.Configuration;
using Spectre.Console;

internal sealed record CommandContext(
    IAnsiConsole Console,
    HostyEnvironment Environment,
    LaunchSettingsStore SettingsStore);

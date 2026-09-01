namespace Haas.Hosty.Cli.Commands;

using Haas.Hosty.Cli.Configuration;
using Spectre.Console;

internal sealed record CommandContext(
    IAnsiConsole Console,
    HostyEnvironment Environment,
    IAnsiConsole? ErrorConsole = null)
{
    /// <summary>
    /// Console for errors and diagnostics. Falls back to <see cref="Console"/> when no
    /// dedicated error console was supplied (e.g. in tests), so error output stays
    /// capturable while production routes it to stderr.
    /// </summary>
    public IAnsiConsole Error => ErrorConsole ?? Console;
}

namespace Haas.Hosty.Cli.Commands;

using Spectre.Console;

internal static class CommandStatus
{
    public static async Task RunAsync(
        CommandContext context,
        string status,
        Func<Task> action)
        => await context.Console
            .Status()
            .Spinner(Spinner.Known.Default)
            .StartAsync(status, async _ => await action());

    public static async Task<T> RunAsync<T>(
        CommandContext context,
        string status,
        Func<Task<T>> action)
        => await context.Console
            .Status()
            .Spinner(Spinner.Known.Default)
            .StartAsync(status, async _ => await action());
}

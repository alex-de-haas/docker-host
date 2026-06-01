namespace Haas.DockerHost.Cli.Commands;

using Spectre.Console;

internal sealed class UpdateCommand(CommandContext context)
{
    public async Task<int> ExecuteAsync(string[] args)
    {
        if (args.Length > 0)
        {
            throw new CommandUsageException("update does not accept arguments.", "Usage: hosty update");
        }

        try
        {
            await new SelfUpdateService(context).UpdateAsync();
        }
        catch (Exception ex) when (ex is HttpRequestException or IOException or InvalidOperationException or UnauthorizedAccessException or PlatformNotSupportedException)
        {
            context.Console.MarkupLine($"[red]CLI update failed:[/] {Markup.Escape(ex.Message)}");
            context.Console.MarkupLine("The Host container was not changed. Retry later, then restart the Host with [grey]hosty stop[/] and [grey]hosty start[/].");
            return 1;
        }

        context.Console.MarkupLine("[grey]Host image updates are checked during [white]hosty start[/].[/]");
        context.Console.MarkupLine("[grey]Restart the Host when convenient with [white]hosty stop[/] and [white]hosty start[/].[/]");

        return 0;
    }
}

namespace Haas.DockerHost.Cli.Commands;

using Spectre.Console;

internal sealed class UpdateCommand(CommandContext context)
{
    public async Task<int> ExecuteAsync(string[] args)
    {
        if (args.Length > 0)
        {
            throw new CommandUsageException("update does not accept arguments.", "Usage: docker-host update");
        }

        try
        {
            await new SelfUpdateService(context).UpdateAsync();
        }
        catch (Exception ex) when (ex is HttpRequestException or IOException or InvalidOperationException or UnauthorizedAccessException or PlatformNotSupportedException)
        {
            context.Console.MarkupLine($"[red]CLI update failed:[/] {Markup.Escape(ex.Message)}");
            context.Console.MarkupLine("The Host container was not changed. Retry later, then restart the Host with [grey]docker-host stop[/] and [grey]docker-host start[/].");
            return 1;
        }

        context.Console.MarkupLine("[grey]Host image updates are checked during [white]docker-host start[/].[/]");
        context.Console.MarkupLine("[grey]Restart the Host when convenient with [white]docker-host stop[/] and [white]docker-host start[/].[/]");

        return 0;
    }
}

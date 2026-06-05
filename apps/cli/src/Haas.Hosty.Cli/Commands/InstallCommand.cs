namespace Haas.Hosty.Cli.Commands;

using Haas.Hosty.Cli.Configuration;
using Spectre.Console;

internal sealed class InstallCommand(CommandContext context)
{
    public async Task<int> ExecuteAsync(string[] args)
    {
        if (args.Length > 0)
        {
            throw new CommandUsageException("install does not accept arguments.", "Usage: hosty install");
        }

        try
        {
            Directory.CreateDirectory(context.Environment.RootDirectory);
            Directory.CreateDirectory(context.Environment.ConfigDirectory);
            Directory.CreateDirectory(context.Environment.BinDirectory);
            Directory.CreateDirectory(context.Environment.AppsDirectory);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            throw new ConfigurationException($"Unable to prepare Hosty directories: {ex.Message}");
        }

        context.Console.MarkupLine("[green]Hosty local directories are ready.[/]");
        context.Console.MarkupLine($"Data root: [grey]{Markup.Escape(context.Environment.RootDirectory)}[/]");
        context.Console.MarkupLine("Next: run [grey]hosty start[/]");
        return 0;
    }
}

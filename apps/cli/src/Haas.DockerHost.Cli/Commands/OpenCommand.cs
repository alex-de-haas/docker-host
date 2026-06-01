namespace Haas.DockerHost.Cli.Commands;

using System.Diagnostics;
using Spectre.Console;

internal sealed class OpenCommand(CommandContext context)
{
    public async Task<int> ExecuteAsync(string[] args)
    {
        if (args.Length > 0)
        {
            throw new CommandUsageException("open does not accept arguments.", "Usage: hosty open");
        }

        var settings = context.SettingsStore.Load();
        settings.Validate(context.Environment);
        using var docker = context.DockerFactory.Create(settings.HostDockerEndpoint);
        var container = await docker.InspectContainerAsync(settings.HostContainerName);
        if (container?.State?.Running != true)
        {
            context.Console.MarkupLine("[red]Host container is not running.[/]");
            context.Console.MarkupLine("Run [grey]hosty start[/] first.");
            return 1;
        }

        var url = HostLifecycle.TryGetHostUrl(container, settings);
        if (url is null)
        {
            context.Console.MarkupLine("[red]Unable to determine the Host UI port from Docker container metadata.[/]");
            return 1;
        }

        if (TryOpen(url))
        {
            context.Console.MarkupLine($"Opened [grey]{Markup.Escape(url)}[/]");
        }
        else
        {
            context.Console.WriteLine(url);
        }

        return 0;
    }

    private static bool TryOpen(string url)
    {
        try
        {
            using var _ = Process.Start(new ProcessStartInfo
            {
                FileName = url,
                UseShellExecute = true,
            });

            return true;
        }
        catch
        {
            return false;
        }
    }
}

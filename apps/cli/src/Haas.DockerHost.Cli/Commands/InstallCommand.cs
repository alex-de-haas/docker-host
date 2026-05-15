namespace Haas.DockerHost.Cli.Commands;

using Haas.DockerHost.Cli.Configuration;
using Spectre.Console;

internal sealed class InstallCommand(CommandContext context)
{
    public async Task<int> ExecuteAsync(string[] args)
    {
        if (args.Length > 0)
        {
            throw new CommandUsageException("install does not accept arguments.", "Usage: docker-host install");
        }

        var settings = context.SettingsStore.EnsureInstalled();

        using var docker = context.DockerFactory.Create(settings.HostDockerEndpoint);
        await docker.EnsureLinuxEngineAsync();

        context.Console.MarkupLine("[green]Launch configuration is ready.[/]");
        context.Console.MarkupLine($"Config: [grey]{Markup.Escape(context.Environment.LaunchConfigPath)}[/]");
        context.Console.MarkupLine($"Data root: [grey]{Markup.Escape(settings.ResolveHostDataRoot(context.Environment))}[/]");
        context.Console.MarkupLine("Next: run [grey]docker-host start[/]");
        return 0;
    }
}

namespace Haas.DockerHost.Cli.Commands;

using Spectre.Console;

internal sealed class LogsCommand(CommandContext context)
{
    public async Task<int> ExecuteAsync(string[] args)
    {
        var tail = 200;
        if (args.Length == 2 && args[0] == "--tail")
        {
            if (!int.TryParse(args[1], out tail) || tail <= 0)
            {
                throw new CommandUsageException("--tail must be a positive integer.", "Usage: hosty logs [--tail <lines>]");
            }
        }
        else if (args.Length > 0)
        {
            throw new CommandUsageException("logs accepts only --tail <lines>.", "Usage: hosty logs [--tail <lines>]");
        }

        var settings = context.SettingsStore.Load();
        settings.Validate(context.Environment);
        using var docker = context.DockerFactory.Create(settings.HostDockerEndpoint);
        var logs = await docker.GetLogsAsync(settings.HostContainerName, tail);
        context.Console.WriteLine(logs);
        return 0;
    }
}

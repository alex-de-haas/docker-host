namespace Haas.DockerHost.Cli.Commands;

internal sealed class StartCommand(CommandContext context)
{
    public async Task<int> ExecuteAsync(string[] args)
    {
        if (args.Length > 0)
        {
            throw new CommandUsageException("start does not accept arguments.", "Usage: docker-host start");
        }

        var settings = context.SettingsStore.EnsureInstalled();
        await new HostLifecycle(context).StartAsync(settings, recreate: false);
        return 0;
    }
}


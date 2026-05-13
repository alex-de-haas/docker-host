namespace Haas.DockerHost.Cli.Commands;

internal sealed class RestartCommand(CommandContext context)
{
    public async Task<int> ExecuteAsync(string[] args)
    {
        if (args.Length > 0)
        {
            throw new CommandUsageException("restart does not accept arguments.", "Usage: docker-host restart");
        }

        var settings = context.SettingsStore.EnsureInstalled();
        await new HostLifecycle(context).StartAsync(settings, recreate: true);
        return 0;
    }
}

namespace Haas.DockerHost.Cli.Commands;

internal sealed class StopCommand(CommandContext context)
{
    public async Task<int> ExecuteAsync(string[] args)
    {
        if (args.Length > 0)
        {
            throw new CommandUsageException("stop does not accept arguments.", "Usage: hosty stop");
        }

        var settings = context.SettingsStore.Load();
        await new HostLifecycle(context).StopAsync(settings);
        return 0;
    }
}

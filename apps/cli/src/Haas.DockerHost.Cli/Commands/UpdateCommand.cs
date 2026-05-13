namespace Haas.DockerHost.Cli.Commands;

using Haas.DockerHost.Cli.Docker;
using Spectre.Console;

internal sealed class UpdateCommand(CommandContext context)
{
    public async Task<int> ExecuteAsync(string[] args)
    {
        var hostOnly = args is ["--host-only"];
        if (args.Length > 0 && !hostOnly)
        {
            throw new CommandUsageException("update accepts only --host-only.", "Usage: docker-host update [--host-only]");
        }

        var settings = context.SettingsStore.EnsureInstalled();

        if (!hostOnly)
        {
            try
            {
                await new SelfUpdateService(context).UpdateAsync();
            }
            catch (Exception ex) when (ex is HttpRequestException or IOException or InvalidOperationException or UnauthorizedAccessException or PlatformNotSupportedException)
            {
                context.Console.MarkupLine($"[red]CLI update failed:[/] {Markup.Escape(ex.Message)}");
                context.Console.MarkupLine("The Host container was not changed. Retry later or run [grey]docker-host update --host-only[/] to update only the Host container.");
                return 1;
            }
        }

        using var docker = context.DockerFactory.Create(settings.HostDockerEndpoint);
        await docker.EnsureLinuxEngineAsync();
        await docker.EnsureNetworkAsync(settings.HostModuleNetwork);

        context.Console.MarkupLine($"Pulling Host image [grey]{Markup.Escape(settings.HostImage)}[/]...");
        await docker.PullImageAsync(settings.HostImage);

        var existing = await docker.InspectContainerAsync(settings.HostContainerName);
        var previousPort = HostLifecycle.TryGetMappedPort(existing);
        if (existing?.State?.Running == true)
        {
            await docker.StopContainerAsync(settings.HostContainerName);
        }

        if (existing is not null)
        {
            await docker.RemoveContainerAsync(settings.HostContainerName);
        }

        var hostPort = settings.GetFixedHostPort() ?? previousPort ?? PortAllocator.GetFreeLoopbackPort();
        var plan = new HostContainerPlan(
            settings.HostImage,
            settings.HostContainerName,
            settings.ResolveHostDataRoot(context.Environment),
            settings.HostDataRootContainer,
            settings.HostDockerSocket,
            settings.HostModuleNetwork,
            settings.HostRestartPolicy,
            hostPort);

        await docker.CreateHostContainerAsync(plan);
        await docker.StartContainerAsync(settings.HostContainerName);

        context.Console.MarkupLine($"[green]Host container updated.[/] {Markup.Escape($"http://localhost:{hostPort}")}");
        return 0;
    }
}

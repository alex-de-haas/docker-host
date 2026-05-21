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
            SelfUpdateResult selfUpdateResult;
            try
            {
                selfUpdateResult = await new SelfUpdateService(context).UpdateAsync();
            }
            catch (Exception ex) when (ex is HttpRequestException or IOException or InvalidOperationException or UnauthorizedAccessException or PlatformNotSupportedException)
            {
                context.Console.MarkupLine($"[red]CLI update failed:[/] {Markup.Escape(ex.Message)}");
                context.Console.MarkupLine("The Host container was not changed. Retry later or run [grey]docker-host update --host-only[/] to update only the Host container.");
                return 1;
            }

            if (selfUpdateResult.WasUpdated)
            {
                context.Console.MarkupLine("[grey]Continuing Host container update with the updated CLI executable.[/]");
                try
                {
                    return await SelfUpdateService.RunUpdatedExecutableAsync(
                        selfUpdateResult.ExecutablePath,
                        SelfUpdateService.HostOnlyUpdateArguments);
                }
                catch (Exception ex) when (ex is InvalidOperationException or IOException or UnauthorizedAccessException or System.ComponentModel.Win32Exception)
                {
                    context.Console.MarkupLine($"[red]Unable to continue Host container update:[/] {Markup.Escape(ex.Message)}");
                    context.Console.MarkupLine("The CLI was updated, but the Host container was not changed. Run [grey]docker-host update --host-only[/] to finish the Host container update.");
                    return 1;
                }
            }
        }

        using var docker = context.DockerFactory.Create(settings.HostDockerEndpoint);
        await CommandStatus.RunAsync(
            context,
            "Checking Docker Engine...",
            async () => await docker.EnsureLinuxEngineAsync());
        await CommandStatus.RunAsync(
            context,
            $"Preparing module network [grey]{Markup.Escape(settings.HostModuleNetwork)}[/]...",
            async () => await docker.EnsureNetworkAsync(settings.HostModuleNetwork));

        await HostLifecycle.PullHostImageAsync(context, docker, settings.HostImage);

        var existing = await docker.InspectContainerAsync(settings.HostContainerName);
        var previousPort = HostLifecycle.TryGetMappedPort(existing);
        if (existing?.State?.Running == true)
        {
            await CommandStatus.RunAsync(
                context,
                $"Stopping Host container [grey]{Markup.Escape(settings.HostContainerName)}[/]...",
                async () => await docker.StopContainerAsync(settings.HostContainerName));
        }

        if (existing is not null)
        {
            await CommandStatus.RunAsync(
                context,
                $"Removing Host container [grey]{Markup.Escape(settings.HostContainerName)}[/]...",
                async () => await docker.RemoveContainerAsync(settings.HostContainerName));
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
            settings.HostBindAddress,
            settings.HostPublicOrigin,
            settings.HostGatewayBaseDomain,
            settings.HostModuleDevMode,
            hostPort);

        await CommandStatus.RunAsync(
            context,
            $"Creating Host container [grey]{Markup.Escape(settings.HostContainerName)}[/]...",
            async () => await docker.CreateHostContainerAsync(plan));
        await CommandStatus.RunAsync(
            context,
            $"Starting Host container [grey]{Markup.Escape(settings.HostContainerName)}[/]...",
            async () => await docker.StartContainerAsync(settings.HostContainerName));

        context.Console.MarkupLine($"[green]Host container updated.[/] {Markup.Escape($"http://localhost:{hostPort}")}");
        return 0;
    }
}

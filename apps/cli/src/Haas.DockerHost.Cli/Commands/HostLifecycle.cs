namespace Haas.DockerHost.Cli.Commands;

using Haas.DockerHost.Cli.Configuration;
using Haas.DockerHost.Cli.Docker;
using Spectre.Console;

internal sealed class HostLifecycle(CommandContext context)
{
    public async Task<DockerContainerInspect?> StartAsync(LaunchSettings settings, bool recreate, CancellationToken cancellationToken = default)
    {
        settings.Validate(context.Environment);
        Directory.CreateDirectory(settings.ResolveHostDataRoot(context.Environment));

        using var docker = context.DockerFactory.Create(settings.HostDockerEndpoint);
        await CommandStatus.RunAsync(
            context,
            "Checking Docker Engine...",
            async () => await docker.EnsureLinuxEngineAsync(cancellationToken));
        await CommandStatus.RunAsync(
            context,
            $"Preparing module network [grey]{Markup.Escape(settings.HostModuleNetwork)}[/]...",
            async () => await docker.EnsureNetworkAsync(settings.HostModuleNetwork, cancellationToken));

        var existing = await docker.InspectContainerAsync(settings.HostContainerName, cancellationToken);
        if (existing is not null && recreate)
        {
            if (existing.State?.Running == true)
            {
                await CommandStatus.RunAsync(
                    context,
                    $"Stopping Host container [grey]{Markup.Escape(settings.HostContainerName)}[/]...",
                    async () => await docker.StopContainerAsync(settings.HostContainerName, cancellationToken));
            }

            await CommandStatus.RunAsync(
                context,
                $"Removing Host container [grey]{Markup.Escape(settings.HostContainerName)}[/]...",
                async () => await docker.RemoveContainerAsync(settings.HostContainerName, cancellationToken));
            existing = null;
        }

        if (existing is not null)
        {
            if (existing.State?.Running == true)
            {
                context.Console.MarkupLine("[green]Host container is already running.[/]");
                return existing;
            }

            await CommandStatus.RunAsync(
                context,
                $"Starting Host container [grey]{Markup.Escape(settings.HostContainerName)}[/]...",
                async () => await docker.StartContainerAsync(settings.HostContainerName, cancellationToken));
            context.Console.MarkupLine("[green]Host container started.[/]");
            return await docker.InspectContainerAsync(settings.HostContainerName, cancellationToken);
        }

        if (!await docker.ImageExistsAsync(settings.HostImage, cancellationToken))
        {
            await PullHostImageAsync(context, docker, settings.HostImage, cancellationToken);
        }

        var hostPort = settings.GetFixedHostPort() ?? PortAllocator.GetFreeLoopbackPort();
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
            async () => await docker.CreateHostContainerAsync(plan, cancellationToken));
        await CommandStatus.RunAsync(
            context,
            $"Starting Host container [grey]{Markup.Escape(settings.HostContainerName)}[/]...",
            async () => await docker.StartContainerAsync(settings.HostContainerName, cancellationToken));

        context.Console.MarkupLine($"[green]Host container started on[/] {Markup.Escape(BuildUrl(hostPort))}");
        return await docker.InspectContainerAsync(settings.HostContainerName, cancellationToken);
    }

    public async Task StopAsync(LaunchSettings settings, CancellationToken cancellationToken = default)
    {
        settings.Validate(context.Environment);
        var dataRoot = settings.ResolveHostDataRoot(context.Environment);
        var moduleLoadResult = ModuleCleanupRecord.LoadFromDataRoot(dataRoot);

        if (moduleLoadResult.Error is not null)
        {
            context.Console.MarkupLine($"[yellow]Could not read installed module registry:[/] {Markup.Escape(moduleLoadResult.Error)}");
            context.Console.MarkupLine("[yellow]Module containers may need manual stop after the Host container stops.[/]");
        }

        using var docker = context.DockerFactory.Create(settings.HostDockerEndpoint);

        foreach (var module in moduleLoadResult.Modules)
        {
            foreach (var moduleContainer in module.GetContainersInStopOrder())
            {
                await TryStopModuleContainerAsync(docker, moduleContainer.ContainerName, cancellationToken);
            }
        }

        var hostContainer = await docker.InspectContainerAsync(settings.HostContainerName, cancellationToken);
        if (hostContainer is null)
        {
            context.Console.MarkupLine("[yellow]Host container does not exist.[/]");
            return;
        }

        if (hostContainer.State?.Running != true)
        {
            context.Console.MarkupLine("[yellow]Host container is already stopped.[/]");
            return;
        }

        await CommandStatus.RunAsync(
            context,
            $"Stopping Host container [grey]{Markup.Escape(settings.HostContainerName)}[/]...",
            async () => await docker.StopContainerAsync(settings.HostContainerName, cancellationToken));
        context.Console.MarkupLine("[green]Host container stopped.[/]");
    }

    public static string? TryGetHostUrl(DockerContainerInspect? container, LaunchSettings settings)
    {
        var mappedPort = TryGetMappedPort(container);
        if (mappedPort is not null)
        {
            return BuildUrl(mappedPort.Value);
        }

        var fixedPort = settings.GetFixedHostPort();
        return fixedPort is null ? null : BuildUrl(fixedPort.Value);
    }

    public static int? TryGetMappedPort(DockerContainerInspect? container)
    {
        var key = $"{HostContainerPlan.ContainerUiPort}/tcp";
        if (container?.NetworkSettings?.Ports is null ||
            !container.NetworkSettings.Ports.TryGetValue(key, out var bindings) ||
            bindings is null)
        {
            return null;
        }

        foreach (var binding in bindings)
        {
            if (int.TryParse(binding.HostPort, out var port))
            {
                return port;
            }
        }

        return null;
    }

    internal static async Task PullHostImageAsync(
        CommandContext context,
        DockerEngineClient docker,
        string image,
        CancellationToken cancellationToken = default)
        => await CommandStatus.RunAsync(
            context,
            $"Pulling Host image [grey]{Markup.Escape(image)}[/]...",
            async () => await docker.PullImageAsync(image, cancellationToken));

    internal static async Task EnsureHostImageInstalledAsync(
        CommandContext context,
        DockerEngineClient docker,
        string image,
        CancellationToken cancellationToken = default)
    {
        if (!IsSingleComponentImageReference(image) ||
            !await docker.ImageExistsAsync(image, cancellationToken))
        {
            await PullHostImageAsync(context, docker, image, cancellationToken);
            return;
        }

        context.Console.MarkupLine($"[grey]Using local Host image {Markup.Escape(image)}.[/]");
    }

    private static bool IsSingleComponentImageReference(string image)
        => !image.Contains('/', StringComparison.Ordinal);

    private async Task TryStopModuleContainerAsync(
        DockerEngineClient docker,
        string containerName,
        CancellationToken cancellationToken)
    {
        try
        {
            await CommandStatus.RunAsync(
                context,
                $"Stopping module container [grey]{Markup.Escape(containerName)}[/]...",
                async () => await docker.StopContainerAsync(containerName, cancellationToken));
        }
        catch (DockerEngineException ex)
        {
            context.Console.MarkupLine($"[yellow]Could not stop module container {Markup.Escape(containerName)}:[/] {Markup.Escape(ex.Message)}");
            if (!string.IsNullOrWhiteSpace(ex.DockerMessage))
            {
                context.Console.MarkupLine($"[grey]Docker message:[/] {Markup.Escape(ex.DockerMessage)}");
            }
        }
    }

    private static string BuildUrl(int port) => $"http://localhost:{port}";
}

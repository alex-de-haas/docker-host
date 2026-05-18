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
        await docker.EnsureLinuxEngineAsync(cancellationToken);
        await docker.EnsureNetworkAsync(settings.HostModuleNetwork, cancellationToken);

        var existing = await docker.InspectContainerAsync(settings.HostContainerName, cancellationToken);
        if (existing is not null && recreate)
        {
            if (existing.State?.Running == true)
            {
                await docker.StopContainerAsync(settings.HostContainerName, cancellationToken);
            }

            await docker.RemoveContainerAsync(settings.HostContainerName, cancellationToken);
            existing = null;
        }

        if (existing is not null)
        {
            if (existing.State?.Running == true)
            {
                context.Console.MarkupLine("[green]Host container is already running.[/]");
                return existing;
            }

            await docker.StartContainerAsync(settings.HostContainerName, cancellationToken);
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
            hostPort);

        await docker.CreateHostContainerAsync(plan, cancellationToken);
        await docker.StartContainerAsync(settings.HostContainerName, cancellationToken);

        context.Console.MarkupLine($"[green]Host container started on[/] {Markup.Escape(BuildUrl(hostPort))}");
        return await docker.InspectContainerAsync(settings.HostContainerName, cancellationToken);
    }

    public async Task StopAsync(LaunchSettings settings, CancellationToken cancellationToken = default)
    {
        settings.Validate(context.Environment);
        using var docker = context.DockerFactory.Create(settings.HostDockerEndpoint);
        var container = await docker.InspectContainerAsync(settings.HostContainerName, cancellationToken);
        if (container is null)
        {
            context.Console.MarkupLine("[yellow]Host container does not exist.[/]");
            return;
        }

        if (container.State?.Running != true)
        {
            context.Console.MarkupLine("[yellow]Host container is already stopped.[/]");
            return;
        }

        await docker.StopContainerAsync(settings.HostContainerName, cancellationToken);
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
        => await context.Console
            .Status()
            .Spinner(Spinner.Known.BoxBounce)
            .SpinnerStyle(Style.Parse("green"))
            .StartAsync(
                $"Pulling Host image [grey]{Markup.Escape(image)}[/]...",
                async _ => await docker.PullImageAsync(image, cancellationToken));

    private static string BuildUrl(int port) => $"http://localhost:{port}";
}

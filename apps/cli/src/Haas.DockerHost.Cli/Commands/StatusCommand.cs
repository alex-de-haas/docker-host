namespace Haas.DockerHost.Cli.Commands;

using Haas.DockerHost.Cli.Docker;
using Spectre.Console;

internal sealed class StatusCommand(CommandContext context)
{
    public async Task<int> ExecuteAsync(string[] args)
    {
        if (args.Length > 0)
        {
            throw new CommandUsageException("status does not accept arguments.", "Usage: hosty status");
        }

        var settings = context.SettingsStore.Load();
        settings.Validate(context.Environment);

        using var docker = context.DockerFactory.Create(settings.HostDockerEndpoint);
        await docker.EnsureLinuxEngineAsync();
        var container = await docker.InspectContainerAsync(settings.HostContainerName);
        var url = HostLifecycle.TryGetHostUrl(container, settings);

        var table = new Table()
            .RoundedBorder()
            .AddColumn("Property")
            .AddColumn("Value");

        table.AddRow("Container", Markup.Escape(settings.HostContainerName));
        table.AddRow("State", Markup.Escape(GetState(container)));
        table.AddRow("Image", Markup.Escape(container?.Config?.Image ?? settings.HostImage));
        table.AddRow("URL", Markup.Escape(url ?? "not available until the container is created"));
        table.AddRow("Data root", Markup.Escape(settings.ResolveHostDataRoot(context.Environment)));
        table.AddRow("Module network", Markup.Escape(settings.HostModuleNetwork));
        table.AddRow("Bind address", Markup.Escape(settings.HostBindAddress));
        table.AddRow("Public origin", Markup.Escape(string.IsNullOrWhiteSpace(settings.HostPublicOrigin) ? "(not set)" : settings.HostPublicOrigin));
        table.AddRow("Core public origin", Markup.Escape(string.IsNullOrWhiteSpace(settings.HostCorePublicOrigin) ? "(not set)" : settings.HostCorePublicOrigin));
        table.AddRow("Shell public origin", Markup.Escape(string.IsNullOrWhiteSpace(settings.HostShellPublicOrigin) ? "(not set)" : settings.HostShellPublicOrigin));
        table.AddRow("Gateway base domain", Markup.Escape(string.IsNullOrWhiteSpace(settings.HostGatewayBaseDomain) ? "(not set)" : settings.HostGatewayBaseDomain));
        table.AddRow("Docker endpoint", Markup.Escape(settings.HostDockerEndpoint));

        context.Console.Write(table);
        return container is null ? 1 : 0;
    }

    private static string GetState(DockerContainerInspect? container)
    {
        if (container is null)
        {
            return "not installed";
        }

        return container.State?.Running == true
            ? "running"
            : container.State?.Status ?? "stopped";
    }
}

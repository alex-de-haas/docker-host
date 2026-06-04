namespace Haas.DockerHost.Cli.Commands;

using Haas.DockerHost.Cli.Configuration;
using Haas.DockerHost.Cli.Docker;

internal static class HostContainerUrl
{
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

    private static int? TryGetMappedPort(DockerContainerInspect? container)
    {
        const string key = "3000/tcp";
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

    private static string BuildUrl(int port) => $"http://localhost:{port}";
}

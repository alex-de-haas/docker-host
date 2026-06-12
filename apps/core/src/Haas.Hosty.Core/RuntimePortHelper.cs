using System.Net;
using System.Net.Sockets;

namespace Haas.Hosty.Core;

internal static class RuntimePortHelper
{
    public static int ResolveHostPort(RuntimeLifecycleContext context, string serviceKey, RuntimePortManifest port, string key)
    {
        if (TryResolvePinnedHostPort(context, serviceKey, port, key, out var pinnedPort))
        {
            return pinnedPort;
        }

        return AllocateLoopbackPort();
    }

    public static bool TryResolvePinnedHostPort(
        RuntimeLifecycleContext context,
        string serviceKey,
        RuntimePortManifest portManifest,
        string key,
        out int port)
    {
        if (TryReadHostPortOverride(context, key, out port))
        {
            return true;
        }

        var explicitPort = portManifest.LocalPort ?? portManifest.HostPort;
        if (explicitPort is not null)
        {
            port = explicitPort.Value;
            return true;
        }

        return TryReadPreviousEndpointPort(context, serviceKey, key, out port);
    }

    public static bool TryReadHostPortOverride(RuntimeLifecycleContext context, string key, out int port)
    {
        port = 0;
        var settingKey = $"HOSTY_PORT_{NormalizeEnvironmentKey(key)}";
        if (!context.App.Settings.TryGetValue(settingKey, out var setting) ||
            string.IsNullOrWhiteSpace(setting.Value))
        {
            return false;
        }

        if (int.TryParse(setting.Value.Trim(), System.Globalization.NumberStyles.None, System.Globalization.CultureInfo.InvariantCulture, out port) &&
            port is > 0 and <= IPEndPoint.MaxPort)
        {
            return true;
        }

        throw new AppLifecycleException("runtime_port_invalid", $"{settingKey} must be an integer between 1 and {IPEndPoint.MaxPort}.");
    }

    public static string NormalizeEnvironmentKey(string value)
        => new(value.Select(character => char.IsLetterOrDigit(character) ? char.ToUpperInvariant(character) : '_').ToArray());

    private static bool TryReadPreviousEndpointPort(RuntimeLifecycleContext context, string serviceKey, string key, out int port)
    {
        port = 0;
        var endpoint = context.App.Endpoints.FirstOrDefault(endpoint =>
            string.Equals(endpoint.Service, serviceKey, StringComparison.Ordinal) &&
            string.Equals(endpoint.Port, key, StringComparison.Ordinal) &&
            !string.IsNullOrWhiteSpace(endpoint.Url));
        if (endpoint is null ||
            !Uri.TryCreate(endpoint.Url, UriKind.Absolute, out var uri) ||
            uri.Port is <= 0 or > IPEndPoint.MaxPort)
        {
            return false;
        }

        port = uri.Port;
        return true;
    }

    private static int AllocateLoopbackPort()
    {
        using var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        return ((IPEndPoint)listener.LocalEndpoint).Port;
    }
}

using System.Net;
using System.Net.Sockets;

namespace Haas.Hosty.Core;

internal static class RuntimePortHelper
{
    public static int ResolveHostPort(RuntimeLifecycleContext context, RuntimePortManifest port, string key)
    {
        if (TryReadHostPortOverride(context, key, out var overridePort))
        {
            return overridePort;
        }

        return port.LocalPort ?? port.HostPort ?? AllocateLoopbackPort();
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

    private static int AllocateLoopbackPort()
    {
        using var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        return ((IPEndPoint)listener.LocalEndpoint).Port;
    }
}

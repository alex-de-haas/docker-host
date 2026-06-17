using System.Net;
using System.Net.Sockets;

namespace Haas.Hosty.Core;

internal static class RuntimePortHelper
{
    // The OS can hand the same ephemeral port to two concurrent starts once the probe
    // listener closes; remembering recent allocations excludes those self-races.
    private const int RecentAllocationMemory = 64;
    private const int MaxAllocationAttempts = 128;
    private static readonly object AllocationLock = new();
    private static readonly HashSet<int> RecentlyAllocatedPorts = [];
    private static readonly Queue<int> RecentlyAllocatedQueue = new();

    // `exclude` lets a caller resolving several ports in one pass (before any is bound) keep
    // dynamic allocations off ports it has already handed out — pinned or dynamic — closing the
    // window where two not-yet-started siblings could be probed onto the same loopback port.
    public static int ResolveHostPort(
        RuntimeLifecycleContext context,
        string serviceKey,
        RuntimePortManifest port,
        string key,
        IReadOnlySet<int>? exclude = null)
    {
        if (TryResolvePinnedHostPort(context, serviceKey, port, key, out var pinnedPort))
        {
            return pinnedPort;
        }

        return AllocateLoopbackPort(exclude);
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

    private static int AllocateLoopbackPort(IReadOnlySet<int>? exclude = null)
    {
        lock (AllocationLock)
        {
            for (var attempt = 0; attempt < MaxAllocationAttempts; attempt++)
            {
                using var listener = new TcpListener(IPAddress.Loopback, 0);
                listener.Start();
                var port = ((IPEndPoint)listener.LocalEndpoint).Port;
                listener.Stop();
                if (exclude is not null && exclude.Contains(port))
                {
                    continue;
                }

                if (RecentlyAllocatedPorts.Add(port))
                {
                    RecentlyAllocatedQueue.Enqueue(port);
                    while (RecentlyAllocatedQueue.Count > RecentAllocationMemory)
                    {
                        RecentlyAllocatedPorts.Remove(RecentlyAllocatedQueue.Dequeue());
                    }

                    return port;
                }
            }
        }

        throw new AppLifecycleException(
            "runtime_port_allocation_failed",
            "Unable to allocate a free loopback port that was not already handed to another starting service.");
    }
}

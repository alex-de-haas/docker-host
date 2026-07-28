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
        AppRecord app,
        string serviceKey,
        RuntimePortManifest port,
        string key,
        IReadOnlySet<int>? exclude = null)
    {
        if (TryResolvePinnedHostPort(app, serviceKey, port, key, out var pinnedPort))
        {
            return pinnedPort;
        }

        return AllocateLoopbackPort(exclude);
    }

    public static bool TryResolvePinnedHostPort(
        AppRecord app,
        string serviceKey,
        RuntimePortManifest portManifest,
        string key,
        out int port)
    {
        // Service-scoped override wins first so an operator can pin one service when a port key (e.g.
        // `http`) is shared by another service in the same app, which the app-scoped form cannot express.
        if (TryReadHostPortOverride(app, ServiceScopedOverrideKey(serviceKey, key), out port) ||
            TryReadHostPortOverride(app, key, out port))
        {
            return true;
        }

        var explicitPort = portManifest.LocalPort ?? portManifest.HostPort;
        if (explicitPort is not null)
        {
            port = explicitPort.Value;
            return true;
        }

        // The install-time reservation is the durable source of an automatic port; a start consumes it
        // instead of allocating a fresh one. The legacy endpoint-URL sticky remains a fallback for records
        // that predate the assignment model (or a port added after install without a re-allocation).
        if (TryReadAssignedHostPort(app, serviceKey, key, out port))
        {
            return true;
        }

        return TryReadPreviousEndpointPort(app, serviceKey, key, out port);
    }

    public static bool TryReadHostPortOverride(AppRecord app, string key, out int port)
    {
        port = 0;
        var settingKey = OverrideSettingKey(key);
        if (!app.Settings.TryGetValue(settingKey, out var setting) ||
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

    // True when a HOSTY_PORT_* override (service- or app-scoped) exists with a non-blank value for this
    // port. A non-throwing presence check used to classify an assignment's source; the value is validated
    // by TryReadHostPortOverride at resolution time.
    public static bool HasHostPortOverride(AppRecord app, string serviceKey, string key)
        => HasOverrideSetting(app, ServiceScopedOverrideKey(serviceKey, key)) || HasOverrideSetting(app, key);

    public static string NormalizeEnvironmentKey(string value)
        => new(value.Select(character => char.IsLetterOrDigit(character) ? char.ToUpperInvariant(character) : '_').ToArray());

    // The env/setting key an override for `key` is read from (HOSTY_PORT_<NORMALIZED-KEY>).
    public static string OverrideSettingKey(string key)
        => $"HOSTY_PORT_{NormalizeEnvironmentKey(key)}";

    // The setting key a service-scoped override lives under. Public so the reassign path writes exactly the
    // key TryResolvePinnedHostPort reads first, instead of re-deriving the `<service>_<key>` convention.
    public static string ServiceScopedOverrideSettingKey(string serviceKey, string key)
        => OverrideSettingKey(ServiceScopedOverrideKey(serviceKey, key));

    // Allocate a free loopback TCP port, excluding a caller-provided set (ports already handed out in the
    // same pass, or reserved by other installed apps and the platform). Public so the install-time
    // allocator can resolve automatic ports with the same self-race protection the start path uses.
    public static int AllocateLoopbackPort(IReadOnlySet<int>? exclude = null)
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

    // True when `port` is free for a loopback-published service. Probes the loopback *and* the wildcard
    // address of both families: a loopback probe alone cannot see a holder bound to `0.0.0.0`/`::`, which
    // is what a localCommand app that listens on "all interfaces" produces. On BSD/macOS the kernel lets a
    // specific address bind alongside a wildcard one whenever the new socket carries SO_REUSEADDR — and
    // .NET turns SO_REUSEADDR on *inside* Socket.Bind on Unix regardless of ExclusiveAddressUse, so no
    // loopback-only probe can report that conflict. An exact-address match is refused whatever the reuse
    // flags are, so probing the wildcard itself finds the wildcard holder. TCP-specific by design (the
    // reservation model is currently TCP-only); a UDP probe would need its own helper. Used by the
    // localCommand adapter's explicit preflight and by the lifecycle start-time reservation preflight.
    // Point-in-time, not a lease.
    //
    // Only a loopback bind has to *succeed*: for the other three, just `InUse` is disqualifying, so a
    // platform that refuses a wildcard bind for its own reasons (a Windows excluded port range answers
    // WSAEACCES, a host without IPv6 fails the `::` probes) does not turn into a phantom conflict. A
    // process holding the port on one specific non-loopback address is reported as a conflict even though
    // a loopback-only bind could still squeeze in beside it — a reserved port shared with an unrelated
    // listener is worth failing loudly for, and the error names the port and offers a reassignment.
    public static bool IsLoopbackTcpPortAvailable(int port)
    {
        if (port is <= 0 or > IPEndPoint.MaxPort)
        {
            return false;
        }

        if (ProbeBind(IPAddress.Loopback, port) is not PortBindProbeResult.Available ||
            ProbeBind(IPAddress.Any, port) is PortBindProbeResult.InUse)
        {
            return false;
        }

        return !Socket.OSSupportsIPv6 ||
            (ProbeBind(IPAddress.IPv6Loopback, port) is not PortBindProbeResult.InUse &&
                ProbeBind(IPAddress.IPv6Any, port) is not PortBindProbeResult.InUse);
    }

    // Binds without listening: bind() is where the address conflict is decided, and the wildcard probes
    // above would otherwise put a real listening socket on every interface for the length of the probe.
    private static PortBindProbeResult ProbeBind(IPAddress address, int port)
    {
        try
        {
            using var socket = new Socket(address.AddressFamily, SocketType.Stream, ProtocolType.Tcp);
            socket.Bind(new IPEndPoint(address, port));
            return PortBindProbeResult.Available;
        }
        catch (SocketException ex) when (ex.SocketErrorCode == SocketError.AddressAlreadyInUse)
        {
            return PortBindProbeResult.InUse;
        }
        catch (SocketException)
        {
            return PortBindProbeResult.Unavailable;
        }
    }

    private enum PortBindProbeResult
    {
        Available,
        InUse,
        Unavailable,
    }

    private static string ServiceScopedOverrideKey(string serviceKey, string key) => $"{serviceKey}_{key}";

    private static bool HasOverrideSetting(AppRecord app, string key)
        => app.Settings.TryGetValue(OverrideSettingKey(key), out var setting) && !string.IsNullOrWhiteSpace(setting.Value);

    private static bool TryReadAssignedHostPort(AppRecord app, string serviceKey, string key, out int port)
    {
        port = 0;
        var assignment = app.PortAssignments?.FirstOrDefault(assignment =>
            string.Equals(assignment.Service, serviceKey, StringComparison.Ordinal) &&
            string.Equals(assignment.PortKey, key, StringComparison.Ordinal));
        if (assignment is null || assignment.HostPort is <= 0 or > IPEndPoint.MaxPort)
        {
            return false;
        }

        port = assignment.HostPort;
        return true;
    }

    private static bool TryReadPreviousEndpointPort(AppRecord app, string serviceKey, string key, out int port)
    {
        port = 0;
        var endpoint = app.Endpoints.FirstOrDefault(endpoint =>
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
}

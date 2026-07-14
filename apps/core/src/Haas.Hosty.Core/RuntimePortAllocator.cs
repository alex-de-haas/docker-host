using System.Globalization;

namespace Haas.Hosty.Core;

// Install-time port reservations, phase 2: the Core-wide coordinator that resolves and persists every
// published host port for an app during install, so a stopped app already has a durable endpoint before
// its first start. A single gate serializes allocation across apps, so two concurrent installs cannot be
// handed the same automatic port; the exclusion view spans every other installed app's loopback assignments
// plus the Core and Shell launch ports. Resolution reuses RuntimePortHelper so install and start agree.
// See docs/planning/install-time-runtime-port-reservations.md.
internal sealed class RuntimePortAllocator(HostyCoreRuntimeConfig config)
{
    private readonly SemaphoreSlim gate = new(1, 1);

    public async Task<AppRecord> AssignAsync(
        AppRecord record,
        RuntimeAppManifestSelection selection,
        IReadOnlyList<AppRecord> otherInstalledApps,
        CancellationToken cancellationToken = default)
    {
        await gate.WaitAsync(cancellationToken);
        try
        {
            return Assign(record, selection, otherInstalledApps);
        }
        finally
        {
            gate.Release();
        }
    }

    private AppRecord Assign(
        AppRecord record,
        RuntimeAppManifestSelection selection,
        IReadOnlyList<AppRecord> otherInstalledApps)
    {
        // Exclude every loopback host port already reserved by another installed app plus the Core and
        // Shell launch ports, so a fresh automatic allocation cannot collide with a stopped sibling or the
        // platform. Host-network assignments bind a fixed container port and never enter this pool.
        var reserved = new HashSet<int>(otherInstalledApps
            .SelectMany(app => app.PortAssignments ?? [])
            .Where(assignment => !string.Equals(assignment.BindScope, AppPortBindScopes.HostNetwork, StringComparison.Ordinal))
            .Select(assignment => assignment.HostPort));
        reserved.Add(config.CorePort);
        reserved.Add(config.ShellPort);

        var now = DateTimeOffset.UtcNow;
        var assignments = new List<AppPortAssignment>();
        // (service, portKey) -> (host port, protocol) for projecting endpoint URLs after resolution.
        var resolved = new Dictionary<(string Service, string PortKey), (int HostPort, string Protocol)>();

        foreach (var service in selection.Services)
        {
            var hostNetwork = service.Runtime.IsHostNetwork;
            foreach (var port in service.Runtime.Ports)
            {
                if (port.ContainerPort is null)
                {
                    continue;
                }

                var key = port.Key ?? port.ContainerPort.Value.ToString(CultureInfo.InvariantCulture);
                var identity = (service.Key, key);
                if (resolved.ContainsKey(identity))
                {
                    continue;
                }

                int hostPort;
                string bindScope;
                string source;
                bool remappable;
                if (hostNetwork)
                {
                    hostPort = port.ContainerPort.Value;
                    bindScope = AppPortBindScopes.HostNetwork;
                    source = AppPortSources.HostNetwork;
                    remappable = false;
                }
                else
                {
                    hostPort = RuntimePortHelper.ResolveHostPort(record, service.Key, port, key, reserved);
                    reserved.Add(hostPort);
                    bindScope = string.Equals(port.Expose, "host", StringComparison.OrdinalIgnoreCase)
                        ? AppPortBindScopes.Host
                        : AppPortBindScopes.Loopback;
                    (source, remappable) = ClassifySource(record, service.Key, port, key);
                }

                assignments.Add(new AppPortAssignment(
                    Service: service.Key,
                    PortKey: key,
                    HostPort: hostPort,
                    Transport: AppPortTransports.Tcp,
                    BindScope: bindScope,
                    Source: source,
                    Remappable: remappable,
                    AssignedAt: now));
                var protocol = string.IsNullOrWhiteSpace(port.Protocol) ? "http" : port.Protocol;
                resolved[identity] = (hostPort, protocol);
            }
        }

        var endpoints = ProjectEndpointUrls(record.Endpoints, resolved);
        return record with { PortAssignments = assignments, Endpoints = endpoints };
    }

    // Classify how a resolved (non-host-network) port was pinned, so reassignment can later target only
    // automatic ports. An operator override or an explicit manifest port is not remappable.
    private static (string Source, bool Remappable) ClassifySource(
        AppRecord record,
        string serviceKey,
        RuntimePortManifest port,
        string key)
    {
        if (RuntimePortHelper.HasHostPortOverride(record, serviceKey, key))
        {
            return (AppPortSources.Operator, false);
        }

        if ((port.LocalPort ?? port.HostPort) is not null)
        {
            return (AppPortSources.Manifest, false);
        }

        return (AppPortSources.Automatic, true);
    }

    // Project the resolved host ports onto the app's endpoint contracts, so a stopped app carries a usable
    // local URL. Only endpoints without a URL are filled; a URL already resolved by a prior start is left
    // as the authority. Matches an endpoint to its assignment by (service, port key), the same key the
    // start path uses. The host comes from RuntimePublicHost, keeping host→app URLs literal IPv4.
    private IReadOnlyList<AppEndpointContract> ProjectEndpointUrls(
        IReadOnlyList<AppEndpointContract> endpoints,
        IReadOnlyDictionary<(string Service, string PortKey), (int HostPort, string Protocol)> resolved)
        => endpoints
            .Select(endpoint =>
            {
                if (!string.IsNullOrWhiteSpace(endpoint.Url) ||
                    string.IsNullOrWhiteSpace(endpoint.Service) ||
                    string.IsNullOrWhiteSpace(endpoint.Port) ||
                    !resolved.TryGetValue((endpoint.Service!, endpoint.Port!), out var target))
                {
                    return endpoint;
                }

                var protocol = string.IsNullOrWhiteSpace(endpoint.Protocol) ? target.Protocol : endpoint.Protocol;
                return endpoint with { Url = $"{protocol}://{config.RuntimePublicHost}:{target.HostPort}" };
            })
            .ToArray();
}

using System.Globalization;
using System.Net;
using Microsoft.Extensions.Logging;

namespace Haas.Hosty.Core;

// Install-time port reservations: the Core-wide coordinator that resolves and persists every
// published host port for an app during install, so a stopped app already has a durable endpoint before
// its first start. A single gate serializes allocation across apps, so two concurrent installs cannot be
// handed the same automatic port; the exclusion view spans every other installed app's non-host-network
// assignments — loopback and host scope alike, since a raw-L4 `host` publish occupies the same host port
// number — plus the Core port (Shell pins its own in its manifest; see ReservedLoopbackPorts). Resolution
// reuses RuntimePortHelper so install and start agree.
// See docs/features/automatic-runtime-app-ports/feature.md.
internal sealed class RuntimePortAllocator(HostyCoreRuntimeConfig config, ILogger<RuntimePortAllocator>? logger = null)
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

    // Read the exclusion view, assign, and persist as one critical section, so two concurrent installs of
    // different apps cannot each allocate against a snapshot that predates the other's persisted ports. The
    // caller supplies how to list installed apps and how to persist; both run under the gate against a fresh
    // read, so the second install observes the first's reservation. The record's own id is excluded from
    // the exclusion view.
    public async Task<TResult> AssignAndPersistAsync<TResult>(
        AppRecord record,
        RuntimeAppManifestSelection selection,
        Func<CancellationToken, Task<IReadOnlyList<AppRecord>>> listInstalled,
        Func<AppRecord, CancellationToken, Task<TResult>> persist,
        CancellationToken cancellationToken = default)
    {
        await gate.WaitAsync(cancellationToken);
        try
        {
            var others = (await listInstalled(cancellationToken))
                .Where(other => !string.Equals(other.Id, record.Id, StringComparison.Ordinal))
                .ToArray();
            var assigned = Assign(record, selection, others);
            return await persist(assigned, cancellationToken);
        }
        finally
        {
            gate.Release();
        }
    }

    // Reassign one loopback port, as one critical section under the gate so the new port is chosen — or an
    // operator-chosen one validated — against the current view of every other app plus the platform. The
    // exclusion set spans other apps' loopback ports, the Core/Shell launch ports, and this record's other
    // loopback reservations; in automatic mode the old port joins it so the new one always differs.
    //
    // `desiredPort` switches the operation from "pick a free port" to "pin this one": the port is validated
    // against that same view, the assignment becomes Operator-sourced and non-remappable, and the
    // HOSTY_PORT_* override is written so start-time resolution agrees with the record. A null
    // `desiredPort` allocates automatically and clears the override, returning the assignment to
    // Automatic/remappable. Assignment, endpoint URL, and override setting move together in the single
    // record handed to `persist`, so the record can never disagree with itself. Returns the persisted
    // record with the old and new ports.
    public async Task<(TResult Persisted, int OldPort, int NewPort)> ReassignAsync<TResult>(
        AppRecord record,
        string service,
        string portKey,
        Func<CancellationToken, Task<IReadOnlyList<AppRecord>>> listInstalled,
        Func<AppRecord, CancellationToken, Task<TResult>> persist,
        int? desiredPort = null,
        CancellationToken cancellationToken = default)
    {
        var target = (record.PortAssignments ?? []).FirstOrDefault(assignment =>
            string.Equals(assignment.Service, service, StringComparison.Ordinal) &&
            string.Equals(assignment.PortKey, portKey, StringComparison.Ordinal))
            ?? throw new AppLifecycleException("reassign_not_found", $"No port assignment for service '{service}' key '{portKey}'.");

        await gate.WaitAsync(cancellationToken);
        try
        {
            var others = (await listInstalled(cancellationToken))
                .Where(other => !string.Equals(other.Id, record.Id, StringComparison.Ordinal))
                .ToArray();
            var reserved = ReservedLoopbackPorts(others);
            // Exclude every OTHER port this app already holds, regardless of bind scope: a host-scope
            // (raw L4) or host-network assignment occupies a real host port number too, so reusing it for
            // the reassigned loopback port would guarantee a bind conflict once that service (re)starts.
            foreach (var assignment in record.PortAssignments ?? [])
            {
                if (!(string.Equals(assignment.Service, service, StringComparison.Ordinal) &&
                      string.Equals(assignment.PortKey, portKey, StringComparison.Ordinal)))
                {
                    reserved.Add(assignment.HostPort);
                }
            }

            var oldPort = target.HostPort;
            int newPort;
            if (desiredPort is { } pinned)
            {
                ValidateManualPort(pinned, oldPort, reserved, record, others);
                newPort = pinned;
            }
            else
            {
                reserved.Add(oldPort);
                newPort = RuntimePortHelper.AllocateLoopbackPort(reserved, logger);
            }

            var manual = desiredPort is not null;
            var now = DateTimeOffset.UtcNow;
            var assignments = (record.PortAssignments ?? [])
                .Select(assignment => string.Equals(assignment.Service, service, StringComparison.Ordinal) &&
                    string.Equals(assignment.PortKey, portKey, StringComparison.Ordinal)
                        ? assignment with
                        {
                            HostPort = newPort,
                            AssignedAt = now,
                            // Classify the same way a fresh reservation would (see ClassifySource): an
                            // operator-chosen port must not stay eligible for a later automatic move.
                            Source = manual ? AppPortSources.Operator : AppPortSources.Automatic,
                            Remappable = !manual,
                        }
                        : assignment)
                .ToArray();
            var endpoints = (record.Endpoints ?? [])
                .Select(endpoint => string.Equals(endpoint.Service, service, StringComparison.Ordinal) &&
                    string.Equals(endpoint.Port, portKey, StringComparison.Ordinal)
                        ? endpoint with { Url = BuildUrl(EndpointProtocol(endpoint), newPort) }
                        : endpoint)
                .ToArray();
            var persisted = await persist(
                record with
                {
                    PortAssignments = assignments,
                    Endpoints = endpoints,
                    Settings = ApplyPortOverride(record, service, portKey, manual ? newPort : null),
                },
                cancellationToken);
            return (persisted, oldPort, newPort);
        }
        finally
        {
            gate.Release();
        }
    }

    // Ports below this need privileges Core does not have (it never runs as root), so a pin there would only
    // fail later at bind time. Rejecting it at the point of choice is the honest answer. Exposed so the plan
    // can tell the Shell the floor instead of the UI hard-coding its own copy.
    internal const int MinManualPort = 1024;

    // Validate an operator-chosen host port against the same exclusion view an automatic allocation uses.
    // Re-pinning the port this endpoint already holds is allowed and skips the bind probe — the owning app
    // may legitimately be running on it, and probing would report its own listener as a conflict.
    private void ValidateManualPort(
        int port,
        int currentPort,
        IReadOnlySet<int> reserved,
        AppRecord record,
        IReadOnlyList<AppRecord> others)
    {
        if (port is <= 0 or > IPEndPoint.MaxPort)
        {
            throw new AppLifecycleException(
                "port_out_of_range",
                $"Port {port} is outside the valid range 1-{IPEndPoint.MaxPort}.");
        }

        if (port < MinManualPort)
        {
            throw new AppLifecycleException(
                "port_privileged",
                $"Port {port} is privileged (below {MinManualPort}) and Core cannot bind it. Choose {MinManualPort} or above.");
        }

        if (port == currentPort)
        {
            return;
        }

        if (reserved.Contains(port))
        {
            throw new AppLifecycleException(
                "port_reserved",
                $"Port {port} is already reserved by {DescribePortHolder(port, record, others)}.");
        }

        if (!RuntimePortHelper.IsLoopbackTcpPortAvailable(port))
        {
            throw new AppLifecycleException(
                "port_in_use",
                $"Port {port} is currently held by another process on this host.");
        }
    }

    // Name the holder of a reserved port, so a conflict tells the operator what to act on instead of leaving
    // them to guess which app took it.
    private string DescribePortHolder(int port, AppRecord record, IReadOnlyList<AppRecord> others)
    {
        if (port == config.CorePort)
        {
            return "Hosty Core";
        }

        var owner = others.FirstOrDefault(other =>
            (other.PortAssignments ?? []).Any(assignment => assignment.HostPort == port));
        if (owner is not null)
        {
            return $"app '{owner.Id}'";
        }

        var own = (record.PortAssignments ?? []).FirstOrDefault(assignment => assignment.HostPort == port);
        return own is not null
            ? $"this app's own {own.Service}.{own.PortKey} endpoint"
            : "the platform";
    }

    // Write (or clear) the HOSTY_PORT_* override so start-time resolution agrees with the assignment we just
    // persisted. Always the service-scoped key: the app-scoped form cannot express a port key like `http`
    // shared by two services.
    //
    // Clearing also drops a legacy app-scoped override for the same key — otherwise "back to automatic"
    // would leave a pin behind that silently re-applies at the next start. That removal is skipped when
    // another service in this app shares the port key, since the app-scoped override speaks for those too
    // and un-pinning them here would be an invisible side effect of editing this endpoint.
    private static IReadOnlyDictionary<string, AppSettingValue> ApplyPortOverride(
        AppRecord record,
        string service,
        string portKey,
        int? port)
    {
        var settings = record.Settings.ToDictionary(pair => pair.Key, pair => pair.Value, StringComparer.Ordinal);
        var scopedKey = RuntimePortHelper.ServiceScopedOverrideSettingKey(service, portKey);
        if (port is { } pinned)
        {
            var value = pinned.ToString(CultureInfo.InvariantCulture);
            settings[scopedKey] = settings.TryGetValue(scopedKey, out var existing)
                ? existing with { Value = value }
                : new AppSettingValue(scopedKey, "string", value, Secret: false);
            return settings;
        }

        settings.Remove(scopedKey);
        var sharedWithAnotherService = (record.PortAssignments ?? []).Any(assignment =>
            string.Equals(assignment.PortKey, portKey, StringComparison.Ordinal) &&
            !string.Equals(assignment.Service, service, StringComparison.Ordinal));
        if (!sharedWithAnotherService)
        {
            settings.Remove(RuntimePortHelper.OverrideSettingKey(portKey));
        }

        return settings;
    }

    private AppRecord Assign(
        AppRecord record,
        RuntimeAppManifestSelection selection,
        IReadOnlyList<AppRecord> otherInstalledApps)
    {
        // Exclude every loopback host port already reserved by another installed app plus the Core and
        // Shell launch ports, so a fresh automatic allocation cannot collide with a stopped sibling or the
        // platform. Host-network assignments bind a fixed container port and never enter this pool.
        var reserved = ReservedLoopbackPorts(otherInstalledApps);

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
                    hostPort = RuntimePortHelper.ResolveHostPort(record, service.Key, port, key, reserved, logger);
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

        var endpoints = ProjectEndpointUrls(record.Endpoints ?? [], resolved);
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
                return endpoint with { Url = BuildUrl(protocol, target.HostPort) };
            })
            .ToArray();

    // The host port numbers no fresh automatic allocation may reuse: every non-host-network reservation
    // held by another installed app, plus the Core port. Host-scope (raw L4) reservations are in the set
    // alongside loopback ones — they occupy a real host port number too — and only host-network is left
    // out, since it binds a fixed container port in another namespace. Core's port stays because Core is
    // not an app and has no assignment to be found in.
    //
    // Shell is not special-cased any more: it pins its port in its own manifest like any app, and once
    // installed its assignment is in the set below. That does drop a guarantee — before Shell installs,
    // nothing holds its pinned port — but only to the exact degree every other app already lives with: no
    // one reserves a pinned port for an app that is not installed yet. Reserving Shell's would be the
    // special case this exists to remove. In practice the window is narrower still: automatic allocation
    // draws from the Hosty band (RuntimePortHelper.AutomaticPortRangeStart), which is deliberately above
    // the development-port neighbourhood apps pin by hand. An app that pins inside the band could still
    // collide, and then its start fails with the same reassign-able runtime_port_unavailable any app gets
    // — recoverable by setting HOSTY_PORT_HTTP on it, which now sticks instead of being re-stamped.
    private HashSet<int> ReservedLoopbackPorts(IEnumerable<AppRecord> apps)
    {
        var reserved = new HashSet<int>(apps
            .SelectMany(app => app.PortAssignments ?? [])
            .Where(assignment => !string.Equals(assignment.BindScope, AppPortBindScopes.HostNetwork, StringComparison.Ordinal))
            .Select(assignment => assignment.HostPort));
        reserved.Add(config.CorePort);
        return reserved;
    }

    // A host→app URL uses RuntimePublicHost (a literal IPv4 by default) so it never resolves through the
    // docker-proxy IPv6 black hole. See the RuntimePublicHost note in the telemetry port-pin fix.
    private string BuildUrl(string protocol, int port) => $"{protocol}://{config.RuntimePublicHost}:{port}";

    private static string EndpointProtocol(AppEndpointContract endpoint)
        => string.IsNullOrWhiteSpace(endpoint.Protocol) ? "http" : endpoint.Protocol;
}

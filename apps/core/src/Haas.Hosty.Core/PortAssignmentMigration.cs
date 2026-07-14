using System.Globalization;
using System.Net;

namespace Haas.Hosty.Core;

// Install-time port reservations, phase 1: derive persistent service-scoped port assignments for existing
// records from their stored endpoint URLs, so a later start consumes a durable reservation instead of the
// URL. This runs at boot before autostart reconciliation and is a pure, additive, idempotent projection —
// it never changes a stored endpoint URL and never allocates a new port (allocation moves to install in
// phase 2). Endpoints that have never started (Url == null) get no reservation yet.
// See docs/planning/install-time-runtime-port-reservations.md.
internal static class PortAssignmentMigration
{
    // Returns the record with backfilled PortAssignments, or null when nothing changed (idempotent: a
    // second pass over an already-migrated record produces no delta because every derivable identity is
    // already present). Existing assignments are preserved; only missing identities are added.
    public static AppRecord? DeriveAssignments(AppRecord app)
    {
        var existing = app.PortAssignments ?? [];
        // Build the identity map defensively rather than via ToDictionary: a corrupted or hand-edited
        // record could carry duplicate identities, and this runs at boot — ToDictionary would throw
        // ArgumentException and abort the backfill. First occurrence wins.
        var byIdentity = new Dictionary<(string, string, string, string), AppPortAssignment>();
        foreach (var assignment in existing)
        {
            byIdentity.TryAdd(AssignmentIdentity(assignment), assignment);
        }

        var added = false;
        var now = DateTimeOffset.UtcNow;

        foreach (var endpoint in app.Endpoints)
        {
            if (string.IsNullOrWhiteSpace(endpoint.Service) ||
                string.IsNullOrWhiteSpace(endpoint.Port) ||
                !TryReadEndpointPort(endpoint.Url, out var hostPort))
            {
                continue;
            }

            // Phase 1 only migrates ordinary loopback HTTP ports (the sole shape the current allocator
            // produces); raw L4 and host-network transports/scopes arrive with their own reservation paths.
            var identity = (endpoint.Service!, endpoint.Port!, AppPortTransports.Tcp, AppPortBindScopes.Loopback);
            if (byIdentity.ContainsKey(identity))
            {
                continue;
            }

            var source = ResolveSource(app.Settings, hostPort);
            byIdentity[identity] = new AppPortAssignment(
                Service: endpoint.Service!,
                PortKey: endpoint.Port!,
                HostPort: hostPort,
                Transport: AppPortTransports.Tcp,
                BindScope: AppPortBindScopes.Loopback,
                Source: source,
                // Only an OS-selected automatic port participates in automatic reassignment; an
                // operator-pinned port is a preference the operator owns, not a remappable one.
                Remappable: string.Equals(source, AppPortSources.Automatic, StringComparison.Ordinal),
                AssignedAt: now);
            added = true;
        }

        if (!added)
        {
            return null;
        }

        // Deterministic order across the full identity (service, port key, transport, bind scope) so the
        // persisted collection is stable across runs and diffs are legible even when a service exposes the
        // same port key on several transports/scopes; identity dedup already happened above.
        var assignments = byIdentity.Values
            .OrderBy(assignment => assignment.Service, StringComparer.Ordinal)
            .ThenBy(assignment => assignment.PortKey, StringComparer.Ordinal)
            .ThenBy(assignment => assignment.Transport, StringComparer.Ordinal)
            .ThenBy(assignment => assignment.BindScope, StringComparer.Ordinal)
            .ToArray();
        return app with { PortAssignments = assignments };
    }

    private static (string, string, string, string) AssignmentIdentity(AppPortAssignment assignment)
        => (assignment.Service, assignment.PortKey, assignment.Transport, assignment.BindScope);

    // A legacy endpoint whose URL already reflects an operator HOSTY_PORT_* override is classified as an
    // operator assignment. Matching by value (rather than reconstructing the exact normalized key) keeps
    // this robust to whichever port key produced the override. Manifest-explicit ports are indistinguishable
    // from automatic at the record level — the URL carries the resolved port either way — so they read as
    // automatic until allocation moves to install and records the precise source (phase 2).
    private static string ResolveSource(IReadOnlyDictionary<string, AppSettingValue> settings, int hostPort)
    {
        foreach (var (key, value) in settings)
        {
            if (!key.StartsWith("HOSTY_PORT_", StringComparison.Ordinal) ||
                string.IsNullOrWhiteSpace(value.Value))
            {
                continue;
            }

            if (int.TryParse(value.Value.Trim(), NumberStyles.None, CultureInfo.InvariantCulture, out var pinned) &&
                pinned == hostPort)
            {
                return AppPortSources.Operator;
            }
        }

        return AppPortSources.Automatic;
    }

    private static bool TryReadEndpointPort(string? url, out int port)
    {
        port = 0;
        if (string.IsNullOrWhiteSpace(url) ||
            !Uri.TryCreate(url, UriKind.Absolute, out var uri) ||
            uri.Port is <= 0 or > IPEndPoint.MaxPort)
        {
            return false;
        }

        port = uri.Port;
        return true;
    }
}

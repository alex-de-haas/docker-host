namespace Haas.Hosty.Core;

// Cloudflare ingress: the ownership authority for Hosty-published hostnames. Each
// publication records exactly which app endpoint owns which hostname, the DNS record id, and the last applied
// local service URL, so reconciliation mutates and cleans up only what Hosty created (or explicitly adopted)
// and never touches operator/third-party routes. Owner-only at rest under the core data root. Keyed by
// (app id, endpoint key). See docs/features/cloudflare-ingress/feature.md.
internal sealed class CloudflarePublicationStore(CoreDataPaths paths)
{
    private readonly SemaphoreSlim gate = new(1, 1);

    private string StorePath => Path.Combine(paths.CoreRoot, "cloudflare-publications.json");

    public async Task<IReadOnlyList<CloudflarePublication>> ListAsync(CancellationToken cancellationToken = default)
    {
        await gate.WaitAsync(cancellationToken);
        try
        {
            return await ReadAsync(cancellationToken);
        }
        finally
        {
            gate.Release();
        }
    }

    public async Task<CloudflarePublication?> GetAsync(string appId, string endpointKey, CancellationToken cancellationToken = default)
        => (await ListAsync(cancellationToken)).FirstOrDefault(publication => Matches(publication, appId, endpointKey));

    public async Task<IReadOnlyList<CloudflarePublication>> ListForAppAsync(string appId, CancellationToken cancellationToken = default)
        => (await ListAsync(cancellationToken))
            .Where(publication => string.Equals(publication.AppId, appId, StringComparison.Ordinal))
            .ToArray();

    public async Task UpsertAsync(CloudflarePublication publication, CancellationToken cancellationToken = default)
    {
        await gate.WaitAsync(cancellationToken);
        try
        {
            var publications = (await ReadAsync(cancellationToken))
                .Where(existing => !Matches(existing, publication.AppId, publication.EndpointKey))
                .Append(publication)
                .OrderBy(entry => entry.AppId, StringComparer.Ordinal)
                .ThenBy(entry => entry.EndpointKey, StringComparer.Ordinal)
                .ToArray();
            await WriteAsync(publications, cancellationToken);
        }
        finally
        {
            gate.Release();
        }
    }

    // Applies a mutation to one stored publication, if it is still there. Used for the bookkeeping the
    // reconciler has no business knowing about (whether the owning app happens to be running).
    public async Task UpdateAsync(string appId, string endpointKey, Func<CloudflarePublication, CloudflarePublication> mutate, CancellationToken cancellationToken = default)
    {
        await gate.WaitAsync(cancellationToken);
        try
        {
            var publications = await ReadAsync(cancellationToken);
            var existing = publications.FirstOrDefault(entry => Matches(entry, appId, endpointKey));
            if (existing is null)
            {
                return;
            }

            await WriteAsync(publications.Select(entry => Matches(entry, appId, endpointKey) ? mutate(entry) : entry).ToArray(), cancellationToken);
        }
        finally
        {
            gate.Release();
        }
    }

    // Same, for every publication of one app: the "this app just started" sweep.
    public async Task UpdateForAppAsync(string appId, Func<CloudflarePublication, CloudflarePublication> mutate, CancellationToken cancellationToken = default)
    {
        await gate.WaitAsync(cancellationToken);
        try
        {
            var publications = await ReadAsync(cancellationToken);
            if (!publications.Any(entry => string.Equals(entry.AppId, appId, StringComparison.Ordinal)))
            {
                return;
            }

            await WriteAsync(
                publications.Select(entry => string.Equals(entry.AppId, appId, StringComparison.Ordinal) ? mutate(entry) : entry).ToArray(),
                cancellationToken);
        }
        finally
        {
            gate.Release();
        }
    }

    public async Task RemoveAsync(string appId, string endpointKey, CancellationToken cancellationToken = default)
    {
        await gate.WaitAsync(cancellationToken);
        try
        {
            var publications = (await ReadAsync(cancellationToken))
                .Where(existing => !Matches(existing, appId, endpointKey))
                .ToArray();
            await WriteAsync(publications, cancellationToken);
        }
        finally
        {
            gate.Release();
        }
    }

    private async Task<IReadOnlyList<CloudflarePublication>> ReadAsync(CancellationToken cancellationToken)
        => (await JsonStorage.ReadAsync<CloudflarePublicationSet>(StorePath, cancellationToken))?.Publications ?? [];

    private Task WriteAsync(IReadOnlyList<CloudflarePublication> publications, CancellationToken cancellationToken)
        => JsonStorage.WriteAsync(StorePath, new CloudflarePublicationSet(publications), restrictToOwner: true, cancellationToken);

    private static bool Matches(CloudflarePublication publication, string appId, string endpointKey)
        => string.Equals(publication.AppId, appId, StringComparison.Ordinal) &&
            string.Equals(publication.EndpointKey, endpointKey, StringComparison.Ordinal);
}

// One Hosty-owned (or adopted) hostname publication. `DnsRecordId` is the exact Cloudflare record Hosty
// manages; `ServiceUrl` is the last local target written into the tunnel route; `OwnershipState` is "owned"
// (Hosty created it) or "adopted" (an operator-owned object Hosty was explicitly told to manage).
//
// `PendingRestart` records that the origin changed while the app was running, so the process is still
// serving the old value. Core cannot observe a running app's environment, and an app record carries no
// start time, so this is the only honest way to answer "is this live yet?": it is set when a publish or
// unpublish lands on a running app and cleared the next time that app starts.
// `DriftedServiceUrl` is the local target the endpoint has NOW when Core could not push it into the
// tunnel — no connection, an expired token, Cloudflare unreachable. The hostname is still routed to
// `ServiceUrl`, which no longer exists, so the publication is broken until a reconcile succeeds. Recording
// it is what lets boot reconciliation be honest without retrying on the startup path: the next successful
// reconcile clears it, and until then the state projection reports the drift. Null means no drift.
// `PreviousPublicOrigin` is Core's own publication only: the persisted public-origin setting as it was
// before Hosty took the value over, so unpublish can put it back. Null means there was none and unpublish
// clears the setting instead.
internal sealed record CloudflarePublication(
    string AppId,
    string EndpointKey,
    string Label,
    string Hostname,
    string? DnsRecordId,
    string? ServiceUrl,
    string OwnershipState,
    DateTimeOffset UpdatedAt,
    bool PendingRestart = false,
    string? DriftedServiceUrl = null,
    string? PreviousPublicOrigin = null);

// The reserved pair Core's own hostname is published under. Core is not an app and has no registry
// record, but the store and the reconciler key ownership on (app id, endpoint key) — so reserving one pair
// is what lets Core's hostname ride the exact same publish, read-back, rollback and cleanup path as an
// app's, with no synthetic app record to keep consistent with a registry it is not in. The cost is that
// every sweep which walks publications expecting an installed app has to skip it, which is why this lives
// here rather than inside the publication service: the skip is the store's contract, not one caller's.
internal static class CorePublication
{
    public const string AppId = "hosty.core";
    public const string EndpointKey = "core";

    public static bool IsCore(string appId) => string.Equals(appId, AppId, StringComparison.Ordinal);
}

internal static class CloudflareOwnershipStates
{
    public const string Owned = "owned";
    public const string Adopted = "adopted";
}

internal sealed record CloudflarePublicationSet(IReadOnlyList<CloudflarePublication> Publications);

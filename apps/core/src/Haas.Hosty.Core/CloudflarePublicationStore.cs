namespace Haas.Hosty.Core;

// One-click Cloudflare public ingress, phase 2: the ownership authority for Hosty-published hostnames. Each
// publication records exactly which app endpoint owns which hostname, the DNS record id, and the last applied
// local service URL, so reconciliation mutates and cleans up only what Hosty created (or explicitly adopted)
// and never touches operator/third-party routes. Owner-only at rest under the core data root. Keyed by
// (app id, endpoint key). See docs/planning/one-click-cloudflare-public-ingress.md.
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
internal sealed record CloudflarePublication(
    string AppId,
    string EndpointKey,
    string Label,
    string Hostname,
    string? DnsRecordId,
    string? ServiceUrl,
    string OwnershipState,
    DateTimeOffset UpdatedAt);

internal static class CloudflareOwnershipStates
{
    public const string Owned = "owned";
    public const string Adopted = "adopted";
}

internal sealed record CloudflarePublicationSet(IReadOnlyList<CloudflarePublication> Publications);

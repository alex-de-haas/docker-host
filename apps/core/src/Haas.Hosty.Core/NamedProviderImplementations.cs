using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Serialization;

namespace Haas.Hosty.Core;

[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
internal sealed record ProviderImplementation(string Id, string DisplayName, [property: JsonRequired] bool Available);
[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
internal sealed record ProviderImplementationPublication(string Key, long Revision, IReadOnlyList<ProviderImplementation> Implementations);
internal sealed record ProviderImplementationReceipt(long Revision);
internal sealed record NamedProviderMember(ProviderImplementation Implementation, long Incarnation);
internal sealed record NamedProviderSnapshot(string Kind, string Key, string Declaration, long Revision, NamedProviderMember[] Members);
internal sealed record NamedProviderCatalog(string InstallationId, NamedProviderSnapshot[] Snapshots);

internal static class NamedProviderImplementations
{
    internal const string Capability = "implementations.named";
    internal const string FileName = "provider-implementations.json";
    internal static bool Participates(AppRecord app)
        => app.Interfaces?.Values.Any(entries => entries.Any(e => e.Capabilities?.Contains(Capability) == true)) == true;

    internal static string Declaration(AppInterfaceContract entry)
        => Digest([entry.EndpointKey ?? "", entry.Path, entry.Version?.ToString(System.Globalization.CultureInfo.InvariantCulture) ?? "",
            .. (entry.Capabilities ?? []).Order(StringComparer.Ordinal)]);

    internal static string RuntimeScope(AppRecord provider)
        => Digest(provider.Interfaces?.SelectMany(kind => kind.Value.Where(e => e.Capabilities?.Contains(Capability) == true)
            .Select(e => CoreJson.Text(new[] { kind.Key, e.Key, Declaration(e) }))).Order(StringComparer.Ordinal).ToArray() ?? []);

    private static string Digest(string[] parts) => Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(CoreJson.Text(parts))));

    internal static bool Readable(NamedProviderCatalog catalog)
    {
        if (string.IsNullOrEmpty(catalog.InstallationId) || catalog.Snapshots is null) return false;
        var keys = new HashSet<(string, string)>();
        foreach (var snapshot in catalog.Snapshots)
        {
            if (snapshot is null || string.IsNullOrEmpty(snapshot.Kind) || string.IsNullOrEmpty(snapshot.Key)
                || snapshot.Declaration is not { Length: 64 } || !keys.Add((snapshot.Kind, snapshot.Key))
                || !ValidRevision(snapshot.Revision) || snapshot.Members is not { Length: <= 256 }) return false;
            var ids = new HashSet<string>(StringComparer.Ordinal);
            foreach (var member in snapshot.Members)
                if (member is null || !Valid(member.Implementation) || !ids.Add(member.Implementation.Id)
                    || member.Incarnation <= 0 || member.Incarnation > snapshot.Revision) return false;
        }
        return true;
    }

    private static bool ValidRevision(long revision) => revision is > 0 and <= 9_007_199_254_740_991;
    private static bool Valid(ProviderImplementation? member) => member is not null && ValidId(member.Id)
        && member.DisplayName is { Length: > 0 and <= 160 } && !string.IsNullOrWhiteSpace(member.DisplayName)
        && member.DisplayName == member.DisplayName.Trim() && !member.DisplayName.Any(char.IsControl);

    internal static bool ValidId(string? id)
        => id is { Length: > 0 and <= 128 } && !string.IsNullOrWhiteSpace(id)
            && id == id.Trim() && !id.Any(char.IsControl);

    internal static ProviderImplementation[] Validate(ProviderImplementationPublication publication)
    {
        if (string.IsNullOrWhiteSpace(publication.Key) || !ValidRevision(publication.Revision)
            || publication.Implementations is not { Count: <= 256 } members)
            throw Invalid();
        var ids = new HashSet<string>(StringComparer.Ordinal);
        foreach (var member in members)
            if (!Valid(member) || !ids.Add(member.Id))
                throw Invalid();
        return members.OrderBy(m => m.Id, StringComparer.Ordinal).ToArray();
    }

    private static AppIdentityException Invalid() => new("provider_publication_invalid", "Publish a positive safe-integer revision and up to 256 uniquely identified, named implementations.");
}

internal sealed partial class AppRegistryStore
{
    // The same app lock fences install/removal, permission changes, and all catalog replacements.
    // State is stored outside app data and contains metadata only. Reinstallation starts a fresh ordering domain.
    internal async Task<ProviderImplementationReceipt> PublishImplementationsAsync(AppRecord authenticated, string kind,
        ProviderImplementationPublication publication, CancellationToken ct)
    {
        _ = ProviderAccessService.Permission(kind);
        var members = NamedProviderImplementations.Validate(publication);
        var mutex = GetAppLock(authenticated.Id);
        await mutex.WaitAsync(ct);
        try
        {
            var current = await GetAppAsync(authenticated.Id, ct);
            var entry = current?.Interfaces?.GetValueOrDefault(kind)?.SingleOrDefault(e => e.Key == publication.Key);
            if (current is null || current.InstalledAt != authenticated.InstalledAt || current.ConfirmedRoles?.Contains(kind) != true
                || entry?.Capabilities?.Contains(NamedProviderImplementations.Capability) != true
                || (entry.EndpointKey is null ? current.Endpoints.Count == 0 : AppSummary.ResolveDeclaredEndpoint(current.Endpoints, entry.EndpointKey) is null)
                || NamedProviderImplementations.RuntimeScope(current) != NamedProviderImplementations.RuntimeScope(authenticated))
                throw new AppIdentityException("provider_publication_denied", "A confirmed interface with named implementation publication is required.");
            if (current.NamedCatalogUnreadable)
                throw new AppIdentityException("provider_catalog_unavailable", "The stored implementation catalog cannot be read.");
            var snapshots = current.NamedProviders?.Snapshots ?? [];
            var previous = snapshots.SingleOrDefault(s => s.Kind == kind && s.Key == publication.Key);
            var declaration = NamedProviderImplementations.Declaration(entry);
            if (previous is not null && publication.Revision <= previous.Revision)
            {
                if (previous.Revision != publication.Revision || !members.SequenceEqual(previous.Members.Select(m => m.Implementation)))
                    throw new AppIdentityException("provider_publication_conflict", "The revision is stale or was already used for different implementations.");
                if (previous.Declaration == declaration) return new(previous.Revision);
            }
            var preceding = previous?.Declaration == declaration ? previous.Members.ToDictionary(m => m.Implementation.Id, StringComparer.Ordinal) : null;
            var next = new NamedProviderSnapshot(kind, publication.Key, declaration, publication.Revision, members.Select(m =>
                new NamedProviderMember(m, preceding?.GetValueOrDefault(m.Id)?.Incarnation ?? publication.Revision)).ToArray());
            var catalog = new NamedProviderCatalog(PanelIdentity.Installation(current),
                [.. snapshots.Where(s => s != previous), next]);
            var path = Path.Combine(CoreDataPaths.ResolveContainedPath(paths.AppsRoot, current.Id), NamedProviderImplementations.FileName);
            await JsonStorage.WriteOwnerFileAsync(path, catalog, ct);
            catalogEpochs.AddOrUpdate(current.Id, 1, static (_, epoch) => epoch + 1);
            recordCache.TryRemove(current.Id, out _);
            return new(next.Revision);
        }
        finally { mutex.Release(); }
    }
}

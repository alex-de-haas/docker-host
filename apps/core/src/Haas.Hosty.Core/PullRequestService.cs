using System.Text.Json;

namespace Haas.Hosty.Core;

internal sealed record PullRequestCacheRepository(string Key, string Id, string ConnectionId, string Authority,
    string Name, string Url, PullRequestSummary[] Items, Dictionary<int, string> Validators,
    Dictionary<int, bool> MorePages, DateTimeOffset? LastScan, string Completeness);
internal sealed record PullRequestCacheOwner(string UserId, PullRequestActor[] Actors, PullRequestCacheRepository[] Repositories);

internal sealed partial class PullRequestService(CoreDataPaths paths, InstalledPullRequestRepositories inventory,
    UserConnectionService connections, IClock clock, ILogger<PullRequestService> logger, PublicationService publications, WorkspaceInspectionService inspection)
{
    private readonly object sync = new();
    private readonly Dictionary<string, Owner> owners = new(StringComparer.Ordinal);
    private readonly SemaphoreSlim persistence = new(1);
    private string CacheRoot => Path.Combine(paths.CoreRoot, "pull-requests");
    private sealed class Owner(string userId)
    {
        public string UserId { get; } = userId;
        public readonly Dictionary<string, PullRequestActor> Actors = new(StringComparer.Ordinal);
        public readonly Dictionary<string, Repository> Repositories = new(StringComparer.Ordinal);
        public PullRequestCoverage[] Coverage = [];
        public DateTimeOffset LastReconciled;
        public string Revision = Guid.NewGuid().ToString("N");
    }
    private sealed class Repository(InstalledPullRequestRepositories.Binding binding)
    {
        public InstalledPullRequestRepositories.Binding Binding = binding;
        public string Id = DevelopmentWorkspaceService.Hash(binding.Key);
        public string Revision = Guid.NewGuid().ToString("N");
        public string Name = binding.Repository;
        public string Url = "https://github.com/" + binding.Repository;
        public DateTimeOffset? AccessAt, LastScan, AttemptAt, RetryAt;
        public string Completeness = "unknown";
        public string? Error;
        public bool Busy, Denied, CapacityLimited, ScanTruncated, SummaryLimited;
        public int Page = 1;
        public readonly Dictionary<int, string> Validators = [];
        public readonly Dictionary<int, bool> MorePages = [];
        public readonly Dictionary<int, PullRequestSummary> Items = [];
        public readonly Dictionary<int, DateTimeOffset> HeadSeen = [], StatusAt = [], StatusRetryAt = [];
        public readonly HashSet<int> ScanSeen = [];
        public readonly HashSet<int> Missing = [];
        public DateTimeOffset? ManualAt;
        public readonly HashSet<int> Requested = [];
        public bool ScanRequested;
    }
    private static Repository[] CanonicalRepositories(Owner owner) => owner.Repositories.Values.GroupBy(r => r.Id)
        .Where(g => g.Select(r => r.Binding.ConnectionId).Distinct(StringComparer.Ordinal).Count() == 1)
        .Select(g => g.OrderBy(r => r.Binding.Key, StringComparer.Ordinal).First()).ToArray();
    private static PullRequestApp[] RepositoryApps(Owner owner, Repository repository) => owner.Repositories.Values
        .Where(r => r.Id == repository.Id).SelectMany(r => r.Binding.Apps).DistinctBy(a => a.Id).ToArray();
    private static PullRequestReceipt NewReceipt() => new(Guid.NewGuid().ToString("N"));
    private void Changed(Owner owner, Repository? repository = null)
    {
        owner.Revision = Guid.NewGuid().ToString("N");
        if (repository is not null) repository.Revision = owner.Revision;
    }
    private bool HasProof(Repository repo) => !repo.Denied && repo.AccessAt is { } at && clock.UtcNow - at < PullRequestPolicy.Baseline;
    private PullRequestReceipt Receipt(Owner owner, Repository repo) => new(owner.Revision, repo.AttemptAt, repo.LastScan,
        repo.RetryAt, repo.Denied ? "unavailable" : repo.RetryAt > clock.UtcNow ? "delayed" : repo.Busy ? "refreshing" :
        repo.LastScan is null ? "refreshing" : clock.UtcNow - repo.LastScan > PullRequestPolicy.Baseline ? "stale" : "fresh",
        repo.Completeness, repo.Error);

    private async Task<Owner> ReconcileAsync(PullRequestActor actor, CancellationToken ct)
    {
        var current = await inventory.DiscoverAsync(actor, ct);
        Owner owner; bool changed;
        lock (sync)
        {
            if (!owners.TryGetValue(actor.UserId, out owner!)) owners[actor.UserId] = owner = new(actor.UserId);
            owner.Actors[actor.Key] = actor;
            var keys = current.Bindings.Select(b => b.Key).ToHashSet(StringComparer.Ordinal);
            changed = false;
            foreach (var key in owner.Repositories.Keys.Where(k => !keys.Contains(k)).ToArray())
            { var removed = owner.Repositories[key]; EvictDetails(owner.UserId, removed.Id); owner.Repositories.Remove(key); changed = true; }
            foreach (var binding in current.Bindings)
            {
                if (!owner.Repositories.TryGetValue(binding.Key, out var repo) || repo.Binding.Authority != binding.Authority)
                { if (repo is not null) EvictDetails(owner.UserId, repo.Id); owner.Repositories[binding.Key] = new(binding); changed = true; }
                else repo.Binding = binding;
            }
            changed |= CoreJson.Text(owner.Coverage) != CoreJson.Text(current.Coverage);
            owner.Coverage = current.Coverage;
            owner.LastReconciled = clock.UtcNow;
            if (changed) Changed(owner);
        }
        if (changed) await PersistAsync(owner, ct);
        return owner;
    }
    public async Task<PullRequestRepositories> RepositoriesAsync(PullRequestActor actor, CancellationToken ct)
    {
        var owner = await ReconcileAsync(actor, ct);
        lock (sync)
        {
            var repos = CanonicalRepositories(owner).Where(HasProof).Select(r =>
                new PullRequestRepository(r.Id, "github", r.Name, r.Url, RepositoryApps(owner, r), Receipt(owner, r))).ToArray();
            var notices = owner.Repositories.Values.Where(r => !HasProof(r)).Select(r => new PullRequestCoverage(r.Binding.Apps,
                r.CapacityLimited ? "capacity_limited" : r.Denied ? "access_denied" : r.Error is not null ? "unavailable" : "checking_access",
                r.CapacityLimited ? "The limit of 100 accessible repositories has been reached." : r.Denied ? "The selected connection cannot read this repository." : r.Error ?? "Repository access is being checked.")).ToArray();
            var conflicts = owner.Repositories.Values.GroupBy(r => r.Id).Where(g => g.Select(r => r.Binding.ConnectionId).Distinct().Count() > 1)
                .Select(g => new PullRequestCoverage(g.SelectMany(r => r.Binding.Apps).DistinctBy(a => a.Id).ToArray(),
                    "connection_selection_required", "These repository aliases have different reviewed connections. Select one connection for their installed apps.")).ToArray();
            return new(repos, [.. owner.Coverage, .. notices, .. conflicts], new(owner.Revision, Freshness: notices.Length == 0 ? "fresh" : "refreshing",
                Completeness: notices.Length == 0 && conflicts.Length == 0 && owner.Coverage.Length == 0 ? "complete" : "partial"),
                DevelopmentWorkspaceService.Hash(paths.DataRoot + "\n" + actor.Key));
        }
    }

    private sealed record PageSnapshot(string Actor, PullRequestQuery Query, PullRequestSummary[] Items,
        DateTimeOffset Expires, PullRequestReceipt Receipt, Dictionary<string, string> Authorities);
    private readonly Dictionary<string, (PageSnapshot Snapshot, int Offset)> cursors = new(StringComparer.Ordinal);
    public async Task<PullRequestPage> ListAsync(PullRequestActor actor, PullRequestQuery query, CancellationToken ct)
    {
        if (query.Limit is < 1 or > 100 || query.Search?.Length > 256 || query.Author?.Length > 256)
            throw new PullRequestException("pr_query_invalid", "Use a bounded PR filter and page size.", 400);
        var owner = await ReconcileAsync(actor, ct);
        lock (sync)
        {
            foreach (var old in cursors.Where(p => p.Value.Snapshot.Expires <= clock.UtcNow).Select(p => p.Key).ToArray()) cursors.Remove(old);
            if (query.Cursor is { Length: > 0 } cursor)
            {
                if (!cursors.TryGetValue(cursor, out var saved) || saved.Snapshot.Actor != actor.Key || saved.Snapshot.Query != (query with { Cursor = null }))
                    throw new PullRequestException("pr_cursor_expired", "Reload the first page of pull requests.", 409);
                var allowed = CanonicalRepositories(owner).Where(HasProof).ToDictionary(r => r.Id, r => r.Binding.Authority, StringComparer.Ordinal);
                if (saved.Snapshot.Authorities.Any(p => !allowed.TryGetValue(p.Key, out var authority) || authority != p.Value))
                    throw new PullRequestException("pr_cursor_expired", "Repository access changed. Reload the first page.", 409);
                return Page(saved.Snapshot, saved.Offset);
            }
            var repos = CanonicalRepositories(owner).Where(HasProof)
                .Where(r => query.Repository is null || r.Id == query.Repository)
                .Where(r => query.App is null || RepositoryApps(owner, r).Any(a => a.Id == query.App)).ToArray();
            var items = repos.SelectMany(r => r.Items.Values.Select(p => Display(owner, r, p)))
                .Where(p => p.State == "open" && (query.Author is null || p.Author.Equals(query.Author, StringComparison.OrdinalIgnoreCase)) &&
                    (query.Bot is null || p.Bot == query.Bot) && (query.Draft is null || p.Draft == query.Draft) &&
                    (query.Ci is null || PullRequestPolicy.Ci(p) == query.Ci) && (query.Review is null || p.ReviewDecision == query.Review) &&
                    (string.IsNullOrWhiteSpace(query.Search) || p.Title.Contains(query.Search, StringComparison.OrdinalIgnoreCase) || p.Number.ToString().Contains(query.Search.TrimStart('#'), StringComparison.Ordinal)))
                .OrderByDescending(p => p.UpdatedAt).ThenBy(p => p.RepositoryId, StringComparer.Ordinal).ThenBy(p => p.Number).ToArray();
            var relevant = CanonicalRepositories(owner).Where(r => query.Repository is null || r.Id == query.Repository)
                .Where(r => query.App is null || RepositoryApps(owner, r).Any(a => a.Id == query.App)).ToArray();
            var complete = CanonicalRepositories(owner).Length == owner.Repositories.Values.Select(r => r.Id).Distinct().Count() &&
                (query.Repository is not null || owner.Coverage.Length == 0) && relevant.Length == repos.Length && repos.All(r => r.Completeness == "complete");
            return Page(new(actor.Key, query with { Cursor = null }, items, clock.UtcNow.AddMinutes(2),
                new(owner.Revision, ObservedAt: repos.Select(r => r.AttemptAt).Max(), LastSuccessAt: repos.Select(r => r.LastScan).Min(), Freshness: repos.Any(r => r.Busy) ? "refreshing" : "fresh", Completeness: complete ? "complete" : "partial"), repos.ToDictionary(r => r.Id, r => r.Binding.Authority, StringComparer.Ordinal)), 0);
        }
    }
    private PullRequestPage Page(PageSnapshot snapshot, int offset)
    {
        var items = snapshot.Items.Skip(offset).Take(snapshot.Query.Limit).ToArray();
        string? next = null;
        if (offset + items.Length < snapshot.Items.Length)
        {
            // Bounded ephemeral pagination; expiring a cursor never exposes a different generation.
            while (cursors.Count >= 2048) cursors.Remove(cursors.Keys.First());
            next = Guid.NewGuid().ToString("N"); cursors[next] = (snapshot, offset + items.Length);
        }
        return new(items, next, snapshot.Items.Length, snapshot.Receipt.Completeness == "complete" ? snapshot.Items.Length : null, snapshot.Receipt);
    }
    private PullRequestSummary Display(Owner owner, Repository repo, PullRequestSummary pr)
    {
        var last = repo.StatusAt.GetValueOrDefault(pr.Number);
        var incomplete = repo.StatusRetryAt.TryGetValue(pr.Number, out var retry);
        var receipt = pr.Receipt with { Revision = owner.Revision,
            NextAttemptAt = incomplete && !(repo.RetryAt > retry) ? retry : repo.RetryAt,
            Freshness = repo.RetryAt > clock.UtcNow ? "delayed" : incomplete || clock.UtcNow - last > PullRequestPolicy.Baseline ? "stale" : "fresh", Reason = repo.Error ?? pr.Receipt.Reason };
        return pr with { Receipt = receipt };
    }
    private async Task<(Owner Owner, Repository Repository)> RequireRepositoryAsync(PullRequestActor actor, string id, CancellationToken ct)
    {
        var owner = await ReconcileAsync(actor, ct);
        lock (sync)
        {
            var repo = CanonicalRepositories(owner).FirstOrDefault(r => r.Id == id);
            if (repo is null || repo.Denied) throw new PullRequestException("pr_not_found", "This installed repository is not accessible.", 404);
            if (!HasProof(repo)) throw new PullRequestException("pr_access_pending", "Repository access must be revalidated before cached data can be shown.", 409);
            return (owner, repo);
        }
    }
    private async Task<T> ReadAsync<T>(PullRequestActor actor, Repository repo,
        Func<UserProviderConnection, IPullRequestProvider, Task<T>> read, CancellationToken ct, bool detailCapability = false)
    {
        await inventory.RequireActorAsync(actor, ct);
        var current = await inventory.DiscoverAsync(actor, ct);
        var binding = current.Bindings.FirstOrDefault(b => b.Key == repo.Binding.Key && b.Authority == repo.Binding.Authority)
            ?? throw new PullRequestException("pr_access_denied", "The installed repository binding changed.", 403);
        T value;
        try { value = await connections.UseForSourceAsync(actor.UserId, binding.ConnectionId, c => read(c, binding.Provider), ct); }
        catch (PullRequestException ex) when (ex.Code == "pr_access_denied" && !detailCapability)
        {
            Owner? owner;
            lock (sync)
            {
                repo.Denied = true; repo.AccessAt = null; repo.Items.Clear(); repo.Validators.Clear();
                EvictDetails(actor.UserId, repo.Id);
                owner = owners.GetValueOrDefault(actor.UserId); if (owner is not null) Changed(owner, repo);
            }
            if (owner is not null) await PersistAsync(owner, ct);
            throw;
        }
        var after = await inventory.DiscoverAsync(actor, ct);
        if (!after.Bindings.Any(b => b.Key == binding.Key && b.Authority == binding.Authority))
            throw new PullRequestException("pr_access_denied", "Repository access changed during the provider read.", 403);
        if (!detailCapability) lock (sync) repo.AccessAt = clock.UtcNow;
        return value;
    }
    private async Task PersistAsync(Owner owner, CancellationToken ct)
    {
        await persistence.WaitAsync(ct);
        try
        {
            PullRequestCacheOwner value;
            lock (sync)
            {
                PullRequestCacheOwner Snapshot() => new(owner.UserId, owner.Actors.Values.ToArray(), owner.Repositories.Values.Where(r => !r.Denied).Select(r =>
                    new PullRequestCacheRepository(r.Binding.Key, r.Id, r.Binding.ConnectionId, r.Binding.Authority, r.Name, r.Url,
                        r.Items.Values.ToArray(), new(r.Validators), new(r.MorePages), r.LastScan, r.Completeness)).ToArray());
                value = Snapshot();
                while (JsonSerializer.SerializeToUtf8Bytes(value, CoreJson.TypeInfo<PullRequestCacheOwner>()).Length > 32 * 1024 * 1024)
                {
                    var rows = owner.Repositories.Values.SelectMany(r => r.Items.Values.Select(p => (Repo: r, Pr: p))).ToArray();
                    if (rows.Length == 0) throw new PullRequestException("pr_cache_limit", "Repository metadata exceeds the owner cache limit.");
                    foreach (var row in rows.OrderBy(p => p.Pr.State == "open").ThenBy(p => p.Pr.UpdatedAt).Take(Math.Max(1, rows.Length / 8)))
                    {
                        row.Repo.Items.Remove(row.Pr.Number); row.Repo.StatusAt.Remove(row.Pr.Number); row.Repo.StatusRetryAt.Remove(row.Pr.Number); row.Repo.HeadSeen.Remove(row.Pr.Number);
                        row.Repo.SummaryLimited = true; row.Repo.Completeness = "partial";
                        row.Repo.Error = "The summary cache is at capacity; older rows are omitted.";
                        Changed(owner, row.Repo);
                    }
                    Changed(owner); value = Snapshot();
                }
            }
            await JsonStorage.WriteAsync(Path.Combine(CacheRoot, DevelopmentWorkspaceService.Hash(owner.UserId) + ".json"), value, restrictToOwner: true, ct);
        }
        finally { persistence.Release(); }
    }
    internal async Task RestoreAsync(CancellationToken ct)
    {
        if (!Directory.Exists(CacheRoot)) return;
        foreach (var file in Directory.EnumerateFiles(CacheRoot, "*.json"))
        {
            try
            {
                if (new FileInfo(file).Length > 32 * 1024 * 1024) continue;
                var saved = await JsonStorage.ReadAsync<PullRequestCacheOwner>(file, ct);
                if (saved is null) continue;
                foreach (var actor in saved.Actors.Where(a => a.UserId == saved.UserId))
                {
                    var owner = await ReconcileAsync(actor, ct);
                    lock (sync) foreach (var stored in saved.Repositories)
                    {
                        if (!owner.Repositories.TryGetValue(stored.Key, out var r) || r.Binding.Authority != stored.Authority || r.Binding.ConnectionId != stored.ConnectionId) continue;
                        r.Id = stored.Id; r.Name = stored.Name; r.Url = stored.Url; r.LastScan = stored.LastScan; r.Completeness = stored.Completeness;
                        foreach (var item in stored.Items.Take(PullRequestPolicy.RepositoryPullRequestLimit)) r.Items[item.Number] = item;
                        foreach (var (page, etag) in stored.Validators) r.Validators[page] = etag;
                        foreach (var (page, more) in stored.MorePages) r.MorePages[page] = more;
                        // No persisted proof is authority. Reads remain hidden until a fresh provider read.
                    }
                    break;
                }
            }
            catch (Exception ex) when (ex is IOException or JsonException or PullRequestException or UserConnectionException)
            { logger.LogWarning("A PR cache registration could not be restored ({Kind}).", ex.GetType().Name); }
        }
    }
}

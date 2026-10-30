namespace Haas.Hosty.Core;

internal sealed partial class PullRequestService
{
    private int schedulingSlot;
    private static readonly int[] SchedulingWeights = [0, 0, 0, 1, 2];
    private sealed record Job(Owner Owner, Repository Repository, PullRequestActor Actor, string Kind,
        int[] Numbers, int Priority, DateTimeOffset Due);

    internal async Task TickAsync(CancellationToken ct)
    {
        await ReconcileWorkspaceJobsAsync(ct);
        Owner[] current;
        lock (sync) current = owners.Values.ToArray();
        foreach (var owner in current)
        {
            if (clock.UtcNow - owner.LastReconciled < TimeSpan.FromSeconds(30)) continue;
            PullRequestActor[] actors;
            lock (sync) actors = owner.Actors.Values.ToArray();
            foreach (var actor in actors)
            {
                try { await ReconcileAsync(actor, ct); }
                catch (PullRequestException)
                {
                    lock (sync) { owner.Actors.Remove(actor.Key); if (owner.Actors.Count == 0) { owner.Repositories.Clear(); Changed(owner); } }
                }
            }
        }
        Job? job;
        WorkspacePrObservationJob? workspaceJob = null;
        lock (sync)
        {
            var jobs = new List<Job>();
            foreach (var owner in owners.Values.Where(o => o.Actors.Count > 0))
            foreach (var repo in owner.Repositories.Values)
            {
                if (repo.Busy || repo.RetryAt > clock.UtcNow) continue;
                var actor = owner.Actors.Values.First();
                var discoveryDemand = RepositoryDemand(owner.UserId, repo.Id);
                var discoveryDue = repo.ScanRequested || repo.LastScan is null ? DateTimeOffset.MinValue :
                    repo.LastScan.Value + PullRequestPolicy.Jitter(PullRequestPolicy.Interval(discoveryDemand, true, false), repo.Id);
                if (repo.Denied)
                {
                    if (repo.AttemptAt is { } failed && clock.UtcNow - failed < TimeSpan.FromMinutes(15)) continue;
                    jobs.Add(new(owner, repo, actor, "access", [], 2, repo.AttemptAt ?? DateTimeOffset.MinValue)); continue;
                }
                if (!HasProof(repo))
                {
                    repo.CapacityLimited = repo.AccessAt is null && owner.Repositories.Values.Count(r => r.AccessAt is not null && !r.Denied) >= PullRequestPolicy.RepositoryLimit;
                    if (repo.CapacityLimited) continue;
                    jobs.Add(new(owner, repo, actor, "access", [], 1, DateTimeOffset.MinValue)); continue; }
                if (discoveryDue <= clock.UtcNow && CanonicalRepositories(owner).Contains(repo)) jobs.Add(new(owner, repo, actor, "discovery", [], 1, discoveryDue));
                if (!CanonicalRepositories(owner).Contains(repo)) continue;
                var due = repo.Items.Values.Where(p => p.State == "open" || repo.Requested.Contains(p.Number))
                    .Select(p =>
                    {
                        var demand = PullRequestDemand(owner.UserId, repo.Id, p.Number);
                        var active = PullRequestPolicy.IsActive(p, repo.HeadSeen.GetValueOrDefault(p.Number, clock.UtcNow), clock.UtcNow);
                        var at = repo.Requested.Contains(p.Number) || repo.Missing.Contains(p.Number) ? DateTimeOffset.MinValue :
                            repo.StatusAt.TryGetValue(p.Number, out var last) ? last + PullRequestPolicy.Jitter(PullRequestPolicy.Interval(demand, false, active), repo.Id + ":" + p.Number) : DateTimeOffset.MinValue;
                        if (repo.StatusRetryAt.TryGetValue(p.Number, out var retry) && retry > at) at = retry;
                        return (p.Number, At: at, Priority: demand && active ? 0 : 2);
                    }).Where(p => p.At <= clock.UtcNow).OrderBy(p => p.At).ToArray();
                foreach (var priority in new[] { 0, 2 })
                {
                    var batch = due.Where(p => p.Priority == priority).Take(10).ToArray();
                    if (batch.Length > 0) jobs.Add(new(owner, repo, actor, "status", batch.Select(p => p.Number).ToArray(), priority, batch[0].At));
                }
            }
            var preferred = SchedulingWeights[schedulingSlot++ % SchedulingWeights.Length];
            job = jobs.Where(j => j.Priority == preferred).OrderBy(j => j.Due).FirstOrDefault() ?? jobs.OrderBy(j => j.Due).FirstOrDefault();
            var workspace = NextWorkspaceJob();
            if (workspace is { } candidate && (job is null || candidate.Priority == preferred && job.Priority != preferred ||
                candidate.Priority == job.Priority && candidate.Due < job.Due)) { workspaceJob = candidate.Job; job = null; }
            if (job is not null) { job.Repository.Busy = true; job.Repository.AttemptAt = clock.UtcNow; }
        }
        if (workspaceJob is not null) { await RunWorkspaceJobAsync(workspaceJob, ct); return; }
        if (job is null) return;
        var r = job.Repository;
        try
        {
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
            timeout.CancelAfter(TimeSpan.FromSeconds(45));
            if (job.Kind == "access")
            {
                var remote = await ReadAsync(job.Actor, r, (c, p) => p.RepositoryAsync(c, r.Binding.Repository, timeout.Token), timeout.Token);
                lock (sync)
                {
                    var id = DevelopmentWorkspaceService.Hash("github:github.com:" + remote.ProviderId);
                    if (r.AccessAt is not null && r.Items.Count > 0 && r.Id != id)
                    { EvictDetails(job.Owner.UserId, r.Id); r.Items.Clear(); r.Validators.Clear(); r.StatusAt.Clear(); r.StatusRetryAt.Clear(); }
                    r.Id = id; r.Name = remote.Name; r.Url = remote.Url; r.Denied = false;
                    foreach (var number in r.Items.Keys.ToArray()) r.Items[number] = r.Items[number] with { RepositoryId = id };
                }
            }
            else if (job.Kind == "discovery")
            {
                var page = r.Page;
                var result = await ReadAsync(job.Actor, r, (c, p) => p.ListPullRequestsAsync(c, r.Name, r.Id, page,
                    r.Validators.GetValueOrDefault(page), timeout.Token), timeout.Token);
                lock (sync)
                {
                    if (result.ETag is { } etag) r.Validators[page] = etag;
                    if (!result.NotModified) r.MorePages[page] = result.HasNext;
                    if (result.NotModified) r.ScanSeen.UnionWith(r.Items.Keys);
                    foreach (var item in result.Items)
                    {
                        r.ScanSeen.Add(item.Number);
                        if (!r.Items.ContainsKey(item.Number) && (r.Items.Count >= PullRequestPolicy.RepositoryPullRequestLimit ||
                            job.Owner.Repositories.Values.Sum(repo => repo.Items.Count) >= PullRequestPolicy.OwnerPullRequestLimit))
                        { r.ScanTruncated = true; r.Completeness = "partial"; continue; }
                        if (r.Items.TryGetValue(item.Number, out var existing) && existing.Head == item.Head)
                            r.Items[item.Number] = item with { Checks = existing.Checks, ReviewDecision = existing.ReviewDecision, MergeState = existing.MergeState };
                        else { r.Items[item.Number] = item; r.HeadSeen[item.Number] = clock.UtcNow; r.StatusAt.Remove(item.Number); r.StatusRetryAt.Remove(item.Number); }
                    }
                    if (r.MorePages.GetValueOrDefault(page) && page < 10)
                    { r.Page++; r.ScanRequested = true; r.Completeness = "partial"; }
                    else
                    {
                        r.Completeness = r.SummaryLimited || r.ScanTruncated || r.MorePages.GetValueOrDefault(page) || r.Items.Count >= PullRequestPolicy.RepositoryPullRequestLimit ? "partial" : "complete";
                        r.ScanTruncated = false;
                        r.Missing.UnionWith(r.Items.Values.Where(p => p.State == "open" && !r.ScanSeen.Contains(p.Number)).Select(p => p.Number));
                        r.ScanSeen.Clear(); r.Page = 1; r.ScanRequested = false; r.LastScan = clock.UtcNow;
                    }
                }
            }
            else
            {
                var results = await ReadAsync(job.Actor, r, (c, p) => p.ReadPullRequestsAsync(c, r.Name, r.Id, job.Numbers, timeout.Token), timeout.Token);
                lock (sync)
                {
                    foreach (var item in results)
                    {
                        if (!r.Items.TryGetValue(item.Number, out var previous) || previous.Head != item.Head) r.HeadSeen[item.Number] = clock.UtcNow;
                        r.Items[item.Number] = item; r.StatusAt[item.Number] = clock.UtcNow; r.StatusRetryAt.Remove(item.Number);
                        r.Requested.Remove(item.Number); r.Missing.Remove(item.Number);
                    }
                    foreach (var absent in job.Numbers.Except(results.Select(p => p.Number)))
                    {
                        // An omitted alias is an attempted read, not a successful observation.
                        r.StatusRetryAt[absent] = clock.UtcNow + PullRequestPolicy.Jitter(TimeSpan.FromSeconds(30), r.Id + ":" + absent);
                        if (r.Items.TryGetValue(absent, out var item)) r.Items[absent] = item with
                        { Checks = new([], null, "unknown"), Receipt = item.Receipt with { Freshness = "stale", Reason = "Some provider fields are unavailable." } };
                    }
                }
            }
            lock (sync) { r.RetryAt = null; r.Error = null; Changed(job.Owner, r); }
        }
        catch (Exception ex) when (ex is PullRequestException or PublicationException or UserConnectionException or HttpRequestException or OperationCanceledException or System.Text.Json.JsonException)
        {
            if (ct.IsCancellationRequested) throw;
            lock (sync)
            {
                var denied = ex is PullRequestException { Code: "pr_access_denied" } || ex is UserConnectionException { Status: not 502 };
                r.Denied = denied;
                r.Error = ex is PullRequestException pr ? pr.Message : "Provider observation is temporarily unavailable.";
                r.RetryAt = ex is PullRequestException { RetryAt: { } retry } ? retry : clock.UtcNow.AddSeconds(denied ? 900 : 30);
                if (denied) { EvictDetails(job.Owner.UserId, r.Id); r.Items.Clear(); r.AccessAt = null; r.Validators.Clear(); }
                Changed(job.Owner, r);
            }
        }
        finally { lock (sync) r.Busy = false; }
        lock (sync)
        {
            foreach (var old in r.Items.Values.Where(p => p.State != "open" && clock.UtcNow - p.Receipt.LastSuccessAt > TimeSpan.FromHours(24)).Select(p => p.Number).ToArray())
            { r.Items.Remove(old); r.StatusAt.Remove(old); r.StatusRetryAt.Remove(old); r.HeadSeen.Remove(old); }
        }
        await PersistAsync(job.Owner, ct);
    }

    private readonly Dictionary<string, DateTimeOffset> refreshRequests = new(StringComparer.Ordinal);
    public async Task<PullRequestRefreshResult> RefreshAsync(PullRequestActor actor, PullRequestRefresh request, CancellationToken ct)
    {
        if (!Guid.TryParse(request.RequestId, out _) || request.Repositories?.Length > 100 || request.PullRequests?.Length > 100 || request.Repositories?.Any(id => id is null || id.Length > 128) == true ||
            request.PullRequests?.Any(p => p is null || p.RepositoryId is null || p.RepositoryId.Length > 128) == true)
            throw new PullRequestException("pr_request_invalid", "Supply a UUID and bounded resource references.", 400);
        var owner = await ReconcileAsync(actor, ct);
        lock (sync)
        {
            foreach (var key in refreshRequests.Where(p => p.Value <= clock.UtcNow).Select(p => p.Key).ToArray()) refreshRequests.Remove(key);
            var requestKey = actor.Key + ":" + request.RequestId;
            if (refreshRequests.ContainsKey(requestKey)) return new("coalesced", null);
            var ids = request.Repositories ?? [];
            var refs = request.PullRequests ?? [];
            var repos = owner.Repositories.Values.Where(r => ids.Contains(r.Id, StringComparer.Ordinal) || refs.Any(p => p.RepositoryId == r.Id)).ToArray();
            if (ids.Any(id => !repos.Any(r => r.Id == id)) || refs.Any(p => p.Number <= 0 || !repos.Any(r => r.Id == p.RepositoryId && r.Items.ContainsKey(p.Number))))
                throw new PullRequestException("pr_not_found", "Refresh references must identify currently authorized PR resources.", 404);
            DateTimeOffset? next = null;
            foreach (var r in repos)
            {
                var cooldown = r.ManualAt?.AddSeconds(10);
                if (cooldown > clock.UtcNow || r.RetryAt > clock.UtcNow)
                { var due = cooldown > r.RetryAt ? cooldown : r.RetryAt; if (next is null || due > next) next = due; continue; }
                r.ManualAt = clock.UtcNow;
                if (ids.Contains(r.Id, StringComparer.Ordinal)) r.ScanRequested = true;
                foreach (var reference in refs.Where(p => p.RepositoryId == r.Id)) r.Requested.Add(reference.Number);
            }
            if (refreshRequests.Count >= 4096) refreshRequests.Remove(refreshRequests.Keys.First());
            refreshRequests[requestKey] = clock.UtcNow.AddMinutes(5);
            return new(next is null ? "queued" : "deferred", next);
        }
    }
    internal bool Invalidate(string userId, ObservationInvalidation signal)
    {
        if (signal.Subject.SchemaVersion != 1 || signal.Subject.Id.Length > 256) return false;
        if (signal.Subject.Kind == "repository") return Invalidate(userId, signal.Subject.Id, null, signal.Reason);
        var parts = signal.Subject.Id.Split(':');
        return signal.Subject.Kind == "pull-request" && parts.Length == 2 && int.TryParse(parts[1], out var number) &&
            Invalidate(userId, parts[0], number, signal.Reason);
    }
    // A future producer can invalidate known authorized resources; payloads never replace provider facts.
    internal bool Invalidate(string userId, string repositoryId, int? number, string reason)
    {
        if (reason.Length is < 1 or > 128) return false;
        lock (sync)
        {
            if (!owners.TryGetValue(userId, out var owner)) return false;
            var repo = owner.Repositories.Values.FirstOrDefault(r => r.Id == repositoryId);
            if (repo is null || repo.Denied) return false;
            if (number is { } n) { if (!repo.Items.ContainsKey(n)) return false; repo.Requested.Add(n); }
            else repo.ScanRequested = true;
            return true;
        }
    }
}

internal sealed class PullRequestObserver(PullRequestService service, ILogger<PullRequestObserver> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        await service.RestoreAsync(stoppingToken);
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(1));
        do
        {
            try { await service.TickAsync(stoppingToken); }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { break; }
            catch (Exception ex) { logger.LogWarning("PR observation will retry after {Kind}.", ex.GetType().Name); }
        } while (await timer.WaitForNextTickAsync(stoppingToken));
    }
}

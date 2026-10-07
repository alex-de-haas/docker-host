using System.Text.Json;

namespace Haas.Hosty.Core;

internal sealed class PublicationService(CoreDataPaths paths, DevelopmentWorkspaceService workspaces,
    UserConnectionService connections, AppRegistryStore apps,
    UserDirectoryStore users, IClock clock, AuditStore audit)
{
    private readonly SemaphoreSlim gate = new(1, 1);
    private string Root => Path.Combine(paths.CoreRoot, "development", "publications");
    private string FilePath(string id)
    {
        if (id.Length != 64 || id.Any(c => !char.IsAsciiHexDigit(c))) throw new PublicationException("not_found", "Publication not found.");
        return Path.Combine(Root, id + ".json");
    }
    private Task Save(PublicationRecord r) => JsonStorage.WriteAsync(FilePath(r.WorkspaceId), r, restrictToOwner: true);
    private Task<PublicationRecord?> Read(string id, CancellationToken ct) => JsonStorage.ReadAsync<PublicationRecord>(FilePath(id), ct);
    private async Task<T> Locked<T>(Func<Task<T>> action, CancellationToken ct)
    {
        await gate.WaitAsync(ct);
        try { return await action(); } finally { gate.Release(); }
    }
    internal async Task RequireOwner(WorkspaceOwner owner, CancellationToken ct)
    {
        var app = await apps.GetAppAsync(owner.AppId, ct);
        var user = (await users.ReadAsync(ct)).Users.FirstOrDefault(u => u.Id == owner.UserId && !u.Disabled);
        if (app?.InstalledAt != owner.Installation || app.GrantedCorePermissions?.Contains(CoreAppPermissions.Sources) != true || user is null || !AppAccessPolicy.IsAdmin(user))
            throw new PublicationException("forbidden", "The assistant installation or administrator publication grant is no longer valid.");
    }
    public async Task<PublicationConnections> ConnectionsAsync(WorkspaceOwner owner, CancellationToken ct)
    {
        await RequireOwner(owner, ct);
        return new((await connections.ProfileAsync(owner.UserId, ct)).Connections.Where(c => connections.Providers.Contains(c.Provider) && connections.Providers.Resolve(c.Provider).Publication is not null).ToArray());
    }
    public Task<PublicationList> ListAsync(WorkspaceOwner? owner, CancellationToken ct) => Locked(async () =>
    {
        if (owner is not null) await RequireOwner(owner, ct);
        var list = new List<PublicationRecord>();
        if (Directory.Exists(Root)) foreach (var file in Directory.EnumerateFiles(Root, "*.json"))
        {
            try
            {
                var record = await Read(Path.GetFileNameWithoutExtension(file), ct);
                if (record is not null && (owner is null || record.Owner == owner)) list.Add(record);
            }
            catch (JsonException) { /* A damaged record does not hide other operations. */ }
        }
        return new PublicationList(list.ToArray());
    }, ct);
    public Task<PublicationRecord> ObserveAsync(string id, WorkspaceOwner? owner, CancellationToken ct) => Locked(async () =>
    {
        var r = await Read(id, ct) ?? throw new PublicationException("not_found", "Publication not found.");
        if (owner is not null && r.Owner != owner) throw new PublicationException("forbidden", "Publication belongs to another session.");
        return await Observe(r, ct);
    }, ct);
    private async Task<PublicationRecord> Observe(PublicationRecord r, CancellationToken ct)
    {
        try
        {
            await RequireOwner(r.Owner, ct);
            r = await connections.UseForSourceAsync(r.Owner.UserId, r.ConnectionId, async c =>
            {
                var provider = Publication(c.Provider);
                if (r.Provider != c.Provider) throw new PublicationException("provider_mismatch", "The publication belongs to a different provider.");
                if (r.Number is null)
                {
                    var found = await provider.FindAsync(c, r, ct);
                    if (found is null) return r with { Observation = new(clock.UtcNow, "unpublished") };
                    r = Link(r, found);
                }
                return r with { Observation = await provider.ObserveAsync(c, r, ct) };
            }, ct);
        }
        catch (Exception ex) when (ex is PublicationException or UserConnectionException or HttpRequestException or JsonException)
        {
            r = r with { Observation = new(clock.UtcNow, "unavailable", Error: "Provider state is unavailable. Check the connection and permissions, then refresh.") };
        }
        await Save(r); return r;
    }
    private IPublicationProvider Publication(string id) => connections.Providers.Resolve(id).Publication
        ?? throw new PublicationException("provider_unsupported", "This source provider does not support pull requests.");
    private PublicationRecord Link(PublicationRecord r, PublicationReference p)
    {
        var expected = Publication(r.Provider).PullRequestUrl(r.Repository, p.Number);
        if (p.Number <= 0 || !string.Equals(p.Url, expected, StringComparison.OrdinalIgnoreCase)) throw new PublicationException("pr_mismatch", "Provider returned an unexpected PR identity.");
        return r with { Number = p.Number, Url = expected };
    }
    internal static void ValidatePolicy(PublicationPolicy p)
    {
        if (p.RequiredChecks is null || p.RequiredWorkflows is null || p.Artifacts is null || p.RequiredChecks.Length > 30 || p.RequiredWorkflows.Length > 20 || p.Artifacts.Length > 20 ||
            p.RequiredChecks.Any(n => string.IsNullOrWhiteSpace(n) || n.Length > 200 || n.Any(char.IsControl)) || p.RequiredWorkflows.Any(n => n <= 0) ||
            p.Artifacts.Any(a => a is null))
            throw new PublicationException("policy_invalid", "Supply bounded explicit check names, workflow IDs and exact artifact selectors.");
        foreach (var artifact in p.Artifacts) PublicationArtifacts.Validate(artifact);
    }
    internal static void RequireMerge(PublicationObservation? o, string head)
    {
        if (o is null || o.State != "open" || o.Head != head || o.Draft || o.MergeState != "CLEAN" || o.UnresolvedThreads != 0 || o.ReviewDecision is "CHANGES_REQUESTED" or "REVIEW_REQUIRED" ||
            o.Checks is null || o.Checks.Any(c => c.State is not ("SUCCESS" or "NEUTRAL" or "SKIPPED")))
            throw new PublicationException("merge_blocked", "The current PR head is not ready: inspect CI, required reviews, unresolved threads, draft state and repository protection.");
    }
    private async Task Dependencies(PublicationRecord r, CancellationToken ct, bool requireComplete)
    {
        var visited = new HashSet<string>(); var active = new HashSet<string> { r.WorkspaceId };
        async Task Visit(string id)
        {
            if (active.Contains(id)) throw new PublicationException("dependency_cycle", "Publication dependencies contain a cycle.");
            if (!visited.Add(id)) return;
            var d = await Read(id, ct) ?? throw new PublicationException("dependency_missing", "A publication dependency is missing.");
            if (d.Owner != r.Owner) throw new PublicationException("dependency_forbidden", "Dependencies must belong to the same user, assistant and session.");
            active.Add(id); foreach (var next in d.Dependencies) await Visit(next); active.Remove(id);
            if (requireComplete)
            {
                d = await Observe(d, ct);
                if (d.Observation is not { State: "merged", Complete: true }) throw new PublicationException("dependency_pending", "A dependency has not merged and satisfied its configured release evidence.");
            }
        }
        foreach (var id in r.Dependencies) await Visit(id);
    }
    private async Task RequireSessionCompletion(PublicationRecord current, PublicationCommand input, CancellationToken ct)
    {
        foreach (var workspace in (await workspaces.ListAsync(current.Owner, true, ct)).Workspaces)
        {
            if (workspace.Id == current.WorkspaceId) continue;
            var other = await Read(workspace.Id, ct);
            if (other?.Outcome == "abandoned" || other is null && workspace.State == "released") continue;
            if (other is null) throw new PublicationException("session_unpublished", "Another session workspace has no published disposition.");
            other = await Observe(other, ct);
            if (other.Observation?.Head != other.PublishedHead || other.PublishedHead is null ||
                other.Outcome != "submitted" && other.Observation is not { State: "merged", Complete: true } &&
                !(input.Outcome == "submitted" && other.Observation is { State: "open" }))
                throw new PublicationException("session_pending", "Another session publication has not met its completion requirements.");
            if (workspace.State != "released") RequireHead(await workspaces.ObserveAsync(workspace.Id, current.Owner, ct), input with { ExpectedHead = other.PublishedHead });
        }
        await Dependencies(current, ct, input.Outcome == "merged");
    }
    public Task<PublicationRecord> CommandAsync(string id, WorkspaceOwner owner, string kind, PublicationCommand input, CancellationToken ct)
        => Locked(async () =>
    {
        if (!Guid.TryParse(input.RequestId, out _) || kind is not ("resolve-review" or "commit" or "configure" or "publish" or "link" or "ready" or "merge" or "complete" or "corrective"))
            throw new PublicationException("request_invalid", "Supply a UUID requestId and a supported publication operation.");
        await RequireOwner(owner, ct);
        var w = await workspaces.ObserveAsync(id, owner, ct);
        var r = await Read(id, ct);
        if (r is not null && r.Owner != owner) throw new PublicationException("forbidden", "Publication belongs to another session.");
        var fingerprint = DevelopmentWorkspaceService.Hash(CoreJson.Text(input));
        var previous = r?.Operations.FirstOrDefault(o => o.Id == input.RequestId);
        if (previous is not null && (previous.Kind != kind || previous.Fingerprint != fingerprint)) throw new PublicationException("request_conflict", "The request ID belongs to different arguments.");
        if (previous is { State: "succeeded" })
        {
            if (r!.Url is not null) await workspaces.AddPublicationReferenceAsync(id, owner, r.Url, ct);
            return r;
        }
        if (r?.Operations.Any(o => o.Id != input.RequestId && o.State == "pending") == true) throw new PublicationException("operation_pending", "Recover the previous operation with its original request ID first.");
        if (r is null)
        {
            if (kind != "configure" || string.IsNullOrWhiteSpace(input.ConnectionId)) throw new PublicationException("connection_required", "Configure a concrete user source connection before publication.");
            var sourceProvider = connections.Providers.ForUrl(w.Repository);
            var repository = Publication(sourceProvider.Descriptor.Id).NormalizeRepository(w.Repository);
            r = new PublicationRecord { Provider = sourceProvider.Descriptor.Id, WorkspaceId = id, Owner = owner, Repository = repository, HeadRepository = repository,
                ConnectionId = input.ConnectionId, Branch = w.Branch, TargetBranch = w.TargetBranch };
        }
        if (input.ConnectionId is not null && input.ConnectionId != r.ConnectionId) throw new PublicationException("connection_conflict", "This publication is bound to another connection.");
        var record = r;
        if (record.Outcome is not null && previous is null) throw new PublicationException("completed", "This publication already has a final outcome.");
        if (kind == "configure")
        {
            ValidatePolicy(input.Policy ?? new([], [], []));
            await Dependencies(record with { Dependencies = input.Dependencies ?? [] }, ct, false);
        }
        if (kind is "publish" or "merge") await Dependencies(record, ct, true);
        if (kind == "complete" && input.Outcome != "abandoned") await RequireSessionCompletion(record, input, ct);
        try
        {
            record = await connections.UseForSourceAsync(owner.UserId, r.ConnectionId, async c =>
            {
                if (c.Provider != record.Provider) throw new PublicationException("provider_mismatch", "Choose a connection for this repository provider.");
                var provider = Publication(c.Provider);
                var op = previous is null ? new PublicationOperation(input.RequestId, kind, fingerprint, "pending", input) : previous with { State = "pending", Error = null };
                record = record with { Operations = [.. record.Operations.Where(o => o.Id != op.Id), op] };
                await Save(record);
                if (kind == "configure")
                {
                    if (record.Number is not null || record.PublishedHead is not null) throw new PublicationException("policy_locked", "Configure completion policy before publication.");
                    var policy = input.Policy ?? new PublicationPolicy([], [], []); ValidatePolicy(policy);
                    if ((input.Dependencies?.Length ?? 0) > 20) throw new PublicationException("dependency_limit", "At most twenty publication dependencies are supported.");
                    record = record with { Policy = policy, Dependencies = input.Dependencies ?? [] };
                    record = record with { HeadRepository = await provider.DestinationAsync(c, record.Repository, input.Fork, ct) };
                }
                else if (kind == "commit")
                {
                    var user = (await users.ReadAsync(ct)).Users.Single(u => u.Id == owner.UserId && !u.Disabled);
                    var identity = previous?.Author ?? user.GitIdentity ?? await provider.IdentityAsync(c, ct);
                    var contributors = input.Contributors ?? [];
                    if (contributors.Length > 20 || contributors.Any(v => string.IsNullOrWhiteSpace(v) || v.Length > 300 || v.Any(char.IsControl) || !v.Contains('<') || !v.EndsWith('>')))
                        throw new PublicationException("attribution_invalid", "Supply recorded contributor names and no-reply emails.");
                    var message = input.Message ?? "";
                    foreach (var contributor in contributors)
                        if (!message.Split('\n').Any(line => line.Trim().Equals("Co-Authored-By: " + contributor, StringComparison.OrdinalIgnoreCase)))
                            message += "\n\nCo-Authored-By: " + contributor;
                    record = record with { Contributors = record.Contributors.Concat(contributors).Distinct().ToArray(),
                        Operations = record.Operations.Select(o => o.Id == input.RequestId ? o with { Author = identity } : o).ToArray() };
                    await Save(record);
                    var committed = await workspaces.CommandAsync(id, owner, "commit", new(input.RequestId, input.ExpectedHead, message, input.Paths, identity.Name, identity.Email), ct);
                    if (committed.Operations.LastOrDefault(o => o.Id == input.RequestId)?.State != "succeeded")
                        throw new PublicationException("commit_uncertain", "Inspect the workspace commit operation before retrying.");
                }
                else if (kind == "publish")
                {
                    RequireHead(w, input);
                    if (record.Outcome is not null) throw new PublicationException("completed", "This publication has completed; start a new session for new work.");
                    if (string.IsNullOrWhiteSpace(input.Title) || input.Title.Length > 250 || (input.Body?.Length ?? 0) > 60000) throw new PublicationException("description_invalid", "Provide a title and a bounded PR description.");
                    if (record.Number is not null)
                    {
                        var existing = await provider.ObserveAsync(c, record, ct);
                        if (existing.State != "open") throw new PublicationException("pr_closed", "Use a corrective operation for a merged PR; do not modify a closed contribution.");
                    }
                    // Workspace serialization fences managed commit/cleanup while credentials are in use.
                    await workspaces.WithPublicationAsync(id, owner, input.ExpectedHead!, async current =>
                    {
                        await provider.PushAsync(c, current, record.HeadRepository, record.Branch, input.ExpectedHead!, ct);
                        return true;
                    }, ct);
                    record = record with { PublishedHead = input.ExpectedHead }; await Save(record);
                    var found = record.Number is null ? await provider.FindAsync(c, record, ct) : null;
                    if (found is not null) record = Link(record, found);
                    record = Link(record, await provider.PublishAsync(c, record, input, ct));
                    if (!input.Draft) await provider.ReadyAsync(c, record, ct);
                }
                else if (kind == "link")
                {
                    if (input.Number is not > 0) throw new PublicationException("pr_required", "A concrete PR number is required.");
                    var candidate = Link(record, new(input.Number.Value, provider.PullRequestUrl(record.Repository, input.Number.Value), null, null));
                    candidate = candidate with { Observation = await provider.ObserveAsync(c, candidate, ct) };
                    if (candidate.Observation.Head != w.Observation?.Head) throw new PublicationException("head_mismatch", "The linked PR head differs from the workspace HEAD.");
                    record = candidate with { PublishedHead = candidate.Observation.Head };
                }
                else if (kind == "complete" && input.Outcome == "abandoned" && record.Number is null)
                {
                    RequireHead(w, input);
                    if (input.Cleanup) throw new PublicationException("unpublished_cleanup", "Unpublished work has no remote recovery reference. Record abandonment without cleanup and use explicit workspace cleanup separately.");
                    record = record with { Outcome = "abandoned", CompletedAt = clock.UtcNow };
                }
                else
                {
                    if (record.Number is null) throw new PublicationException("pr_required", "Publish or link a PR first.");
                    record = record with { Observation = await provider.ObserveAsync(c, record, ct) };
                    if (kind == "resolve-review")
                    {
                        RequireHead(w, input);
                        if (string.IsNullOrWhiteSpace(input.ThreadId) || input.ThreadId.Length > 200) throw new PublicationException("review_required", "Select a concrete addressed review thread.");
                        await provider.ResolveReviewAsync(c, record, input.ThreadId, input.ExpectedHead!, ct);
                    }
                    else if (kind == "ready")
                    {
                        RequireHead(w, input);
                        if (record.Observation.State != "open" || record.Observation.Head != input.ExpectedHead) throw new PublicationException("stale_head", "Refresh the current open PR head.");
                        await provider.ReadyAsync(c, record, ct);
                    }
                    else if (kind == "merge")
                    {
                        if (previous is not null && record.Observation is { State: "merged" } && record.Observation.Head == input.ExpectedHead) { /* Recovered remote merge. */ }
                        else
                        {
                            RequireHead(w, input);
                            RequireMerge(record.Observation, input.ExpectedHead!);
                            await provider.MergeAsync(c, record, input.ExpectedHead!, input.MergeMethod ?? "merge", ct);
                        }
                    }
                    else if (kind == "corrective")
                    {
                        RequireHead(w, input);
                        if (record.Observation.State != "merged" || record.Outcome is not null) throw new PublicationException("corrective_invalid", "A corrective PR requires a merged PR in an unfinished session.");
                        record = record with { History = [.. record.History, new(record.Number.Value, record.Url!, record.Observation.Head, record.Observation.MergeCommit)], Number = null, Url = null, PublishedHead = null, Observation = null, Branch = w.Branch + "-corrective-" + input.RequestId };
                    }
                    else if (kind == "complete")
                    {
                        RequireHead(w, input);
                        if (record.Observation.Head != input.ExpectedHead || record.PublishedHead != input.ExpectedHead) throw new PublicationException("unpublished", "The current workspace head is not the published PR head.");
                        if (input.Outcome == "merged" && record.Observation is not { State: "merged", Complete: true } ||
                            input.Outcome == "submitted" && record.Observation.State != "open" || input.Outcome is not ("merged" or "submitted" or "abandoned"))
                            throw new PublicationException("completion_blocked", "Choose an outcome supported by current PR and configured release evidence.");
                        record = record with { Outcome = input.Outcome, CompletedAt = clock.UtcNow, CleanupRequested = input.Cleanup };
                    }
                }
                record = record with { Operations = record.Operations.Select(o => o.Id == input.RequestId ? o with { State = "succeeded", Error = null } : o).ToArray() };
                await Save(record); return record;
            }, ct);
        }
        catch (Exception ex) when (ex is PublicationException or UserConnectionException or HttpRequestException or IOException or OperationCanceledException or AppLifecycleException)
        {
            // Preserve pending intent: an HTTP error may follow a successful push, fork or PR mutation.
            record = record with { Operations = record.Operations.Select(o => o.Id == input.RequestId ? o with { State = ex is PublicationException pe && pe.Code is not ("publication_provider_unavailable" or "publication_push_uncertain" or "publication_merge_uncertain" or "publication_fork_unavailable" or "publication_commit_uncertain") ? "failed" : "pending", Error = "Operation did not complete. Inspect state before retrying; retain the request ID for an uncertain outcome." } : o).ToArray() };
            await Save(record); throw;
        }
        if (record.Url is not null) await workspaces.AddPublicationReferenceAsync(id, owner, record.Url, ct);
        await audit.AppendAsync(new("audit_" + Guid.NewGuid().ToString("N"), "development.publication." + kind, "workspace", id, "succeeded", owner.UserId, clock.UtcNow,
            new Dictionary<string, string> { ["requestId"] = input.RequestId }), ct);
        return await Observe(record, ct);
    }, ct);
    private static void RequireHead(DevelopmentWorkspace w, PublicationCommand input)
    {
        if (w.State != "active" || w.Observation is not { State: "ok", Conflict: false, Local: { Files.Count: 0, Truncated: false } } || string.IsNullOrEmpty(input.ExpectedHead) || w.Observation.Head != input.ExpectedHead)
            throw new PublicationException("workspace_changed", "A clean active worktree and its current expectedHead are required.");
    }
    public async Task CleanupAsync(string id, CancellationToken ct)
    {
        await Locked(async () =>
        {
            var r = await Read(id, ct);
            if (r is null || !r.CleanupRequested || r.Outcome is null) return false;
            await RequireOwner(r.Owner, ct);
            r = await Observe(r, ct);
            if (r.Observation is { State: "unavailable" }) return false;
            if (r.Observation?.Head != r.PublishedHead) return false;
            if (r.Outcome == "merged" && r.Observation is not { State: "merged", Complete: true }) return false;
            var w = await workspaces.ObserveAsync(id, r.Owner, ct);
            if (w.State != "released") await workspaces.ReleasePublishedAsync(id, r.Owner, r.PublishedHead!, ct);
            await Save(r with { CleanupRequested = false }); return true;
        }, ct);
    }
}

internal sealed class PublicationObserver(PublicationService service, ILogger<PublicationObserver> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(30));
        do
        {
            try
            {
                foreach (var r in (await service.ListAsync(null, stoppingToken)).Publications)
                {
                    try { await service.ObserveAsync(r.WorkspaceId, null, stoppingToken); await service.CleanupAsync(r.WorkspaceId, stoppingToken); }
                    catch (Exception ex) when (ex is not OperationCanceledException) { logger.LogWarning("Cannot observe publication {WorkspaceId}: {ErrorType}", r.WorkspaceId, ex.GetType().Name); }
                }
            }
            catch (Exception ex) when (ex is not OperationCanceledException) { logger.LogWarning("Cannot list publications: {ErrorType}", ex.GetType().Name); }
        } while (await timer.WaitForNextTickAsync(stoppingToken));
    }
}

namespace Haas.Hosty.Core;

internal sealed record WorkspacePrObservationJob(string Id, string WorkspaceId, string UserId, string Repository,
    int? Number, PublicationObservation? Observation, Func<CancellationToken, Task> Run);

internal sealed partial class PublicationService
{
    internal static PublicationObservation DisplayObservation(PullRequestSummary pr)
        => new(pr.Receipt.ObservedAt ?? DateTimeOffset.UtcNow, pr.State, Head: pr.Head, Base: pr.BaseBranch,
            Draft: pr.Draft, MergeState: pr.MergeState, ReviewDecision: pr.ReviewDecision,
            UnresolvedThreads: -1, Complete: false,
            Checks: pr.Checks.Items.Select(c => new PublicationCheck(c.Name, c.State switch
            {
                "passed" => "SUCCESS", "failed" => "FAILURE", "running" => "IN_PROGRESS", "pending" => "PENDING",
                "skipped" => "SKIPPED", "neutral" => "NEUTRAL", "cancelled" => "CANCELLED", _ => "UNKNOWN"
            })).ToArray(), Error: pr.Checks.Completeness == "complete" ? null : "Check coverage is incomplete.",
            Title: pr.Title, CommentCount: pr.CommentCount, BaseHead: pr.Base);

    internal static PublicationObservation DisplayReferenceObservation(PullRequestSummary pr, string headRepository, string targetBranch)
    {
        if (!string.Equals(pr.HeadRepository, headRepository, StringComparison.OrdinalIgnoreCase) || pr.BaseBranch != targetBranch)
            throw new PublicationException("pr_mismatch", "The PR no longer matches the workspace repository and target branch.");
        return DisplayObservation(pr);
    }

    internal async Task ValidateObservationScopesAsync(PullRequestActor actor, string[] ids, CancellationToken ct, int explicitReferences = 0)
    {
        if (ids.Length == 0) return;
        await workspaces.RequireWorkspaceUserAsync(actor.UserId, ct);
        var all = (await workspaces.ListAsync(null, true, ct)).Workspaces;
        var references = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var id in ids.Distinct(StringComparer.Ordinal))
        {
            var trees = all.Where(t => t.WorkspaceId == id && t.Owner.UserId == actor.UserId).ToArray();
            if (trees.Length == 0) throw new PullRequestException("pr_scope_forbidden", "Workspace PR observation belongs to its source connection owner.", 403);
            foreach (var tree in trees)
            {
                if (tree.Owner.IsExternal) await ExternalConnection(tree, ct);
                else { await RequireOwner(tree.Owner, ct); await workspaces.RequireParticipationSourceAsync(tree, actor.UserId, ct); }
                references.UnionWith(tree.PullRequests);
            }
        }
        if (references.Count + explicitReferences > 200)
            throw new PullRequestException("pr_scope_limit", "Combined workspace and explicit scope exceeds 200 PR references.", 429);
    }

    internal async Task<WorkspacePrObservationJob[]> BackgroundObservationJobsAsync(CancellationToken ct)
    {
        var result = new List<WorkspacePrObservationJob>();
        foreach (var record in (await ListAsync(null, ct)).Publications)
        {
            if (!await workspaces.CanObserveInBackgroundAsync(record.WorkspaceId, ct)) continue;
            var tree = await workspaces.Read(record.WorkspaceId, null, ct);
            result.Add(new(record.WorkspaceId, tree.WorkspaceId, record.Owner.UserId, record.Repository, record.Number,
                record.Observation, token => ObserveCompactInBackgroundAsync(record.WorkspaceId, token)));
        }
        foreach (var tree in (await workspaces.ListAsync(null, true, ct)).Workspaces.Where(t => t.Owner.IsExternal))
        {
            if (!await workspaces.CanObserveInBackgroundAsync(tree.Id, ct)) continue;
            var snapshot = await JsonStorage.ReadAsync<ExternalPublicationSnapshot>(ExternalPath(tree.Id), ct);
            foreach (var url in tree.PullRequests.Where(SafeReference).Distinct(StringComparer.Ordinal))
            {
                if (!int.TryParse(new Uri(url).AbsolutePath.Split('/').Last(), out var number) || number <= 0) continue;
                result.Add(new(tree.Id + ":" + number, tree.WorkspaceId, tree.Owner.UserId, tree.Repository, number,
                    snapshot?.PullRequests.FirstOrDefault(p => p.Url == url)?.Observation,
                    token => ObserveExternalCompactAsync(tree, url, number, token)));
            }
        }
        return result.ToArray();
    }
    private async Task ObserveCompactInBackgroundAsync(string id, CancellationToken ct)
    {
        await Locked(async () =>
        {
            if (!await workspaces.CanObserveInBackgroundAsync(id, ct)) return false;
            var record = await Read(id, ct);
            if (record is null) return false;
            await RequireOwner(record.Owner, ct);
            var tree = await workspaces.Read(id, null, ct);
            await workspaces.RequireParticipationSourceAsync(tree, record.Owner.UserId, ct);
            if (record.Number is null) { await Observe(record, ct); return true; }
            var observation = await connections.UseForSourceAsync(record.Owner.UserId, record.ConnectionId, async connection =>
            {
                var provider = Publication(connection.Provider);
                if (provider is not IPullRequestProvider reader) return await provider.ObserveAsync(connection, record, ct);
                var result = (await reader.ReadPullRequestsAsync(connection, record.Repository, "", [record.Number.Value], ct)).Single();
                if (result.HeadBranch != record.Branch)
                    throw new PublicationException("pr_mismatch", "The PR no longer matches this workspace's publication branches.");
                return DisplayReferenceObservation(result, record.HeadRepository, record.TargetBranch);
            }, ct);
            if (!await workspaces.CanObserveInBackgroundAsync(id, ct)) return false;
            await RequireOwner(record.Owner, ct);
            await workspaces.RequireParticipationSourceAsync(await workspaces.Read(id, null, ct), record.Owner.UserId, ct);
            // Merge/release evidence still goes through the original verifier with its policy.
            if (observation.State == "merged" || record.CleanupRequested) await Observe(record, ct);
            else await Save(record with { Observation = observation });
            return true;
        }, ct);
        await CleanupAsync(id, ct, background: true);
    }
    private async Task ObserveExternalCompactAsync(DevelopmentWorkspace tree, string url, int number, CancellationToken ct)
    {
        if (!await workspaces.CanObserveInBackgroundAsync(tree.Id, ct)) return;
        var binding = await ExternalConnection(tree, ct);
        var provider = binding.Source.Publication!;
        if (!string.Equals(provider.PullRequestUrl(binding.Repository, number), url, StringComparison.OrdinalIgnoreCase)) return;
        var observation = await connections.UseForSourceAsync(tree.Owner.UserId, binding.Connection.Id, async connection =>
        {
            if (provider is IPullRequestProvider reader)
                return DisplayReferenceObservation((await reader.ReadPullRequestsAsync(connection, binding.Repository, "", [number], ct)).Single(), binding.Repository, tree.TargetBranch);
            return await provider.ObserveReferenceAsync(connection, new() { WorkspaceId = tree.Id, Owner = tree.Owner,
                Repository = binding.Repository, HeadRepository = binding.Repository, ConnectionId = connection.Id,
                Provider = binding.Source.Descriptor.Id, Branch = tree.Branch, TargetBranch = tree.TargetBranch, Number = number, Url = url }, ct);
        }, ct);
        var current = await workspaces.Read(tree.Id, tree.Owner, ct);
        if (!await workspaces.CanObserveInBackgroundAsync(tree.Id, ct) || (await ExternalConnection(current, ct)).Connection.Id != binding.Connection.Id) return;
        var previous = await JsonStorage.ReadAsync<ExternalPublicationSnapshot>(ExternalPath(tree.Id), ct);
        var retained = previous?.ConnectionId == binding.Connection.Id && previous.Owner.SameIdentity(tree.Owner) && previous.Repository == binding.Repository ? previous.PullRequests : [];
        var items = current.PullRequests.Where(SafeReference).Distinct(StringComparer.Ordinal).Select(reference => reference == url
            ? new InspectionPullRequest(url, observation.Head, observation with { Complete = false, Reviews = null }, null)
            : retained.FirstOrDefault(p => p.Url == reference) ?? new(reference, null, null, "Waiting for provider observation.")).ToArray();
        await workspaces.WritePublicationAsync(tree.Id, () => JsonStorage.WriteAsync(ExternalPath(tree.Id),
            new ExternalPublicationSnapshot(tree.Id, tree.Owner, binding.Repository, binding.Connection.Id, items), restrictToOwner: true), ct);
    }
}

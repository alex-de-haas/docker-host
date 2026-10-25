namespace Haas.Hosty.Core;

internal sealed record WorkspaceCommitReviewRequest(string RequestId, string ExpectedHead, string[] Paths);
internal sealed record WorkspaceCommitReview(string Id, string WorktreeId, WorkspaceOwner Actor, long MembershipRevision,
    string Head, string[] Paths, string Tree, DateTimeOffset ExpiresAt);
internal sealed record WorkspaceLeaseClaim(string Id, WorkspaceOwner Session);

internal sealed partial class DevelopmentWorkspaceService
{
    private string CommitReviewPath(string id)
    {
        RequestId(id);
        return System.IO.Path.Combine(Root, "commit-reviews", Guid.Parse(id).ToString("D") + ".json");
    }

    internal Task<WorkspaceCommitReview> PrepareCommitReviewAsync(string id, WorkspaceOwner actor,
        WorkspaceCommitReviewRequest input, CancellationToken ct)
        => Locked("workspace-participation", async () =>
        {
            RequestId(input.RequestId);
            var tree = await Read(id, actor, ct);
            return await Locked(Hash(OwnerIdentity(tree.Owner)), async () =>
            {
                tree = await Read(id, actor, ct);
                await RequireOpenWorkflow(tree.Owner, ct);
                var state = await ReadParticipationAsync(tree.WorkspaceId, ct);
                var paths = ReviewPaths(tree, input.Paths);
                var previous = await JsonStorage.ReadAsync<WorkspaceCommitReview>(CommitReviewPath(input.RequestId), ct);
                if (previous is not null)
                {
                    if (previous.WorktreeId != id || !previous.Actor.SameIdentity(actor) || previous.Head != input.ExpectedHead || !previous.Paths.SequenceEqual(paths))
                        throw Error("request_conflict", "Reuse the original commit review arguments and session.");
                    return previous;
                }
                tree = await Observe(tree, ct);
                if (tree.Observation is not { State: "ok", Conflict: false } || tree.Observation.Head != input.ExpectedHead)
                    throw Error("stale_head", "Refresh the workspace before reviewing a commit.");
                var index = System.IO.Path.Combine(Root, "indexes", Guid.NewGuid().ToString("N") + ".index");
                Directory.CreateDirectory(System.IO.Path.GetDirectoryName(index)!);
                try
                {
                    foreach (var path in paths)
                        if (File.Exists(System.IO.Path.Combine(tree.Path, path)))
                            await AppSourceService.RequireRegularFileAsync(System.IO.Path.Combine(tree.Path, path), ct);
                    await Git(tree.Path, ["read-tree", input.ExpectedHead], ct, index: index);
                    await Git(tree.Path, ["--literal-pathspecs", "add", "--", .. paths], ct, index: index);
                    var snapshot = (await Git(tree.Path, ["write-tree"], ct, index: index)).StandardOutput.Trim();
                    var result = new WorkspaceCommitReview(input.RequestId, id, actor, state?.Revision ?? 0,
                        input.ExpectedHead, paths, snapshot, clock.UtcNow.AddMinutes(15));
                    await JsonStorage.WriteAsync(CommitReviewPath(input.RequestId), result, restrictToOwner: true);
                    return result;
                }
                finally { File.Delete(index); }
            }, ct);
        }, ct);

    private static string[] ReviewPaths(DevelopmentWorkspace tree, string[]? paths)
    {
        if (paths is not { Length: > 0 and <= 256 } || paths.Distinct(StringComparer.Ordinal).Count() != paths.Length ||
            paths.Any(p => string.IsNullOrWhiteSpace(p) || p.Any(char.IsControl) || p.StartsWith('-') || p.StartsWith(':') ||
                p.Contains('\\') || p.Split('/').Any(s => s is "" or "." or "..") ||
                !CoreDataPaths.TryResolveContainedRelativePath(tree.Path, p, out var full) || Directory.Exists(full) ||
                !AppSourceService.IsRegularSourcePath(tree.Path, p)))
            throw Error("paths_invalid", "Select up to 256 distinct regular repository-relative file paths.");
        return paths.Order(StringComparer.Ordinal).ToArray();
    }

    private async Task ValidateCommitReviewAsync(DevelopmentWorkspace workspace, WorkspaceOwner? actor,
        WorkspaceCommand input, string stagedTree, CancellationToken ct)
    {
        var participation = await ReadParticipationAsync(workspace.WorkspaceId, ct);
        var shared = participation is not null && (participation.Members.Length > 1 || participation.Sessions.Length > 1);
        if (input.ReviewId is null)
        {
            if (shared) throw Error("commit_review_required", "Review the selected shared-workspace files before committing.");
            return;
        }
        if (actor is null) throw Error("commit_review_required", "Use the session that reviewed these files.");
        var review = await JsonStorage.ReadAsync<WorkspaceCommitReview>(CommitReviewPath(input.ReviewId), ct)
            ?? throw Error("commit_review_missing", "The commit review is unavailable. Review the selected files again.");
        if (review.WorktreeId != workspace.Id || !review.Actor.SameIdentity(actor) || review.MembershipRevision != (participation?.Revision ?? 0) ||
            review.ExpiresAt <= clock.UtcNow || review.Head != input.ExpectedHead || review.Tree != stagedTree ||
            !review.Paths.SequenceEqual(ReviewPaths(workspace, input.Paths)))
            throw Error("commit_review_stale", "Source or membership changed since review. Review the current selected files before committing.");
    }

    private static DevelopmentWorkspace ClaimLease(DevelopmentWorkspace tree, WorkspaceOwner actor, string id)
    {
        var claim = tree.LeaseClaims?.FirstOrDefault(c => c.Id == id);
        if (claim is not null && !claim.Session.SameIdentity(actor) || claim is null && tree.Leases.Contains(id))
            throw Error("lease_owner", "This lease belongs to another execution or has unknown legacy ownership.");
        return tree with { Leases = tree.Leases.Append(id).Distinct().ToArray(),
            LeaseClaims = [.. tree.LeaseClaims?.Where(c => c.Id != id) ?? [], new(id, actor)] };
    }

    private static void RequireLeaseOwner(DevelopmentWorkspace tree, WorkspaceOwner? actor, string id)
    {
        var claim = tree.LeaseClaims?.FirstOrDefault(c => c.Id == id);
        if (claim is not null && (actor is null || !claim.Session.SameIdentity(actor)))
            throw Error("lease_owner", "Only the owning execution can release this activity lease.");
        if (claim is null && actor is not null && !actor.SameIdentity(tree.Owner) && tree.Leases.Contains(id))
            throw Error("lease_owner", "Legacy lease ownership is unknown. Use the explicit operator recovery action.");
    }
}

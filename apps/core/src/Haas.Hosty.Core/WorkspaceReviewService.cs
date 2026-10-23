using System.Globalization;
using System.Text.RegularExpressions;

namespace Haas.Hosty.Core;

internal sealed partial class WorkspaceInspectionService
{
    public async Task<WorkspaceReview> ReviewAsync(string workspaceId, string id, string userId,
        string scope, string? pullRequestUrl, CancellationToken ct)
        => (await ReadReviewProjectionAsync(workspaceId, id, userId, scope, pullRequestUrl, ct)).Review;

    private async Task<(WorkspaceReview Review, PublicationReviewSnapshot? Snapshot)> ReadReviewProjectionAsync(
        string workspaceId, string id, string userId, string scope, string? pullRequestUrl, CancellationToken ct)
    {
        var tree = await RequireAsync(workspaceId, id, userId, ct);
        if (scope is not ("local" or "session" or "target" or "pull-request"))
            throw DevelopmentWorkspaceService.Error("review_scope_invalid", "Choose a local, session, target or published PR review.");
        tree = await workspaces.ReadObservedAsync(id, ct, refresh: true);
        await RequireAsync(workspaceId, id, userId, ct);
        if (scope == "pull-request")
        {
            if (publications is null || string.IsNullOrWhiteSpace(pullRequestUrl))
                throw DevelopmentWorkspaceService.Error("review_invalid", "Select a PR registered with this worktree.");
            var snapshot = await publications.ReadReviewSnapshotAsync(tree, userId, pullRequestUrl, ct);
            tree = await workspaces.ReadObservedAsync(id, ct, refresh: true);
            await RequireAsync(workspaceId, id, userId, ct);
            var local = tree.Observation?.Local;
            var source = ReviewSource(scope, "PR #" + new Uri(snapshot.Url).Segments.Last(), snapshot.MergeBase,
                snapshot.Head, snapshot.MergeBase, snapshot.BaseBranch, snapshot.Url, snapshot.Observation.At,
                tree.Observation?.Head, snapshot.Head != tree.Observation?.Head || local?.Files.Count > 0, null);
            await RequireAsync(workspaceId, id, userId, ct);
            return (new(source, snapshot.Files.Select(file => new AppSourceFile(file.Path,
                file.Status, file.Status is "added" or "A", false,
                new(file.Additions, file.Deletions), file.Binary)).ToArray(), snapshot.Observation.Reviews ?? [],
                snapshot.Truncated, Observation: snapshot.Observation), snapshot);
        }
        PublicationReviewSnapshot? comparison = null;
        if (!string.IsNullOrWhiteSpace(pullRequestUrl))
        {
            if (publications is null)
                throw DevelopmentWorkspaceService.Error("review_invalid", "Select a PR registered with this worktree.");
            // A comparison is selected explicitly. A worktree can have several PRs; never infer one.
            comparison = await publications.ReadReviewSnapshotAsync(tree, userId, pullRequestUrl, ct);
            tree = await workspaces.ReadObservedAsync(id, ct, refresh: true);
            await RequireAsync(workspaceId, id, userId, ct);
        }
        await RequireReviewTreeAsync(tree, ct);
        var status = tree.Observation!.Local!;
        var basis = scope == "local" ? status.Head! : tree.OriginalBase;
        string? mergeBase = null;
        if (scope == "target")
        {
            var target = tree.Observation.TargetHead ?? throw DevelopmentWorkspaceService.Error("review_unavailable", "The cached target branch is unavailable. Refresh the workspace first.");
            mergeBase = await ReviewGitText(tree.Path, ["merge-base", status.Head!, target], ct);
            basis = mergeBase;
        }
        var files = scope == "local" ? status.Files.Select(file => file with { CanDiscard = false }).ToArray()
            : await ReviewWorkingFilesAsync(tree, basis, status, ct);
        var statistics = await AppSourceService.AddLineStatisticsAsync(status with { Head = basis, Files = files }, ct);
        var sourceLabel = scope == "local" ? "Uncommitted changes" : scope == "session" ? "Session changes" : "Since " + tree.TargetBranch;
        var projection = ReviewSource(scope, sourceLabel, basis, status.Head!, mergeBase, tree.TargetBranch,
            null, clock.UtcNow, status.Head, false, tree.SourceStamp, comparison?.Url, comparison?.Head);
        await RequireAsync(workspaceId, id, userId, ct);
        return (new(projection, statistics.Files.ToArray(), [], statistics.Truncated), comparison);
    }

    public async Task<WorkspaceReviewDiff> ReviewDiffAsync(string workspaceId, string id, string userId,
        string scope, string? pullRequestUrl, string path, string? revision, CancellationToken ct)
    {
        // Rebuild the scope rather than trusting a client-provided SHA, file list or provider identity.
        var loaded = await ReadReviewProjectionAsync(workspaceId, id, userId, scope, pullRequestUrl, ct);
        var review = loaded.Review;
        if (!string.IsNullOrEmpty(revision) && revision != review.Source.Revision)
            throw DevelopmentWorkspaceService.Error("review_stale", "The review source changed. Refresh the file list before opening this diff.");
        var file = review.Files.FirstOrDefault(file => file.Path == path)
            ?? throw DevelopmentWorkspaceService.Error("review_path_invalid", "Choose a file in the observed review.");
        var tree = await RequireAsync(workspaceId, id, userId, ct);
        if (tree.State == "active") await workspaces.ValidateTree(tree, ct);
        AppSourceDiff diff;
        WorkspaceReviewLineRange[] ranges = [];
        var rangesComplete = false;
        if (scope == "pull-request")
        {
            // Reuse the exact authenticated snapshot which produced this file list and revision.
            var snapshot = loaded.Snapshot!;
            var published = snapshot.Files.FirstOrDefault(candidate => candidate.Path == path)
                ?? throw DevelopmentWorkspaceService.Error("review_stale", "The published file list changed. Refresh the review.");
            var patch = published.Patch;
            diff = new(path, patch ?? "", "", patch is null && !published.Binary,
                snapshot.Head, file.NewFile, published.Binary);
            (ranges, rangesComplete) = await LocalReviewRangesAsync(tree, snapshot.Head, path, ct);
        }
        else if (scope is "session" or "local")
            diff = await workspaces.DiffAsync(id, null, new(path, scope), ct);
        else
            diff = await WorkingReviewDiffAsync(tree, review.Source.Base, file, ct);
        WorkspaceReviewPublishedEvidence? evidence = null;
        if (!review.Source.Published && loaded.Snapshot is { } comparison)
            evidence = await PublishedReviewEvidenceAsync(tree, comparison, path, diff, ct);
        // Recheck the selected publication after local Git, including its current owner/source authority.
        // A force-push must not leave line evidence labelled with an obsolete comparison head.
        if (!review.Source.Published && loaded.Snapshot is { } selected)
        {
            var current = await publications!.ReadReviewSnapshotAsync(tree, userId, selected.Url, ct);
            if (current.Head != selected.Head)
                throw DevelopmentWorkspaceService.Error("review_stale", "The selected PR head changed. Refresh the review.");
        }
        // A live edit can occur while Git is producing output or the provider is rechecked.
        // Never pair it with a stale source identity.
        var final = await workspaces.ReadObservedAsync(id, ct, refresh: true);
        await RequireAsync(workspaceId, id, userId, ct);
        if (!review.Source.Published)
        {
            await RequireReviewTreeAsync(final, ct);
            var finalBase = scope == "local" ? final.Observation!.Head! : final.OriginalBase;
            if (scope == "target")
                finalBase = await ReviewGitText(final.Path,
                    ["merge-base", final.Observation!.Head!, final.Observation.TargetHead!], ct);
            var finalRevision = ReviewRevision(scope, finalBase, final.Observation!.Head!,
                review.Source.PullRequestUrl, final.SourceStamp,
                review.Source.PublishedComparisonUrl, review.Source.PublishedComparisonHead);
            if (finalRevision != review.Source.Revision)
                throw DevelopmentWorkspaceService.Error("review_stale", "Workspace files changed while reading the diff. Refresh the review.");
        }
        else if (final.SourceStamp != tree.SourceStamp)
        {
            ranges = [];
            rangesComplete = false;
        }
        await RequireAsync(workspaceId, id, userId, ct);
        return new(review.Source, diff, ranges, rangesComplete, evidence);
    }

    private static WorkspaceReviewSource ReviewSource(string scope, string label, string basis, string head,
        string? mergeBase, string? target, string? url, DateTimeOffset at, string? localHead, bool unpublished, string? stamp,
        string? comparisonUrl = null, string? comparisonHead = null)
        => new(scope, label, basis, head, mergeBase, target, url, at,
            ReviewRevision(scope, basis, head, url, stamp, comparisonUrl, comparisonHead),
            scope == "pull-request", localHead, unpublished, comparisonUrl, comparisonHead);

    private static string ReviewRevision(string scope, string basis, string head, string? url, string? stamp,
        string? comparisonUrl, string? comparisonHead)
        => DevelopmentWorkspaceService.Hash(string.Join("\n", scope, basis, head, url, stamp, comparisonUrl, comparisonHead));

    private async Task RequireReviewTreeAsync(DevelopmentWorkspace tree, CancellationToken ct)
    {
        if (tree.State != "active" || tree.Observation is not { State: "ok", Local.Head: not null })
            throw DevelopmentWorkspaceService.Error("review_unavailable", "Workspace source is unavailable.");
        await workspaces.ValidateTree(tree, ct);
    }

    private static async Task<string> ReviewGitText(string path, string[] args, CancellationToken ct)
        => (await DevelopmentWorkspaceService.Git(path, args, ct)).StandardOutput.Trim();

    private static async Task<AppSourceFile[]> ReviewWorkingFilesAsync(DevelopmentWorkspace tree,
        string basis, AppSourceStatus local, CancellationToken ct)
    {
        var names = (await DevelopmentWorkspaceService.Git(tree.Path,
            ["diff", "--no-ext-diff", "--no-textconv", "--name-status", "-z", "--no-renames", basis, "--"], ct))
            .StandardOutput.Split('\0', StringSplitOptions.RemoveEmptyEntries);
        var files = new Dictionary<string, AppSourceFile>(StringComparer.Ordinal);
        for (var i = 0; i + 1 < names.Length; i += 2)
            files[names[i + 1]] = new(names[i + 1], names[i], names[i] == "A", false);
        foreach (var file in local.Files.Where(file => file.Status == "??"))
            files.TryAdd(file.Path, file with { CanDiscard = false });
        return files.Values.OrderBy(file => file.Path, StringComparer.Ordinal).ToArray();
    }

    private static async Task<AppSourceDiff> WorkingReviewDiffAsync(DevelopmentWorkspace tree,
        string basis, AppSourceFile file, CancellationToken ct)
    {
        if (!AppSourceService.IsRegularSourcePath(tree.Path, file.Path))
            throw DevelopmentWorkspaceService.Error("review_path_invalid", "Only regular files inside the workspace can be previewed.");
        await AppSourceService.RequireRegularFileAsync(Path.Combine(tree.Path, file.Path), ct);
        // The application index and worktree remain untouched. The temporary index is owned by this read.
        var directory = Path.Combine(Path.GetTempPath(), "hosty-review-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        var index = Path.Combine(directory, "index");
        try
        {
            await DevelopmentWorkspaceService.Git(tree.Path, ["read-tree", basis], ct, index: index);
            if (File.Exists(Path.Combine(tree.Path, file.Path)))
                await DevelopmentWorkspaceService.Git(tree.Path, ["add", "--intent-to-add", "--force", "--", file.Path], ct, index: index);
            var status = tree.Observation!.Local! with { Head = basis, Files = [file with { Status = " M" }] };
            var diff = await AppSourceService.ReadScopeDiffAsync(status, new(file.Path), ct, index);
            return diff with { Staged = "" };
        }
        finally { Directory.Delete(directory, recursive: true); }
    }

    private static async Task<(WorkspaceReviewLineRange[] Ranges, bool Complete)> LocalReviewRangesAsync(
        DevelopmentWorkspace tree, string publishedHead, string path, CancellationToken ct)
    {
        if (tree.State != "active" || tree.Observation is not { State: "ok", Local: { } local } ||
            !AppSourceService.IsRegularSourcePath(tree.Path, path)) return ([], false);
        if (local.Files.Any(file => file.Path == path && file.Status == "??")) return ([], false);
        try
        {
            var exists = await DevelopmentWorkspaceService.Git(tree.Path, ["cat-file", "-e", publishedHead + "^{commit}"], ct, allowFailure: true);
            if (exists.ExitCode != 0) return ([], false); // Read-only: never fetch with ambient Git credentials.
            var patch = await DevelopmentWorkspaceService.Git(tree.Path,
                ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--unified=0", publishedHead, "--", path], ct);
            if (AppSourceService.IsBinaryPatch(patch.StandardOutput)) return ([], false);
            return (ParseOldLineRanges(patch.StandardOutput), true);
        }
        catch (AppLifecycleException) { return ([], false); } // Published evidence remains useful when local evidence is unavailable.
    }

    internal static WorkspaceReviewLineRange[] ParseOldLineRanges(string patch)
    {
        var ranges = new List<WorkspaceReviewLineRange>();
        foreach (var line in patch.Split('\n'))
        {
            var match = Regex.Match(line, "^@@ -([0-9]+)(?:,([0-9]+))? \\+[0-9]+(?:,[0-9]+)? @@", RegexOptions.CultureInvariant);
            if (!match.Success) continue;
            if (!int.TryParse(match.Groups[1].Value, NumberStyles.None, CultureInfo.InvariantCulture, out var start) ||
                !int.TryParse(match.Groups[2].Success ? match.Groups[2].Value : "1", NumberStyles.None, CultureInfo.InvariantCulture, out var count)) continue;
            // Pure insertions touch the preceding published line (or the first line at the file start).
            var first = Math.Max(1, start);
            var last = Math.Max(first, (long)start + count - 1);
            if (last <= int.MaxValue) ranges.Add(new(first, (int)last));
        }
        return ranges.ToArray();
    }
}

using System.Security.Cryptography;
using System.Text;

namespace Haas.Hosty.Core;

internal sealed record WorkspaceDiscardApply(string RequestId, long ExpectedRevision, string Digest, string ConfirmationName);
internal sealed record WorkspaceDiscardTree(string Id, string Repository, string Path, string Branch, string? Head,
    string Fingerprint, string[] ChangedFiles, string[] UntrackedFiles, string[] IgnoredFiles, int UnmergedCommits);
internal sealed record WorkspaceDiscardResource(string Id, string Kind, string Name, string? DataPath, string State, long Revision);
internal sealed record WorkspaceDiscardPlan(string WorkspaceId, string Name, long Revision, string Digest,
    DateTimeOffset ExpiresAt, WorkspaceDiscardTree[] Trees, WorkspaceDiscardResource[] Resources, string[] Blockers, string[]? RemovedTrees = null, string[]? Warnings = null);
internal sealed record WorkspaceDiscardItem(string Id, string State, string? Kind = null);
internal sealed record WorkspaceDiscardProgress(string WorkspaceId, string RequestId, string State, WorkspaceDiscardApply Command,
    WorkspaceDiscardItem[] Trees, WorkspaceDiscardItem[] Resources, string? Error = null, WorkspaceDeleteActivity[]? Activity = null);
internal sealed record WorkspaceDiscardReview(string Actor, WorkspaceOwner Owner, WorkspaceDiscardPlan Plan);
internal sealed record WorkspaceDiscardJournal(string Actor, string WorkspaceId, WorkspaceDiscardApply Command,
    string State, WorkspaceOwner? Owner, WorkspaceDiscardPlan? Plan, DevelopmentWorkspace[]? Snapshots,
    WorkspaceDiscardItem[] Trees, WorkspaceDiscardItem[] Resources, WorkspaceCleanupResource[] Cleanup,
    string? Error = null, bool SourceRemoved = false, string[]? RelatedRequests = null, string[]? ReviewDigests = null, bool Direct = false, WorkspaceDeleteActivity[]? Activity = null)
{
    internal WorkspaceDiscardProgress Progress() => new(WorkspaceId, Command.RequestId, State, Command, Trees, Resources, Error, Activity);
}

internal sealed partial class DevelopmentWorkspaceService
{
    private string DiscardRoot => System.IO.Path.Combine(Root, "discards");
    private string DiscardJournalPath(string workspaceId, string requestId)
    {
        Id(workspaceId); RequestId(requestId);
        var path = System.IO.Path.Combine(DiscardRoot, "operations", workspaceId + "-" + Guid.Parse(requestId).ToString("D") + ".json");
        RequireDiscardStorage(path); return path;
    }
    private string DiscardReviewPath(string digest)
    {
        Id(digest); var path = System.IO.Path.Combine(DiscardRoot, "reviews", digest + ".json");
        RequireDiscardStorage(path); return path;
    }
    private void RequireDiscardStorage(string path)
    {
        if (CoreDataPaths.ContainsSymbolicLink(Root, path)) throw Error("ownership_invalid", "Removal metadata cannot contain symbolic links.");
    }
    internal async Task<WorkspaceDiscardJournal?> ReadDiscardAsync(string workspaceId, string requestId, string actor, CancellationToken ct)
    {
        var value = await JsonStorage.ReadAsync<WorkspaceDiscardJournal>(DiscardJournalPath(workspaceId, requestId), ct);
        if (value is not null)
        {
            if (value.WorkspaceId != workspaceId)
                throw Error("forbidden", "The deletion receipt does not match this workspace.");
            if (value.Command is null || value.Command.RequestId != requestId || value.Trees is null || value.Resources is null || value.Cleanup is null
                || value.State is not ("pending" or "removed" or "review-required") || value.Trees.Select(t => t.Id).Distinct().Count() != value.Trees.Length
                || value.State != "removed" && (value.Owner is null || WorkspaceIdFor(value.Owner) != workspaceId
                    || value.Plan is null || value.Plan.WorkspaceId != workspaceId || value.Plan.Digest != value.Command.Digest || value.Snapshots is not { Length: > 0 }
                    || value.Snapshots.Any(w => w.Owner is null || !w.Owner.SameIdentity(value.Owner) || w.WorkspaceId != workspaceId
                        || w.Id != Hash(OwnerIdentity(value.Owner) + "\n" + w.RepositoryId) || w.RepositoryId != Hash(w.Repository)
                        || w.Path != WorkPath(w.Id) || w.Branch != "hosty/session/" + w.Id)
                    || !value.Trees.Select(t => t.Id).Order(StringComparer.Ordinal).SequenceEqual(value.Snapshots.Select(t => t.Id).Order(StringComparer.Ordinal))))
                throw Error("ownership_invalid", "The removal journal is inconsistent; source was preserved.");
            if (value.State != "removed")
            {
                var plan = value.Plan!;
                if (plan.Trees.Any(t => !value.Snapshots!.Any(w => w.Id == t.Id && w.Repository == t.Repository && w.Path == t.Path && w.Branch == t.Branch))
                    || !value.Resources.Select(r => r.Kind + ":" + r.Id).Order(StringComparer.Ordinal).SequenceEqual(plan.Resources.Select(r => r.Kind + ":" + r.Id).Order(StringComparer.Ordinal))
                    || !value.Cleanup.Select(r => r.Kind + ":" + r.Id).Order(StringComparer.Ordinal).SequenceEqual(plan.Resources.Select(r => r.Kind + ":" + r.Id).Order(StringComparer.Ordinal)))
                    throw Error("ownership_invalid", "The removal resource scope is inconsistent; data was preserved.");
            }
        }
        return value;
    }
    internal async Task SaveDiscardAsync(WorkspaceDiscardJournal value)
    {
        await JsonStorage.WriteAsync(DiscardJournalPath(value.WorkspaceId, value.Command.RequestId), value, restrictToOwner: true);
        observationState?.CatalogChanged();
    }
    internal async Task<WorkspaceDiscardJournal[]> PendingDiscardJournalsAsync(string actor, CancellationToken ct)
    {
        var directory = System.IO.Path.Combine(DiscardRoot, "operations");
        if (!Directory.Exists(directory)) return [];
        var found = new List<WorkspaceDiscardJournal>();
        foreach (var path in Directory.EnumerateFiles(directory, "*.json"))
        {
            RequireDiscardStorage(path);
            var value = await JsonStorage.ReadAsync<WorkspaceDiscardJournal>(path, ct);
            if (value is null || value.State != "pending") continue;
            var journal = await ReadDiscardAsync(value.WorkspaceId, value.Command.RequestId, actor, ct);
            if (journal is not null && DiscardJournalPath(journal.WorkspaceId, journal.Command.RequestId) == path) found.Add(journal);
        }
        return found.ToArray();
    }

    private async Task<bool> HasPendingDiscardAsync(WorkspaceOwner owner, CancellationToken ct)
        => (await PendingDiscardJournalsAsync(owner.UserId, ct)).Any(journal => journal.Owner?.SameIdentity(owner) == true);

    internal Task<WorkspaceDiscardPlan> PrepareDiscardAsync(WorkspaceOwner owner, string actor,
        WorkspaceDiscardResource[] resources, CancellationToken ct)
        => Locked(Hash(OwnerIdentity(owner)), async () =>
        {
            RequireDiscardActor(owner, actor);
            var plan = await BuildDiscardPlan(owner, resources, ct);
            plan = plan with { Digest = Hash(actor + "\n" + CoreJson.Text(owner) + "\n" + CoreJson.Text(plan)) };
            await JsonStorage.WriteAsync(DiscardReviewPath(plan.Digest), new WorkspaceDiscardReview(actor, owner, plan), restrictToOwner: true);
            return plan;
        }, ct);

    private static void RequireDiscardActor(WorkspaceOwner owner, string actor)
    {
        if (string.IsNullOrWhiteSpace(actor)) throw Error("forbidden", "An initiating user is required for workspace deletion.");
    }
    private async Task<DevelopmentWorkspace[]> DiscardTrees(WorkspaceOwner owner, CancellationToken ct)
    {
        // Unlike a diagnostic list, unreadable ownership records cannot silently omit a repository.
        var found = new List<DevelopmentWorkspace>();
        if (Directory.Exists(Records)) foreach (var path in Directory.EnumerateFiles(Records, "*.json"))
        {
            var tree = await Read(System.IO.Path.GetFileNameWithoutExtension(path), null, ct);
            if (tree.Owner.SameIdentity(owner)) found.Add(tree);
        }
        return found.OrderBy(w => w.Id, StringComparer.Ordinal).ToArray();
    }
    private async Task<WorkspaceDiscardPlan> BuildDiscardPlan(WorkspaceOwner owner, WorkspaceDiscardResource[] resources, CancellationToken ct, bool direct = false)
    {
        var workflow = await WorkflowAsync(owner, ct);
        var trees = await DiscardTrees(owner, ct);
        if (trees.Length == 0) throw Error("not_found", "The workspace has no registered source to discard.");
        var blockers = new List<string>(); var review = new List<WorkspaceDiscardTree>();
        var renewed = workflow.State == "deleting" && await HasDiscardReviewRequired(owner, workflow, ct);
        if (!direct && (workflow.State == "deleted" || workflow.State == "deleting" && !renewed || workflow.Operations?.Any(o => o.State == "pending") == true))
            blockers.Add("Recover the already accepted workspace action before preparing another removal.");
        foreach (var tree in trees)
        {
            if ((direct || renewed) && tree.State == "released") continue;
            try
            {
                if (!direct && tree.State != "active") throw Error("not_active", "The worktree is not active; recover its existing operation first.");
                if (!direct && tree.Operations.Any(o => o.State is "pending" or "unknown"))
                    throw Error("operation_pending", "Recover outstanding source operations before discarding this worktree.");
                if (!direct) await CheckDiscardConsumers(tree, resources.Select(r => r.Id).ToHashSet(StringComparer.Ordinal), ct);
                review.Add(await InspectDiscardTree(tree, ct, fingerprint: !direct));
            }
            catch (Exception ex) when (ex is AppLifecycleException or IOException or UnauthorizedAccessException)
            {
                blockers.Add(tree.Repository + ": " + ex.Message);
                // An unreadable or blocked tree remains explicit; it is never an empty successful review.
                review.Add(new(tree.Id, tree.Repository, tree.Path, tree.Branch, null, "", [], [], [], 0));
            }
        }
        return new(WorkspaceIdFor(owner), trees[0].Name ?? "Workspace", workflow.Revision, "", clock.UtcNow.AddMinutes(10),
            review.ToArray(), resources.OrderBy(r => r.Kind).ThenBy(r => r.Id).ToArray(), blockers.ToArray(),
            trees.Where(t => t.State == "released").Select(t => t.Id).ToArray(),
            direct ? [.. blockers, .. trees.SelectMany(t => t.Leases.Select(l => "Activity lease " + l + ": the external process may still be running; its exit is not verified."))] : null);
    }
    private async Task<bool> HasDiscardReviewRequired(WorkspaceOwner owner, WorkspaceWorkflow workflow, CancellationToken ct)
    {
        var directory = System.IO.Path.Combine(DiscardRoot, "operations");
        if (!Directory.Exists(directory)) return false;
        foreach (var path in Directory.EnumerateFiles(directory, WorkspaceIdFor(owner) + "-*.json"))
        {
            RequireDiscardStorage(path);
            var journal = await JsonStorage.ReadAsync<WorkspaceDiscardJournal>(path, ct);
            if (journal?.State == "review-required" && journal.Owner?.SameIdentity(owner) == true
                && workflow.Operations?.LastOrDefault()?.Id == journal.Command.RequestId
                && workflow.Operations.Last().State == "rejected") return true;
        }
        return false;
    }
    private async Task CheckDiscardConsumers(DevelopmentWorkspace tree, HashSet<string> ownedResources, CancellationToken ct)
    {
        foreach (var app in await apps.ListAppRecordsAsync(ct))
            if (processes?.Conflict(app.Id) is not null)
                throw Error("consumer_unavailable", "A local process has unverified ownership. Resolve its recovery before removal.");
        await CheckConsumers(tree with { SandboxConsumers = tree.SandboxConsumers.Where(id => !ownedResources.Contains(id)).ToArray() }, ct);
    }
    private async Task<WorkspaceDiscardTree> InspectDiscardTree(DevelopmentWorkspace tree, CancellationToken ct, bool fingerprint = true)
    {
        await ValidateTree(tree, ct);
        var head = (await Git(tree.Path, ["rev-parse", "HEAD"], ct)).StandardOutput.Trim();
        var changed = new List<string>(); var untracked = new List<string>();
        var status = (await Git(tree.Path, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], ct)).StandardOutput.Split('\0');
        for (var index = 0; index < status.Length; index++)
        {
            var entry = status[index]; if (entry.Length < 4) continue;
            (entry.StartsWith("??", StringComparison.Ordinal) ? untracked : changed).Add(entry[3..]);
            if (entry[..2].Contains('R') || entry[..2].Contains('C')) { if (++index < status.Length && status[index].Length > 0) changed.Add(status[index]); }
        }
        var ignored = (await Git(tree.Path, ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"], ct)).StandardOutput.Split('\0', StringSplitOptions.RemoveEmptyEntries);
        if (changed.Count + untracked.Count + ignored.Length > 50_000) throw Error("review_truncated", "The removal review exceeds 50,000 changed paths or ignored-directory entries; source is preserved.");
        var target = "refs/hosty/targets/" + Hash(tree.TargetBranch);
        var count = (await Git(RepoPath(tree.RepositoryId), ["rev-list", "--count", target + ".." + head], ct)).StandardOutput.Trim();
        if (!int.TryParse(count, out var unmerged)) throw Error("unavailable", "The local target comparison is unavailable.");
        if (!fingerprint) return new(tree.Id, tree.Repository, tree.Path, tree.Branch, head, "observed",
            changed.Order(StringComparer.Ordinal).ToArray(), untracked.Order(StringComparer.Ordinal).ToArray(), ignored.Order(StringComparer.Ordinal).ToArray(), unmerged);
        // The index can contain staged bytes absent from both HEAD and the working directory.
        var indexPath = (await Git(tree.Path, ["rev-parse", "--path-format=absolute", "--git-path", "index"], ct)).StandardOutput.Trim();
        string indexDigest = "absent";
        if (!IsUnder(RepoPath(tree.RepositoryId), indexPath) || CoreDataPaths.ContainsSymbolicLink(RepoPath(tree.RepositoryId), indexPath))
            throw Error("ownership_invalid", "The Git index is outside its registered repository metadata.");
        if (File.Exists(indexPath))
        {
            await using var stream = new FileStream(indexPath, FileMode.Open, FileAccess.Read, FileShare.Read, 65536, FileOptions.Asynchronous);
            indexDigest = Convert.ToHexStringLower(await SHA256.HashDataAsync(stream, ct));
        }
        var sourceFingerprint = Hash(await DiscardFingerprint(tree.Path, ct) + "\n" + indexDigest);
        return new(tree.Id, tree.Repository, tree.Path, tree.Branch, head, sourceFingerprint,
            changed.Order(StringComparer.Ordinal).ToArray(), untracked.Order(StringComparer.Ordinal).ToArray(), ignored.Order(StringComparer.Ordinal).ToArray(), unmerged);
    }
    private static async Task<string> DiscardFingerprint(string root, CancellationToken ct)
    {
        using var digest = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        var count = 0;
        void Add(string value) => digest.AppendData(Encoding.UTF8.GetBytes(CoreJson.Text(value)));
        async Task Walk(string directory)
        {
            foreach (var entry in new DirectoryInfo(directory).EnumerateFileSystemInfos().OrderBy(e => e.Name, StringComparer.Ordinal))
            {
                ct.ThrowIfCancellationRequested();
                var relative = System.IO.Path.GetRelativePath(root, entry.FullName);
                if (directory == root && entry.Name == ".git") continue;
                if (++count > 1_000_000) throw Error("review_truncated", "The physical source review exceeds 1,000,000 entries; removal was refused.");
                Add(relative);
                if (entry.Name == ".git") throw Error("nested_repository", "Nested Git repositories require separate review and cannot be discarded by this action.");
                if (entry.LinkTarget is { } target) { Add("link"); Add(target); continue; } // Remove the link itself; never traverse its target.
                Add(((int)entry.Attributes).ToString(System.Globalization.CultureInfo.InvariantCulture));
                if (!OperatingSystem.IsWindows()) Add(((int)File.GetUnixFileMode(entry.FullName)).ToString(System.Globalization.CultureInfo.InvariantCulture));
                if (entry is DirectoryInfo) { Add("directory"); await Walk(entry.FullName); }
                else
                {
                    if (entry is not FileInfo info) throw Error("unavailable", "An unexpected source entry cannot be inspected.");
                    await AppSourceService.RequireRegularFileAsync(entry.FullName, ct);
                    await using var stream = new FileStream(entry.FullName, FileMode.Open, FileAccess.Read, FileShare.Read, 65536, FileOptions.Asynchronous | FileOptions.SequentialScan);
                    Add(Convert.ToHexStringLower(await SHA256.HashDataAsync(stream, ct)));
                    entry.Refresh();
                    if (entry.LinkTarget is not null) throw Error("source_changed", "A file changed into a link while preparing the review.");
                }
            }
        }
        await Walk(root);
        return Convert.ToHexStringLower(digest.GetHashAndReset());
    }

    internal async Task<WorkspaceDiscardJournal?> ReviewRequiredDiscardAsync(WorkspaceOwner owner, string actor, CancellationToken ct)
    {
        RequireDiscardActor(owner, actor);
        var operation = (await WorkflowAsync(owner, ct)).Operations?.LastOrDefault();
        if (operation is not { Kind: "discard", State: "rejected" }) return null;
        var journal = await ReadDiscardAsync(WorkspaceIdFor(owner), operation.Id, actor, ct);
        return journal?.State == "review-required" ? journal : null;
    }

    internal Task<WorkspaceDiscardJournal> AdmitDiscardAsync(WorkspaceOwner owner, string actor, WorkspaceDiscardApply input,
        WorkspaceDiscardResource[] resources, CancellationToken ct, WorkspaceCleanupResource[]? acceptedCleanup = null)
        => Locked(Hash(OwnerIdentity(owner)), async () =>
        {
            RequireDiscardActor(owner, actor); RequestId(input.RequestId);
            if (input.ExpectedRevision < 0 || input.ExpectedRevision == long.MaxValue) throw Error("revision_invalid", "Use a valid workspace revision.");
            var prior = await ReadDiscardAsync(WorkspaceIdFor(owner), input.RequestId, actor, ct);
            if (prior is not null)
            {
                if (prior.Command != input) throw Error("request_conflict", "Recover removal with the original reviewed arguments.");
                if (prior.State == "pending") await EnsureDiscardFence(owner, prior, ct);
                return prior;
            }
            var review = await JsonStorage.ReadAsync<WorkspaceDiscardReview>(DiscardReviewPath(input.Digest), ct)
                ?? throw Error("discard_review_required", "Prepare a fresh removal review first.");
            if (review.Actor != actor || !review.Owner.SameIdentity(owner)) throw Error("forbidden", "The removal review belongs to another operator or workspace.");
            if (review.Plan.Digest != input.Digest || Hash(actor + "\n" + CoreJson.Text(owner) + "\n" + CoreJson.Text(review.Plan with { Digest = "" })) != input.Digest)
                throw Error("ownership_invalid", "The removal review digest is inconsistent.");
            if (review.Plan.ExpiresAt <= clock.UtcNow) throw Error("discard_review_expired", "The removal review expired. Prepare and confirm a fresh review.");
            if (input.ExpectedRevision != review.Plan.Revision || input.ConfirmationName != review.Plan.Name)
                throw Error("discard_confirmation_invalid", "Confirm the exact reviewed workspace name and revision.");
            var current = await BuildDiscardPlan(owner, resources, ct);
            if (current.Blockers.Length > 0) throw Error("discard_blocked", string.Join("\n", current.Blockers));
            if (current.Revision != review.Plan.Revision || current.Name != review.Plan.Name
                || CoreJson.Text(current.Trees) != CoreJson.Text(review.Plan.Trees) || CoreJson.Text(current.Resources) != CoreJson.Text(review.Plan.Resources))
                throw Error("discard_review_changed", "Source, resources or workspace state changed. Prepare and confirm a fresh review.");
            var snapshots = await DiscardTrees(owner, ct);
            if (acceptedCleanup?.Any(r => !resources.Any(p => p.Id == r.Id && p.Kind == r.Kind)) == true)
                throw Error("ownership_invalid", "A resumed resource request is outside the fresh removal scope.");
            var cleanup = resources.Select(r => acceptedCleanup?.SingleOrDefault(prior => prior.Id == r.Id && prior.Kind == r.Kind)
                ?? new WorkspaceCleanupResource(r.Id, r.Kind, Guid.NewGuid().ToString("D"), r.Revision)).ToArray();
            var preceding = await ReviewRequiredDiscardAsync(owner, actor, ct);
            var related = preceding is null ? [] : (preceding.RelatedRequests ?? []).Append(preceding.Command.RequestId).Distinct(StringComparer.Ordinal).ToArray();
            var reviewDigests = new HashSet<string>(preceding?.ReviewDigests ?? [], StringComparer.Ordinal) { input.Digest };
            var reviewsRoot = System.IO.Path.Combine(DiscardRoot, "reviews");
            if (Directory.Exists(reviewsRoot)) foreach (var path in Directory.EnumerateFiles(reviewsRoot, "*.json"))
            {
                RequireDiscardStorage(path);
                var recorded = await JsonStorage.ReadAsync<WorkspaceDiscardReview>(path, ct);
                if (recorded?.Actor == actor && recorded.Owner.SameIdentity(owner) && recorded.Plan.WorkspaceId == current.WorkspaceId)
                    reviewDigests.Add(System.IO.Path.GetFileNameWithoutExtension(path));
            }
            var journal = new WorkspaceDiscardJournal(actor, current.WorkspaceId, input, "pending", owner, review.Plan, snapshots,
                snapshots.Select(t => new WorkspaceDiscardItem(t.Id, t.State == "released" ? "removed" : "pending")).ToArray(), resources.Select(r => new WorkspaceDiscardItem(r.Id, "pending", r.Kind)).ToArray(), cleanup,
                RelatedRequests: related, ReviewDigests: reviewDigests.Order(StringComparer.Ordinal).ToArray());
            // Persist authority before any cleanup. The workflow fence then prevents all new managed source work.
            await SaveDiscardAsync(journal);
            await EnsureDiscardFence(owner, journal, ct);
            return journal;
        }, ct);

    private async Task EnsureDiscardFence(WorkspaceOwner owner, WorkspaceDiscardJournal journal, CancellationToken ct)
    {
        var workflow = await WorkflowAsync(owner, ct);
        var prior = workflow.Operations?.SingleOrDefault(o => o.Id == journal.Command.RequestId);
        if (prior is not null)
        {
            if ((prior.Kind != "discard" && !(journal.Direct && prior.Kind == "delete")) || !journal.Direct && prior.ExpectedRevision != journal.Command.ExpectedRevision || workflow.State is not ("deleting" or "deleted"))
                throw Error("ownership_invalid", "The accepted removal fence changed.");
            return;
        }
        if (!journal.Direct && (workflow.Revision != journal.Command.ExpectedRevision || workflow.Operations?.Any(o => o.State == "pending") == true
            || workflow.State == "deleted")) throw Error("discard_review_changed", "Workspace changed before its removal fence was recorded.");
        var heads = new Dictionary<string, string>(workflow.Heads ?? []);
        foreach (var tree in journal.Plan!.Trees) heads[tree.Id] = tree.Head!;
        await SaveWorkflow(owner, workflow with { State = "deleting", Closure = "closed", ChangedBy = journal.Actor, Heads = heads,
            Operations = [.. (workflow.Operations ?? []).Select(o => journal.Direct && o.State == "pending" ? o with { State = "rejected", Error = "Superseded by workspace deletion." } : o), new(journal.Command.RequestId, "discard", journal.Command.ExpectedRevision, "pending")] });
    }

    internal Task<WorkspaceDiscardJournal> RequireDiscardReviewAsync(WorkspaceOwner owner, WorkspaceDiscardJournal journal, string error)
        => Locked(Hash(OwnerIdentity(owner)), () => RequireDiscardReviewUnderOwnerLock(owner, journal, error), default);

    private async Task<WorkspaceDiscardJournal> RequireDiscardReviewUnderOwnerLock(WorkspaceOwner owner, WorkspaceDiscardJournal journal, string error)
    {
        foreach (var tree in await DiscardTrees(owner, default))
        {
            var id = "discard-" + journal.Command.RequestId;
            if (tree.Operations.Any(o => o.Id == id && o.State == "pending") && Directory.Exists(tree.Path))
                await Save(tree with { State = "active", Operations = tree.Operations.Select(o => o.Id == id ? o with { State = "failed", Error = error } : o).ToArray() });
        }
        var workflow = await WorkflowAsync(owner, default);
        await SaveWorkflow(owner, workflow with { Operations = (workflow.Operations ?? []).Select(o => o.Id == journal.Command.RequestId
            ? o with { State = "rejected", Error = error } : o).ToArray() });
        journal = journal with { State = "review-required", Error = error };
        await SaveDiscardAsync(journal);
        return journal;
    }

    internal Task ValidateDiscardSourcesAsync(WorkspaceOwner owner, WorkspaceDiscardJournal journal, CancellationToken ct)
        => Locked(Hash(OwnerIdentity(owner)), () => Locked("workspace-consumers", async () =>
        {
            if (journal.SourceRemoved || journal.Direct) return true;
            var snapshots = journal.Snapshots!;
            var current = await DiscardTrees(owner, ct);
            if (current.Length != snapshots.Length || current.Any(t => !snapshots.Any(s => s.Id == t.Id)))
                throw Error("ownership_invalid", "The accepted removal repository set changed.");
            var resources = journal.Resources.Select(r => r.Id).ToHashSet(StringComparer.Ordinal);
            foreach (var tree in current)
            {
                await CheckDiscardConsumers(tree, resources, ct);
                if (tree.Operations.Any(o => (o.State is "pending" or "unknown") && o.Id != "discard-" + journal.Command.RequestId))
                    throw Error("operation_pending", "An unrelated source operation blocks removal.");
                if (tree.State == "released") continue;
                var reviewed = journal.Plan!.Trees.Single(t => t.Id == tree.Id);
                if (Directory.Exists(tree.Path))
                {
                    var fresh = await InspectDiscardTree(tree, ct);
                    if (fresh.Head != reviewed.Head || fresh.Fingerprint != reviewed.Fingerprint)
                        throw Error("discard_review_changed", "Source changed after removal admission. Prepare a fresh review before any remaining cleanup.");
                }
                else if (tree.State != "releasing" || !tree.Operations.Any(o => o.Id == "discard-" + journal.Command.RequestId && o.BeforeHead == reviewed.Head))
                    throw Error("ownership_invalid", "A missing source directory has no accepted removal evidence.");
            }
            return true;
        }, ct), ct);

    private async Task MarkDiscardWorkflowDeleted(WorkspaceOwner owner, WorkspaceDiscardJournal journal, CancellationToken ct)
    {
        var workflow = await WorkflowAsync(owner, ct);
        if (workflow.State == "deleted") return;
        // The final deletion journal may already have removed workflow metadata on recovery.
        if (await ReadDeletionAsync(journal.WorkspaceId, ct) is not null || (await DiscardTrees(owner, ct)).Length == 0) return;
        await EnsureDiscardFence(owner, journal, ct);
        workflow = await WorkflowAsync(owner, ct);
        await SaveWorkflow(owner, workflow with { State = "deleted", Revision = workflow.Revision + 1,
            Operations = [.. (workflow.Operations ?? []).Where(o => o.Id != journal.Command.RequestId),
                new(journal.Command.RequestId, "discard", journal.Command.ExpectedRevision, "succeeded")] });
    }

    internal async Task<WorkspaceDiscardJournal> FinishDiscardAsync(WorkspaceOwner owner, string actor, WorkspaceDiscardApply input, CancellationToken ct)
    {
        RequireDiscardActor(owner, actor);
        var result = await Locked(Hash(OwnerIdentity(owner)), () => Locked("workspace-consumers", async () =>
        {
            var journal = await ReadDiscardAsync(WorkspaceIdFor(owner), input.RequestId, actor, ct) ?? throw Error("not_found", "Removal request not found.");
            if (journal.Command != input) throw Error("request_conflict", "Recover the original removal request.");
            if (journal.State != "pending") return journal;
            if (journal.Resources.Any(r => r.State != "removed")) throw Error("cleanup_pending", "Finish the reviewed test resources before removing source.");
            if (journal.SourceRemoved)
            {
                await MarkDiscardWorkflowDeleted(owner, journal, ct);
                return journal;
            }
            await EnsureDiscardFence(owner, journal, ct);
            var plan = journal.Plan!; var snapshots = journal.Snapshots!;
            var current = await DiscardTrees(owner, ct);
            if (current.Any(t => !snapshots.Any(s => s.Id == t.Id))) throw Error("ownership_invalid", "The workspace gained a repository after confirmation.");
            try
            {
                foreach (var snapshot in snapshots)
                {
                    var tree = await Read(snapshot.Id, null, ct);
                    if (!tree.Owner.SameIdentity(owner)) throw Error("forbidden", "The discard allocation owner changed.");
                    if (!journal.Direct) await CheckDiscardConsumers(tree, [], ct);
                    if (!journal.Direct && tree.Operations.Any(o => (o.State is "pending" or "unknown") && o.Id != "discard-" + input.RequestId))
                        throw Error("operation_pending", "An unrelated source operation blocks removal.");
                    if (tree.State == "released") continue;
                    var reviewed = plan.Trees.Single(t => t.Id == tree.Id);
                    if (Directory.Exists(tree.Path))
                    {
                        if (journal.Direct) await ValidateDeleteTreeAsync(tree, ct);
                        else await ValidateTree(tree, ct);
                        var fresh = journal.Direct ? null : await InspectDiscardTree(tree, ct);
                        if (fresh is not null && (fresh.Head != reviewed.Head || fresh.Fingerprint != reviewed.Fingerprint))
                            throw Error("discard_review_changed", "Source changed after removal admission. Prepare a fresh removal review; remaining files are preserved.");
                    }
                    else if (!journal.Direct && (tree.State != "releasing" || !tree.Operations.Any(o => o.Id == "discard-" + input.RequestId && o.BeforeHead == reviewed.Head)))
                        throw Error("ownership_invalid", "A missing directory does not prove removal by this operation.");
                }
                foreach (var snapshot in snapshots)
                {
                    var tree = await Read(snapshot.Id, null, ct);
                    if (!tree.Owner.SameIdentity(owner)) throw Error("forbidden", "The discard allocation owner changed.");
                    if (tree.State != "released")
                    {
                        var reviewed = plan.Trees.Single(t => t.Id == tree.Id);
                        if (!journal.Direct) await CheckDiscardConsumers(tree, [], ct);
                        var operation = new WorkspaceOperation("discard-" + input.RequestId, "discard", input.Digest, "pending", reviewed.Head);
                        tree = tree with { State = "releasing", Operations = [.. tree.Operations.Where(o => o.Id != operation.Id)
                            .Select(o => journal.Direct && o.State is ("pending" or "unknown") ? o with { State = "failed", Error = "Canceled by workspace deletion." } : o), operation] };
                        await Save(tree);
                        if (Directory.Exists(tree.Path))
                        {
                            if (journal.Direct) await ValidateDeleteTreeAsync(snapshot, ct);
                            else await ValidateTree(tree, ct);
                            var fresh = journal.Direct ? null : await InspectDiscardTree(tree, ct);
                            if (fresh is not null && (fresh.Head != reviewed.Head || fresh.Fingerprint != reviewed.Fingerprint)) throw Error("discard_review_changed", "Source changed before physical removal. Prepare a fresh removal review.");
                            if (journal.Direct) Directory.Delete(tree.Path, recursive: true);
                            else await Git(RepoPath(tree.RepositoryId), ["worktree", "remove", "--force", "--force", tree.Path], ct);
                        }
                        else if (PathEntryExists(tree.Path)) throw Error("ownership_invalid", "The source path was replaced with a link or unexpected entry.");
                        if (journal.Direct)
                        {
                            var registrations = await Git(RepoPath(tree.RepositoryId), ["worktree", "list", "--porcelain"], ct);
                            if (registrations.StandardOutput.Split('\n').Contains("worktree " + tree.Path))
                                await Git(RepoPath(tree.RepositoryId), ["worktree", "remove", "--force", "--force", tree.Path], ct);
                        }
                        var reference = "refs/heads/" + tree.Branch;
                        var symbolic = await Git(RepoPath(tree.RepositoryId), ["symbolic-ref", "--quiet", reference], ct, true);
                        if (symbolic.ExitCode != 1) throw Error("ownership_invalid", "The private workspace branch was replaced or cannot be verified; it was preserved.");
                        var branch = await Git(RepoPath(tree.RepositoryId), ["show-ref", "--verify", reference], ct, true);
                        if (branch.ExitCode == 0)
                        {
                            var head = branch.StandardOutput.Split(' ')[0];
                            if (!journal.Direct && head != reviewed.Head) throw Error("stale_head", "The workspace branch changed and was preserved.");
                            var registrations = await Git(RepoPath(tree.RepositoryId), ["worktree", "list", "--porcelain"], ct);
                            if (registrations.StandardOutput.Split('\n').Any(line => line == "worktree " + tree.Path || line == "branch " + reference))
                                throw Error("in_use", "The workspace still has a Git registration.");
                            await Git(RepoPath(tree.RepositoryId), ["update-ref", "--no-deref", "-d", reference, head], ct);
                        }
                        else if (branch.ExitCode != 1) throw Error("unavailable", "The workspace branch could not be inspected.");
                        await Save(Put(tree with { State = "released", Observation = null, Leases = journal.Direct ? [] : tree.Leases,
                            LeaseClaims = journal.Direct ? [] : tree.LeaseClaims,
                            SandboxConsumers = journal.Direct ? [] : tree.SandboxConsumers }, operation with { State = "succeeded" }));
                    }
                    journal = journal with { Trees = journal.Trees.Select(t => t.Id == tree.Id ? t with { State = "removed" } : t).ToArray(), Error = null };
                    await SaveDiscardAsync(journal);
                }
                // Persist complete released snapshots before the normal deletion workflow can
                // trigger startup metadata recovery. Either side of this boundary is replayable.
                journal = journal with { SourceRemoved = true, Snapshots = await DiscardTrees(owner, ct) };
                await SaveDiscardAsync(journal);
                await MarkDiscardWorkflowDeleted(owner, journal, ct);
                return journal;
            }
            catch (AppLifecycleException ex) when (ex.Code == "workspace_discard_review_changed")
            {
                await RequireDiscardReviewUnderOwnerLock(owner, journal, ex.Message);
                throw;
            }
            catch (Exception ex) when (ex is AppLifecycleException or IOException or OperationCanceledException)
            {
                await SaveDiscardAsync(journal with { Error = ex.Message });
                throw;
            }
        }, ct), ct);
        if (result.State != "pending") return result;
        var deletion = await ReadDeletionAsync(result.WorkspaceId, ct);
        if (deletion is not null || (await DiscardTrees(owner, ct)).Length > 0)
            await FinalizeDeletionAsync(owner, ct, result.Direct);
        else
        {
            // A crash after the last metadata unlink still retains the accepted receipt.
            await RequireAbsentAsync(result.WorkspaceId, ct);
            foreach (var tree in result.Snapshots!)
            {
                if (tree.State != "released" || PathEntryExists(tree.Path)) throw Error("cleanup_pending", "Source absence cannot be verified.");
                if (!result.Direct) await CheckDiscardConsumers(tree, [], ct);
                var branch = await Git(RepoPath(tree.RepositoryId), ["show-ref", "--verify", "--quiet", "refs/heads/" + tree.Branch], ct, true);
                if (branch.ExitCode != 1) throw Error("cleanup_pending", "The private branch is present or cannot be verified.");
                var registrations = await Git(RepoPath(tree.RepositoryId), ["worktree", "list", "--porcelain"], ct);
                if (registrations.StandardOutput.Split('\n').Any(line => line == "worktree " + tree.Path || line == "branch refs/heads/" + tree.Branch))
                    throw Error("cleanup_pending", "A Git worktree registration remains.");
            }
        }
        // The minimal success receipt is the last durable write, after review metadata has
        // also been removed. An unlink failure remains pending and discoverable for recovery.
        await CompactDiscardMetadataAsync(result.WorkspaceId, actor, input.RequestId, ct);
        return (await ReadDiscardAsync(result.WorkspaceId, input.RequestId, actor, ct))!;
    }
    internal async Task CompactDiscardMetadataAsync(string workspaceId, string actor, string requestId, CancellationToken ct)
    {
        var completed = await ReadDiscardAsync(workspaceId, requestId, actor, ct)
            ?? throw Error("not_found", "Removal receipt not found.");
        if (completed.State != "removed")
        {
            if (!completed.SourceRemoved || completed.Trees.Any(t => t.State != "removed") || completed.Resources.Any(r => r.State != "removed"))
                throw Error("cleanup_pending", "Physical removal is not verified.");
            await RequireAbsentAsync(workspaceId, ct);
        }
        // Capture this operation's exact metadata scope at admission. A later allocation can
        // reuse a task/workspace ID; replay must never rewrite that new generation's records.
        foreach (var digest in (completed.ReviewDigests ?? []).Concat(completed.Direct ? [] : new[] { completed.Command.Digest }).Distinct(StringComparer.Ordinal))
        {
            var path = DiscardReviewPath(digest);
            var review = await JsonStorage.ReadAsync<WorkspaceDiscardReview>(path, ct);
            if (review is not null && (review.Actor != completed.Actor || review.Plan.WorkspaceId != workspaceId))
                throw Error("ownership_invalid", "The captured removal review belongs to another workspace.");
            DeleteMetadata(path);
        }
        foreach (var id in (completed.RelatedRequests ?? []).Append(requestId).Distinct(StringComparer.Ordinal))
        {
            var journal = await ReadDiscardAsync(workspaceId, id, actor, ct);
            if (journal is null) continue;
            if (id != requestId && journal.State == "pending")
                throw Error("ownership_invalid", "A superseded removal request is unexpectedly active; metadata was preserved.");
            // Keep only actor-bound replay evidence, never source inventories or private grants.
            await SaveDiscardAsync(journal with { State = "removed", Owner = null, Plan = null, Snapshots = null, Cleanup = [], Error = null,
                Activity = journal.Activity?.Select(a => a.Kind == "lease" ? a with { State = "retired", Detail = "Lease retired by deletion; external process exit remains unknown." } : a).ToArray(),
                Trees = journal.Trees.Select(t => t with { State = "removed" }).ToArray(), Resources = journal.Resources.Select(r => r with { State = "removed" }).ToArray() });
        }
    }
}

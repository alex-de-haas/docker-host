namespace Haas.Hosty.Core;

internal sealed record WorkspaceWorkflowCommand(string RequestId, long ExpectedRevision);
internal sealed record WorkspaceWorkflowOperation(string Id, string Kind, long ExpectedRevision, string State, string? Error = null);
internal sealed record WorkspaceWorkflow(string State = "in-progress", long Revision = 0,
    DateTimeOffset? CompletedAt = null, string? ChangedBy = null, Dictionary<string, string>? Heads = null,
    WorkspaceWorkflowOperation[]? Operations = null, string? Closure = null, DateTimeOffset? UpdatedAt = null);

internal sealed partial class DevelopmentWorkspaceService
{
    internal Task<T> WithIdleSourceAsync<T>(WorkspaceOwner owner, Func<Task<T>> action, CancellationToken ct)
        => Locked(Hash(OwnerIdentity(owner)), async () =>
        {
            var trees = new List<DevelopmentWorkspace>();
            if (Directory.Exists(Records)) foreach (var file in Directory.EnumerateFiles(Records, "*.json"))
            {
                var tree = await Read(System.IO.Path.GetFileNameWithoutExtension(file), null, ct);
                if (tree.Owner.SameIdentity(owner)) trees.Add(tree);
            }
            if (trees.Any(w => w.Leases.Length > 0 || w.Operations.Any(o => o.State is "pending" or "unknown")))
                throw Error("busy", "Stop active source work and recover pending or unknown Git operations before checking or restarting this preview.");
            var workflow = await WorkflowAsync(owner, ct);
            if (workflow.Closure is not null || workflow.State is "deferred" or "deleting" or "deleted" || await HasPendingDiscardAsync(owner, ct))
                throw Error("workflow_closed", "Recover workspace closure before running preview actions.");
            return await action();
        }, ct);

    // Serialize context-only resource allocation with workspace deletion as well as source mounts.
    // Independent QA without a matching workspace keeps the existing sandbox contract.
    internal async Task<T> WithResourceContextAsync<T>(SandboxActor actor, SandboxContext? context,
        Func<Task<T>> action, CancellationToken ct, bool cleanup = false)
    {
        var associated = actor.AppId is not null && actor.Installation is not null && context?.SessionId is not null
            ? await SessionParticipationAsync(new(actor.AppId, actor.Installation.Value, actor.UserId, context.SessionId), ct) : null;
        var tree = (await ListAsync(null, true, ct)).Workspaces.FirstOrDefault(w =>
            context?.WorkspaceId == w.WorkspaceId || associated?.Id == w.WorkspaceId ||
            w.Owner.UserId == actor.UserId && !w.Owner.IsExternal && context?.SessionId == w.Owner.SessionId
                && actor.AppId == w.Owner.AppId && actor.Installation == w.Owner.Installation);
        if (tree is null && context?.WorkspaceId is null) return await action();
        var workspaceId = tree?.WorkspaceId ?? context!.WorkspaceId!;
        Id(workspaceId);
        return await Locked("workspace-resources-" + workspaceId, async () =>
        {
            if (!cleanup)
            {
                if (tree is null) throw Error("not_found", "Workspace no longer exists.");
                if (!await RequireParticipationSourceAsync(tree, actor.UserId, ct))
                {
                    if (tree.Owner.UserId != actor.UserId) throw Error("forbidden", "The workspace owner must share its source first.");
                    await Read(tree.Id, tree.Owner, ct);
                }
            }
            var workflow = tree is null ? new WorkspaceWorkflow() : await WorkflowAsync(tree.Owner, ct);
            if (!cleanup && (workflow.Closure is not null || workflow.State is "deferred" or "deleting" or "deleted"
                || tree is not null && await HasPendingDiscardAsync(tree.Owner, ct)))
                throw Error("workflow_closed", "This workspace is closing, closed or being deleted. Resume retained source before creating new previews.");
            return await action();
        }, ct);
    }
    internal Task<WorkspaceWorkflow> SessionWorkflowAsync(WorkspaceOwner actor, CancellationToken ct)
        => Locked("workspace-participation", async () =>
        {
            // Detaching the creator removes its conversation's workflow association, but does
            // not change the retained allocation owner or grant access to its former source.
            if (await SessionDetachedAsync(actor, ct)) return new WorkspaceWorkflow();
            return await WorkflowAsync(await SessionResourceOwnerAsync(actor, ct), ct);
        }, ct);

    private string WorkflowPath(WorkspaceOwner owner) => System.IO.Path.Combine(Root, "workflows", Hash(OwnerIdentity(owner)) + ".json");
    internal async Task<WorkspaceWorkflow> WorkflowAsync(WorkspaceOwner owner, CancellationToken ct)
        => await JsonStorage.ReadAsync<WorkspaceWorkflow>(WorkflowPath(owner), ct) ?? new();
    private async Task SaveWorkflow(WorkspaceOwner owner, WorkspaceWorkflow value)
    {
        var previous = await WorkflowAsync(owner, default);
        var changed = CoreJson.Text(previous with { UpdatedAt = null }) != CoreJson.Text(value with { UpdatedAt = null });
        await JsonStorage.WriteAsync(WorkflowPath(owner), value with { UpdatedAt = changed ? clock.UtcNow : previous.UpdatedAt }, restrictToOwner: true);
        if (changed) observationState?.CatalogChanged();
    }
    private async Task RequireOpenWorkflow(WorkspaceOwner owner, CancellationToken ct)
    {
        var workflow = await WorkflowAsync(owner, ct);
        if (await ReadDeletionAsync(WorkspaceIdFor(owner), ct) is not null || workflow.State != "in-progress" || workflow.Closure is not null
            || await HasPendingDiscardAsync(owner, ct))
            throw Error("workflow_closed", "Resume the workspace before starting source work.");
    }
    internal static bool IsPauseAction(string kind) => kind is "pause" or "close" or "defer";
    internal static bool IsBackgroundActive(WorkspaceWorkflow state)
        => state.State == "in-progress" && state.Closure is null;

    // Metadata only: explicit observation and lifecycle verification do not use this filter.
    internal async Task<bool> CanObserveInBackgroundAsync(string id, CancellationToken ct)
    {
        if (!await CanObservePublicationAsync(id, ct)) return false;
        var tree = await Read(id, null, ct);
        return IsBackgroundActive(await WorkflowAsync(tree.Owner, ct));
    }

    internal Task<WorkspaceWorkflow> ChangeWorkflowAsync(WorkspaceOwner owner, string actor,
        string kind, WorkspaceWorkflowCommand input, IReadOnlyDictionary<string, string> mergedHeads, CancellationToken ct, bool prepareOnly = false)
        // Resource allocation takes this gate before the source-owner gate when attaching a
        // consumer. Close uses the same order so already-admitted previews finish before fencing.
        => IsPauseAction(kind)
            ? Locked("workspace-resources-" + Hash("workspace\n" + OwnerIdentity(owner)),
                () => ChangeWorkflowUnderOwnerLockAsync(owner, actor, kind, input, mergedHeads, ct, prepareOnly), ct)
            : ChangeWorkflowUnderOwnerLockAsync(owner, actor, kind, input, mergedHeads, ct, prepareOnly);

    private async Task<WorkspaceWorkflow> ChangeWorkflowUnderOwnerLockAsync(WorkspaceOwner owner, string actor,
        string kind, WorkspaceWorkflowCommand input, IReadOnlyDictionary<string, string> mergedHeads, CancellationToken ct, bool prepareOnly)
        => await Locked(Hash(OwnerIdentity(owner)), async () =>
        {
            RequestId(input.RequestId);
            if (kind is not ("complete" or "resume" or "pause" or "defer" or "delete" or "close")) throw Error("operation_invalid", "Unknown workspace workflow action.");
            var state = await WorkflowAsync(owner, ct);
            var prior = state.Operations?.FirstOrDefault(o => o.Id == input.RequestId);
            if (prior is not null)
            {
                if (prior.Kind != kind || prior.ExpectedRevision != input.ExpectedRevision) throw Error("request_conflict", "Reuse the original workspace action and revision.");
                if (prior.State == "succeeded") return state;
            }
            else if (state.Operations?.Any(o => o.State == "pending") == true)
                throw Error("operation_pending", "Recover the pending workspace action with its original requestId and revision.");
            else if (state.Revision != input.ExpectedRevision) throw Error("revision_conflict", "Workspace changed. Refresh before choosing an action.");
            if (await HasPendingDiscardAsync(owner, ct))
                throw Error("operation_pending", "Recover the accepted discard with its original removal request before changing workspace state.");
            if (state.State == "deleted" || state.State == "deleting" && kind != "delete")
                throw Error("workflow_closed", "Source cleanup has started. Recover deletion or start a new workspace.");
            var all = new List<DevelopmentWorkspace>();
            if (Directory.Exists(Records)) foreach (var file in Directory.EnumerateFiles(Records, "*.json"))
            {
                var tree = await Read(System.IO.Path.GetFileNameWithoutExtension(file), null, ct);
                if (tree.Owner.SameIdentity(owner)) all.Add(tree);
            }
            var trees = all.ToArray();
            if (trees.Length == 0) throw Error("not_found", "There is no workspace to complete.");
            if (IsPauseAction(kind)) return await CloseWorkflow(owner, actor, kind, input, state, trees, prepareOnly, ct);
            if (trees.Any(w => w.Operations.Any(o => o.State is "pending" or "unknown" && o.Kind != "cleanup")))
                throw Error("operation_pending", "Resolve outstanding source operations before changing workspace state.");
            if (trees.Any(w => w.Leases.Length > 0)) throw Error("in_use", "An agent still holds an activity lease. Stop it and verify its exit first.");
            if (kind == "resume")
            {
                if (trees.Any(w => w.State != "active")) throw Error("released", "Released source requires a new workspace.");
                foreach (var tree in trees)
                {
                    // Resume permits unfinished/conflicted work, but never trusts a cached
                    // observation or silently reopens missing/replaced source.
                    await ValidateTree(tree, ct);
                    await Fetch(RepoPath(tree.RepositoryId), tree.Repository, tree.TargetBranch, ct, await WorkspaceGrantAsync(tree, ct));
                    if ((await Observe(tree, ct)).Observation?.State != "ok")
                        throw Error("unavailable", "The full workspace status could not be read. Source remains paused.");
                }
                state = state with { State = "in-progress", CompletedAt = null, Heads = null, Closure = null };
            }
            else
            {
                if (kind == "delete" && state.State is not ("completed" or "deleting"))
                    throw Error("not_completed", "Complete this workspace before deleting it. Unfinished work is preserved.");
                var heads = new Dictionary<string, string>(StringComparer.Ordinal);
                foreach (var original in trees)
                {
                    if (original.State == "released")
                    {
                        var releasedHead = state.Heads?.GetValueOrDefault(original.Id)
                            ?? original.Operations.LastOrDefault(o => o.Kind == "cleanup" && o.State == "succeeded")?.BeforeHead;
                        if (releasedHead is null) throw Error("completion_unknown", "Released source has no recoverable head evidence.");
                        var releasedTarget = await Fetch(RepoPath(original.RepositoryId), original.Repository, original.TargetBranch, ct, await WorkspaceGrantAsync(original, ct));
                        if ((await Git(RepoPath(original.RepositoryId), ["merge-base", "--is-ancestor", releasedHead, releasedTarget], ct, true)).ExitCode != 0 && mergedHeads.GetValueOrDefault(original.Id) != releasedHead)
                            throw Error("unmerged", "Released source is not verified as merged.");
                        heads[original.Id] = releasedHead;
                        continue;
                    }
                    if (kind == "delete" && original.State == "releasing" && !Directory.Exists(original.Path)
                        && state.Heads?.GetValueOrDefault(original.Id) is { } recoveringHead
                        && original.Operations.Any(o => o.Id == "workflow-" + input.RequestId && o.BeforeHead == recoveringHead))
                    {
                        heads[original.Id] = recoveringHead;
                        continue; // FinishCleanup verifies the remaining branch and registration.
                    }
                    var w = await Observe(original, ct);
                    if (w.Observation is not { State: "ok", Head: { } head, Conflict: false, Local: { Files.Count: 0, Truncated: false } })
                        throw Error("dirty", "Commit or resolve every repository's changes before completing or deleting the workspace.");
                    var target = await Fetch(RepoPath(w.RepositoryId), w.Repository, w.TargetBranch, ct, await WorkspaceGrantAsync(w, ct));
                    if ((await Git(w.Path, ["merge-base", "--is-ancestor", head, target], ct, true)).ExitCode != 0 && mergedHeads.GetValueOrDefault(w.Id) != head)
                        throw Error("unmerged", "Current commits are not merged in " + w.Repository + ".");
                    if (kind == "delete" && state.Heads?.GetValueOrDefault(w.Id) != head)
                        throw Error("stale_head", "Source changed since completion. Review it before cleanup.");
                    heads[w.Id] = head;
                }
                if (kind == "complete") state = state with { State = "completed", CompletedAt = clock.UtcNow, Heads = heads };
                else
                {
                    // Persist intent before releasing the first worktree. Each release has its own
                    // recovery journal; a crash cannot silently reopen a partly removed workspace.
                    state = state with { State = "deleting", Heads = heads };
                    var op = new WorkspaceWorkflowOperation(input.RequestId, kind, input.ExpectedRevision, "pending");
                    state = state with { Operations = [.. (state.Operations ?? []).Where(o => o.Id != op.Id), op] };
                    await SaveWorkflow(owner, state);
                    if (prepareOnly) return state;
                    try
                    {
                        foreach (var original in trees)
                        {
                            var w = await Read(original.Id, null, ct);
                            if (w.State == "released") continue;
                            await CheckConsumers(w, ct);
                            var releaseId = "workflow-" + input.RequestId;
                            var release = w.Operations.FirstOrDefault(o => o.Id == releaseId)
                                ?? new WorkspaceOperation(releaseId, "cleanup", input.RequestId, "pending", heads[w.Id]);
                            w = w with { State = "releasing", Operations = [.. w.Operations.Where(o => o.Id != releaseId), release] };
                            await Save(w);
                            await FinishCleanup(w, release, ct, published: mergedHeads.GetValueOrDefault(w.Id) == heads[w.Id]);
                        }
                        state = state with { State = "deleted" };
                    }
                    catch (Exception ex) when (ex is AppLifecycleException or IOException or OperationCanceledException)
                    {
                        await SaveWorkflow(owner, state with { Operations = [.. state.Operations!.Where(o => o.Id != op.Id), op with { Error = ex.Message }] });
                        throw;
                    }
                }
            }
            state = state with { Revision = state.Revision + 1, ChangedBy = actor,
                Operations = [.. (state.Operations ?? []).Where(o => o.Id != input.RequestId), new(input.RequestId, kind, input.ExpectedRevision, "succeeded")] };
            await SaveWorkflow(owner, state);
            return state;
        }, ct);
}

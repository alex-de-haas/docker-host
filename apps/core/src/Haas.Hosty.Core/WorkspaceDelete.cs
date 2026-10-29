using Haas.Hosty.Launch;

namespace Haas.Hosty.Core;

internal sealed record WorkspaceDeleteCommand(string RequestId);
internal sealed record WorkspaceDeleteActivity(string Kind, string Reference, string State, string? Detail = null);
internal sealed record WorkspaceDeleteBatchCommand(string RequestId, string[]? WorkspaceIds = null, bool All = false);
internal sealed record WorkspaceDeleteTarget(string WorkspaceId, string RequestId, string State = "pending", string? Error = null, string[]? Allocations = null);
internal sealed record WorkspaceDeleteBatch(string Actor, WorkspaceDeleteBatchCommand Command, WorkspaceDeleteTarget[] Targets);

internal sealed partial class DevelopmentWorkspaceService
{
    private Task ValidateDeleteTreeAsync(DevelopmentWorkspace tree, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        if (!Directory.Exists(tree.Path) || MountPathPolicy.ResolveRealPath(tree.Path) != Path.GetFullPath(tree.Path)
            || CoreDataPaths.ContainsSymbolicLink(Root, RepoPath(tree.RepositoryId)))
            throw Error("ownership_invalid", "The registered workspace or repository path was replaced with a link.");
        // Read has verified the immutable allocation and exact Core-owned path. Deletion does
        // not require a working Git checkout: detached HEAD, missing .git and nested repositories
        // are source contents to remove, not additional user approvals.
        return Task.CompletedTask;
    }

    internal Task<WorkspaceDiscardPlan> DeleteDetailsAsync(WorkspaceOwner owner, WorkspaceDiscardResource[] resources, CancellationToken ct)
        => Locked(Hash(OwnerIdentity(owner)), () => BuildDiscardPlan(owner, resources, ct, direct: true), ct);

    internal Task<WorkspaceDiscardJournal> AdmitDeleteAsync(WorkspaceOwner owner, string actor, string requestId,
        WorkspaceDiscardResource[] resources, CancellationToken ct, string[]? expectedAllocations = null)
        => Locked(Hash(OwnerIdentity(owner)), async () =>
        {
            RequestId(requestId);
            await RequireWorkspaceUserAsync(actor, ct);
            var id = WorkspaceIdFor(owner);
            var prior = await ReadDiscardAsync(id, requestId, actor, ct);
            if (prior is not null)
            {
                if (prior.State == "pending") await EnsureDiscardFence(owner, prior, ct);
                return prior;
            }
            var pending = (await PendingDiscardJournalsAsync(actor, ct)).FirstOrDefault(j => j.WorkspaceId == id);
            if (pending is not null) return pending;
            var trees = await DiscardTrees(owner, ct);
            if (expectedAllocations is not null && !trees.Select(WorkspaceCleanupService.DeleteAllocation)
                .Order(StringComparer.Ordinal).SequenceEqual(expectedAllocations))
                throw Error("allocation_changed", "The original workspace allocation was replaced; the replacement is preserved.");
            if (trees.Length == 0) throw Error("not_found", "Workspace not found.");
            var workflow = await WorkflowAsync(owner, ct);
            // Admission records identities, not a human review of mutable source bytes. Inspection
            // is optional and cannot veto deletion when Git status or an external writer is unknown.
            var plan = new WorkspaceDiscardPlan(id, trees[0].Name ?? "Workspace", workflow.Revision,
                Hash(id + "\n" + requestId), DateTimeOffset.MaxValue,
                trees.Select(t => new WorkspaceDiscardTree(t.Id, t.Repository, t.Path, t.Branch,
                    t.Observation?.Head, "", [], [], [], 0)).ToArray(), resources, []);
            var command = new WorkspaceDiscardApply(requestId, workflow.Revision, plan.Digest, plan.Name);
            var journal = new WorkspaceDiscardJournal(actor, id, command, "pending", owner, plan, trees,
                trees.Select(t => new WorkspaceDiscardItem(t.Id, t.State == "released" ? "removed" : "pending")).ToArray(),
                resources.Select(r => new WorkspaceDiscardItem(r.Id, "pending", r.Kind)).ToArray(),
                resources.Select(r => new WorkspaceCleanupResource(r.Id, r.Kind, Guid.NewGuid().ToString("D"), r.Revision)).ToArray(),
                Direct: true, Activity: trees.SelectMany(t => t.Leases.Select(l =>
                    new WorkspaceDeleteActivity("lease", l, "retained", "External process exit is unknown. The lease is retired when source is removed."))).ToArray());
            await SaveDiscardAsync(journal);
            await EnsureDiscardFence(owner, journal, ct);
            foreach (var tree in trees)
                await Save(tree with { Operations = tree.Operations.Select(o => o.State is "pending" or "unknown"
                    ? o with { State = "failed", Error = "Canceled by workspace deletion " + requestId + "." } : o).ToArray() });
            return journal;
        }, ct);
}

internal sealed partial class WorkspaceCleanupService
{
    private async Task RequireDeleteAuthorityAsync(string userId, string? caller, CancellationToken ct)
    {
        if (caller is not null) await RequirePermission(caller, CoreAppPermissions.Sources, ct);
        await workspaces.RequireWorkspaceUserAsync(userId, ct);
    }

    private async Task<WorkspaceDiscardResource[]> DeleteResourcesAsync(string workspaceId, WorkspaceOwner owner, CancellationToken ct)
    {
        var resources = new List<WorkspaceDiscardResource>();
        foreach (var child in (await environments.ListAsync(ct)).Where(e => Belongs(e.Owner, e.Request.Context, owner, workspaceId)))
            if (child.State != "finished" || DevelopmentWorkspaceService.PathEntryExists(environments.Root(child.Id)))
                resources.Add(new(child.Id, "core", child.Request.Label, environments.Root(child.Id), child.State, child.Revision));
        return resources.OrderBy(r => r.Kind).ThenBy(r => r.Id).ToArray();
    }

    public async Task<WorkspaceDiscardPlan> DeleteDetailsAsync(string workspaceId, string userId, string? caller, CancellationToken ct)
    {
        await RequireDeleteAuthorityAsync(userId, caller, ct);
        var owner = await inspection.WorkflowOwnerAsync(workspaceId, userId, ct);
        var plan = await workspaces.DeleteDetailsAsync(owner, await DeleteResourcesAsync(workspaceId, owner, ct), ct);
        var warnings = (plan.Warnings ?? []).ToList();
        foreach (var tree in (await workspaces.ListAsync(null, true, ct)).Workspaces.Where(t => t.WorkspaceId == workspaceId))
            foreach (var app in await workspaces.DevConsumerAppsAsync(tree, ct))
                warnings.Add("Managed runtime " + app + " uses this source. Deletion requests its shutdown; the result is reported separately.");
        return plan with { Blockers = [], Warnings = warnings.ToArray() };
    }

    public async Task<WorkspaceDiscardProgress> DeleteStatusAsync(string workspaceId, string userId, string? caller, string requestId, CancellationToken ct)
    {
        await RequireDeleteAuthorityAsync(userId, caller, ct);
        var journal = await workspaces.ReadDiscardAsync(workspaceId, requestId, userId, ct)
            ?? throw DevelopmentWorkspaceService.Error("not_found", "Deletion request not found.");
        return journal.Progress();
    }

    public Task<WorkspaceDiscardProgress> ApplyDeleteAsync(string workspaceId, string userId, string? caller, WorkspaceDeleteCommand input, CancellationToken ct,
        string[]? expectedAllocations = null)
        => workspaces.WithResourceContextAsync(new(userId), new(WorkspaceId: workspaceId),
            () => ApplyDeleteUnderResourceLockAsync(workspaceId, userId, caller, input, ct, expectedAllocations), ct, cleanup: true);

    private async Task<WorkspaceDiscardProgress> ApplyDeleteUnderResourceLockAsync(string workspaceId, string userId, string? caller,
        WorkspaceDeleteCommand input, CancellationToken ct, string[]? expectedAllocations)
    {
        await RequireDeleteAuthorityAsync(userId, caller, ct);
        var gate = gates.GetOrAdd(workspaceId, _ => new(1, 1)); await gate.WaitAsync(ct);
        try
        {
            var journal = await workspaces.ReadDiscardAsync(workspaceId, input.RequestId, userId, ct);
            if (journal?.State == "removed") return journal.Progress();
            if (journal is null)
            {
                var owner = await inspection.WorkflowOwnerAsync(workspaceId, userId, ct);
                journal = await workspaces.AdmitDeleteAsync(owner, userId, input.RequestId,
                    await DeleteResourcesAsync(workspaceId, owner, ct), ct, expectedAllocations);
            }
            if (!journal.Direct)
            {
                // Legacy accepted requests retain their target set and child request IDs. Delete
                // upgrades their execution semantics without requiring a second review ceremony.
                journal = journal with { Direct = true, State = "pending", Error = null };
                await workspaces.SaveDiscardAsync(journal);
            }
            var removalOwner = journal.Owner!;
            try
            {
                journal = await workspaces.AdmitDeleteAsync(removalOwner, userId, journal.Command.RequestId, [], ct);
                foreach (var entry in journal.Cleanup.ToArray())
                {
                    var resource = entry;
                    var revision = resource.Revision;
                    var recorded = false;
                    if (resource.Kind == "core")
                    {
                        var record = await environments.ReadAsync(resource.Id, ct);
                        if (record is null || !Belongs(record.Owner, record.Request.Context, removalOwner, workspaceId))
                            throw DevelopmentWorkspaceService.Error("consumer_unavailable", "The accepted child Core cannot be identified.");
                        recorded = record.Operations?.Any(o => o.Id == CoreEnvironmentService.RequestId(resource.RequestId)) == true;
                        if (!recorded && record.Revision != resource.Revision)
                        {
                            revision = record.Revision;
                            resource = resource with { Revision = revision };
                            journal = journal with { Cleanup = journal.Cleanup.Select(r => r.Id == resource.Id && r.Kind == resource.Kind ? resource : r).ToArray() };
                            await workspaces.SaveDiscardAsync(journal);
                        }
                        var result = record.State == "finished" ? null : await environmentService.CommandAsync(new(userId) { DeletingWorkspace = workspaceId, DeletingOwner = removalOwner }, resource.Id,
                            "finish", new(resource.RequestId, revision), ct);
                        if (result is not null && result.State != "finished") throw DevelopmentWorkspaceService.Error("cleanup_pending", "Child Core shutdown remains pending.");
                        if (DevelopmentWorkspaceService.PathEntryExists(environments.Root(resource.Id))) throw DevelopmentWorkspaceService.Error("cleanup_pending", "Child Core data removal remains pending.");
                    }
                    else throw DevelopmentWorkspaceService.Error("ownership_invalid", "Unknown accepted resource kind.");
                    journal = journal with { Resources = journal.Resources.Select(r => r.Id == resource.Id && r.Kind == resource.Kind ? r with { State = "removed" } : r).ToArray() };
                    await workspaces.SaveDiscardAsync(journal);
                }
                journal = await StopDeleteConsumersAsync(journal, userId, ct);
                await RequireFinishedResourcesAsync(workspaceId, removalOwner, ct);
                var finished = await workspaces.FinishDiscardAsync(removalOwner, userId, journal.Command, ct);
                return finished.Progress();
            }
            catch (Exception ex) when (ex is AppLifecycleException or SandboxException or IOException or HttpRequestException or UnauthorizedAccessException or OperationCanceledException)
            {
                journal = await workspaces.ReadDiscardAsync(workspaceId, journal.Command.RequestId, userId, default) ?? journal;
                journal = journal with { Error = ex.Message };
                await workspaces.SaveDiscardAsync(journal);
                return journal.Progress();
            }
        }
        finally { gate.Release(); }
    }

    private async Task<WorkspaceDiscardJournal> StopDeleteConsumersAsync(WorkspaceDiscardJournal journal, string userId, CancellationToken ct)
    {
        var activity = (journal.Activity ?? []).ToList();
        foreach (var tree in journal.Snapshots ?? [])
        {
            var consumers = await inspection.ConsumersAsync(tree, await apps.ListAppRecordsAsync(ct), ct);
            foreach (var appId in consumers.Select(c => c.Reference.Split('/')[0]).Distinct(StringComparer.Ordinal))
            {
                if (activity.Any(a => a.Kind == "runtime" && a.Reference == appId && a.State == "stopped")) continue;
                if (appId == "hosty:core" || lifecycle is null || (await apps.GetAppAsync(appId, ct)) is null)
                {
                    activity.RemoveAll(a => a.Kind == "runtime" && a.Reference == appId);
                    activity.Add(new("runtime", appId, "unknown", "Source removal does not establish that this runtime stopped."));
                    continue;
                }
                var status = await lifecycle.GetDevModeAsync(appId, ct);
                if (status.WorktreeId == tree.Id && status.Phase != "inactive")
                {
                    var actor = new AppDevActor(userId, "workspace-delete", WorkspaceOwner.ForExternal(userId, "workspace-delete", journal.Command.RequestId, "Workspace deletion"));
                    var request = new AppDevRequest(WorkspaceRuntimeFiles.ChildId(journal.Command.RequestId, appId), "return", AcceptDataChanges: true);
                    var plan = await lifecycle.PlanDevModeAsync(appId, request, actor, ct);
                    await lifecycle.ApplyDevModeAsync(appId, request with { PlanDigest = plan.PlanDigest }, actor, ct);
                    var returned = await lifecycle.GetDevModeAsync(appId, ct);
                    if (returned.WorktreeId == tree.Id && returned.Phase is not ("inactive" or "returned"))
                        throw DevelopmentWorkspaceService.Error("cleanup_pending", "Managed runtime return remains pending: " + appId);
                }
                else await lifecycle.StopAsync(appId, ct);
                activity.RemoveAll(a => a.Kind == "runtime" && a.Reference == appId);
                activity.Add(new("runtime", appId, "stopped", "The source consumer was stopped through its lifecycle owner."));
                journal = journal with { Activity = activity.ToArray() };
                await workspaces.SaveDiscardAsync(journal);
            }
        }
        journal = journal with { Activity = activity.ToArray() };
        await workspaces.SaveDiscardAsync(journal);
        return journal;
    }

    internal static string DeleteAllocation(DevelopmentWorkspace tree)
        => tree.Id + ":" + tree.Operations.FirstOrDefault(o => o.Kind == "prepare")?.Id;

    public async Task<WorkspaceDeleteBatch> DeleteBatchAsync(string userId, string? caller, WorkspaceDeleteBatchCommand command, CancellationToken ct)
    {
        await RequireDeleteAuthorityAsync(userId, caller, ct);
        if (!Guid.TryParseExact(command.RequestId, "D", out _) || command.All == (command.WorkspaceIds is { Length: > 0 }))
            throw DevelopmentWorkspaceService.Error("request_invalid", "Supply a UUID requestId and either workspaceIds or all.");
        foreach (var id in command.WorkspaceIds ?? []) DevelopmentWorkspaceService.Id(id);
        var path = Path.Combine(paths.CoreRoot, "development", "delete-batches", command.RequestId + ".json");
        if (CoreDataPaths.ContainsSymbolicLink(paths.CoreRoot, path))
            throw DevelopmentWorkspaceService.Error("ownership_invalid", "Deletion receipt storage contains a symbolic link.");
        var gate = gates.GetOrAdd("delete-batch:" + command.RequestId, _ => new(1, 1)); await gate.WaitAsync(ct);
        try
        {
            var batch = await JsonStorage.ReadAsync<WorkspaceDeleteBatch>(path, ct);
            if (batch is not null && CoreJson.Text(batch.Command) != CoreJson.Text(command))
                throw DevelopmentWorkspaceService.Error("request_conflict", "Reuse the accepted batch command and requestId.");
            if (batch is null)
            {
                var trees = (await workspaces.ListAsync(null, true, ct)).Workspaces;
                var ids = command.All ? trees.Select(t => t.WorkspaceId) : command.WorkspaceIds!;
                batch = new(userId, command, ids.Distinct(StringComparer.Ordinal).Order(StringComparer.Ordinal)
                    .Select(id => new WorkspaceDeleteTarget(id, Guid.NewGuid().ToString("D"), Allocations: trees.Where(t => t.WorkspaceId == id)
                        .Select(DeleteAllocation).Order(StringComparer.Ordinal).ToArray())).ToArray());
                await JsonStorage.WriteAsync(path, batch, restrictToOwner: true);
            }
            foreach (var target in batch.Targets.Where(t => t.State != "removed").ToArray())
            {
                WorkspaceDeleteTarget result;
                try
                {
                    if (await workspaces.ReadDiscardAsync(target.WorkspaceId, target.RequestId, userId, ct) is null)
                    {
                        var current = (await workspaces.ListAsync(null, true, ct)).Workspaces.Where(t => t.WorkspaceId == target.WorkspaceId)
                            .Select(DeleteAllocation).Order(StringComparer.Ordinal).ToArray();
                        if (current.Length == 0)
                        {
                            batch = batch with { Targets = batch.Targets.Select(t => t.WorkspaceId == target.WorkspaceId ? t with { State = "removed", Error = null } : t).ToArray() };
                            await JsonStorage.WriteAsync(path, batch, restrictToOwner: true);
                            continue;
                        }
                        else if (target.Allocations is null || !current.SequenceEqual(target.Allocations))
                            throw DevelopmentWorkspaceService.Error("allocation_changed", "The original workspace allocation was replaced; the replacement is preserved.");
                    }
                    var progress = await ApplyDeleteAsync(target.WorkspaceId, userId, caller, new(target.RequestId), ct, target.Allocations ?? []);
                    result = target with { RequestId = progress.RequestId, State = progress.State, Error = progress.Error };
                }
                catch (Exception ex) when (ex is AppLifecycleException or IOException or SandboxException)
                { result = target with { Error = ex.Message }; }
                batch = batch with { Targets = batch.Targets.Select(t => t.WorkspaceId == target.WorkspaceId ? result : t).ToArray() };
                await JsonStorage.WriteAsync(path, batch, restrictToOwner: true);
            }
            return batch;
        }
        finally { gate.Release(); }
    }
}

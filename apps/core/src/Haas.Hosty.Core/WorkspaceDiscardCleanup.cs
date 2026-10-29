namespace Haas.Hosty.Core;

internal sealed partial class WorkspaceInspectionService
{
    internal async Task RequireDiscardAccessAsync(WorkspaceDiscardJournal journal, string userId, CancellationToken ct)
    {
        await workspaces.RequireWorkspaceUserAsync(userId, ct);
        if (journal.State == "removed") return;
        var installed = await apps.ListAppRecordsAsync(ct);
        foreach (var tree in journal.Snapshots ?? [])
        {
            await RequireSourceAsync(tree, userId, installed, ct);
        }
    }
}

internal sealed partial class WorkspaceCleanupService
{
    private async Task<WorkspaceDiscardResource[]> DiscardResourcesAsync(string workspaceId, WorkspaceOwner owner, string caller, CancellationToken ct)
    {
        var resources = new List<WorkspaceDiscardResource>();
        foreach (var child in (await environments.ListAsync(ct)).Where(e => Belongs(e.Owner, e.Request.Context, owner, workspaceId)))
            if (child.State != "finished" || DevelopmentWorkspaceService.PathEntryExists(environments.Root(child.Id)))
                resources.Add(new(child.Id, "core", child.Request.Label, environments.Root(child.Id), child.State, child.Revision));
        foreach (var instance in (await sandboxes.ListAsync(ct)).Where(s => Belongs(s.Owner, s.Request.Context, owner, workspaceId)))
            if (instance.State != "disposed" || DevelopmentWorkspaceService.PathEntryExists(sandboxes.DataRoot(instance.Id)))
                resources.Add(new(instance.Id, "sandbox", instance.Request.AppId + " · " + instance.Id, sandboxes.DataRoot(instance.Id), instance.State, instance.Revision));
        if (resources.Any(r => r.Kind == "core"))
        {
            await RequirePermission(caller, CoreAppPermissions.CoreEnvironmentsRead, ct);
            await RequirePermission(caller, CoreAppPermissions.CoreEnvironmentsManage, ct);
        }
        if (resources.Any(r => r.Kind == "sandbox"))
        {
            await RequirePermission(caller, CoreAppPermissions.SandboxesRead, ct);
            await RequirePermission(caller, CoreAppPermissions.SandboxesManage, ct);
        }
        return resources.OrderBy(r => r.Kind, StringComparer.Ordinal).ThenBy(r => r.Id, StringComparer.Ordinal).ToArray();
    }

    public Task<WorkspaceDiscardPlan> PrepareDiscardAsync(string workspaceId, string userId, string caller, CancellationToken ct)
        => workspaces.WithResourceContextAsync(new(userId), new(WorkspaceId: workspaceId), async () =>
        {
            await RequirePermission(caller, CoreAppPermissions.Sources, ct);
            var owner = await inspection.WorkflowOwnerAsync(workspaceId, userId, ct);
            return await workspaces.PrepareDiscardAsync(owner, userId, await DiscardResourcesAsync(workspaceId, owner, caller, ct), ct);
        }, ct, cleanup: true);

    public async Task<WorkspaceDiscardProgress> DiscardStatusAsync(string workspaceId, string userId, string caller, string requestId, CancellationToken ct)
    {
        await RequirePermission(caller, CoreAppPermissions.Sources, ct);
        var journal = await workspaces.ReadDiscardAsync(workspaceId, requestId, userId, ct)
            ?? throw DevelopmentWorkspaceService.Error("not_found", "Removal request not found.");
        await inspection.RequireDiscardAccessAsync(journal, userId, ct);
        return journal.Progress();
    }

    public Task<WorkspaceDiscardProgress> ApplyDiscardAsync(string workspaceId, string userId, string caller, WorkspaceDiscardApply input, CancellationToken ct)
        => workspaces.WithResourceContextAsync(new(userId), new(WorkspaceId: workspaceId),
            () => ApplyDiscardUnderResourceLockAsync(workspaceId, userId, caller, input, ct), ct, cleanup: true);

    private async Task<WorkspaceDiscardProgress> ApplyDiscardUnderResourceLockAsync(string workspaceId, string userId, string caller, WorkspaceDiscardApply input, CancellationToken ct)
    {
        await RequirePermission(caller, CoreAppPermissions.Sources, ct);
        var gate = gates.GetOrAdd(workspaceId, _ => new(1, 1)); await gate.WaitAsync(ct);
        try
        {
            var journal = await workspaces.ReadDiscardAsync(workspaceId, input.RequestId, userId, ct);
            if (journal is not null)
            {
                if (journal.Command != input) throw DevelopmentWorkspaceService.Error("request_conflict", "Recover with the original reviewed removal command.");
                await inspection.RequireDiscardAccessAsync(journal, userId, ct);
                if (journal.State != "pending")
                {
                    if (journal.State == "removed") await workspaces.CompactDiscardMetadataAsync(workspaceId, userId, input.RequestId, ct);
                    return journal.Progress();
                }
            }
            else
            {
                var owner = await inspection.WorkflowOwnerAsync(workspaceId, userId, ct);
                var resources = await DiscardResourcesAsync(workspaceId, owner, caller, ct);
                var retained = new List<WorkspaceCleanupResource>();
                var previous = await workspaces.ReviewRequiredDiscardAsync(owner, userId, ct);
                foreach (var resource in previous?.Cleanup ?? [])
                {
                    if (!resources.Any(r => r.Id == resource.Id && r.Kind == resource.Kind)) continue;
                    if (resource.Kind == "core")
                    {
                        var record = await environments.ReadAsync(resource.Id, ct);
                        if (record is not null && Belongs(record.Owner, record.Request.Context, owner, workspaceId)
                            && record.Operations?.Any(o => o.Id == CoreEnvironmentService.RequestId(resource.RequestId) && o.Kind == "finish") == true)
                            retained.Add(resource);
                    }
                    else if (resource.Kind == "sandbox")
                    {
                        var record = await sandboxService.ReadAsync(new(userId), resource.Id, ct);
                        if (Belongs(record.Owner, record.Context, owner, workspaceId)
                            && record.Operations.Any(o => o.Id == resource.RequestId && o.Kind == "dispose")) retained.Add(resource);
                    }
                }
                // A new source confirmation does not replace already accepted resource requests.
                // Requests never admitted by their resource owner use the newly reviewed revision.
                journal = await workspaces.AdmitDiscardAsync(owner, userId, input, resources, ct, retained.ToArray());
            }
            var removalOwner = journal.Owner!;
            try
            {
                // Replay repairs a crash between durable admission and the workflow fence.
                journal = await workspaces.AdmitDiscardAsync(removalOwner, userId, input, [], ct);
                var current = await DiscardResourcesAsync(workspaceId, removalOwner, caller, ct);
                if (current.Any(r => !journal.Resources.Any(prior => prior.Id == r.Id && prior.Kind == r.Kind)))
                    throw DevelopmentWorkspaceService.Error("discard_review_changed", "A new resource appeared after review. Existing source and unreviewed data were preserved.");
                // Validate the entire remaining data scope before the first resource command.
                // An unrelated resource revision is never silently folded into accepted consent.
                foreach (var resource in journal.Cleanup)
                {
                    if (resource.Kind == "core")
                    {
                        var record = await environments.ReadAsync(resource.Id, ct);
                        if (record is null || !Belongs(record.Owner, record.Request.Context, removalOwner, workspaceId))
                            throw DevelopmentWorkspaceService.Error("consumer_unavailable", "The reviewed child Core owner cannot be verified.");
                        if (record.State != "finished" && record.Revision != resource.Revision
                            && record.Operations?.Any(o => o.Id == CoreEnvironmentService.RequestId(resource.RequestId)) != true)
                            throw DevelopmentWorkspaceService.Error("discard_review_changed", "A child Core changed after review. Prepare a fresh removal review.");
                    }
                    else if (resource.Kind == "sandbox")
                    {
                        var record = await sandboxService.ReadAsync(new(userId), resource.Id, ct);
                        if (!Belongs(record.Owner, record.Context, removalOwner, workspaceId))
                            throw DevelopmentWorkspaceService.Error("forbidden", "The reviewed sandbox owner changed.");
                        if (record.State != "disposed" && record.Revision != resource.Revision && !record.Operations.Any(o => o.Id == resource.RequestId))
                            throw DevelopmentWorkspaceService.Error("discard_review_changed", "A sandbox changed after review. Prepare a fresh removal review.");
                    }
                    else throw DevelopmentWorkspaceService.Error("ownership_invalid", "The cleanup journal contains an unknown resource kind.");
                }
                await workspaces.ValidateDiscardSourcesAsync(removalOwner, journal, ct);
                foreach (var resource in journal.Cleanup)
                {
                    if (resource.Kind == "core")
                    {
                        await RequirePermission(caller, CoreAppPermissions.CoreEnvironmentsManage, ct);
                        var record = await environments.ReadAsync(resource.Id, ct);
                        if (record is null || !Belongs(record.Owner, record.Request.Context, removalOwner, workspaceId))
                            throw DevelopmentWorkspaceService.Error("consumer_unavailable", "The reviewed child Core owner cannot be verified.");
                        if (record.State != "finished")
                        {
                            var accepted = record.Operations?.Any(o => o.Id == CoreEnvironmentService.RequestId(resource.RequestId)) == true;
                            if (!accepted && record.Revision != resource.Revision)
                                throw DevelopmentWorkspaceService.Error("discard_review_changed", "The child Core changed after review. Prepare a fresh removal review.");
                            var result = await environmentService.CommandAsync(new(userId), resource.Id, "finish", new(resource.RequestId, resource.Revision), ct);
                            if (result.State != "finished") throw DevelopmentWorkspaceService.Error("cleanup_pending", "Child Core cleanup remains pending.");
                        }
                        if (DevelopmentWorkspaceService.PathEntryExists(environments.Root(resource.Id)))
                            throw DevelopmentWorkspaceService.Error("cleanup_pending", "Child Core data removal cannot be verified.");
                    }
                    else if (resource.Kind == "sandbox")
                    {
                        await RequirePermission(caller, CoreAppPermissions.SandboxesManage, ct);
                        var record = await sandboxService.ReadAsync(new(userId), resource.Id, ct);
                        if (!Belongs(record.Owner, record.Context, removalOwner, workspaceId))
                            throw DevelopmentWorkspaceService.Error("forbidden", "The reviewed sandbox owner changed.");
                        if (record.State != "disposed")
                        {
                            var accepted = record.Operations.Any(o => o.Id == resource.RequestId);
                            if (!accepted && record.Revision != resource.Revision)
                                throw DevelopmentWorkspaceService.Error("discard_review_changed", "The sandbox changed after review. Prepare a fresh removal review.");
                            var result = await sandboxOperations.CommandAsync(new(userId), resource.Id, "dispose", new(resource.RequestId, resource.Revision), ct);
                            if (result.State != "disposed") throw DevelopmentWorkspaceService.Error("cleanup_pending", "Sandbox cleanup remains pending.");
                        }
                        if (DevelopmentWorkspaceService.PathEntryExists(sandboxes.DataRoot(resource.Id)))
                            throw DevelopmentWorkspaceService.Error("cleanup_pending", "Sandbox data removal cannot be verified.");
                    }
                    else throw DevelopmentWorkspaceService.Error("ownership_invalid", "The cleanup journal contains an unknown resource kind.");
                    journal = journal with { Resources = journal.Resources.Select(r => r.Id == resource.Id && r.Kind == resource.Kind ? r with { State = "removed" } : r).ToArray(), Error = null };
                    await workspaces.SaveDiscardAsync(journal);
                }
                await RequireFinishedResourcesAsync(workspaceId, removalOwner, ct);
                return (await workspaces.FinishDiscardAsync(removalOwner, userId, input, ct)).Progress();
            }
            catch (Exception ex) when (ex is AppLifecycleException or SandboxException or IOException or HttpRequestException or UnauthorizedAccessException or OperationCanceledException)
            {
                journal = await workspaces.ReadDiscardAsync(workspaceId, input.RequestId, userId, default) ?? journal;
                if (ex is AppLifecycleException { Code: "workspace_discard_review_changed" } && journal.State == "pending")
                    journal = await workspaces.RequireDiscardReviewAsync(removalOwner, journal, ex.Message);
                else
                {
                    journal = journal with { Error = ex.Message };
                    await workspaces.SaveDiscardAsync(journal);
                }
                return journal.Progress();
            }
        }
        finally { gate.Release(); }
    }
}

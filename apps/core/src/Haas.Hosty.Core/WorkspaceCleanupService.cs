using System.Collections.Concurrent;

namespace Haas.Hosty.Core;

internal sealed record WorkspaceCleanupResource(string Id, string Kind, string RequestId, long Revision);
internal sealed record WorkspaceCleanupJob(string WorkspaceId, string UserId, WorkspaceWorkflowCommand Input,
    WorkspaceCleanupResource[] Resources);
internal sealed record WorkspacePreviews(CoreEnvironmentView[] Environments, SandboxView[] Instances, Dictionary<string, CoreEnvironmentApplications> Applications);

// Coordinates existing resource owners. It does not implement another container supervisor.
internal sealed class WorkspaceCleanupService(CoreDataPaths paths, WorkspaceInspectionService inspection,
    DevelopmentWorkspaceService workspaces, PublicationService publications, AppRegistryStore apps,
    CoreEnvironmentStore environments, CoreEnvironmentService environmentService, CoreEnvironmentAccess access,
    SandboxStore sandboxes, SandboxService sandboxService, SandboxOperations sandboxOperations)
{
    private readonly ConcurrentDictionary<string, SemaphoreSlim> gates = new(StringComparer.Ordinal);
    private static bool Belongs(SandboxActor actor, SandboxContext? context, WorkspaceOwner owner, string workspaceId)
        => actor.UserId == owner.UserId && (context?.WorkspaceId == workspaceId ||
            !owner.IsExternal && context?.SessionId == owner.SessionId && actor.AppId == owner.AppId && actor.Installation == owner.Installation);
    private async Task RequirePermission(string appId, string permission, CancellationToken ct)
    {
        var app = await apps.GetAppAsync(appId, ct);
        if (app is null || !AppManagementAuthorization.HasPermission(app, permission))
            throw new AppIdentityException("app_permission_required", "Workspace resources require the reviewed " + permission + " permission.");
    }
    public async Task<WorkspacePreviews> PreviewsAsync(string workspaceId, string userId, string appId, CancellationToken ct)
    {
        var owner = await inspection.WorkflowOwnerAsync(workspaceId, userId, ct);
        var children = (await environments.ListAsync(ct)).Where(e => Belongs(e.Owner, e.Request.Context, owner, workspaceId) && e.State != "finished").ToArray();
        var instances = (await sandboxes.ListAsync(ct)).Where(s => Belongs(s.Owner, s.Request.Context, owner, workspaceId)).ToArray();
        if (children.Length > 0) await RequirePermission(appId, CoreAppPermissions.CoreEnvironmentsRead, ct);
        if (instances.Length > 0) await RequirePermission(appId, CoreAppPermissions.SandboxesRead, ct);
        var applications = new Dictionary<string, CoreEnvironmentApplications>();
        foreach (var child in children.Where(e => e.State == "running"))
        {
            try { applications[child.Id] = await access.ApplicationsAsync(new(userId), child.Id, ct); }
            catch (Exception ex) when (ex is SandboxException or HttpRequestException or IOException)
            { applications[child.Id] = new("unavailable", [], "Application preview status is unavailable."); }
        }
        return new(await Task.WhenAll(children.Select(e => environmentService.ReadAsync(new(userId), e.Id, ct))), instances.Select(SandboxService.View).ToArray(), applications);
    }
    public Task<WorkspaceWorkflow> DeleteAsync(string workspaceId, string userId, string appId,
        WorkspaceWorkflowCommand input, CancellationToken ct)
        => workspaces.WithResourceContextAsync(new(userId), new(WorkspaceId: workspaceId),
            () => DeleteResourcesAsync(workspaceId, userId, appId, input, ct), ct, cleanup: true);
    private async Task<WorkspaceWorkflow> DeleteResourcesAsync(string workspaceId, string userId, string appId,
        WorkspaceWorkflowCommand input, CancellationToken ct)
    {
        if (!Guid.TryParseExact(input.RequestId, "D", out var request)) throw DevelopmentWorkspaceService.Error("request_invalid", "Use a UUID requestId.");
        var owner = await inspection.WorkflowOwnerAsync(workspaceId, userId, ct);
        var gate = gates.GetOrAdd(workspaceId, _ => new(1, 1)); await gate.WaitAsync(ct);
        try
        {
            var heads = await publications.MergedWorkspaceHeadsAsync(owner, ct);
            var state = await workspaces.ChangeWorkflowAsync(owner, userId, "delete", input, heads, ct, prepareOnly: true);
            if (state.State == "deleted") return state;
            var path = Path.Combine(paths.CoreRoot, "development", "cleanup", request.ToString("D") + ".json");
            var job = await JsonStorage.ReadAsync<WorkspaceCleanupJob>(path, ct);
            if (job is not null && (job.WorkspaceId != workspaceId || job.UserId != userId || job.Input != input))
                throw DevelopmentWorkspaceService.Error("request_conflict", "This cleanup request belongs to another workspace or revision.");
            job ??= new(workspaceId, userId, input, []);
            var children = (await environments.ListAsync(ct)).Where(e => Belongs(e.Owner, e.Request.Context, owner, workspaceId) && e.State != "finished").ToArray();
            var instances = (await sandboxes.ListAsync(ct)).Where(s => Belongs(s.Owner, s.Request.Context, owner, workspaceId)).ToArray();
            if (children.Length > 0) await RequirePermission(appId, CoreAppPermissions.CoreEnvironmentsManage, ct);
            if (instances.Length > 0) await RequirePermission(appId, CoreAppPermissions.SandboxesManage, ct);
            var resources = job.Resources.ToList();
            foreach (var child in children) if (!resources.Any(r => r.Kind == "core" && r.Id == child.Id))
                resources.Add(new(child.Id, "core", Guid.NewGuid().ToString("D"), child.Revision));
            foreach (var instance in instances) if (!resources.Any(r => r.Kind == "sandbox" && r.Id == instance.Id))
                resources.Add(new(instance.Id, "sandbox", Guid.NewGuid().ToString("D"), instance.Revision));
            job = job with { Resources = resources.ToArray() };
            await JsonStorage.WriteAsync(path, job, restrictToOwner: true);
            foreach (var resource in resources)
            {
                // Context alone never grants access to another operator's data. Recheck each owner
                // on recovery, then use the existing admin lifecycle path with its original UUID.
                if (resource.Kind == "core")
                {
                    var record = await environments.ReadAsync(resource.Id, ct);
                    if (record?.State == "finished") continue;
                    if (record is null || !Belongs(record.Owner, record.Request.Context, owner, workspaceId))
                        throw DevelopmentWorkspaceService.Error("consumer_unavailable", "Cannot verify the child Core owner.");
                    await RequirePermission(appId, CoreAppPermissions.CoreEnvironmentsManage, ct);
                    var result = await environmentService.CommandAsync(new(userId), resource.Id, "finish", new(resource.RequestId, resource.Revision), ct);
                    if (result.State != "finished") throw DevelopmentWorkspaceService.Error("cleanup_pending", "Child Core cleanup is not finished. Retry this workspace action.");
                }
                else
                {
                    var record = await sandboxService.ReadAsync(new(userId), resource.Id, ct);
                    if (record.State == "disposed") continue;
                    if (!Belongs(record.Owner, record.Context, owner, workspaceId)) throw DevelopmentWorkspaceService.Error("forbidden", "Sandbox ownership changed.");
                    await RequirePermission(appId, CoreAppPermissions.SandboxesManage, ct);
                    var result = await sandboxOperations.CommandAsync(new(userId), resource.Id, "dispose", new(resource.RequestId, resource.Revision), ct);
                    if (result.State != "disposed") throw DevelopmentWorkspaceService.Error("cleanup_pending", "Sandbox cleanup is pending. Retry this workspace action.");
                }
            }
            // Fresh verification still applies after slow shutdowns. Core preserves released
            // worktree receipts, so a partially successful cleanup can safely resume here.
            heads = await publications.MergedWorkspaceHeadsAsync(owner, ct);
            return await workspaces.ChangeWorkflowAsync(owner, userId, "delete", input, heads, ct);
        }
        finally { gate.Release(); }
    }
}

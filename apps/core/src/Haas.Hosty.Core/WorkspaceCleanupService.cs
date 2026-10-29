using System.Collections.Concurrent;

namespace Haas.Hosty.Core;

internal sealed record WorkspaceCleanupResource(string Id, string Kind, string RequestId, long Revision);
internal sealed record WorkspaceCleanupJob(string WorkspaceId, string UserId, WorkspaceWorkflowCommand Input,
    WorkspaceCleanupResource[] Resources);
internal sealed record WorkspacePreviews(CoreEnvironmentView[] Environments, Dictionary<string, CoreEnvironmentApplications> Applications);

// Coordinates existing resource owners. It does not implement another container supervisor.
internal sealed partial class WorkspaceCleanupService(CoreDataPaths paths, WorkspaceInspectionService inspection,
    DevelopmentWorkspaceService workspaces, PublicationService publications, AppRegistryStore apps,
    CoreEnvironmentStore environments, CoreEnvironmentService environmentService, CoreEnvironmentAccess access,
    CoreLifecycleService? lifecycle = null)
{
    private readonly ConcurrentDictionary<string, SemaphoreSlim> gates = new(StringComparer.Ordinal);
    internal static bool Belongs(SandboxActor actor, SandboxContext? context, WorkspaceOwner owner, string workspaceId)
        => context?.WorkspaceId == workspaceId ||
            actor.UserId == owner.UserId && (
            !owner.IsExternal && context?.SessionId == owner.SessionId && actor.AppId == owner.AppId && actor.Installation == owner.Installation);
    private async Task RequirePermission(string appId, string permission, CancellationToken ct)
    {
        var app = await apps.GetAppAsync(appId, ct);
        if (app is null || !AppManagementAuthorization.HasPermission(app, permission))
            throw new AppIdentityException("app_permission_required", "Workspace resources require the reviewed " + permission + " permission.");
    }
    public async Task<WorkspacePreviews> PreviewsAsync(string workspaceId, string userId, string appId, CancellationToken ct)
    {
        var owner = await inspection.ReadOwnerAsync(workspaceId, userId, ct);
        var children = (await environments.ListAsync(ct)).Where(e => Belongs(e.Owner, e.Request.Context, owner with { UserId = userId }, workspaceId) && e.State != "finished").ToArray();
        if (children.Length > 0) await RequirePermission(appId, CoreAppPermissions.CoreEnvironmentsRead, ct);
        var applications = new Dictionary<string, CoreEnvironmentApplications>();
        foreach (var child in children.Where(e => e.State == "running"))
        {
            try { applications[child.Id] = await access.ApplicationsAsync(new(userId), child.Id, ct); }
            catch (Exception ex) when (ex is SandboxException or HttpRequestException or IOException)
            { applications[child.Id] = new("unavailable", [], "Application preview status is unavailable."); }
        }
        return new(await Task.WhenAll(children.Select(e => environmentService.ReadAsync(new(userId), e.Id, ct))), applications);
    }
    public async Task<WorkspaceWorkflow> DeleteAsync(string workspaceId, string userId, string appId,
        WorkspaceWorkflowCommand input, CancellationToken ct)
    {
        var result = await ApplyDeleteAsync(workspaceId, userId, appId, new(input.RequestId), ct);
        return new(result.State == "removed" ? "deleted" : "deleting", input.ExpectedRevision + 1,
            ChangedBy: userId, Closure: "closed", Operations: [new(result.RequestId, "discard", input.ExpectedRevision,
                result.State == "removed" ? "succeeded" : "pending", result.Error)]);
    }

    public async Task<CoreEnvironmentApiResponse> PreviewActionAsync(string workspaceId, string userId, string caller,
        string environmentId, string targetApp, string action, PreviewCheckRun? input, CancellationToken ct)
    {
        var owner = await inspection.ReadOwnerAsync(workspaceId, userId, ct);
        var readOnly = action is "checks" or "logs";
        await RequirePermission(caller, readOnly ? CoreAppPermissions.CoreEnvironmentsRead : CoreAppPermissions.CoreEnvironmentsManage, ct);
        var child = await environments.ReadAsync(environmentId, ct);
        if (child is null || !Belongs(child.Owner, child.Request.Context, owner with { UserId = userId }, workspaceId))
            throw new SandboxException("environment_not_found", "This sandbox does not belong to the selected workspace.", 404);
        if (action is not ("checks" or "run" or "restart" or "logs")) throw new SandboxException("preview_action_invalid", "Unknown preview action.", 400);
        var path = "/api/apps/" + Uri.EscapeDataString(targetApp) + (action == "logs" ? "/logs?tail=80" : action == "restart" ? "/restart" : "/preview-checks" + (action == "run" ? "/run" : ""));
        System.Text.Json.JsonElement? body = action == "run" ? System.Text.Json.JsonSerializer.SerializeToElement(input ?? throw new SandboxException("preview_action_invalid", "Choose a reviewed recipe.", 400), CoreJsonSerializerContext.Default.PreviewCheckRun) : null;
        return await access.SendAsync(new(userId), environmentId, new(readOnly ? "GET" : "POST", path, body), ct,
            readOnly ? null : owner);
    }
    private async Task<WorkspaceWorkflow> DeleteResourcesAsync(string workspaceId, string userId, string appId,
        WorkspaceWorkflowCommand input, CancellationToken ct)
    {
        if (!Guid.TryParseExact(input.RequestId, "D", out var request)) throw DevelopmentWorkspaceService.Error("request_invalid", "Use a UUID requestId.");
        DevelopmentWorkspaceService.ValidateDelete(workspaceId, input);
        var gate = gates.GetOrAdd(workspaceId, _ => new(1, 1)); await gate.WaitAsync(ct);
        try
        {
            WorkspaceOwner? owner;
            try { owner = await inspection.WorkflowOwnerAsync(workspaceId, userId, ct); }
            catch (AppLifecycleException ex) when (ex.Code == "workspace_not_found")
            {
                owner = (await workspaces.ReadDeletionAsync(workspaceId, ct))?.Owner;
                if (owner is not null && owner.UserId != userId)
                    throw DevelopmentWorkspaceService.Error("forbidden", "Workspace deletion belongs to another user.");
            }
            if (owner is null)
            {
                await workspaces.RequireAbsentAsync(workspaceId, ct);
                await RequireFinishedResourcesAsync(workspaceId, null, ct);
                return DevelopmentWorkspaceService.DeletedResult(input);
            }
            if ((await workspaces.WorkflowAsync(owner, ct)).State == "deleted" || await workspaces.ReadDeletionAsync(workspaceId, ct) is not null)
            {
                await FinalizeAsync(owner, ct);
                return DevelopmentWorkspaceService.DeletedResult(input);
            }
            var heads = await publications.MergedWorkspaceHeadsAsync(owner, ct, userId);
            var state = await workspaces.ChangeWorkflowAsync(owner, userId, "delete", input, heads, ct, prepareOnly: true);
            if (state.State == "deleted") return state;
            var path = Path.Combine(paths.CoreRoot, "development", "cleanup", request.ToString("D") + ".json");
            var job = await JsonStorage.ReadAsync<WorkspaceCleanupJob>(path, ct);
            if (job is not null && (job.WorkspaceId != workspaceId || job.UserId != userId || job.Input != input))
                throw DevelopmentWorkspaceService.Error("request_conflict", "This cleanup request belongs to another workspace or revision.");
            job ??= new(workspaceId, userId, input, []);
            var children = (await environments.ListAsync(ct)).Where(e => Belongs(e.Owner, e.Request.Context, owner, workspaceId) && e.State != "finished").ToArray();
            if (children.Length > 0) await RequirePermission(appId, CoreAppPermissions.CoreEnvironmentsManage, ct);
            var resources = job.Resources.ToList();
            foreach (var child in children) if (!resources.Any(r => r.Kind == "core" && r.Id == child.Id))
                resources.Add(new(child.Id, "core", Guid.NewGuid().ToString("D"), child.Revision));
            job = job with { Resources = resources.ToArray() };
            await JsonStorage.WriteAsync(path, job, restrictToOwner: true);
            async Task<WorkspaceCleanupResource> RefreshUnaccepted(WorkspaceCleanupResource resource, long revision, bool recorded)
            {
                // Revision changes prove the old expected revision cannot be admitted. Replace only
                // an unjournaled request; accepted Finish always retains its replay identity.
                if (recorded || revision == resource.Revision) return resource;
                var fresh = resource with { RequestId = Guid.NewGuid().ToString("D"), Revision = revision };
                resources[resources.FindIndex(r => r.Kind == resource.Kind && r.Id == resource.Id)] = fresh;
                job = job with { Resources = resources.ToArray() };
                await JsonStorage.WriteAsync(path, job, restrictToOwner: true);
                return fresh;
            }
            foreach (var entry in resources.ToArray())
            {
                var resource = entry;
                // Context alone never grants access to another operator's data. Recheck each owner
                // on recovery, then use the existing admin lifecycle path with its original UUID.
                if (resource.Kind == "core")
                {
                    var record = await environments.ReadAsync(resource.Id, ct);
                    if (record?.State == "finished") continue;
                    if (record is null || !Belongs(record.Owner, record.Request.Context, owner, workspaceId))
                        throw DevelopmentWorkspaceService.Error("consumer_unavailable", "Cannot verify the child Core owner.");
                    await RequirePermission(appId, CoreAppPermissions.CoreEnvironmentsManage, ct);
                    resource = await RefreshUnaccepted(resource, record.Revision,
                        record.Operations?.Any(o => o.Id == CoreEnvironmentService.RequestId(resource.RequestId)) == true);
                    var result = await environmentService.CommandAsync(new(userId), resource.Id, "finish", new(resource.RequestId, resource.Revision), ct);
                    if (result.State != "finished") throw DevelopmentWorkspaceService.Error("cleanup_pending", "Child Core cleanup is not finished. Retry this workspace action.");
                }
                else throw DevelopmentWorkspaceService.Error("consumer_unavailable", "Unknown workspace resource kind.");
            }
            // Fresh verification still applies after slow shutdowns. Core preserves released
            // worktree receipts, so a partially successful cleanup can safely resume here.
            heads = await publications.MergedWorkspaceHeadsAsync(owner, ct, userId);
            state = await workspaces.ChangeWorkflowAsync(owner, userId, "delete", input, heads, ct);
            await FinalizeAsync(owner, ct);
            return state;
        }
        finally { gate.Release(); }
    }
}

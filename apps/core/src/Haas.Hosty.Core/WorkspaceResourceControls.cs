namespace Haas.Hosty.Core;

internal sealed partial class WorkspaceCleanupService
{
    public async Task<CoreEnvironmentView> EnvironmentCommandAsync(string workspaceId, string userId, string caller,
        string id, string action, CoreEnvironmentCommand input, CancellationToken ct)
    {
        if (action is not ("start" or "stop" or "finish"))
            throw new SandboxException("environment_operation_invalid", "Choose Start, Stop or Delete sandbox.", 400);
        var owner = await inspection.ReadOwnerAsync(workspaceId, userId, ct);
        await RequirePermission(caller, CoreAppPermissions.CoreEnvironmentsManage, ct);
        var child = await environments.ReadAsync(id, ct);
        if (child is null || !Belongs(child.Owner, child.Request.Context, owner with { UserId = userId }, workspaceId))
            throw new SandboxException("environment_not_found", "This sandbox does not belong to the selected workspace.", 404);
        var requestId = CoreEnvironmentService.RequestId(input.RequestId);
        // A terminal replay only observes its receipt. Fresh/retryable starts must pass admission.
        var replay = child.Operations?.Any(o => o.Id == requestId && o.State == "succeeded") == true;
        if (action == "start" && !replay) await RequirePermission(caller, CoreAppPermissions.Sources, ct);
        return await workspaces.WithResourceContextAsync(new(userId), new(WorkspaceId: workspaceId),
            () => environmentService.CommandAsync(new(userId), id, action, input, ct), ct,
            cleanup: action != "start" || replay);
    }

    public async Task<SandboxView> SandboxCommandAsync(string workspaceId, string userId, string caller,
        string id, string action, SandboxCommand input, CancellationToken ct)
    {
        if (action is not ("start" or "stop" or "dispose"))
            throw new SandboxException("sandbox_operation_invalid", "Choose Start, Stop or Delete sandbox.", 400);
        var owner = await inspection.ReadOwnerAsync(workspaceId, userId, ct);
        await RequirePermission(caller, CoreAppPermissions.SandboxesManage, ct);
        var instance = await sandboxService.ReadAsync(new(userId), id, ct);
        if (!Belongs(instance.Owner, instance.Context, owner with { UserId = userId }, workspaceId))
            throw new SandboxException("sandbox_not_found", "This sandbox does not belong to the selected workspace.", 404);
        var replay = instance.Operations.Any(o => o.Id == input.RequestId && o.State == "succeeded");
        if (action == "start" && !replay) await RequirePermission(caller, CoreAppPermissions.Sources, ct);
        return await workspaces.WithResourceContextAsync(new(userId), new(WorkspaceId: workspaceId),
            () => sandboxOperations.CommandAsync(new(userId), id, action, input, ct), ct,
            cleanup: action != "start" || replay);
    }
}

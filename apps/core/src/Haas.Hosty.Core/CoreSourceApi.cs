namespace Haas.Hosty.Core;

internal sealed record CanonicalWorkspacePrepare(string RequestId, string TaskId, string AppId, string LeaseId,
    string Name, string? TargetBranch = null, string? NavigationPath = null);
internal sealed record CoreWorkspaceQuery(string? TaskId = null, bool IncludeReleased = true);

// Allocation context is opaque client metadata. A chat, agent runner or first-party app is not
// required. Legacy session routes retain their filters; these routes address the Core collection.
internal static class CoreSourceApi
{
    private const string Root = "/api/workspaces/v1";
    internal static async Task<ExternalWorkspaceMcpCaller> Caller(HttpRequest request, CoreCapabilityAuthorization authorization, CancellationToken ct)
    {
        var caller = await authorization.RequireAsync(request, [AccessTokenScopes.McpRead, AccessTokenScopes.McpWorkspaces],
            [CoreAppPermissions.Sources], ct);
        return new(caller.User.Id, caller.PrincipalId, caller.App?.DisplayName ?? "Core workspace client", caller.App, caller.Authority);
    }
    internal static async Task<WorkspaceOwner> Actor(ExternalWorkspaceMcpCaller caller, string worktreeId,
        DevelopmentWorkspaceService workspaces, CancellationToken ct)
    {
        var tree = (await workspaces.ListAsync(null, true, ct)).Workspaces.FirstOrDefault(w => w.Id == worktreeId)
            ?? throw new AppLifecycleException("workspace_not_found", "No registered worktree has that ID.");
        return caller.Owner(tree.Owner.SessionId);
    }
    internal static void Map(WebApplication app)
    {
        app.MapPost(Root + "/prepare", async (CanonicalWorkspacePrepare input, HttpRequest request,
            CoreCapabilityAuthorization auth, DevelopmentWorkspaceService service, AuditStore audit, IClock clock, CancellationToken ct) =>
            await CoreWorkspaceEndpoints.Handle(async () =>
            {
                var caller = await Caller(request, auth, ct);
                DevelopmentWorkspaceService.ValidateWorkspaceName(input.Name);
                if (!Guid.TryParse(input.LeaseId, out _)) throw DevelopmentWorkspaceService.Error("lease_invalid", "An activity lease UUID is required.");
                var owner = caller.Owner(input.TaskId);
                var result = await service.PrepareAsync(owner, new(input.RequestId, input.TaskId, input.AppId, input.NavigationPath,
                    input.TargetBranch, input.LeaseId, Name: input.Name), ct);
                await ExternalWorkspaceMcpTools.AuditAsync(audit, clock, caller, result, input.RequestId, "prepare", "api");
                return await service.SessionProjectionAsync(result, owner, ct);
            }));
        app.MapPost(Root + "/query", async (CoreWorkspaceQuery input, HttpRequest request,
            CoreCapabilityAuthorization auth, DevelopmentWorkspaceService service, CancellationToken ct) =>
            await CoreWorkspaceEndpoints.Handle(async () =>
            {
                var caller = await Caller(request, auth, ct);
                var found = new List<DevelopmentWorkspace>();
                foreach (var tree in (await service.ListAsync(null, input.IncludeReleased, ct)).Workspaces.Where(w => input.TaskId is null || w.Owner.SessionId == input.TaskId))
                {
                    var actor = caller.Owner(tree.Owner.SessionId);
                    try { found.Add(await service.SessionProjectionAsync(await service.ObserveAsync(tree.Id, actor, ct), actor, ct)); }
                    catch (Exception ex) when (ex is AppLifecycleException or IOException or UnauthorizedAccessException) { }
                }
                return new WorkspaceList(found.ToArray(), new(true, true, caller.UserId, caller.PrincipalId));
            }));
        app.MapGet(Root + "/{worktreeId}", async (string worktreeId, HttpRequest request,
            CoreCapabilityAuthorization auth, DevelopmentWorkspaceService service, CancellationToken ct) =>
            await CoreWorkspaceEndpoints.Handle(async () =>
            {
                var actor = await Actor(await Caller(request, auth, ct), worktreeId, service, ct);
                return await service.SessionProjectionAsync(await service.ObserveAsync(worktreeId, actor, ct), actor, ct);
            }));
        app.MapPost(Root + "/{worktreeId}/diff", async (string worktreeId, WorkspaceDiffRequest input, HttpRequest request,
            CoreCapabilityAuthorization auth, DevelopmentWorkspaceService service, CancellationToken ct) =>
            await CoreWorkspaceEndpoints.Handle(async () => await service.DiffAsync(worktreeId,
                await Actor(await Caller(request, auth, ct), worktreeId, service, ct), input, ct)));
        app.MapPost(Root + "/{worktreeId}/commands/{kind}", async (string worktreeId, string kind, WorkspaceCommand input,
            HttpRequest request, CoreCapabilityAuthorization auth, DevelopmentWorkspaceService service, AuditStore audit, IClock clock, CancellationToken ct) =>
            await CoreWorkspaceEndpoints.Handle(async () =>
            {
                var caller = await Caller(request, auth, ct);
                if (kind is not ("refresh" or "commit" or "merge" or "merge-upstream" or "abort-merge" or "lease" or "release-lease" or "references"))
                    throw DevelopmentWorkspaceService.Error("command_invalid", "Use an explicitly supported source command.");
                var actor = await Actor(caller, worktreeId, service, ct);
                var result = await service.CommandAsync(worktreeId, actor, kind, input, ct);
                await ExternalWorkspaceMcpTools.AuditAsync(audit, clock, caller, result, input.RequestId, kind, "api");
                return await service.SessionProjectionAsync(result, actor, ct);
            }));
        app.MapPost(Root + "/{worktreeId}/commit-review", async (string worktreeId, WorkspaceCommitReviewRequest input,
            HttpRequest request, CoreCapabilityAuthorization auth, DevelopmentWorkspaceService service, CancellationToken ct) =>
            await CoreWorkspaceEndpoints.Handle(async () => await service.PrepareCommitReviewAsync(worktreeId,
                await Actor(await Caller(request, auth, ct), worktreeId, service, ct), input, ct)));
        app.MapGet(Root + "/{workspaceId}/participants", async (string workspaceId, HttpRequest request,
            CoreCapabilityAuthorization auth, DevelopmentWorkspaceService service, UserDirectoryStore users, AppRegistryStore apps, CancellationToken ct) =>
            await CoreWorkspaceEndpoints.Handle(async () =>
            {
                var caller = await Caller(request, auth, ct);
                return await WorkspaceParticipationEndpoints.Project(await service.ParticipationAsync(workspaceId, caller.UserId, ct),
                    caller.UserId, caller.App?.Id ?? "", users, apps, ct);
            }));
    }
}

namespace Haas.Hosty.Core;

internal static class WorkspaceNameEndpoints
{
    internal static void Map(WebApplication app)
    {
        const string session = "/api/internal/apps/{appId}/sessions/{sessionId}/workspaces/name";
        app.MapPost(session, (string appId, string sessionId, WorkspaceNameCommand input,
            HttpRequest request, WorkspaceAuthorization auth, DevelopmentWorkspaceService workspaces, CancellationToken ct)
            => Handle(async () => await workspaces.RenameAsync(await workspaces.SessionResourceOwnerAsync(await auth.RequireAsync(request, appId, sessionId, ct), ct, ownerOnly: true), input, ct)));
        const string inspected = "/api/internal/apps/{appId}/workspace-inspection/{workspaceId}/name";
        app.MapGet(inspected, (string appId, string workspaceId, HttpRequest request,
            WorkspaceInspectionAuthorization auth, WorkspaceInspectionService inspection, DevelopmentWorkspaceService workspaces, CancellationToken ct)
            => Handle(async () => await workspaces.MetadataAsync(await inspection.WorkflowOwnerAsync(workspaceId,
                await auth.RequireAsync(request, appId, ct), ct), ct)));
        app.MapPost(inspected, (string appId, string workspaceId, WorkspaceNameCommand input, HttpRequest request,
            WorkspaceInspectionAuthorization auth, WorkspaceInspectionService inspection, DevelopmentWorkspaceService workspaces, CancellationToken ct)
            => Handle(async () => await workspaces.RenameAsync(await inspection.WorkflowOwnerAsync(workspaceId,
                await auth.RequireAsync(request, appId, ct, manage: true), ct), input, ct)));
        const string browser = "/api/development/workspaces/{workspaceId}/name";
        app.MapGet(browser, (string workspaceId, HttpRequest request, UserDirectoryStore users, IClock clock,
            WorkspaceInspectionService inspection, DevelopmentWorkspaceService workspaces, CancellationToken ct)
            => CoreSessionAuthorization.RequireAdminSessionAsync(request, users, clock, () => Handle(async () =>
            {
                var actor = await CoreSessionAuthorization.TryResolveSessionAsync(request, users, clock, ct);
                return await workspaces.MetadataAsync(await inspection.WorkflowOwnerAsync(workspaceId, actor!.Id, ct), ct);
            }), cancellationToken: ct));
        app.MapPost(browser, (string workspaceId, WorkspaceNameCommand input, HttpRequest request, UserDirectoryStore users, IClock clock,
            WorkspaceInspectionService inspection, DevelopmentWorkspaceService workspaces, CancellationToken ct)
            => CoreSessionAuthorization.RequireAdminSessionAsync(request, users, clock, () => Handle(async () =>
            {
                var actor = await CoreSessionAuthorization.TryResolveSessionAsync(request, users, clock, ct);
                return await workspaces.RenameAsync(await inspection.WorkflowOwnerAsync(workspaceId, actor!.Id, ct), input, ct);
            }), requireCsrf: true, cancellationToken: ct));
    }

    private static async Task<IResult> Handle<T>(Func<Task<T>> action)
    {
        try { return CoreJson.Json(await action()); }
        catch (AppIdentityException ex) { return CoreJson.Json(new ErrorResponse(ex.Code, ex.Message), AuthEndpoints.MapIdentityErrorStatus(ex.Code)); }
        catch (AppLifecycleException ex)
        {
            var status = ex.Code.EndsWith("not_found", StringComparison.Ordinal) ? 404
                : ex.Code.EndsWith("forbidden", StringComparison.Ordinal) || ex.Code.Contains("access_denied", StringComparison.Ordinal) ? 403
                : ex.Code.EndsWith("invalid", StringComparison.Ordinal) ? 400 : 409;
            return CoreJson.Json(new ErrorResponse(ex.Code, ex.Message), status);
        }
    }
}

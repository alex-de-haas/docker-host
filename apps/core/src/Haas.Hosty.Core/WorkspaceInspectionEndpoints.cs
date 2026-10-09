namespace Haas.Hosty.Core;

internal sealed class WorkspaceInspectionAuthorization(AppServiceTokenService services, AppRegistryStore apps,
    AppIdentityService identity, UserDirectoryStore users)
{
    public async Task<string> RequireAsync(HttpRequest request, string appId, CancellationToken ct)
    {
        if (!services.ValidateToken(appId, CoreSessionAuthorization.ReadBearerToken(request) ?? ""))
            throw new AppIdentityException("token_invalid", "An app service token is required.");
        var app = await apps.GetAppAsync(appId, ct);
        if (app is null || !AppManagementAuthorization.HasPermission(app, CoreAppPermissions.WorkspacesRead))
            throw new AppIdentityException("app_permission_required", "The calling app requires apps.workspaces.read.");
        if (request.Cookies.ContainsKey(CoreSessionAuthorization.SessionCookieName))
            throw new AppIdentityException("app_credential_mixed", "Use this app's user credential without a Core cookie.");
        var token = request.Headers["X-Hosty-User-Token"].ToString();
        if (!token.StartsWith("hostyg_", StringComparison.Ordinal))
            throw new AppIdentityException("token_invalid", "An active app identity is required.");
        var userId = (await identity.RequireActivityAsync(token, appId, ct)).UserId;
        if (!(await users.ReadAsync(ct)).Users.Any(u => u.Id == userId && !u.Disabled && u.Role == "host.admin"))
            throw new AppIdentityException("admin_required", "Workspace inspection requires a current administrator.");
        return userId;
    }
}

internal static class WorkspaceInspectionEndpoints
{
    public static void Map(WebApplication app)
    {
        var routes = app.MapGroup("/api/internal/apps/{appId}/workspace-inspection").AddEndpointFilter(async (context, next) =>
        {
            context.HttpContext.Response.Headers.CacheControl = "no-store";
            return await next(context);
        });
        routes.MapGet("", async (string appId, HttpRequest request, WorkspaceInspectionAuthorization auth,
            WorkspaceInspectionService service, CancellationToken ct) =>
            await Handle(async () => await service.ListAsync(await auth.RequireAsync(request, appId, ct), ct)));
        routes.MapGet("/{workspaceId}/worktrees/{id}", async (string appId, string workspaceId, string id, HttpRequest request,
            WorkspaceInspectionAuthorization auth, WorkspaceInspectionService service, CancellationToken ct) =>
            await Handle(async () => await service.ReadAsync(workspaceId, id, await auth.RequireAsync(request, appId, ct), ct)));
        routes.MapGet("/{workspaceId}/worktrees/{id}/diff", async (string appId, string workspaceId, string id, HttpRequest request,
            WorkspaceInspectionAuthorization auth, WorkspaceInspectionService service, CancellationToken ct) =>
            await Handle(async () => await service.DiffAsync(workspaceId, id, await auth.RequireAsync(request, appId, ct),
                new(request.Query["path"].ToString(), request.Query["view"].ToString() is { Length: > 0 } view ? view : "session"), ct)));
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

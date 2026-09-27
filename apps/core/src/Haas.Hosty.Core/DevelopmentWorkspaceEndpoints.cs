namespace Haas.Hosty.Core;

internal sealed class WorkspaceAuthorization(AppServiceTokenService serviceTokens, AppRegistryStore apps,
    DelegatedTokenService delegated, AppIdentityService identity)
{
    public async Task<WorkspaceOwner> RequireAsync(HttpRequest request, string appId, string sessionId, CancellationToken ct)
    {
        if (!serviceTokens.ValidateToken(appId, CoreSessionAuthorization.ReadBearerToken(request) ?? ""))
            throw new AppIdentityException("token_invalid", "An app service token is required.");
        var caller = await apps.GetAppAsync(appId, ct) ?? throw new AppIdentityException("app_access_denied", "Assistant is not installed.");
        if (caller.GrantedCorePermissions?.Contains(CoreAppPermissions.Workspaces, StringComparer.Ordinal) != true)
            throw new AppIdentityException("app_permission_required", "The assistant needs the reviewed apps.workspaces.manage permission.");
        var credential = request.Headers["X-Hosty-User-Token"].ToString();
        string userId;
        var claims = delegated.ValidateToken(credential, appId);
        if (claims is not null)
        {
            var (user, _) = await identity.RequireAccessibleUserAsync(appId, claims.Sub, ct);
            if (!AppAccessPolicy.IsAdmin(user)) throw new AppIdentityException("admin_required", "Workspace operations require an administrator.");
            userId = user.Id;
        }
        else
        {
            var actor = await identity.RevalidateAsync(credential, appId, ct);
            if (actor.HostRole != "host.admin") throw new AppIdentityException("admin_required", "Workspace operations require an administrator.");
            userId = actor.UserId;
        }
        return new(appId, caller.InstalledAt, userId, sessionId);
    }
}

internal static class DevelopmentWorkspaceEndpoints
{
    public static void Map(WebApplication app)
    {
        var routes = app.MapGroup("").AddEndpointFilter(async (context, next) =>
        {
            context.HttpContext.Response.Headers.CacheControl = "no-store";
            return await next(context);
        });
        const string internalRoot = "/api/internal/apps/{appId}/sessions/{sessionId}/workspaces";
        routes.MapGet(internalRoot, async (string appId, string sessionId, HttpRequest request,
            WorkspaceAuthorization auth, DevelopmentWorkspaceService workspaces, CancellationToken ct) =>
            await Handle(async () => await workspaces.ListAsync(await auth.RequireAsync(request, appId, sessionId, ct), true, ct)));
        routes.MapPost(internalRoot, async (string appId, string sessionId, HttpRequest request, WorkspacePrepare input,
            WorkspaceAuthorization auth, DevelopmentWorkspaceService workspaces, AuditStore audit, IClock clock, CancellationToken ct) =>
            await Handle(async () =>
            {
                var owner = await auth.RequireAsync(request, appId, sessionId, ct);
                var result = await workspaces.PrepareAsync(owner, input, ct);
                await Audit(audit, clock, owner.UserId, result, input.RequestId, "prepare", ct);
                return result;
            }));
        routes.MapGet(internalRoot + "/{id}", async (string appId, string sessionId, string id, HttpRequest request,
            WorkspaceAuthorization auth, DevelopmentWorkspaceService workspaces, CancellationToken ct) =>
            await Handle(async () => await workspaces.ObserveAsync(id, await auth.RequireAsync(request, appId, sessionId, ct), ct)));
        routes.MapPost(internalRoot + "/{id}/diff", async (string appId, string sessionId, string id, HttpRequest request, WorkspaceDiffRequest input,
            WorkspaceAuthorization auth, DevelopmentWorkspaceService workspaces, CancellationToken ct) =>
            await Handle(async () => await workspaces.DiffAsync(id, await auth.RequireAsync(request, appId, sessionId, ct), input, ct)));
        routes.MapPost(internalRoot + "/{id}/operations/{kind}", async (string appId, string sessionId, string id, string kind,
            HttpRequest request, WorkspaceCommand input, WorkspaceAuthorization auth, DevelopmentWorkspaceService workspaces,
            AuditStore audit, IClock clock, CancellationToken ct) => await Handle(async () =>
            {
                var owner = await auth.RequireAsync(request, appId, sessionId, ct);
                var result = await workspaces.CommandAsync(id, owner, kind, input, ct);
                await Audit(audit, clock, owner.UserId, result, input.RequestId, kind, ct);
                return result;
            }));
        routes.MapGet("/api/development/workspaces", async (HttpRequest request, UserDirectoryStore users, IClock clock,
            DevelopmentWorkspaceService workspaces, CancellationToken ct) =>
            await CoreSessionAuthorization.RequireAdminSessionAsync(request, users, clock,
                () => Handle(() => workspaces.ListAsync(null, false, ct)), cancellationToken: ct));
        routes.MapGet("/api/development/workspaces/{id}", async (string id, HttpRequest request, UserDirectoryStore users, IClock clock,
            DevelopmentWorkspaceService workspaces, CancellationToken ct) =>
            await CoreSessionAuthorization.RequireAdminSessionAsync(request, users, clock,
                () => Handle(() => workspaces.ObserveAsync(id, null, ct)), cancellationToken: ct));
        routes.MapPost("/api/development/workspaces/{id}/diff", async (string id, HttpRequest request, WorkspaceDiffRequest input,
            UserDirectoryStore users, IClock clock, DevelopmentWorkspaceService workspaces, CancellationToken ct) =>
            await CoreSessionAuthorization.RequireAdminBrowserAsync(request, users, clock,
                _ => Handle(() => workspaces.DiffAsync(id, null, input, ct)), ct));
        routes.MapPost("/api/development/workspaces/{id}/operations/{kind}", async (string id, string kind, HttpRequest request,
            WorkspaceCommand input, UserDirectoryStore users, IClock clock, DevelopmentWorkspaceService workspaces, AuditStore audit, CancellationToken ct) =>
            await CoreSessionAuthorization.RequireAdminBrowserAsync(request, users, clock, user => Handle(async () =>
            {
                var result = await workspaces.CommandAsync(id, null, kind, input, ct);
                await Audit(audit, clock, user.Id, result, input.RequestId, kind, ct); return result;
            }), ct));
    }
    private static Task Audit(AuditStore audit, IClock clock, string user, DevelopmentWorkspace w, string request, string kind, CancellationToken ct)
        => audit.AppendAsync(new AuditRecord("audit_" + Guid.NewGuid().ToString("N"), "development.workspace." + kind, "workspace", w.Id,
            w.Operations.FirstOrDefault(o => o.Id == request)?.State ?? w.State, user, clock.UtcNow,
            new Dictionary<string, string> { ["requestId"] = request, ["assistant"] = w.Owner.AppId }), ct);
    private static async Task<IResult> Handle<T>(Func<Task<T>> action)
    {
        try { return CoreJson.Json(await action()); }
        catch (AppIdentityException ex) { return CoreJson.Json(new ErrorResponse(ex.Code, ex.Message), ex.Code == "token_invalid" ? 401 : 403); }
        catch (AppLifecycleException ex) { return CoreJson.Json(new ErrorResponse(ex.Code, ex.Message), ex.Code == "workspace_not_found" ? 404 : ex.Code == "workspace_forbidden" ? 403 : 409); }
    }
}

internal sealed class DevelopmentWorkspaceObserver(DevelopmentWorkspaceService workspaces, ILogger<DevelopmentWorkspaceObserver> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(20));
        do
        {
            try
            {
                foreach (var workspace in (await workspaces.ListAsync(null, false, stoppingToken)).Workspaces)
                {
                    try { await workspaces.ObserveAsync(workspace.Id, null, stoppingToken); }
                    catch (Exception ex) when (ex is not OperationCanceledException) { logger.LogWarning(ex, "Cannot observe workspace {WorkspaceId}", workspace.Id); }
                }
            }
            catch (Exception ex) when (ex is not OperationCanceledException) { logger.LogWarning(ex, "Cannot list development workspaces"); }
        } while (await timer.WaitForNextTickAsync(stoppingToken));
    }
}

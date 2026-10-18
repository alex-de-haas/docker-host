namespace Haas.Hosty.Core;

internal static class AppCreationEndpoints
{
    internal static void Map(WebApplication app)
    {
        const string root = "/api/internal/apps/{appId}/sessions/{sessionId}/app-creations";
        var routes = app.MapGroup(root).AddEndpointFilter(async (context, next) =>
        {
            context.HttpContext.Response.Headers.CacheControl = "no-store";
            return await next(context);
        });
        routes.MapGet("/local/{id}", async (string appId, string sessionId, string id, string? workspaceId, HttpRequest request,
            WorkspaceAuthorization auth, CoreLifecycleService lifecycle, DevelopmentWorkspaceService workspaces, CancellationToken ct) =>
            await Handle(async () => await lifecycle.ReadLocalAppAsync(await auth.RequireAsync(request, appId, sessionId, ct), id, workspaceId ?? "", workspaces, ct)));
        routes.MapPost("/local/{id}/{kind}", async (string appId, string sessionId, string id, string kind,
            LocalAppHandoffRequest input, HttpRequest request, WorkspaceAuthorization auth, AppRegistryStore apps,
            CoreLifecycleService lifecycle, DevelopmentWorkspaceService workspaces, AuditStore audit, IClock clock, CancellationToken ct) =>
            await Handle(async () =>
            {
                var owner = await auth.RequireAsync(request, appId, sessionId, ct);
                if (kind == "use" && (await apps.GetAppAsync(appId, ct)) is null)
                    throw new AppIdentityException("app_access_denied", "The calling app is unavailable.");
                if (kind == "use" && !AppManagementAuthorization.HasPermission((await apps.GetAppAsync(appId, ct))!, CoreAppPermissions.AppLifecycle))
                    throw new AppIdentityException("app_permission_required", "Ordinary use requires reviewed apps.lifecycle permission.");
                var result = await lifecycle.HandoffLocalAppAsync(owner, id, kind, input, workspaces, ct);
                await audit.AppendAsync(new("audit_" + Guid.NewGuid().ToString("N"), "app.local." + kind, "app", id,
                    result.Operation?.State ?? "unknown", owner.UserId, clock.UtcNow,
                    new Dictionary<string, string> { ["requestId"] = input.RequestId, ["assistant"] = appId }), ct);
                return result;
            }));
        app.MapGet("/control/v1/apps/development-guide", async (string? topic, HttpContext context, ControlSecret secret) =>
        {
            context.Response.Headers.CacheControl = "no-store";
            return await HostyCoreApplication.RequireControlSecret(context.Request, secret, () => Handle(() =>
                Task.FromResult(AppDevelopmentGuideReader.Read(topic))));
        });
        routes.MapGet("/guide", async (string appId, string sessionId, string? topic, HttpRequest request,
            WorkspaceAuthorization auth, CancellationToken ct) => await Handle(async () =>
            {
                await auth.RequireAsync(request, appId, sessionId, ct);
                return AppDevelopmentGuideReader.Read(topic);
            }));
        routes.MapGet("/capabilities", async (string appId, string sessionId, HttpRequest request,
            WorkspaceAuthorization auth, UserDirectoryStore users, CancellationToken ct) => await Handle(async () =>
            {
                var owner = await auth.RequireAsync(request, appId, sessionId, ct);
                var user = (await users.ReadAsync(ct)).Users.First(u => u.Id == owner.UserId);
                return new AppCreationCapabilities(user.GitIdentity);
            }));
        routes.MapGet("/{id}", async (string appId, string sessionId, string id, HttpRequest request,
            WorkspaceAuthorization auth, CoreLifecycleService lifecycle, CancellationToken ct) => await Handle(async () =>
                new AppCreationResult(await lifecycle.ReadCreationAsync(await auth.RequireAsync(request, appId, sessionId, ct), id, ct))));
        routes.MapPost("", async (string appId, string sessionId, AppCreationRequest input, HttpRequest request,
            WorkspaceAuthorization auth, AppRegistryStore apps, UserDirectoryStore users, CoreLifecycleService lifecycle,
            DevelopmentWorkspaceService workspaces, AuditStore audit, IClock clock, CancellationToken ct) => await Handle(async () =>
            {
                var owner = await auth.RequireAsync(request, appId, sessionId, ct);
                var caller = await apps.GetAppAsync(appId, ct);
                if (caller is null || !AppManagementAuthorization.HasPermission(caller, CoreAppPermissions.Install))
                    throw new AppIdentityException("app_permission_required", "Creation requires the reviewed apps.install permission.");
                var user = (await users.ReadAsync(ct)).Users.First(u => u.Id == owner.UserId);
                var created = await lifecycle.CreateLocalAppAsync(owner, input, user.GitIdentity, ct);
                var tree = await workspaces.PrepareAsync(owner, new(input.RequestId, sessionId, input.AppId,
                    "/assistant?session=" + Uri.EscapeDataString(sessionId), "main"), ct);
                await audit.AppendAsync(new("audit_" + Guid.NewGuid().ToString("N"), "app.creation", "app", input.AppId,
                    "prepared", owner.UserId, clock.UtcNow, new Dictionary<string, string> { ["requestId"] = input.RequestId, ["assistant"] = appId }), ct);
                return created with { Workspace = tree };
            }));
    }
    private static async Task<IResult> Handle<T>(Func<Task<T>> action)
    {
        try { return CoreJson.Json(await action()); }
        catch (AppIdentityException ex) { return CoreJson.Json(new ErrorResponse(ex.Code, ex.Message), AuthEndpoints.MapIdentityErrorStatus(ex.Code)); }
        catch (AppLifecycleException ex) { return CoreJson.Json(new ErrorResponse(ex.Code, ex.Message), ex.Code == AppDevelopmentGuideReader.InvalidTopicCode ? 400 : ex.Code is "creation_not_found" or "workspace_not_found" ? 404 : ex.Code == "workspace_forbidden" ? 403 : 409); }
        catch (AppManifestException ex) { return CoreJson.Json(new ErrorResponse(ex.Code, ex.Message), 409); }
    }
}

namespace Haas.Hosty.Core;

internal sealed class WorkspaceInspectionAuthorization(AppServiceTokenService services, AppRegistryStore apps,
    AppIdentityService identity, UserDirectoryStore users)
{
    public async Task<string> RequireAsync(HttpRequest request, string appId, CancellationToken ct, bool manage = false)
    {
        if (!services.ValidateToken(appId, CoreSessionAuthorization.ReadBearerToken(request) ?? ""))
            throw new AppIdentityException("token_invalid", "An app service token is required.");
        var app = await apps.GetAppAsync(appId, ct);
        if (app is null || !AppManagementAuthorization.HasPermission(app, manage ? CoreAppPermissions.Sources : CoreAppPermissions.WorkspacesRead))
            throw new AppIdentityException("app_permission_required", "The calling app requires the reviewed workspace permission.");
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
        routes.MapGet("/events", (string appId, HttpRequest request, HttpResponse response,
            WorkspaceInspectionAuthorization auth, WorkspaceInspectionService service, CoreEventHub events,
            IHostApplicationLifetime lifetime, CancellationToken ct) =>
            WorkspaceInspectionStream.RunAsync(appId, request, response, auth, service, events, lifetime, ct));
        routes.MapGet("", async (string appId, HttpRequest request, WorkspaceInspectionAuthorization auth,
            WorkspaceInspectionService service, CancellationToken ct) =>
            await Handle(async () => await service.ListAsync(await auth.RequireAsync(request, appId, ct), ct, callerAppId: appId)));
        routes.MapGet("/local-apps", async (string appId, HttpRequest request, WorkspaceInspectionAuthorization auth,
            CoreLifecycleService lifecycle, DevelopmentWorkspaceService workspaces, CancellationToken ct) =>
            await Handle(async () => await lifecycle.ReadLocalBuildingAppsAsync(await auth.RequireAsync(request, appId, ct), workspaces, ct)));
        routes.MapGet("/{workspaceId}/previews", async (string appId, string workspaceId, HttpRequest request,
            WorkspaceInspectionAuthorization auth, WorkspaceCleanupService cleanup, CancellationToken ct) =>
            await Handle(async () => await cleanup.PreviewsAsync(workspaceId, await auth.RequireAsync(request, appId, ct), appId, ct)));
        routes.MapPost("/{workspaceId}/previews/{environmentId}/{targetApp}/{action}", async (string appId, string workspaceId,
            string environmentId, string targetApp, string action, HttpRequest request, PreviewCheckRun input,
            WorkspaceInspectionAuthorization auth, WorkspaceCleanupService cleanup, CancellationToken ct) =>
            await Handle(async () => await cleanup.PreviewActionAsync(workspaceId, await auth.RequireAsync(request, appId, ct), appId,
                environmentId, targetApp, action, input, ct)));
        routes.MapPost("/{workspaceId}/environments/{id}/{action}", async (string appId, string workspaceId,
            string id, string action, CoreEnvironmentCommand input, HttpRequest request,
            WorkspaceInspectionAuthorization auth, WorkspaceCleanupService cleanup, CancellationToken ct) =>
            await Handle(async () => await cleanup.EnvironmentCommandAsync(workspaceId,
                await auth.RequireAsync(request, appId, ct), appId, id, action, input, ct)));
        routes.MapGet("/{workspaceId}/discard/plan", async (string appId, string workspaceId, HttpRequest request,
            WorkspaceInspectionAuthorization auth, WorkspaceCleanupService cleanup, CancellationToken ct) =>
            await Handle(async () => await cleanup.PrepareDiscardAsync(workspaceId, await auth.RequireAsync(request, appId, ct, manage: true), appId, ct)));
        routes.MapPost("/{workspaceId}/discard/apply", async (string appId, string workspaceId, WorkspaceDiscardApply input, HttpRequest request,
            WorkspaceInspectionAuthorization auth, WorkspaceCleanupService cleanup, CancellationToken ct) =>
            await Handle(async () => await cleanup.ApplyDiscardAsync(workspaceId, await auth.RequireAsync(request, appId, ct, manage: true), appId, input, ct)));
        routes.MapGet("/{workspaceId}/discard/status", async (string appId, string workspaceId, HttpRequest request,
            WorkspaceInspectionAuthorization auth, WorkspaceCleanupService cleanup, CancellationToken ct) =>
            await Handle(async () => await cleanup.DiscardStatusAsync(workspaceId, await auth.RequireAsync(request, appId, ct, manage: true), appId, request.Query["requestId"].ToString(), ct)));
        routes.MapGet("/{workspaceId}/workflow", async (string appId, string workspaceId, HttpRequest request,
            WorkspaceInspectionAuthorization auth, WorkspaceInspectionService service, CancellationToken ct) =>
            await Handle(async () => await service.WorkflowAsync(workspaceId, await auth.RequireAsync(request, appId, ct), null, null, ct)));
        routes.MapPost("/{workspaceId}/workflow/{kind}", async (string appId, string workspaceId, string kind,
            WorkspaceWorkflowCommand input, HttpRequest request, WorkspaceInspectionAuthorization auth,
            WorkspaceInspectionService service, WorkspaceCleanupService cleanup, CancellationToken ct) =>
            await Handle(async () =>
            {
                var userId = await auth.RequireAsync(request, appId, ct, manage: true);
                return kind == "delete" ? await cleanup.DeleteAsync(workspaceId, userId, appId, input, ct)
                    : await service.WorkflowAsync(workspaceId, userId, kind, input, ct);
            }));
        routes.MapGet("/{workspaceId}/worktrees/{id}", async (string appId, string workspaceId, string id, HttpRequest request,
            WorkspaceInspectionAuthorization auth, WorkspaceInspectionService service, CancellationToken ct) =>
            await Handle(async () => await service.ReadAsync(workspaceId, id, await auth.RequireAsync(request, appId, ct), ct, request.Query["refresh"] == "true")));
        routes.MapPost("/{workspaceId}/worktrees/{id}/recover-lease", async (string appId, string workspaceId, string id,
            WorkspaceLeaseRecovery input, HttpRequest request, WorkspaceInspectionAuthorization auth,
            WorkspaceInspectionService service, AuditStore audit, IClock clock, CancellationToken ct) =>
            await Handle(async () =>
            {
                var userId = await auth.RequireAsync(request, appId, ct, manage: true);
                var result = await service.RecoverLeaseAsync(workspaceId, id, userId, input, ct);
                await audit.AppendAsync(new AuditRecord("audit_" + Guid.NewGuid().ToString("N"),
                    "development.workspace.recover-lease", "workspace", id, "succeeded", userId, clock.UtcNow,
                    new Dictionary<string, string> { ["requestId"] = input.RequestId, ["leaseId"] = input.LeaseId,
                        ["assistant"] = appId }), ct);
                return result;
            }));
        routes.MapGet("/{workspaceId}/worktrees/{id}/review", async (string appId, string workspaceId, string id, HttpRequest request,
            WorkspaceInspectionAuthorization auth, WorkspaceInspectionService service, CancellationToken ct) =>
            await Handle(async () => await service.ReviewAsync(workspaceId, id, await auth.RequireAsync(request, appId, ct),
                request.Query["scope"].ToString() is { Length: > 0 } scope ? scope : "session",
                request.Query["pullRequestUrl"].ToString(), ct)));
        routes.MapGet("/{workspaceId}/worktrees/{id}/review/diff", async (string appId, string workspaceId, string id, HttpRequest request,
            WorkspaceInspectionAuthorization auth, WorkspaceInspectionService service, CancellationToken ct) =>
            await Handle(async () => await service.ReviewDiffAsync(workspaceId, id, await auth.RequireAsync(request, appId, ct),
                request.Query["scope"].ToString() is { Length: > 0 } scope ? scope : "session",
                request.Query["pullRequestUrl"].ToString(), request.Query["path"].ToString(), request.Query["revision"].ToString(), ct)));
        routes.MapPost("/{workspaceId}/worktrees/{id}/reviews/{kind}", async (string appId, string workspaceId, string id,
            string kind, PublicationReviewCommand input, HttpRequest request, WorkspaceInspectionAuthorization auth,
            WorkspaceInspectionService service, PublicationService publications, CancellationToken ct) =>
            await Handle(async () =>
            {
                var userId = await auth.RequireAsync(request, appId, ct, manage: true);
                var tree = await service.RequireAsync(workspaceId, id, userId, ct);
                return await publications.CommandReviewAsync(tree, userId, kind, input, ct);
            }));
        routes.MapGet("/{workspaceId}/worktrees/{id}/diff", async (string appId, string workspaceId, string id, HttpRequest request,
            WorkspaceInspectionAuthorization auth, WorkspaceInspectionService service, CancellationToken ct) =>
            await Handle(async () => await service.DiffAsync(workspaceId, id, await auth.RequireAsync(request, appId, ct),
                new(request.Query["path"].ToString(), request.Query["view"].ToString() is { Length: > 0 } view ? view : "session"), ct)));
    }
    private static async Task<IResult> Handle<T>(Func<Task<T>> action)
    {
        try { return CoreJson.Json(await action()); }
        catch (PublicationException ex)
        {
            var status = ex.Code.EndsWith("not_found", StringComparison.Ordinal) ? 404
                : ex.Code.EndsWith("forbidden", StringComparison.Ordinal) ? 403
                : ex.Code.EndsWith("invalid", StringComparison.Ordinal) ? 400 : 409;
            return CoreJson.Json(new ErrorResponse(ex.Code, ex.Message), status);
        }
        catch (UserConnectionException ex) { return CoreJson.Json(new ErrorResponse(ex.Code, ex.Message), ex.Status); }
        catch (System.Text.Json.JsonException) { return CoreJson.Json(new ErrorResponse("publication_provider_unavailable", "The source provider returned an incomplete review. Refresh to retry."), 409); }
        catch (HttpRequestException) { return CoreJson.Json(new ErrorResponse("publication_provider_unavailable", "The source provider is unavailable. Refresh the review to retry."), 409); }
        catch (SandboxException ex) { return CoreJson.Json(new ErrorResponse(ex.Code, ex.Message), ex.Status); }
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

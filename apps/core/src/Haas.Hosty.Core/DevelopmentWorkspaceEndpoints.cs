namespace Haas.Hosty.Core;

internal sealed class WorkspaceAuthorization(AppServiceTokenService serviceTokens, AppRegistryStore apps,
    AssistantSessionAuthority authority)
{
    public async Task<WorkspaceOwner> RequireAsync(HttpRequest request, string appId, string sessionId, CancellationToken ct)
    {
        if (!serviceTokens.ValidateToken(appId, CoreSessionAuthorization.ReadBearerToken(request) ?? ""))
            throw new AppIdentityException("token_invalid", "An app service token is required.");
        var caller = await apps.GetAppAsync(appId, ct) ?? throw new AppIdentityException("app_access_denied", "Assistant is not installed.");
        if (caller.GrantedCorePermissions?.Contains(CoreAppPermissions.Sources, StringComparer.Ordinal) != true)
            throw new AppIdentityException("app_permission_required", "The assistant needs the reviewed apps.sources.full permission.");
        var credential = request.Headers["X-Hosty-User-Token"].ToString();
        if (!credential.StartsWith("hostyg_", StringComparison.Ordinal))
            throw new AppIdentityException("reauth_required", "Workspace access requires active browser app authorization.");
        var actor = await authority.RequireAsync(appId, sessionId, AppIdentityService.HashToken(credential), ct);
        if (actor.HostRole != "host.admin") throw new AppIdentityException("admin_required", "Workspace operations require an administrator.");
        var userId = actor.UserId;
        return new(appId, caller.InstalledAt, userId, sessionId);
    }
}

internal static class DevelopmentWorkspaceEndpoints
{
    public static void Map(WebApplication app)
    {
        WorkspaceNameEndpoints.Map(app);
        WorkspaceParticipationEndpoints.Map(app);
        WorkspaceSessionActivityEndpoints.Map(app);
        var routes = app.MapGroup("").AddEndpointFilter(async (context, next) =>
        {
            context.HttpContext.Response.Headers.CacheControl = "no-store";
            return await next(context);
        });
        const string internalRoot = "/api/internal/apps/{appId}/sessions/{sessionId}/workspaces";
        routes.MapGet(internalRoot, async (string appId, string sessionId, HttpRequest request,
            WorkspaceAuthorization auth, DevelopmentWorkspaceService workspaces, CancellationToken ct) =>
            await Handle(async () => await workspaces.SessionListAsync(await auth.RequireAsync(request, appId, sessionId, ct), ct)));
        routes.MapGet(internalRoot + "/workflow", async (string appId, string sessionId, HttpRequest request,
            WorkspaceAuthorization auth, DevelopmentWorkspaceService workspaces, CancellationToken ct) =>
            await Handle(async () => await workspaces.SessionWorkflowAsync(await auth.RequireAsync(request, appId, sessionId, ct), ct)));
        routes.MapPost(internalRoot + "/workflow/{kind}", async (string appId, string sessionId, string kind,
            WorkspaceWorkflowCommand input, HttpRequest request, WorkspaceAuthorization auth,
            DevelopmentWorkspaceService workspaces, PublicationService publications, WorkspaceCleanupService cleanup, CancellationToken ct) =>
            await Handle(async () =>
            {
                var actor = await auth.RequireAsync(request, appId, sessionId, ct);
                var owner = await workspaces.SessionResourceOwnerAsync(actor, ct, ownerOnly: true);
                if (kind == "delete")
                {
                    return await cleanup.DeleteAsync(DevelopmentWorkspaceService.WorkspaceIdFor(owner), owner.UserId, appId, input, ct);
                }
                var heads = kind is "complete" or "delete" ? await publications.MergedWorkspaceHeadsAsync(owner, ct) : new Dictionary<string, string>();
                return await workspaces.ChangeWorkflowAsync(owner, owner.UserId, kind is "pause-confirm" or "close-confirm" or "defer-confirm" ? kind[..^8] : kind, input, heads, ct, prepareOnly: kind is "pause" or "close");
            }));
        routes.MapPost(internalRoot, async (string appId, string sessionId, HttpRequest request, WorkspacePrepare input,
            WorkspaceAuthorization auth, DevelopmentWorkspaceService workspaces, AuditStore audit, IClock clock, CancellationToken ct) =>
            await Handle(async () =>
            {
                var owner = await auth.RequireAsync(request, appId, sessionId, ct);
                var result = await workspaces.PrepareAsync(owner, input, ct);
                await Audit(audit, clock, owner.UserId, result, input.RequestId, "prepare", ct);
                return await workspaces.SessionProjectionAsync(result, owner, ct);
            }));
        routes.MapGet(internalRoot + "/{id}", async (string appId, string sessionId, string id, HttpRequest request,
            WorkspaceAuthorization auth, DevelopmentWorkspaceService workspaces, CancellationToken ct) =>
            await Handle(async () =>
            {
                var actor = await auth.RequireAsync(request, appId, sessionId, ct);
                return await workspaces.SessionProjectionAsync(await workspaces.ObserveAsync(id, actor, ct), actor, ct);
            }));
        routes.MapGet(internalRoot + "/{id}/viewer", async (string appId, string sessionId, string id, HttpRequest request,
            WorkspaceAuthorization auth, DevelopmentWorkspaceService workspaces, WorkspaceInspectionService inspection, CancellationToken ct) =>
            await Handle(async () =>
            {
                var actor = await auth.RequireAsync(request, appId, sessionId, ct);
                return await inspection.SessionDestinationAsync(await workspaces.Read(id, actor, ct), actor, ct);
            }));
        routes.MapGet(internalRoot + "/{id}/remote", async (string appId, string sessionId, string id, string? sourceAppId, HttpRequest request,
            WorkspaceAuthorization auth, DevelopmentWorkspaceService workspaces, CancellationToken ct) =>
            await Handle(async () =>
            {
                var owner = await auth.RequireAsync(request, appId, sessionId, ct);
                if (string.IsNullOrWhiteSpace(sourceAppId) || sourceAppId.Length > 63)
                    throw DevelopmentWorkspaceService.Error("request_invalid", "Supply the local source app id.");
                return await workspaces.RemoteStatusAsync(id, owner, sourceAppId, ct);
            }));
        routes.MapPost(internalRoot + "/{id}/remote/{kind}", async (string appId, string sessionId, string id, string kind, LocalRemoteCommand input, HttpRequest request,
            WorkspaceAuthorization auth, DevelopmentWorkspaceService workspaces, AuditStore audit, IClock clock, CancellationToken ct) =>
            await Handle(async () =>
            {
                var owner = await auth.RequireAsync(request, appId, sessionId, ct);
                var result = await workspaces.RemoteCommandAsync(id, owner, kind, input, ct);
                await Audit(audit, clock, owner.UserId, await workspaces.Read(id, owner, ct), input.RequestId, "remote-" + kind, ct);
                return result;
            }));
        routes.MapPost(internalRoot + "/{id}/commit-review", async (string appId, string sessionId, string id,
            WorkspaceCommitReviewRequest input, HttpRequest request, WorkspaceAuthorization auth,
            DevelopmentWorkspaceService workspaces, CancellationToken ct) =>
            await Handle(async () => await workspaces.PrepareCommitReviewAsync(id, await auth.RequireAsync(request, appId, sessionId, ct), input, ct)));
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
                return await workspaces.SessionProjectionAsync(result, owner, ct);
            }));
        routes.MapGet("/api/development/workspaces", async (HttpRequest request, UserDirectoryStore users, IClock clock,
            DevelopmentWorkspaceService workspaces, WorkspaceInspectionService inspection, CancellationToken ct) =>
            await CoreSessionAuthorization.RequireAdminSessionAsync(request, users, clock,
                () => Handle(async () =>
                {
                    var actor = await CoreSessionAuthorization.TryResolveSessionAsync(request, users, clock, ct);
                    var allowed = new List<DevelopmentWorkspace>();
                    foreach (var tree in (await workspaces.ListAsync(null, false, ct)).Workspaces)
                    {
                        try { await inspection.RequireAsync(tree.WorkspaceId, tree.Id, actor!.Id, ct); allowed.Add(DevelopmentWorkspaceService.UserProjection(tree, actor.Id)); }
                        catch (AppLifecycleException) { }
                    }
                    return new WorkspaceList(allowed.ToArray());
                }), cancellationToken: ct));
        routes.MapGet("/api/development/workspaces/{id}", async (string id, HttpRequest request, UserDirectoryStore users, IClock clock,
            DevelopmentWorkspaceService workspaces, WorkspaceInspectionService inspection, CancellationToken ct) =>
            await CoreSessionAuthorization.RequireAdminSessionAsync(request, users, clock,
                () => Handle(async () =>
                {
                    var actor = await CoreSessionAuthorization.TryResolveSessionAsync(request, users, clock, ct);
                    var tree = await workspaces.Read(id, null, ct);
                    await inspection.RequireAsync(tree.WorkspaceId, id, actor!.Id, ct);
                    var observed = await workspaces.ObserveAsync(id, null, ct);
                    await inspection.RequireAsync(tree.WorkspaceId, id, actor.Id, ct);
                    return DevelopmentWorkspaceService.UserProjection(observed, actor.Id);
                }), cancellationToken: ct));
        routes.MapPost("/api/development/workspaces/{id}/diff", async (string id, HttpRequest request, WorkspaceDiffRequest input,
            UserDirectoryStore users, IClock clock, DevelopmentWorkspaceService workspaces, WorkspaceInspectionService inspection, CancellationToken ct) =>
            await CoreSessionAuthorization.RequireAdminBrowserAsync(request, users, clock,
                actor => Handle(async () =>
                {
                    var tree = await workspaces.Read(id, null, ct);
                    return await inspection.DiffAsync(tree.WorkspaceId, id, actor.Id, input, ct);
                }), ct));
        routes.MapPost("/api/development/workspaces/{id}/operations/{kind}", async (string id, string kind, HttpRequest request,
            WorkspaceCommand input, UserDirectoryStore users, IClock clock, DevelopmentWorkspaceService workspaces, AuditStore audit, CancellationToken ct) =>
            await CoreSessionAuthorization.RequireAdminBrowserAsync(request, users, clock, user => Handle(async () =>
            {
                var tree = await workspaces.Read(id, null, ct);
                if (tree.Owner.UserId != user.Id)
                    throw DevelopmentWorkspaceService.Error("forbidden", "Workspace operations require the owning operator or an attached session.");
                if (tree.Owner.IsExternal) await workspaces.RequireExternalSourceAsync(tree, ct);
                else await workspaces.RequireParticipationSourceAsync(tree, user.Id, ct);
                // Browser-prepared Core source uses an explicit operator principal. It may
                // release its own preparation lease; it cannot impersonate an assistant or MCP grant.
                var actor = tree.Owner.External?.PrincipalId == "operator:" + user.Id ? tree.Owner : null;
                var result = await workspaces.CommandAsync(id, actor, kind, input, ct);
                await Audit(audit, clock, user.Id, result, input.RequestId, kind, ct);
                return DevelopmentWorkspaceService.UserProjection(result, user.Id);
            }), ct));
    }
    private static Task Audit(AuditStore audit, IClock clock, string user, DevelopmentWorkspace w, string request, string kind, CancellationToken ct)
        => audit.AppendAsync(new AuditRecord("audit_" + Guid.NewGuid().ToString("N"), "development.workspace." + kind, "workspace", w.Id,
            w.Operations.FirstOrDefault(o => o.Id == request)?.State ?? w.State, user, clock.UtcNow,
            new Dictionary<string, string> { ["requestId"] = request, ["assistant"] = w.Owner.AppId }), ct);
    private static async Task<IResult> Handle<T>(Func<Task<T>> action)
    {
        try { return CoreJson.Json(await action()); }
        catch (UserConnectionException ex) { return CoreJson.Json(new ErrorResponse(ex.Code, ex.Message), ex.Status); }
        catch (HttpRequestException) { return CoreJson.Json(new ErrorResponse("remote_unavailable", "Remote is unavailable. Retry with the same requestId."), 503); }
        catch (AppIdentityException ex) { return CoreJson.Json(new ErrorResponse(ex.Code, ex.Message), AuthEndpoints.MapIdentityErrorStatus(ex.Code)); }
        catch (AppLifecycleException ex) { return CoreJson.Json(new ErrorResponse(ex.Code, ex.Message), ex.Code == "workspace_not_found" ? 404 : ex.Code == "workspace_forbidden" ? 403 : 409); }
    }
}

using System.Text.Json;

namespace Haas.Hosty.Core;

internal static class FeedbackEndpoints
{
    private const int IntakeLimit = 12 * 1024 * 1024;
    internal static void Map(WebApplication app)
    {
        const string own = "/api/internal/apps/{appId}/ui/feedback";
        const string admin = "/api/internal/apps/{appId}/feedback";
        app.MapGet(own, (string appId, HttpContext ctx, ProviderAccessService access, AppIdentityService identity, CoreDataPaths paths) =>
            WithApp(appId, ctx, access, identity, false, (caller, actor) => Task.FromResult(CoreJson.Json(
                new FeedbackCapabilities(1, DevelopmentWorkspaceService.Hash(paths.CoreRoot), caller.Id, caller.InstalledAt.ToString("O"), actor.UserId, Administrator: actor.HostRole == "host.admin")))));
        app.MapGet(own + "/{reportId}/review-targets", (string appId, string reportId, HttpContext ctx, ProviderAccessService access,
            AppIdentityService identity, FeedbackStore store, AppRegistryStore apps, CorePublicOriginResolver origins) =>
            WithApp(appId, ctx, access, identity, false, async (_, actor) =>
            {
                if (actor.HostRole != "host.admin") throw new FeedbackException("admin_required", "Only administrators can send feedback to a chat.", 403);
                if (!(await store.ListAsync(ctx.RequestAborted)).Reports.Any(r => r.Id == reportId))
                    throw new FeedbackException("feedback_not_found", "Feedback is unavailable.", 404);
                var targets = new List<FeedbackReviewTarget>();
                foreach (var candidate in await apps.ListAppRecordsAsync(ctx.RequestAborted))
                {
                    if (candidate.GrantedCorePermissions?.Contains(CoreAppPermissions.FeedbackManage) != true || candidate.Ui is null) continue;
                    try { await identity.RequireAccessibleUserAsync(candidate.Id, actor.UserId, ctx.RequestAborted); }
                    catch (AppIdentityException) { continue; }
                    foreach (var entry in candidate.Ui.Navigation.Where(n => n.FeedbackReview))
                    {
                        var endpoint = entry.EndpointKey ?? candidate.Ui.EndpointKey;
                        if (endpoint is null || !candidate.Endpoints.Any(e => e.Key == endpoint && e.Public && e.Protocol is "http" or "https")) continue;
                        var route = Microsoft.AspNetCore.WebUtilities.QueryHelpers.AddQueryString(entry.Path, "feedback", reportId);
                        targets.Add(new(candidate.DisplayName, UiPanelService.BuildOpenUrl(origins.Effective, candidate.Id, PanelIdentity.Installation(candidate), endpoint, route)));
                    }
                }
                return CoreJson.Json(new FeedbackReviewTargets(targets.ToArray()));
            }));
        app.MapPost(own, (string appId, HttpContext ctx, ProviderAccessService access, AppIdentityService identity,
            FeedbackStore store, CoreDataPaths paths, DevelopmentWorkspaceService workspaces, IClock clock) =>
            WithApp(appId, ctx, access, identity, false, async (caller, actor) =>
                CoreJson.Json(await store.SubmitAsync(actor.UserId, await Observe(caller, paths, workspaces, clock, ctx.RequestAborted),
                    await Read<FeedbackSubmit>(ctx, IntakeLimit), ctx.RequestAborted))));
        app.MapGet(admin, (string appId, HttpContext ctx, ProviderAccessService access, AppIdentityService identity, FeedbackStore store) =>
            WithApp(appId, ctx, access, identity, true, async (_, _) => CoreJson.Json(await store.ListAsync(ctx.RequestAborted))));
        app.MapGet(admin + "/{reportId}/images/{noteId}", (string appId, string reportId, string noteId, HttpContext ctx,
            ProviderAccessService access, AppIdentityService identity, FeedbackStore store) =>
            WithApp(appId, ctx, access, identity, true, async (_, _) => Image(await store.ImageAsync(reportId, noteId, ctx.RequestAborted))));
        app.MapPost(admin + "/{reportId}", (string appId, string reportId, HttpContext ctx,
            ProviderAccessService access, AppIdentityService identity, FeedbackStore store, DevelopmentWorkspaceService workspaces, WorkspaceInspectionService inspection) =>
            WithApp(appId, ctx, access, identity, true, async (_, actor) =>
            {
                var input = await Read<FeedbackChange>(ctx);
                await Workspace(workspaces, inspection, actor.UserId, input.WorkspaceId, ctx.RequestAborted);
                return CoreJson.Json(await store.ChangeAsync(reportId, input, ctx.RequestAborted));
            }));
        app.MapPost(admin + "/dispatches", (string appId, HttpContext ctx, ProviderAccessService access,
            AppIdentityService identity, FeedbackStore store, DevelopmentWorkspaceService workspaces, WorkspaceInspectionService inspection) =>
            WithApp(appId, ctx, access, identity, true, async (caller, actor) =>
            {
                var input = await Read<FeedbackDispatchInput>(ctx);
                await Workspace(workspaces, inspection, actor.UserId, input.WorkspaceId, ctx.RequestAborted);
                return CoreJson.Json(await store.ReserveAsync(caller.Id, caller.InstalledAt.ToString("O"), actor.UserId, input, ctx.RequestAborted));
            }));
        app.MapPost(admin + "/dispatches/{dispatchId}/delivery", (string appId, string dispatchId, HttpContext ctx,
            ProviderAccessService access, AppIdentityService identity, FeedbackStore store, DevelopmentWorkspaceService workspaces, WorkspaceInspectionService inspection) =>
            WithApp(appId, ctx, access, identity, true, async (caller, actor) =>
            {
                var input = await Read<FeedbackDelivery>(ctx);
                await Workspace(workspaces, inspection, actor.UserId, input.WorkspaceId, ctx.RequestAborted);
                return CoreJson.Json(await store.DeliverAsync(dispatchId, caller.Id, caller.InstalledAt.ToString("O"), actor.UserId, input, ctx.RequestAborted));
            }));
        app.MapPost(admin + "/dispatches/{dispatchId}/outcomes", (string appId, string dispatchId, HttpContext ctx,
            ProviderAccessService access, AppIdentityService identity, FeedbackStore store) =>
            WithApp(appId, ctx, access, identity, true, async (caller, actor) =>
                CoreJson.Json(await store.ResultsAsync(dispatchId, caller.Id, caller.InstalledAt.ToString("O"), actor.UserId,
                    await Read<FeedbackResults>(ctx), ctx.RequestAborted))));

        // Core's own session API remains usable without any distribution UI or assistant installed.
        app.MapGet("/api/feedback", (HttpContext ctx, UserDirectoryStore users, IClock clock, FeedbackStore store) =>
            CoreSessionAuthorization.RequireAdminSessionAsync(ctx.Request, users, clock,
                () => Handle(ctx, async () => CoreJson.Json(await store.ListAsync(ctx.RequestAborted))), cancellationToken: ctx.RequestAborted));
        app.MapPost("/api/apps/{appId}/feedback", (string appId, HttpContext ctx, UserDirectoryStore users, IClock clock,
            AppIdentityService identity, FeedbackStore store, CoreDataPaths paths, DevelopmentWorkspaceService workspaces) =>
            CoreSessionAuthorization.RequireSessionAsync(ctx.Request, users, clock, actor => Handle(ctx, async () =>
            {
                var (_, caller) = await identity.RequireAccessibleUserAsync(appId, actor.Id, ctx.RequestAborted);
                return CoreJson.Json(await store.SubmitAsync(actor.Id, await Observe(caller, paths, workspaces, clock, ctx.RequestAborted),
                    await Read<FeedbackSubmit>(ctx, IntakeLimit), ctx.RequestAborted));
            }), requireCsrf: true, cancellationToken: ctx.RequestAborted));
    }
    internal static void RequireAdmin(AppRecord caller, AppSessionValidationResult actor)
    {
        if (actor.HostRole != "host.admin") throw new FeedbackException("admin_required", "Feedback management requires an administrator.", 403);
        if (caller.GrantedCorePermissions?.Contains(CoreAppPermissions.FeedbackManage, StringComparer.Ordinal) != true)
            throw new FeedbackException("app_permission_required", "Allow this app to manage feedback.", 403);
    }
    private static Task<IResult> WithApp(string appId, HttpContext ctx, ProviderAccessService access, AppIdentityService identity,
        bool admin, Func<AppRecord, AppSessionValidationResult, Task<IResult>> action) => Handle(ctx, async () =>
    {
        var caller = await access.AuthenticateAsync(appId, ctx.Request, ctx.RequestAborted);
        var token = ctx.Request.Headers["X-Hosty-User-Token"].ToString();
        var actor = ctx.Request.Method == "GET" ? await identity.RevalidateAsync(token, appId, ctx.RequestAborted)
            : await identity.RequireActivityAsync(token, appId, ctx.RequestAborted);
        if (admin) RequireAdmin(caller, actor);
        return await action(caller, actor);
    });
    private static async Task<IResult> Handle(HttpContext ctx, Func<Task<IResult>> action)
    {
        ctx.Response.Headers.CacheControl = "no-store";
        ctx.Response.Headers["X-Content-Type-Options"] = "nosniff";
        try { return await action(); }
        catch (FeedbackException ex) { return CoreJson.Json(new ErrorResponse(ex.Code, ex.Message), ex.Status); }
        catch (AppIdentityException ex) { return CoreJson.Json(new ErrorResponse(ex.Code, ex.Message), AuthEndpoints.MapIdentityErrorStatus(ex.Code)); }
        catch (AppLifecycleException ex) { return CoreJson.Json(new ErrorResponse(ex.Code, ex.Message), 409); }
        catch (JsonException) { return CoreJson.Json(new ErrorResponse("feedback_invalid", "Invalid feedback request."), 400); }
    }
    private static IResult Image(FeedbackImage image) => Results.Bytes(Convert.FromBase64String(image.Data), image.MediaType);
    private static async Task<T> Read<T>(HttpContext ctx, int limit = 262144) where T : class
    {
        if (ctx.Request.ContentType?.Split(';', 2)[0].Trim() != "application/json")
            throw new FeedbackException("feedback_invalid", "Send an application/json request.", 415);
        if (ctx.Request.ContentLength > limit) throw new FeedbackException("feedback_too_large", "Feedback request is too large.", 413);
        using var buffer = new MemoryStream();
        var chunk = new byte[8192];
        int count;
        while ((count = await ctx.Request.Body.ReadAsync(chunk, ctx.RequestAborted)) != 0)
        {
            if (buffer.Length + count > limit) throw new FeedbackException("feedback_too_large", "Feedback request is too large.", 413);
            buffer.Write(chunk, 0, count);
        }
        return JsonSerializer.Deserialize(buffer.ToArray(), CoreJson.TypeInfo<T>())
            ?? throw new FeedbackException("feedback_invalid", "A request body is required.", 400);
    }
    internal static async Task Workspace(DevelopmentWorkspaceService service, WorkspaceInspectionService inspection, string user, string? id, CancellationToken ct)
    {
        if (id is null) return;
        await service.RequireWorkspaceUserAsync(user, ct);
        await inspection.ReadOwnerAsync(id, user, ct);
        var tree = (await service.ListAsync(null, false, ct)).Workspaces.FirstOrDefault(w => w.WorkspaceId == id && w.State == "active")
            ?? throw new FeedbackException("workspace_not_found", "Select an available workspace.", 404);
        var workflow = await service.WorkflowAsync(tree.Owner, ct);
        if (workflow.State is "deleting" or "deleted")
            throw new FeedbackException("workspace_deleted", "This workspace is being deleted.");
    }
    internal static async Task<FeedbackObservation> Observe(AppRecord app, CoreDataPaths paths,
        DevelopmentWorkspaceService workspaces, IClock clock, CancellationToken ct)
    {
        string? workspace = null, revision = app.SourceState?.Commit;
        var kind = app.DevModeId is null ? "package" : "unknown";
        try
        {
            var execution = await AppDevStore.ReadAsync(paths, app, ct);
            if (execution is { Active: true } && execution.Installation == app.InstalledAt &&
                app.SelectedRuntime == execution.TargetRuntime && app.SourceState?.LocalOverridePath == execution.SourcePath)
            {
                kind = "development";
                revision = execution.SourceHead;
                var tree = (await workspaces.ListAsync(null, false, ct)).Workspaces.FirstOrDefault(t =>
                    t.Id == execution.WorktreeId && t.State == "active");
                if (tree is not null) { workspace = tree.WorkspaceId; kind = "workspace"; }
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException ||
            ex is AppLifecycleException { Code: "dev_state_unavailable" })
        {
            // Optional execution metadata must not prevent reporting a broken application.
            workspace = null; revision = null; kind = "unknown";
        }
        return new(app.Id, app.DisplayName, app.InstalledAt.ToString("O"), app.Version, clock.UtcNow,
            kind, workspace, revision);
    }
}

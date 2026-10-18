using System.ComponentModel;
using ModelContextProtocol.Server;

namespace Haas.Hosty.Core;

internal static class AppDevModeEndpoints
{
    public static void Map(WebApplication app)
    {
        app.MapGet("/api/apps/{appId}/dev-mode", async (string appId, HttpRequest request, UserDirectoryStore users,
            IClock clock, CoreLifecycleService lifecycle, CancellationToken ct) =>
            await CoreSessionAuthorization.RequireAdminSessionAsync(request, users, clock,
                () => Handle(() => lifecycle.GetDevModeAsync(appId, ct)), cancellationToken: ct));
        app.MapPost("/api/apps/{appId}/dev-mode/{kind}", async (string appId, string kind, AppDevRequest input,
            HttpRequest request, UserDirectoryStore users, IClock clock, CoreLifecycleService lifecycle, CancellationToken ct) =>
            await CoreSessionAuthorization.RequireSessionAsync(request, users, clock, user => AppAccessPolicy.IsAdmin(user)
                ? Dispatch(lifecycle, appId, kind, input, new(user.Id, "manual"), ct)
                : Task.FromResult<IResult>(CoreJson.Json(new ErrorResponse("admin_required", "An administrator is required."), 403)), requireCsrf: true, cancellationToken: ct));
        app.MapGet("/control/v1/apps/{appId}/dev-mode", async (string appId, HttpRequest request, ControlSecret secret,
            CoreLifecycleService lifecycle, CancellationToken ct) => await HostyCoreApplication.RequireControlSecret(request, secret,
                () => Handle(() => lifecycle.GetDevModeAsync(appId, ct))));
        app.MapPost("/control/v1/apps/{appId}/dev-mode/{kind}", async (string appId, string kind, AppDevRequest input,
            HttpRequest request, ControlSecret secret, CoreLifecycleService lifecycle, CancellationToken ct) =>
            await HostyCoreApplication.RequireControlSecret(request, secret,
                () => Dispatch(lifecycle, appId, kind, input, new("local-operator", "cli", TrustedLocalOperator: true), ct)));
        const string root = "/api/internal/apps/{appId}/sessions/{sessionId}/dev-mode/{targetAppId}";
        app.MapGet(root, async (string appId, string sessionId, string targetAppId, HttpRequest request,
            WorkspaceAuthorization auth, AppRegistryStore apps, CoreLifecycleService lifecycle, CancellationToken ct) =>
            await Handle(async () => { await Assistant(request, appId, sessionId, auth, apps, ct); return await lifecycle.GetDevModeAsync(targetAppId, ct); }));
        app.MapGet(root + "/logs", async (string appId, string sessionId, string targetAppId, HttpRequest request,
            WorkspaceAuthorization auth, AppRegistryStore apps, CoreLifecycleService lifecycle, CancellationToken ct) =>
            await Handle(async () =>
            {
                await Assistant(request, appId, sessionId, auth, apps, ct);
                var caller = await apps.GetAppAsync(appId, ct);
                if (caller is null || !AppManagementAuthorization.HasPermission(caller, CoreAppPermissions.AppLogs))
                    throw new AppIdentityException("app_permission_required", "Reading logs requires the existing apps.logs permission.");
                return await lifecycle.GetLogsAsync(targetAppId, 100, ct);
            }));
        app.MapPost(root + "/{kind}", async (string appId, string sessionId, string targetAppId, string kind, AppDevRequest input,
            HttpRequest request, WorkspaceAuthorization auth, AppRegistryStore apps, CoreLifecycleService lifecycle, CancellationToken ct) =>
        {
            try { return await Dispatch(lifecycle, targetAppId, kind, input, await Assistant(request, appId, sessionId, auth, apps, ct), ct); }
            catch (AppIdentityException ex) { return CoreJson.Json(new ErrorResponse(ex.Code, ex.Message), AuthEndpoints.MapIdentityErrorStatus(ex.Code)); }
        });
    }

    private static async Task<AppDevActor> Assistant(HttpRequest request, string appId, string sessionId,
        WorkspaceAuthorization auth, AppRegistryStore apps, CancellationToken ct)
    {
        var owner = await auth.RequireAsync(request, appId, sessionId, ct);
        var caller = await apps.GetAppAsync(appId, ct);
        if (caller is null || !AppManagementAuthorization.HasPermission(caller, CoreAppPermissions.AppLifecycle))
            throw new AppIdentityException("app_permission_required", "Dev mode requires reviewed apps.lifecycle and apps.sources.full permissions.");
        return new(owner.UserId, "assistant:" + appId, owner);
    }

    private static Task<IResult> Dispatch(CoreLifecycleService lifecycle, string appId, string kind, AppDevRequest input,
        AppDevActor actor, CancellationToken ct) => kind switch
    {
        "plan" => Handle(() => lifecycle.PlanDevModeAsync(appId, input, actor, ct)),
        "apply" => Handle(() => lifecycle.ApplyDevModeAsync(appId, input, actor, ct)),
        _ => Task.FromResult<IResult>(CoreJson.Json(new ErrorResponse("dev_action_invalid", "Choose plan or apply."), 400)),
    };
    private static async Task<IResult> Handle<T>(Func<Task<T>> action)
    {
        try { return CoreJson.Json(await action()); }
        catch (AppIdentityException ex) { return CoreJson.Json(new ErrorResponse(ex.Code, ex.Message), AuthEndpoints.MapIdentityErrorStatus(ex.Code)); }
        catch (AppLifecycleException ex) { return CoreJson.Json(new ErrorResponse(ex.Code, ex.Message), 409); }
        catch (AppManifestException ex) { return CoreJson.Json(new ErrorResponse(ex.Code, ex.Message), 409); }
    }
}

[McpServerToolType]
internal sealed class AppDevModeMcpTools
{
    [McpServerTool(Name = "get_app_dev_mode", ReadOnly = true)]
    [Description("Inspect ordinary-data development state, previous runtime, backup, progress and recovery receipts. This is the installed app on the same Core, not a child sandbox. Requires mcp:lifecycle; reading does not mutate data.")]
    public static Task<string> Status(string appId, CoreLifecycleService lifecycle, IHttpContextAccessor accessor, CancellationToken cancellationToken)
        => Execute(async () => { Require(accessor); return CoreJson.Text(await lifecycle.GetDevModeAsync(appId, cancellationToken)); });

    [McpServerTool(Name = "plan_app_dev_mode", ReadOnly = true)]
    [Description("Prepare enter/restart/return for an ordinary app's Docker dev profile. Code stays live and uses ordinary app data/users. No commit or child Core. Enter backs up managed data; Return never restores data. Supply stable UUID requestId; inspect changes/outsideBackup and preserve the digest. A worktree needs direct mcp:workspaces authority in addition to mcp:lifecycle. acceptDataChanges explicitly accepts compatibility of current data with the old runtime on Return.")]
    public static Task<string> Plan(string appId, string requestId, string action, CoreLifecycleService lifecycle,
        IHttpContextAccessor accessor, ExternalWorkspaceMcpAuthorization authorization, DevelopmentWorkspaceService workspaces,
        CancellationToken cancellationToken, string? targetRuntime = null, string? worktreeId = null,
        string? planDigest = null, bool acceptDataChanges = false)
        => Execute(async () =>
        {
            var request = new AppDevRequest(requestId, action, targetRuntime, worktreeId, planDigest, acceptDataChanges);
            return CoreJson.Text(await lifecycle.PlanDevModeAsync(appId, request,
                await Actor(appId, request, lifecycle, accessor, authorization, workspaces, cancellationToken), cancellationToken));
        });

    [McpServerTool(Name = "apply_app_dev_mode", ReadOnly = false, Destructive = true, Idempotent = true)]
    [Description("Apply a reviewed ordinary-data dev operation under the client's configured confirmation policy. Requires mcp:lifecycle, and direct mcp:workspaces for a worktree. Send the exact prepared request with planDigest. Preserve requestId and arguments after disconnection; retry resumes the same operation, never a new trial. Return preserves current data and source edits; it does not publish or restore a backup.")]
    public static Task<string> Apply(string appId, string requestId, string action, CoreLifecycleService lifecycle,
        IHttpContextAccessor accessor, ExternalWorkspaceMcpAuthorization authorization, DevelopmentWorkspaceService workspaces,
        CancellationToken cancellationToken, string? targetRuntime = null, string? worktreeId = null,
        string? planDigest = null, bool acceptDataChanges = false)
        => Execute(async () =>
        {
            var request = new AppDevRequest(requestId, action, targetRuntime, worktreeId, planDigest, acceptDataChanges);
            return CoreJson.Text(await lifecycle.ApplyDevModeAsync(appId, request,
                await Actor(appId, request, lifecycle, accessor, authorization, workspaces, cancellationToken), cancellationToken));
        });

    private static McpCallerGrants Require(IHttpContextAccessor accessor)
        => accessor.HttpContext?.Items[McpCallerGrants.Key] is McpCallerGrants { Lifecycle: true } caller ? caller
            : throw new AppIdentityException("dev_authority_required", "Direct mcp:lifecycle authority is required; read-only and delegated credentials cannot switch runtime.");
    private static async Task<AppDevActor> Actor(string appId, AppDevRequest input, CoreLifecycleService lifecycle,
        IHttpContextAccessor accessor, ExternalWorkspaceMcpAuthorization authorization, DevelopmentWorkspaceService workspaces, CancellationToken ct)
    {
        var caller = Require(accessor);
        var id = input.WorktreeId ?? (input.Action == "enter" ? null : (await lifecycle.GetDevModeAsync(appId, ct)).WorktreeId);
        WorkspaceOwner? owner = null;
        if (id is not null)
        {
            var external = await authorization.RequireAsync(accessor.HttpContext, ct);
            var tree = await workspaces.Read(id, null, ct);
            if (!external.Owns(tree.Owner)) throw new AppIdentityException("workspace_forbidden", "This credential does not own the worktree.");
            owner = tree.Owner;
        }
        return new(caller.ActorUserId, "direct-mcp", owner);
    }
    private static async Task<string> Execute(Func<Task<string>> action)
    {
        try { return await action(); }
        catch (AppIdentityException ex) { return CoreJson.Text(new ErrorResponse(ex.Code, ex.Message)); }
        catch (AppLifecycleException ex) { return CoreJson.Text(new ErrorResponse(ex.Code, ex.Message)); }
        catch (AppManifestException ex) { return CoreJson.Text(new ErrorResponse(ex.Code, ex.Message)); }
    }
}

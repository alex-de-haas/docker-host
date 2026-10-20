using System.ComponentModel;
using Haas.Hosty.Launch;
using ModelContextProtocol.Server;

namespace Haas.Hosty.Core;

internal static class AppExecutionTargetEndpoints
{
    internal static void Map(WebApplication app)
    {
        app.MapPost("/api/development/workspaces/{workspaceId}/execution-recipe", (string workspaceId,
            WorkspaceRecipeRequest input, HttpRequest request, UserDirectoryStore users, IClock clock,
            CoreLifecycleService lifecycle, CancellationToken ct) => WithActor(request, users, clock,
                actor => Handle(() => lifecycle.ConfigureWorkspaceRecipeAsync(workspaceId, input, actor.UserId, null, ct)), true, ct));
        app.MapPost("/api/internal/apps/{appId}/workspace-inspection/{workspaceId}/execution-recipe",
            (string appId, string workspaceId, WorkspaceRecipeRequest input, HttpRequest request,
                WorkspaceInspectionAuthorization auth, CoreLifecycleService lifecycle, CancellationToken ct) => Handle(async () =>
                    await lifecycle.ConfigureWorkspaceRecipeAsync(workspaceId, input, await auth.RequireAsync(request, appId, ct, true), null, ct)));
        app.MapGet("/api/apps/execution-targets", (HttpRequest request, UserDirectoryStore users, IClock clock,
            AppExecutionTargetService targets, CancellationToken ct) =>
            WithActor(request, users, clock, actor => Handle(() => targets.InventoryAsync(actor.UserId, ct)), false, ct));
        app.MapGet("/api/apps/{appId}/execution-targets", (string appId, HttpRequest request, UserDirectoryStore users,
            IClock clock, AppExecutionTargetService targets, CancellationToken ct) =>
            WithActor(request, users, clock, actor => Handle(() => targets.ChoicesAsync(appId, actor.UserId, ct)), false, ct));
        app.MapPost("/api/apps/{appId}/execution-target", (string appId, AppExecutionTargetRequest input,
            HttpRequest request, UserDirectoryStore users, IClock clock, AppExecutionTargetService targets, CancellationToken ct) =>
            WithActor(request, users, clock, actor => Handle(() => targets.SubmitAsync(appId, input, actor, ct)), true, ct));
        app.MapGet("/api/apps/{appId}/execution-target/{requestId}", (string appId, string requestId,
            HttpRequest request, UserDirectoryStore users, IClock clock, AppExecutionTargetService targets, CancellationToken ct) =>
            WithActor(request, users, clock, actor => Handle(() => targets.StatusAsync(appId, requestId, actor.UserId, ct)), false, ct));
        app.MapPost("/api/development/workspaces/{workspaceId}/execution-target", (string workspaceId,
            AppExecutionTargetRequest input, HttpRequest request, UserDirectoryStore users, IClock clock,
            AppExecutionTargetService targets, CancellationToken ct) =>
            WithActor(request, users, clock, actor => Handle(() => targets.SubmitWorkspaceAsync(workspaceId, input, actor, ct)), true, ct));
        app.MapGet("/api/development/workspaces/{workspaceId}/execution-target/{requestId}", (string workspaceId,
            string requestId, HttpRequest request, UserDirectoryStore users, IClock clock,
            AppExecutionTargetService targets, CancellationToken ct) =>
            WithActor(request, users, clock, actor => Handle(() => targets.WorkspaceStatusAsync(workspaceId, requestId, actor.UserId, ct)), false, ct));
        app.MapPost("/api/internal/apps/{appId}/workspace-inspection/{workspaceId}/execution-target",
            (string appId, string workspaceId, AppExecutionTargetRequest input, HttpRequest request,
                WorkspaceInspectionAuthorization auth, AppRegistryStore apps, AppExecutionTargetService targets, CancellationToken ct) =>
                Handle(async () => await targets.SubmitWorkspaceAsync(workspaceId, input,
                    await AppActor(appId, request, auth, apps, true, ct), ct)));
        app.MapGet("/api/internal/apps/{appId}/workspace-inspection/{workspaceId}/execution-target/{requestId}",
            (string appId, string workspaceId, string requestId, HttpRequest request,
                WorkspaceInspectionAuthorization auth, AppRegistryStore apps, AppExecutionTargetService targets, CancellationToken ct) =>
                Handle(async () => await targets.WorkspaceStatusAsync(workspaceId, requestId,
                    (await AppActor(appId, request, auth, apps, false, ct)).UserId, ct)));
        app.MapPost("/api/internal/apps/{appId}/sessions/{sessionId}/execution-target/{targetAppId}",
            (string appId, string sessionId, string targetAppId, AppExecutionTargetRequest input, HttpRequest request,
                WorkspaceAuthorization auth, AppRegistryStore apps, DevelopmentWorkspaceService workspaces,
                AppExecutionTargetService targets, CancellationToken ct) => Handle(async () =>
                {
                    var owner = await auth.RequireAsync(request, appId, sessionId, ct);
                    if (input.Kind == "workspace")
                    {
                        var trees = (await workspaces.ListAsync(owner, false, ct)).Workspaces;
                        if (!trees.Any(t => t.WorkspaceId == input.WorkspaceId && (input.WorktreeId is null || t.Id == input.WorktreeId)))
                            throw new AppIdentityException("workspace_forbidden", "Use this session's workspace.");
                    }
                    var caller = await apps.GetAppAsync(appId, ct) ?? throw WorkspaceActivationAccess.Denied();
                    return await targets.SubmitAsync(targetAppId, input, new(owner.UserId, "assistant:" + appId, appId,
                        caller.InstalledAt, AppIdentityHash: AppIdentityService.HashToken(request.Headers["X-Hosty-User-Token"].ToString())), ct);
                }));
        app.MapGet("/api/internal/apps/{appId}/sessions/{sessionId}/execution-target/{targetAppId}/{requestId}",
            (string appId, string sessionId, string targetAppId, string requestId, HttpRequest request,
                WorkspaceAuthorization auth, AppExecutionTargetService targets, CancellationToken ct) => Handle(async () =>
                await targets.StatusAsync(targetAppId, requestId, (await auth.RequireAsync(request, appId, sessionId, ct)).UserId, ct)));
        app.MapGet("/control/v1/apps/{appId}/execution-targets", (string appId, HttpRequest request,
            ControlSecret secret, UserDirectoryStore users, AppExecutionTargetService targets, CancellationToken ct) =>
            HostyCoreApplication.RequireControlSecret(request, secret, () => Handle(async () =>
                await targets.ChoicesAsync(appId, await LocalUser(users, ct), ct))));
        app.MapPost("/control/v1/apps/{appId}/execution-target", (string appId, AppExecutionTargetRequest input,
            HttpRequest request, ControlSecret secret, UserDirectoryStore users, AppExecutionTargetService targets, CancellationToken ct) =>
            HostyCoreApplication.RequireControlSecret(request, secret, () => Handle(async () =>
                await targets.SubmitAsync(appId, input, new(await LocalUser(users, ct), "local-control", Principal: "local-control"), ct))));
        app.MapGet("/control/v1/apps/{appId}/execution-target/{requestId}", (string appId, string requestId,
            HttpRequest request, ControlSecret secret, UserDirectoryStore users, AppExecutionTargetService targets, CancellationToken ct) =>
            HostyCoreApplication.RequireControlSecret(request, secret, () => Handle(async () =>
                await targets.StatusAsync(appId, requestId, await LocalUser(users, ct), ct))));
    }

    private static async Task<string> LocalUser(UserDirectoryStore users, CancellationToken ct) =>
        (await users.ReadAsync(ct)).Users.FirstOrDefault(u => !u.Disabled && AppAccessPolicy.IsAdmin(u))?.Id
            ?? throw new AppIdentityException("admin_required", "Set up an administrator before selecting an execution target.");

    private static Task<IResult> WithActor(HttpRequest request, UserDirectoryStore users, IClock clock,
        Func<WorkspaceActivationActor, Task<IResult>> action, bool mutation, CancellationToken ct) =>
        CoreSessionAuthorization.RequireSessionAsync(request, users, clock, user =>
            AppAccessPolicy.IsAdmin(user) ? action(AppManagementAuthorization.Caller(request) is { } caller
                ? new(user.Id, "app:" + caller.App.Id, caller.App.Id, caller.App.InstalledAt,
                    AppIdentityHash: AppIdentityService.HashToken(request.Headers[AppManagementAuthorization.IdentityHeader].ToString()))
                : new(user.Id, "manual", Principal: "browser:" + DevelopmentWorkspaceService.Hash(CoreSessionAuthorization.ReadSessionId(request)!)))
                : Task.FromResult<IResult>(CoreJson.Json(new ErrorResponse("admin_required", "An administrator is required."), 403)),
            requireCsrf: mutation, cancellationToken: ct);

    private static async Task<WorkspaceActivationActor> AppActor(string appId, HttpRequest request,
        WorkspaceInspectionAuthorization auth, AppRegistryStore apps, bool manage, CancellationToken ct)
    {
        var user = await auth.RequireAsync(request, appId, ct, manage);
        var caller = await apps.GetAppAsync(appId, ct) ?? throw WorkspaceActivationAccess.Denied();
        return new(user, "app:" + appId, appId, caller.InstalledAt,
            AppIdentityHash: AppIdentityService.HashToken(request.Headers["X-Hosty-User-Token"].ToString()));
    }

    internal static async Task<IResult> Handle<T>(Func<Task<T>> action)
    {
        try { return CoreJson.Json(await action()); }
        catch (AppIdentityException ex) { return CoreJson.Json(new ErrorResponse(ex.Code, ex.Message), AuthEndpoints.MapIdentityErrorStatus(ex.Code)); }
        catch (AppLifecycleException ex) { return CoreJson.Json(new ErrorResponse(ex.Code, ex.Message), ex.Code.EndsWith("_not_found", StringComparison.Ordinal) ? 404 : 409); }
        catch (AppManifestException ex) { return CoreJson.Json(new ErrorResponse(ex.Code, ex.Message), 409); }
        catch (ArgumentException ex) { return CoreJson.Json(new ErrorResponse("execution_invalid", ex.Message), 400); }
    }
}

[McpServerToolType]
internal sealed class AppExecutionTargetMcpTools(IHttpContextAccessor accessor, ExternalWorkspaceMcpAuthorization authorization,
    AppExecutionTargetService targets, CoreLifecycleService lifecycle)
{
    [McpServerTool(Name = "get_app_execution_targets", ReadOnly = true)]
    [Description("Read installed package runtimes and named workspaces for an app. Development recipes are internal. Requires direct workspace authority.")]
    public Task<string> Choices(string appId, CancellationToken cancellationToken) => Run(async actor =>
        CoreJson.Text(await targets.ChoicesAsync(appId, actor.UserId, cancellationToken, actor.Principal)), cancellationToken);

    [McpServerTool(Name = "select_app_execution_target", ReadOnly = false, Destructive = true, Idempotent = true)]
    [Description("Select a package runtime or owned named workspace on this Core's ordinary data. One selection prepares and switches internally; selecting package returns to the installed package. Requires direct workspace and lifecycle authority. Preserve requestId and exact arguments after disconnection. Additional access returns review-required with Core confirmation input; no routine compatibility acknowledgement is required.")]
    public Task<string> Select(string appId, AppExecutionTargetRequest input, CancellationToken cancellationToken) =>
        Run(async actor => CoreJson.Text(await targets.SubmitAsync(appId, input, actor, cancellationToken)), cancellationToken);

    [McpServerTool(Name = "get_app_execution_selection", ReadOnly = true)]
    [Description("Recover the status of a retained execution selection using its original requestId. Does not repeat completed runtime changes.")]
    public Task<string> Status(string appId, string requestId, CancellationToken cancellationToken) =>
        Run(async actor => CoreJson.Text(await targets.StatusAsync(appId, requestId, actor.UserId, cancellationToken)), cancellationToken);

    [McpServerTool(Name = "select_workspace_execution", ReadOnly = false, Destructive = true, Idempotent = true)]
    [Description("Use an owned workspace's associated apps, or return its currently active apps to their package runtimes. Sandboxes and Core itself are separate. Preserve requestId; completed children are skipped on retry. Requires direct workspace/lifecycle authority.")]
    public Task<string> SelectWorkspace(string workspaceId, AppExecutionTargetRequest input, CancellationToken cancellationToken) =>
        Run(async actor => CoreJson.Text(await targets.SubmitWorkspaceAsync(workspaceId, input, actor, cancellationToken)), cancellationToken);

    [McpServerTool(Name = "get_workspace_execution_selection", ReadOnly = true)]
    [Description("Inspect per-app results of a retained workspace execution selection using its original requestId.")]
    public Task<string> WorkspaceStatus(string workspaceId, string requestId, CancellationToken cancellationToken) =>
        Run(async actor => CoreJson.Text(await targets.WorkspaceStatusAsync(workspaceId, requestId, actor.UserId, cancellationToken)), cancellationToken);

    [McpServerTool(Name = "configure_workspace_runtime", ReadOnly = false, Destructive = false, Idempotent = true)]
    [Description("Configure an owned app-bound workspace's internal development recipe without switching or restarting its app. Use once when multiple recipes need selection. Requires source workspace authority, not lifecycle. Supply requestId and preserve it on retry.")]
    public async Task<string> ConfigureRuntime(string workspaceId, WorkspaceRecipeRequest input, CancellationToken cancellationToken) => await Run(async actor =>
            CoreJson.Text(await lifecycle.ConfigureWorkspaceRecipeAsync(workspaceId, input, actor.UserId, actor.Principal, cancellationToken)), cancellationToken);

    private async Task<string> Run(Func<WorkspaceActivationActor, Task<string>> action, CancellationToken ct)
    {
        try
        {
            var caller = await authorization.RequireAsync(accessor.HttpContext, ct);
            return await action(new(caller.UserId, "direct-mcp", Principal: caller.PrincipalId));
        }
        catch (AppIdentityException ex) { return CoreJson.Text(new ErrorResponse(ex.Code, ex.Message)); }
        catch (AppLifecycleException ex) { return CoreJson.Text(new ErrorResponse(ex.Code, ex.Message)); }
        catch (AppManifestException ex) { return CoreJson.Text(new ErrorResponse(ex.Code, ex.Message)); }
    }
}

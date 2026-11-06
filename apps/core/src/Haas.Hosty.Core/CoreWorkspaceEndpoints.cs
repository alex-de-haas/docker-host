namespace Haas.Hosty.Core;

internal static class CoreWorkspaceEndpoints
{
    public static void Map(WebApplication app)
    {
        app.MapGet("/api/development/activation-workspaces", (HttpRequest request, UserDirectoryStore users, IClock clock,
            WorkspaceInspectionService inspection, CancellationToken ct) => CoreSessionAuthorization.RequireSessionAsync(request, users, clock,
                user => AppAccessPolicy.IsAdmin(user) ? Handle(() => inspection.ListAsync(user.Id, ct))
                    : Task.FromResult<IResult>(CoreJson.Json(new ErrorResponse("admin_required", "An administrator is required."), 403)), cancellationToken: ct));
        app.MapGet("/api/core/execution-targets", (HttpRequest request, UserDirectoryStore users, IClock clock,
            CoreExecutionTargetService targets, WorkspaceActivationAccess access, CancellationToken ct) =>
            CoreSessionAuthorization.RequireSessionAsync(request, users, clock, user =>
                AppAccessPolicy.IsAdmin(user) ? Handle(async () =>
                {
                    var actor = AppManagementAuthorization.Caller(request) is { } caller
                        ? new Haas.Hosty.Launch.WorkspaceActivationActor(user.Id, "app:" + caller.App.Id, caller.App.Id, caller.App.InstalledAt,
                            AppIdentityHash: AppIdentityService.HashToken(request.Headers[AppManagementAuthorization.IdentityHeader].ToString()))
                        : new(user.Id, "manual", Principal: "browser:" + DevelopmentWorkspaceService.Hash(CoreSessionAuthorization.ReadSessionId(request)!));
                    // Match activation/list authority without admitting a lifecycle operation.
                    await access.ValidateAsync(actor, false, ct);
                    return await targets.InventoryAsync(user.Id, ct);
                }) : Task.FromResult<IResult>(CoreJson.Json(new ErrorResponse("admin_required", "An administrator is required."), 403)),
                cancellationToken: ct));
        app.MapPost("/api/development/workspaces/{workspaceId}/activation/{kind}", (string workspaceId, string kind,
            WorkspaceActivationCommand input, HttpRequest request, UserDirectoryStore users, IClock clock,
            WorkspaceActivationActions actions, CancellationToken ct) => CoreSessionAuthorization.RequireSessionAsync(request, users, clock,
                user => AppAccessPolicy.IsAdmin(user) ? HandleResult(() => actions.RunAsync(workspaceId, kind, input,
                    AppManagementAuthorization.Caller(request) is { } caller
                        ? new(user.Id, "app:" + caller.App.Id, caller.App.Id, caller.App.InstalledAt, AppIdentityHash: AppIdentityService.HashToken(request.Headers[AppManagementAuthorization.IdentityHeader].ToString()))
                        : new(user.Id, "manual", Principal: "browser:" + DevelopmentWorkspaceService.Hash(CoreSessionAuthorization.ReadSessionId(request)!)), ct))
                    : Task.FromResult<IResult>(CoreJson.Json(new ErrorResponse("admin_required", "An administrator is required."), 403)),
                requireCsrf: true, cancellationToken: ct));
        app.MapPost("/api/internal/apps/{appId}/workspace-inspection/{workspaceId}/activation/{kind}",
            (string appId, string workspaceId, string kind, WorkspaceActivationCommand input, HttpRequest request,
                WorkspaceInspectionAuthorization auth, AppRegistryStore apps, WorkspaceActivationActions actions, CancellationToken ct) =>
            HandleResult(async () =>
            {
                var user = await auth.RequireAsync(request, appId, ct, manage: kind is not ("list" or "status"));
                var caller = await apps.GetAppAsync(appId, ct) ?? throw WorkspaceActivationAccess.Denied();
                return await actions.RunAsync(workspaceId, kind, input, new(user, "app:" + appId, appId, caller.InstalledAt, AppIdentityHash: AppIdentityService.HashToken(request.Headers["X-Hosty-User-Token"].ToString())), ct);
            }));
        app.MapPost("/api/internal/apps/{appId}/sessions/{sessionId}/workspace-activation/{workspaceId}/{kind}",
            (string appId, string sessionId, string workspaceId, string kind, WorkspaceActivationCommand input, HttpRequest request,
                WorkspaceAuthorization auth, WorkspaceInspectionService inspection, AppRegistryStore apps,
                WorkspaceActivationActions actions, CancellationToken ct) => HandleResult(async () =>
            {
                var owner = await auth.RequireAsync(request, appId, sessionId, ct);
                var actual = await inspection.WorkflowOwnerAsync(workspaceId, owner.UserId, ct);
                if (!owner.SameIdentity(actual)) throw WorkspaceActivationAccess.Denied();
                var caller = await apps.GetAppAsync(appId, ct) ?? throw WorkspaceActivationAccess.Denied();
                return await actions.RunAsync(workspaceId, kind, input, new(owner.UserId, "assistant:" + appId, appId, caller.InstalledAt, AppIdentityHash: AppIdentityService.HashToken(request.Headers["X-Hosty-User-Token"].ToString())), ct);
            }));
        // Local operator composition only. Delegated Harness/MCP activation authority is a separate contract.
        app.MapPost("/control/v1/workspaces/{workspaceId}/activation/prepare", (string workspaceId,
            WorkspaceActivationRequest input, HttpRequest request, ControlSecret secret,
            WorkspaceActivationService activations, CancellationToken ct) =>
            HostyCoreApplication.RequireControlSecret(request, secret, () => Handle(() => activations.PrepareAsync(workspaceId, input, ct))));
        app.MapPost("/control/v1/workspace-activations/{id}/apply-apps", (string id, HttpRequest request,
            ControlSecret secret, WorkspaceActivationService activations, CancellationToken ct) =>
            HostyCoreApplication.RequireControlSecret(request, secret, () => Handle(() => activations.ApplyAppsAsync(id, ct))));
        app.MapPost("/control/v1/workspace-activations/{id}/release-preparation", (string id, HttpRequest request,
            ControlSecret secret, WorkspaceActivationService activations, CancellationToken ct) =>
            HostyCoreApplication.RequireControlSecret(request, secret, () => Handle(() => activations.ReleasePreparationAsync(id, ct))));
        app.MapGet("/control/v1/workspace-activations/{id}", (string id, HttpRequest request,
            ControlSecret secret, WorkspaceActivationService activations, CancellationToken ct) =>
            HostyCoreApplication.RequireControlSecret(request, secret, () => Handle(() => activations.StatusAsync(id, ct))));
        app.MapPost("/control/v1/workspace-activations/{id}/verify-apps", (string id, HttpRequest request,
            ControlSecret secret, WorkspaceActivationService activations, CancellationToken ct) =>
            HostyCoreApplication.RequireControlSecret(request, secret, () => Handle(() => activations.VerifyAppsAsync(id, ct))));
        app.MapPost("/control/v1/workspace-activations/{id}/start", (string id, HttpRequest request,
            ControlSecret secret, WorkspaceActivationRecovery recovery) =>
            HostyCoreApplication.RequireControlSecret(request, secret, () => Handle(() => Task.FromResult(recovery.Dispatch(id)))));
        app.MapPost("/control/v1/workspace-activations/{id}/cancel", (string id, HttpRequest request,
            ControlSecret secret, CoreDataPaths paths) =>
            HostyCoreApplication.RequireControlSecret(request, secret, () => Handle(() => Task.FromResult(
                Haas.Hosty.Launch.WorkspaceActivationSupervisor.Cancel(paths.DataRoot, id)))));
        app.MapPost("/control/v1/workspace-activations/{id}/return", (string id, Haas.Hosty.Launch.WorkspaceReturnRequest input,
            HttpRequest request, ControlSecret secret, WorkspaceActivationService activations, CancellationToken ct) =>
            HostyCoreApplication.RequireControlSecret(request, secret, () => Handle(() => activations.PrepareReturnAsync(id, input, ct))));
        app.MapPost("/control/v1/workspace-activations/{id}/validate-authority", (string id, HttpRequest request,
            ControlSecret secret, WorkspaceActivationService activations, CancellationToken ct) =>
            HostyCoreApplication.RequireControlSecret(request, secret, () => Handle(() => activations.ValidateRuntimeAuthorityAsync(id, ct))));
        app.MapPost("/control/v1/workspace-activations/{id}/restore-app", (string id, Haas.Hosty.Launch.WorkspaceReturnAppMutation input,
            HttpRequest request, ControlSecret secret, WorkspaceActivationService activations, CancellationToken ct) =>
            HostyCoreApplication.RequireControlSecret(request, secret, () => Handle(() => activations.RestoreReturnAppAsync(id, input, ct))));
        app.MapPost("/control/v1/workspace-activations/{id}/return-apps", (string id, HttpRequest request,
            ControlSecret secret, WorkspaceActivationService activations, CancellationToken ct) =>
            HostyCoreApplication.RequireControlSecret(request, secret, () => Handle(() => activations.ReturnAppsAsync(id, ct))));
        app.MapPost("/api/core/source/prepare", (HttpRequest request, CoreSourcePrepare input,
            UserDirectoryStore users, IClock clock, CoreDevelopmentService core, HostyCoreRuntimeConfig config,
            CancellationToken ct) => CoreSessionAuthorization.RequireAdminSessionAsync(request, users, clock,
                () => Handle(async () =>
                {
                    var actor = await CoreSessionAuthorization.TryResolveSessionAsync(request, users, clock, ct);
                    using var sourceLock = Haas.Hosty.Launch.CoreLaunchFiles.Lock(config.DataRoot);
                    Haas.Hosty.Launch.CoreLaunchFiles.AssertNoPendingOperations(config.DataRoot);
                    var source = await core.SourceSettingsAsync(ct);
                    if (source.Revision != input.SourceRevision) throw new InvalidOperationException("Core source changed; refresh before preparation.");
                    return new CoreSourcePrepared(await core.PrepareSourceAsync(source, ct, actor: actor!.Id), source.Revision);
                }), requireCsrf: true, cancellationToken: ct));

        app.MapPost("/api/core/source/workspaces", (HttpRequest request, CoreWorkspacePrepare input,
            UserDirectoryStore users, IClock clock, DevelopmentWorkspaceService workspaces,
            CancellationToken ct) => CoreSessionAuthorization.RequireAdminSessionAsync(request, users, clock,
                () => Handle(async () =>
                {
                    var actor = await CoreSessionAuthorization.TryResolveSessionAsync(request, users, clock, ct);
                    var owner = WorkspaceOwner.ForExternal(actor!.Id, "operator:" + actor.Id, input.TaskId,
                        ExternalWorkspaceMcpAuthorization.NormalizeLabel(input.Label ?? "Core development"));
                    return await workspaces.PrepareCoreSourceAsync(owner, input, ct);
                }), requireCsrf: true, cancellationToken: ct));

        app.MapPost("/api/development/workspaces/{workspaceId}/activation-plan",
            (string workspaceId, HttpRequest request, WorkspaceActivationSelection input,
                UserDirectoryStore users, IClock clock, WorkspaceActivationPlanner planner,
                CancellationToken ct) => CoreSessionAuthorization.RequireAdminSessionAsync(request, users, clock,
                () => Handle(async () =>
                {
                    var actor = await CoreSessionAuthorization.TryResolveSessionAsync(request, users, clock, ct);
                    return await planner.PlanAsync(workspaceId, actor!.Id, input, ct);
                }), requireCsrf: true, cancellationToken: ct));
    }

    internal static async Task<IResult> HandleResult(Func<Task<IResult>> action)
    {
        try { return await action(); }
        catch (SandboxException ex) { return CoreJson.Json(new ErrorResponse(ex.Code, ex.Message), ex.Status); }
        catch (AppIdentityException ex) { return CoreJson.Json(new ErrorResponse(ex.Code, ex.Message), AuthEndpoints.MapIdentityErrorStatus(ex.Code)); }
        catch (AppLifecycleException ex) { return CoreJson.Json(new ErrorResponse(ex.Code, ex.Message), 409); }
        catch (ArgumentException ex) { return CoreJson.Json(new ErrorResponse("invalid_request", ex.Message), 400); }
        catch (Exception ex) when (ex is IOException or InvalidOperationException or OperationCanceledException)
        { return CoreJson.Json(new ErrorResponse("activation_recovery_required", ex.Message), 409); }
    }

    internal static async Task<IResult> Handle<T>(Func<Task<T>> action)
    {
        try { return CoreJson.Json(await action()); }
        catch (OperationCanceledException ex) { return CoreJson.Json(new ErrorResponse("activation_paused", ex.Message), statusCode: 409); }
        catch (ArgumentException ex) { return CoreJson.Json(new ErrorResponse("invalid_request", ex.Message), statusCode: 400); }
        catch (SandboxException ex) { return CoreJson.Json(new ErrorResponse(ex.Code, ex.Message), ex.Status); }
        catch (AppIdentityException ex) { return CoreJson.Json(new ErrorResponse(ex.Code, ex.Message), statusCode: AuthEndpoints.MapIdentityErrorStatus(ex.Code)); }
        catch (AppLifecycleException ex) { return CoreJson.Json(new ErrorResponse(ex.Code, ex.Message), statusCode: 409); }
        catch (Exception ex) when (ex is IOException or InvalidOperationException)
        { return CoreJson.Json(new ErrorResponse("core_source_failed", ex.Message), statusCode: 409); }
    }
}

internal sealed record CoreSourcePrepare(string SourceRevision);
internal sealed record CoreSourcePrepared(string ProjectPath, string SourceRevision);

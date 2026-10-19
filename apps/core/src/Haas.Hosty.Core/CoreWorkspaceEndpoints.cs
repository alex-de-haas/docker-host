namespace Haas.Hosty.Core;

internal static class CoreWorkspaceEndpoints
{
    public static void Map(WebApplication app)
    {
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

    private static async Task<IResult> Handle<T>(Func<Task<T>> action)
    {
        try { return CoreJson.Json(await action()); }
        catch (ArgumentException ex) { return CoreJson.Json(new ErrorResponse("invalid_request", ex.Message), statusCode: 400); }
        catch (AppLifecycleException ex) { return CoreJson.Json(new ErrorResponse(ex.Code, ex.Message), statusCode: 409); }
        catch (Exception ex) when (ex is IOException or InvalidOperationException)
        { return CoreJson.Json(new ErrorResponse("core_source_failed", ex.Message), statusCode: 409); }
    }
}

internal sealed record CoreSourcePrepare(string SourceRevision);
internal sealed record CoreSourcePrepared(string ProjectPath, string SourceRevision);

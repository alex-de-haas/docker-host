namespace Haas.Hosty.Core;

internal static class SandboxEndpoints
{
    public static void Map(WebApplication app)
    {
        var routes = app.MapGroup("").AddEndpointFilter(async (context, next) =>
        {
            context.HttpContext.Response.Headers.CacheControl = "no-store";
            return await next(context);
        });
        const string appRoot = "/api/internal/apps/{appId}/sandbox-instances";
        routes.MapPost(appRoot + "/plans", async (string appId, SandboxPlanRequest input, HttpRequest request,
            SandboxAuthorization auth, SandboxService service, CancellationToken ct) => await Handle(async () =>
                await service.PlanAsync(await auth.RequireAsync(request, appId, "plan", null, input, null, ct), input, ct)));
        routes.MapPost(appRoot, async (string appId, SandboxPrepareRequest input, HttpRequest request,
            SandboxAuthorization auth, SandboxService service, CancellationToken ct) => await Handle(async () =>
                await service.PrepareAsync(await auth.RequireAsync(request, appId, "prepare", null, null, input.PlanId, ct), input, ct)));
        routes.MapGet(appRoot, async (string appId, HttpRequest request, SandboxAuthorization auth, SandboxService service,
            CancellationToken ct) => await Handle(async () =>
                await service.ListAsync(await auth.RequireAsync(request, appId, "read", null, null, null, ct), ct)));
        routes.MapGet(appRoot + "/{id}", async (string appId, string id, HttpRequest request, SandboxAuthorization auth,
            SandboxService service, CancellationToken ct) => await Handle(async () =>
                await service.ReadAsync(await auth.RequireAsync(request, appId, "read", id, null, null, ct), id, ct)));
        routes.MapPost(appRoot + "/{id}/operations/{kind}", async (string appId, string id, string kind, SandboxCommand input,
            HttpRequest request, SandboxAuthorization auth, SandboxOperations operations, CancellationToken ct) => await Handle(async () =>
                await operations.CommandAsync(await auth.RequireAsync(request, appId, kind, id, null, null, ct), id, kind, input, ct)));
        routes.MapPost(appRoot + "/{id}/users", async (string appId, string id, SandboxUserRequest input,
            HttpRequest request, SandboxAuthorization auth, SandboxService service, CancellationToken ct) => await Handle(async () =>
                await service.UserAsync(await auth.RequireAsync(request, appId, "users", id, null, null, ct), id, input, ct)));
        routes.MapPost(appRoot + "/{id}/seeds", async (string appId, string id, SandboxSeedRequest input,
            HttpRequest request, SandboxAuthorization auth, SandboxService service, CancellationToken ct) => await Handle(async () =>
                await service.SeedAsync(await auth.RequireAsync(request, appId, "seed", id, null, null, ct), id, input, ct)));

        routes.MapPost(appRoot + "/{id}/users/delete", async (string appId, string id, SandboxUserDeleteRequest input,
            HttpRequest request, SandboxAuthorization auth, SandboxService service, CancellationToken ct) => await Handle(async () =>
                await service.DeleteUserAsync(await auth.RequireAsync(request, appId, "users", id, null, null, ct), id, input, ct)));
        routes.MapPost(appRoot + "/{id}/viewers", async (string appId, string id, SandboxViewersRequest input,
            HttpRequest request, SandboxAuthorization auth, SandboxService service, CancellationToken ct) => await Handle(async () =>
                await service.ViewersAsync(await auth.RequireAsync(request, appId, "viewers", id, null, null, ct), id, input, ct)));
        routes.MapPost(appRoot + "/{id}/evidence/clear", async (string appId, string id, SandboxEvidenceClearRequest input,
            HttpRequest request, SandboxAuthorization auth, SandboxService service, CancellationToken ct) => await Handle(async () =>
                await service.ClearEvidenceAsync(await auth.RequireAsync(request, appId, "evidence-clear", id, null, null, ct), id, input, ct)));
        routes.MapGet(appRoot + "/{id}/preview", async (string appId, string id, string? userId, HttpRequest request,
            SandboxAuthorization auth, SandboxService service, CancellationToken ct) => await Handle(async () =>
                await service.PreviewAsync(await auth.RequireAsync(request, appId, "read", id, null, null, ct), id, userId, ct)));
        routes.MapPost(appRoot + "/{id}/browser-runs/cancel", async (string appId, string id, SandboxBrowserCancelRequest input,
            HttpRequest request, SandboxAuthorization auth, SandboxBrowser browser, CancellationToken ct) => await Handle(async () =>
                await browser.CancelAsync(await auth.RequireAsync(request, appId, "browser-cancel", id, null, null, ct), id, input, ct)));
        routes.MapPost(appRoot + "/{id}/browser-runs", async (string appId, string id, SandboxBrowserRequest input,
            HttpRequest request, SandboxAuthorization auth, SandboxBrowser browser, CancellationToken ct) => await Handle(async () =>
                await browser.RunAsync(await auth.RequireAsync(request, appId, "browser", id, null, null, ct), id, input, ct)));
        routes.MapGet(appRoot + "/{id}/browser-runs/{jobId}", async (string appId, string id, string jobId,
            HttpRequest request, SandboxAuthorization auth, SandboxBrowser browser, CancellationToken ct) => await Handle(async () =>
                await browser.ExportAsync(await auth.RequireAsync(request, appId, "export", id, null, null, ct), id, jobId, ct)));

        routes.MapGet(appRoot + "/{id}/diagnostics", async (string appId, string id, HttpRequest request,
            SandboxAuthorization auth, SandboxService service, CancellationToken ct) => await Handle(async () =>
                await service.DiagnosticsAsync(await auth.RequireAsync(request, appId, "read", id, null, null, ct), id, ct)));
        const string root = "/api/sandbox-instances";
        routes.MapGet(root + "/{id}/diagnostics", async (string id, HttpRequest request,
            UserDirectoryStore users, IClock clock, SandboxService service, CancellationToken ct) =>
                await ReadAdmin(request, users, clock, actor => service.DiagnosticsAsync(actor, id, ct), ct));
        routes.MapPost(root + "/{id}/browser-runs", async (string id, SandboxBrowserRequest input, HttpRequest request,
            UserDirectoryStore users, IClock clock, SandboxBrowser browser, CancellationToken ct) =>
                await Admin(request, users, clock, actor => browser.RunAsync(actor, id, input, ct), ct));
        routes.MapGet(root + "/{id}/browser-runs/{jobId}", async (string id, string jobId, HttpRequest request,
            UserDirectoryStore users, IClock clock, SandboxBrowser browser, CancellationToken ct) =>
                await ReadAdmin(request, users, clock, actor => browser.ExportAsync(actor, id, jobId, ct), ct));
        routes.MapPost(root + "/{id}/users/delete", async (string id, SandboxUserDeleteRequest input, HttpRequest request,
            UserDirectoryStore users, IClock clock, SandboxService service, CancellationToken ct) =>
                await Admin(request, users, clock, actor => service.DeleteUserAsync(actor, id, input, ct), ct));
        routes.MapPost(root + "/{id}/viewers", async (string id, SandboxViewersRequest input, HttpRequest request,
            UserDirectoryStore users, IClock clock, SandboxService service, CancellationToken ct) =>
                await Admin(request, users, clock, actor => service.ViewersAsync(actor, id, input, ct), ct));
        routes.MapPost(root + "/{id}/evidence/clear", async (string id, SandboxEvidenceClearRequest input, HttpRequest request,
            UserDirectoryStore users, IClock clock, SandboxService service, CancellationToken ct) =>
                await Admin(request, users, clock, actor => service.ClearEvidenceAsync(actor, id, input, ct), ct));
        routes.MapGet(root + "/{id}/preview", async (string id, string? userId, HttpRequest request,
            UserDirectoryStore users, IClock clock, SandboxService service, CancellationToken ct) =>
                await ReadAdmin(request, users, clock, actor => service.PreviewAsync(actor, id, userId, ct), ct));
        routes.MapPost(root + "/{id}/browser-runs/cancel", async (string id, SandboxBrowserCancelRequest input, HttpRequest request,
            UserDirectoryStore users, IClock clock, SandboxBrowser browser, CancellationToken ct) =>
                await Admin(request, users, clock, actor => browser.CancelAsync(actor, id, input, ct), ct));
        routes.MapGet(root, async (HttpRequest request, UserDirectoryStore users, IClock clock, SandboxService service,
            CancellationToken ct) => await ReadAdmin(request, users, clock, actor => service.ListAsync(actor, ct), ct));
        routes.MapGet(root + "/{id}", async (string id, HttpRequest request, UserDirectoryStore users, IClock clock,
            SandboxService service, CancellationToken ct) => await ReadAdmin(request, users, clock, actor => service.ReadAsync(actor, id, ct), ct));
        routes.MapPost(root + "/plans", async (SandboxPlanRequest input, HttpRequest request, UserDirectoryStore users,
            IClock clock, SandboxService service, CancellationToken ct) => await Admin(request, users, clock, actor => service.PlanAsync(actor, input, ct), ct));
        routes.MapPost(root + "/plans/{id}/approve", async (string id, SandboxApprovalRequest input, HttpRequest request,
            UserDirectoryStore users, IClock clock, SandboxService service, CancellationToken ct) =>
                await Admin(request, users, clock, actor => service.ApproveAsync(id, input.Digest, actor, ct), ct));
        routes.MapPost(root, async (SandboxPrepareRequest input, HttpRequest request, UserDirectoryStore users,
            IClock clock, SandboxService service, CancellationToken ct) => await Admin(request, users, clock, actor => service.PrepareAsync(actor, input, ct), ct));
        routes.MapPost(root + "/{id}/operations/{kind}", async (string id, string kind, SandboxCommand input,
            HttpRequest request, UserDirectoryStore users, IClock clock, SandboxOperations operations, CancellationToken ct) =>
                await Admin(request, users, clock, actor => operations.CommandAsync(actor, id, kind, input, ct), ct));
        routes.MapPost(root + "/{id}/users", async (string id, SandboxUserRequest input, HttpRequest request,
            UserDirectoryStore users, IClock clock, SandboxService service, CancellationToken ct) =>
                await Admin(request, users, clock, actor => service.UserAsync(actor, id, input, ct), ct));
        routes.MapPost(root + "/{id}/seeds", async (string id, SandboxSeedRequest input, HttpRequest request,
            UserDirectoryStore users, IClock clock, SandboxService service, CancellationToken ct) =>
                await Admin(request, users, clock, actor => service.SeedAsync(actor, id, input, ct), ct));
    }

    private static Task<IResult> Admin<T>(HttpRequest request, UserDirectoryStore users, IClock clock,
        Func<SandboxActor, Task<T>> action, CancellationToken ct)
        => AppManagementAuthorization.Caller(request) is { } caller
            ? AppAccessPolicy.IsAdmin(caller.User) ? Handle(() => action(new(caller.User.Id)))
                : Task.FromResult<IResult>(CoreJson.Json(new ErrorResponse("admin_required", "Administrator required."), 403))
            : CoreSessionAuthorization.RequireAdminBrowserAsync(request, users, clock, user => Handle(() => action(new(user.Id))), ct);
    private static Task<IResult> ReadAdmin<T>(HttpRequest request, UserDirectoryStore users, IClock clock,
        Func<SandboxActor, Task<T>> action, CancellationToken ct)
        => CoreSessionAuthorization.RequireSessionAsync(request, users, clock, user => AppAccessPolicy.IsAdmin(user)
            ? Handle(() => action(new(user.Id))) : Task.FromResult<IResult>(CoreJson.Json(new ErrorResponse("admin_required", "Administrator required."), 403)), cancellationToken: ct);
    internal static async Task<IResult> Handle<T>(Func<Task<T>> action)
    {
        try { return CoreJson.Json(await action()); }
        catch (SandboxException ex) { return CoreJson.Json(new ErrorResponse(ex.Code, ex.Message), ex.Status); }
        catch (AppIdentityException ex) { return CoreJson.Json(new ErrorResponse(ex.Code, ex.Message), AuthEndpoints.MapIdentityErrorStatus(ex.Code)); }
        catch (AppLifecycleException ex) { return CoreJson.Json(new ErrorResponse(ex.Code, ex.Message), 409); }
        catch (AppManifestException ex) { return CoreJson.Json(new ErrorResponse(ex.Code, ex.Message), 409); }
    }
}

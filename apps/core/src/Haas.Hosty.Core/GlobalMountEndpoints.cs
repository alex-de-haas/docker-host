namespace Haas.Hosty.Core;

// Admin CRUD over the shared-mounts library. Mirrors the lifecycle endpoints: admin session (+ CSRF
// on mutations) for the Shell, control-secret variants for the CLI. Every handler returns the full
// updated list so clients always refresh to consistent state.
internal static class GlobalMountEndpoints
{
    public static void Map(WebApplication app)
    {
        app.MapGet("/api/global-mounts", async (
            HttpRequest request,
            UserDirectoryStore users,
            IClock clock,
            GlobalMountService mounts,
            CancellationToken cancellationToken) =>
            await CoreSessionAuthorization.RequireAdminSessionAsync(
                request,
                users,
                clock,
                () => Handle(async () => new GlobalMountListResponse(await mounts.ListAsync(cancellationToken))),
                cancellationToken: cancellationToken));

        app.MapPost("/api/global-mounts", async (
            HttpRequest request,
            UserDirectoryStore users,
            IClock clock,
            GlobalMountService mounts,
            GlobalMountUpsertRequest input,
            CancellationToken cancellationToken) =>
            await CoreSessionAuthorization.RequireAdminSessionAsync(
                request,
                users,
                clock,
                () => Handle(async () => new GlobalMountListResponse(await mounts.UpsertAsync(input, cancellationToken))),
                requireCsrf: true,
                cancellationToken: cancellationToken));

        app.MapDelete("/api/global-mounts/{name}", async (
            string name,
            HttpRequest request,
            UserDirectoryStore users,
            IClock clock,
            GlobalMountService mounts,
            CancellationToken cancellationToken) =>
            await CoreSessionAuthorization.RequireAdminSessionAsync(
                request,
                users,
                clock,
                () => Handle(async () => new GlobalMountListResponse(await mounts.DeleteAsync(name, ReadForce(request), cancellationToken))),
                requireCsrf: true,
                cancellationToken: cancellationToken));

        app.MapGet("/control/v1/global-mounts", async (
            HttpRequest request,
            ControlSecret secret,
            GlobalMountService mounts,
            CancellationToken cancellationToken) =>
            await HostyCoreApplication.RequireControlSecret(request, secret, () =>
                Handle(async () => new GlobalMountListResponse(await mounts.ListAsync(cancellationToken)))));

        app.MapPost("/control/v1/global-mounts", async (
            HttpRequest request,
            ControlSecret secret,
            GlobalMountService mounts,
            GlobalMountUpsertRequest input,
            CancellationToken cancellationToken) =>
            await HostyCoreApplication.RequireControlSecret(request, secret, () =>
                Handle(async () => new GlobalMountListResponse(await mounts.UpsertAsync(input, cancellationToken)))));

        app.MapDelete("/control/v1/global-mounts/{name}", async (
            string name,
            HttpRequest request,
            ControlSecret secret,
            GlobalMountService mounts,
            CancellationToken cancellationToken) =>
            await HostyCoreApplication.RequireControlSecret(request, secret, () =>
                Handle(async () => new GlobalMountListResponse(await mounts.DeleteAsync(name, ReadForce(request), cancellationToken)))));
    }

    private static bool ReadForce(HttpRequest request)
        => string.Equals(request.Query["force"], "true", StringComparison.OrdinalIgnoreCase);

    private static async Task<IResult> Handle<T>(Func<Task<T>> action)
    {
        try
        {
            return CoreJson.Json(await action());
        }
        catch (AppLifecycleException ex)
        {
            var statusCode = ex.Code switch
            {
                "global_mount_not_found" => StatusCodes.Status404NotFound,
                "global_mount_in_use" => StatusCodes.Status409Conflict,
                _ => StatusCodes.Status400BadRequest,
            };
            return CoreJson.Json(new ErrorResponse(ex.Code, ex.Message), statusCode: statusCode);
        }
    }
}

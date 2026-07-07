namespace Haas.Hosty.Core;

// Marketplace catalog API. Two planes, same handlers: session-authenticated `/api/catalog/*` for the
// Shell (admin session, CSRF on mutations) and control-secret `/control/v1/catalog/*` for the CLI. Reads
// are best-effort — an unreachable/misconfigured source degrades to an empty catalog rather than an
// error, so they never surface transport failures. Clients drive install/update by passing a version's
// `manifestRef` to the existing reviewed install/update endpoints — the catalog installs nothing itself.
// Source management (WS7 federation) is runtime-mutable and takes effect on the next storefront fetch, no
// Core restart. See docs/features/runtime-app-marketplace.md (B2, Q1, WS4, WS7).
internal static class CatalogEndpoints
{
    public static void Map(WebApplication app)
    {
        // ---- Storefront reads (session plane for the Shell) --------------------------------------

        // The storefront directory across all configured sources (empty when none are configured).
        app.MapGet("/api/catalog/apps", async (
            HttpRequest request,
            UserDirectoryStore users,
            IClock clock,
            CatalogService catalog,
            CancellationToken cancellationToken) =>
            await CoreSessionAuthorization.RequireAdminSessionAsync(
                request,
                users,
                clock,
                async () => CoreJson.Json(await catalog.GetAppsAsync(cancellationToken)),
                cancellationToken: cancellationToken));

        // One catalog app's detail: display metadata + resolved feed versions + install/update state.
        // 404 when no configured source lists the id.
        app.MapGet("/api/catalog/apps/{id}", async (
            string id,
            HttpRequest request,
            UserDirectoryStore users,
            IClock clock,
            CatalogService catalog,
            CancellationToken cancellationToken) =>
            await CoreSessionAuthorization.RequireAdminSessionAsync(
                request,
                users,
                clock,
                async () => await AppDetailResultAsync(catalog, id, cancellationToken),
                cancellationToken: cancellationToken));

        // ---- Source management (session plane for the Shell, WS7) --------------------------------

        app.MapGet("/api/catalog/sources", async (
            HttpRequest request,
            UserDirectoryStore users,
            IClock clock,
            CatalogSourceService sources,
            CancellationToken cancellationToken) =>
            await CoreSessionAuthorization.RequireAdminSessionAsync(
                request,
                users,
                clock,
                () => Handle(async () => await sources.ListAsync(cancellationToken)),
                cancellationToken: cancellationToken));

        app.MapPost("/api/catalog/sources", async (
            HttpRequest request,
            UserDirectoryStore users,
            IClock clock,
            CatalogSourceService sources,
            CatalogSourceUpsertRequest input,
            CancellationToken cancellationToken) =>
            await CoreSessionAuthorization.RequireAdminSessionAsync(
                request,
                users,
                clock,
                () => Handle(async () => await sources.AddAsync(input.Url, cancellationToken)),
                requireCsrf: true,
                cancellationToken: cancellationToken));

        app.MapDelete("/api/catalog/sources", async (
            HttpRequest request,
            UserDirectoryStore users,
            IClock clock,
            CatalogSourceService sources,
            CancellationToken cancellationToken) =>
            await CoreSessionAuthorization.RequireAdminSessionAsync(
                request,
                users,
                clock,
                () => Handle(async () => await sources.RemoveAsync(ReadUrl(request), cancellationToken)),
                requireCsrf: true,
                cancellationToken: cancellationToken));

        // ---- Storefront reads (control plane for the CLI, WS4) -----------------------------------

        app.MapGet("/control/v1/catalog/apps", async (
            HttpRequest request,
            ControlSecret secret,
            CatalogService catalog,
            CancellationToken cancellationToken) =>
            await HostyCoreApplication.RequireControlSecret(request, secret, async () =>
                CoreJson.Json(await catalog.GetAppsAsync(cancellationToken))));

        app.MapGet("/control/v1/catalog/apps/{id}", async (
            string id,
            HttpRequest request,
            ControlSecret secret,
            CatalogService catalog,
            CancellationToken cancellationToken) =>
            await HostyCoreApplication.RequireControlSecret(request, secret, async () =>
                await AppDetailResultAsync(catalog, id, cancellationToken)));

        // ---- Source management (control plane for the CLI, WS7) ----------------------------------

        app.MapGet("/control/v1/catalog/sources", async (
            HttpRequest request,
            ControlSecret secret,
            CatalogSourceService sources,
            CancellationToken cancellationToken) =>
            await HostyCoreApplication.RequireControlSecret(request, secret, () =>
                Handle(async () => await sources.ListAsync(cancellationToken))));

        app.MapPost("/control/v1/catalog/sources", async (
            HttpRequest request,
            ControlSecret secret,
            CatalogSourceService sources,
            CatalogSourceUpsertRequest input,
            CancellationToken cancellationToken) =>
            await HostyCoreApplication.RequireControlSecret(request, secret, () =>
                Handle(async () => await sources.AddAsync(input.Url, cancellationToken))));

        app.MapDelete("/control/v1/catalog/sources", async (
            HttpRequest request,
            ControlSecret secret,
            CatalogSourceService sources,
            CancellationToken cancellationToken) =>
            await HostyCoreApplication.RequireControlSecret(request, secret, () =>
                Handle(async () => await sources.RemoveAsync(ReadUrl(request), cancellationToken))));
    }

    private static async Task<IResult> AppDetailResultAsync(CatalogService catalog, string id, CancellationToken cancellationToken)
    {
        var detail = await catalog.GetAppAsync(id, cancellationToken);
        return detail is null
            ? CoreJson.Json(
                new ErrorResponse("catalog_app_not_found", $"No catalog app '{id}' was found in any configured source."),
                statusCode: StatusCodes.Status404NotFound)
            : CoreJson.Json(detail);
    }

    private static string? ReadUrl(HttpRequest request) => request.Query["url"];

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
                "catalog_source_not_found" => StatusCodes.Status404NotFound,
                "catalog_source_exists" => StatusCodes.Status409Conflict,
                _ => StatusCodes.Status400BadRequest,
            };
            return CoreJson.Json(new ErrorResponse(ex.Code, ex.Message), statusCode: statusCode);
        }
    }
}

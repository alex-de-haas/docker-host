namespace Haas.Hosty.Core;

// Marketplace catalog read API (WS2). Host-admin only, read-only (GET, no CSRF), mirroring the
// observability fleet endpoints. Best-effort: an unreachable/misconfigured source degrades to an empty
// catalog rather than an error, so these never surface transport failures to the client. Clients drive
// install/update by passing a version's `manifestRef` to the existing reviewed install/update endpoints —
// the catalog installs nothing itself. See docs/features/runtime-app-marketplace.md (B2, Q1).
internal static class CatalogEndpoints
{
    public static void Map(WebApplication app)
    {
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
                async () =>
                {
                    var detail = await catalog.GetAppAsync(id, cancellationToken);
                    return detail is null
                        ? CoreJson.Json(
                            new ErrorResponse("catalog_app_not_found", $"No catalog app '{id}' was found in any configured source."),
                            statusCode: StatusCodes.Status404NotFound)
                        : CoreJson.Json(detail);
                },
                cancellationToken: cancellationToken));
    }
}

namespace Haas.Hosty.Core;

// Host-admin surface for publishing/unpublishing an app endpoint's Cloudflare public origin. Publish and
// unpublish mutate DNS + the tunnel route through the reconciler, so they require an admin session and CSRF.
internal static class CloudflarePublicationEndpoints
{
    public static void Map(WebApplication app)
    {
        app.MapGet("/api/apps/{appId}/public-origins", (
            string appId,
            HttpRequest request,
            UserDirectoryStore users,
            IClock clock,
            CloudflarePublicationService service,
            CancellationToken cancellationToken) =>
            CoreSessionAuthorization.RequireAdminSessionAsync(
                request,
                users,
                clock,
                async () => CoreJson.Json(await service.ListForAppAsync(appId, cancellationToken)),
                requireCsrf: false,
                cancellationToken: cancellationToken));

        app.MapPost("/api/apps/{appId}/public-origins/publish", (
            string appId,
            HttpRequest request,
            UserDirectoryStore users,
            IClock clock,
            CloudflarePublicationService service,
            CloudflarePublishRequest input,
            CancellationToken cancellationToken) =>
            CoreSessionAuthorization.RequireAdminSessionAsync(
                request,
                users,
                clock,
                async () => await HandleCloudflareError(() => service.PublishAsync(appId, input.EndpointKey, input.Label, input.Adopt, cancellationToken)),
                requireCsrf: true,
                cancellationToken: cancellationToken));

        app.MapPost("/api/apps/{appId}/public-origins/unpublish", (
            string appId,
            HttpRequest request,
            UserDirectoryStore users,
            IClock clock,
            CloudflarePublicationService service,
            CloudflareUnpublishRequest input,
            CancellationToken cancellationToken) =>
            CoreSessionAuthorization.RequireAdminSessionAsync(
                request,
                users,
                clock,
                async () => await HandleCloudflareError(() => service.UnpublishAsync(appId, input.EndpointKey, cancellationToken)),
                requireCsrf: true,
                cancellationToken: cancellationToken));

        // Core's own hostname. Separate routes rather than the app ones with a reserved id in the path:
        // `hosty.core` is not an app, and an /api/apps/… URL that answers for it would invite every app
        // caller to treat it as one.
        app.MapGet("/api/core/public-origin", (
            HttpRequest request,
            UserDirectoryStore users,
            IClock clock,
            CloudflarePublicationService service,
            CancellationToken cancellationToken) =>
            CoreSessionAuthorization.RequireAdminSessionAsync(
                request,
                users,
                clock,
                async () => CoreJson.Json(await service.GetCoreAsync(cancellationToken)),
                requireCsrf: false,
                cancellationToken: cancellationToken));

        app.MapPost("/api/core/public-origin/publish", (
            HttpRequest request,
            UserDirectoryStore users,
            IClock clock,
            CloudflarePublicationService service,
            CloudflareCorePublishRequest input,
            CancellationToken cancellationToken) =>
            CoreSessionAuthorization.RequireAdminSessionAsync(
                request,
                users,
                clock,
                async () => await HandleCoreCloudflareError(() => service.PublishCoreAsync(input.Label, input.Adopt, cancellationToken)),
                requireCsrf: true,
                cancellationToken: cancellationToken));

        app.MapPost("/api/core/public-origin/unpublish", (
            HttpRequest request,
            UserDirectoryStore users,
            IClock clock,
            CloudflarePublicationService service,
            CancellationToken cancellationToken) =>
            CoreSessionAuthorization.RequireAdminSessionAsync(
                request,
                users,
                clock,
                async () => await HandleCoreCloudflareError(() => service.UnpublishCoreAsync(cancellationToken)),
                requireCsrf: true,
                cancellationToken: cancellationToken));
    }

    private static async Task<IResult> HandleCoreCloudflareError(Func<Task<CloudflareCorePublicationResult>> action)
    {
        try
        {
            return CoreJson.Json(await action());
        }
        catch (CloudflareConnectionException exception)
        {
            return CoreJson.Json(new ErrorResponse(exception.Code, exception.Message), statusCode: StatusForCode(exception.Code));
        }
    }

    private static async Task<IResult> HandleCloudflareError(Func<Task<CloudflarePublicationResult>> action)
    {
        try
        {
            return CoreJson.Json(await action());
        }
        catch (CloudflareConnectionException exception)
        {
            return CoreJson.Json(new ErrorResponse(exception.Code, exception.Message), statusCode: StatusForCode(exception.Code));
        }
    }

    private static int StatusForCode(string code)
        => code switch
        {
            "cloudflare_not_connected" or "cloudflare_provider_inactive" or "cloudflare_reconnect_required"
                => StatusCodes.Status409Conflict,
            "cloudflare_app_not_found" => StatusCodes.Status404NotFound,
            "cloudflare_hostname_owned" or "cloudflare_hostname_conflict" => StatusCodes.Status409Conflict,
            _ => StatusCodes.Status400BadRequest,
        };
}

// `Adopt` answers a cloudflare_hostname_conflict for Core's hostname exactly as it does for an app's.
internal sealed record CloudflareCorePublishRequest(string Label, bool Adopt = false);

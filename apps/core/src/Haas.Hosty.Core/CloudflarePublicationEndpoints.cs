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
                async () => await HandleCloudflareError(() => service.PublishAsync(appId, input.EndpointKey, input.Label, cancellationToken)),
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
    }

    private static async Task<IResult> HandleCloudflareError(Func<Task<CloudflarePublicationResult>> action)
    {
        try
        {
            return CoreJson.Json(await action());
        }
        catch (CloudflareConnectionException exception)
        {
            var statusCode = exception.Code switch
            {
                "cloudflare_not_connected" => StatusCodes.Status409Conflict,
                "cloudflare_app_not_found" => StatusCodes.Status404NotFound,
                "cloudflare_hostname_owned" or "cloudflare_hostname_conflict" => StatusCodes.Status409Conflict,
                _ => StatusCodes.Status400BadRequest,
            };
            return CoreJson.Json(new ErrorResponse(exception.Code, exception.Message), statusCode: statusCode);
        }
    }
}

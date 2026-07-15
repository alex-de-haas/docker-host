namespace Haas.Hosty.Core;

// Host-admin surface for connecting Hosty to a Cloudflare account with a scoped API token and inspecting
// the resulting connection. Read/discovery only in this phase — no DNS or tunnel mutation. All routes
// require an admin session; mutations also require CSRF.
internal static class CloudflareConnectionEndpoints
{
    // The account-owned token creation page. The required permission groups are returned as guidance
    // alongside it; prefilling the permission-group keys is a later UX refinement.
    private const string TokenCreationUrl = "https://dash.cloudflare.com/?to=/:account/api-tokens";

    private static readonly IReadOnlyList<string> RequiredPermissions =
    [
        "Account · Cloudflare Tunnel · Edit",
        "Zone · DNS · Edit",
        "Zone · Zone · Read",
    ];

    public static void Map(WebApplication app)
    {
        app.MapGet("/api/core/cloudflare/token-template", (
            HttpRequest request,
            UserDirectoryStore users,
            IClock clock,
            CancellationToken cancellationToken) =>
            CoreSessionAuthorization.RequireAdminSessionAsync(
                request,
                users,
                clock,
                () => Task.FromResult(CoreJson.Json(new CloudflareTokenTemplate(TokenCreationUrl, RequiredPermissions))),
                requireCsrf: false,
                cancellationToken: cancellationToken));

        app.MapGet("/api/core/cloudflare/status", (
            HttpRequest request,
            UserDirectoryStore users,
            IClock clock,
            CloudflareConnectionService service,
            CancellationToken cancellationToken) =>
            CoreSessionAuthorization.RequireAdminSessionAsync(
                request,
                users,
                clock,
                async () => CoreJson.Json(await service.StatusAsync(cancellationToken)),
                requireCsrf: false,
                cancellationToken: cancellationToken));

        app.MapPost("/api/core/cloudflare/connect", (
            HttpRequest request,
            UserDirectoryStore users,
            IClock clock,
            CloudflareConnectionService service,
            CloudflareConnectRequest input,
            CancellationToken cancellationToken) =>
            CoreSessionAuthorization.RequireAdminSessionAsync(
                request,
                users,
                clock,
                async () => await HandleCloudflareError(() => service.ConnectAsync(input.Token, cancellationToken)),
                requireCsrf: true,
                cancellationToken: cancellationToken));

        app.MapPost("/api/core/cloudflare/disconnect", (
            HttpRequest request,
            UserDirectoryStore users,
            IClock clock,
            CloudflareConnectionService service,
            CancellationToken cancellationToken) =>
            CoreSessionAuthorization.RequireAdminSessionAsync(
                request,
                users,
                clock,
                async () => await HandleCloudflareError(() => service.DisconnectAsync(cancellationToken)),
                requireCsrf: true,
                cancellationToken: cancellationToken));
    }

    private static async Task<IResult> HandleCloudflareError(Func<Task<CloudflareConnectionStatus>> action)
    {
        try
        {
            return CoreJson.Json(await action());
        }
        catch (CloudflareConnectionException exception)
        {
            var statusCode = exception.Code switch
            {
                "cloudflare_token_invalid" => StatusCodes.Status401Unauthorized,
                "cloudflare_token_forbidden" => StatusCodes.Status403Forbidden,
                _ => StatusCodes.Status400BadRequest,
            };
            return CoreJson.Json(new ErrorResponse(exception.Code, exception.Message), statusCode: statusCode);
        }
    }
}

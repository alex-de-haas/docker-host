namespace Haas.Hosty.Core;

// Host-admin surface for connecting Hosty to a Cloudflare account with a scoped API token and inspecting
// the resulting connection. Connect/status/disconnect only — publishing a hostname is app-scoped and
// lives in CloudflarePublicationEndpoints. All routes
// require an admin session; mutations also require CSRF.
internal static class CloudflareConnectionEndpoints
{
    // The account-owned token creation page. Cloudflare's template links can prefill permission groups
    // through `permissionGroupKeys`, but the key for the tunnel permission is not documented, and a link
    // that silently prefills two of the three — dropping the one that is genuinely hard to find — would
    // send an operator away confident and back with a 403. So this stays a plain link and the guidance
    // below carries the exact names instead.
    private const string TokenCreationUrl = "https://dash.cloudflare.com/?to=/:account/api-tokens";

    // The groups a phase-0 spike proved sufficient against a live account. The tunnel one is listed first
    // and by its dashboard name: searching the token editor for "Cloudflare Tunnel" finds nothing, which
    // is the single most common way this setup stalls.
    private static readonly IReadOnlyList<string> RequiredPermissions =
    [
        "Account · Argo Tunnel (Legacy) · Edit — the dashboard's name for the Cloudflare Tunnel permission",
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
                async () => await HandleCloudflareError(() => service.ConnectAsync(input.Token, input.Selection, cancellationToken)),
                requireCsrf: true,
                cancellationToken: cancellationToken));

        app.MapPost("/api/core/cloudflare/disconnect", (
            HttpRequest request,
            UserDirectoryStore users,
            IClock clock,
            CloudflareConnectionService service,
            CloudflarePublicationService publications,
            CloudflareDisconnectRequest? input,
            CancellationToken cancellationToken) =>
            CoreSessionAuthorization.RequireAdminSessionAsync(
                request,
                users,
                clock,
                async () => await HandleCloudflareError(async () =>
                {
                    // Keep is the default and the safe answer: the routes and records stay as they are, and
                    // reconnecting the same account picks up where this left off. Remove runs first,
                    // because deleting them needs the token — and it stops the disconnect when any of it
                    // fails, since a half-removed disconnect that also threw the token away would leave
                    // orphans nothing can reach.
                    if (input?.RemovePublished == true)
                    {
                        var leftBehind = await publications.RemoveAllAsync(cancellationToken);
                        if (leftBehind > 0)
                        {
                            throw new CloudflareConnectionException(
                                "cloudflare_disconnect_incomplete",
                                $"{leftBehind} published endpoint(s) could not be removed from Cloudflare, so the connection was kept. Retry, or disconnect with Keep and clean them up in the dashboard.");
                        }
                    }

                    return await service.DisconnectAsync(cancellationToken);
                }),
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
            // An ambiguity is not a failed request: the token is fine and the account simply has more than
            // one candidate. It answers 409 with the candidates so the client can ask and retry, rather
            // than the 400 that used to end the flow.
            if (exception.Selection is { } selection)
            {
                return CoreJson.Json(
                    new CloudflareSelectionErrorResponse(exception.Code, exception.Message, selection),
                    statusCode: StatusCodes.Status409Conflict);
            }

            var statusCode = exception.Code switch
            {
                "cloudflare_token_invalid" => StatusCodes.Status401Unauthorized,
                "cloudflare_token_forbidden" => StatusCodes.Status403Forbidden,
                // The request was fine; the account's current state stopped it, and retrying can work.
                "cloudflare_disconnect_incomplete" => StatusCodes.Status409Conflict,
                _ => StatusCodes.Status400BadRequest,
            };
            return CoreJson.Json(new ErrorResponse(exception.Code, exception.Message), statusCode: statusCode);
        }
    }
}

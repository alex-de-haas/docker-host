namespace Haas.Hosty.Core;

internal static class ControlIdentityEndpoints
{
    public static void Map(WebApplication app)
    {
        app.MapGet("/control/v1/users/summaries", async (
            string? appId,
            HttpRequest request,
            ControlSecret secret,
            UserDirectoryStore users,
            CancellationToken cancellationToken) =>
            await HostyCoreApplication.RequireControlSecret(request, secret, async () =>
            {
                var state = await users.ReadAsync(cancellationToken);
                var summaries = state.Users
                    .OrderBy(user => user.Email, StringComparer.OrdinalIgnoreCase)
                    .Where(user => string.IsNullOrWhiteSpace(appId) || IsUserAssignedToApp(state, user, appId))
                    .Select(user => new HostUserSummary(
                        user.Id,
                        user.Email ?? "",
                        user.DisplayName,
                        user.Role,
                        user.Disabled,
                        string.IsNullOrWhiteSpace(appId) ? null : IsUserAssignedToApp(state, user, appId)))
                    .ToArray();
                return Results.Json(new HostUsersSummaryResponse(summaries));
            }));

        app.MapPost("/control/v1/apps/{appId}/identity", async (
            string appId,
            HttpRequest request,
            ControlSecret secret,
            UserDirectoryStore users,
            AppIdentityService identity,
            AppIdentityIssueRequest input,
            CancellationToken cancellationToken) =>
            await HostyCoreApplication.RequireControlSecret(request, secret, async () =>
                await HandleIdentityError(async () =>
                {
                    var user = await ResolveUserAsync(users, input.User, cancellationToken);
                    var token = await identity.CreateLaunchTokenAsync(appId, user.Id, cancellationToken);
                    return Results.Json(new AppIdentityIssueResponse(appId, user.Id, token));
                })));

        app.MapPost("/control/v1/apps/{appId}/open-link", async (
            string appId,
            HttpRequest request,
            ControlSecret secret,
            UserDirectoryStore users,
            AppRegistryStore apps,
            AppIdentityService identity,
            HostyCoreRuntimeConfig config,
            AppOpenLinkRequest input,
            CancellationToken cancellationToken) =>
            await HostyCoreApplication.RequireControlSecret(request, secret, async () =>
                await HandleIdentityError(async () =>
                {
                    var user = await ResolveUserAsync(users, input.User, cancellationToken);
                    var mode = string.IsNullOrWhiteSpace(input.Mode) ? "standalone" : input.Mode;
                    if (string.Equals(mode, "shell", StringComparison.OrdinalIgnoreCase))
                    {
                        var shellOrigin = config.ShellPublicOrigin ?? $"http://localhost:{config.ShellPort}";
                        return Results.Json(new AppOpenLinkResponse(
                            AppId: appId,
                            UserId: user.Id,
                            Mode: "shell",
                            Url: $"{shellOrigin.TrimEnd('/')}/apps/{Uri.EscapeDataString(appId)}",
                            ExpiresAt: null));
                    }

                    if (!string.Equals(mode, "standalone", StringComparison.OrdinalIgnoreCase))
                    {
                        return Results.Json(new ErrorResponse("open_mode_invalid", "Open mode must be shell or standalone."), statusCode: StatusCodes.Status400BadRequest);
                    }

                    var redirectUri = input.RedirectUri ?? await ResolveDefaultRedirectUriAsync(apps, appId, cancellationToken);
                    var authorization = await identity.CreateAuthorizationCodeAsync(appId, user.Id, redirectUri, cancellationToken);
                    return Results.Json(new AppOpenLinkResponse(
                        AppId: appId,
                        UserId: user.Id,
                        Mode: "standalone",
                        Url: authorization.RedirectUri,
                        ExpiresAt: authorization.ExpiresAt));
                })));
    }

    private static bool IsUserAssignedToApp(UserDirectoryState state, HostUserRecord user, string appId)
        => string.Equals(user.Role, "host.admin", StringComparison.Ordinal) ||
            state.Assignments.Any(assignment =>
                string.Equals(assignment.AppId, appId, StringComparison.Ordinal) &&
                string.Equals(assignment.UserId, user.Id, StringComparison.Ordinal));

    private static async Task<HostUserRecord> ResolveUserAsync(
        UserDirectoryStore users,
        string user,
        CancellationToken cancellationToken)
    {
        var state = await users.ReadAsync(cancellationToken);
        return state.Users.FirstOrDefault(candidate =>
                string.Equals(candidate.Id, user, StringComparison.Ordinal) ||
                string.Equals(candidate.Email, user, StringComparison.OrdinalIgnoreCase)) ??
            throw new AppIdentityException("user_not_found", "Host user was not found.");
    }

    private static async Task<string> ResolveDefaultRedirectUriAsync(
        AppRegistryStore apps,
        string appId,
        CancellationToken cancellationToken)
    {
        var app = await apps.GetAppAsync(appId, cancellationToken) ??
            throw new AppIdentityException("app_not_found", "Runtime app was not found.");
        var endpoint = app.Endpoints.FirstOrDefault(candidate => candidate.Public && !string.IsNullOrWhiteSpace(candidate.Url)) ??
            app.Endpoints.FirstOrDefault(candidate => !string.IsNullOrWhiteSpace(candidate.Url));
        if (endpoint?.Url is null)
        {
            throw new AppIdentityException("app_open_url_missing", "Runtime app does not have a public endpoint URL. Pass --redirect-uri for standalone open.");
        }

        return endpoint.Url;
    }

    private static async Task<IResult> HandleIdentityError(Func<Task<IResult>> action)
    {
        try
        {
            return await action();
        }
        catch (AppIdentityException ex)
        {
            var status = ex.Code is "user_not_found" or "app_not_found"
                ? StatusCodes.Status404NotFound
                : StatusCodes.Status403Forbidden;
            return Results.Json(new ErrorResponse(ex.Code, ex.Message), statusCode: status);
        }
    }
}

internal sealed record HostUserSummary(
    string Id,
    string Email,
    string? DisplayName,
    string Role,
    bool Disabled,
    bool? Assigned);

internal sealed record HostUsersSummaryResponse(IReadOnlyList<HostUserSummary> Users);

internal sealed record AppIdentityIssueRequest(string User);

internal sealed record AppIdentityIssueResponse(string AppId, string UserId, AppIdentityTokenResult Token);

internal sealed record AppOpenLinkRequest(string User, string? Mode = null, string? RedirectUri = null);

internal sealed record AppOpenLinkResponse(string AppId, string UserId, string Mode, string Url, DateTimeOffset? ExpiresAt);

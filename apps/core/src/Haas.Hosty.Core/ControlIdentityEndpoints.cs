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
                return CoreJson.Json(new HostUsersSummaryResponse(summaries));
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
                    return CoreJson.Json(new AppIdentityIssueResponse(appId, user.Id, token));
                })));

        // Mints a delegated token for a named app on behalf of a named host user — the credential
        // `hosty mcp` presents to an app's MCP endpoint (docs/features/hosty-mcp-connector/feature.md).
        //
        // Why this exists next to /identity rather than reusing it: that route mints an *app identity*
        // token, a different mechanism app MCP endpoints do not accept. And the session-gated
        // POST /api/apps/{appId}/delegated-token is unreachable from here, because the CLI talks to
        // Core over the control channel and holds no Core session.
        //
        // The caller must name a user, exactly as /identity does. The control secret identifies no
        // user, yet a delegated token needs a concrete `sub` and role for the receiving app's access
        // checks — so there is nothing to default to, and defaulting would mean impersonating whichever
        // administrator happened to be found first. The same access policy the session path runs is
        // applied here, so this is never a way to obtain more than that user could obtain themselves.
        app.MapPost("/control/v1/apps/{appId}/delegated-token", async (
            string appId,
            HttpRequest request,
            ControlSecret secret,
            UserDirectoryStore users,
            AppIdentityService identity,
            DelegatedTokenService delegatedTokens,
            AuditStore audit,
            IClock clock,
            AppIdentityIssueRequest input,
            CancellationToken cancellationToken) =>
            await HostyCoreApplication.RequireControlSecret(request, secret, async () =>
            {
                // Audited on every attempt including refusals, like the app-to-app exchange and for the
                // same reason: this is a path to a data-plane credential, and a refusal is the more
                // interesting half of that record. HandleIdentityError converts the exception to a
                // response WITHOUT rethrowing, so wrapping it would have left the refusals unaudited.
                // Carried out of the try so a refusal after the user resolved still records WHO was
                // refused, while one that failed at resolution records nobody — see the audit helper.
                string? actorId = null;
                try
                {
                    var user = await ResolveUserAsync(users, input.User, cancellationToken);
                    actorId = user.Id;
                    if (appId == AccessTokenScopes.CoreAudience)
                    {
                        if (user.Disabled || !AppAccessPolicy.IsAdmin(user))
                            throw new AppIdentityException("admin_required", "Core MCP requires an enabled Host administrator.");
                        var coreToken = delegatedTokens.CreateToken(AccessTokenScopes.CoreAudience, user.Id, user.Role);
                        await AppendControlTokenAuditAsync(audit, appId, user.Id, input.User, "succeeded", clock, cancellationToken);
                        return CoreJson.Json(coreToken);
                    }
                    var (actor, target) = await identity.RequireAccessibleUserAsync(appId, user.Id, cancellationToken);
                    var issued = delegatedTokens.CreateToken(target.Id, actor.Id, actor.Role);
                    await AppendControlTokenAuditAsync(audit, appId, actor.Id, input.User, "succeeded", clock, cancellationToken);
                    return CoreJson.Json(issued);
                }
                catch (AppIdentityException exception)
                {
                    await AppendControlTokenAuditAsync(audit, appId, actorId, input.User, exception.Code, clock, cancellationToken);
                    return CoreJson.Json(
                        new ErrorResponse(exception.Code, exception.Message),
                        statusCode: exception.Code is "user_not_found" or "app_not_found"
                            ? StatusCodes.Status404NotFound
                            : StatusCodes.Status403Forbidden);
                }
            }));

        app.MapPost("/control/v1/apps/{appId}/open-link", async (
            string appId,
            HttpRequest request,
            ControlSecret secret,
            AppRegistryStore apps,
            AppIdentityService identity,
            ShellPublicOriginResolver shellOrigins,
            AppOpenLinkRequest input,
            CancellationToken cancellationToken) =>
            await HostyCoreApplication.RequireControlSecret(request, secret, async () =>
                await HandleIdentityError(async () =>
                {
                    if (input.User.ValueKind != System.Text.Json.JsonValueKind.Undefined)
                    {
                        return CoreJson.Json(
                            new ErrorResponse("open_user_removed", "Open links use the browser's signed-in account. Remove the user field; apps identity remains a diagnostic helper."),
                            statusCode: StatusCodes.Status400BadRequest);
                    }

                    var appRecord = await apps.GetAppAsync(appId, cancellationToken) ??
                        throw new AppIdentityException("app_not_found", "Runtime app was not found.");
                    var mode = string.IsNullOrWhiteSpace(input.Mode) ? "standalone" : input.Mode;
                    if (string.Equals(mode, "shell", StringComparison.OrdinalIgnoreCase))
                    {
                        if (await shellOrigins.ResolveAsync(cancellationToken) is not { } shellOrigin)
                        {
                            return CoreJson.Json(
                                new ErrorResponse("shell_not_installed", "This host has no Shell installed, so there is no shell link to open."),
                                statusCode: StatusCodes.Status409Conflict);
                        }

                        return CoreJson.Json(new AppOpenLinkResponse(
                            AppId: appId,
                            Mode: "shell",
                            Url: BuildShellWorkspaceUrl(shellOrigin, appId)));
                    }

                    if (!string.Equals(mode, "standalone", StringComparison.OrdinalIgnoreCase))
                    {
                        return CoreJson.Json(new ErrorResponse("open_mode_invalid", "Open mode must be shell or standalone."), statusCode: StatusCodes.Status400BadRequest);
                    }

                    var redirectUri = input.RedirectUri ?? AppSummary.From(appRecord).EmbeddedUrl;
                    if (string.IsNullOrWhiteSpace(redirectUri))
                    {
                        throw new AppIdentityException("app_open_url_missing", "Runtime app does not have a browser UI URL. Pass --redirect-uri for standalone open.");
                    }

                    RequirePlainOpenUri(redirectUri);
                    await identity.RequireAllowedRedirectUriAsync(appId, redirectUri, cancellationToken);
                    return CoreJson.Json(new AppOpenLinkResponse(
                        AppId: appId,
                        Mode: "standalone",
                        Url: redirectUri));
                })));
    }

    // The Shell route that opens an app's workspace. This used to build `{shellOrigin}/apps/{appId}`,
    // which the Shell has never served: `/apps` is its app overview, with no per-app segment beneath
    // it, so `hosty apps open --mode shell` handed the operator a link that 404s. `/workspace` is the
    // one route that takes an app id, and it carries the app path the workspace opens on.
    internal static string BuildShellWorkspaceUrl(string shellOrigin, string appId)
        => $"{shellOrigin.TrimEnd('/')}/workspace?app={Uri.EscapeDataString(appId)}&path=%2F";

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

    private static void RequirePlainOpenUri(string value)
    {
        if (!Uri.TryCreate(value, UriKind.Absolute, out var uri) ||
            (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps) ||
            !string.IsNullOrEmpty(uri.UserInfo) || !string.IsNullOrEmpty(uri.Fragment))
        {
            throw new AppIdentityException("redirect_uri_invalid", "Open URL must be an absolute credential-free http(s) URI without a fragment.");
        }

        var query = Microsoft.AspNetCore.WebUtilities.QueryHelpers.ParseQuery(uri.Query);
        string[] reserved = ["code", "state", "codeVerifier", "code_verifier", "codeChallenge", "code_challenge",
            "codeChallengeMethod", "code_challenge_method", "requestId", "access_token", "hosty_launch"];
        if (reserved.Any(query.ContainsKey))
        {
            throw new AppIdentityException("redirect_uri_invalid", "Open URL must not contain authorization callback or proof parameters.");
        }
    }

    /// <summary>
    /// Records one attempt at the control-channel token route.
    /// </summary>
    /// <remarks>
    /// <paramref name="actorUserId"/> is a resolved user id or null — never the caller's raw argument,
    /// which may be an email since the route accepts either. Writing an email into
    /// <see cref="AuditRecord.ActorUserId"/> would make that field mean two different things depending
    /// on how far the request got, and break any consumer that joins it against the user directory.
    /// What was asked for still needs recording, so it goes in the details under its own key.
    /// </remarks>
    private static Task AppendControlTokenAuditAsync(
        AuditStore audit,
        string appId,
        string? actorUserId,
        string requestedUser,
        string outcome,
        IClock clock,
        CancellationToken cancellationToken)
        => audit.AppendAsync(
            new AuditRecord(
                Id: $"audit_{Guid.NewGuid():N}",
                Action: "auth.delegated-token.control",
                ResourceType: "app",
                ResourceId: appId,
                Outcome: outcome,
                ActorUserId: actorUserId,
                CreatedAt: clock.UtcNow,
                Details: new Dictionary<string, string>
                {
                    ["targetAppId"] = appId,
                    ["channel"] = "control",
                    ["requestedUser"] = requestedUser,
                }),
            cancellationToken);

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
            return CoreJson.Json(new ErrorResponse(ex.Code, ex.Message), statusCode: status);
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

internal sealed record AppOpenLinkRequest(
    string? Mode = null,
    string? RedirectUri = null,
    System.Text.Json.JsonElement User = default);

internal sealed record AppOpenLinkResponse(string AppId, string Mode, string Url);

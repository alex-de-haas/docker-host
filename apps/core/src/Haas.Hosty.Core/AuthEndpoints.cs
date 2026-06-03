namespace Haas.Hosty.Core;

internal static class AuthEndpoints
{
    public static void Map(WebApplication app)
    {
        app.MapGet("/api/auth/csrf", (HttpResponse response) =>
        {
            var token = CreateSessionId();
            response.Cookies.Append(CoreSessionAuthorization.CsrfCookieName, token, new CookieOptions
            {
                HttpOnly = false,
                SameSite = SameSiteMode.Lax,
                Secure = false,
            });

            return Results.Json(new CsrfResponse(token));
        });

        app.MapGet("/api/auth/session", async (HttpRequest request, UserDirectoryStore users, CancellationToken cancellationToken) =>
        {
            var state = await users.ReadAsync(cancellationToken);
            var sessionId = request.Cookies[CoreSessionAuthorization.SessionCookieName];
            var now = DateTimeOffset.UtcNow;
            var session = state.Sessions.FirstOrDefault(candidate =>
                string.Equals(candidate.Id, sessionId, StringComparison.Ordinal) &&
                candidate.RevokedAt is null &&
                candidate.ExpiresAt > now);
            var user = session is null
                ? null
                : state.Users.FirstOrDefault(candidate => string.Equals(candidate.Id, session.UserId, StringComparison.Ordinal));

            return Results.Json(new AuthSessionResponse(user is not null && !user.Disabled, user));
        });

        app.MapPost("/api/auth/session", async (AuthSessionCreateRequest input, HttpResponse response, UserDirectoryStore users, IClock clock, CancellationToken cancellationToken) =>
        {
            var result = await CreateSessionAsync(input.UserId, input.SecureCookie, response, users, clock, cancellationToken);
            return result.Succeeded
                ? Results.Json(new AuthSessionResponse(true, result.User))
                : Results.Json(new ErrorResponse("session_denied", "Host user is missing or disabled."), statusCode: StatusCodes.Status403Forbidden);
        });

        app.MapPost("/api/auth/trusted-proxy/session", async (HttpRequest request, HttpResponse response, UserDirectoryStore users, IClock clock, CancellationToken cancellationToken) =>
        {
            var userId = request.Headers["X-Hosty-Trusted-User-Id"].ToString();
            if (string.IsNullOrWhiteSpace(userId))
            {
                return Results.Json(new ErrorResponse("trusted_proxy_user_missing", "Trusted proxy user id header is missing."), statusCode: StatusCodes.Status400BadRequest);
            }

            var result = await CreateSessionAsync(userId, secureCookie: true, response, users, clock, cancellationToken);
            return result.Succeeded
                ? Results.Json(new AuthSessionResponse(true, result.User))
                : Results.Json(new ErrorResponse("session_denied", "Host user is missing or disabled."), statusCode: StatusCodes.Status403Forbidden);
        });

        app.MapPost("/api/auth/logout", async (HttpRequest request, HttpResponse response, UserDirectoryStore users, IClock clock, CancellationToken cancellationToken) =>
        {
            var state = await users.ReadAsync(cancellationToken);
            var sessionId = request.Cookies[CoreSessionAuthorization.SessionCookieName];
            if (!string.IsNullOrWhiteSpace(sessionId))
            {
                var sessions = state.Sessions
                    .Select(session => string.Equals(session.Id, sessionId, StringComparison.Ordinal)
                        ? session with { RevokedAt = clock.UtcNow }
                        : session)
                    .ToArray();
                await users.WriteAsync(state with { Sessions = sessions }, cancellationToken);
            }

            response.Cookies.Delete(CoreSessionAuthorization.SessionCookieName);
            return Results.Json(new LogoutResponse("logged_out"));
        });

        app.MapPost("/api/auth/apps/authorize", async (AppAuthorizeRequest input, AppIdentityService identity, CancellationToken cancellationToken) =>
            await HandleIdentityError(async () => Results.Json(await identity.CreateAuthorizationCodeAsync(input.AppId, input.UserId, input.RedirectUri, cancellationToken))));

        app.MapPost("/api/auth/apps/token", async (AppTokenExchangeRequest input, AppIdentityService identity, CancellationToken cancellationToken) =>
            await HandleIdentityError(async () => Results.Json(await identity.ExchangeCodeAsync(input.Code, cancellationToken))));

        app.MapPost("/api/auth/apps/revalidate", async (AppRevalidateRequest input, AppIdentityService identity, CancellationToken cancellationToken) =>
            await HandleIdentityError(async () => Results.Json(await identity.RevalidateAsync(input.AccessToken, cancellationToken))));

        app.MapPost("/api/apps/{appId}/launch-code", async (string appId, AppLaunchCodeRequest input, AppIdentityService identity, CancellationToken cancellationToken) =>
            await HandleIdentityError(async () => Results.Json(await identity.CreateAuthorizationCodeAsync(appId, input.UserId, input.RedirectUri, cancellationToken))));
    }

    private static async Task<IResult> HandleIdentityError(Func<Task<IResult>> action)
    {
        try
        {
            return await action();
        }
        catch (AppIdentityException ex)
        {
            return Results.Json(new ErrorResponse(ex.Code, ex.Message), statusCode: StatusCodes.Status403Forbidden);
        }
    }

    private static string CreateSessionId()
        => Convert.ToHexString(System.Security.Cryptography.RandomNumberGenerator.GetBytes(32)).ToLowerInvariant();

    internal static async Task<AuthSessionCreateResult> CreateSessionAsync(
        string userId,
        bool secureCookie,
        HttpResponse response,
        UserDirectoryStore users,
        IClock clock,
        CancellationToken cancellationToken)
    {
        var state = await users.ReadAsync(cancellationToken);
        var user = state.Users.FirstOrDefault(candidate => string.Equals(candidate.Id, userId, StringComparison.Ordinal));
        if (user is null || user.Disabled)
        {
            return new AuthSessionCreateResult(false, null);
        }

        var now = clock.UtcNow;
        var session = new AuthSessionRecord(CreateSessionId(), user.Id, now, now.AddHours(12), null);
        await users.WriteAsync(state with { Sessions = state.Sessions.Append(session).ToArray() }, cancellationToken);
        response.Cookies.Append(CoreSessionAuthorization.SessionCookieName, session.Id, new CookieOptions
        {
            HttpOnly = true,
            SameSite = SameSiteMode.Lax,
            Secure = secureCookie,
            Expires = session.ExpiresAt,
        });

        return new AuthSessionCreateResult(true, user);
    }
}

internal sealed record CsrfResponse(string Token);

internal sealed record AuthSessionCreateRequest(string UserId, bool SecureCookie = false);

internal sealed record AuthSessionResponse(bool Authenticated, HostUserRecord? User);

internal sealed record AuthSessionCreateResult(bool Succeeded, HostUserRecord? User);

internal sealed record LogoutResponse(string Status);

internal sealed record AppAuthorizeRequest(string AppId, string UserId, string RedirectUri);

internal sealed record AppTokenExchangeRequest(string Code);

internal sealed record AppRevalidateRequest(string AccessToken);

internal sealed record AppLaunchCodeRequest(string UserId, string RedirectUri);

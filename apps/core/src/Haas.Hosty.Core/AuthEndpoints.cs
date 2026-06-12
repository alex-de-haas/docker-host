using System.Security.Cryptography;
using System.Text;

namespace Haas.Hosty.Core;

internal static class AuthEndpoints
{
    internal const string TrustedProxySecretHeader = "X-Hosty-Trusted-Proxy-Secret";
    internal const string TrustedProxyUserIdHeader = "X-Hosty-Trusted-User-Id";

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

        app.MapPost("/api/auth/session", async (
            AuthSessionCreateRequest input,
            HttpResponse response,
            IHostEnvironment environment,
            UserDirectoryStore users,
            IClock clock,
            CancellationToken cancellationToken) =>
        {
            if (!environment.IsDevelopment())
            {
                return Results.Json(new ErrorResponse("session_create_unavailable", "Direct session creation is available only in development."), statusCode: StatusCodes.Status404NotFound);
            }

            var result = await CreateSessionAsync(input.UserId, input.SecureCookie, response, users, clock, cancellationToken);
            return result.Succeeded
                ? Results.Json(new AuthSessionResponse(true, result.User))
                : Results.Json(new ErrorResponse("session_denied", "Host user is missing or disabled."), statusCode: StatusCodes.Status403Forbidden);
        });

        app.MapPost("/api/auth/trusted-proxy/session", async (
            HttpRequest request,
            HttpResponse response,
            HostyCoreRuntimeConfig config,
            UserDirectoryStore users,
            IClock clock,
            CancellationToken cancellationToken) =>
        {
            if (string.IsNullOrWhiteSpace(config.TrustedProxySecret))
            {
                return Results.Json(new ErrorResponse("trusted_proxy_disabled", "Trusted proxy session creation is disabled. Set HOSTY_TRUSTED_PROXY_SECRET to enable it."), statusCode: StatusCodes.Status404NotFound);
            }

            var submittedSecret = request.Headers[TrustedProxySecretHeader].ToString();
            if (!FixedTimeEquals(config.TrustedProxySecret, submittedSecret))
            {
                return Results.Json(new ErrorResponse("trusted_proxy_unauthorized", "Trusted proxy secret is missing or invalid."), statusCode: StatusCodes.Status401Unauthorized);
            }

            var userId = request.Headers[TrustedProxyUserIdHeader].ToString();
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
            await LogoutAsync(request, response, users, clock, cancellationToken);
            return Results.Json(new LogoutResponse("logged_out"));
        });

        app.MapPost("/api/auth/apps/authorize", async (
            HttpRequest request,
            UserDirectoryStore users,
            IClock clock,
            AppAuthorizeRequest input,
            AppIdentityService identity,
            CancellationToken cancellationToken) =>
            await CoreSessionAuthorization.RequireSessionAsync(
                request,
                users,
                clock,
                async user => await HandleIdentityError(async () =>
                    Results.Json(await identity.CreateAuthorizationCodeAsync(input.AppId, user.Id, input.RedirectUri, cancellationToken))),
                requireCsrf: true,
                cancellationToken: cancellationToken));

        app.MapPost("/api/auth/apps/token", async (AppTokenExchangeRequest input, AppIdentityService identity, CancellationToken cancellationToken) =>
            await HandleIdentityError(async () => Results.Json(await identity.ExchangeCodeAsync(input.Code, cancellationToken))));

        app.MapPost("/api/auth/apps/revalidate", async (
            HttpRequest request,
            AppRevalidateRequest input,
            AppServiceTokenService serviceTokens,
            AppIdentityService identity,
            CancellationToken cancellationToken) =>
        {
            var serviceToken = CoreSessionAuthorization.ReadBearerToken(request);
            var callingAppId = serviceToken is null ? null : serviceTokens.ResolveAppId(serviceToken);
            if (callingAppId is null)
            {
                return Results.Json(new ErrorResponse("app_service_token_invalid", "App service token is missing or invalid."), statusCode: StatusCodes.Status401Unauthorized);
            }

            return await HandleIdentityError(async () => Results.Json(await identity.RevalidateAsync(input.AccessToken, callingAppId, cancellationToken)));
        });

        app.MapPost("/api/apps/{appId}/launch-code", async (
            string appId,
            HttpRequest request,
            UserDirectoryStore users,
            IClock clock,
            AppLaunchCodeRequest input,
            AppIdentityService identity,
            CancellationToken cancellationToken) =>
            await CoreSessionAuthorization.RequireSessionAsync(
                request,
                users,
                clock,
                async user => await HandleIdentityError(async () =>
                    Results.Json(await identity.CreateAuthorizationCodeAsync(appId, user.Id, input.RedirectUri, cancellationToken))),
                requireCsrf: true,
                cancellationToken: cancellationToken));

        app.MapGet("/api/apps/{appId}/open", async (
            string appId,
            string? redirectUri,
            HttpRequest request,
            UserDirectoryStore users,
            IClock clock,
            AppIdentityService identity,
            CancellationToken cancellationToken) =>
        {
            if (string.IsNullOrWhiteSpace(redirectUri))
            {
                return Results.Json(new ErrorResponse("redirect_uri_missing", "Redirect URI is required."), statusCode: StatusCodes.Status400BadRequest);
            }

            return await CoreSessionAuthorization.RequireSessionAsync(
                request,
                users,
                clock,
                async user => await HandleIdentityError(async () =>
                {
                    var authorization = await identity.CreateAuthorizationCodeAsync(appId, user.Id, redirectUri, cancellationToken);
                    return Results.Redirect(authorization.RedirectUri);
                }),
                requireCsrf: false,
                cancellationToken: cancellationToken);
        });
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
        => Convert.ToHexString(RandomNumberGenerator.GetBytes(32)).ToLowerInvariant();

    private static bool FixedTimeEquals(string expected, string actual)
        => CryptographicOperations.FixedTimeEquals(
            Encoding.UTF8.GetBytes(expected),
            Encoding.UTF8.GetBytes(actual));

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

    internal static async Task LogoutAsync(
        HttpRequest request,
        HttpResponse response,
        UserDirectoryStore users,
        IClock clock,
        CancellationToken cancellationToken)
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
    }
}

internal sealed record CsrfResponse(string Token);

internal sealed record AuthSessionCreateRequest(string UserId, bool SecureCookie = false);

internal sealed record AuthSessionResponse(bool Authenticated, HostUserRecord? User);

internal sealed record AuthSessionCreateResult(bool Succeeded, HostUserRecord? User);

internal sealed record LogoutResponse(string Status);

internal sealed record AppAuthorizeRequest(string AppId, string RedirectUri);

internal sealed record AppTokenExchangeRequest(string Code);

internal sealed record AppRevalidateRequest(string AccessToken);

internal sealed record AppLaunchCodeRequest(string RedirectUri);

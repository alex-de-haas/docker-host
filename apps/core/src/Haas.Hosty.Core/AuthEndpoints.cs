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

            return CoreJson.Json(new CsrfResponse(token));
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

            return CoreJson.Json(new AuthSessionResponse(user is not null && !user.Disabled, user));
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
                return CoreJson.Json(new ErrorResponse("session_create_unavailable", "Direct session creation is available only in development."), statusCode: StatusCodes.Status404NotFound);
            }

            var result = await CreateSessionAsync(input.UserId, input.SecureCookie, response, users, clock, cancellationToken);
            return result.Succeeded
                ? CoreJson.Json(new AuthSessionResponse(true, result.User))
                : CoreJson.Json(new ErrorResponse("session_denied", "Host user is missing or disabled."), statusCode: StatusCodes.Status403Forbidden);
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
                return CoreJson.Json(new ErrorResponse("trusted_proxy_disabled", "Trusted proxy session creation is disabled. Set HOSTY_TRUSTED_PROXY_SECRET to enable it."), statusCode: StatusCodes.Status404NotFound);
            }

            var submittedSecret = request.Headers[TrustedProxySecretHeader].ToString();
            if (!FixedTimeEquals(config.TrustedProxySecret, submittedSecret))
            {
                return CoreJson.Json(new ErrorResponse("trusted_proxy_unauthorized", "Trusted proxy secret is missing or invalid."), statusCode: StatusCodes.Status401Unauthorized);
            }

            var userId = request.Headers[TrustedProxyUserIdHeader].ToString();
            if (string.IsNullOrWhiteSpace(userId))
            {
                return CoreJson.Json(new ErrorResponse("trusted_proxy_user_missing", "Trusted proxy user id header is missing."), statusCode: StatusCodes.Status400BadRequest);
            }

            var result = await CreateSessionAsync(userId, secureCookie: true, response, users, clock, cancellationToken);
            return result.Succeeded
                ? CoreJson.Json(new AuthSessionResponse(true, result.User))
                : CoreJson.Json(new ErrorResponse("session_denied", "Host user is missing or disabled."), statusCode: StatusCodes.Status403Forbidden);
        });

        app.MapPost("/api/auth/logout", async (HttpRequest request, HttpResponse response, UserDirectoryStore users, IClock clock, CancellationToken cancellationToken) =>
        {
            await LogoutAsync(request, response, users, clock, cancellationToken);
            return CoreJson.Json(new LogoutResponse("logged_out"));
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
                    CoreJson.Json(await identity.CreateAuthorizationCodeAsync(input.AppId, user.Id, input.RedirectUri, cancellationToken))),
                requireCsrf: true,
                cancellationToken: cancellationToken));

        app.MapPost("/api/auth/apps/token", async (AppTokenExchangeRequest input, AppIdentityService identity, CancellationToken cancellationToken) =>
            await HandleIdentityError(async () => CoreJson.Json(await identity.ExchangeCodeAsync(input.Code, cancellationToken))));

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
                return CoreJson.Json(new ErrorResponse("app_service_token_invalid", "App service token is missing or invalid."), statusCode: StatusCodes.Status401Unauthorized);
            }

            return await HandleIdentityError(async () => CoreJson.Json(await identity.RevalidateAsync(input.AccessToken, callingAppId, cancellationToken)));
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
                    CoreJson.Json(await identity.CreateAuthorizationCodeAsync(appId, user.Id, input.RedirectUri, cancellationToken))),
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
                return CoreJson.Json(new ErrorResponse("redirect_uri_missing", "Redirect URI is required."), statusCode: StatusCodes.Status400BadRequest);
            }

            // This is a top-level browser navigation (the standalone app recovery target). A missing or
            // expired Core session must send the user through /login and resume this exact request
            // afterward, not return a JSON 401 the browser cannot act on. A valid-but-disabled account is
            // terminal: return its 403 as-is rather than bouncing to a login that would reject it anyway.
            var navigation = await CoreSessionAuthorization.ResolveNavigationSessionAsync(request, users, clock, cancellationToken);
            if (navigation.Denied is not null)
            {
                return navigation.Denied;
            }

            if (navigation.User is null)
            {
                var continuation = request.Path + request.QueryString;
                return Results.Redirect($"/login?returnTo={Uri.EscapeDataString(continuation)}");
            }

            return await HandleIdentityError(async () =>
            {
                var authorization = await identity.CreateAuthorizationCodeAsync(appId, navigation.User.Id, redirectUri, cancellationToken);
                return Results.Redirect(authorization.RedirectUri);
            });
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
            return CoreJson.Json(new ErrorResponse(ex.Code, ex.Message), statusCode: MapIdentityErrorStatus(ex.Code));
        }
    }

    // Split the identity error contract by cause so apps can act correctly:
    //   401 - recoverable: the token/code is missing, expired, invalid, or revoked; the app should
    //         drop its cookie and re-authorize.
    //   403 - terminal: the user is authenticated but not allowed (disabled, unassigned, admin-only,
    //         wrong app); the app must show an access-denied state and never auto-redirect (loop guard).
    //   400 - malformed redirect URI (bad caller input).
    //   500 - server fault (signing key could not be initialized).
    // Any unmapped code defaults to 403, the safe terminal choice.
    internal static int MapIdentityErrorStatus(string code) => code switch
    {
        "invalid_code" or "code_expired" or "code_consumed"
            or "token_invalid" or "token_expired" or "token_revoked"
            => StatusCodes.Status401Unauthorized,
        "redirect_uri_invalid" => StatusCodes.Status400BadRequest,
        "signing_key_unavailable" => StatusCodes.Status500InternalServerError,
        _ => StatusCodes.Status403Forbidden,
    };

    // Only a Core-relative app-open continuation may be used as a post-login redirect target, so
    // /login can never be turned into an open redirect. Anything else falls back to the Shell origin.
    internal static string ResolveLoginRedirect(string? returnTo, HostyCoreRuntimeConfig config)
        => IsAllowedLoginReturnTo(returnTo) ? returnTo! : config.EffectiveShellPublicOrigin;

    internal static bool IsAllowedLoginReturnTo(string? returnTo)
    {
        if (string.IsNullOrWhiteSpace(returnTo))
        {
            return false;
        }

        // Reject anything that could escape the Core origin or inject into the Location header:
        // protocol-relative (`//host`), backslash tricks browsers normalize to `//`, and control chars.
        if (returnTo[0] != '/' ||
            returnTo.StartsWith("//", StringComparison.Ordinal) ||
            returnTo.Contains('\\') ||
            returnTo.Any(char.IsControl) ||
            !Uri.TryCreate(returnTo, UriKind.Relative, out _))
        {
            return false;
        }

        var queryIndex = returnTo.IndexOf('?', StringComparison.Ordinal);
        var path = queryIndex >= 0 ? returnTo.AsSpan(0, queryIndex) : returnTo.AsSpan();
        return path.StartsWith("/api/apps/", StringComparison.Ordinal) &&
            path.EndsWith("/open", StringComparison.Ordinal);
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
        var now = clock.UtcNow;
        var result = await users.UpdateAsync<AuthSessionCreateResult>(state =>
        {
            var user = state.Users.FirstOrDefault(candidate => string.Equals(candidate.Id, userId, StringComparison.Ordinal));
            if (user is null || user.Disabled)
            {
                // Abort the write without mutating: return the unchanged state.
                return (state, new AuthSessionCreateResult(false, null));
            }

            var newSession = new AuthSessionRecord(CreateSessionId(), user.Id, now, now.AddHours(12), null);
            return (state with { Sessions = state.Sessions.Append(newSession).ToArray() }, new AuthSessionCreateResult(true, user, newSession));
        }, cancellationToken);

        if (!result.Succeeded || result.Session is null)
        {
            return new AuthSessionCreateResult(false, null);
        }

        var session = result.Session;
        response.Cookies.Append(CoreSessionAuthorization.SessionCookieName, session.Id, new CookieOptions
        {
            HttpOnly = true,
            SameSite = SameSiteMode.Lax,
            Secure = secureCookie,
            Expires = session.ExpiresAt,
        });

        return new AuthSessionCreateResult(true, result.User);
    }

    internal static async Task LogoutAsync(
        HttpRequest request,
        HttpResponse response,
        UserDirectoryStore users,
        IClock clock,
        CancellationToken cancellationToken)
    {
        var sessionId = request.Cookies[CoreSessionAuthorization.SessionCookieName];
        if (!string.IsNullOrWhiteSpace(sessionId))
        {
            await users.UpdateAsync(state => state with
            {
                Sessions = state.Sessions
                    .Select(session => string.Equals(session.Id, sessionId, StringComparison.Ordinal)
                        ? session with { RevokedAt = clock.UtcNow }
                        : session)
                    .ToArray(),
            }, cancellationToken);
        }

        response.Cookies.Delete(CoreSessionAuthorization.SessionCookieName);
    }
}

internal sealed record CsrfResponse(string Token);

internal sealed record AuthSessionCreateRequest(string UserId, bool SecureCookie = false);

internal sealed record AuthSessionResponse(bool Authenticated, HostUserRecord? User);

internal sealed record AuthSessionCreateResult(bool Succeeded, HostUserRecord? User, AuthSessionRecord? Session = null);

internal sealed record LogoutResponse(string Status);

internal sealed record AppAuthorizeRequest(string AppId, string RedirectUri);

internal sealed record AppTokenExchangeRequest(string Code);

internal sealed record AppRevalidateRequest(string AccessToken);

internal sealed record AppLaunchCodeRequest(string RedirectUri);

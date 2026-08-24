using System.Security.Cryptography;
using System.Text;

namespace Haas.Hosty.Core;

internal static class AuthEndpoints
{
    internal const string TrustedProxySecretHeader = "X-Hosty-Trusted-Proxy-Secret";
    internal const string TrustedProxyUserIdHeader = "X-Hosty-Trusted-User-Id";

    public static void Map(WebApplication app)
    {
        app.MapGet("/api/auth/csrf", (HttpRequest request, HttpResponse response) =>
        {
            var token = CreateSessionId();
            response.Cookies.Append(CoreSessionAuthorization.CsrfCookieName, token, new CookieOptions
            {
                HttpOnly = false,
                SameSite = SameSiteMode.Lax,
                // Mirror the session cookie's HTTPS behavior (C-L2): a Secure cookie over plain HTTP is
                // silently dropped, but on an HTTPS origin the CSRF cookie must be Secure like the
                // session it protects, so it is not exposed on an accidental cleartext request.
                Secure = request.IsHttps,
            });

            return CoreJson.Json(new CsrfResponse(token));
        });

        app.MapGet("/api/auth/session", async (HttpRequest request, UserDirectoryStore users, AuthLifetimes lifetimes, CancellationToken cancellationToken) =>
        {
            var state = await users.ReadAsync(cancellationToken);
            var sessionId = CoreSessionAuthorization.ReadSessionId(request);
            var now = DateTimeOffset.UtcNow;
            var session = state.Sessions.FirstOrDefault(candidate =>
                string.Equals(candidate.Id, sessionId, StringComparison.Ordinal) &&
                // A scoped credential is not a session, and this endpoint resolves one by hand rather
                // than through CoreSessionAuthorization — so the rule that holds everywhere else has
                // to be restated here, or the one probe every client makes first would answer with
                // the user record for a credential that may do nothing but read one app's tools.
                candidate.Audience is null &&
                CoreSessionAuthorization.IsSessionLive(candidate, now, lifetimes.IdleFor(candidate.Kind)));
            var user = session is null
                ? null
                : state.Users.FirstOrDefault(candidate => string.Equals(candidate.Id, session.UserId, StringComparison.Ordinal));

            // Kind lets a non-browser client see what it is holding — the Cardputer console reads the
            // role here to warn when it was authorized by a host.user rather than an administrator.
            return CoreJson.Json(new AuthSessionResponse(user is not null && !user.Disabled, user, session?.Kind));
        });

        app.MapPost("/api/auth/session", async (
            AuthSessionCreateRequest input,
            HttpResponse response,
            IHostEnvironment environment,
            UserDirectoryStore users,
            IClock clock,
            AuthLifetimes lifetimes,
            CancellationToken cancellationToken) =>
        {
            if (!environment.IsDevelopment())
            {
                return CoreJson.Json(new ErrorResponse("session_create_unavailable", "Direct session creation is available only in development."), statusCode: StatusCodes.Status404NotFound);
            }

            var result = await CreateSessionAsync(input.UserId, input.SecureCookie, response, users, clock, lifetimes, cancellationToken);
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
            AuthLifetimes lifetimes,
            CancellationToken cancellationToken) =>
        {
            if (string.IsNullOrWhiteSpace(config.TrustedProxySecret))
            {
                return CoreJson.Json(new ErrorResponse("trusted_proxy_disabled", "Trusted proxy session creation is disabled. Set HOSTY_TRUSTED_PROXY_SECRET to enable it."), statusCode: StatusCodes.Status404NotFound);
            }

            var submittedSecret = request.Headers[TrustedProxySecretHeader].ToString();
            if (!SecretComparison.Equals(config.TrustedProxySecret, submittedSecret))
            {
                return CoreJson.Json(new ErrorResponse("trusted_proxy_unauthorized", "Trusted proxy secret is missing or invalid."), statusCode: StatusCodes.Status401Unauthorized);
            }

            var userId = request.Headers[TrustedProxyUserIdHeader].ToString();
            if (string.IsNullOrWhiteSpace(userId))
            {
                return CoreJson.Json(new ErrorResponse("trusted_proxy_user_missing", "Trusted proxy user id header is missing."), statusCode: StatusCodes.Status400BadRequest);
            }

            var result = await CreateSessionAsync(userId, secureCookie: true, response, users, clock, lifetimes, cancellationToken);
            return result.Succeeded
                ? CoreJson.Json(new AuthSessionResponse(true, result.User))
                : CoreJson.Json(new ErrorResponse("session_denied", "Host user is missing or disabled."), statusCode: StatusCodes.Status403Forbidden);
        });

        app.MapPost("/api/auth/logout", async (HttpRequest request, HttpResponse response, UserDirectoryStore users, AppSessionGrantStore grants, IClock clock, CancellationToken cancellationToken) =>
        {
            // Logout revokes the session (and cascades to app grants), so it is a state change that must
            // carry CSRF — otherwise a cross-site POST could log the user out (C-L2). No session is
            // required beyond that: logging out an already-gone session is a harmless no-op, so gate on
            // CSRF alone rather than a full session to keep it idempotent near expiry.
            if (!CoreSessionAuthorization.IsCsrfExempt(request) && !CoreSessionAuthorization.HasValidCsrfToken(request))
            {
                return CoreJson.Json(new ErrorResponse("csrf_invalid", "CSRF token is missing or invalid."), statusCode: StatusCodes.Status403Forbidden);
            }

            await LogoutAsync(request, response, users, grants, clock, cancellationToken);
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
                    CoreJson.Json(await identity.CreateAuthorizationCodeAsync(
                        input.AppId, user.Id, input.RedirectUri, CoreSessionAuthorization.ReadSessionId(request), cancellationToken))),
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
                    CoreJson.Json(await identity.CreateAuthorizationCodeAsync(
                        appId, user.Id, input.RedirectUri, CoreSessionAuthorization.ReadSessionId(request), cancellationToken))),
                requireCsrf: true,
                cancellationToken: cancellationToken));

        // Trades the caller's Core session for a short-TTL signed token (audience = the app) that
        // the browser presents when calling a system app's API directly — the Shell→system-app
        // data-plane path (docs/features/ai-gateway/plan.md). The receiving app validates it
        // locally with the public key Core injects into its environment; Core stays out of the
        // per-request path. Refresh = call again: every issue re-runs the full access policy, so a
        // role downgrade or removed assignment stops fresh tokens within one 5-minute TTL.
        app.MapPost("/api/apps/{appId}/delegated-token", async (
            string appId,
            HttpRequest request,
            UserDirectoryStore users,
            IClock clock,
            AppIdentityService identity,
            DelegatedTokenService delegatedTokens,
            AppRegistryStore apps,
            AuditStore audit,
            CancellationToken cancellationToken) =>
        {
            // Two credentials reach this route. A Core session is the browser path, unchanged. A
            // delegated token is the exchange (docs/features/delegated-token-exchange/plan.md): a
            // system app trades the token it was given for one scoped to another app, so an agent can
            // call app MCP endpoints on behalf of the user currently talking to it. The exchange is
            // tried first only because it is unambiguous — a bearer that parses as a Core-signed
            // delegated token was never a session id.
            var presented = CoreSessionAuthorization.ReadBearerToken(request);
            if (!string.IsNullOrWhiteSpace(presented) && delegatedTokens.ReadClaims(presented) is { } claims)
            {
                return await ExchangeDelegatedTokenAsync(
                    appId, claims, identity, delegatedTokens, apps, audit, clock, cancellationToken);
            }

            return await CoreSessionAuthorization.RequireSessionAsync(
                request,
                users,
                clock,
                async user => await HandleIdentityError(async () =>
                {
                    var (actor, target) = await identity.RequireAccessibleUserAsync(appId, user.Id, cancellationToken);
                    return CoreJson.Json(delegatedTokens.CreateToken(target.Id, actor.Id, actor.Role));
                }),
                requireCsrf: true,
                cancellationToken: cancellationToken);
        });

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
                var authorization = await identity.CreateAuthorizationCodeAsync(
                    appId, navigation.User.Id, redirectUri, CoreSessionAuthorization.ReadSessionId(request), cancellationToken);
                return Results.Redirect(authorization.RedirectUri);
            });
        });
    }

    // The exchange (docs/features/delegated-token-exchange/plan.md). Bounds, in the order a reader
    // should think about them:
    //
    //   * the CALLER is the presented token's audience — not something it asserts, which is why the
    //     claims are read without pinning an audience;
    //   * only a SYSTEM app may exchange, because a domain app calling another is a different trust
    //     story (cross-app-dependencies) that nobody has designed yet;
    //   * a BRANCHED token may only be refreshed, never branched again — that is what stops reach
    //     spreading app to app, while leaving a caller able to keep its own credential alive;
    //   * the chain expires an hour after the human interaction it descends from, so a stolen
    //     credential is bounded without a revocation store.
    //
    // Everything else is the ordinary issue path: the same access policy runs, so the result is never
    // stronger than what the user could obtain through Shell themselves.
    private static async Task<IResult> ExchangeDelegatedTokenAsync(
        string targetAppId,
        DelegatedTokenPayload claims,
        AppIdentityService identity,
        DelegatedTokenService delegatedTokens,
        AppRegistryStore apps,
        AuditStore audit,
        IClock clock,
        CancellationToken cancellationToken)
    {
        var callerAppId = claims.Aud;
        var target = targetAppId.Trim();
        var branching = !string.Equals(callerAppId, target, StringComparison.Ordinal);

        async Task<IResult> DenyAsync(string code, string message, int status)
        {
            await AppendExchangeAuditAsync(audit, claims, callerAppId, target, code, clock, cancellationToken);
            return CoreJson.Json(new ErrorResponse(code, message), statusCode: status);
        }

        var caller = await apps.GetAppAsync(callerAppId, cancellationToken);
        if (caller is null || !caller.System)
        {
            return await DenyAsync(
                "exchange_forbidden",
                "Only an installed system app may exchange a delegated token.",
                StatusCodes.Status403Forbidden);
        }

        if (claims.Branched == true && branching)
        {
            return await DenyAsync(
                "exchange_chain_forbidden",
                "A token obtained by exchange may be refreshed for its own audience, never exchanged for another app.",
                StatusCodes.Status403Forbidden);
        }

        var origin = claims.ChainOriginOrIat;
        if (clock.UtcNow.ToUnixTimeSeconds() - origin > (long)DelegatedTokenService.ChainLifetime.TotalSeconds)
        {
            return await DenyAsync(
                "exchange_chain_expired",
                "This delegation chain is older than the maximum lifetime; the user must interact again.",
                StatusCodes.Status403Forbidden);
        }

        // The access-policy refusals — an unassigned member, a disabled user, an uninstalled target —
        // are raised as AppIdentityException. HandleIdentityError converts them to a response WITHOUT
        // rethrowing, so wrapping it would have produced dead code; the exception is caught here
        // instead and mapped with the same rules. Auditing only the success path would have dropped
        // exactly the refusals this trail exists to keep.
        try
        {
            var (actor, resolved) = await identity.RequireAccessibleUserAsync(target, claims.Sub, cancellationToken);
            var issued = delegatedTokens.CreateToken(
                resolved.Id,
                actor.Id,
                actor.Role,
                chainOrigin: origin,
                branched: claims.Branched == true || branching);
            await AppendExchangeAuditAsync(audit, claims, callerAppId, target, "succeeded", clock, cancellationToken);
            return CoreJson.Json(issued);
        }
        catch (AppIdentityException exception)
        {
            await AppendExchangeAuditAsync(audit, claims, callerAppId, target, exception.Code, clock, cancellationToken);
            return CoreJson.Json(
                new ErrorResponse(exception.Code, exception.Message),
                statusCode: MapIdentityErrorStatus(exception.Code));
        }
    }

    private static Task AppendExchangeAuditAsync(
        AuditStore audit,
        DelegatedTokenPayload claims,
        string callerAppId,
        string targetAppId,
        string outcome,
        IClock clock,
        CancellationToken cancellationToken)
        // Recorded on every attempt, not only on success: this is the one place where an app acts as a
        // user toward another app, and a refusal is the more interesting half of that record.
        => audit.AppendAsync(
            new AuditRecord(
                Id: $"audit_{Guid.NewGuid():N}",
                Action: "auth.delegated-token.exchange",
                ResourceType: "app",
                ResourceId: targetAppId,
                Outcome: outcome,
                ActorUserId: claims.Sub,
                CreatedAt: clock.UtcNow,
                Details: new Dictionary<string, string>
                {
                    ["callerAppId"] = callerAppId,
                    ["targetAppId"] = targetAppId,
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

    // Two shapes may be used as a post-login redirect target. Both are relative and both pass the same
    // hardening, so /login can never be turned into an open redirect:
    //
    //   - a Core-relative app-open continuation, which stays on this origin;
    //   - any other relative path, resolved against the Shell origin. It cannot leave that origin — a
    //     relative path appended to it can only extend it — and Shell's pages sit at the root of it, so
    //     there is no prefix to match on that would not have to be revised every time it gains a page.
    //
    // The second exists because a destination inside Shell otherwise cannot survive a sign-in. Shell
    // sends a browser with no session here and gets it back at its bare origin, which loses the page it
    // was heading for — including the device authorization approval screen, where someone is waiting to
    // approve a pending code. A browser with no session is exactly the browser this matters in.
    //
    // Anything else falls back to the Shell origin — and null when this host has no Shell (an optional
    // distribution app), because then there is genuinely nowhere to send the browser and the caller has
    // to say so instead of inventing a target.
    internal static string? ResolveLoginRedirect(string? returnTo, string? shellOrigin)
    {
        if (IsAllowedLoginReturnTo(returnTo))
        {
            return returnTo!;
        }

        // Concatenated onto the Shell origin rather than parsed into a URL: the value has already been
        // checked to be a relative path that cannot begin with `//`, so it can only extend that origin.
        return shellOrigin is not null && IsAllowedShellReturnTo(returnTo)
            ? $"{shellOrigin.TrimEnd('/')}{returnTo}"
            : shellOrigin;
    }

    /// Whether this is a continuation /login may echo back into its form and act on afterwards.
    internal static bool IsAllowedLoginContinuation(string? returnTo)
        => IsAllowedLoginReturnTo(returnTo) || IsAllowedShellReturnTo(returnTo);

    internal static bool IsAllowedLoginReturnTo(string? returnTo)
        => IsRelativeContinuation(returnTo, out var path) &&
            path.StartsWith("/api/apps/", StringComparison.Ordinal) &&
            path.EndsWith("/open", StringComparison.Ordinal);

    internal static bool IsAllowedShellReturnTo(string? returnTo)
        => IsRelativeContinuation(returnTo, out _);

    /// The shared hardening: a relative path this Core can hand to a browser, and its path portion.
    private static bool IsRelativeContinuation(string? returnTo, out ReadOnlySpan<char> path)
    {
        path = default;
        if (string.IsNullOrWhiteSpace(returnTo))
        {
            return false;
        }

        // Reject anything that could escape the origin or inject into the Location header:
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
        path = queryIndex >= 0 ? returnTo.AsSpan(0, queryIndex) : returnTo.AsSpan();
        return true;
    }

    private static string CreateSessionId()
        => Convert.ToHexString(RandomNumberGenerator.GetBytes(32)).ToLowerInvariant();

    // Sessions carry an absolute cap (ExpiresAt) plus a sliding idle window (LastSeenAt + idle TTL). Dead
    // records are pruned opportunistically on write so the list does not grow unbounded now that lifetimes
    // are days, not hours; recently revoked ones linger briefly for diagnostics.
    private static readonly TimeSpan SessionRevokedRetention = TimeSpan.FromDays(7);

    internal static async Task<AuthSessionCreateResult> CreateSessionAsync(
        string userId,
        bool secureCookie,
        HttpResponse response,
        UserDirectoryStore users,
        IClock clock,
        AuthLifetimes lifetimes,
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

            var newSession = new AuthSessionRecord(
                CreateSessionId(),
                user.Id,
                now,
                now.Add(lifetimes.CoreSessionAbsolute),
                null,
                LastSeenAt: now);
            var sessions = PruneSessions(state.Sessions, now, lifetimes).Append(newSession).ToArray();
            return (state with { Sessions = sessions }, new AuthSessionCreateResult(true, user, newSession));
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
        AppSessionGrantStore grants,
        IClock clock,
        CancellationToken cancellationToken)
    {
        // However the caller presented the session: a bearer client must be able to end its own session,
        // and the cascade below is the only thing that revokes the app grants it authorized.
        var sessionId = CoreSessionAuthorization.ReadSessionId(request);
        if (!string.IsNullOrWhiteSpace(sessionId))
        {
            var now = clock.UtcNow;
            await users.UpdateAsync(state => state with
            {
                Sessions = state.Sessions
                    .Select(session => string.Equals(session.Id, sessionId, StringComparison.Ordinal)
                        ? session with { RevokedAt = now }
                        : session)
                    .ToArray(),
            }, cancellationToken);

            // Explicit logout is an intent to leave: cascade-revoke the app session grants this Core
            // session authorized. (Grants otherwise outlive an expired Core session.)
            await grants.RevokeByAuthorizingSessionAsync(sessionId, now, cancellationToken);
        }

        response.Cookies.Delete(CoreSessionAuthorization.SessionCookieName);
    }

    // Keep a session only while it is still usable — live within both the absolute and sliding idle
    // windows — or was revoked recently enough to remain visible for diagnostics. This drops idle-expired
    // sessions too, so a large absolute cap does not let the list grow with long-idle records.
    // Every record is judged by its own kind's idle window. Applying one window to the whole list would
    // let a browser login prune a live access token, whose window is much longer — the pruning caller is
    // a session write, but the list it rewrites holds both.
    internal static IEnumerable<AuthSessionRecord> PruneSessions(
        IEnumerable<AuthSessionRecord> sessions,
        DateTimeOffset now,
        AuthLifetimes lifetimes)
        => sessions.Where(session =>
            session.RevokedAt is not null
                ? now - session.RevokedAt.Value < SessionRevokedRetention
                : CoreSessionAuthorization.IsSessionLive(session, now, lifetimes.IdleFor(session.Kind)));
}

internal sealed record CsrfResponse(string Token);

internal sealed record AuthSessionCreateRequest(string UserId, bool SecureCookie = false);

internal sealed record AuthSessionResponse(bool Authenticated, HostUserRecord? User, string? Kind = null);

internal sealed record AuthSessionCreateResult(bool Succeeded, HostUserRecord? User, AuthSessionRecord? Session = null);

internal sealed record LogoutResponse(string Status);

internal sealed record AppAuthorizeRequest(string AppId, string RedirectUri);

internal sealed record AppTokenExchangeRequest(string Code);

internal sealed record AppRevalidateRequest(string AccessToken);

internal sealed record AppLaunchCodeRequest(string RedirectUri);

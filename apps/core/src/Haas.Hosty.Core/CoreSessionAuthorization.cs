using Microsoft.Extensions.DependencyInjection;

namespace Haas.Hosty.Core;

internal static class CoreSessionAuthorization
{
    public const string SessionCookieName = "hosty_session";
    public const string CsrfCookieName = "hosty_csrf";
    public const string CsrfHeaderName = "X-Hosty-CSRF";

    // Slide the session idle window at most once per this interval; idle TTLs are days, so a few minutes
    // of imprecision is irrelevant and this keeps per-request resolution from rewriting the store.
    private static readonly TimeSpan TouchThrottle = TimeSpan.FromMinutes(5);

    // A session is live only while it is unrevoked, within its absolute cap (ExpiresAt), and within the
    // sliding idle window (last use + idle TTL). Records written before sliding shipped have no LastSeenAt
    // and fall back to CreatedAt.
    public static bool IsSessionLive(AuthSessionRecord session, DateTimeOffset now, TimeSpan idle)
        => session.RevokedAt is null &&
            session.ExpiresAt > now &&
            (session.LastSeenAt ?? session.CreatedAt).Add(idle) > now;

    public static async Task<IResult> RequireAdminSessionAsync(
        HttpRequest request,
        UserDirectoryStore users,
        IClock clock,
        Func<Task<IResult>> action,
        bool requireCsrf = false,
        CancellationToken cancellationToken = default)
    {
        if (requireCsrf && !HasValidCsrfToken(request))
        {
            return CoreJson.Json(
                new ErrorResponse("csrf_invalid", "CSRF token is missing or invalid."),
                statusCode: StatusCodes.Status403Forbidden);
        }

        return await RequireSessionAsync(
            request,
            users,
            clock,
            user =>
            {
                if (!string.Equals(user.Role, "host.admin", StringComparison.Ordinal))
                {
                    return Task.FromResult<IResult>(CoreJson.Json(
                        new ErrorResponse("admin_required", "This Core operation requires a Host administrator session."),
                        statusCode: StatusCodes.Status403Forbidden));
                }

                return action();
            },
            cancellationToken: cancellationToken);
    }

    public static async Task<IResult> RequireSessionAsync(
        HttpRequest request,
        UserDirectoryStore users,
        IClock clock,
        Func<HostUserRecord, Task<IResult>> action,
        bool requireCsrf = false,
        CancellationToken cancellationToken = default)
    {
        if (requireCsrf && !HasValidCsrfToken(request))
        {
            return CoreJson.Json(
                new ErrorResponse("csrf_invalid", "CSRF token is missing or invalid."),
                statusCode: StatusCodes.Status403Forbidden);
        }

        var authorization = await ResolveSessionAsync(request, users, clock, cancellationToken);
        if (authorization.Error is not null)
        {
            return authorization.Error;
        }

        return await action(authorization.User!);
    }

    // Non-throwing session probe for endpoints that stay public but reveal more to a signed-in caller
    // (e.g. /api/core/status). Returns the user on a valid session, null otherwise — never an error result.
    public static async Task<HostUserRecord?> TryResolveSessionAsync(
        HttpRequest request,
        UserDirectoryStore users,
        IClock clock,
        CancellationToken cancellationToken = default)
    {
        var authorization = await ResolveSessionAsync(request, users, clock, cancellationToken);
        return authorization.User;
    }

    // Session resolution for top-level navigation endpoints (e.g. /api/apps/{id}/open). Distinguishes an
    // authenticated user, a terminal denial (a signed-in but disabled user — return Denied as-is so the
    // 403 contract holds), and a missing/expired session (both null — the caller recovers by sending the
    // user to /login).
    public static async Task<NavigationSessionResult> ResolveNavigationSessionAsync(
        HttpRequest request,
        UserDirectoryStore users,
        IClock clock,
        CancellationToken cancellationToken = default)
    {
        var authorization = await ResolveSessionAsync(request, users, clock, cancellationToken);
        if (authorization.User is not null)
        {
            return new NavigationSessionResult(authorization.User, null);
        }

        return new NavigationSessionResult(null, authorization.Terminal ? authorization.Error : null);
    }

    // The Core session id is the session cookie value. Exposed so identity flows can stamp the grant they
    // issue with the authorizing session, enabling the explicit-logout cascade.
    public static string? ReadSessionId(HttpRequest request)
        => request.Cookies[SessionCookieName];

    public static string? ReadBearerToken(HttpRequest request)
    {
        if (!request.Headers.TryGetValue("Authorization", out var header))
        {
            return null;
        }

        var value = header.ToString();
        return value.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase)
            ? value["Bearer ".Length..].Trim()
            : null;
    }

    private static bool HasValidCsrfToken(HttpRequest request)
    {
        var cookie = request.Cookies[CsrfCookieName];
        var header = request.Headers[CsrfHeaderName].ToString();
        return !string.IsNullOrWhiteSpace(cookie) &&
            !string.IsNullOrWhiteSpace(header) &&
            string.Equals(cookie, header, StringComparison.Ordinal);
    }

    private static async Task<CoreSessionAuthorizationResult> ResolveSessionAsync(
        HttpRequest request,
        UserDirectoryStore users,
        IClock clock,
        CancellationToken cancellationToken)
    {
        var sessionId = request.Cookies[SessionCookieName];
        if (string.IsNullOrWhiteSpace(sessionId))
        {
            return Unauthorized("session_missing", "Core session cookie is missing.");
        }

        var now = clock.UtcNow;
        var idle = ResolveLifetimes(request).CoreSessionIdle;
        var state = await users.ReadAsync(cancellationToken);
        var session = state.Sessions.FirstOrDefault(candidate =>
            string.Equals(candidate.Id, sessionId, StringComparison.Ordinal) &&
            IsSessionLive(candidate, now, idle));
        if (session is null)
        {
            return Unauthorized("session_invalid", "Core session is missing, expired, or revoked.");
        }

        var user = state.Users.FirstOrDefault(candidate => string.Equals(candidate.Id, session.UserId, StringComparison.Ordinal));
        if (user is null)
        {
            return Unauthorized("session_user_missing", "Core session user was not found.");
        }

        if (user.Disabled)
        {
            // Terminal: the session is valid but the account is disabled. A navigation caller must not
            // treat this as a missing session and bounce to /login (login rejects disabled users anyway).
            return new CoreSessionAuthorizationResult(
                null,
                CoreJson.Json(
                    new ErrorResponse("user_disabled", "Core session user is disabled."),
                    statusCode: StatusCodes.Status403Forbidden),
                Terminal: true);
        }

        await TouchSessionAsync(users, session, now, cancellationToken);
        return new CoreSessionAuthorizationResult(user, null);
    }

    private static AuthLifetimes ResolveLifetimes(HttpRequest request)
        => request.HttpContext.RequestServices?.GetService<AuthLifetimes>() ?? AuthLifetimes.Defaults;

    // Advance the idle window on authenticated use, throttled. Best-effort: a concurrent write that already
    // removed or revoked the session simply leaves it unchanged (the FirstOrDefault guard inside the
    // mutation), and a failure here must not fail the authenticated request, so it is fire-and-forget-safe.
    private static async Task TouchSessionAsync(
        UserDirectoryStore users,
        AuthSessionRecord session,
        DateTimeOffset now,
        CancellationToken cancellationToken)
    {
        if (now - (session.LastSeenAt ?? session.CreatedAt) < TouchThrottle)
        {
            return;
        }

        await users.UpdateAsync(state => state with
        {
            Sessions = state.Sessions
                .Select(candidate => string.Equals(candidate.Id, session.Id, StringComparison.Ordinal) && candidate.RevokedAt is null
                    ? candidate with { LastSeenAt = now }
                    : candidate)
                .ToArray(),
        }, cancellationToken);
    }

    private static CoreSessionAuthorizationResult Unauthorized(string code, string message)
        => new(
            null,
            CoreJson.Json(
                new ErrorResponse(code, message),
                statusCode: StatusCodes.Status401Unauthorized));
}

internal sealed record CoreSessionAuthorizationResult(HostUserRecord? User, IResult? Error, bool Terminal = false);

// User is set on a valid session; otherwise Denied is the terminal result to return as-is (e.g. disabled
// account), or both are null to signal a missing/expired session the caller should recover via /login.
internal sealed record NavigationSessionResult(HostUserRecord? User, IResult? Denied);

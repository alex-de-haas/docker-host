using System.Security.Cryptography;
using System.Text;
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
        if (requireCsrf && !IsCsrfExempt(request) && !HasValidCsrfToken(request))
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
        if (requireCsrf && !IsCsrfExempt(request) && !HasValidCsrfToken(request))
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

    // The Core session id, however the caller presented it. Exposed so identity flows can stamp the grant
    // they issue with the authorizing session, enabling the explicit-logout cascade.
    public static string? ReadSessionId(HttpRequest request)
        => ReadSessionCredential(request).Value;

    // A session id IS the bearer credential, so it must never leave Core in a listing. This is the
    // leak-safe stand-in every projection uses: stable, derived, and useless to replay. Callers that
    // need to act on a specific record (revoking a credential, say) match on this and look the real id
    // up server-side.
    public static string FingerprintSessionId(string id)
        => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(id)))[..12].ToLowerInvariant();

    // How the caller presented its session, which decides whether CSRF applies.
    //
    // A cookie is ambient: the browser attaches it to any request to this origin, including one a hostile
    // page provoked, which is the entire reason mutations carry a CSRF token. A bearer header is attached
    // deliberately by a client that holds the session id — and page script cannot read it, because the
    // session cookie is HttpOnly — so a cross-origin page cannot construct one and there is nothing for a
    // CSRF pair to defend. Native clients use the bearer form; see docs/features/swift-shell/.
    //
    // The cookie is read first and wins outright. If a request that carries a session cookie could select
    // the bearer path merely by adding a header, it would select its own way out of the CSRF check.
    public static SessionCredential ReadSessionCredential(HttpRequest request)
    {
        var cookie = request.Cookies[SessionCookieName];
        if (!string.IsNullOrWhiteSpace(cookie))
        {
            return new SessionCredential(cookie, SessionCredentialSource.Cookie);
        }

        var bearer = ReadBearerToken(request);
        return string.IsNullOrWhiteSpace(bearer)
            ? new SessionCredential(null, SessionCredentialSource.None)
            : new SessionCredential(bearer, SessionCredentialSource.Bearer);
    }

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

    // Only a bearer-presented session skips the CSRF pair. A request with no credential at all is
    // deliberately NOT exempt: it is answered exactly as before this path existed, so the only behavior
    // that changed is the one a browser cannot produce.
    // Internal so the logout endpoint, which gates on CSRF without requiring a session, applies the same
    // rule — otherwise a bearer client could authenticate but never end its own session.
    internal static bool IsCsrfExempt(HttpRequest request)
        => ReadSessionCredential(request).Source == SessionCredentialSource.Bearer;

    // Double-submit check: the CSRF cookie (readable JS, set by /api/auth/csrf) must equal the
    // X-Hosty-CSRF header. Both values are client-supplied and identical by construction, so there is
    // no secret to leak — ordinary equality is fine here (unlike the server-held secrets in C-L1).
    // Internal so the logout endpoint can gate on CSRF without pulling in a full session requirement.
    internal static bool HasValidCsrfToken(HttpRequest request)
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
        var sessionId = ReadSessionCredential(request).Value;
        if (string.IsNullOrWhiteSpace(sessionId))
        {
            return Unauthorized("session_missing", "Core session cookie is missing.");
        }

        var now = clock.UtcNow;
        var lifetimes = ResolveLifetimes(request);
        var state = await users.ReadAsync(cancellationToken);
        // The record is looked up first and judged second, rather than in one predicate: a dead record
        // still knows *how* it died, and the refusal below says so. The idle window is resolved from the
        // record rather than once up front, because a browser session and an access token live by
        // different clocks and both resolve through here.
        var session = state.Sessions.FirstOrDefault(candidate =>
            string.Equals(candidate.Id, sessionId, StringComparison.Ordinal));
        if (session is null || !IsSessionLive(session, now, lifetimes.IdleFor(session.Kind)))
        {
            return Unauthorized("session_invalid", DescribeDeadCredential(session, now));
        }

        // A scoped credential is not a session, and this is the line that makes that true.
        //
        // Audience and scopes were added to the *same* record deliberately (revocation, the idle
        // window and the logout cascade already work on it), which means every existing /api route
        // would otherwise accept one the moment it was issued — a credential minted to read one
        // app's MCP tools would install apps. So the refusal lives here, once, ahead of every route,
        // rather than being an opt-in each route could forget. A route that wants to accept a scoped
        // credential says so itself and checks the scope it needs (Core MCP does).
        //
        // 403 rather than 401: the credential is valid and the holder knows what they presented, so
        // naming the audience is the difference between a fixable mistake and an unexplained refusal.
        if (session.Audience is { } audience)
        {
            return new CoreSessionAuthorizationResult(
                null,
                CoreJson.Json(
                    new ErrorResponse(
                        "credential_scoped",
                        $"This credential is scoped to '{audience}' and cannot be used as a Core session."),
                    statusCode: StatusCodes.Status403Forbidden),
                Terminal: true);
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
    // Internal so scoped-credential resolution slides the same window the session path does: a token used
    // daily through an app's MCP endpoint is in use, and would otherwise idle out as though it were not.
    internal static async Task TouchSessionAsync(
        UserDirectoryStore users,
        AuthSessionRecord session,
        DateTimeOffset now,
        CancellationToken cancellationToken)
    {
        if (now - (session.LastSeenAt ?? session.CreatedAt) < TouchThrottle)
        {
            return;
        }

        try
        {
            await users.UpdateAsync(state => state with
            {
                Sessions = state.Sessions
                    .Select(candidate => string.Equals(candidate.Id, session.Id, StringComparison.Ordinal) && candidate.RevokedAt is null
                        ? candidate with { LastSeenAt = now }
                        : candidate)
                    .ToArray(),
            }, cancellationToken);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            // Sliding the idle window is advisory; a transient I/O or concurrency failure must not fail the
            // authenticated request. Client cancellation still propagates. The window slides on the next use.
        }
    }

    // Why the credential was refused, in the words an operator debugging a client needs. IsSessionLive
    // folds three conditions into one boolean, and revoked-versus-expired is exactly the distinction
    // someone reads this message to make: on 2026-09-06 a revoked OAuth grant read as an expiry to the
    // client watching it fail (docs/features/mcp-oauth/feature.md).
    //
    // The code stays `session_invalid` for every cause. Callers classify Core's refusals on the status
    // class and pass the code through for logging (docs/features/auth-session-lifecycle/feature.md), and
    // all four causes lead to the same recovery — authenticate again — so a new code would add a Core
    // HTTP API surface callers could match on without buying any of them new behavior.
    //
    // Naming the cause tells the caller nothing about anyone else: it already holds the exact credential
    // being described, and ids are 256 bits of randomness, so "revoked" versus "never existed" is not an
    // oracle anything can walk.
    private static string DescribeDeadCredential(AuthSessionRecord? session, DateTimeOffset now)
    {
        if (session is null)
        {
            // Dead records are pruned (revoked ones after 7 days), so an id whose record is gone is
            // genuinely indistinguishable from one that never existed — the one case where the old
            // three-way sentence is still the honest answer.
            return "Core session is missing, expired, or revoked.";
        }

        // An access token is not a "session" to the person holding it, and the credential most likely to
        // die here is an OAuth-issued one whose grant was revoked on the tokens page.
        var subject = AccessTokenKinds.IsAccessToken(session.Kind) ? "access token" : "Core session";

        if (session.RevokedAt is not null)
        {
            // Revocation wins over an expiry that also applies: it is the deliberate act, and it is the
            // one the operator is trying to confirm landed.
            return $"This {subject} was revoked.";
        }

        // Whichever window ran out is named, because they are tuned by different settings: the absolute
        // cap versus the sliding idle window (see AuthLifetimes).
        return session.ExpiresAt <= now
            ? $"This {subject} has expired."
            : $"This {subject} expired after its idle window elapsed.";
    }

    private static CoreSessionAuthorizationResult Unauthorized(string code, string message)
        => new(
            null,
            CoreJson.Json(
                new ErrorResponse(code, message),
                statusCode: StatusCodes.Status401Unauthorized));
}

// How a Core session credential reached Core. See CoreSessionAuthorization.ReadSessionCredential.
internal enum SessionCredentialSource
{
    None,
    Cookie,
    Bearer,
}

internal readonly record struct SessionCredential(string? Value, SessionCredentialSource Source);

internal sealed record CoreSessionAuthorizationResult(HostUserRecord? User, IResult? Error, bool Terminal = false);

// User is set on a valid session; otherwise Denied is the terminal result to return as-is (e.g. disabled
// account), or both are null to signal a missing/expired session the caller should recover via /login.
internal sealed record NavigationSessionResult(HostUserRecord? User, IResult? Denied);

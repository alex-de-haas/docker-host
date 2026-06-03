namespace Haas.Hosty.Core;

internal static class CoreSessionAuthorization
{
    public const string SessionCookieName = "hosty_session";
    public const string CsrfCookieName = "hosty_csrf";
    public const string CsrfHeaderName = "X-Hosty-CSRF";

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
            return Results.Json(
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
                    return Task.FromResult<IResult>(Results.Json(
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
            return Results.Json(
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

        var state = await users.ReadAsync(cancellationToken);
        var session = state.Sessions.FirstOrDefault(candidate =>
            string.Equals(candidate.Id, sessionId, StringComparison.Ordinal) &&
            candidate.RevokedAt is null &&
            candidate.ExpiresAt > clock.UtcNow);
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
            return new CoreSessionAuthorizationResult(
                null,
                Results.Json(
                    new ErrorResponse("user_disabled", "Core session user is disabled."),
                    statusCode: StatusCodes.Status403Forbidden));
        }

        return new CoreSessionAuthorizationResult(user, null);
    }

    private static CoreSessionAuthorizationResult Unauthorized(string code, string message)
        => new(
            null,
            Results.Json(
                new ErrorResponse(code, message),
                statusCode: StatusCodes.Status401Unauthorized));
}

internal sealed record CoreSessionAuthorizationResult(HostUserRecord? User, IResult? Error);

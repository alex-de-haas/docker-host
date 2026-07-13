using System.Security.Cryptography;
using System.Text;

namespace Haas.Hosty.Core;

internal sealed class AppIdentityService(
    UserDirectoryStore users,
    AppAuthCodeStore codes,
    AppRegistryStore apps,
    AppSessionGrantStore grants,
    AuthLifetimes lifetimes,
    IClock clock)
{
    private static readonly TimeSpan AuthCodeLifetime = TimeSpan.FromMinutes(5);
    // The idle window slides on use, but rewriting the grant store on every server render is wasteful, so
    // LastSeenAt is only advanced once per this window. Idle TTLs are days, so minutes of imprecision are
    // irrelevant.
    private static readonly TimeSpan TouchThrottle = TimeSpan.FromMinutes(5);

    private const string GrantTokenPrefix = "hostyg_";

    public async Task<AppAuthorizeResult> CreateAuthorizationCodeAsync(
        string appId,
        string userId,
        string redirectUri,
        string? authorizingSessionId = null,
        CancellationToken cancellationToken = default)
    {
        await RequireAllowedRedirectUriAsync(appId, redirectUri, cancellationToken);
        var (user, _) = await RequireAccessibleUserAsync(appId, userId, cancellationToken);
        var now = clock.UtcNow;
        var code = CreateOpaqueToken();
        await codes.AppendCodeAsync(
            new AppAuthCodeRecord(code, appId, user.Id, redirectUri, now, now.Add(AuthCodeLifetime), null, authorizingSessionId),
            now,
            cancellationToken);

        return new AppAuthorizeResult(code, BuildRedirectUri(redirectUri, code), now.Add(AuthCodeLifetime));
    }

    public async Task<AppIdentityTokenResult> ExchangeCodeAsync(string code, CancellationToken cancellationToken = default)
    {
        var result = await codes.ConsumeCodeAsync(code, clock.UtcNow, cancellationToken);
        var match = result.Outcome switch
        {
            AppAuthCodeConsumeOutcome.Consumed => result.Record!,
            AppAuthCodeConsumeOutcome.AlreadyConsumed => throw new AppIdentityException("code_consumed", "Authorization code has already been consumed."),
            AppAuthCodeConsumeOutcome.Expired => throw new AppIdentityException("code_expired", "Authorization code has expired."),
            _ => throw new AppIdentityException("invalid_code", "Authorization code is invalid."),
        };

        var (user, app) = await RequireAccessibleUserAsync(match.AppId, match.UserId, cancellationToken);
        return await CreateGrantAsync(app, user, AppGrantIssuedVia.Code, match.AuthorizingSessionId, cancellationToken);
    }

    public async Task<AppIdentityTokenResult> CreateLaunchTokenAsync(
        string appId,
        string userId,
        CancellationToken cancellationToken = default)
    {
        var (user, app) = await RequireAccessibleUserAsync(appId, userId, cancellationToken);
        return await CreateGrantAsync(app, user, AppGrantIssuedVia.CliDiagnostic, authorizingSessionId: null, cancellationToken);
    }

    public async Task<AppSessionValidationResult> RevalidateAsync(
        string token,
        string callingAppId,
        CancellationToken cancellationToken = default)
    {
        var now = clock.UtcNow;
        var tokenHash = HashToken(token);
        var grant = await grants.TryResolveAsync(tokenHash, cancellationToken) ??
            throw new AppIdentityException("token_invalid", "App session token is not recognized.");

        if (grant.RevokedAt is not null)
        {
            throw new AppIdentityException("token_revoked", "App session has been revoked.");
        }

        if (grant.AbsoluteExpiresAt <= now)
        {
            throw new AppIdentityException("token_expired", "App session has reached its maximum lifetime.");
        }

        if (!string.Equals(grant.AppId, callingAppId, StringComparison.Ordinal))
        {
            throw new AppIdentityException("token_app_mismatch", "App session token was issued for a different app.");
        }

        // Policy (disabled / unassigned / system-app-admin / role downgrade) is re-checked online on every
        // revalidation — the primary revocation guarantee — so grant TTLs can be long without weakening it.
        var (user, app) = await RequireAccessibleUserAsync(grant.AppId, grant.UserId, cancellationToken);

        var (idle, _) = lifetimes.ForGrant(app.System, grant.IssuedVia);
        if (grant.LastSeenAt.Add(idle) <= now)
        {
            throw new AppIdentityException("token_expired", "App session has been idle too long.");
        }

        // Fast path: skip the store round-trip (read + mutex) on the common throttled case. TouchAsync
        // re-checks the throttle under the lock, so a racing writer cannot cause a double advance.
        if (now - grant.LastSeenAt >= TouchThrottle)
        {
            await grants.TouchAsync(tokenHash, now, TouchThrottle, cancellationToken);
        }

        return new AppSessionValidationResult(
            true,
            grant.AppId,
            user.Id,
            user.Email,
            user.DisplayName,
            user.Role,
            grant.AbsoluteExpiresAt);
    }

    private async Task<AppIdentityTokenResult> CreateGrantAsync(
        AppRecord app,
        HostUserRecord user,
        string issuedVia,
        string? authorizingSessionId,
        CancellationToken cancellationToken)
    {
        var now = clock.UtcNow;
        var (_, absolute) = lifetimes.ForGrant(app.System, issuedVia);
        var absoluteExpiresAt = now.Add(absolute);
        var token = CreateGrantToken();
        var record = new AppSessionGrantRecord(
            Id: CreateOpaqueToken(),
            AppId: app.Id,
            UserId: user.Id,
            TokenHash: HashToken(token),
            IssuedVia: issuedVia,
            CreatedAt: now,
            LastSeenAt: now,
            AbsoluteExpiresAt: absoluteExpiresAt,
            RevokedAt: null,
            AuthorizingSessionId: authorizingSessionId);
        await grants.AppendAsync(record, now, cancellationToken);
        return new AppIdentityTokenResult(token, "Bearer", absoluteExpiresAt, (int)absolute.TotalSeconds);
    }

    private async Task<(HostUserRecord User, AppRecord App)> RequireAccessibleUserAsync(
        string appId,
        string userId,
        CancellationToken cancellationToken)
    {
        var state = await users.ReadAsync(cancellationToken);
        var app = await RequireInstalledAppAsync(appId, cancellationToken);
        var user = state.Users.FirstOrDefault(candidate => string.Equals(candidate.Id, userId, StringComparison.Ordinal)) ??
            throw new AppIdentityException("user_not_found", "Host user was not found.");
        if (user.Disabled)
        {
            throw new AppIdentityException("user_disabled", "Host user is disabled.");
        }

        // System apps are administrator surfaces. This is the enforcement point for every identity flow
        // (authorize, launch, exchange, revalidate), so a role downgrade revokes access no later than the
        // next revalidation.
        if (app.System && !string.Equals(user.Role, "host.admin", StringComparison.Ordinal))
        {
            throw new AppIdentityException("system_app_admin_required", "System app access requires a Host administrator.");
        }

        var hasAssignmentsForApp = state.Assignments.Any(assignment => string.Equals(assignment.AppId, appId, StringComparison.Ordinal));
        var userAssigned = state.Assignments.Any(assignment =>
            string.Equals(assignment.AppId, appId, StringComparison.Ordinal) &&
            string.Equals(assignment.UserId, user.Id, StringComparison.Ordinal));
        if (!string.Equals(user.Role, "host.admin", StringComparison.Ordinal) && hasAssignmentsForApp && !userAssigned)
        {
            throw new AppIdentityException("app_access_denied", "Host user is not assigned to this app.");
        }

        return (user, app);
    }

    private async Task<AppRecord> RequireInstalledAppAsync(string appId, CancellationToken cancellationToken)
        => await apps.GetAppAsync(appId, cancellationToken) ??
            throw new AppIdentityException("app_not_found", "Runtime app was not found.");

    private async Task RequireAllowedRedirectUriAsync(
        string appId,
        string redirectUri,
        CancellationToken cancellationToken)
    {
        var redirect = ValidateRedirectUri(redirectUri);
        var app = await RequireInstalledAppAsync(appId, cancellationToken);
        var allowed = app.Endpoints
            .SelectMany(endpoint => GetAllowedEndpointOrigins(endpoint, app.Settings))
            .Where(origin => !string.IsNullOrWhiteSpace(origin))
            .Select(origin => Uri.TryCreate(origin, UriKind.Absolute, out var uri) ? uri : null)
            .OfType<Uri>()
            .Any(endpointUri => SameOrigin(endpointUri, redirect));

        if (!allowed)
        {
            throw new AppIdentityException("redirect_uri_denied", "Redirect URI must target an installed app endpoint origin.");
        }
    }

    private static IEnumerable<string?> GetAllowedEndpointOrigins(
        AppEndpointContract endpoint,
        IReadOnlyDictionary<string, AppSettingValue> settings)
    {
        yield return endpoint.Url;
        yield return endpoint.PublicOrigin;

        if (endpoint.Public &&
            !string.IsNullOrWhiteSpace(endpoint.Url) &&
            settings.TryGetValue(PublicOriginSettings.BuildSettingKey(endpoint.Key), out var setting) &&
            PublicOriginSettings.TryNormalizeOrigin(setting.Value, out var publicOrigin))
        {
            yield return publicOrigin;
        }
    }

    private static string BuildRedirectUri(string redirectUri, string code)
    {
        var separator = redirectUri.Contains('?', StringComparison.Ordinal) ? '&' : '?';
        return $"{redirectUri}{separator}code={Uri.EscapeDataString(code)}";
    }

    private static Uri ValidateRedirectUri(string redirectUri)
    {
        if (!Uri.TryCreate(redirectUri, UriKind.Absolute, out var uri) ||
            (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps) ||
            !string.IsNullOrEmpty(uri.Fragment))
        {
            throw new AppIdentityException("redirect_uri_invalid", "Redirect URI must be an absolute http(s) URI without a fragment.");
        }

        return uri;
    }

    private static bool SameOrigin(Uri left, Uri right)
        => string.Equals(left.Scheme, right.Scheme, StringComparison.OrdinalIgnoreCase) &&
            string.Equals(left.Host, right.Host, StringComparison.OrdinalIgnoreCase) &&
            left.Port == right.Port;

    private static string CreateOpaqueToken()
        => Base64UrlEncode(RandomNumberGenerator.GetBytes(32));

    // A prefixed opaque value: the prefix aids log/debug identification, the 256 random bits are the
    // secret. Only its hash is ever stored, so the raw value is unrecoverable from Core state.
    private static string CreateGrantToken()
        => GrantTokenPrefix + Base64UrlEncode(RandomNumberGenerator.GetBytes(32));

    private static string HashToken(string token)
        => Base64UrlEncode(SHA256.HashData(Encoding.UTF8.GetBytes(token)));

    private static string Base64UrlEncode(byte[] bytes)
        => Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');
}

internal sealed record AppAuthorizeResult(string Code, string RedirectUri, DateTimeOffset ExpiresAt);

internal sealed record AppIdentityTokenResult(string AccessToken, string TokenType, DateTimeOffset ExpiresAt, int ExpiresInSeconds);

internal sealed record AppSessionValidationResult(
    bool Active,
    string AppId,
    string UserId,
    string? Email,
    string? DisplayName,
    string HostRole,
    DateTimeOffset ExpiresAt);

internal sealed class AppIdentityException(string code, string message) : Exception(message)
{
    public string Code { get; } = code;
}

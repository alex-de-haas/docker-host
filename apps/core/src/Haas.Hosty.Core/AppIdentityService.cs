using System.Security.Cryptography;
using System.Text;

namespace Haas.Hosty.Core;

internal sealed class AppIdentityService(
    UserDirectoryStore users,
    AppAuthCodeStore codes,
    AppRegistryStore apps,
    AppSessionGrantStore grants,
    CoreSettingsService settings,
    AuditStore audit,
    IClock clock, BackgroundGrantService? background = null)
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
        string? codeChallenge,
        string? codeChallengeMethod,
        string? authorizingSessionId = null,
        CancellationToken cancellationToken = default,
        bool activityAuthorized = false)
    {
        AppCodeProof.RequireChallenge(codeChallenge, codeChallengeMethod);
        await RequireAllowedRedirectUriAsync(appId, redirectUri, cancellationToken);
        var (user, _) = await RequireAccessibleUserAsync(appId, userId, cancellationToken);
        var now = clock.UtcNow;
        var code = CreateOpaqueToken();
        await codes.AppendCodeAsync(
            new AppAuthCodeRecord(code, appId, user.Id, redirectUri, now, now.Add(AuthCodeLifetime), null, authorizingSessionId, user.AuthRevision, activityAuthorized, codeChallenge),
            now,
            cancellationToken);

        return new AppAuthorizeResult(code, BuildRedirectUri(redirectUri, code), now.Add(AuthCodeLifetime));
    }

    public async Task<AppIdentityTokenResult> ExchangeCodeAsync(string? code, string callingAppId, string? codeVerifier, CancellationToken cancellationToken = default)
    {
        var result = await codes.ConsumeCodeAsync(code, callingAppId, codeVerifier, clock.UtcNow, cancellationToken);
        try
        {
            var match = result.Outcome switch
            {
                AppAuthCodeConsumeOutcome.Consumed => result.Record!,
                AppAuthCodeConsumeOutcome.AlreadyConsumed => throw new AppIdentityException("code_consumed", "Authorization code has already been consumed."),
                AppAuthCodeConsumeOutcome.Expired => throw new AppIdentityException("code_expired", "Authorization code has expired."),
                _ => throw new AppIdentityException("invalid_code", "Authorization code is invalid."),
            };

            var (user, app) = await RequireAccessibleUserAsync(match.AppId, match.UserId, cancellationToken);
            RequireCurrentAuthRevision(match.AuthRevision, user);
            return await CreateGrantAsync(app, user, AppGrantIssuedVia.Code, match.AuthorizingSessionId, cancellationToken, match.ActivityAuthorized);
        }
        catch (AppIdentityException exception)
        {
            await AppendCodeExchangeRefusalAsync(callingAppId, result.Record?.AppId,
                result.Outcome switch { AppAuthCodeConsumeOutcome.AppMismatch => "code_app_mismatch", AppAuthCodeConsumeOutcome.ProofMismatch => "code_proof_mismatch", _ => exception.Code }, cancellationToken);
            throw;
        }
    }

    internal async Task AuditRejectedCodeExchangeAsync(string? code, string reason, CancellationToken cancellationToken)
    {
        var codeAppId = (await codes.ReadAsync(cancellationToken)).Codes
            .FirstOrDefault(candidate => string.Equals(candidate.Code, code, StringComparison.Ordinal))?.AppId;
        await AppendCodeExchangeRefusalAsync(null, codeAppId, reason, cancellationToken);
    }

    private Task AppendCodeExchangeRefusalAsync(string? callingAppId, string? codeAppId, string reason, CancellationToken cancellationToken)
    {
        var details = new Dictionary<string, string> { ["reason"] = reason };
        if (callingAppId is not null) details["callingAppId"] = callingAppId;
        if (codeAppId is not null) details["codeAppId"] = codeAppId;
        return audit.AppendAsync(new AuditRecord(
            Id: $"audit_{Guid.NewGuid():N}", Action: "auth.app-code.exchange", ResourceType: "app",
            ResourceId: codeAppId, Outcome: reason, ActorUserId: null, CreatedAt: clock.UtcNow, Details: details), cancellationToken);
    }

    public async Task<AppIdentityTokenResult> CreateLaunchTokenAsync(
        string appId,
        string userId,
        CancellationToken cancellationToken = default)
    {
        var (user, app) = await RequireAccessibleUserAsync(appId, userId, cancellationToken);
        return await CreateGrantAsync(app, user, AppGrantIssuedVia.CliDiagnostic, authorizingSessionId: null, cancellationToken);
    }

    // Internal binding only: the primary browser credential never leaves Core.
    internal async Task<string?> AuthorizingBrowserSessionAsync(string token, string appId, CancellationToken ct)
    {
        await RevalidateAsync(token, appId, ct);
        return (await grants.TryResolveAsync(HashToken(token), ct))?.AuthorizingSessionId;
    }

    public async Task<AppSessionValidationResult> RevalidateAsync(
        string? token,
        string callingAppId,
        CancellationToken cancellationToken = default)
    {
        // A body that omits the token is an unrecognized token, not a server fault: the hash below
        // would throw on null, and the caller's contract for "no usable token" is already token_invalid.
        if (string.IsNullOrWhiteSpace(token))
        {
            throw new AppIdentityException("token_invalid", "App session token is not recognized.");
        }

        return await RevalidateHashAsync(HashToken(token), callingAppId, cancellationToken);
    }

    // MCP credentials carry only this one-way reference, never the parent app session secret.
    internal async Task<AppSessionValidationResult> RevalidateHashAsync(string tokenHash, string callingAppId, CancellationToken cancellationToken)
        => (await RevalidateAuthorityAsync(tokenHash, callingAppId, cancellationToken, allowBackground: false)).Actor;

    // Keep the validated background scope with the actor for this dispatch, never in a cache or wire response.
    internal async Task<(AppSessionValidationResult Actor, (BackgroundGrant Grant, BackgroundScope Scope)? Background)>
        RevalidateAuthorityAsync(string tokenHash, string callingAppId, CancellationToken cancellationToken, bool allowBackground)
    {
        var now = clock.UtcNow;
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
        RequireCurrentAuthRevision(grant.AuthRevision, user);

        if ((grant.Installation is null && grant.CreatedAt < app.InstalledAt) || (grant.Installation is { } installation && installation != app.InstalledAt))
            throw new AppIdentityException("token_revoked", "Sign in again after reinstalling the app.");
        var (legacyIdle, _) = settings.AuthLifetimes.ForGrant(app.System, grant.IssuedVia);
        var idle = grant.AuthorityVersion == 1 ? settings.AuthLifetimes.AppGrantIdle : legacyIdle;
        if (grant.LastSeenAt.Add(idle) <= now)
        {
            throw new AppIdentityException("token_expired", "App session has been idle too long.");
        }

        if (grant.BackgroundGrantId is not null)
        {
            if (!allowBackground || background is null || grant.BackgroundScopeId is null)
                throw BackgroundGrantService.Error("This credential cannot establish interactive app identity.");
            var validated = await background.ValidateAsync(callingAppId, grant.BackgroundGrantId, grant.BackgroundScopeId, cancellationToken);
            return (new(true, grant.AppId, user.Id, user.Email, user.DisplayName, user.Role, grant.AbsoluteExpiresAt), validated);
        }
        AuthSessionRecord? parent = null;
        if (grant.IssuedVia == AppGrantIssuedVia.Code && grant.AuthorizingSessionId is not null)
        {
            // A migration does not revive a dead legacy identity, nor invent browser provenance.
            parent = await TryLivePrincipalAsync(grant.AuthorizingSessionId, grant.UserId, cancellationToken);
            if (parent is not null && grant.AuthorityVersion == 0)
                grant = await grants.UpgradeContinuityAsync(tokenHash, app.InstalledAt,
                    PrincipalDeadline(parent, now), now, legacyIdle, cancellationToken);
        }
        if (grant.AuthorityVersion == 1 && parent is null)
            throw new AppIdentityException("token_expired", "The session authorizing this app has ended. Sign in again.");

        // Fast path: skip the store round-trip (read + mutex) on the common throttled case. TouchAsync
        // re-checks the throttle under the lock, so a racing writer cannot cause a double advance.
        if (now - grant.LastSeenAt >= TouchThrottle)
        {
            try
            {
                await grants.TouchAsync(tokenHash, now, TouchThrottle, cancellationToken);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                // Sliding the idle window is advisory: the token and policy are already valid. A transient
                // grant-store write failure must not turn a good revalidation into a 500; it slides next time.
            }
        }

        return (new AppSessionValidationResult(
            true,
            grant.AppId,
            user.Id,
            user.Email,
            user.DisplayName,
            user.Role,
            grant.AbsoluteExpiresAt, grant.AuthorityVersion == 1 ? null : grant.ActiveUntil,
            grant.AuthorityVersion != 1 && (app.RequiredCorePermissions?.Count ?? 0) + (app.OptionalCorePermissions?.Count ?? 0) + (app.GrantedCorePermissions?.Count ?? 0) > 0,
            parent is not null && grant.AuthorityVersion == 1 ? new AppContinuityInfo(1,
                parent.Kind is null ? "browser" : "native", grant.Id, grant.AbsoluteExpiresAt, 300) : null), null);
    }

    // Only explicitly scope-aware dispatchers may accept background authority.
    internal async Task<AppSessionValidationResult> RequireOperationHashAsync(string hash, string appId,
        Func<BackgroundScope, bool> permits, CancellationToken ct, bool requireActivity = true)
    {
        var grant = await grants.TryResolveAsync(hash, ct);
        if (grant?.BackgroundGrantId is null) return requireActivity ? await RequireActivityHashAsync(hash, appId, ct)
            : await RevalidateHashAsync(hash, appId, ct);
        var authority = await RevalidateAuthorityAsync(hash, appId, ct, allowBackground: true);
        await RequireBackgroundOperationAsync(authority.Background!.Value, permits, ct);
        return authority.Actor;
    }

    internal async Task RequireBackgroundOperationAsync((BackgroundGrant Grant, BackgroundScope Scope) validated,
        Func<BackgroundScope, bool> permits, CancellationToken ct)
    {
        if (!permits(validated.Scope)) throw BackgroundGrantService.Error("This operation exceeds the selected background scope.");
        await background!.AuditAsync(validated.Grant, "dispatch", ct);
    }

    private async Task<AppIdentityTokenResult> CreateGrantAsync(
        AppRecord app,
        HostUserRecord user,
        string issuedVia,
        string? authorizingSessionId,
        CancellationToken cancellationToken, bool activityAuthorized = false)
    {
        var now = clock.UtcNow;
        var (_, absolute) = settings.AuthLifetimes.ForGrant(app.System, issuedVia);
        var absoluteExpiresAt = now.Add(absolute);
        var token = CreateGrantToken();
        DateTimeOffset? activeUntil = null;
        var parent = issuedVia == AppGrantIssuedVia.Code && authorizingSessionId is not null
            ? await TryLivePrincipalAsync(authorizingSessionId, user.Id, cancellationToken) : null;
        if (authorizingSessionId is not null && parent is null)
        {
            var original = (await users.ReadAsync(cancellationToken)).Sessions.FirstOrDefault(s => s.Id == authorizingSessionId && s.UserId == user.Id);
            throw new AppIdentityException(original is null || original.RevokedAt is not null ? "token_revoked" : "token_expired",
                "The authorizing session is no longer live or cannot establish app continuity.");
        }
        if (parent is not null) absoluteExpiresAt = PrincipalDeadline(parent, now);
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
            AuthorizingSessionId: authorizingSessionId,
            AuthRevision: user.AuthRevision,
            ActiveUntil: activeUntil, AuthorityVersion: parent is null ? 0 : 1, Installation: app.InstalledAt);
        await grants.AppendAsync(record, now, cancellationToken);
        if (authorizingSessionId is not null)
        {
            // Check after the write so logout cannot finish its cascade before a racing exchange
            // appends the grant. Expiry alone does not revoke identity; explicit logout does.
            var storedParent = (await users.ReadAsync(cancellationToken)).Sessions.FirstOrDefault(session =>
                string.Equals(session.Id, authorizingSessionId, StringComparison.Ordinal) && session.UserId == user.Id);
            if (storedParent is null || storedParent.RevokedAt is not null)
            {
                // An expired parent can be pruned by a later login. Refuse this in-flight sign-in
                // without treating that normal cleanup as a logout of its established app grants.
                await grants.RevokeByIdAsync(record.Id, clock.UtcNow, cancellationToken);
                throw new AppIdentityException("token_revoked", "The Core session authorizing this app sign-in has been revoked.");
            }
        }
        return new AppIdentityTokenResult(token, "Bearer", absoluteExpiresAt, (int)(absoluteExpiresAt - now).TotalSeconds, activeUntil,
            parent is null ? null : new AppContinuityInfo(1, parent.Kind is null ? "browser" : "native", record.Id, absoluteExpiresAt, 300));
    }

    internal Task<AppSessionValidationResult> RequireActivityAsync(string token, string appId, CancellationToken ct)
        => RequireActivityHashAsync(HashToken(token), appId, ct);

    internal async Task<AppSessionValidationResult> RequireActivityHashAsync(string hash, string appId, CancellationToken ct)
    {
        var actor = await RevalidateHashAsync(hash, appId, ct);
        var grant = await grants.TryResolveAsync(hash, ct);
        if (actor.Continuity is not null) return actor;
        if (grant?.ActiveUntil is not { } until || until <= clock.UtcNow)
            throw new AppIdentityException("reauth_required", "Renew app activity through Core before continuing.");
        await RequireLiveAuthorizingSessionAsync(grant.AuthorizingSessionId, actor.UserId, ct);
        return actor;
    }

    internal async Task<AppSessionValidationResult> RequireBrowserIdentityHashAsync(string hash, string appId, CancellationToken ct)
    {
        var actor = await RevalidateHashAsync(hash, appId, ct);
        var grant = await grants.TryResolveAsync(hash, ct);
        if (actor.Continuity is null)
            await RequireLiveAuthorizingSessionAsync(grant?.AuthorizingSessionId, actor.UserId, ct);
        return actor;
    }

    internal async Task<AuthSessionRecord?> TryLivePrincipalAsync(string id, string userId, CancellationToken ct)
    {
        var state = await users.ReadAsync(ct);
        var parent = state.Sessions.FirstOrDefault(s => s.Id == id && s.UserId == userId);
        if (parent is null || parent.Audience is not null || parent.GrantId is not null || (parent.Scopes?.Count ?? 0) != 0
            || (parent.Kind is null ? parent.BrowserOrigin is null : parent.Kind is not (AccessTokenKinds.Device or AccessTokenKinds.Manual))
            || !CoreSessionAuthorization.IsSessionLive(parent, clock.UtcNow, settings.AuthLifetimes.IdleFor(parent.Kind))) return null;
        return parent;
    }

    private DateTimeOffset PrincipalDeadline(AuthSessionRecord parent, DateTimeOffset now)
        => parent.ExpiresAt == DateTimeOffset.MaxValue ? now.Add(settings.AuthLifetimes.AppGrantAbsolute) : parent.ExpiresAt;

    internal async Task<AuthSessionRecord> RequireLiveAuthorizingSessionAsync(string? id, string userId, CancellationToken ct)
    {
        var state = await users.ReadAsync(ct);
        var session = state.Sessions.FirstOrDefault(s => s.Id == id && s.UserId == userId);
        if (session is null || session.Kind is not null || session.BrowserOrigin is null ||
            !CoreSessionAuthorization.IsSessionLive(session, clock.UtcNow, settings.AuthLifetimes.CoreSessionIdle))
            throw new AppIdentityException("reauth_required", "Sign in through Core to renew privileged app activity.");
        return session;
    }

    private static void RequireCurrentAuthRevision(string? revision, HostUserRecord user)
    {
        if (!string.Equals(revision, user.AuthRevision, StringComparison.Ordinal))
            throw new AppIdentityException("token_revoked", "Authorization was revoked by account recovery. Sign in again.");
    }

    // Public because it is the single access-policy gate shared by every identity flow, including
    // the delegated-token endpoint, which composes it with DelegatedTokenService instead of
    // duplicating the disabled/system-admin/assignment rules.
    public async Task<(HostUserRecord User, AppRecord App)> RequireAccessibleUserAsync(
        string appId,
        string userId,
        CancellationToken cancellationToken)
    {
        var state = await users.ReadAsync(cancellationToken);
        return await RequireAccessibleUserAsync(state, appId, userId, cancellationToken);
    }

    // For callers that already read the directory state in the same request (introspection,
    // on-behalf-of), so one call does not resolve the same store twice.
    public async Task<(HostUserRecord User, AppRecord App)> RequireAccessibleUserAsync(
        UserDirectoryState state,
        string appId,
        string userId,
        CancellationToken cancellationToken)
    {
        var app = await RequireInstalledAppAsync(appId, cancellationToken);
        return (RequireAccessibleUser(state, app, userId), app);
    }

    // The policy core, kept in one copy for every caller shape — including those that already hold
    // both the state and the app record and must not pay a second resolve for either.
    public static HostUserRecord RequireAccessibleUser(UserDirectoryState state, AppRecord app, string userId)
    {
        var user = state.Users.FirstOrDefault(candidate => string.Equals(candidate.Id, userId, StringComparison.Ordinal)) ??
            throw new AppIdentityException("user_not_found", "Host user was not found.");
        if (user.Disabled)
        {
            throw new AppIdentityException("user_disabled", "Host user is disabled.");
        }

        // The system role describes the app, not who may use it. Assignments and host roles
        // are shared with listings/assets; management endpoints check administrative authority.
        if (!AppAccessPolicy.CanAccessApp(state, user, app.Id, app.System))
        {
            throw new AppIdentityException("app_access_denied", "Host user is not assigned to this app.");
        }

        return user;
    }

    private async Task<AppRecord> RequireInstalledAppAsync(string appId, CancellationToken cancellationToken)
        => await apps.GetAppAsync(appId, cancellationToken) ??
            throw new AppIdentityException("app_not_found", "Runtime app was not found.");

    internal async Task RequireAllowedRedirectUriAsync(
        string appId,
        string redirectUri,
        CancellationToken cancellationToken)
    {
        var redirect = ValidateRedirectUri(redirectUri);
        var app = await RequireInstalledAppAsync(appId, cancellationToken);
        var allowed = app.Endpoints
            .SelectMany(endpoint => GetAllowedEndpointOrigins(app, endpoint))
            .Where(origin => !string.IsNullOrWhiteSpace(origin))
            .Select(origin => Uri.TryCreate(origin, UriKind.Absolute, out var uri) ? uri : null)
            .OfType<Uri>()
            .Any(endpointUri => SameOrigin(endpointUri, redirect));

        if (!allowed)
        {
            throw new AppIdentityException("redirect_uri_denied", "Redirect URI must target an installed app endpoint origin.");
        }
    }

    internal static IEnumerable<string?> GetAllowedEndpointOrigins(
        AppRecord app,
        AppEndpointContract endpoint)
    {
        yield return endpoint.Url;
        yield return endpoint.PublicOrigin;
        yield return LocalBrowserOrigins.App(app, endpoint);

        if (endpoint.Public &&
            !string.IsNullOrWhiteSpace(endpoint.Url) &&
            app.Settings.TryGetValue(PublicOriginSettings.BuildSettingKey(endpoint.Key), out var setting) &&
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

    internal static string HashToken(string token)
        => Base64UrlEncode(SHA256.HashData(Encoding.UTF8.GetBytes(token)));

    private static string Base64UrlEncode(byte[] bytes)
        => Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');
}

internal sealed record AppAuthorizeResult(string Code, string RedirectUri, DateTimeOffset ExpiresAt);

internal sealed record AppIdentityTokenResult(string AccessToken, string TokenType, DateTimeOffset ExpiresAt, int ExpiresInSeconds, DateTimeOffset? ActiveUntil = null, AppContinuityInfo? Continuity = null);

internal sealed record AppSessionValidationResult(
    bool Active,
    string AppId,
    string UserId,
    string? Email,
    string? DisplayName,
    string HostRole,
    DateTimeOffset ExpiresAt, DateTimeOffset? ActiveUntil = null, bool ActivityRequired = false, AppContinuityInfo? Continuity = null);

internal sealed record AppContinuityInfo(int Version, string Mode, string GrantId, DateTimeOffset ExpiresAt, int CheckAfterSeconds);

internal sealed class AppIdentityException(string code, string message) : Exception(message)
{
    public string Code { get; } = code;
}

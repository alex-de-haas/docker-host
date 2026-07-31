using System.Globalization;
using System.Security.Cryptography;

namespace Haas.Hosty.Core;

// Credentials for clients that have no browser: a device console, the CLI on another machine, a script.
//
// Core's only way to mint a session was posting the HTML login form, which a headless client cannot do.
// These endpoints add two ways in — a device authorization flow approved in Shell, and direct creation
// in Shell whose value is shown once — and one place to see and revoke what exists.
//
// What comes out is an ordinary session record with a `Kind`, not a new credential type: bearer
// resolution, the sliding idle window, instant revocation and the logout cascade already work on that
// record. See docs/features/access-tokens/.
internal static class AccessTokenEndpoints
{
    public static void Map(WebApplication app)
    {
        // --- Device authorization flow -------------------------------------------------------------
        // Unauthenticated by nature: the caller has no credential yet, which is the whole point. The
        // guards are a short lifetime, a per-source cap, and the fact that nothing happens until a
        // signed-in human approves it.
        app.MapPost("/api/auth/device/code", async (
            HttpRequest request,
            DeviceAuthorizationCodeRequest? input,
            DeviceAuthorizationStore devices,
            ShellPublicOriginResolver shellOrigin,
            CancellationToken cancellationToken) =>
        {
            var result = devices.Create(input?.Label, ResolveSourceKey(request));
            if (result.Request is null)
            {
                return CoreJson.Json(
                    new ErrorResponse("device_code_throttled", "Too many pending device authorization requests from this address. Wait for the existing ones to expire."),
                    statusCode: StatusCodes.Status429TooManyRequests);
            }

            var origin = await shellOrigin.ResolveAsync(cancellationToken);
            return CoreJson.Json(new DeviceAuthorizationCodeResponse(
                result.Request.DeviceCode,
                result.Request.UserCode,
                // Straight to the tab that approves it — Settings opens on Users otherwise. Null when
                // this host has no Shell: the device shows the code and the operator finds the approval
                // screen themselves rather than being sent to an invented address.
                string.IsNullOrWhiteSpace(origin) ? null : $"{origin.TrimEnd('/')}/shell/settings?tab=tokens",
                (int)DeviceAuthorizationStore.PollInterval.TotalSeconds,
                (int)DeviceAuthorizationStore.RequestLifetime.TotalSeconds));
        });

        app.MapPost("/api/auth/device/token", (
            DeviceAuthorizationTokenRequest input,
            DeviceAuthorizationStore devices) =>
        {
            var result = devices.Poll(input.DeviceCode);
            return result.Status switch
            {
                DeviceAuthorizationStatus.Approved => CoreJson.Json(
                    new DeviceAuthorizationTokenResponse("approved", result.SessionId)),
                DeviceAuthorizationStatus.Pending => CoreJson.Json(
                    new DeviceAuthorizationTokenResponse("pending", null)),
                DeviceAuthorizationStatus.Denied => CoreJson.Json(
                    new DeviceAuthorizationTokenResponse("denied", null)),
                _ => CoreJson.Json(new DeviceAuthorizationTokenResponse("expired", null)),
            };
        });

        // --- Approval surface ----------------------------------------------------------------------
        // Any signed-in user may approve a device, and the credential it receives carries that user's
        // role. A device that needs an administrator says so itself; Core has no scopes to enforce a
        // narrower grant with (see docs/features/access-tokens/).
        app.MapGet("/api/auth/device/requests", (
            HttpRequest request,
            UserDirectoryStore users,
            IClock clock,
            DeviceAuthorizationStore devices,
            CancellationToken cancellationToken) =>
            CoreSessionAuthorization.RequireSessionAsync(
                request,
                users,
                clock,
                _ =>
                {
                    var now = clock.UtcNow;
                    var pending = devices.ListPending()
                        .Select(item => new DeviceAuthorizationRequestView(
                            item.UserCode,
                            item.Label,
                            item.CreatedAt,
                            (int)Math.Max(0, (item.ExpiresAt - now).TotalSeconds)))
                        .ToArray();
                    return Task.FromResult<IResult>(CoreJson.Json(new DeviceAuthorizationRequestListResponse(pending)));
                },
                cancellationToken: cancellationToken));

        app.MapPost("/api/auth/device/requests/approve", (
            HttpRequest request,
            DeviceAuthorizationDecisionRequest input,
            UserDirectoryStore users,
            IClock clock,
            AuthLifetimes lifetimes,
            DeviceAuthorizationStore devices,
            AuditStore audit,
            CancellationToken cancellationToken) =>
            CoreSessionAuthorization.RequireSessionAsync(
                request,
                users,
                clock,
                async user =>
                {
                    var pending = devices.FindByUserCode(input.UserCode);
                    if (pending is null)
                    {
                        return CoreJson.Json(
                            new ErrorResponse("device_code_invalid", "That code is not waiting for approval. It may have expired or already been answered."),
                            statusCode: StatusCodes.Status404NotFound);
                    }

                    var credential = await IssueAsync(
                        user.Id, AccessTokenKinds.Device, pending.Label, users, clock, lifetimes, cancellationToken);

                    // Losing the race means another approver already answered this code; the credential
                    // just minted is revoked rather than left dangling with nobody holding it.
                    if (!devices.TryApprove(pending.DeviceCode, credential.Id, user.Id))
                    {
                        await RevokeAsync(credential.Id, users, clock, cancellationToken);
                        return CoreJson.Json(
                            new ErrorResponse("device_code_invalid", "That code was already answered."),
                            statusCode: StatusCodes.Status409Conflict);
                    }

                    // The fingerprint, never the record id: the audit log is durable and readable
                    // through the control channel, so writing the id there would leave the bearer
                    // credential recoverable long after its one collecting poll.
                    await AppendAuditAsync(
                        audit,
                        "auth.device.approved",
                        CoreSessionAuthorization.FingerprintSessionId(credential.Id),
                        user.Id,
                        clock,
                        pending.Label,
                        AccessTokenKinds.Device,
                        cancellationToken);
                    return CoreJson.Json(new DeviceAuthorizationDecisionResponse("approved"));
                },
                requireCsrf: true,
                cancellationToken: cancellationToken));

        app.MapPost("/api/auth/device/requests/deny", (
            HttpRequest request,
            DeviceAuthorizationDecisionRequest input,
            UserDirectoryStore users,
            IClock clock,
            DeviceAuthorizationStore devices,
            AuditStore audit,
            CancellationToken cancellationToken) =>
            CoreSessionAuthorization.RequireSessionAsync(
                request,
                users,
                clock,
                async user =>
                {
                    var pending = devices.FindByUserCode(input.UserCode);
                    if (pending is null || !devices.TryDeny(pending.DeviceCode))
                    {
                        return CoreJson.Json(
                            new ErrorResponse("device_code_invalid", "That code is not waiting for approval."),
                            statusCode: StatusCodes.Status404NotFound);
                    }

                    await AppendAuditAsync(audit, "auth.device.denied", null, user.Id, clock, pending.Label, AccessTokenKinds.Device, cancellationToken);
                    return CoreJson.Json(new DeviceAuthorizationDecisionResponse("denied"));
                },
                requireCsrf: true,
                cancellationToken: cancellationToken));

        // --- Credential management -----------------------------------------------------------------
        app.MapGet("/api/auth/credentials", (
            HttpRequest request,
            UserDirectoryStore users,
            IClock clock,
            AuthLifetimes lifetimes,
            CancellationToken cancellationToken) =>
            CoreSessionAuthorization.RequireSessionAsync(
                request,
                users,
                clock,
                async user =>
                {
                    var state = await users.ReadAsync(cancellationToken);
                    var now = clock.UtcNow;
                    var isAdmin = AppAccessPolicy.IsAdmin(user);
                    var views = state.Sessions
                        .Where(session => AccessTokenKinds.IsAccessToken(session.Kind))
                        .Where(session => CoreSessionAuthorization.IsSessionLive(session, now, lifetimes.IdleFor(session.Kind)))
                        // A host.user sees only their own; an administrator sees every one, because
                        // revoking a credential on a lost device is a host-wide concern.
                        .Where(session => isAdmin || string.Equals(session.UserId, user.Id, StringComparison.Ordinal))
                        .OrderByDescending(session => session.CreatedAt)
                        // The id here is the fingerprint, never the record id: a session id IS the
                        // bearer credential, so listing raw ids would hand every credential's secret to
                        // anyone allowed to see that the credential exists.
                        .Select(session => new AccessTokenView(
                            CoreSessionAuthorization.FingerprintSessionId(session.Id),
                            session.Kind!,
                            session.Label,
                            session.UserId,
                            state.Users.FirstOrDefault(candidate => string.Equals(candidate.Id, session.UserId, StringComparison.Ordinal))?.DisplayName,
                            session.CreatedAt,
                            session.LastSeenAt ?? session.CreatedAt))
                        .ToArray();

                    return CoreJson.Json(new AccessTokenListResponse(views));
                },
                cancellationToken: cancellationToken));

        app.MapPost("/api/auth/credentials", (
            HttpRequest request,
            AccessTokenCreateRequest input,
            UserDirectoryStore users,
            IClock clock,
            AuthLifetimes lifetimes,
            AuditStore audit,
            CancellationToken cancellationToken) =>
            CoreSessionAuthorization.RequireSessionAsync(
                request,
                users,
                clock,
                async user =>
                {
                    var label = DeviceAuthorizationStore.NormalizeLabel(input.Label);
                    if (label is null)
                    {
                        return CoreJson.Json(
                            new ErrorResponse("label_required", "A credential needs a label so it can be recognized later."),
                            statusCode: StatusCodes.Status400BadRequest);
                    }

                    var credential = await IssueAsync(
                        user.Id, AccessTokenKinds.Manual, label, users, clock, lifetimes, cancellationToken);
                    var fingerprint = CoreSessionAuthorization.FingerprintSessionId(credential.Id);
                    await AppendAuditAsync(audit, "auth.credential.created", fingerprint, user.Id, clock, label, AccessTokenKinds.Manual, cancellationToken);

                    // The only time the value is ever returned. Nothing stores it in a form that can be
                    // read back, so a caller that loses it revokes and creates another.
                    return CoreJson.Json(new AccessTokenCreateResponse(fingerprint, label, credential.Id));
                },
                requireCsrf: true,
                cancellationToken: cancellationToken));

        app.MapDelete("/api/auth/credentials/{fingerprint}", (
            HttpRequest request,
            string fingerprint,
            UserDirectoryStore users,
            IClock clock,
            AppSessionGrantStore grants,
            CoreEventHub events,
            AuditStore audit,
            CancellationToken cancellationToken) =>
            CoreSessionAuthorization.RequireSessionAsync(
                request,
                users,
                clock,
                async user =>
                {
                    var state = await users.ReadAsync(cancellationToken);
                    // Callers hold the fingerprint the listing gave them; the real id never left Core.
                    var target = state.Sessions.FirstOrDefault(session =>
                        AccessTokenKinds.IsAccessToken(session.Kind) &&
                        session.RevokedAt is null &&
                        string.Equals(CoreSessionAuthorization.FingerprintSessionId(session.Id), fingerprint, StringComparison.OrdinalIgnoreCase));

                    // A missing credential and someone else's credential answer the same way, so the
                    // endpoint cannot be used to discover which ids exist.
                    if (target is null ||
                        (!AppAccessPolicy.IsAdmin(user) && !string.Equals(target.UserId, user.Id, StringComparison.Ordinal)))
                    {
                        return CoreJson.Json(
                            new ErrorResponse("credential_not_found", "No such credential."),
                            statusCode: StatusCodes.Status404NotFound);
                    }

                    await RevokeAsync(target.Id, users, clock, cancellationToken);

                    // The credential authorized app grants like any session, so revoking it cascades the
                    // same way an explicit logout does.
                    await grants.RevokeByAuthorizingSessionAsync(target.Id, clock.UtcNow, cancellationToken);

                    // And it ends the stream the credential is holding open right now, which is the
                    // window a lost device is revoked to close.
                    events.CloseSession(target.Id);

                    await AppendAuditAsync(audit, "auth.credential.revoked", fingerprint, user.Id, clock, target.Label, target.Kind, cancellationToken);
                    return CoreJson.Json(new AccessTokenRevokeResponse("revoked"));
                },
                requireCsrf: true,
                cancellationToken: cancellationToken));
    }

    // Mint the credential. Idle-only by design: ExpiresAt is the absolute cap every session carries, and
    // an access token is given the maximum so only the sliding idle window can end it. A console in a
    // pocket that stops working on a fixed date, for no reason its holder can see, is not usable.
    internal static async Task<AuthSessionRecord> IssueAsync(
        string userId,
        string kind,
        string? label,
        UserDirectoryStore users,
        IClock clock,
        AuthLifetimes lifetimes,
        CancellationToken cancellationToken)
    {
        var now = clock.UtcNow;
        var record = new AuthSessionRecord(
            Convert.ToHexString(RandomNumberGenerator.GetBytes(32)).ToLowerInvariant(),
            userId,
            now,
            DateTimeOffset.MaxValue,
            RevokedAt: null,
            LastSeenAt: now,
            Kind: kind,
            Label: label);

        await users.UpdateAsync(state => state with
        {
            Sessions = AuthEndpoints.PruneSessions(state.Sessions, now, lifetimes).Append(record).ToArray(),
        }, cancellationToken);

        return record;
    }

    private static async Task RevokeAsync(
        string credentialId,
        UserDirectoryStore users,
        IClock clock,
        CancellationToken cancellationToken)
    {
        var now = clock.UtcNow;
        await users.UpdateAsync(state => state with
        {
            Sessions = state.Sessions
                .Select(session => string.Equals(session.Id, credentialId, StringComparison.Ordinal) && session.RevokedAt is null
                    ? session with { RevokedAt = now }
                    : session)
                .ToArray(),
        }, cancellationToken);
    }

    private static Task AppendAuditAsync(
        AuditStore audit,
        string action,
        string? credentialId,
        string actorUserId,
        IClock clock,
        string? label,
        string? kind,
        CancellationToken cancellationToken)
    {
        var details = new Dictionary<string, string>(StringComparer.Ordinal);
        if (!string.IsNullOrWhiteSpace(label))
        {
            details["label"] = label;
        }

        if (!string.IsNullOrWhiteSpace(kind))
        {
            details["kind"] = kind;
        }

        return audit.AppendAsync(
            new AuditRecord(
                Id: $"audit_{Guid.NewGuid():N}",
                Action: action,
                ResourceType: "auth.credential",
                ResourceId: credentialId,
                Outcome: "succeeded",
                ActorUserId: actorUserId,
                CreatedAt: clock.UtcNow,
                Details: details),
            cancellationToken);
    }

    // Who is asking, for the per-source cap.
    //
    // This is the connection's remote address, never a header a caller supplies — so nobody can pick
    // their own bucket. Core runs UseForwardedHeaders, so behind a proxy it *is* the real client
    // address whenever that proxy is trusted by ForwardedHeadersOptions, which covers the normal
    // deployment (cloudflared on the host, i.e. loopback).
    //
    // Residual: a proxy that is neither loopback nor a configured known proxy leaves every request
    // sharing the proxy's address, and the per-source cap degenerates into a global one — the very
    // shape this cap exists to avoid. Widening the trusted set is a Core-wide ingress decision, not
    // one this endpoint should make on its own.
    private static string ResolveSourceKey(HttpRequest request)
        => request.HttpContext.Connection.RemoteIpAddress?.ToString() ?? "unknown";

    internal static string FormatUserCode(string userCode)
        => userCode.Length == 8
            ? string.Create(CultureInfo.InvariantCulture, $"{userCode[..4]}-{userCode[4..]}")
            : userCode;
}

internal sealed record DeviceAuthorizationCodeRequest(string? Label = null);

internal sealed record DeviceAuthorizationCodeResponse(
    string DeviceCode,
    string UserCode,
    string? VerificationUri,
    int IntervalSeconds,
    int ExpiresInSeconds);

internal sealed record DeviceAuthorizationTokenRequest(string DeviceCode);

internal sealed record DeviceAuthorizationTokenResponse(string Status, string? Token);

internal sealed record DeviceAuthorizationDecisionRequest(string UserCode);

internal sealed record DeviceAuthorizationDecisionResponse(string Status);

internal sealed record DeviceAuthorizationRequestView(
    string UserCode,
    string? Label,
    DateTimeOffset CreatedAt,
    int ExpiresInSeconds);

internal sealed record DeviceAuthorizationRequestListResponse(IReadOnlyList<DeviceAuthorizationRequestView> Requests);

internal sealed record AccessTokenView(
    string Id,
    string Kind,
    string? Label,
    string UserId,
    string? UserDisplayName,
    DateTimeOffset CreatedAt,
    DateTimeOffset LastSeenAt);

internal sealed record AccessTokenListResponse(IReadOnlyList<AccessTokenView> Credentials);

internal sealed record AccessTokenCreateRequest(string Label);

internal sealed record AccessTokenCreateResponse(string Id, string Label, string Token);

internal sealed record AccessTokenRevokeResponse(string Status);

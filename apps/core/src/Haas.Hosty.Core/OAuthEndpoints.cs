using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Serialization;

namespace Haas.Hosty.Core;

// Core as an OAuth 2.1 authorization server, per the MCP authorization specification
// (docs/features/mcp-oauth/plan.md). This is an *issuance* path and nothing more: what comes out of
// the token endpoint is an ordinary scoped access token — the same record the manual path mints,
// revoked on the same page, validated by the same introspection. A capable client (Claude Code, an
// editor) obtains and rotates its own credentials; the manual path stays forever, because it works
// in every client including ones that never learn OAuth.
//
// Public clients only, PKCE mandatory, resource indicators mandatory. The resource parameter is what
// maps the spec onto this platform's one-audience rule: the client names the MCP endpoint it wants a
// token for, Core resolves that URL to a single audience, and a request without one is refused —
// never defaulted to something broad.
internal static class OAuthEndpoints
{
    /// <summary>Conventional short access-token life. Introspection already revokes instantly, so
    /// this buys no security — it is kept purely for spec-conventional client behavior.</summary>
    private static readonly TimeSpan AccessTokenLifetime = TimeSpan.FromHours(1);

    public static void Map(WebApplication app)
    {
        MapMetadata(app);
        MapAuthorize(app);
        MapConsent(app);
        MapToken(app);
        MapRegistration(app);
        MapClients(app);
    }

    // --- Discovery (RFC 8414 + RFC 9728) -------------------------------------------------------

    private static void MapMetadata(WebApplication app)
    {
        // AS metadata. Issuer and endpoints use the browser-reachable origin: the flow's whole point
        // is a remote client and a browser completing it, and a loopback URL in this document would
        // send both to the wrong machine.
        app.MapGet("/.well-known/oauth-authorization-server", (CorePublicOriginResolver coreOrigins) =>
        {
            var origin = coreOrigins.Effective.TrimEnd('/');
            return CoreJson.Json(new OAuthServerMetadata(
                Issuer: origin,
                AuthorizationEndpoint: $"{origin}/api/auth/oauth/authorize",
                TokenEndpoint: $"{origin}/api/auth/oauth/token",
                RegistrationEndpoint: $"{origin}/api/auth/oauth/register",
                ResponseTypesSupported: ["code"],
                GrantTypesSupported: ["authorization_code", "refresh_token"],
                CodeChallengeMethodsSupported: ["S256"],
                TokenEndpointAuthMethodsSupported: ["none"],
                ScopesSupported: [AccessTokenScopes.McpRead]));
        });

        // Core MCP's own resource metadata, at the RFC 9728 path for the resource `/api/mcp`. Apps
        // and the facade serve their equivalents through the SDK helpers.
        app.MapGet("/.well-known/oauth-protected-resource/api/mcp", (CorePublicOriginResolver coreOrigins) =>
        {
            var origin = coreOrigins.Effective.TrimEnd('/');
            return CoreJson.Json(new OAuthProtectedResourceMetadata(
                Resource: $"{origin}/api/mcp",
                AuthorizationServers: [origin],
                ScopesSupported: [AccessTokenScopes.McpRead],
                BearerMethodsSupported: ["header"]));
        });
    }

    // --- Authorization request -----------------------------------------------------------------

    private static void MapAuthorize(WebApplication app)
    {
        // The browser lands here from the client. Everything is validated *before* the consent page
        // exists, and the validated request is parked server-side — the page renders from Core's
        // copy, so nothing the user consents to can be swapped in the URL after the fact.
        app.MapGet("/api/auth/oauth/authorize", async (
            HttpRequest request,
            OAuthStore oauth,
            OAuthAuthorizationStore pending,
            CoreLifecycleService lifecycle,
            HostyCoreRuntimeConfig config,
            CorePublicOriginResolver coreOrigins,
            ShellPublicOriginResolver shellOrigin,
            CancellationToken cancellationToken) =>
        {
            var query = request.Query;
            var clientId = query["client_id"].ToString();
            var redirectUri = query["redirect_uri"].ToString();

            var state = await oauth.ReadAsync(cancellationToken);
            var client = state.Clients.FirstOrDefault(candidate =>
                string.Equals(candidate.ClientId, clientId, StringComparison.Ordinal));

            // Client and redirect_uri are the trust anchors: until both check out, nothing may be
            // redirected anywhere, so these two failures answer 400 in place. Everything after them
            // reports through the redirect, per RFC 6749 — the client is legitimate and gets to hear
            // what was wrong with its request.
            if (client is null)
            {
                return CoreJson.Json(
                    new ErrorResponse("oauth_client_unknown", "No such OAuth client is registered on this host."),
                    statusCode: StatusCodes.Status400BadRequest);
            }

            if (!client.RedirectUris.Contains(redirectUri, StringComparer.Ordinal))
            {
                return CoreJson.Json(
                    new ErrorResponse("oauth_redirect_mismatch", "redirect_uri is not one this client registered."),
                    statusCode: StatusCodes.Status400BadRequest);
            }

            var stateParam = query["state"].ToString();
            string RedirectError(string code, string description)
                => Append(redirectUri,
                    $"error={Uri.EscapeDataString(code)}&error_description={Uri.EscapeDataString(description)}" +
                    (string.IsNullOrEmpty(stateParam) ? "" : $"&state={Uri.EscapeDataString(stateParam)}"));

            if (!string.Equals(query["response_type"].ToString(), "code", StringComparison.Ordinal))
            {
                return Results.Redirect(RedirectError("unsupported_response_type", "Only response_type=code is supported."));
            }

            // PKCE is mandatory and S256 only: these are public clients, and the verifier is the
            // one thing binding the code to the client that asked for it.
            var challenge = query["code_challenge"].ToString();
            if (string.IsNullOrWhiteSpace(challenge) ||
                !string.Equals(query["code_challenge_method"].ToString(), "S256", StringComparison.Ordinal))
            {
                return Results.Redirect(RedirectError("invalid_request", "PKCE with code_challenge_method=S256 is required."));
            }

            // The resource decides the audience, and its absence is a refusal — a token without an
            // audience would be the broad credential this whole design exists to retire.
            var resource = query["resource"].ToString();
            if (string.IsNullOrWhiteSpace(resource))
            {
                return Results.Redirect(RedirectError("invalid_target", "A resource parameter naming the MCP endpoint is required."));
            }

            var resolved = await ResolveResourceAsync(resource, lifecycle, coreOrigins, config.ListenUrl, cancellationToken);
            if (resolved is null)
            {
                return Results.Redirect(RedirectError("invalid_target", "The resource does not name an MCP endpoint on this host."));
            }

            var scopes = ParseScopes(query["scope"].ToString());
            if (scopes is null)
            {
                // This feature issues read scopes only; anything else is refused rather than
                // silently narrowed, the same rule manual issuance follows.
                return Results.Redirect(RedirectError("invalid_scope", $"This host issues: {AccessTokenScopes.McpRead}."));
            }

            var parked = pending.Create(
                client.ClientId,
                client.Name,
                redirectUri,
                string.IsNullOrEmpty(stateParam) ? null : stateParam,
                challenge,
                resolved.Value.Audience,
                resolved.Value.DisplayName,
                scopes,
                resource,
                ResolveSourceKey(request));
            if (parked is null)
            {
                return Results.Redirect(RedirectError("temporarily_unavailable", "Too many pending authorization requests from this address."));
            }

            // Off to Shell, which owns the consent UI. Sign-in is Shell's ordinary continuation:
            // the page is session-gated and names itself as the destination.
            var shell = await shellOrigin.ResolveAsync(cancellationToken);
            if (string.IsNullOrWhiteSpace(shell))
            {
                return Results.Redirect(RedirectError("temporarily_unavailable", "This host has no Shell to show a consent page."));
            }

            return Results.Redirect($"{shell.TrimEnd('/')}/oauth/consent?request={Uri.EscapeDataString(parked.Id)}");
        });
    }

    // --- Consent (Shell's data + decision endpoints) -------------------------------------------

    private static void MapConsent(WebApplication app)
    {
        // What the consent page renders. Session-gated: the page is asking "may this client act as
        // *you*", and there is no you until someone signs in.
        app.MapGet("/api/auth/oauth/requests/{id}", (
            string id,
            HttpRequest request,
            UserDirectoryStore users,
            IClock clock,
            OAuthAuthorizationStore pending,
            CancellationToken cancellationToken) =>
            CoreSessionAuthorization.RequireSessionAsync(
                request,
                users,
                clock,
                user =>
                {
                    var found = pending.Find(id);
                    if (found is null)
                    {
                        return Task.FromResult<IResult>(CoreJson.Json(
                            new ErrorResponse("oauth_request_gone", "This authorization request expired or was already answered. Start again from the client."),
                            statusCode: StatusCodes.Status404NotFound));
                    }

                    return Task.FromResult<IResult>(CoreJson.Json(new OAuthConsentView(
                        found.Id,
                        found.ClientName,
                        found.AudienceDisplayName,
                        found.Audience,
                        found.Scopes,
                        user.DisplayName ?? user.Email ?? user.Id,
                        (int)Math.Max(0, (found.ExpiresAt - clock.UtcNow).TotalSeconds))));
                },
                cancellationToken: cancellationToken));

        // The decision. Approval mints the one-time code; either way the browser is handed the
        // redirect target and navigates itself — Core never answers a cross-origin redirect here,
        // so the page can show an error instead of stranding the user on a broken client URL.
        app.MapPost("/api/auth/oauth/requests/{id}/decide", (
            string id,
            HttpRequest request,
            OAuthDecisionRequest? input,
            UserDirectoryStore users,
            IClock clock,
            OAuthAuthorizationStore pending,
            AuditStore audit,
            CancellationToken cancellationToken) =>
            CoreSessionAuthorization.RequireSessionAsync(
                request,
                users,
                clock,
                async user =>
                {
                    var found = pending.Find(id);
                    if (found is null)
                    {
                        return CoreJson.Json(
                            new ErrorResponse("oauth_request_gone", "This authorization request expired or was already answered."),
                            statusCode: StatusCodes.Status404NotFound);
                    }

                    if (!string.Equals(input?.Decision, "approve", StringComparison.Ordinal))
                    {
                        pending.Deny(id);
                        await AppendAuditAsync(audit, clock, "auth.oauth.consent", "denied", found.ClientName, found.Audience, user.Id, cancellationToken);
                        return CoreJson.Json(new OAuthDecisionResponse(
                            Append(found.RedirectUri, WithState("error=access_denied", found.State))));
                    }

                    // The same bar manual issuance sets: Core MCP is an administrator surface, and a
                    // consent cannot grant what the consenting user does not hold.
                    if (string.Equals(found.Audience, AccessTokenScopes.CoreAudience, StringComparison.Ordinal) &&
                        !AppAccessPolicy.IsAdmin(user))
                    {
                        return CoreJson.Json(
                            new ErrorResponse("admin_required", "A credential for Core MCP requires a Host administrator."),
                            statusCode: StatusCodes.Status403Forbidden);
                    }

                    var approved = pending.Approve(id, user.Id);
                    if (approved is null)
                    {
                        return CoreJson.Json(
                            new ErrorResponse("oauth_request_gone", "This authorization request expired or was already answered."),
                            statusCode: StatusCodes.Status404NotFound);
                    }

                    await AppendAuditAsync(audit, clock, "auth.oauth.consent", "approved", approved.ClientName, approved.Audience, user.Id, cancellationToken);
                    return CoreJson.Json(new OAuthDecisionResponse(
                        Append(approved.RedirectUri, WithState($"code={Uri.EscapeDataString(approved.Code!)}", approved.State))));
                },
                requireCsrf: true,
                cancellationToken: cancellationToken));
    }

    // --- Token endpoint ------------------------------------------------------------------------

    private static void MapToken(WebApplication app)
    {
        // Anonymous by nature (the client is public and proves itself with PKCE or a refresh
        // token), form-encoded per the spec.
        app.MapPost("/api/auth/oauth/token", async (
            HttpRequest request,
            OAuthStore oauth,
            OAuthAuthorizationStore pending,
            UserDirectoryStore users,
            IClock clock,
            CoreSettingsService settings,
            CoreEventHub events,
            AuditStore audit,
            CancellationToken cancellationToken) =>
        {
            if (!request.HasFormContentType)
            {
                return TokenError("invalid_request", "Expected application/x-www-form-urlencoded.");
            }

            var form = await request.ReadFormAsync(cancellationToken);
            return form["grant_type"].ToString() switch
            {
                "authorization_code" => await RedeemCodeAsync(form, oauth, pending, users, clock, settings, events, audit, cancellationToken),
                "refresh_token" => await RefreshAsync(form, oauth, users, clock, settings, events, audit, cancellationToken),
                _ => TokenError("unsupported_grant_type", "Supported: authorization_code, refresh_token."),
            };
        });
    }

    private static async Task<IResult> RedeemCodeAsync(
        IFormCollection form,
        OAuthStore oauth,
        OAuthAuthorizationStore pending,
        UserDirectoryStore users,
        IClock clock,
        CoreSettingsService settings,
        CoreEventHub events,
        AuditStore audit,
        CancellationToken cancellationToken)
    {
        var code = form["code"].ToString();
        var verifier = form["code_verifier"].ToString();
        if (string.IsNullOrWhiteSpace(code) || string.IsNullOrWhiteSpace(verifier))
        {
            return TokenError("invalid_request", "code and code_verifier are required.");
        }

        // Redeemed (and thereby consumed) before anything is checked against it: a code must die on
        // its first presentation, valid or not, or a failed guess could be retried against it.
        var redeemed = pending.Redeem(code);
        if (redeemed is null || redeemed.ApprovedUserId is null)
        {
            return TokenError("invalid_grant", "The authorization code is unknown, expired, or already used.");
        }

        if (!string.Equals(form["client_id"].ToString(), redeemed.ClientId, StringComparison.Ordinal) ||
            (form.ContainsKey("redirect_uri") &&
                !string.Equals(form["redirect_uri"].ToString(), redeemed.RedirectUri, StringComparison.Ordinal)))
        {
            return TokenError("invalid_grant", "The code was issued to a different client or redirect_uri.");
        }

        // PKCE: S256(verifier) must equal the challenge the authorization request carried.
        var computed = Base64UrlEncode(SHA256.HashData(Encoding.ASCII.GetBytes(verifier)));
        if (!CryptographicOperations.FixedTimeEquals(
                Encoding.ASCII.GetBytes(computed), Encoding.ASCII.GetBytes(redeemed.CodeChallenge)))
        {
            return TokenError("invalid_grant", "PKCE verification failed.");
        }

        // The spec lets a client repeat `resource` at the token endpoint; when it does, it must be
        // the one consent was given for — a token for a different audience than the user saw is the
        // substitution the parked request exists to prevent.
        if (form.ContainsKey("resource") &&
            !string.Equals(form["resource"].ToString(), redeemed.Resource, StringComparison.Ordinal))
        {
            return TokenError("invalid_target", "resource differs from the one that was authorized.");
        }

        // The grant first, the access token second: a grant without an access token self-heals on
        // the client's first refresh, while the reverse would be an access token no page can revoke
        // as part of anything.
        var refreshToken = NewSecret("hosty_oauth_refresh");
        var grant = new OAuthGrantRecord(
            Id: Convert.ToHexString(RandomNumberGenerator.GetBytes(16)).ToLowerInvariant(),
            ClientId: redeemed.ClientId,
            UserId: redeemed.ApprovedUserId,
            Audience: redeemed.Audience,
            Scopes: redeemed.Scopes,
            RefreshTokenHash: OAuthStore.HashRefreshToken(refreshToken),
            CreatedAt: clock.UtcNow,
            // The grant is the long-lived credential; it lives on the access-token idle budget the
            // operator already tunes, and every rotation issues a fresh one.
            ExpiresAt: clock.UtcNow + settings.AuthLifetimes.AccessTokenIdle);
        await oauth.UpdateAsync<object?>(state => (state with { Grants = state.Grants.Append(grant).ToArray() }, null), cancellationToken);

        var access = await AccessTokenEndpoints.IssueAsync(
            redeemed.ApprovedUserId, AccessTokenKinds.OAuth, redeemed.ClientName, users, clock, settings.AuthLifetimes,
            cancellationToken, redeemed.Audience, redeemed.Scopes, AccessTokenLifetime, grant.Id);

        // The same post-append re-check the refresh path runs, closing the race with a concurrent
        // revocation of the just-created grant (see RefreshAsync for why either ordering is covered).
        var latest = await oauth.ReadAsync(cancellationToken);
        if (latest.Grants.FirstOrDefault(candidate => string.Equals(candidate.Id, grant.Id, StringComparison.Ordinal))
                is not { RevokedAt: null })
        {
            await RevokeIssuedAccessTokensAsync(grant.Id, users, events, clock.UtcNow, cancellationToken);
            return TokenError("invalid_grant", "The grant was revoked.");
        }

        await AppendAuditAsync(audit, clock, "auth.oauth.grant", "issued", redeemed.ClientName, redeemed.Audience, redeemed.ApprovedUserId, cancellationToken);
        return CoreJson.Json(new OAuthTokenResponse(
            access.Id, "Bearer", (int)AccessTokenLifetime.TotalSeconds, refreshToken, string.Join(' ', redeemed.Scopes)));
    }

    /// <summary>Spent hashes retained per chain. ~two days of hourly rotation; a replay older than
    /// this is refused without the family kill, which fails toward an inconvenience.</summary>
    private const int SpentHashesRetained = 50;

    private static async Task<IResult> RefreshAsync(
        IFormCollection form,
        OAuthStore oauth,
        UserDirectoryStore users,
        IClock clock,
        CoreSettingsService settings,
        CoreEventHub events,
        AuditStore audit,
        CancellationToken cancellationToken)
    {
        var presented = form["refresh_token"].ToString();
        var clientId = form["client_id"].ToString();
        if (string.IsNullOrWhiteSpace(presented))
        {
            return TokenError("invalid_request", "refresh_token is required.");
        }

        var hash = OAuthStore.HashRefreshToken(presented);
        var now = clock.UtcNow;
        var replacement = NewSecret("hosty_oauth_refresh");

        // Rotation inside the store's lock: the presented token is spent and replaced atomically,
        // so two racing refreshes redeem one rotation between them. The same pass detects a
        // *replay* — a token this chain already spent. Two parties presenting one token means one
        // of them stole it, and whichever refreshed first holds the live chain; the only safe
        // answer is to kill the chain, or the thief who won the race keeps a credential while the
        // victim is quietly locked out.
        var (rotated, replayed) = await oauth.UpdateAsync(state =>
        {
            var grant = state.Grants.FirstOrDefault(candidate =>
                string.Equals(candidate.RefreshTokenHash, hash, StringComparison.Ordinal) &&
                string.Equals(candidate.ClientId, clientId, StringComparison.Ordinal) &&
                OAuthStore.IsGrantLive(candidate, now));
            if (grant is not null)
            {
                var spent = (grant.SpentRefreshTokenHashes ?? []).Append(grant.RefreshTokenHash).ToArray();
                var next = grant with
                {
                    RefreshTokenHash = OAuthStore.HashRefreshToken(replacement),
                    RotatedAt = now,
                    ExpiresAt = now + settings.AuthLifetimes.AccessTokenIdle,
                    SpentRefreshTokenHashes = spent.Length <= SpentHashesRetained ? spent : spent[^SpentHashesRetained..],
                };
                return (state with
                {
                    Grants = state.Grants
                        .Select(candidate => ReferenceEquals(candidate, grant) ? next : candidate)
                        .ToArray(),
                }, ((OAuthGrantRecord?)next, (OAuthGrantRecord?)null));
            }

            var replayVictim = state.Grants.FirstOrDefault(candidate =>
                string.Equals(candidate.ClientId, clientId, StringComparison.Ordinal) &&
                OAuthStore.IsGrantLive(candidate, now) &&
                (candidate.SpentRefreshTokenHashes ?? []).Contains(hash, StringComparer.Ordinal));
            if (replayVictim is null)
            {
                return (state, ((OAuthGrantRecord?)null, (OAuthGrantRecord?)null));
            }

            return (state with
            {
                Grants = state.Grants
                    .Select(candidate => ReferenceEquals(candidate, replayVictim)
                        ? replayVictim with { RevokedAt = now }
                        : candidate)
                    .ToArray(),
            }, ((OAuthGrantRecord?)null, (OAuthGrantRecord?)replayVictim));
        }, cancellationToken);

        if (replayed is not null)
        {
            // The chain is dead; now so is everything it issued, including the winner's access
            // token — the winner may be the thief.
            await RevokeIssuedAccessTokensAsync(replayed.Id, users, events, now, cancellationToken);
            await AppendAuditAsync(audit, clock, "auth.oauth.grant", "revoked_replay",
                LabelFor(await oauth.ReadAsync(cancellationToken), replayed), replayed.Audience, replayed.UserId, cancellationToken);
            return TokenError("invalid_grant", "This refresh token was already used. The grant has been revoked; authorize again.");
        }

        if (rotated is null)
        {
            return TokenError("invalid_grant", "The refresh token is unknown, expired, or revoked.");
        }

        // The acting user is re-read at issue (IssueAsync stores the id; introspection re-checks
        // access per call), so a demoted or removed user's refresh yields a token that answers
        // inactive everywhere — the same catch-up every scoped credential gets.
        var access = await AccessTokenEndpoints.IssueAsync(
            rotated.UserId, AccessTokenKinds.OAuth, LabelFor(await oauth.ReadAsync(cancellationToken), rotated), users, clock,
            settings.AuthLifetimes, cancellationToken, rotated.Audience, rotated.Scopes, AccessTokenLifetime, rotated.Id);

        // Re-checked *after* the session was appended, which closes the race with a concurrent
        // revocation: a revoke that landed before this read is caught here and the fresh token is
        // taken back; one that lands after it will find the token in its own cascade scan, because
        // the append happened first. Either ordering leaves nothing alive.
        var latest = await oauth.ReadAsync(cancellationToken);
        if (latest.Grants.FirstOrDefault(candidate => string.Equals(candidate.Id, rotated.Id, StringComparison.Ordinal))
                is not { RevokedAt: null })
        {
            await RevokeIssuedAccessTokensAsync(rotated.Id, users, events, clock.UtcNow, cancellationToken);
            return TokenError("invalid_grant", "The grant was revoked.");
        }

        return CoreJson.Json(new OAuthTokenResponse(
            access.Id, "Bearer", (int)AccessTokenLifetime.TotalSeconds, replacement, string.Join(' ', rotated.Scopes)));
    }

    /// <summary>Revokes every access token a grant issued and closes their event streams — the same
    /// cascade the credentials page runs when a grant row is revoked.</summary>
    private static async Task RevokeIssuedAccessTokensAsync(
        string grantId,
        UserDirectoryStore users,
        CoreEventHub events,
        DateTimeOffset revokedAt,
        CancellationToken cancellationToken)
    {
        var issuedIds = new List<string>();
        await users.UpdateAsync(current => current with
        {
            Sessions = current.Sessions
                .Select(session =>
                {
                    if (string.Equals(session.GrantId, grantId, StringComparison.Ordinal) && session.RevokedAt is null)
                    {
                        issuedIds.Add(session.Id);
                        return session with { RevokedAt = revokedAt };
                    }

                    return session;
                })
                .ToArray(),
        }, cancellationToken);
        foreach (var issuedId in issuedIds)
        {
            events.CloseSession(issuedId);
        }
    }

    // --- Dynamic client registration (RFC 7591) ------------------------------------------------

    private static void MapRegistration(WebApplication app)
    {
        app.MapPost("/api/auth/oauth/register", async (
            HttpRequest request,
            OAuthRegistrationRequest? input,
            OAuthStore oauth,
            CoreSettingsService settings,
            OAuthRegistrationLimiter limiter,
            AuditStore audit,
            IClock clock,
            CancellationToken cancellationToken) =>
        {
            // The breaker. Registration is an anonymous write, so it exists only while an operator
            // has deliberately turned it on — and everything already registered keeps working when
            // they turn it back off.
            if (!settings.OAuth.DynamicRegistrationEnabled)
            {
                return CoreJson.Json(
                    new ErrorResponse(
                        "oauth_registration_disabled",
                        "OAuth client registration is turned off. A host administrator can enable it in Core settings while connecting a new client."),
                    statusCode: StatusCodes.Status403Forbidden);
            }

            var source = ResolveSourceKey(request);
            if (!limiter.Allow(source, clock.UtcNow))
            {
                return CoreJson.Json(
                    new ErrorResponse("oauth_registration_throttled", "Too many registrations from this address. Wait and retry."),
                    statusCode: StatusCodes.Status429TooManyRequests);
            }

            var redirectUris = (input?.RedirectUris ?? []).Where(IsAcceptableRedirectUri).Distinct(StringComparer.Ordinal).ToArray();
            if (redirectUris.Length == 0)
            {
                return CoreJson.Json(
                    new ErrorResponse(
                        "invalid_redirect_uri",
                        "At least one https or loopback-http redirect_uri is required."),
                    statusCode: StatusCodes.Status400BadRequest);
            }

            var name = NormalizeClientName(input?.ClientName);
            var client = new OAuthClientRecord(
                ClientId: $"hosty_oauth_{Convert.ToHexString(RandomNumberGenerator.GetBytes(12)).ToLowerInvariant()}",
                Name: name,
                RedirectUris: redirectUris,
                CreatedAt: clock.UtcNow,
                SourceAddress: source);
            await oauth.UpdateAsync<object?>(state => (state with { Clients = state.Clients.Append(client).ToArray() }, null), cancellationToken);
            await AppendAuditAsync(audit, clock, "auth.oauth.client", "registered", name, null, null, cancellationToken);

            // token_endpoint_auth_method none: public client, no secret exists to leak.
            return CoreJson.Json(
                new OAuthRegistrationResponse(client.ClientId, name, redirectUris, "none"),
                statusCode: StatusCodes.Status201Created);
        });
    }

    private static void MapClients(WebApplication app)
    {
        // The operator-visible client list: who may start an authorization flow against this host.
        app.MapGet("/api/auth/oauth/clients", (
            HttpRequest request,
            UserDirectoryStore users,
            IClock clock,
            OAuthStore oauth,
            CancellationToken cancellationToken) =>
            CoreSessionAuthorization.RequireAdminSessionAsync(
                request,
                users,
                clock,
                async () =>
                {
                    var state = await oauth.ReadAsync(cancellationToken);
                    var now = clock.UtcNow;
                    return CoreJson.Json(new OAuthClientListResponse(state.Clients
                        .Select(client => new OAuthClientView(
                            client.ClientId,
                            client.Name,
                            client.RedirectUris,
                            client.CreatedAt,
                            client.SourceAddress,
                            state.Grants.Count(grant =>
                                string.Equals(grant.ClientId, client.ClientId, StringComparison.Ordinal) &&
                                OAuthStore.IsGrantLive(grant, now))))
                        .ToArray()));
                },
                cancellationToken: cancellationToken));
    }

    // --- Resource → audience -------------------------------------------------------------------

    /// <summary>
    /// Resolves an RFC 8707 resource URL to the single audience a token may carry. Three shapes
    /// exist on a host: Core's own MCP endpoint, an app's declared `mcp` interface, and the MCP
    /// facade of an app declaring the `ai-gateway` interface (its origin + /mcp). Anything else is
    /// nothing — an unmatched resource must refuse, never default to something broad.
    /// </summary>
    internal static async Task<(string Audience, string DisplayName)?> ResolveResourceAsync(
        string resource,
        CoreLifecycleService lifecycle,
        CorePublicOriginResolver coreOrigins,
        string listenUrl,
        CancellationToken cancellationToken)
    {
        if (!Uri.TryCreate(resource.Trim(), UriKind.Absolute, out var target))
        {
            return null;
        }

        // Both spellings of Core's own MCP endpoint, deliberately. The listen URL is not a convenience
        // here: it is the half of this pair that keeps working when the public origin names a host that
        // does not answer, so an operator recovering over loopback can still complete the flow.
        foreach (var origin in new[] { coreOrigins.Effective, listenUrl })
        {
            if (SameResource(target, origin, "/api/mcp"))
            {
                return (AccessTokenScopes.CoreAudience, "Hosty Core");
            }
        }

        var apps = await lifecycle.ListAppsAsync(cancellationToken);
        foreach (var app in apps)
        {
            foreach (var declaration in (app.Interfaces ?? new Dictionary<string, IReadOnlyList<AppInterfaceSummary>>())
                .Where(pair => string.Equals(pair.Key, "mcp", StringComparison.Ordinal))
                .SelectMany(pair => pair.Value))
            {
                if (declaration.Url is { } url && SameUrl(target, url))
                {
                    return (app.Id, app.DisplayName);
                }
            }

            // The facade: served at the gateway app's own origin under /mcp. Matched for the app
            // that declares the ai-gateway interface rather than for every app, because "origin plus
            // a path that might exist" is not a claim any other app has made.
            if ((app.Interfaces ?? new Dictionary<string, IReadOnlyList<AppInterfaceSummary>>()).ContainsKey("ai-gateway"))
            {
                foreach (var endpoint in app.Endpoints)
                {
                    foreach (var origin in new[] { endpoint.PublicOrigin, endpoint.Url })
                    {
                        if (origin is not null && SameResource(target, origin, "/mcp"))
                        {
                            return (app.Id, app.DisplayName);
                        }
                    }
                }
            }
        }

        return null;
    }

    private static bool SameResource(Uri target, string origin, string path)
        => Uri.TryCreate(origin.TrimEnd('/') + path, UriKind.Absolute, out var expected) && SameUrl(target, expected);

    private static bool SameUrl(Uri target, string url)
        => Uri.TryCreate(url, UriKind.Absolute, out var expected) && SameUrl(target, expected);

    // Scheme, host and port case-insensitively; the path exactly bar a trailing slash. Query and
    // fragment make two resources different on purpose — nothing here mints for "roughly that URL".
    private static bool SameUrl(Uri target, Uri expected)
        => string.Equals(target.Scheme, expected.Scheme, StringComparison.OrdinalIgnoreCase) &&
            string.Equals(target.Host, expected.Host, StringComparison.OrdinalIgnoreCase) &&
            target.Port == expected.Port &&
            string.Equals(target.AbsolutePath.TrimEnd('/'), expected.AbsolutePath.TrimEnd('/'), StringComparison.Ordinal) &&
            string.IsNullOrEmpty(target.Query) && string.IsNullOrEmpty(target.Fragment);

    // --- Helpers -------------------------------------------------------------------------------

    /// <summary>Scopes for this flow: absent means mcp:read, anything beyond read is refused (this
    /// feature ships read scopes only). Null signals the refusal.</summary>
    private static IReadOnlyList<string>? ParseScopes(string raw)
    {
        if (string.IsNullOrWhiteSpace(raw))
        {
            return [AccessTokenScopes.McpRead];
        }

        var requested = raw.Split(' ', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        return requested.All(scope => string.Equals(scope, AccessTokenScopes.McpRead, StringComparison.Ordinal))
            ? [AccessTokenScopes.McpRead]
            : null;
    }

    private static bool IsAcceptableRedirectUri(string? candidate)
    {
        if (!Uri.TryCreate(candidate, UriKind.Absolute, out var uri) || !string.IsNullOrEmpty(uri.Fragment))
        {
            return false;
        }

        if (string.Equals(uri.Scheme, "https", StringComparison.OrdinalIgnoreCase))
        {
            return true;
        }

        // http only on the loopback, which is how a native client (Claude Code, an editor) receives
        // its callback. A routable http URI would carry the code in clear across a network.
        return string.Equals(uri.Scheme, "http", StringComparison.OrdinalIgnoreCase) &&
            (uri.IsLoopback || string.Equals(uri.Host, "localhost", StringComparison.OrdinalIgnoreCase));
    }

    private static string NormalizeClientName(string? name)
    {
        var cleaned = new string((name ?? "").Trim().Where(character => !char.IsControl(character)).ToArray());
        if (cleaned.Length == 0)
        {
            return "Unnamed client";
        }

        return cleaned.Length <= 80 ? cleaned : cleaned[..80];
    }

    private static string LabelFor(OAuthState state, OAuthGrantRecord grant)
        => state.Clients.FirstOrDefault(client => string.Equals(client.ClientId, grant.ClientId, StringComparison.Ordinal))?.Name
            ?? grant.ClientId;

    private static string WithState(string query, string? state)
        => state is null ? query : $"{query}&state={Uri.EscapeDataString(state)}";

    private static string Append(string uri, string query)
        => uri.Contains('?', StringComparison.Ordinal) ? $"{uri}&{query}" : $"{uri}?{query}";

    private static IResult TokenError(string code, string description)
        => CoreJson.Json(new OAuthTokenErrorResponse(code, description), statusCode: StatusCodes.Status400BadRequest);

    private static string NewSecret(string prefix)
        => $"{prefix}_{Convert.ToHexString(RandomNumberGenerator.GetBytes(32)).ToLowerInvariant()}";

    private static string Base64UrlEncode(byte[] bytes)
        => Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');

    private static string ResolveSourceKey(HttpRequest request)
        => request.HttpContext.Connection.RemoteIpAddress?.ToString() ?? "unknown";

    private static Task AppendAuditAsync(
        AuditStore audit,
        IClock clock,
        string action,
        string outcome,
        string clientName,
        string? audience,
        string? actorUserId,
        CancellationToken cancellationToken)
    {
        var details = new Dictionary<string, string>(StringComparer.Ordinal) { ["client"] = clientName };
        if (audience is not null)
        {
            details["audience"] = audience;
        }

        return audit.AppendAsync(
            new AuditRecord(
                Id: $"audit_{Guid.NewGuid():N}",
                Action: action,
                ResourceType: "auth.oauth",
                ResourceId: null,
                Outcome: outcome,
                ActorUserId: actorUserId,
                CreatedAt: clock.UtcNow,
                Details: details),
            cancellationToken);
    }

}

/// <summary>The registration limiter: per-source sliding window, in memory. A DI singleton rather
/// than a static, so its state belongs to one application instance — a static would also be shared
/// across every in-process test host, which is how it was caught.</summary>
internal sealed class OAuthRegistrationLimiter
{
    // Registrations one address may make per window. Registration is anonymous, so refusing floods
    // has to be cheap; the toggle (off by default) is the real breaker, this bounds the "on" state.
    private const int Limit = 5;
    private static readonly TimeSpan Window = TimeSpan.FromMinutes(10);

    private readonly Dictionary<string, List<DateTimeOffset>> hits = new(StringComparer.Ordinal);
    private readonly object gate = new();

    public bool Allow(string source, DateTimeOffset now)
    {
        lock (gate)
        {
            var recent = hits.TryGetValue(source, out var existing)
                ? existing.Where(at => now - at < Window).ToList()
                : [];
            if (recent.Count >= Limit)
            {
                hits[source] = recent;
                return false;
            }

            recent.Add(now);
            hits[source] = recent;
            if (hits.Count > 1024)
            {
                hits.Remove(hits.Keys.First());
            }

            return true;
        }
    }
}

// --- Wire shapes (snake_case per the OAuth RFCs) ----------------------------------------------

internal sealed record OAuthServerMetadata(
    [property: JsonPropertyName("issuer")] string Issuer,
    [property: JsonPropertyName("authorization_endpoint")] string AuthorizationEndpoint,
    [property: JsonPropertyName("token_endpoint")] string TokenEndpoint,
    [property: JsonPropertyName("registration_endpoint")] string RegistrationEndpoint,
    [property: JsonPropertyName("response_types_supported")] IReadOnlyList<string> ResponseTypesSupported,
    [property: JsonPropertyName("grant_types_supported")] IReadOnlyList<string> GrantTypesSupported,
    [property: JsonPropertyName("code_challenge_methods_supported")] IReadOnlyList<string> CodeChallengeMethodsSupported,
    [property: JsonPropertyName("token_endpoint_auth_methods_supported")] IReadOnlyList<string> TokenEndpointAuthMethodsSupported,
    [property: JsonPropertyName("scopes_supported")] IReadOnlyList<string> ScopesSupported);

internal sealed record OAuthProtectedResourceMetadata(
    [property: JsonPropertyName("resource")] string Resource,
    [property: JsonPropertyName("authorization_servers")] IReadOnlyList<string> AuthorizationServers,
    [property: JsonPropertyName("scopes_supported")] IReadOnlyList<string> ScopesSupported,
    [property: JsonPropertyName("bearer_methods_supported")] IReadOnlyList<string> BearerMethodsSupported);

internal sealed record OAuthTokenResponse(
    [property: JsonPropertyName("access_token")] string AccessToken,
    [property: JsonPropertyName("token_type")] string TokenType,
    [property: JsonPropertyName("expires_in")] int ExpiresIn,
    [property: JsonPropertyName("refresh_token")] string RefreshToken,
    [property: JsonPropertyName("scope")] string Scope);

internal sealed record OAuthTokenErrorResponse(
    [property: JsonPropertyName("error")] string Error,
    [property: JsonPropertyName("error_description")] string ErrorDescription);

internal sealed record OAuthRegistrationRequest(
    [property: JsonPropertyName("redirect_uris")] IReadOnlyList<string>? RedirectUris,
    [property: JsonPropertyName("client_name")] string? ClientName);

internal sealed record OAuthRegistrationResponse(
    [property: JsonPropertyName("client_id")] string ClientId,
    [property: JsonPropertyName("client_name")] string ClientName,
    [property: JsonPropertyName("redirect_uris")] IReadOnlyList<string> RedirectUris,
    [property: JsonPropertyName("token_endpoint_auth_method")] string TokenEndpointAuthMethod);

// Camel-case like the rest of the operator API: these two are consumed by Shell, not by an OAuth
// library, and Shell speaks the platform's own dialect.
internal sealed record OAuthConsentView(
    string Id,
    string ClientName,
    string AudienceDisplayName,
    string Audience,
    IReadOnlyList<string> Scopes,
    string ActingUser,
    int ExpiresInSeconds);

internal sealed record OAuthDecisionRequest(string? Decision);

internal sealed record OAuthDecisionResponse(string RedirectTo);

internal sealed record OAuthClientView(
    string ClientId,
    string Name,
    IReadOnlyList<string> RedirectUris,
    DateTimeOffset CreatedAt,
    string? SourceAddress,
    int LiveGrants);

internal sealed record OAuthClientListResponse(IReadOnlyList<OAuthClientView> Clients);

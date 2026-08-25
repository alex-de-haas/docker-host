namespace Haas.Hosty.Core;

// How a system app reaches other apps for a user it never got a browser session from
// (docs/features/mcp-facade/plan.md).
//
// The delegated-token *exchange* cannot serve this. It branches off a token the caller was already
// handed, and that token descends from a person clicking something in Shell within the last hour —
// which is exactly right for the assistant panel and impossible for an external agent client, whose
// authorization is a standing credential rather than a fresh interaction.
//
// So the credential the client presented becomes the authorization: a scoped access token whose
// audience is the calling app. Issuing it *was* the user's consent, it is revocable, and it is
// re-validated here on every call. What comes back is an ordinary, unbranched delegated token, no
// different from one the browser path mints.
//
// This never widens reach. `RequireAccessibleUserAsync` bounds the result by the acting user's own
// access — the same gate every identity flow runs — so an app acting for a user can reach exactly
// what that user could reach personally, and nothing more.
internal static class OnBehalfOfTokenEndpoints
{
    public static void Map(WebApplication app)
    {
        app.MapPost("/api/internal/apps/{appId}/delegated-token", async (
            string appId,
            HttpRequest request,
            OnBehalfOfTokenRequest? input,
            AppServiceTokenService serviceTokens,
            AppRegistryStore apps,
            AppIdentityService identity,
            DelegatedTokenService delegatedTokens,
            UserDirectoryStore users,
            AuthLifetimes lifetimes,
            AuditStore audit,
            IClock clock,
            CancellationToken cancellationToken) =>
        {
            var serviceToken = CoreSessionAuthorization.ReadBearerToken(request);
            if (string.IsNullOrWhiteSpace(serviceToken) || !serviceTokens.ValidateToken(appId, serviceToken))
            {
                return CoreJson.Json(
                    new ErrorResponse("on_behalf_of_unauthorized", "App service token is missing or invalid."),
                    statusCode: StatusCodes.Status401Unauthorized);
            }

            var target = input?.TargetAppId?.Trim();
            if (string.IsNullOrWhiteSpace(input?.Token) || string.IsNullOrWhiteSpace(target))
            {
                return CoreJson.Json(
                    new ErrorResponse("on_behalf_of_invalid", "Both the presented credential and a target app id are required."),
                    statusCode: StatusCodes.Status400BadRequest);
            }

            // The same bar the delegated-token exchange sets, for the same reason: acting as a user
            // toward another app is a delegation capability, and it belongs to the apps an
            // administrator installed as part of the platform rather than to every app that happens
            // to hold a credential.
            var caller = await apps.GetAppAsync(appId, cancellationToken);
            if (caller is null || !caller.System)
            {
                await AppendAuditAsync(audit, clock, appId, target, null, "on_behalf_of_forbidden", cancellationToken);
                return CoreJson.Json(
                    new ErrorResponse("on_behalf_of_forbidden", "Only an installed system app may act on behalf of a user."),
                    statusCode: StatusCodes.Status403Forbidden);
            }

            // Audience is the caller Core just authenticated, never one read out of the credential —
            // the same issuer-side check introspection makes, so a credential addressed to one app
            // cannot be spent by another.
            var state = await users.ReadAsync(cancellationToken);
            var scoped = ScopedCredentials.Resolve(state, input.Token, clock.UtcNow, lifetimes, appId);
            if (scoped is null || !AccessTokenScopes.Grants(scoped.Record.Scopes, AccessTokenScopes.McpRead))
            {
                await AppendAuditAsync(audit, clock, appId, target, scoped?.User.Id, "on_behalf_of_denied", cancellationToken);
                return CoreJson.Json(
                    new ErrorResponse("on_behalf_of_denied", "The presented credential is not valid for this app."),
                    statusCode: StatusCodes.Status403Forbidden);
            }

            // Core's own MCP endpoint as a target, so one aggregated catalog can carry the control
            // plane beside the apps. There is no app record to resolve access against, so the rule
            // is the one that surface has always had: administrators only, re-read here rather than
            // taken from the credential, because a role downgrade must reach it.
            if (string.Equals(target, AccessTokenScopes.CoreAudience, StringComparison.Ordinal))
            {
                if (!AppAccessPolicy.IsAdmin(scoped.User))
                {
                    await AppendAuditAsync(audit, clock, appId, target, scoped.User.Id, "admin_required", cancellationToken);
                    return CoreJson.Json(
                        new ErrorResponse("admin_required", "Core MCP requires a Host administrator."),
                        statusCode: StatusCodes.Status403Forbidden);
                }

                var coreToken = delegatedTokens.CreateToken(
                    AccessTokenScopes.CoreAudience, scoped.User.Id, scoped.User.Role);
                await CoreSessionAuthorization.TouchSessionAsync(users, scoped.Record, clock.UtcNow, cancellationToken);
                await AppendAuditAsync(audit, clock, appId, target, scoped.User.Id, "succeeded", cancellationToken);
                return CoreJson.Json(coreToken);
            }

            try
            {
                var (actor, resolved) = await identity.RequireAccessibleUserAsync(
                    target, scoped.User.Id, cancellationToken);

                // Unbranched, with a fresh chain origin. The hour-long chain bound exists to make a
                // stolen delegated token die with the interaction it descends from; here there is no
                // interaction to descend from, and the standing credential is revocable and re-checked
                // on every call — which is the stronger property, not a weaker one.
                var issued = delegatedTokens.CreateToken(resolved.Id, actor.Id, actor.Role);
                await CoreSessionAuthorization.TouchSessionAsync(users, scoped.Record, clock.UtcNow, cancellationToken);
                await AppendAuditAsync(audit, clock, appId, target, actor.Id, "succeeded", cancellationToken);
                return CoreJson.Json(issued);
            }
            catch (AppIdentityException ex)
            {
                // An unassigned member, a disabled user, an uninstalled target. Audited as the
                // refusal it is — this is the one place an app acts as a user toward another app, and
                // the refusals are the more interesting half of that trail.
                await AppendAuditAsync(audit, clock, appId, target, scoped.User.Id, ex.Code, cancellationToken);
                return CoreJson.Json(new ErrorResponse(ex.Code, ex.Message), statusCode: StatusCodes.Status403Forbidden);
            }
        });
    }

    private static Task AppendAuditAsync(
        AuditStore audit,
        IClock clock,
        string callerAppId,
        string targetAppId,
        string? actorUserId,
        string outcome,
        CancellationToken cancellationToken)
        => audit.AppendAsync(
            new AuditRecord(
                Id: $"audit_{Guid.NewGuid():N}",
                // Its own action rather than the exchange's: the authorization is a standing
                // credential, not a delegation chain, and a reader of the log should be able to tell
                // which of the two let an app act as somebody.
                Action: "auth.delegated-token.on-behalf-of",
                ResourceType: "app",
                ResourceId: targetAppId,
                Outcome: outcome,
                ActorUserId: actorUserId,
                CreatedAt: clock.UtcNow,
                Details: new Dictionary<string, string>(StringComparer.Ordinal)
                {
                    ["callerAppId"] = callerAppId,
                    ["targetAppId"] = targetAppId,
                }),
            cancellationToken);
}

internal sealed record OnBehalfOfTokenRequest(string? Token, string? TargetAppId);

namespace Haas.Hosty.Core;

// How an app validates a scoped access token presented to it
// (docs/features/scoped-access-tokens/feature.md).
//
// The credential an app accepted until now was a delegated identity token: signed, verified offline
// inside the app, and therefore impossible to revoke — which is why it lives five minutes and why a
// static client config cannot hold one. A scoped access token is the opposite trade: opaque, worth
// nothing on its own, and resolved here against live state on every call. That is what lets it live
// in a config file and still stop working the instant it is revoked.
//
// There is no cache, by decision. Core and the app share a host, so this is a loopback hop against
// an in-memory read, and the traffic is agent tool calls rather than a request flood. A cache would
// buy microseconds and sell back the one property the whole design is for: an operator who revokes a
// credential has revoked it, with no window to explain.
internal static class TokenIntrospectionEndpoints
{
    public static void Map(WebApplication app)
    {
        // Follows the `/api/internal/apps/{appId}/…` pattern exactly: the service token is validated
        // against the id in the path, so an app can only ever introspect *for itself*. That is not
        // decoration — it is the audience check. The token's own audience is compared to the caller
        // Core just authenticated, never to an audience read out of the token, so app A presenting
        // app B's credential learns nothing but `active: false`.
        app.MapPost("/api/internal/apps/{appId}/token/introspect", async (
            string appId,
            HttpRequest request,
            TokenIntrospectionRequest? input,
            AppServiceTokenService serviceTokens,
            AppRegistryStore apps,
            AppIdentityService identity,
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
                    new ErrorResponse("introspection_unauthorized", "App service token is missing or invalid."),
                    statusCode: StatusCodes.Status401Unauthorized);
            }

            if (await apps.GetAppAsync(appId, cancellationToken) is null)
            {
                return CoreJson.Json(
                    new ErrorResponse("app_not_found", "Runtime app was not found."),
                    statusCode: StatusCodes.Status404NotFound);
            }

            // A missing token is a malformed request, not an inactive credential: answering
            // `active: false` would let a broken caller believe it had checked something.
            if (string.IsNullOrWhiteSpace(input?.Token))
            {
                return CoreJson.Json(
                    new ErrorResponse("token_required", "The credential to introspect is missing."),
                    statusCode: StatusCodes.Status400BadRequest);
            }

            var tool = NormalizeTool(input.Tool);
            var state = await users.ReadAsync(cancellationToken);
            var match = ScopedCredentials.Resolve(state, input.Token, clock.UtcNow, lifetimes, appId);
            if (match is null)
            {
                await WriteAuditAsync(audit, clock, "refused", appId, tool, actorUserId: null, cancellationToken);
                return Inactive();
            }

            // Access is re-checked here, not assumed from issuance. A credential outlives the state
            // it was minted against — an assignment is removed, a role is downgraded, an app becomes
            // a system app — and this is where that catches up with it. Reusing the identity flows'
            // own gate rather than restating its rules keeps there from being a second copy, which is
            // the copy that would go stale unnoticed.
            try
            {
                await identity.RequireAccessibleUserAsync(appId, match.User.Id, cancellationToken);
            }
            catch (AppIdentityException)
            {
                await WriteAuditAsync(audit, clock, "refused", appId, tool, match.User.Id, cancellationToken);
                return Inactive();
            }

            // Authenticated use, so the idle window slides exactly as it does on a session — without
            // this, a credential used through an app every day would still idle out as unused.
            await CoreSessionAuthorization.TouchSessionAsync(users, match.Record, clock.UtcNow, cancellationToken);

            // Introspection is where an external client's action becomes visible to Hosty audit: the
            // call never reaches Core otherwise. A named tool is an action and is recorded; a
            // protocol round trip that names none (`initialize`, `tools/list`) is not, or the log
            // would fill with handshakes and bury the actions among them.
            if (tool is not null)
            {
                await WriteAuditAsync(audit, clock, "succeeded", appId, tool, match.User.Id, cancellationToken);
            }

            return CoreJson.Json(new TokenIntrospectionResponse(
                Active: true,
                Sub: match.User.Id,
                Role: match.User.Role,
                Scopes: match.Record.Scopes ?? []));
        });
    }

    // One shape for every refusal — unknown, revoked, idled out, another app's, or a user who lost
    // access. An app that could tell these apart could probe for which credentials exist.
    private static IResult Inactive()
        => CoreJson.Json(new TokenIntrospectionResponse(Active: false, Sub: null, Role: null, Scopes: []));

    // App-supplied display text on its way into a durable log: bounded and stripped of control
    // characters, the same treatment every other untrusted label gets before it is stored.
    private static string? NormalizeTool(string? tool)
    {
        if (string.IsNullOrWhiteSpace(tool))
        {
            return null;
        }

        var cleaned = new string(tool.Trim().Where(character => !char.IsControl(character)).ToArray());
        return cleaned.Length == 0 ? null : cleaned[..Math.Min(cleaned.Length, 120)];
    }

    private static Task WriteAuditAsync(
        AuditStore audit,
        IClock clock,
        string outcome,
        string appId,
        string? tool,
        string? actorUserId,
        CancellationToken cancellationToken)
    {
        var details = new Dictionary<string, string>(StringComparer.Ordinal) { ["audience"] = appId };
        if (tool is not null)
        {
            details["tool"] = tool;
        }

        return audit.AppendAsync(
            new AuditRecord(
                Id: $"audit_{Guid.NewGuid():N}",
                Action: "auth.credential.used",
                ResourceType: "auth.credential",
                // No fingerprint on a refusal: the value presented was not a credential of this
                // app's, so hashing it would write an identifier for something that may not exist —
                // or, worse, for a live credential belonging to someone else.
                ResourceId: null,
                Outcome: outcome,
                ActorUserId: actorUserId,
                CreatedAt: clock.UtcNow,
                Details: details),
            cancellationToken);
    }
}

internal sealed record TokenIntrospectionRequest(string? Token, string? Tool = null);

// Deliberately close to RFC 7662's shape: `active` first and sufficient on its own, everything else
// present only when it is true. A caller that reads nothing but `active` is not thereby insecure.
internal sealed record TokenIntrospectionResponse(
    bool Active,
    string? Sub,
    string? Role,
    IReadOnlyList<string> Scopes);

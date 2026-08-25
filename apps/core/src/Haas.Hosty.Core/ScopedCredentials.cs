namespace Haas.Hosty.Core;

// Resolution for scoped access tokens (docs/features/scoped-access-tokens/feature.md).
//
// Two surfaces consult this and nothing else does: Core MCP, which accepts a bearer scoped to
// `hosty:core`, and the introspection endpoint, through which an app validates a bearer scoped to
// itself.
// Both ask the same question — "is this token live, for *my* audience, and whose is it" — so it is
// answered once here rather than twice in their own shapes.
//
// Audience is matched by the caller passing the audience it *is*, never by reading one out of the
// token and trusting it. That is what makes an app unable to accept a token minted for its
// neighbour, and it is enforced at the issuer rather than left to each verifier to remember — the
// convention-shaped hole the 2026-08-18 review recorded as H3 against `hosty_app_identity`.
internal static class ScopedCredentials
{
    /// <summary>
    /// The live scoped credential a bearer names for one audience, with the user it acts as.
    /// Null when the token names nothing, names an unscoped credential (those are Core sessions and
    /// are resolved by <see cref="CoreSessionAuthorization"/>), names one for another audience, names
    /// one that is revoked or idled out, or acts as a user who is gone or disabled.
    /// </summary>
    public static ScopedCredentialMatch? Resolve(
        UserDirectoryState state,
        string? token,
        DateTimeOffset now,
        AuthLifetimes lifetimes,
        string audience)
    {
        if (string.IsNullOrWhiteSpace(token) || string.IsNullOrWhiteSpace(audience))
        {
            return null;
        }

        var record = state.Sessions.FirstOrDefault(candidate =>
            string.Equals(candidate.Id, token, StringComparison.Ordinal) &&
            // Only an access token is ever scoped. A browser session with an audience cannot exist,
            // and were one ever written by a future path, this refuses it rather than honoring it.
            AccessTokenKinds.IsAccessToken(candidate.Kind) &&
            string.Equals(candidate.Audience, audience, StringComparison.Ordinal) &&
            CoreSessionAuthorization.IsSessionLive(candidate, now, lifetimes.IdleFor(candidate.Kind)));
        if (record is null)
        {
            return null;
        }

        // Re-read the user on every call rather than trusting what the credential was minted with:
        // role and disabled state change under a long-lived token, and this is the moment that
        // change takes effect. Same principle the session path and the identity flows follow.
        var user = state.Users.FirstOrDefault(candidate =>
            string.Equals(candidate.Id, record.UserId, StringComparison.Ordinal));
        return user is null || user.Disabled ? null : new ScopedCredentialMatch(record, user);
    }
}

internal sealed record ScopedCredentialMatch(AuthSessionRecord Record, HostUserRecord User);

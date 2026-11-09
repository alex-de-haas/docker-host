namespace Haas.Hosty.Core;

internal sealed partial class UserConnectionService
{
    // Bind an attempt to the selected credential revision, never to a caller-supplied account.
    // The pending record contains no copy of the credential it may eventually replace.
    private sealed record RenewalTarget(string ConnectionId, string Provider, string AccountId, string Revision);

    private static RenewalTarget? RenewalFor(UserDirectoryState state, string userId, string? id, string provider)
    {
        if (id is null) return null;
        var current = RequireConnection(state, userId, id);
        if (current.Provider != provider)
            throw new UserConnectionException("connection_provider_mismatch", "Renew this connection with the same provider. Add a separate connection for another provider.", 409);
        return new(current.Id, current.Provider, current.AccountId, current.Revision);
    }

    private static UserProviderConnection RequireRenewal(UserDirectoryState state, string userId, RenewalTarget target)
    {
        var current = RequireConnection(state, userId, target.ConnectionId);
        if (current.Revision != target.Revision || current.Provider != target.Provider || current.AccountId != target.AccountId)
            throw new UserConnectionException("connection_changed", "The connection changed during renewal. Cancel this attempt and start again.", 409);
        return current;
    }

    private void RequireNoPendingRenewal(string userId, RenewalTarget? target)
    {
        if (target is not null && pending.Values.Any(p => p.UserId == userId && p.Renewal?.ConnectionId == target.ConnectionId))
            throw new UserConnectionException("connection_attempt_pending", "Finish or cancel this connection's existing renewal first.", 409);
    }

    private Task<UserProviderConnection> SaveAuthorizedAsync(string userId, UserConnectionInput input, ProviderIdentity identity,
        string method, ProviderToken token, string? clientId, RenewalTarget? renewal, string? sessionId, CancellationToken ct)
        => users.UpdateAsync(state =>
        {
            RequireUser(state, userId);
            if (sessionId is not null) RequireSession(state, userId, sessionId);
            if (renewal is null)
            {
                var added = NewConnection(userId, input, identity, method, token, clientId);
                return (Add(state, added), added);
            }
            var current = RequireRenewal(state, userId, renewal);
            if (identity.Id != current.AccountId)
                throw new UserConnectionException("provider_account_changed", "Reconnect the same provider account. Add a separate connection to use another account.", 409);
            if (method == "oauth" && current.Provider == "github" && token.GrantedScopes is { } granted)
            {
                var requirePrivate = input.PrivateRepositories == true || current.GrantedScopes?.Contains("repo", StringComparer.Ordinal) == true;
                var hasRepo = granted.Contains("repo", StringComparer.Ordinal);
                if (!granted.Contains("workflow", StringComparer.Ordinal) ||
                    (requirePrivate ? !hasRepo : !hasRepo && !granted.Contains("public_repo", StringComparer.Ordinal)))
                    throw new UserConnectionException("connection_scope_insufficient",
                        "The renewed GitHub authorization is missing required permissions. Grant workflow and " +
                        (requirePrivate ? "repo" : "repo or public_repo") + " before renewing this connection.", 409);
            }
            // Stable ID, provider/account identity, label and creation time retain every existing
            // source/publication binding. Only the newly verified credential and status change.
            var next = current with { AccountName = identity.Name, Method = method, AccessToken = token.AccessToken,
                RefreshToken = token.RefreshToken, ExpiresAt = token.ExpiresAt, ClientId = clientId, GrantedScopes = token.GrantedScopes,
                CheckedAt = clock.UtcNow, Status = "connected", Revision = Guid.NewGuid().ToString("N") };
            return (Replace(state, next), next);
        }, ct);
}

namespace Haas.Hosty.Core;

// Synchronous hosted-service startup: incomplete revocation must be recovered before HTTP serves.
internal sealed class OAuthRevocationRecovery(
    OAuthStore oauth, UserDirectoryStore users, CoreEventHub events, IClock clock) : IHostedService
{
    public async Task StartAsync(CancellationToken cancellationToken)
    {
        var state = await oauth.ReadAsync(cancellationToken);
        var deleted = state.Clients.Where(client => client.DeletedAt is not null).Select(client => client.ClientId).ToHashSet(StringComparer.Ordinal);
        foreach (var grant in state.Grants.Where(grant => grant.RevokedAt is not null || deleted.Contains(grant.ClientId)))
            await OAuthEndpoints.RevokeIssuedAccessTokensAsync(grant.Id, users, events, clock.UtcNow, cancellationToken);
    }

    public Task StopAsync(CancellationToken cancellationToken) => Task.CompletedTask;
}

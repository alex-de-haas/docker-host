using System.Security.Cryptography;
using System.Text;

namespace Haas.Hosty.Core;

// The durable half of the OAuth authorization server (docs/features/mcp-oauth/plan.md): registered
// clients and the grants (refresh-token chains) issued to them.
//
// Access tokens do NOT live here. They are ordinary scoped access tokens on the session record,
// exactly what the manual path mints — OAuth replaces issuance only, nothing downstream of it. What
// is durable here is what has no other home: who a client_id is, and the long-lived revocable
// credential a client holds between sessions.
//
// Refresh tokens are stored as SHA-256 hashes, the way invitation tokens already are: the document
// is owner-only, but a bearer value that never needs to be read back has no business being readable.
internal sealed class OAuthStore(CoreDataPaths paths, IClock clock)
{
    // Serialized like every auth-critical store: concurrent read-modify-writes race last-writer-wins
    // and silently drop each other's record — a rotation racing a revocation must not resurrect the
    // chain it lost to.
    private readonly SemaphoreSlim gate = new(1, 1);

    private string StatePath => Path.Combine(paths.AuthRoot, "oauth.json");

    public async Task<OAuthState> ReadAsync(CancellationToken cancellationToken = default)
    {
        var state = await JsonStorage.ReadAsync<OAuthState>(StatePath, cancellationToken);
        return state is null
            ? new OAuthState(1, [], [])
            : state with { Clients = state.Clients ?? [], Grants = state.Grants ?? [] };
    }

    public async Task<T> UpdateAsync<T>(
        Func<OAuthState, (OAuthState State, T Result)> mutate,
        CancellationToken cancellationToken = default)
    {
        await gate.WaitAsync(cancellationToken);
        try
        {
            var current = await ReadAsync(cancellationToken);
            var (next, result) = mutate(current);
            await JsonStorage.WriteAsync(StatePath, next, restrictToOwner: true, cancellationToken);
            return result;
        }
        finally
        {
            gate.Release();
        }
    }

    /// <summary>A grant is live while it is unrevoked and inside its absolute window.</summary>
    public static bool IsGrantLive(OAuthGrantRecord grant, DateTimeOffset now)
        => grant.RevokedAt is null && grant.ExpiresAt > now;

    /// <summary>The stored form of a refresh token. One-way on purpose.</summary>
    public static string HashRefreshToken(string token)
        => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(token))).ToLowerInvariant();

    public DateTimeOffset Now => clock.UtcNow;
}

internal sealed record OAuthState(
    int SchemaVersion,
    IReadOnlyList<OAuthClientRecord> Clients,
    IReadOnlyList<OAuthGrantRecord> Grants);

// One registered OAuth client (RFC 7591). Public clients only — no secret is issued or stored,
// because the clients this exists for (Claude Code, editors) cannot keep one; PKCE is what binds a
// code to the client that requested it.
internal sealed record OAuthClientRecord(
    string ClientId,
    string Name,
    IReadOnlyList<string> RedirectUris,
    DateTimeOffset CreatedAt,
    // The registrar's remote address, kept so an operator reviewing the client list can tell a
    // registration they recognize from one they do not.
    string? SourceAddress = null);

// One grant: a refresh-token chain for (client, user, audience, scopes). Rotation replaces the
// hash and bumps RotatedAt; the record — and so the grant's identity — survives, which is what lets
// the credential page list and revoke it as one thing.
internal sealed record OAuthGrantRecord(
    string Id,
    string ClientId,
    string UserId,
    string Audience,
    IReadOnlyList<string> Scopes,
    string RefreshTokenHash,
    DateTimeOffset CreatedAt,
    DateTimeOffset ExpiresAt,
    DateTimeOffset? RotatedAt = null,
    DateTimeOffset? RevokedAt = null);

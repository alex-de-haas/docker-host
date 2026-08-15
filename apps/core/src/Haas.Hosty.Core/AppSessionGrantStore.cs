namespace Haas.Hosty.Core;

// Server-side store of app session grants: the opaque browser app token is never persisted, only its
// hash. This replaces the previous stateless signed JWT so app sessions gain instant server-side
// revocation, idle + absolute expiry, and an explicit-logout cascade — while apps still hold a single
// HttpOnly cookie. See docs/features/auth-session-lifecycle/feature.md.
internal sealed class AppSessionGrantStore(CoreDataPaths paths)
{
    // Revoked grants are kept briefly so revocation is observable in diagnostics before pruning removes
    // them; absolutely-expired grants are dropped as soon as they are seen on a write.
    private static readonly TimeSpan RevokedRetention = TimeSpan.FromDays(7);

    private readonly SemaphoreSlim mutex = new(1, 1);

    private string StatePath => Path.Combine(paths.AuthRoot, "app-grants.json");

    public async Task<AppSessionGrantState> ReadAsync(CancellationToken cancellationToken = default)
        => await JsonStorage.ReadAsync<AppSessionGrantState>(StatePath, cancellationToken) ??
            new AppSessionGrantState(1, []);

    public async Task AppendAsync(AppSessionGrantRecord record, DateTimeOffset now, CancellationToken cancellationToken = default)
    {
        await mutex.WaitAsync(cancellationToken);
        try
        {
            var state = await ReadAsync(cancellationToken);
            var next = Prune(state.Grants, now).Append(record).ToArray();
            await JsonStorage.WriteAsync(StatePath, state with { Grants = next }, restrictToOwner: true, cancellationToken);
        }
        finally
        {
            mutex.Release();
        }
    }

    // Read-only resolution by token hash. Returns the stored grant regardless of validity so the caller
    // can distinguish revoked / absolutely-expired / idle-expired and map each to the right status.
    public async Task<AppSessionGrantRecord?> TryResolveAsync(string tokenHash, CancellationToken cancellationToken = default)
    {
        var state = await ReadAsync(cancellationToken);
        return state.Grants.FirstOrDefault(candidate => string.Equals(candidate.TokenHash, tokenHash, StringComparison.Ordinal));
    }

    // Slides the idle window by advancing LastSeenAt, throttled so a per-request revalidate does not
    // rewrite the JSON store on every call. A no-op for a missing, revoked, or absolutely-expired grant.
    public async Task TouchAsync(string tokenHash, DateTimeOffset now, TimeSpan throttle, CancellationToken cancellationToken = default)
    {
        await mutex.WaitAsync(cancellationToken);
        try
        {
            var state = await ReadAsync(cancellationToken);
            var match = state.Grants.FirstOrDefault(candidate => string.Equals(candidate.TokenHash, tokenHash, StringComparison.Ordinal));
            if (match is null || match.RevokedAt is not null || match.AbsoluteExpiresAt <= now || now - match.LastSeenAt < throttle)
            {
                return;
            }

            var touched = match with { LastSeenAt = now };
            var next = Prune(state.Grants, now)
                .Select(candidate => string.Equals(candidate.TokenHash, tokenHash, StringComparison.Ordinal) ? touched : candidate)
                .ToArray();
            await JsonStorage.WriteAsync(StatePath, state with { Grants = next }, restrictToOwner: true, cancellationToken);
        }
        finally
        {
            mutex.Release();
        }
    }

    // Logout cascade: revoke every live grant authorized by the Core session being logged out. Grant
    // validity is otherwise independent of Core session liveness (a grant outlives an expired session),
    // so this fires only on an explicit logout — the user's intent to leave.
    public async Task RevokeByAuthorizingSessionAsync(string authorizingSessionId, DateTimeOffset now, CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrEmpty(authorizingSessionId))
        {
            return;
        }

        await mutex.WaitAsync(cancellationToken);
        try
        {
            var state = await ReadAsync(cancellationToken);
            var changed = false;
            var next = Prune(state.Grants, now)
                .Select(candidate =>
                {
                    if (candidate.RevokedAt is null &&
                        string.Equals(candidate.AuthorizingSessionId, authorizingSessionId, StringComparison.Ordinal))
                    {
                        changed = true;
                        return candidate with { RevokedAt = now };
                    }

                    return candidate;
                })
                .ToArray();

            if (changed || next.Length != state.Grants.Count)
            {
                await JsonStorage.WriteAsync(StatePath, state with { Grants = next }, restrictToOwner: true, cancellationToken);
            }
        }
        finally
        {
            mutex.Release();
        }
    }

    private static IEnumerable<AppSessionGrantRecord> Prune(IEnumerable<AppSessionGrantRecord> grants, DateTimeOffset now)
        => grants.Where(grant =>
            grant.AbsoluteExpiresAt > now &&
            (grant.RevokedAt is null || now - grant.RevokedAt.Value < RevokedRetention));
}

internal sealed record AppSessionGrantState(int SchemaVersion, IReadOnlyList<AppSessionGrantRecord> Grants);

internal sealed record AppSessionGrantRecord(
    string Id,
    string AppId,
    string UserId,
    string TokenHash,
    string IssuedVia,
    DateTimeOffset CreatedAt,
    DateTimeOffset LastSeenAt,
    DateTimeOffset AbsoluteExpiresAt,
    DateTimeOffset? RevokedAt,
    string? AuthorizingSessionId);

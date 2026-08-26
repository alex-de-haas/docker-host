namespace Haas.Hosty.Core;

internal sealed class UserDirectoryStore(CoreDataPaths paths)
{
    // This store is auth-critical (sessions, users, invitations, assignments) and every caller does a
    // whole-document read-modify-write. Without serialization two concurrent writers race last-writer-
    // wins and silently drop each other's record — e.g. two logins racing loses a session (the holder
    // gets 401s), or login racing invitation-accept drops the new user. All writes go through this gate.
    private readonly SemaphoreSlim gate = new(1, 1);

    // Session resolution reads this store on every authenticated request, so reads must not cost a
    // disk parse. The cache is safe because every write goes through the gate above and replaces it
    // with the state it just persisted; revocation therefore lands in the cache in the same call that
    // lands it on disk. The file stamp covers the one writer the gate cannot see — an operator editing
    // state.json out of band — by turning a stamp mismatch into a plain re-read. A racing read may
    // briefly publish a fresh state under a stale stamp; the only consequence is one redundant re-read.
    private volatile CachedState? cache;

    private sealed record CachedState(UserDirectoryState State, FileStamp Stamp);

    private string StatePath => Path.Combine(paths.AuthRoot, "state.json");

    // Callers treat the collections as non-null (their declarations say so), but that contract does not
    // survive deserialization: the null fallback only covers a *missing* file, so a document that does
    // exist without a `users` or `sessions` key deserializes those to null anyway. Normalizing once here
    // keeps every call site — login, disable, purge — from having to guard, and turns a partial state.json
    // into an empty directory rather than a 500. Nothing downstream distinguishes null from empty.
    // PasswordCredentials stays as-is: it is declared nullable, so its consumers already handle null.
    private static UserDirectoryState Normalize(UserDirectoryState? state)
        => state is null
            ? new UserDirectoryState(1, [], [], [], [])
            : state with
            {
                Users = state.Users ?? [],
                Invitations = state.Invitations ?? [],
                Assignments = state.Assignments ?? [],
                Sessions = state.Sessions ?? [],
            };

    public async Task<UserDirectoryState> ReadAsync(CancellationToken cancellationToken = default)
    {
        var stamp = FileStamp.Read(StatePath);
        var cached = cache;
        if (cached is not null && cached.Stamp == stamp)
        {
            return cached.State;
        }

        var state = Normalize(await JsonStorage.ReadAsync<UserDirectoryState>(StatePath, cancellationToken));
        cache = new CachedState(state, stamp);
        return state;
    }

    public async Task WriteAsync(UserDirectoryState state, CancellationToken cancellationToken = default)
    {
        await gate.WaitAsync(cancellationToken);
        try
        {
            await WriteLockedAsync(state, cancellationToken);
        }
        finally
        {
            gate.Release();
        }
    }

    private async Task WriteLockedAsync(UserDirectoryState state, CancellationToken cancellationToken)
    {
        await JsonStorage.WriteAsync(StatePath, state, restrictToOwner: true, cancellationToken);
        cache = new CachedState(Normalize(state), FileStamp.Read(StatePath));
    }

    // Atomic read-modify-write. The mutator runs under an exclusive lock against the freshest on-disk
    // state; it may throw (validation) to abort the write, and returns the next state plus a caller value
    // (e.g. the created record) so post-commit work — audit, summaries — runs after the lock is released.
    public async Task<T> UpdateAsync<T>(
        Func<UserDirectoryState, (UserDirectoryState State, T Result)> mutate,
        CancellationToken cancellationToken = default)
    {
        await gate.WaitAsync(cancellationToken);
        try
        {
            var current = await ReadAsync(cancellationToken);
            var (next, result) = mutate(current);
            await WriteLockedAsync(next, cancellationToken);
            return result;
        }
        finally
        {
            gate.Release();
        }
    }

    public Task UpdateAsync(
        Func<UserDirectoryState, UserDirectoryState> mutate,
        CancellationToken cancellationToken = default)
        => UpdateAsync<object?>(state => (mutate(state), null), cancellationToken);
}

internal sealed record UserDirectoryState(
    int SchemaVersion,
    IReadOnlyList<HostUserRecord> Users,
    IReadOnlyList<HostInvitationRecord> Invitations,
    IReadOnlyList<AppAssignmentRecord> Assignments,
    IReadOnlyList<AuthSessionRecord> Sessions,
    IReadOnlyList<LocalPasswordCredentialRecord>? PasswordCredentials = null);

internal sealed record HostUserRecord(
    string Id,
    string? Email,
    string? DisplayName,
    string Role,
    bool Disabled,
    DateTimeOffset CreatedAt,
    DateTimeOffset UpdatedAt);

internal sealed record HostInvitationRecord(
    string Id,
    string Email,
    string Role,
    string Status,
    DateTimeOffset ExpiresAt,
    DateTimeOffset CreatedAt,
    string? DisplayName = null,
    IReadOnlyList<string>? AssignedAppIds = null,
    string? TokenHash = null,
    string? CreatedByUserId = null,
    DateTimeOffset? UsedAt = null,
    DateTimeOffset? RevokedAt = null);

internal sealed record AppAssignmentRecord(string AppId, string UserId, DateTimeOffset CreatedAt);

internal sealed record AuthSessionRecord(
    string Id,
    string UserId,
    DateTimeOffset CreatedAt,
    DateTimeOffset ExpiresAt,
    DateTimeOffset? RevokedAt,
    // Last authenticated use, advanced (throttled) on session resolution to slide the idle window.
    // ExpiresAt is the absolute cap; a session is valid only while both windows hold. Null on records
    // written before sliding shipped — treated as CreatedAt.
    DateTimeOffset? LastSeenAt = null,
    // What kind of credential points at this record. Null is a browser session — which is every record
    // written before access tokens shipped, so old state loads unchanged and keeps behaving as before.
    // Non-null values come from AccessTokenKinds and select an idle-only lifetime (see AuthLifetimes).
    string? Kind = null,
    // Operator-supplied name, shown in the credential list so a lost device can be recognized and
    // revoked. Browser sessions have none.
    string? Label = null,
    // What this credential may be presented to: a single app id, or `hosty:core`. Null is the credential
    // this feature did not change — a browser session or a full-role access token, which is every
    // record written before scopes shipped.
    //
    // Non-null makes the record a *scoped* credential, and the rule that gives that word meaning is
    // in CoreSessionAuthorization: a record with an audience is refused as a Core session outright.
    // One audience per credential, never a list: a bearer is handed to the party it addresses, so a
    // credential valid at two audiences lets the first replay it against the second.
    string? Audience = null,
    // What the credential may do at that audience (AccessTokenScopes). Null/empty on an unscoped
    // record; an audience without scopes cannot be issued, because it could do nothing anyway.
    IReadOnlyList<string>? Scopes = null,
    // The OAuth grant (refresh-token chain) this access token descends from, so revoking the grant
    // finds and revokes every access token it issued. Null on everything the OAuth path did not mint.
    string? GrantId = null);

internal sealed record LocalPasswordCredentialRecord(
    string UserId,
    string Algorithm,
    int Iterations,
    string Salt,
    string Hash,
    DateTimeOffset CreatedAt,
    DateTimeOffset UpdatedAt);

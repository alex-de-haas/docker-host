namespace Haas.Hosty.Core;

internal sealed class UserDirectoryStore(CoreDataPaths paths)
{
    // This store is auth-critical (sessions, users, invitations, assignments) and every caller does a
    // whole-document read-modify-write. Without serialization two concurrent writers race last-writer-
    // wins and silently drop each other's record — e.g. two logins racing loses a session (the holder
    // gets 401s), or login racing invitation-accept drops the new user. UpdateAsync closes that window.
    private readonly SemaphoreSlim gate = new(1, 1);

    private string StatePath => Path.Combine(paths.AuthRoot, "state.json");

    public async Task<UserDirectoryState> ReadAsync(CancellationToken cancellationToken = default)
        => await JsonStorage.ReadAsync<UserDirectoryState>(StatePath, cancellationToken) ??
            new UserDirectoryState(1, [], [], [], []);

    public async Task WriteAsync(UserDirectoryState state, CancellationToken cancellationToken = default)
        => await JsonStorage.WriteAsync(StatePath, state, restrictToOwner: true, cancellationToken);

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
            await WriteAsync(next, cancellationToken);
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
    DateTimeOffset? RevokedAt);

internal sealed record LocalPasswordCredentialRecord(
    string UserId,
    string Algorithm,
    int Iterations,
    string Salt,
    string Hash,
    DateTimeOffset CreatedAt,
    DateTimeOffset UpdatedAt);

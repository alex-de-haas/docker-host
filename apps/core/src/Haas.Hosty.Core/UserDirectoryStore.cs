namespace Haas.Hosty.Core;

internal sealed class UserDirectoryStore(CoreDataPaths paths)
{
    private string StatePath => Path.Combine(paths.AuthRoot, "state.json");

    public async Task<UserDirectoryState> ReadAsync(CancellationToken cancellationToken = default)
        => await JsonStorage.ReadAsync<UserDirectoryState>(StatePath, cancellationToken) ??
            new UserDirectoryState(1, [], [], [], []);

    public async Task WriteAsync(UserDirectoryState state, CancellationToken cancellationToken = default)
        => await JsonStorage.WriteAsync(StatePath, state, cancellationToken);
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

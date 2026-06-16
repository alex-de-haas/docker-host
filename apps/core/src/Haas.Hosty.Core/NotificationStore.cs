namespace Haas.Hosty.Core;

// Persisted notification inbox. A single JSON document at <core-root>/notifications/notifications.json
// (mirrors UserDirectoryStore). Read-modify-write is serialized through a gate so concurrent
// publishes / mark-read / retention passes cannot lose updates. Read-only queries use ReadAsync
// without the gate — eventual consistency is acceptable for an inbox.
internal sealed class NotificationStore(CoreDataPaths paths)
{
    private readonly SemaphoreSlim _gate = new(1, 1);

    private string StatePath => Path.Combine(paths.CoreRoot, "notifications", "notifications.json");

    public async Task<NotificationState> ReadAsync(CancellationToken cancellationToken = default)
        => await JsonStorage.ReadAsync<NotificationState>(StatePath, cancellationToken) ?? NotificationState.Empty;

    public async Task<TResult> UpdateAsync<TResult>(
        Func<NotificationState, (NotificationState State, TResult Result)> update,
        CancellationToken cancellationToken = default)
    {
        await _gate.WaitAsync(cancellationToken);
        try
        {
            var current = await JsonStorage.ReadAsync<NotificationState>(StatePath, cancellationToken) ?? NotificationState.Empty;
            var (next, result) = update(current);
            if (!ReferenceEquals(next, current))
            {
                await JsonStorage.WriteAsync(StatePath, next, restrictToOwner: true, cancellationToken);
            }

            return result;
        }
        finally
        {
            _gate.Release();
        }
    }
}

internal sealed record NotificationState(int SchemaVersion, IReadOnlyList<NotificationRecord> Notifications)
{
    public static readonly NotificationState Empty = new(1, []);
}

internal sealed record NotificationRecord(
    string Id,
    string RecipientUserId,
    NotificationSource Source,
    string Audience,
    string Level,
    string Title,
    string? Body,
    string? Link,
    string? DedupeKey,
    DateTimeOffset CreatedAt,
    DateTimeOffset? ReadAt);

// Kind = "app" (AppId set) | "core" (AppId null).
internal sealed record NotificationSource(string Kind, string? AppId);

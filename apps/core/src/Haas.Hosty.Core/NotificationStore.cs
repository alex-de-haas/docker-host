namespace Haas.Hosty.Core;

// Persisted notification inbox. A single JSON document at <core-root>/notifications/notifications.json
// (mirrors UserDirectoryStore). Read-modify-write is serialized through a gate so concurrent
// publishes / mark-read / retention passes cannot lose updates. Read-only queries use ReadAsync
// without the gate — eventual consistency is acceptable for an inbox.
internal sealed class NotificationStore(CoreDataPaths paths)
{
    private readonly SemaphoreSlim _gate = new(1, 1);

    // Every inbox query deserialized this document from disk. The bell is polled by each open Shell
    // client, so that was a recurring parse for a document that only this store writes. Cached like
    // the other single-writer stores: writes replace it, and the file stamp catches an out-of-band
    // edit by turning a mismatch into a plain re-read.
    private volatile CachedState? _cache;

    private sealed record CachedState(NotificationState State, FileStamp Stamp);

    private string StatePath => Path.Combine(paths.CoreRoot, "notifications", "notifications.json");

    public async Task<NotificationState> ReadAsync(CancellationToken cancellationToken = default)
    {
        var stamp = FileStamp.Read(StatePath);
        var cached = _cache;
        if (cached is not null && cached.Stamp == stamp)
        {
            return cached.State;
        }

        var state = await JsonStorage.ReadAsync<NotificationState>(StatePath, cancellationToken) ?? NotificationState.Empty;
        _cache = new CachedState(state, stamp);
        return state;
    }

    public async Task<TResult> UpdateAsync<TResult>(
        Func<NotificationState, (NotificationState State, TResult Result)> update,
        CancellationToken cancellationToken = default)
    {
        await _gate.WaitAsync(cancellationToken);
        try
        {
            var current = await ReadAsync(cancellationToken);
            var (next, result) = update(current);
            if (!ReferenceEquals(next, current))
            {
                await JsonStorage.WriteAsync(StatePath, next, restrictToOwner: true, cancellationToken);
                _cache = new CachedState(next, FileStamp.Read(StatePath));
            }

            return result;
        }
        finally
        {
            _gate.Release();
        }
    }
}

internal sealed record NotificationState(int SchemaVersion, IReadOnlyList<NotificationRecord>? Notifications)
{
    // Guard against a persisted file that omits the property: a positional non-null record property
    // would otherwise deserialize as null and NRE on the first query/update.
    public IReadOnlyList<NotificationRecord> Notifications { get; init; } = Notifications ?? [];

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

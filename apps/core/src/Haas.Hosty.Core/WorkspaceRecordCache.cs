namespace Haas.Hosty.Core;

// Parsed workspace records are reusable only while their native file identity and nanosecond
// mtime/ctime match. Each caller still validates ownership, membership and current grants.
// Missing files are checked anew without opening them; unsupported/special files retain
// JsonStorage's uncached behavior, including errors. Access errors never become missing records.
internal sealed class WorkspaceRecordCache(int capacity = 512, long byteLimit = 16 * 1024 * 1024)
{
    private sealed record Entry(DocumentFileStamp Stamp, object Value);
    private readonly SourceDocumentSnapshotCache entries = new(capacity, byteLimit);
    private readonly SemaphoreSlim[] gates = Enumerable.Range(0, 32).Select(_ => new SemaphoreSlim(1)).ToArray();
    private int reads, hits;
    internal (int Reads, int Hits, int Entries, long Bytes) Statistics
        => (Volatile.Read(ref reads), Volatile.Read(ref hits), entries.Statistics.Count, entries.Statistics.Bytes);

    internal async Task<T?> ReadAsync<T>(string path, CancellationToken ct) where T : class
    {
        ct.ThrowIfCancellationRequested();
        var gate = gates[(uint)StringComparer.Ordinal.GetHashCode(path) % gates.Length];
        await gate.WaitAsync(ct);
        try
        {
            var stamp = DocumentFileStamp.Read(path, out var missing);
            if (missing) return null;
            if (stamp is { Regular: true } before && entries.TryGet<Entry>(path, out var found)
                && found.Stamp == before && found.Value is T cached)
            {
                Interlocked.Increment(ref hits);
                return cached;
            }
            Interlocked.Increment(ref reads);
            var value = await JsonStorage.ReadAsync<T>(path, ct);
            if (value is not null && stamp is { Regular: true } current && current == DocumentFileStamp.Read(path))
                entries.Set(path, new Entry(current, value), checked(current.Size * 4 + 256));
            return value;
        }
        finally { gate.Release(); }
    }
}

namespace Haas.Hosty.Core;

// Immutable Git values only. Access decisions, target refs and mutable worktree bytes never enter
// this cache; the service resolves them again before consulting it on every request.
internal sealed class SourceDocumentSnapshotCache(int capacity = 1024, long byteLimit = 64 * 1024 * 1024)
{
    private sealed record Entry(object Value, long Size, LinkedListNode<string> Node);
    private readonly object gate = new();
    private readonly Dictionary<string, Entry> values = new(StringComparer.Ordinal);
    private readonly Dictionary<string, Task<object>> running = new(StringComparer.Ordinal);
    private readonly LinkedList<string> order = new();
    private long size;
    internal (int Count, long Bytes) Statistics { get { lock (gate) return (values.Count, size); } }

    internal bool TryGet<T>(string key, out T value)
    {
        lock (gate)
        {
            if (values.TryGetValue(key, out var found) && found.Value is T typed)
            {
                order.Remove(found.Node); order.AddLast(found.Node);
                value = typed; return true;
            }
        }
        value = default!; return false;
    }

    internal void Set<T>(string key, T value, long bytes) where T : notnull
    {
        var weight = checked(bytes + key.Length * 2L + 64);
        lock (gate)
        {
            if (values.Remove(key, out var previous)) { order.Remove(previous.Node); size -= previous.Size; }
            if (weight > byteLimit || capacity <= 0) return;
            while (values.Count >= capacity || size + weight > byteLimit)
            {
                var first = order.First!;
                size -= values[first.Value].Size; values.Remove(first.Value); order.RemoveFirst();
            }
            values[key] = new(value, weight, order.AddLast(key)); size += weight;
        }
    }

    internal async Task<T> GetAsync<T>(string key, Func<CancellationToken, Task<(T Value, long Size)>> create, CancellationToken ct) where T : notnull
    {
        if (TryGet<T>(key, out var cached)) return cached;
        Task<object> pending;
        lock (gate)
        {
            if (values.TryGetValue(key, out var found)) { order.Remove(found.Node); order.AddLast(found.Node); return (T)found.Value; }
            if (!running.TryGetValue(key, out pending!)) running[key] = pending = LoadAsync(key, create);
        }
        return (T)await pending.WaitAsync(ct);
    }

    private async Task<object> LoadAsync<T>(string key, Func<CancellationToken, Task<(T Value, long Size)>> create) where T : notnull
    {
        await Task.Yield();
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(30));
        try
        {
            var result = await create(deadline.Token);
            Set(key, result.Value, result.Size);
            return result.Value;
        }
        finally { lock (gate) running.Remove(key); }
    }
}

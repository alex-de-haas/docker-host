using System.Collections.Concurrent;
using System.Threading.Channels;

namespace Haas.Hosty.Core;

// Notifications invalidate snapshots; they never authorize source operations.
internal sealed class WorkspaceObservationState(CoreEventHub events, TimeSpan? retryDelay = null)
{
    internal sealed class Entry
    {
        public long Generation = 1;
        public long Observed;
        public long Scans;
        public long Documents;
        public long Publications;
        public long RetryAfter;
        public string Health = "starting";
    }
    private readonly ConcurrentDictionary<string, Entry> entries = new(StringComparer.Ordinal);
    internal readonly Channel<bool> Wake = Channel.CreateBounded<bool>(new BoundedChannelOptions(1) { FullMode = BoundedChannelFullMode.DropWrite });
    private long catalog = 1;
    internal long CatalogRevision => Interlocked.Read(ref catalog);
    internal IEnumerable<string> Dirty => entries.Where(p => CanObserve(p.Key) && p.Value.Health != "paused").Select(p => p.Key).ToArray();
    internal long ScanCount(string id) => entries.TryGetValue(id, out var entry) ? Interlocked.Read(ref entry.Scans) : 0;
    internal long Generation(string id) => Interlocked.Read(ref entries.GetOrAdd(id, _ => new()).Generation);
    internal long DocumentGeneration(string id) => Interlocked.Read(ref entries.GetOrAdd(id, _ => new()).Documents);
    internal void DocumentsChanged(string id) => Interlocked.Increment(ref entries.GetOrAdd(id, _ => new()).Documents);
    internal bool NeedsObservation(string id) => !entries.TryGetValue(id, out var e) || Interlocked.Read(ref e.Generation) != Interlocked.Read(ref e.Observed);
    internal bool CanObserve(string id) => NeedsObservation(id) && (!entries.TryGetValue(id, out var entry)
        || Environment.TickCount64 >= Interlocked.Read(ref entry.RetryAfter));
    internal string Health(string id) => entries.TryGetValue(id, out var e)
        ? e.Health == "watching" ? Interlocked.Read(ref e.RetryAfter) != 0 ? "recovering" : NeedsObservation(id) ? "pending" : "watching" : e.Health : "starting";
    internal void Invalidate(string id)
    {
        var entry = entries.GetOrAdd(id, _ => new());
        Interlocked.Exchange(ref entry.RetryAfter, 0);
        Interlocked.Increment(ref entry.Generation);
        Wake.Writer.TryWrite(true);
    }
    internal void Observed(string id, long generation)
    {
        var entry = entries.GetOrAdd(id, _ => new());
        Interlocked.Exchange(ref entry.RetryAfter, 0);
        Interlocked.Exchange(ref entry.Observed, generation);
        Interlocked.Increment(ref entry.Scans);
        events.PublishWorkspaceChange(id);
    }
    internal void ObservationFailed(string id)
    {
        var entry = entries.GetOrAdd(id, _ => new());
        // Keep failed scans dirty, including a fresh action on a previously clean generation.
        // The health timer retries failures; ordinary reads cannot create a scan/reload loop.
        Interlocked.Increment(ref entry.Generation);
        Interlocked.Exchange(ref entry.RetryAfter, Environment.TickCount64 + (long)(retryDelay ?? TimeSpan.FromSeconds(15)).TotalMilliseconds);
        Interlocked.Increment(ref entry.Scans);
        events.PublishWorkspaceChange(id);
    }
    internal void SetHealth(string id, string health)
    {
        var entry = entries.GetOrAdd(id, _ => new());
        if (Interlocked.Exchange(ref entry.Health, health) != health) events.PublishWorkspaceChange(id);
    }
    internal void RequestReconcile()
    {
        Interlocked.Increment(ref catalog);
        Wake.Writer.TryWrite(true);
    }
    internal void CatalogChanged(string id = "*")
    {
        RequestReconcile();
        events.PublishWorkspaceChange(id);
    }
    internal void Publish(string id) => events.PublishWorkspaceChange(id);
    internal long PublicationGeneration(string id) => Interlocked.Read(ref entries.GetOrAdd(id, _ => new()).Publications);
    internal void PublicationChanged(string id)
    {
        // Provider facts invalidate UI details without scheduling another source/Git scan.
        Interlocked.Increment(ref entries.GetOrAdd(id, _ => new()).Publications);
        events.PublishWorkspaceChange(id);
    }
    internal void Remove(string id)
    {
        entries.TryRemove(id, out _);
        CatalogChanged(id);
    }
}

using System.Collections.Concurrent;
using System.Threading.Channels;

namespace Haas.Hosty.Core;

// Notifications invalidate snapshots; they never authorize source operations.
internal sealed class WorkspaceObservationState(CoreEventHub events)
{
    internal sealed class Entry
    {
        public long Generation = 1;
        public long Observed;
        public long Scans;
        public string Health = "starting";
    }
    private readonly ConcurrentDictionary<string, Entry> entries = new(StringComparer.Ordinal);
    internal readonly Channel<bool> Wake = Channel.CreateBounded<bool>(new BoundedChannelOptions(1) { FullMode = BoundedChannelFullMode.DropWrite });
    private long catalog = 1;
    internal long CatalogRevision => Interlocked.Read(ref catalog);
    internal IEnumerable<string> Dirty => entries.Where(p => NeedsObservation(p.Key) && p.Value.Health != "paused").Select(p => p.Key).ToArray();
    internal long ScanCount(string id) => entries.TryGetValue(id, out var entry) ? Interlocked.Read(ref entry.Scans) : 0;
    internal long Generation(string id) => Interlocked.Read(ref entries.GetOrAdd(id, _ => new()).Generation);
    internal bool NeedsObservation(string id) => !entries.TryGetValue(id, out var e) || Interlocked.Read(ref e.Generation) != Interlocked.Read(ref e.Observed);
    internal string Health(string id) => entries.TryGetValue(id, out var e)
        ? e.Health == "watching" && NeedsObservation(id) ? "pending" : e.Health : "starting";
    internal void Invalidate(string id)
    {
        Interlocked.Increment(ref entries.GetOrAdd(id, _ => new()).Generation);
        Wake.Writer.TryWrite(true);
    }
    internal void Observed(string id, long generation)
    {
        var entry = entries.GetOrAdd(id, _ => new());
        Interlocked.Exchange(ref entry.Observed, generation);
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
    internal void Remove(string id)
    {
        entries.TryRemove(id, out _);
        CatalogChanged(id);
    }
}

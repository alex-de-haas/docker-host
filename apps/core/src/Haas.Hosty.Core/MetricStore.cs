using System.Text;

namespace Haas.Hosty.Core;

// A single recorded metric value at a point in time (epoch-millis so clients render a time axis
// without re-deriving it). A readonly struct keeps the rolling window compact.
internal readonly record struct MetricPoint(long TimestampUnixMs, double Value);

// Immutable snapshot of one metric series — its name, its label set, and the points that fell inside
// a query window. Returned by IMetricStore.Query; safe to hand to the JSON serializer.
internal sealed record MetricSeriesSnapshot(
    string Name,
    IReadOnlyDictionary<string, string> Labels,
    IReadOnlyList<MetricPoint> Points);

// Append-only, in-memory telemetry store backing observability v1. Holds a bounded rolling window of
// metric points per (app, series) so Core can answer range queries itself, with no external backend
// and no persistence — a Core restart drops the window, which is acceptable for a live metrics view
// (see docs/features/observability.md). The store is the seam the plan calls out: a later swap to a
// durable backing (e.g. Microsoft.Data.Sqlite) is a local IMetricStore implementation change only.
internal interface IMetricStore
{
    // Record one sample. Labels identify the series within the app (e.g. the metric's Prometheus
    // labels minus the app-attribution one, or {service=…} for Core-collected infra metrics). A null
    // or empty label set is the unlabelled series. Non-finite values (NaN/±Inf) are dropped.
    void Record(string appId, string name, IReadOnlyDictionary<string, string>? labels, double value, DateTimeOffset timestamp);

    // All series for an app holding at least one point at or after `since`, each trimmed to that
    // window. Empty when the app has no recorded telemetry.
    IReadOnlyList<MetricSeriesSnapshot> Query(string appId, DateTimeOffset since);

    // Drop everything recorded for an app — called when the app is removed so an uninstalled app's
    // series do not linger until the process restarts.
    void Remove(string appId);

    // Evict points older than the retention window across every series, dropping series and apps that
    // empty out. Called periodically by the scrape loop so series that stop emitting (transient
    // containers, dynamic labels) are reclaimed even though no further Record arrives to trim them.
    void Prune(DateTimeOffset now);
}

internal sealed class InMemoryMetricStore : IMetricStore
{
    // Rolling-window bounds. The window caps age; the per-series point cap caps memory even if a
    // producer scrapes faster than expected; the per-app series cap stops a misbehaving (or
    // high-cardinality) app from growing the store without limit. Generous but finite.
    private static readonly TimeSpan DefaultWindow = TimeSpan.FromHours(1);
    private const int MaxPointsPerSeries = 720;
    private const int MaxSeriesPerApp = 256;

    private readonly TimeSpan window;
    private readonly object gate = new();
    private readonly Dictionary<string, Dictionary<string, Series>> apps = new(StringComparer.Ordinal);

    public InMemoryMetricStore()
        : this(DefaultWindow)
    {
    }

    // Test seam: a shorter window keeps eviction assertions fast and deterministic.
    internal InMemoryMetricStore(TimeSpan window)
        => this.window = window > TimeSpan.Zero ? window : DefaultWindow;

    public void Record(string appId, string name, IReadOnlyDictionary<string, string>? labels, double value, DateTimeOffset timestamp)
    {
        if (string.IsNullOrWhiteSpace(appId) || string.IsNullOrWhiteSpace(name) || !double.IsFinite(value))
        {
            return;
        }

        var key = BuildSeriesKey(name, labels);
        var point = new MetricPoint(timestamp.ToUnixTimeMilliseconds(), value);
        var cutoff = timestamp - window;

        lock (gate)
        {
            if (!apps.TryGetValue(appId, out var series))
            {
                series = new Dictionary<string, Series>(StringComparer.Ordinal);
                apps[appId] = series;
            }

            if (!series.TryGetValue(key, out var existing))
            {
                if (series.Count >= MaxSeriesPerApp && !TryEvictColdestSeries(series))
                {
                    return;
                }

                existing = new Series(name, FreezeLabels(labels));
                series[key] = existing;
            }

            existing.Append(point, cutoff);
        }
    }

    public IReadOnlyList<MetricSeriesSnapshot> Query(string appId, DateTimeOffset since)
    {
        if (string.IsNullOrWhiteSpace(appId))
        {
            return [];
        }

        var sinceMs = since.ToUnixTimeMilliseconds();
        lock (gate)
        {
            if (!apps.TryGetValue(appId, out var series))
            {
                return [];
            }

            var snapshots = new List<MetricSeriesSnapshot>(series.Count);
            foreach (var entry in series.Values)
            {
                var points = entry.Snapshot(sinceMs);
                if (points.Count > 0)
                {
                    snapshots.Add(new MetricSeriesSnapshot(entry.Name, entry.Labels, points));
                }
            }

            return snapshots;
        }
    }

    public void Remove(string appId)
    {
        if (string.IsNullOrWhiteSpace(appId))
        {
            return;
        }

        lock (gate)
        {
            apps.Remove(appId);
        }
    }

    public void Prune(DateTimeOffset now)
    {
        var cutoffMs = (now - window).ToUnixTimeMilliseconds();
        lock (gate)
        {
            foreach (var appId in apps.Keys.ToArray())
            {
                var series = apps[appId];
                foreach (var key in series.Keys.ToArray())
                {
                    if (series[key].PruneOlderThan(cutoffMs))
                    {
                        series.Remove(key);
                    }
                }

                if (series.Count == 0)
                {
                    apps.Remove(appId);
                }
            }
        }
    }

    // Drops the series whose newest point is oldest, freeing a slot for a fresh series once an app
    // hits the cardinality cap. Returns false only when the app has no series to evict (never, here).
    private static bool TryEvictColdestSeries(Dictionary<string, Series> series)
    {
        string? coldestKey = null;
        var coldestAt = long.MaxValue;
        foreach (var entry in series)
        {
            var newest = entry.Value.NewestTimestampMs;
            if (newest < coldestAt)
            {
                coldestAt = newest;
                coldestKey = entry.Key;
            }
        }

        if (coldestKey is null)
        {
            return false;
        }

        series.Remove(coldestKey);
        return true;
    }

    // Canonical per-app series identity: the metric name plus its labels sorted by key, so the same
    // label set always maps to one series regardless of emission order. Each segment is length-prefixed
    // (`<len>:<value>`), a uniquely-decodable encoding — so the key is collision-free for ANY name or
    // label value, with no reliance on "impossible" separator characters.
    private static string BuildSeriesKey(string name, IReadOnlyDictionary<string, string>? labels)
    {
        var builder = new StringBuilder();
        AppendSegment(builder, name);
        if (labels is not null)
        {
            foreach (var label in labels.OrderBy(pair => pair.Key, StringComparer.Ordinal))
            {
                AppendSegment(builder, label.Key);
                AppendSegment(builder, label.Value);
            }
        }

        return builder.ToString();
    }

    private static void AppendSegment(StringBuilder builder, string value)
        => builder.Append(value.Length).Append(':').Append(value);

    private static IReadOnlyDictionary<string, string> FreezeLabels(IReadOnlyDictionary<string, string>? labels)
        => labels is null || labels.Count == 0
            ? EmptyLabels
            : new Dictionary<string, string>(labels, StringComparer.Ordinal);

    private static readonly IReadOnlyDictionary<string, string> EmptyLabels =
        new Dictionary<string, string>(StringComparer.Ordinal);

    // One series' rolling point buffer. Oldest→newest order; bounded by both age (cutoff) and count.
    // Not thread-safe on its own — the store holds `gate` for every access.
    private sealed class Series(string name, IReadOnlyDictionary<string, string> labels)
    {
        private readonly Queue<MetricPoint> points = new();

        public string Name { get; } = name;

        public IReadOnlyDictionary<string, string> Labels { get; } = labels;

        public long NewestTimestampMs { get; private set; } = long.MinValue;

        public void Append(MetricPoint point, DateTimeOffset cutoff)
        {
            points.Enqueue(point);
            if (point.TimestampUnixMs > NewestTimestampMs)
            {
                NewestTimestampMs = point.TimestampUnixMs;
            }

            var cutoffMs = cutoff.ToUnixTimeMilliseconds();
            while (points.Count > 0 && points.Peek().TimestampUnixMs < cutoffMs)
            {
                points.Dequeue();
            }

            while (points.Count > MaxPointsPerSeries)
            {
                points.Dequeue();
            }
        }

        public IReadOnlyList<MetricPoint> Snapshot(long sinceMs)
        {
            var result = new List<MetricPoint>();
            foreach (var point in points)
            {
                if (point.TimestampUnixMs >= sinceMs)
                {
                    result.Add(point);
                }
            }

            return result;
        }

        // Drops points older than the cutoff and reports whether the series is now empty (so the store
        // can reclaim it). The newest timestamp is left intact: it still ranks the series for the
        // coldest-series eviction even once all its points have aged out.
        public bool PruneOlderThan(long cutoffMs)
        {
            while (points.Count > 0 && points.Peek().TimestampUnixMs < cutoffMs)
            {
                points.Dequeue();
            }

            return points.Count == 0;
        }
    }
}

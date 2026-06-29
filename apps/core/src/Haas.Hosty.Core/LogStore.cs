namespace Haas.Hosty.Core;

// One structured OTLP log record held in the store and returned by the read API. Timestamp is
// epoch-millis (clients render a time axis without re-deriving it); SeverityNumber is the OTLP
// severity (1-24, 0 = unspecified) and SeverityText its textual level. TraceId/SpanId are the
// lowercase-hex correlation ids (null when the record is not trace-correlated). Attributes are the
// log record's own attributes, flattened to strings. This is a distinct stream from the console
// (`docker logs`) tail — never interleaved with it. See docs/features/observability.md.
internal sealed record OtlpLogRecord(
    long TimestampUnixMs,
    int SeverityNumber,
    string SeverityText,
    string Body,
    IReadOnlyDictionary<string, string> Attributes,
    string? TraceId,
    string? SpanId);

// Append-only, in-memory OTLP-logs store backing observability v1 (P4) — the logs analogue of
// IMetricStore. Holds a bounded rolling window of structured log records per app so Core can answer
// range/severity queries itself, with no external backend and no persistence (a Core restart drops
// the window, acceptable for a live logs view). The interface is the seam for a later durable swap.
internal interface ILogStore
{
    // Record one log line for an app. Records with a non-positive timestamp are dropped (the caller
    // substitutes the scrape clock for records the producer left unstamped).
    void Record(string appId, OtlpLogRecord record);

    // The app's records at or after `since`, optionally filtered to severity >= `minSeverity`, in
    // arrival (≈ chronological) order, capped to the most recent `limit`. Empty when the app has no
    // recorded logs.
    IReadOnlyList<OtlpLogRecord> Query(string appId, DateTimeOffset since, int? minSeverity, int limit);

    // Drop everything recorded for an app — called when the app is removed so an uninstalled app's
    // logs do not linger until the process restarts.
    void Remove(string appId);

    // Evict records older than the retention window across every app, dropping apps that empty out.
    void Prune(DateTimeOffset now);
}

internal sealed class InMemoryLogStore : ILogStore
{
    // Rolling-window bounds. The window caps age; the per-app record cap caps memory even if an app
    // logs in a tight loop. Generous but finite.
    private static readonly TimeSpan DefaultWindow = TimeSpan.FromHours(1);
    private const int MaxRecordsPerApp = 2000;

    private readonly TimeSpan window;
    private readonly object gate = new();
    private readonly Dictionary<string, LinkedList<OtlpLogRecord>> apps = new(StringComparer.Ordinal);

    public InMemoryLogStore()
        : this(DefaultWindow)
    {
    }

    // Test seam: a shorter window keeps eviction assertions fast and deterministic.
    internal InMemoryLogStore(TimeSpan window)
        => this.window = window > TimeSpan.Zero ? window : DefaultWindow;

    public void Record(string appId, OtlpLogRecord record)
    {
        if (string.IsNullOrWhiteSpace(appId) || record is null || record.TimestampUnixMs <= 0)
        {
            return;
        }

        lock (gate)
        {
            if (!apps.TryGetValue(appId, out var records))
            {
                records = new LinkedList<OtlpLogRecord>();
                apps[appId] = records;
            }

            records.AddLast(record);

            // Bound memory on write by count only. Age eviction is left to Prune, which runs each
            // scrape tick on the authoritative host clock — so a single record with a skewed future
            // timestamp cannot prematurely evict the app's in-window records here.
            while (records.Count > MaxRecordsPerApp)
            {
                records.RemoveFirst();
            }
        }
    }

    public IReadOnlyList<OtlpLogRecord> Query(string appId, DateTimeOffset since, int? minSeverity, int limit)
    {
        if (string.IsNullOrWhiteSpace(appId) || limit <= 0)
        {
            return [];
        }

        var sinceMs = since.ToUnixTimeMilliseconds();
        lock (gate)
        {
            if (!apps.TryGetValue(appId, out var records))
            {
                return [];
            }

            // Walk newest→oldest, take up to `limit` matches, then reverse back to arrival order.
            var matched = new List<OtlpLogRecord>(Math.Min(limit, records.Count));
            for (var node = records.Last; node is not null && matched.Count < limit; node = node.Previous)
            {
                var record = node.Value;
                // Arrival order ≈ chronological but is not strictly sorted, so filter every node
                // rather than breaking on the first out-of-window record.
                if (record.TimestampUnixMs < sinceMs)
                {
                    continue;
                }

                if (minSeverity is { } floor && record.SeverityNumber < floor)
                {
                    continue;
                }

                matched.Add(record);
            }

            matched.Reverse();
            return matched;
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
                var records = apps[appId];
                while (records.First is { } oldest && oldest.Value.TimestampUnixMs < cutoffMs)
                {
                    records.RemoveFirst();
                }

                if (records.Count == 0)
                {
                    apps.Remove(appId);
                }
            }
        }
    }
}

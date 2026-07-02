namespace Haas.Hosty.Core;

// One OTLP span held in the store. Start/End are epoch-nanoseconds (kept at OTLP precision so
// sub-millisecond spans still order and measure correctly in a waterfall; the read API converts to
// fractional milliseconds for clients). TraceId/SpanId/ParentSpanId are the lowercase-hex OTLP ids
// (ParentSpanId null for a root span). Kind and StatusCode are normalized lowercase tokens
// ("server"/"client"/… and "unset"/"ok"/"error") so clients never parse OTLP enum names. Attributes
// are the span's own attributes, flattened to strings. See docs/features/observability.md.
internal sealed record OtlpSpan(
    string TraceId,
    string SpanId,
    string? ParentSpanId,
    string Name,
    string Kind,
    long StartUnixNano,
    long EndUnixNano,
    string StatusCode,
    string? StatusMessage,
    IReadOnlyDictionary<string, string> Attributes);

// Append-only, in-memory trace store backing observability v1 (traces phase) — the spans analogue of
// IMetricStore/ILogStore. Holds a bounded rolling window of spans per app so Core can answer trace
// list/detail queries itself, with no external backend and no persistence (a Core restart drops the
// window, acceptable for a live traces view). The interface is the seam for a later durable swap.
internal interface ITraceStore
{
    // Record one span for an app. Spans with a non-positive start timestamp or a blank trace/span id
    // are dropped (they cannot be grouped into a trace or placed on the window).
    void Record(string appId, OtlpSpan span);

    // The app's spans starting at or after `since`, in arrival (≈ chronological) order, capped to the
    // most recent `limit`. Empty when the app has no recorded spans.
    IReadOnlyList<OtlpSpan> Query(string appId, DateTimeOffset since, int limit);

    // Every stored span of one trace recorded for an app, in arrival order. Used for the trace-detail
    // read path, which merges the per-app slices of a distributed trace at the service layer.
    IReadOnlyList<OtlpSpan> QueryTrace(string appId, string traceId);

    // Drop everything recorded for an app — called when the app is removed so an uninstalled app's
    // spans do not linger until the process restarts.
    void Remove(string appId);

    // Evict spans older than the retention window across every app, dropping apps that empty out.
    void Prune(DateTimeOffset now);
}

internal sealed class InMemoryTraceStore : ITraceStore
{
    // Rolling-window bounds, mirroring the log store: the window caps age; the per-app span cap caps
    // memory even if an app emits spans in a tight loop.
    private static readonly TimeSpan DefaultWindow = TimeSpan.FromHours(1);
    private const int MaxSpansPerApp = 2000;

    private readonly TimeSpan window;
    private readonly object gate = new();
    private readonly Dictionary<string, LinkedList<OtlpSpan>> apps = new(StringComparer.Ordinal);

    public InMemoryTraceStore()
        : this(DefaultWindow)
    {
    }

    // Test seam: a shorter window keeps eviction assertions fast and deterministic.
    internal InMemoryTraceStore(TimeSpan window)
        => this.window = window > TimeSpan.Zero ? window : DefaultWindow;

    public void Record(string appId, OtlpSpan span)
    {
        if (string.IsNullOrWhiteSpace(appId) || span is null || span.StartUnixNano <= 0 ||
            string.IsNullOrWhiteSpace(span.TraceId) || string.IsNullOrWhiteSpace(span.SpanId))
        {
            return;
        }

        lock (gate)
        {
            if (!apps.TryGetValue(appId, out var spans))
            {
                spans = new LinkedList<OtlpSpan>();
                apps[appId] = spans;
            }

            spans.AddLast(span);

            // Bound memory on write by count only. Age eviction is left to Prune, which runs each
            // scrape tick on the authoritative host clock — so a single span with a skewed future
            // timestamp cannot prematurely evict the app's in-window spans here.
            while (spans.Count > MaxSpansPerApp)
            {
                spans.RemoveFirst();
            }
        }
    }

    public IReadOnlyList<OtlpSpan> Query(string appId, DateTimeOffset since, int limit)
    {
        if (string.IsNullOrWhiteSpace(appId) || limit <= 0)
        {
            return [];
        }

        var sinceNano = ToUnixNano(since);
        lock (gate)
        {
            if (!apps.TryGetValue(appId, out var spans))
            {
                return [];
            }

            // Walk newest→oldest, take up to `limit` matches, then reverse back to arrival order.
            var matched = new List<OtlpSpan>(Math.Min(limit, spans.Count));
            for (var node = spans.Last; node is not null && matched.Count < limit; node = node.Previous)
            {
                // Arrival order ≈ chronological but is not strictly sorted, so filter every node
                // rather than breaking on the first out-of-window span.
                if (node.Value.StartUnixNano < sinceNano)
                {
                    continue;
                }

                matched.Add(node.Value);
            }

            matched.Reverse();
            return matched;
        }
    }

    public IReadOnlyList<OtlpSpan> QueryTrace(string appId, string traceId)
    {
        if (string.IsNullOrWhiteSpace(appId) || string.IsNullOrWhiteSpace(traceId))
        {
            return [];
        }

        lock (gate)
        {
            if (!apps.TryGetValue(appId, out var spans))
            {
                return [];
            }

            List<OtlpSpan>? matched = null;
            foreach (var span in spans)
            {
                if (string.Equals(span.TraceId, traceId, StringComparison.OrdinalIgnoreCase))
                {
                    (matched ??= []).Add(span);
                }
            }

            return matched ?? [];
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
        var cutoffNano = ToUnixNano(now - window);
        lock (gate)
        {
            foreach (var appId in apps.Keys.ToArray())
            {
                var spans = apps[appId];
                while (spans.First is { } oldest && oldest.Value.StartUnixNano < cutoffNano)
                {
                    spans.RemoveFirst();
                }

                if (spans.Count == 0)
                {
                    apps.Remove(appId);
                }
            }
        }
    }

    private static long ToUnixNano(DateTimeOffset timestamp)
        => timestamp.ToUnixTimeMilliseconds() * 1_000_000;
}

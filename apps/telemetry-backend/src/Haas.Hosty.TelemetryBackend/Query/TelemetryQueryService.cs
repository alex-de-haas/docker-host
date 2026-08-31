namespace Haas.Hosty.TelemetryBackend;

// Answers the query API by clamping the request window/limit (same bounds Core used), reading the
// SQLite store, and — for the fleet reads — grouping across apps the way Core's service layer did. All
// responses are appId-keyed; Core's read proxy adds display names. Ported from Core's CoreLifecycleService
// observability read path (Phase 2).
internal sealed class TelemetryQueryService(SqliteTelemetryStore store)
{
    // Clamp bounds, mirroring Core's CoreLifecycleService constants.
    private const int DefaultMetricsRangeSeconds = 300;
    private const int MaxMetricsRangeSeconds = 3600;
    private const int DefaultLogsRangeSeconds = 300;
    private const int MaxLogsRangeSeconds = 3600;
    private const int DefaultLogsLimit = 500;
    private const int MaxLogsLimit = 2000;
    private const int DefaultTracesRangeSeconds = 300;
    private const int MaxTracesRangeSeconds = 3600;
    private const int DefaultTracesLimit = 50;
    private const int MaxTracesLimit = 200;

    // Global span scan cap for fleet trace aggregation (Core scanned up to 2000 spans per app; the
    // backend scans the newest spans across all apps in one pass).
    private const int MaxSpansScan = 20_000;

    public BackendMetricsResponse GetMetrics(string appId, int? rangeSeconds)
    {
        var range = Math.Clamp(rangeSeconds ?? DefaultMetricsRangeSeconds, 1, MaxMetricsRangeSeconds);
        var sinceMs = DateTimeOffset.UtcNow.AddSeconds(-range).ToUnixTimeMilliseconds();
        return new BackendMetricsResponse(appId, range, store.QueryMetrics(appId, sinceMs));
    }

    public BackendOtlpLogsResponse GetOtlpLogs(string appId, int? rangeSeconds, int? minSeverity, int? limit)
    {
        var range = Math.Clamp(rangeSeconds ?? DefaultLogsRangeSeconds, 1, MaxLogsRangeSeconds);
        var cappedLimit = Math.Clamp(limit ?? DefaultLogsLimit, 1, MaxLogsLimit);
        var sinceMs = DateTimeOffset.UtcNow.AddSeconds(-range).ToUnixTimeMilliseconds();
        return new BackendOtlpLogsResponse(appId, range, store.QueryOtlpLogs(appId, sinceMs, minSeverity, cappedLimit));
    }

    public BackendFleetLogsResponse GetFleetLogs(
        int? rangeSeconds, int? minSeverity, int? limit, IReadOnlyCollection<string>? appIds, string? query)
    {
        var range = Math.Clamp(rangeSeconds ?? DefaultLogsRangeSeconds, 1, MaxLogsRangeSeconds);
        var cappedLimit = Math.Clamp(limit ?? DefaultLogsLimit, 1, MaxLogsLimit);
        var sinceMs = DateTimeOffset.UtcNow.AddSeconds(-range).ToUnixTimeMilliseconds();

        var records = new List<BackendFleetLogRecord>();
        var present = new HashSet<string>(StringComparer.Ordinal);
        foreach (var parsed in store.QueryFleetLogs(sinceMs, minSeverity, cappedLimit, appIds, query))
        {
            var record = parsed.Record;
            records.Add(new BackendFleetLogRecord(
                parsed.AppId,
                record.TimestampUnixMs,
                record.SeverityNumber,
                record.SeverityText,
                record.Body,
                record.Attributes,
                record.TraceId,
                record.SpanId));
            present.Add(parsed.AppId);
        }

        return new BackendFleetLogsResponse(range, CountApps(present), records);
    }

    public BackendTracesResponse GetFleetTraces(
        int? rangeSeconds, int? limit, IReadOnlyCollection<string>? appIds, string? query)
    {
        var range = Math.Clamp(rangeSeconds ?? DefaultTracesRangeSeconds, 1, MaxTracesRangeSeconds);
        var cappedLimit = Math.Clamp(limit ?? DefaultTracesLimit, 1, MaxTracesLimit);
        var sinceNano = DateTimeOffset.UtcNow.AddSeconds(-range).ToUnixTimeMilliseconds() * 1_000_000L;
        var trimmedQuery = string.IsNullOrWhiteSpace(query) ? null : query.Trim();

        var groups = new Dictionary<string, TraceAccumulator>(StringComparer.OrdinalIgnoreCase);
        foreach (var parsed in store.QueryInWindowSpans(sinceNano, appIds, MaxSpansScan))
        {
            if (!groups.TryGetValue(parsed.Span.TraceId, out var group))
            {
                group = new TraceAccumulator(parsed.Span.TraceId);
                groups[parsed.Span.TraceId] = group;
            }

            group.Add(parsed.AppId, parsed.Span);
        }

        var summaries = new List<BackendTraceSummary>(groups.Count);
        foreach (var group in groups.Values)
        {
            var summary = group.ToSummary();
            if (trimmedQuery is not null &&
                !summary.RootName.Contains(trimmedQuery, StringComparison.OrdinalIgnoreCase) &&
                !summary.TraceId.Contains(trimmedQuery, StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }

            summaries.Add(summary);
        }

        summaries.Sort((left, right) => right.StartUnixMs.CompareTo(left.StartUnixMs));
        if (summaries.Count > cappedLimit)
        {
            summaries.RemoveRange(cappedLimit, summaries.Count - cappedLimit);
        }

        var present = new HashSet<string>(StringComparer.Ordinal);
        foreach (var summary in summaries)
        {
            foreach (var appId in summary.AppIds)
            {
                present.Add(appId);
            }
        }

        return new BackendTracesResponse(range, CountApps(present), summaries);
    }

    // The count is reported and rendered as a number of *apps*. Hosty Core contributes records under a
    // reserved id but is the host kernel, not an installed app, so counting it would inflate every
    // fleet response by one.
    private static int CountApps(HashSet<string> present)
        => present.Count - (present.Contains(CoreLogPullParser.CoreAppId) ? 1 : 0);

    public BackendTraceDetailResponse GetTrace(string traceId)
    {
        var trimmed = string.IsNullOrWhiteSpace(traceId) ? null : traceId.Trim();
        var spans = new List<BackendTraceDetailSpan>();
        if (trimmed is not null)
        {
            foreach (var parsed in store.QueryTraceSpans(trimmed))
            {
                var span = parsed.Span;
                spans.Add(new BackendTraceDetailSpan(
                    AppId: parsed.AppId,
                    SpanId: span.SpanId,
                    ParentSpanId: span.ParentSpanId,
                    Name: span.Name,
                    Kind: span.Kind,
                    StartUnixMs: NanosToUnixMs(span.StartUnixNano),
                    DurationMs: NanosToDurationMs(span.StartUnixNano, span.EndUnixNano),
                    StatusCode: span.StatusCode,
                    StatusMessage: span.StatusMessage,
                    Attributes: span.Attributes));
            }

            spans.Sort((left, right) =>
            {
                var byStart = left.StartUnixMs.CompareTo(right.StartUnixMs);
                return byStart != 0 ? byStart : right.DurationMs.CompareTo(left.DurationMs);
            });
        }

        var startMs = 0d;
        var durationMs = 0d;
        if (spans.Count > 0)
        {
            startMs = spans[0].StartUnixMs;
            foreach (var span in spans)
            {
                durationMs = Math.Max(durationMs, span.StartUnixMs + span.DurationMs - startMs);
            }
        }

        return new BackendTraceDetailResponse(trimmed ?? string.Empty, startMs, durationMs, spans);
    }

    // OTLP nanos exceed the JS safe-integer range, so the wire format is fractional unix-ms.
    internal static double NanosToUnixMs(long unixNano) => unixNano / 1_000_000d;

    internal static double NanosToDurationMs(long startUnixNano, long endUnixNano)
        => endUnixNano > startUnixNano ? (endUnixNano - startUnixNano) / 1_000_000d : 0d;

    // Per-trace aggregation, ported from Core's TraceAccumulator (appId-only; Core adds display names).
    private sealed class TraceAccumulator(string traceId)
    {
        private readonly List<string> appIds = [];
        private readonly HashSet<string> seen = new(StringComparer.Ordinal);
        private long minStartNano = long.MaxValue;
        private long maxEndNano;
        private int spanCount;
        private int errorCount;
        private OtlpSpan? root;
        private string? rootAppId;
        private OtlpSpan? earliest;
        private string? earliestAppId;

        public void Add(string appId, OtlpSpan span)
        {
            spanCount++;
            if (string.Equals(span.StatusCode, "error", StringComparison.Ordinal))
            {
                errorCount++;
            }

            minStartNano = Math.Min(minStartNano, span.StartUnixNano);
            maxEndNano = Math.Max(maxEndNano, span.EndUnixNano);
            if (seen.Add(appId))
            {
                appIds.Add(appId);
            }

            if (span.ParentSpanId is null && (root is null || span.StartUnixNano < root.StartUnixNano))
            {
                (root, rootAppId) = (span, appId);
            }

            if (earliest is null || span.StartUnixNano < earliest.StartUnixNano)
            {
                (earliest, earliestAppId) = (span, appId);
            }
        }

        public BackendTraceSummary ToSummary()
        {
            var (representative, representativeAppId) = root is not null
                ? (root, rootAppId!)
                : (earliest!, earliestAppId!);
            return new BackendTraceSummary(
                TraceId: traceId,
                RootName: representative.Name,
                RootKind: representative.Kind,
                RootAppId: representativeAppId,
                HasRootSpan: root is not null,
                StartUnixMs: NanosToUnixMs(minStartNano),
                DurationMs: NanosToDurationMs(minStartNano, maxEndNano),
                SpanCount: spanCount,
                ErrorCount: errorCount,
                AppIds: appIds);
        }
    }
}

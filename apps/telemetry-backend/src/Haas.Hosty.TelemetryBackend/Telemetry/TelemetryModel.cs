namespace Haas.Hosty.TelemetryBackend;

// Shared telemetry record types — the same shapes Core used to hold in its in-memory stores, now
// persisted in SQLite and returned by the query API. Copied from Core (MetricStore/LogStore/TraceStore)
// so the backend serves byte-identical shapes to what Core's read proxy forwards. See
// docs/features/observability-phase-2-backend.md.

// A single recorded metric value at a point in time (epoch-millis so clients render a time axis
// without re-deriving it).
internal readonly record struct MetricPoint(long TimestampUnixMs, double Value);

// Immutable snapshot of one metric series — its name, its label set, and the points that fell inside a
// query window. Returned by the metric store's Query; safe to hand to the JSON serializer.
internal sealed record MetricSeriesSnapshot(
    string Name,
    IReadOnlyDictionary<string, string> Labels,
    IReadOnlyList<MetricPoint> Points);

// One structured OTLP log record. Timestamp is epoch-millis; SeverityNumber is the OTLP severity
// (1-24, 0 = unspecified) and SeverityText its textual level. TraceId/SpanId are the lowercase-hex
// correlation ids (null when not trace-correlated). Attributes are the record's own attributes,
// flattened to strings. A distinct stream from the console (`docker logs`) tail — never interleaved.
internal sealed record OtlpLogRecord(
    long TimestampUnixMs,
    int SeverityNumber,
    string SeverityText,
    string Body,
    IReadOnlyDictionary<string, string> Attributes,
    string? TraceId,
    string? SpanId);

// One OTLP span. Start/End are epoch-nanoseconds (kept at OTLP precision so sub-millisecond spans
// still order and measure correctly in a waterfall; the read API converts to fractional milliseconds).
// TraceId/SpanId/ParentSpanId are lowercase-hex OTLP ids (ParentSpanId null for a root span). Kind and
// StatusCode are normalized lowercase tokens ("server"/"client"/… and "unset"/"ok"/"error").
// Attributes are the span's own attributes, flattened to strings.
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

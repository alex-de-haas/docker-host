namespace Haas.Hosty.TelemetryBackend;

// Query-API response shapes. These are the appId-keyed forms the telemetry UI's server routes consume
// and enrich with each app's display name (AppName) from the Core roster — telemetry identity/display
// is Core's domain, not the backend's. Otherwise the shapes mirror Core's former observability
// responses, so the UI's mapping layer (apps/telemetry-ui/src/lib/enrich.ts) stays thin. See
// docs/features/observability-phase-2-backend.md.

internal sealed record BackendMetricsResponse(
    string AppId,
    long RangeSeconds,
    IReadOnlyList<MetricSeriesSnapshot> Series);

internal sealed record BackendOtlpLogsResponse(
    string AppId,
    long RangeSeconds,
    IReadOnlyList<OtlpLogRecord> Records);

// One cross-resource OTLP log record, attributed to its source app by id (the UI adds the display name).
internal sealed record BackendFleetLogRecord(
    string AppId,
    long TimestampUnixMs,
    int SeverityNumber,
    string SeverityText,
    string Body,
    IReadOnlyDictionary<string, string> Attributes,
    string? TraceId,
    string? SpanId);

internal sealed record BackendFleetLogsResponse(
    long RangeSeconds,
    int AppCount,
    IReadOnlyList<BackendFleetLogRecord> Records);

// One trace in the fleet list, spans collapsed to a summary. Root* describe the root span when stored
// (HasRootSpan) else the earliest span. Timestamps are fractional unix-ms. AppIds are the contributing
// apps in first-seen order (the UI maps each to a display name).
internal sealed record BackendTraceSummary(
    string TraceId,
    string RootName,
    string RootKind,
    string RootAppId,
    bool HasRootSpan,
    double StartUnixMs,
    double DurationMs,
    int SpanCount,
    int ErrorCount,
    IReadOnlyList<string> AppIds);

internal sealed record BackendTracesResponse(
    long RangeSeconds,
    int AppCount,
    IReadOnlyList<BackendTraceSummary> Traces);

// One span of a trace-detail response, tagged with its source app id. Start/Duration are fractional
// unix-ms; ParentSpanId is null for the root span.
internal sealed record BackendTraceDetailSpan(
    string AppId,
    string SpanId,
    string? ParentSpanId,
    string Name,
    string Kind,
    double StartUnixMs,
    double DurationMs,
    string StatusCode,
    string? StatusMessage,
    IReadOnlyDictionary<string, string> Attributes);

internal sealed record BackendTraceDetailResponse(
    string TraceId,
    double StartUnixMs,
    double DurationMs,
    IReadOnlyList<BackendTraceDetailSpan> Spans);

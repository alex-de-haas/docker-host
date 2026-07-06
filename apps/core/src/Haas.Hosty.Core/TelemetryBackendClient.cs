using System.Text.Json;
using Microsoft.Extensions.Logging;

namespace Haas.Hosty.Core;

// Phase 2 read proxy: the HTTP client Core uses to query the telemetry-backend system app, plus the
// appId-keyed response shapes the backend serves and the mapping that enriches them with each app's
// display name (from Core's registry — telemetry identity/display is Core's domain, not the backend's).
// Metrics and per-app OTLP logs come back in Core's own shapes (AppMetricsResponse / AppOtlpLogsResponse)
// and pass straight through; only the fleet reads need enrichment. Best-effort: any transport failure
// yields null so an unreachable backend degrades to "no data", never an error — but the failure is logged
// (on reachability transitions, not per-request) so a misconfigured backend is distinguishable from
// genuinely-absent data. See docs/features/observability-phase-2-backend.md.
internal sealed class TelemetryBackendClient(ILogger<TelemetryBackendClient>? logger = null) : IDisposable
{
    private readonly HttpClient client = new() { Timeout = TimeSpan.FromSeconds(10) };
    private readonly ILogger<TelemetryBackendClient>? logger = logger;

    // Reachability is logged only on transitions so a persistently-down backend doesn't flood the log.
    // 1 = last call succeeded, 0 = last call failed; starts "reachable" so the first failure is reported.
    private int lastReachable = 1;

    public Task<AppMetricsResponse?> GetMetricsAsync(string baseUrl, string appId, int? range, CancellationToken cancellationToken)
        => GetAsync($"{baseUrl}/api/apps/{Uri.EscapeDataString(appId)}/metrics{Query(("range", range?.ToString()))}",
            CoreJsonSerializerContext.Default.AppMetricsResponse, cancellationToken);

    public Task<AppOtlpLogsResponse?> GetOtlpLogsAsync(string baseUrl, string appId, int? range, int? severity, int? limit, CancellationToken cancellationToken)
        => GetAsync($"{baseUrl}/api/apps/{Uri.EscapeDataString(appId)}/otlp-logs{Query(("range", range?.ToString()), ("severity", severity?.ToString()), ("limit", limit?.ToString()))}",
            CoreJsonSerializerContext.Default.AppOtlpLogsResponse, cancellationToken);

    public Task<BackendFleetLogsResponse?> GetFleetLogsAsync(string baseUrl, int? range, int? severity, int? limit, string? apps, string? q, CancellationToken cancellationToken)
        => GetAsync($"{baseUrl}/api/observability/logs{Query(("range", range?.ToString()), ("severity", severity?.ToString()), ("limit", limit?.ToString()), ("apps", apps), ("q", q))}",
            CoreJsonSerializerContext.Default.BackendFleetLogsResponse, cancellationToken);

    public Task<BackendTracesResponse?> GetFleetTracesAsync(string baseUrl, int? range, int? limit, string? apps, string? q, CancellationToken cancellationToken)
        => GetAsync($"{baseUrl}/api/observability/traces{Query(("range", range?.ToString()), ("limit", limit?.ToString()), ("apps", apps), ("q", q))}",
            CoreJsonSerializerContext.Default.BackendTracesResponse, cancellationToken);

    public Task<BackendTraceDetailResponse?> GetTraceAsync(string baseUrl, string traceId, CancellationToken cancellationToken)
        => GetAsync($"{baseUrl}/api/observability/traces/{Uri.EscapeDataString(traceId)}",
            CoreJsonSerializerContext.Default.BackendTraceDetailResponse, cancellationToken);

    private async Task<T?> GetAsync<T>(string url, System.Text.Json.Serialization.Metadata.JsonTypeInfo<T> typeInfo, CancellationToken cancellationToken)
        where T : class
    {
        try
        {
            using var response = await client.GetAsync(url, cancellationToken);
            if (!response.IsSuccessStatusCode)
            {
                MarkFailure(url, $"HTTP {(int)response.StatusCode}", exception: null);
                return null;
            }

            await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken);
            var result = await JsonSerializer.DeserializeAsync(stream, typeInfo, cancellationToken);
            MarkSuccess();
            return result;
        }
        catch (Exception ex) when (
            ex is HttpRequestException or IOException or UriFormatException or InvalidOperationException or JsonException ||
            (ex is TaskCanceledException && !cancellationToken.IsCancellationRequested))
        {
            MarkFailure(url, ex.Message, ex);
            return null;
        }
    }

    private void MarkSuccess()
    {
        if (Interlocked.Exchange(ref lastReachable, 1) == 0)
        {
            logger?.LogInformation("Telemetry backend is reachable again.");
        }
    }

    private void MarkFailure(string url, string reason, Exception? exception)
    {
        if (Interlocked.Exchange(ref lastReachable, 0) == 1)
        {
            logger?.LogWarning(exception, "Telemetry backend query failed ({Reason}); observability data will read as empty until it recovers. URL: {Url}", reason, url);
        }
    }

    // Builds `?k=v&…` from the non-empty pairs, url-encoding values; empty string when none apply.
    private static string Query(params (string Key, string? Value)[] pairs)
    {
        var parts = pairs
            .Where(pair => !string.IsNullOrWhiteSpace(pair.Value))
            .Select(pair => $"{pair.Key}={Uri.EscapeDataString(pair.Value!)}")
            .ToArray();
        return parts.Length == 0 ? string.Empty : "?" + string.Join("&", parts);
    }

    public void Dispose() => client.Dispose();
}

// ---- Backend fleet response shapes (appId-keyed; Core enriches with display names) ------------------

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

// Maps the backend's appId-keyed fleet shapes to Core's Shell-facing shapes, resolving each app id to
// its display name (falling back to the id when the app is unknown). Pure/static so it is unit-tested
// without a live backend.
internal static class TelemetryBackendMapping
{
    public static FleetOtlpLogsResponse MapFleetLogs(BackendFleetLogsResponse backend, IReadOnlyDictionary<string, string> names)
    {
        var source = backend.Records ?? [];
        var records = new List<FleetOtlpLogRecord>(source.Count);
        foreach (var record in source)
        {
            records.Add(new FleetOtlpLogRecord(
                record.AppId,
                ResolveName(names, record.AppId),
                record.TimestampUnixMs,
                record.SeverityNumber,
                record.SeverityText,
                record.Body,
                record.Attributes,
                record.TraceId,
                record.SpanId));
        }

        return new FleetOtlpLogsResponse(backend.RangeSeconds, backend.AppCount, records);
    }

    public static FleetTracesResponse MapFleetTraces(BackendTracesResponse backend, IReadOnlyDictionary<string, string> names)
    {
        var source = backend.Traces ?? [];
        var traces = new List<FleetTraceSummary>(source.Count);
        foreach (var trace in source)
        {
            var appIds = trace.AppIds ?? [];
            var apps = new List<TraceAppRef>(appIds.Count);
            foreach (var appId in appIds)
            {
                apps.Add(new TraceAppRef(appId, ResolveName(names, appId)));
            }

            traces.Add(new FleetTraceSummary(
                trace.TraceId,
                trace.RootName,
                trace.RootKind,
                trace.RootAppId,
                ResolveName(names, trace.RootAppId),
                trace.HasRootSpan,
                trace.StartUnixMs,
                trace.DurationMs,
                trace.SpanCount,
                trace.ErrorCount,
                apps));
        }

        return new FleetTracesResponse(backend.RangeSeconds, backend.AppCount, traces);
    }

    public static TraceDetailResponse MapTraceDetail(BackendTraceDetailResponse backend, IReadOnlyDictionary<string, string> names)
    {
        var source = backend.Spans ?? [];
        var spans = new List<TraceDetailSpan>(source.Count);
        foreach (var span in source)
        {
            spans.Add(new TraceDetailSpan(
                span.AppId,
                ResolveName(names, span.AppId),
                span.SpanId,
                span.ParentSpanId,
                span.Name,
                span.Kind,
                span.StartUnixMs,
                span.DurationMs,
                span.StatusCode,
                span.StatusMessage,
                span.Attributes));
        }

        return new TraceDetailResponse(backend.TraceId, backend.StartUnixMs, backend.DurationMs, spans);
    }

    private static string ResolveName(IReadOnlyDictionary<string, string> names, string appId)
        => names.TryGetValue(appId, out var name) && !string.IsNullOrWhiteSpace(name) ? name : appId;
}

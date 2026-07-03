using Haas.Hosty.TelemetryBackend;

// Hosty telemetry backend (observability Phase 2). Ingests from the otelcol collector (Prometheus
// scrape + file sinks on the shared volume) into an embedded SQLite store and serves a query API that
// mirrors the shapes Core used to serve (appId-keyed; Core's read proxy adds display names). Reached
// only by Core's read proxy over the internal network, so it carries no auth of its own. See
// docs/features/observability-phase-2-backend.md.
var options = TelemetryBackendOptions.FromEnvironment();

var builder = WebApplication.CreateBuilder(args);
builder.WebHost.ConfigureKestrel(kestrel => kestrel.ListenAnyIP(options.QueryPort));
builder.Services.AddSingleton(options);
builder.Services.AddSingleton<SqliteTelemetryStore>();
builder.Services.AddSingleton<TelemetryQueryService>();
builder.Services.AddHostedService<TelemetryIngestService>();

var app = builder.Build();

// Warm the store eagerly so schema init failures surface at startup, not on first query.
app.Services.GetRequiredService<SqliteTelemetryStore>();

// Liveness probe for the runtime (and a trivial reachability check for Core).
app.MapGet("/healthz", () => Results.Ok(new HealthResponse("ok")));

// Per-app metric series over the resolved range.
app.MapGet("/api/apps/{appId}/metrics", (string appId, int? range, TelemetryQueryService query)
    => Results.Ok(query.GetMetrics(appId, range)));

// Per-app OTLP structured logs (distinct from console `docker logs`, which stays in Core).
app.MapGet("/api/apps/{appId}/otlp-logs", (string appId, int? range, int? severity, int? limit, TelemetryQueryService query)
    => Results.Ok(query.GetOtlpLogs(appId, range, severity, limit)));

// Cross-resource OTLP logs merged across apps.
app.MapGet("/api/observability/logs", (int? range, int? severity, int? limit, string? apps, string? q, TelemetryQueryService query)
    => Results.Ok(query.GetFleetLogs(range, severity, limit, ParseAppFilter(apps), q)));

// Cross-resource trace summaries merged across apps.
app.MapGet("/api/observability/traces", (int? range, int? limit, string? apps, string? q, TelemetryQueryService query)
    => Results.Ok(query.GetFleetTraces(range, limit, ParseAppFilter(apps), q)));

// One trace's spans merged across apps.
app.MapGet("/api/observability/traces/{traceId}", (string traceId, TelemetryQueryService query)
    => Results.Ok(query.GetTrace(traceId)));

app.Run();

static IReadOnlyCollection<string>? ParseAppFilter(string? apps)
{
    if (string.IsNullOrWhiteSpace(apps))
    {
        return null;
    }

    var ids = apps
        .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
        .Distinct(StringComparer.Ordinal)
        .ToArray();
    return ids.Length > 0 ? ids : null;
}

namespace Haas.Hosty.TelemetryBackend
{
    internal sealed record HealthResponse(string Status);
}

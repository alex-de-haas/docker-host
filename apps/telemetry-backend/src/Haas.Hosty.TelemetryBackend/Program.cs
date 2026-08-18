using Haas.Hosty.TelemetryBackend;
using Haas.Hosty.TelemetryBackend.Query;

// Hosty telemetry backend (observability Phase 2). Ingests from the otelcol collector (Prometheus
// scrape + file sinks on the shared volume) into an embedded SQLite store and serves a query API that
// mirrors the shapes Core used to serve (appId-keyed; Core's read proxy adds display names).
//
// SECURITY (docs/features/telemetry-mcp/feature.md). Reading is authenticated: every route below
// requires a token Core signed — an app's own identity, or a user's delegated token addressed to this
// app — verified locally with the public key Core injects. The administrator requirement is inherited
// rather than re-checked here: telemetry is a system app, so Core will not mint a delegated token for
// it to anyone who is not one.
//
// Writing is deliberately open to any installed app, and is confined by the network rather than by a
// credential: the OTLP port binds loopback and containers reach the collector over hosty-telemetry-net,
// so nothing off-host can inject spans attributed to a hosty.app.id. That confinement is the security
// property — do not publish the ingest port to 0.0.0.0 again without replacing it with something.
var options = TelemetryBackendOptions.FromEnvironment();

var builder = WebApplication.CreateBuilder(args);
builder.WebHost.ConfigureKestrel(kestrel => kestrel.ListenAnyIP(options.QueryPort));
builder.Services.AddSingleton(options);
builder.Services.AddSingleton<SqliteTelemetryStore>();
builder.Services.AddSingleton<TelemetryQueryService>();
builder.Services.AddSingleton(new TelemetryCallerAuth(
    Environment.GetEnvironmentVariable("HOSTY_DELEGATED_TOKEN_PUBLIC_KEY"),
    Environment.GetEnvironmentVariable("HOSTY_APP_ID") ?? "hosty.telemetry"));
builder.Services.AddHostedService<TelemetryIngestService>();

var app = builder.Build();

// Warm the store eagerly so schema init failures surface at startup, not on first query.
app.Services.GetRequiredService<SqliteTelemetryStore>();

// Liveness probe for the runtime (and a trivial reachability check for Core). Deliberately outside
// the gate below: a health check that needed a credential would make an unauthenticated backend look
// dead rather than look closed, and Core polls this to decide whether the app is up.
app.MapGet("/healthz", () => Results.Ok(new HealthResponse("ok")));

// One gate over everything else. Applied as a filter rather than repeated per route so a route added
// later is closed by default — the failure of the per-route style is the endpoint someone forgets.
var read = app.MapGroup("/api").AddEndpointFilter(async (context, next) =>
{
    var auth = context.HttpContext.RequestServices.GetRequiredService<TelemetryCallerAuth>();
    if (auth.Authenticate(context.HttpContext.Request.Headers.Authorization.ToString()) is null)
    {
        return (object?)Results.Json(
            new
            {
                code = auth.Configured ? "telemetry_unauthorized" : "telemetry_auth_unconfigured",
                message = auth.Configured
                    ? "Telemetry reads require a token Hosty Core signed for this app."
                    : "This telemetry backend received no verification key from Hosty Core, so it cannot "
                        + "authenticate anyone and refuses every read. Restart the app through Core.",
            },
            statusCode: StatusCodes.Status401Unauthorized);
    }

    return await next(context);
});

// Per-app metric series over the resolved range.
read.MapGet("/apps/{appId}/metrics", (string appId, int? range, TelemetryQueryService query)
    => Results.Ok(query.GetMetrics(appId, range)));

// Per-app OTLP structured logs (distinct from console `docker logs`, which stays in Core).
read.MapGet("/apps/{appId}/otlp-logs", (string appId, int? range, int? severity, int? limit, TelemetryQueryService query)
    => Results.Ok(query.GetOtlpLogs(appId, range, severity, limit)));

// Cross-resource OTLP logs merged across apps.
read.MapGet("/observability/logs", (int? range, int? severity, int? limit, string? apps, string? q, TelemetryQueryService query)
    => Results.Ok(query.GetFleetLogs(range, severity, limit, ParseAppFilter(apps), q)));

// Cross-resource trace summaries merged across apps.
read.MapGet("/observability/traces", (int? range, int? limit, string? apps, string? q, TelemetryQueryService query)
    => Results.Ok(query.GetFleetTraces(range, limit, ParseAppFilter(apps), q)));

// One trace's spans merged across apps.
read.MapGet("/observability/traces/{traceId}", (string traceId, TelemetryQueryService query)
    => Results.Ok(query.GetTrace(traceId)));

// The app-owned MCP interface, inside the same gate as every other read.
read.MapPost("/mcp", async (HttpRequest request, TelemetryQueryService query) =>
{
    var body = await System.Text.Json.Nodes.JsonNode.ParseAsync(request.Body);
    return TelemetryMcpEndpoint.Handle(body, query);
});

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

using System.Globalization;

namespace Haas.Hosty.TelemetryBackend;

// Runtime configuration for the telemetry backend, resolved from the environment Hosty Core injects at
// start. The backend runs as a service inside the telemetry-backend system app alongside the otelcol
// collector; it ingests from the collector (Prometheus scrape + the file sinks on the shared volume)
// into an embedded SQLite store and serves a query API. See docs/features/observability-phase-2-backend.md.
internal sealed record TelemetryBackendOptions
{
    // Embedded SQLite database file. Persistent (survives restarts) — the whole point of Phase 2.
    public required string DatabasePath { get; init; }

    // The collector's Prometheus `/metrics` scrape URL (app OTLP metrics ingest). Null when unset —
    // metrics ingest is then idle, which is fine for a logs/traces-only run.
    public string? MetricsScrapeUrl { get; init; }

    // Core's Prometheus endpoint for host-privileged `docker stats` infra metrics (CPU/mem), which Core
    // collects and re-exposes because they need host Docker access the backend deliberately lacks. The
    // backend scrapes it as a second target and attributes it the same way (hosty_app_id label). Null
    // when unset (e.g. a docker-less host or dev run).
    public string? DockerMetricsScrapeUrl { get; init; }

    // The collector's file sinks on the shared volume (logs/traces ingest), tailed continuously.
    public required string LogsFilePath { get; init; }
    public required string TracesFilePath { get; init; }

    // How often the ingest loop ticks. Logs/traces are tailed every tick (near-real-time), so this stays
    // short. Metrics are NOT scraped every tick — see MetricsScrapeInterval.
    public TimeSpan IngestInterval { get; init; } = TimeSpan.FromSeconds(1);

    // How often metrics are scraped, decoupled from the tail tick. The Prometheus exporter re-serves the
    // last value every scrape, so scraping at the 1 s tail cadence inserted ~1 row/series/second (≈4.3 M
    // rows/day/app) of mostly-identical data, collapsing the intended 14-day retention to hours of prune
    // churn. Scraping every ~15 s (plus the unchanged-sample skip below) restores it. (T-H2)
    public TimeSpan MetricsScrapeInterval { get; init; } = TimeSpan.FromSeconds(15);

    // A flat series is skipped rather than re-inserted every scrape, but is still re-recorded at least
    // this often so it stays legible as "live" and range queries keep an anchor point. Set to zero to
    // record every scrape (no unchanged-skip).
    public TimeSpan MetricsHeartbeat { get; init; } = TimeSpan.FromSeconds(60);

    // Per-signal age caps (retention intent) + a global size ceiling (hard safety so telemetry can
    // never fill the disk). Evicted by the periodic prune. See the retention decision in the doc.
    public TimeSpan MetricsRetention { get; init; } = TimeSpan.FromDays(14);
    public TimeSpan LogsRetention { get; init; } = TimeSpan.FromDays(3);
    public TimeSpan TracesRetention { get; init; } = TimeSpan.FromDays(3);
    public long MaxDatabaseBytes { get; init; } = 1L * 1024 * 1024 * 1024; // ~1 GiB

    // The HTTP port the query API listens on (internal-network only; reached by Core's read proxy).
    public int QueryPort { get; init; } = 8080;

    // Builds options from the process environment. Defaults keep a bare `dotnet run` (dev localCommand
    // profile) working without any wiring: a local `data/` dir under the working directory.
    public static TelemetryBackendOptions FromEnvironment()
    {
        var appData = FirstNonEmpty(
            Environment.GetEnvironmentVariable("HOSTY_TELEMETRY_DATA_DIR"),
            Environment.GetEnvironmentVariable("HOSTY_APP_DATA"))
            ?? Path.Combine(Directory.GetCurrentDirectory(), "data");

        return new TelemetryBackendOptions
        {
            DatabasePath = FirstNonEmpty(Environment.GetEnvironmentVariable("HOSTY_TELEMETRY_DB_PATH"))
                ?? Path.Combine(appData, "telemetry.db"),
            // Collector Prometheus URL. The manifest pins this explicitly, and must: the `dependsOn`
            // fallback below resolves the collector's FIRST port, which is the OTLP receiver (4318), not
            // the Prometheus exporter (9464) — so it yields a 404 and silently drops every app metric.
            // The fallback stays for a collector that declares only the one port; it is not a default to
            // rely on. Both forms use the sibling service name, reachable over the per-app docker
            // network, unlike a host-loopback URL.
            MetricsScrapeUrl = FirstNonEmpty(
                Environment.GetEnvironmentVariable("HOSTY_TELEMETRY_METRICS_URL"),
                Append(Environment.GetEnvironmentVariable("HOSTY_SERVICE_COLLECTOR_URL"), "/metrics")),
            // Core's docker-stats endpoint: explicit, else derived from the Core origin Core injects.
            DockerMetricsScrapeUrl = FirstNonEmpty(
                Environment.GetEnvironmentVariable("HOSTY_TELEMETRY_DOCKER_METRICS_URL"),
                Append(Environment.GetEnvironmentVariable("HOSTY_CORE_ORIGIN"), "/internal/telemetry/metrics")),
            LogsFilePath = FirstNonEmpty(Environment.GetEnvironmentVariable("HOSTY_TELEMETRY_LOGS_FILE"))
                ?? Path.Combine(appData, "otlp-logs", "logs.jsonl"),
            TracesFilePath = FirstNonEmpty(Environment.GetEnvironmentVariable("HOSTY_TELEMETRY_TRACES_FILE"))
                ?? Path.Combine(appData, "otlp-traces", "traces.jsonl"),
            IngestInterval = ParseSeconds("HOSTY_TELEMETRY_INGEST_INTERVAL_SECONDS", 1, minimumSeconds: 0.1),
            MetricsScrapeInterval = ParseSeconds("HOSTY_TELEMETRY_METRICS_INTERVAL_SECONDS", 15, minimumSeconds: 1),
            MetricsHeartbeat = ParseSeconds("HOSTY_TELEMETRY_METRICS_HEARTBEAT_SECONDS", 60, minimumSeconds: 0),
            MetricsRetention = ParseDays("HOSTY_TELEMETRY_METRICS_RETENTION_DAYS", 14),
            LogsRetention = ParseDays("HOSTY_TELEMETRY_LOGS_RETENTION_DAYS", 3),
            TracesRetention = ParseDays("HOSTY_TELEMETRY_TRACES_RETENTION_DAYS", 3),
            MaxDatabaseBytes = ParseBytes("HOSTY_TELEMETRY_MAX_DB_BYTES", 1L * 1024 * 1024 * 1024),
            QueryPort = ParseInt("HOSTY_TELEMETRY_QUERY_PORT", 8080),
        };
    }

    private static string? FirstNonEmpty(params string?[] values)
        => values.FirstOrDefault(static v => !string.IsNullOrWhiteSpace(v));

    // Appends a path to a base URL (trimming a duplicate slash), or null when the base is unset.
    private static string? Append(string? baseUrl, string path)
        => string.IsNullOrWhiteSpace(baseUrl) ? null : baseUrl.TrimEnd('/') + path;

    // Env values are culture-independent, so parse with the invariant culture (belt-and-braces even
    // with InvariantGlobalization on) — otherwise a comma-decimal host could misread "1.5".
    private static TimeSpan ParseDays(string name, double fallbackDays)
    {
        var raw = Environment.GetEnvironmentVariable(name);
        return double.TryParse(raw, NumberStyles.Float, CultureInfo.InvariantCulture, out var days) && days > 0
            ? TimeSpan.FromDays(days)
            : TimeSpan.FromDays(fallbackDays);
    }

    // A duration in (fractional) seconds, floored at minimumSeconds so a misconfigured 0 can't spin the
    // ingest loop. A minimum of 0 allows disabling (e.g. the unchanged-skip heartbeat).
    private static TimeSpan ParseSeconds(string name, double fallbackSeconds, double minimumSeconds)
    {
        var raw = Environment.GetEnvironmentVariable(name);
        // A parsed value is floored at minimumSeconds (a too-small override is clamped, not silently
        // swapped for the default); only a missing/unparseable value falls back to fallbackSeconds.
        var seconds = double.TryParse(raw, NumberStyles.Float, CultureInfo.InvariantCulture, out var value)
            ? Math.Max(value, minimumSeconds)
            : fallbackSeconds;
        return TimeSpan.FromSeconds(seconds);
    }

    private static long ParseBytes(string name, long fallback)
    {
        var raw = Environment.GetEnvironmentVariable(name);
        return long.TryParse(raw, NumberStyles.Integer, CultureInfo.InvariantCulture, out var bytes) && bytes > 0
            ? bytes
            : fallback;
    }

    private static int ParseInt(string name, int fallback)
    {
        var raw = Environment.GetEnvironmentVariable(name);
        return int.TryParse(raw, NumberStyles.Integer, CultureInfo.InvariantCulture, out var value) && value > 0
            ? value
            : fallback;
    }
}

namespace Haas.Hosty.TelemetryBackend;

// Runtime configuration for the telemetry backend, resolved from the environment Hosty Core injects at
// start. The backend runs as a service inside the telemetry-backend system app alongside the otelcol
// collector; it ingests from the collector (Prometheus scrape + the file sinks on the shared volume)
// into an embedded SQLite store and serves a query API. See docs/features/observability-phase-2-backend.md.
internal sealed record TelemetryBackendOptions
{
    // Embedded SQLite database file. Persistent (survives restarts) — the whole point of Phase 2.
    public required string DatabasePath { get; init; }

    // The collector's Prometheus `/metrics` scrape URL (metrics ingest). Null when unset — metrics
    // ingest is then idle, which is fine for a logs/traces-only run.
    public string? MetricsScrapeUrl { get; init; }

    // The collector's file sinks on the shared volume (logs/traces ingest), tailed continuously.
    public required string LogsFilePath { get; init; }
    public required string TracesFilePath { get; init; }

    // How often the ingest loop ticks (scrape + tail + retention prune). Kept short: the backend's job
    // is ingestion, so unlike Core's old 10 s poll it tails aggressively for near-real-time freshness.
    public TimeSpan IngestInterval { get; init; } = TimeSpan.FromSeconds(1);

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
            MetricsScrapeUrl = FirstNonEmpty(Environment.GetEnvironmentVariable("HOSTY_TELEMETRY_METRICS_URL")),
            LogsFilePath = FirstNonEmpty(Environment.GetEnvironmentVariable("HOSTY_TELEMETRY_LOGS_FILE"))
                ?? Path.Combine(appData, "otlp-logs", "logs.jsonl"),
            TracesFilePath = FirstNonEmpty(Environment.GetEnvironmentVariable("HOSTY_TELEMETRY_TRACES_FILE"))
                ?? Path.Combine(appData, "otlp-traces", "traces.jsonl"),
            MetricsRetention = ParseDays("HOSTY_TELEMETRY_METRICS_RETENTION_DAYS", 14),
            LogsRetention = ParseDays("HOSTY_TELEMETRY_LOGS_RETENTION_DAYS", 3),
            TracesRetention = ParseDays("HOSTY_TELEMETRY_TRACES_RETENTION_DAYS", 3),
            MaxDatabaseBytes = ParseBytes("HOSTY_TELEMETRY_MAX_DB_BYTES", 1L * 1024 * 1024 * 1024),
            QueryPort = ParseInt("HOSTY_TELEMETRY_QUERY_PORT", 8080),
        };
    }

    private static string? FirstNonEmpty(params string?[] values)
        => values.FirstOrDefault(static v => !string.IsNullOrWhiteSpace(v));

    private static TimeSpan ParseDays(string name, double fallbackDays)
    {
        var raw = Environment.GetEnvironmentVariable(name);
        return double.TryParse(raw, out var days) && days > 0
            ? TimeSpan.FromDays(days)
            : TimeSpan.FromDays(fallbackDays);
    }

    private static long ParseBytes(string name, long fallback)
    {
        var raw = Environment.GetEnvironmentVariable(name);
        return long.TryParse(raw, out var bytes) && bytes > 0 ? bytes : fallback;
    }

    private static int ParseInt(string name, int fallback)
    {
        var raw = Environment.GetEnvironmentVariable(name);
        return int.TryParse(raw, out var value) && value > 0 ? value : fallback;
    }
}

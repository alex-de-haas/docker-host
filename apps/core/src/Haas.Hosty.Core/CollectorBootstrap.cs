namespace Haas.Hosty.Core;

// Constants and the canonical configuration for the Hosty telemetry collector — the OpenTelemetry
// collector that Core installs as a hidden system app (P2). The collector receives OTLP over HTTP
// from opted-in runtime apps and re-exposes it as a Prometheus text endpoint that Core scrapes in
// P3, and (P4) writes received OTLP logs as newline-delimited JSON into a file Core tails. Core owns
// the config: it is written into the collector's app-data dir at bootstrap and mounted over the
// image's default config directory, so the stock `--config /etc/otelcol-contrib/config.yaml`
// entrypoint picks it up. Embedded here (not a repo file) so a stripped binary deployment still has
// it, matching how Core inlines its other bootstrap templates. See docs/features/observability.md.
internal static class CollectorBootstrap
{
    // Stable app id of the collector system app (referenced by the supervisor bootstrap and by the
    // OTLP endpoint resolution in CoreLifecycleService).
    public const string AppId = "hosty.telemetry";

    // The collector's app-data dir is mounted here; the upstream image's default CMD reads
    // `--config /etc/otelcol-contrib/config.yaml`, so the file Core writes must land at this path.
    public const string ContainerConfigDir = "/etc/otelcol-contrib";
    public const string ConfigFileName = "config.yaml";

    // Endpoint keys the manifest declares; OTLP discovery reads the otlp-http endpoint URL.
    public const string OtlpEndpointKey = "otlp-http";
    public const string MetricsEndpointKey = "metrics";
    // The telemetry-backend service's query API endpoint (Phase 2), resolved by Core's read proxy.
    public const string QueryEndpointKey = "query";

    // OTLP-logs sink (P4). The `file` exporter writes received logs as newline-delimited OTLP/JSON
    // into a subdir of the mounted config dir, which Core reads back from the host side and tails into
    // its in-memory log store — the same "Core reads from the collector" boundary as the metrics
    // scrape, so the collector stays unprivileged (no inbound ingest endpoint on Core, no docker.sock).
    // The path is relative to the collector's app-data dir (= ContainerConfigDir inside the container).
    public const string LogsRelativeDir = "otlp-logs";
    public const string LogsFileName = "logs.jsonl";
    public const string ContainerLogsFile = ContainerConfigDir + "/" + LogsRelativeDir + "/" + LogsFileName;

    // OTLP-traces sink (traces phase): same file-exporter boundary as logs, its own subdir/file so the
    // two signals rotate independently and the tail offsets never interfere.
    public const string TracesRelativeDir = "otlp-traces";
    public const string TracesFileName = "traces.jsonl";
    public const string ContainerTracesFile = ContainerConfigDir + "/" + TracesRelativeDir + "/" + TracesFileName;

    // The telemetry backend's embedded SQLite store lives here on the same shared mount (Phase 2). Core
    // provisions it writable at bootstrap so the backend can create its database file.
    public const string StoreRelativeDir = "store";

    // Host-side path of the OTLP-logs file Core tails, derived from the apps root. Mirrors
    // CoreLifecycleService.GetAppDataPath ({appsRoot}/{appId}/data) for the collector app, so the
    // scrape loop can find the same file the bootstrap provisions without taking a CoreLifecycleService
    // dependency. The "data" segment is the app-data dir name GetAppDataPath appends.
    public static string ResolveHostLogsFilePath(string appsRoot)
        => Path.Combine(CoreDataPaths.ResolveContainedPath(appsRoot, AppId), "data", LogsRelativeDir, LogsFileName);

    // Host-side path of the OTLP-traces file Core tails; same derivation as the logs path.
    public static string ResolveHostTracesFilePath(string appsRoot)
        => Path.Combine(CoreDataPaths.ResolveContainedPath(appsRoot, AppId), "data", TracesRelativeDir, TracesFileName);

    // Core owns the collector config: (re)write it on every boot so a template change ships forward.
    // Runs after install/reconcile and before the container starts; the manifest mounts the app-data
    // dir over the image's default config directory. The sink dirs are provisioned world-writable so
    // the non-root collector can write/rotate the files Core tails from the host side, and the store
    // dir lets the telemetry backend sibling create its SQLite database on the same shared mount.
    // Attached to the collector's bootstrap descriptor by SystemAppBootstraps.FromDistribution; the
    // collector starts before OTLP-consuming apps via StartPriority so its endpoint resolves first.
    internal static async Task ProvisionAsync(CoreLifecycleService lifecycle, CancellationToken cancellationToken)
    {
        await lifecycle.WriteSystemAppDataFileAsync(AppId, ConfigFileName, ConfigYaml, cancellationToken);
        lifecycle.EnsureSystemAppDataSubdirectory(AppId, LogsRelativeDir);
        lifecycle.EnsureSystemAppDataSubdirectory(AppId, TracesRelativeDir);
        lifecycle.EnsureSystemAppDataSubdirectory(AppId, StoreRelativeDir);
    }

    // Authoritative collector config. OTLP/HTTP in (4318) → Prometheus out (9464) for metrics, and a
    // rotated newline-delimited JSON file for logs (Core tails it). Infra metrics (docker stats) and
    // console log tail (docker logs) are deliberately NOT here — Core collects those itself via its
    // host-level docker access, keeping this container unprivileged (no docker.sock mount).
    // resource_to_telemetry_conversion promotes service.name / hosty.app.id resource attributes to
    // Prometheus labels so P3/P4 can attribute each metrics series to its app; the file exporter keeps
    // the full resource so Core attributes each log record via its hosty.app.id resource attribute.
    public const string ConfigYaml = """
        # Hosty telemetry collector configuration — authored and owned by Core.
        # Do not edit in place: Core rewrites this file from CollectorBootstrap.ConfigYaml on every
        # start. See docs/features/observability.md.
        receivers:
          otlp:
            protocols:
              http:
                endpoint: 0.0.0.0:4318

        processors:
          batch: {}

        exporters:
          prometheus:
            endpoint: 0.0.0.0:9464
            resource_to_telemetry_conversion:
              enabled: true
          # OTLP logs sink (P4): newline-delimited JSON that Core tails from the mounted app-data dir.
          # Rotation bounds disk use; Core keeps only a live in-memory window, so rotated-out backups
          # are never read. flush_interval keeps records landing promptly for the ~10s tail loop.
          file:
            path: /etc/otelcol-contrib/otlp-logs/logs.jsonl
            format: json
            flush_interval: 1s
            rotation:
              max_megabytes: 8
              max_backups: 1
          # OTLP traces sink (traces phase): same file boundary as logs — Core tails the spans into its
          # in-memory trace store. A separate file keeps the two signals' rotation and tail offsets
          # independent.
          file/traces:
            path: /etc/otelcol-contrib/otlp-traces/traces.jsonl
            format: json
            flush_interval: 1s
            rotation:
              max_megabytes: 8
              max_backups: 1

        service:
          telemetry:
            metrics:
              level: none
          pipelines:
            metrics:
              receivers: [otlp]
              processors: [batch]
              exporters: [prometheus]
            logs:
              receivers: [otlp]
              processors: [batch]
              exporters: [file]
            traces:
              receivers: [otlp]
              processors: [batch]
              exporters: [file/traces]

        """;
}

namespace Haas.Hosty.Core;

// Constants and the canonical configuration for the Hosty telemetry collector — the OpenTelemetry
// collector that Core installs as a hidden system app (P2). The collector receives OTLP over HTTP
// from opted-in runtime apps and re-exposes it as a Prometheus text endpoint that Core scrapes in
// P3. Core owns the config: it is written into the collector's app-data dir at bootstrap and mounted
// over the image's default config directory, so the stock `--config /etc/otelcol-contrib/config.yaml`
// entrypoint picks it up. Embedded here (not a repo file) so a stripped binary deployment still has
// it, matching how Core inlines its other bootstrap templates. See docs/features/observability.md.
internal static class CollectorBootstrap
{
    // Stable app id of the collector system app (referenced by the supervisor bootstrap and by the
    // OTLP endpoint resolution in CoreLifecycleService).
    public const string AppId = "hosty.observability.collector";

    // The collector's app-data dir is mounted here; the upstream image's default CMD reads
    // `--config /etc/otelcol-contrib/config.yaml`, so the file Core writes must land at this path.
    public const string ContainerConfigDir = "/etc/otelcol-contrib";
    public const string ConfigFileName = "config.yaml";

    // Endpoint keys the manifest declares; OTLP discovery reads the otlp-http endpoint URL.
    public const string OtlpEndpointKey = "otlp-http";
    public const string MetricsEndpointKey = "metrics";

    // Authoritative collector config. OTLP/HTTP in (4318) → Prometheus out (9464). Infra metrics
    // (docker stats) and log tail are deliberately NOT here — Core collects those itself via its
    // host-level docker access in P3, keeping this container unprivileged (no docker.sock mount).
    // resource_to_telemetry_conversion promotes service.name / hosty.app.id resource attributes to
    // Prometheus labels so P3/P4 can attribute each series to its app.
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
          debug:
            verbosity: basic

        service:
          telemetry:
            metrics:
              level: none
          pipelines:
            metrics:
              receivers: [otlp]
              processors: [batch]
              exporters: [prometheus]
            traces:
              receivers: [otlp]
              processors: [batch]
              exporters: [debug]

        """;
}

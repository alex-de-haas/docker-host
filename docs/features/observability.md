# Feature: Observability (telemetry collection)

## Goal

Collect telemetry **from hosted runtime apps** and surface it in Shell, without making Core itself an
observability backend. Apps are the OpenTelemetry producers; an OTel collector aggregates their OTLP
push and re-exposes it for Core to read; Core is the read boundary; Shell is the (later) read-only UI.

This page documents **phases P2, P3, and P4**. P2 is the push path (apps → collector); P3 is Core
scraping that into an in-memory store, adding Core-collected container infra metrics, and serving a
metrics read API; **P4 adds OTLP-logs support** (collector `logs` pipeline → Core tails the records
into their own store → read API) **and the Shell Observability tab** (per-app metric charts + a
distinct structured OTLP-logs view). The Dashboard fleet heat-map is the remaining follow-up.

## Non-goals

- **No second dashboard.** Shell is the dashboard; Grafana/SigNoz are deliberately not used. An
  external backend (long retention, large-scale trace search) is a possible v2 swap that changes only
  *where the collector exports / where Core reads* — not Shell or the Core API.
- **No privileged collector.** The collector container is unprivileged. It does **not** mount the
  Docker socket or host log directories. Container infra metrics (`docker stats`) and log tail
  (`docker logs`) are collected by **Core itself** in P3, using the host-level Docker access it
  already has — keeping the default-installed system container free of root-equivalent access.
- **No per-app ingest authentication in v1.** The collector's OTLP port uses `expose: host`, which
  binds `0.0.0.0` (so sibling containers reach it via `host.docker.internal`) — meaning it is also
  reachable from the LAN unless the host firewall blocks it. v1 has no ingest auth and accepts the
  `service.name` spoof risk among trusted local apps; **run it on a trusted network / firewall the
  OTLP port** (default 4318) until a shared/per-app ingest secret lands. See [raw ports](raw-ports.md).
- **No localCommand OTLP.** Only the `docker` runtime injects OTLP env in v1. A docker-less host gets
  no collector and no OTLP; it degrades (in P3) to Core-collected health + process metrics + log tail.

## Architecture

```
runtime apps ──OTLP/HTTP──▶ OTel collector (Hosty system app) ──Prometheus /metrics──▶ Core ──read API──▶ Shell
  (opt-in telemetry)         unprivileged container             ──OTLP/JSON logs file──▶ (P3 metrics, P4 logs)
                                                                  + `docker stats` infra metrics (P3)
```

The collector is installed as a **hidden system app** (`hosty.observability.collector`), like the
Shell. Its manifest (`apps/collector/manifest.json`) runs the upstream
`otel/opentelemetry-collector-contrib` image with two ports:

- `otlp-http` (4318) — **host-exposed and pinned** (`expose: host`, `localPort: 4318`) so sibling
  containers, which sit on isolated per-app networks, reach it via `host.docker.internal:4318`. The
  pin keeps the advertised port stable across restarts.
- `metrics` (9464) — loopback, auto-allocated. Core scrapes it as a host process in P3.

**Core owns the collector config.** It is embedded in Core (`CollectorBootstrap.ConfigYaml`), written
into the collector's app-data dir at bootstrap, and mounted over the image's default config directory
(`/etc/otelcol-contrib`) so the stock `--config` entrypoint picks it up. The config is OTLP in →
Prometheus out for metrics (with `resource_to_telemetry_conversion` so `service.name` / `hosty.app.id`
become metric labels for P3/P4 attribution) and OTLP in → a rotated newline-delimited JSON **file** out
for logs (P4). The log file is written to a subdir of the same mounted app-data dir
(`otlp-logs/logs.jsonl`), which Core tails from the host side. Because the upstream collector image is
distroless and runs as a non-root UID (10001), Core provisions that sink dir world-writable on Unix at
bootstrap (`EnsureSystemAppDataSubdirectory`) so the container can create and rotate its log file in
the bind mount; the contents are non-secret telemetry. Traces are still accepted then dropped (`nop`).

## Enabling it

Observability is **off by default** — an install with no telemetry consumer never pulls the collector
image. Enable it with `hosty config` (persisted in `launch.env`, injected into the Core process on
`hosty core start`):

```sh
hosty config set HOSTY_OBSERVABILITY_ENABLED true
hosty core start   # or restart if already running — the flag is read only at Core startup
```

- `HOSTY_OBSERVABILITY_ENABLED` — install + run the collector (default `false`). Booleans accept
  `true/false`, `1/0`, `yes/no`, `enabled/disabled`, `on/off`; stored canonicalized to `true`/`false`.
- `HOSTY_COLLECTOR_AUTOSTART` — start the collector with the other autostart apps (default `true`).

Both are also plain Core env vars, so `export HOSTY_OBSERVABILITY_ENABLED=1` before `hosty core start`
still works (the CLI passes its environment through to Core). `hosty config` only injects a value when
it overrides Core's default, so it never clobbers such an ambient export. Two advanced overrides remain
ambient-env-only (not in `hosty config`): `HOSTY_COLLECTOR_MANIFEST_PATH` (override the bundled
`apps/collector/manifest.json`) and `HOSTY_COLLECTOR_BOOTSTRAP_RUNTIME` (default `docker`).

The collector starts **before** other autostart apps so its OTLP endpoint is resolved and persisted
before their start-time env injection reads it.

## App opt-in

An app opts in with a `telemetry` block in its manifest (additive under `app.0.1`; `docker` only):

```jsonc
"telemetry": { "enabled": true, "sampleRatio": 0.1 }
```

When the app opts in **and** the collector endpoint is available, Core injects the standard `OTEL_*`
env at docker run (see `DockerRuntimeAdapter.BuildTelemetryEnvironment`), so any OpenTelemetry SDK
exports with no app-specific wiring:

- `OTEL_EXPORTER_OTLP_ENDPOINT` — the collector OTLP origin, loopback-rewritten to
  `host.docker.internal:<port>` (same rewrite as `HOSTY_CORE_ORIGIN`).
- `OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf`
- `OTEL_SERVICE_NAME=<app id>`; `OTEL_RESOURCE_ATTRIBUTES=service.name=…,hosty.app.id=…,hosty.app.service=…`
- `OTEL_TRACES_SAMPLER=parentbased_traceidratio` with `OTEL_TRACES_SAMPLER_ARG=<sampleRatio>`.

The collector's presence is the gate: when observability is off it is never installed, the endpoint
resolves to null, and **no `OTEL_*` env is injected** — apps must degrade gracefully and emit nothing.

## Core read boundary (P3): scrape, infra metrics, read API

P3 makes Core the queryable read boundary. There is no external backend in v1 — Core itself plays the
"storage" role, turning the collector's push stream into something range-queryable.

**In-memory metric store.** `IMetricStore` (`InMemoryMetricStore`) holds a bounded rolling window of
metric points per `(app, series)` — a 1-hour window, capped per series and per app. It is **pure
in-memory with no persistence**: a Core restart drops the window, which is acceptable for a live
metrics view. The interface is the seam for a later durable swap (e.g. `Microsoft.Data.Sqlite`); v1
keeps Core framework-only.

**Two collectors feed the store, on a ~10s `TelemetryScrapeService` loop** (gated behind
`HOSTY_OBSERVABILITY_ENABLED`; it no-ops when off):

1. **App metrics** — Core scrapes the collector's loopback Prometheus `/metrics` (a host process
   reaching the auto-allocated loopback port), parses the exposition text, and attributes each series
   to its app via the promoted `hosty_app_id` label (then drops that label, since the series is keyed
   by app). These only flow for apps that opted into telemetry and export OTLP metrics.
2. **Container infra metrics** — Core runs `docker stats` itself (its host-level Docker access),
   attributing each container to its app/service via the `hosty.app.id` / `hosty.app.service` labels
   Core already stamps at run, and records `container.cpu.percent`, `container.memory.bytes`,
   `container.memory.percent` (labelled with `service`). This is the **universal baseline**: it works
   for every running container regardless of instrumentation, and keeps the collector unprivileged.

**Read API.** `GET /api/apps/{id}/metrics?range=<seconds>` (admin session; `range` default 300,
clamped to the 1-hour window) returns the app's series — name, labels, and timestamped points — over
the window. A `/control/v1/...` twin exists for the CLI admin plane. The endpoint never fails on "no
data": observability off, no telemetry, or a stopped app all return an empty series list.

**Console logs** are served by `GET /api/apps/{id}/logs` (`docker logs` tail) and are unchanged. So P3
adds exactly one new read surface: metrics.

## OTLP logs read boundary (P4): collector file → Core tail → read API

P4 adds the second read surface: structured OTLP logs, kept in their **own store, separate from the
console (`docker logs`) stream**. The collector's `logs` pipeline writes received OTLP logs as
newline-delimited OTLP/JSON to its sink file; Core's `TelemetryScrapeService` tail loop reads the
newly-appended lines each tick (`FileLogTailReader` resumes from a byte offset, aligns to whole lines,
and resets on rotation), parses them with a tolerant `JsonDocument` walker (`OtlpLogsJsonParser`),
attributes each record to its app via the `hosty.app.id` resource attribute, and records it in an
in-memory `ILogStore` (`InMemoryLogStore`) — the logs analogue of the metric store (bounded 1-hour
rolling window, per-app cap, no persistence, the same durable-swap seam).

**Read API.** `GET /api/apps/{id}/otlp-logs?range=<seconds>&severity=<minNumber>&limit=<n>` (admin
session; a `/control/v1/...` twin exists) returns the app's structured records — timestamp, severity
(number + text), body, attributes, and trace/span ids — over the window. Like the metrics endpoint it
never fails on "no data". This stays addressable independently from `…/logs` end to end.

## Logs: two separate streams (console vs OTLP)

Hosty keeps **two log streams that are never merged** — they have different shapes, sources, and
audiences:

1. **Console logs** (`docker logs` stdout/stderr). Collected by **Core** (P3), zero instrumentation,
   captures *every* app including ones that know nothing about OpenTelemetry. Plain text lines, no
   severity/attributes, no trace correlation. This is the universal baseline.
2. **OTLP logs** (OpenTelemetry logs signal). **Opt-in** via the app's OTel logs SDK/appender.
   Structured records with severity + attributes and — the reason to bother — `trace_id` / `span_id`
   correlation, so a log line links to its span. Only flows for apps that wire a logs SDK.

**Transport is already automatic.** The `OTEL_EXPORTER_OTLP_ENDPOINT` we inject is the *base* OTLP
endpoint, which every OTel SDK uses for all three signals (`/v1/traces`, `/v1/metrics`, `/v1/logs`).
So an app that wants OTLP logs only has to enable its language's logs SDK — no extra Hosty env or
manifest field beyond `telemetry.enabled`.

**Receiving and surfacing OTLP logs shipped in P4** (file-tail-from-collector, the shape the plan
anticipated):

- The collector now has a `logs` pipeline (OTLP → `file`), so OTLP logs are accepted and persisted to
  the sink file Core tails.
- Core keeps them in `ILogStore`, separate from the `docker logs` console stream, and serves them at
  `GET /api/apps/{id}/otlp-logs`.
- Shell shows them in the Observability tab as a **distinct, structured view** (severity filters,
  trace-id chips, attribute chips), *never* interleaved with the console-log (`LogsPanel`) view.

The two streams stay addressable independently end to end (`…/logs` vs `…/otlp-logs`).

## Shell Observability tab (P4)

A per-app **Observability** view (Installed Apps → app action menu) renders both read surfaces:

- **Metrics** — recharts area charts, one per series, with a 5m/15m/1h range selector. CPU/memory
  series are titled and unit-formatted (% / bytes). Backed by `GET …/metrics`.
- **OTLP logs** — a severity-filterable (All / Info+ / Warn+ / Error+) structured table with severity
  badges, trace-id chips, and attribute chips, newest-first. Backed by `GET …/otlp-logs`, and kept
  visually distinct from the console-log `LogsPanel`.

Both show informative empty states when observability is disabled or the app has emitted nothing. The
Dashboard **fleet heat-map** is deferred to a focused follow-up (it wants a Core fleet-summary
endpoint to avoid N per-app calls).

## Key code

- `apps/collector/manifest.json` — collector system-app manifest.
- `apps/core/src/Haas.Hosty.Core/CollectorBootstrap.cs` — app id, container paths, the owned config.
- `EnsureCollectorInstalledAsync` (`HostyCoreApplication.cs`) — install + config write + autostart.
- `RuntimeTelemetrySettings.FromManifest` / `RuntimeAppTelemetryManifest` (`RuntimeAppManifest.cs`).
- `ResolveTelemetryEndpointAsync` (`CoreLifecycleService.cs`) — per-start endpoint resolution.
- `DockerRuntimeAdapter.BuildTelemetryEnvironment` (`RuntimeAppManifest.cs`) — `OTEL_*` injection.
- `MetricStore.cs` — `IMetricStore` + `InMemoryMetricStore` rolling-window store (P3).
- `LogStore.cs` — `ILogStore` + `InMemoryLogStore` rolling-window OTLP-log store (P4).
- `PrometheusTextParser.cs` / `DockerStatsParser.cs` — exposition-format and `docker stats` parsers (P3).
- `OtlpLogsJsonParser.cs` — tolerant OTLP/JSON logs parser for the collector file output (P4).
- `TelemetryScrapeService.cs` — the ~10s loop that fills the stores; metrics scrape + `docker stats`
  (P3) + the `FileLogTailReader` OTLP-logs tail (P4).
- `CoreLifecycleService.GetMetricsAsync` / `GetOtlpLogsAsync` + the `…/metrics` and `…/otlp-logs`
  endpoints in `LifecycleEndpoints.cs` (P3/P4).
- `apps/shell/src/app/shell/dialogs/observability-panel.tsx` — the Shell Observability tab (P4).

## Roadmap (later phases)

- **P3 (done)** — Core scrapes the collector `/metrics` into an in-memory `IMetricStore` and collects
  container infra metrics (`docker stats`) itself; read API `GET /api/apps/{id}/metrics?range`.
- **P4 (done)** — **OTLP-logs support**: a `logs` pipeline in the collector config (OTLP → `file`),
  a Core tail path (`FileLogTailReader` → `OtlpLogsJsonParser` → `ILogStore`) that stores OTLP logs as
  their **own stream separate from the console (`docker logs`) stream**, read API
  `GET /api/apps/{id}/otlp-logs?range&severity&limit`; **plus the Shell Observability tab** — per-app
  metric charts and a distinct, structured OTLP-logs view (severity filters, trace-id chips), never
  interleaved with console logs.
- **Later** — the Dashboard **fleet heat-map** (+ a Core fleet-summary endpoint); traces (a real sink
  replacing `nop` + a `…/traces` read surface); per-app OTLP ingest auth; localCommand OTLP; external
  backend (SigNoz / Prometheus + Tempo + Loki) swap (changes only where the collector exports / where
  Core reads).

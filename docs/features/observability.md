# Feature: Observability (telemetry collection)

## Goal

Collect telemetry **from hosted runtime apps** and surface it in Shell, without making Core itself an
observability backend. Apps are the OpenTelemetry producers; an OTel collector aggregates their OTLP
push and re-exposes it for Core to read; Core is the read boundary; Shell is the (later) read-only UI.

This page documents **phases P2 and P3** — the collection path and Core's read boundary. It is
plumbing plus a Core HTTP API: there is still no user-visible UI (that is P4, the Shell Observability
tab). P2 is the push path (apps → collector); P3 is Core scraping that into an in-memory store, adding
Core-collected container infra metrics, and serving a metrics read API.

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
runtime apps ──OTLP/HTTP──▶ OTel collector (Hosty system app) ──Prometheus /metrics──▶ Core ──read API──▶ Shell (P4)
  (opt-in telemetry)         unprivileged container               scraped by Core (P3)
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
Prometheus out (with `resource_to_telemetry_conversion` so `service.name` / `hosty.app.id` become
metric labels for P3/P4 attribution).

## Enabling it

Observability is **off by default** — an install with no telemetry consumer never pulls the collector
image. Enable it on the host:

- `HOSTY_OBSERVABILITY_ENABLED=1` — install + run the collector (default `false`).
- `HOSTY_COLLECTOR_MANIFEST_PATH` — override the bundled `apps/collector/manifest.json`.
- `HOSTY_COLLECTOR_BOOTSTRAP_RUNTIME` — default `docker`.
- `HOSTY_COLLECTOR_AUTOSTART` — default `true`.

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

**Console logs** are already served by `GET /api/apps/{id}/logs` (`docker logs` tail) and are
unchanged by P3. **Traces** are still dropped at the collector (`nop`) so there is no trace store to
read yet, and **OTLP logs** are not collected yet — both are P4. So P3 adds exactly one new read
surface: metrics.

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

**Receiving and surfacing OTLP logs is P4 work**, not done yet:

- The collector has **no `logs` pipeline** today (only `metrics` → Prometheus and `traces` → `nop`),
  so OTLP logs sent now are not accepted.
- Core has no logs read path, and Shell has no view for them.

P4 will add: a `logs` pipeline in the collector config → a Core ingest path that keeps OTLP logs in
their **own store/stream, separate from the `docker logs` console stream** (the file-tail-from-collector
model already planned for traces is the likely shape) → a Shell surface that shows OTLP logs as a
**distinct, structured view** (severity/attribute filters, trace links), *never* interleaved into the
console-log view. The two streams stay addressable independently end to end.

## Key code

- `apps/collector/manifest.json` — collector system-app manifest.
- `apps/core/src/Haas.Hosty.Core/CollectorBootstrap.cs` — app id, container paths, the owned config.
- `EnsureCollectorInstalledAsync` (`HostyCoreApplication.cs`) — install + config write + autostart.
- `RuntimeTelemetrySettings.FromManifest` / `RuntimeAppTelemetryManifest` (`RuntimeAppManifest.cs`).
- `ResolveTelemetryEndpointAsync` (`CoreLifecycleService.cs`) — per-start endpoint resolution.
- `DockerRuntimeAdapter.BuildTelemetryEnvironment` (`RuntimeAppManifest.cs`) — `OTEL_*` injection.
- `MetricStore.cs` — `IMetricStore` + `InMemoryMetricStore` rolling-window store (P3).
- `PrometheusTextParser.cs` / `DockerStatsParser.cs` — exposition-format and `docker stats` parsers (P3).
- `TelemetryScrapeService.cs` — the ~10s scrape/collect loop that fills the store (P3).
- `CoreLifecycleService.GetMetricsAsync` + the `…/metrics` endpoints in `LifecycleEndpoints.cs` (P3).

## Roadmap (later phases)

- **P3 (done)** — Core scrapes the collector `/metrics` into an in-memory `IMetricStore` and collects
  container infra metrics (`docker stats`) itself; read API `GET /api/apps/{id}/metrics?range`.
  Console logs are served by the pre-existing `…/logs` endpoint; traces (`nop`) and OTLP logs are not
  yet stored, so no `…/traces` or OTLP-`…/logs` read surface exists yet (both P4).
- **P4** — Shell Observability tab + fleet heat-map; **plus OTLP-logs support**: a `logs` pipeline in
  the collector config, a Core ingest path that stores OTLP logs as their **own stream separate from
  the console (`docker logs`) stream**, and a distinct structured Shell view for them (severity /
  attribute filters, trace-id links) that is never interleaved with console logs.
- **Later** — per-app OTLP ingest auth; localCommand OTLP; external backend (SigNoz / Prometheus +
  Tempo + Loki) swap (changes only where the collector exports / where Core reads).

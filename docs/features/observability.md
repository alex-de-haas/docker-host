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
- **No OTLP without a collector.** The collector is itself a docker app, so a fully docker-less host
  has no collector and no OTLP — it degrades to Core-collected health + process metrics + log tail.
  When the collector *is* running, both `docker` and `localCommand` apps export to it (the localCommand
  process runs on the host and reaches the collector's host-published port via the loopback endpoint).

## Architecture

```
runtime apps ──OTLP/HTTP──▶ OTel collector (Hosty system app) ──Prometheus /metrics──▶ Core ──read API──▶ Shell
  (opt-in telemetry)         unprivileged container             ──OTLP/JSON logs file──▶ (P3 metrics, P4 logs)
                                                                  + `docker stats` infra metrics (P3)
```

The collector is installed as a **hidden system app** (`hosty.telemetry`), like the
Shell. Its manifest (`apps/telemetry/manifest.json`) runs the upstream
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
for logs (P4) and traces (P6, a separate file so the two signals rotate independently). The sink files
are written to subdirs of the same mounted app-data dir (`otlp-logs/logs.jsonl`,
`otlp-traces/traces.jsonl`), which Core tails from the host side. Because the upstream collector image
is distroless and runs as a non-root UID (10001), Core provisions those sink dirs world-writable on
Unix at bootstrap (`EnsureSystemAppDataSubdirectory`) so the container can create and rotate its files
in the bind mount; the contents are non-secret telemetry.

## Enabling it

Observability is **off by default** — an install with no telemetry consumer never pulls the collector
image. Enable it with `hosty config` (persisted in `launch.env`, injected into the Core process on
`hosty core start`):

```sh
hosty config set HOSTY_OBSERVABILITY_ENABLED true
hosty core start   # or restart if already running — the flag is read only at Core startup
```

- `HOSTY_OBSERVABILITY_ENABLED` — install + run the collector (default `false`).
- `HOSTY_COLLECTOR_AUTOSTART` — start the collector with the other autostart apps (default `true`).
- `HOSTY_COLLECTOR_MANIFEST_PATH` — where Core reads the collector manifest (default: the
  `apps/telemetry/manifest.json` published from this repo on GitHub `main`). A **standalone installed
  Core has no repo layout on disk**, so this remote default is what lets it bootstrap the collector at
  all — without it the bootstrap is skipped (`"no collector manifest path was configured"`). Override
  with a local path or a different URL for a fork / air-gapped mirror.

The two **boolean** toggles accept `true/false`, `1/0`, `yes/no`, `enabled/disabled`, `on/off` when set
via `hosty config` and are stored canonicalized to `true`/`false`. Note this wider token set is a
`hosty config` convenience: Core's own env-var parsing only treats `1`, `true`, `enabled`, `yes` as
truthy, so if you export a boolean **directly** prefer one of those (e.g.
`export HOSTY_OBSERVABILITY_ENABLED=1`). The manifest path is a string, not a boolean.

All three are also plain Core env vars, so a direct `export … ` before `hosty core start` works too (the
CLI passes its environment through to Core). Injection precedence differs by kind. The **boolean**
toggles are injected into the Core process **only when they differ from Core's default**, so one left at
its default does not touch an ambient export (a non-default value *is* injected and takes precedence).
The **manifest path** (like `HOSTY_SHELL_MANIFEST_PATH`) is injected whenever non-empty — including its
default — which is exactly what lets an installed Core find the collector manifest; consequently a
configured or default path takes precedence over an ambient `export HOSTY_COLLECTOR_MANIFEST_PATH`. One
advanced override stays ambient-env-only (not in `hosty config`): `HOSTY_COLLECTOR_BOOTSTRAP_RUNTIME`
(default `docker`).

The collector starts **before** other autostart apps so its OTLP endpoint is resolved and persisted
before their start-time env injection reads it.

## App opt-in

An app opts in with a `telemetry` block in its manifest (additive under `app.0.1`; `docker` and
`localCommand`):

```jsonc
"telemetry": { "enabled": true, "sampleRatio": 0.1 }
```

When the app opts in **and** the collector endpoint is available, Core injects the standard `OTEL_*`
env at start (the docker adapter at docker-run, the localCommand adapter into the child process env;
both share `RuntimeTelemetrySettings.BuildEnvironment`), so any OpenTelemetry SDK exports with no
app-specific wiring:

- `OTEL_EXPORTER_OTLP_ENDPOINT` — the collector OTLP origin. For a **docker** app the loopback host is
  rewritten to `host.docker.internal:<port>` (same rewrite as `HOSTY_CORE_ORIGIN`); a **localCommand**
  app runs on the host and gets the loopback origin unchanged.
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

## Traces read boundary (P6): collector file → Core tail → read API

Traces reuse the exact P4 shape — the collector's `traces` pipeline (formerly a `nop` sink) writes
received OTLP spans as newline-delimited OTLP/JSON to its own sink file (`otlp-traces/traces.jsonl`);
Core's `TelemetryScrapeService` tails it each tick with the same reader (`FileLogTailReader`, its own
byte offset), parses spans with a tolerant walker (`OtlpTracesJsonParser`, sharing the low-level
OTLP/JSON readers with the logs parser via `OtlpJsonParsing`), attributes each span to its app via the
`hosty.app.id` resource attribute, and records it in an in-memory `ITraceStore` (`InMemoryTraceStore`)
— the spans analogue of the log store (bounded 1-hour rolling window, per-app span cap, no
persistence, the same durable-swap seam). Spans keep OTLP nanosecond precision in the store; the read
API converts to fractional unix-milliseconds (raw nanos exceed the JS safe-integer range).

**Read API.** The read surface is **fleet-shaped from the start** — a distributed trace's spans can
come from several apps, so unlike metrics/logs there is no per-app twin:

- `GET /api/observability/traces?range=<seconds>&limit=<n>&apps=<csv>&q=<substring>` (admin session;
  `/control/v1` twin) groups the window's spans by trace id across all installed apps (or the `apps`
  filter) into summaries — root span name/kind/app (falling back to the earliest span for a partial
  trace, flagged via `hasRootSpan`), wall-clock start + duration, span/error counts, and the
  contributing apps — ordered newest-first and capped to `limit` **traces**. `q` matches the root name
  or trace id, case-insensitively.
- `GET /api/observability/traces/{traceId}` (admin session; `/control/v1` twin) returns every stored
  span of one trace merged across apps, each tagged with its source app, ordered by start time. An
  unknown or aged-out trace id yields an empty span list, never a 404.

Like the other telemetry reads, both endpoints never fail on "no data".

## Shell Observability tab (P4, superseded)

P4 originally shipped a **per-app** Observability tab (recharts metric charts + a structured OTLP-logs
table) plus a console **Logs** tab in the Installed Apps app-action dialog. Both per-app dialog tabs
were later **removed** in favour of the cross-resource Observability **section** below — the same read
surfaces, but host-wide with a resource selector, so the per-app popups were pure duplication. The
Dashboard **fleet heat-map** remains deferred.

## Shell Observability section (cross-resource)

Shell has a first-class **Observability** group in the sidebar (host-admin only), modelled on the .NET
Aspire dashboard. Three top-level destinations, each its own route under `/observability` (a "Resources"
overview was dropped — Installed Apps already covers it):

- **Metrics** (`/observability/metrics`) — a resource selector (All / one app) + 5m/15m/1h range; charts
  reuse the same `MetricSeriesCard`, fanned out over `GET …/metrics` per selected app.
- **Console logs** (`/observability/console`) — a resource selector + the `docker logs` tail
  (`GET …/logs`), kept strictly separate from the OTLP stream.
- **Structured logs** (`/observability/logs`) — OTLP log records merged across **all** resources into one
  searchable, severity-filterable stream, backed by the new fleet endpoint below.
- **Traces** (`/observability/traces`, P6) — recent traces across all resources (resource filter +
  5m/15m/1h range + name/trace-id search) via `GET /api/observability/traces`; selecting a trace opens
  an indented **span waterfall** (`GET …/traces/{traceId}`): per-app accent colors, offset/width bars
  over the trace envelope, error highlighting, and click-to-expand span attributes.

The per-app dialog Observability/Logs tabs were removed (they duplicated this section); the shared
`MetricSeriesCard` / `OtlpLogTable` components now back only the section pages. Cross-resource metrics
and console logs deliberately fan out the existing per-app endpoints (no aggregation value in a fleet
endpoint there — the in-memory stores are per-app keyed and charts render per app anyway). Only the
structured-logs view needs server-side composition (a single time-merged, globally-ordered,
globally-capped stream), so it gets one new endpoint.

**Fleet read API.** `GET /api/observability/logs?range=<seconds>&severity=<minNumber>&limit=<n>&apps=<csv>&q=<substring>`
(admin session; `/control/v1` twin) merges OTLP log records across all installed apps (or the `apps`
filter), applies the severity floor + a case-insensitive `q` body search, orders chronologically, and
caps to the most recent `limit` **across apps**. Each record is tagged with its source `appId` +
`appName` (the stored `OtlpLogRecord` carries neither — attribution happens at the service layer by
iterating `ListAppRecordsAsync` and querying `ILogStore` per app). Best-effort: an unknown id in `apps`
is skipped, never a 404. `ILogStore` is unchanged — the cross-app composition lives in
`CoreLifecycleService.GetFleetOtlpLogsAsync`.

## Key code

- `apps/telemetry/manifest.json` — collector system-app manifest.
- `apps/core/src/Haas.Hosty.Core/CollectorBootstrap.cs` — app id, container paths, the owned config.
- `EnsureCollectorInstalledAsync` (`HostyCoreApplication.cs`) — install + config write + autostart.
- `RuntimeTelemetrySettings.FromManifest` / `RuntimeAppTelemetryManifest` (`RuntimeAppManifest.cs`).
- `ResolveTelemetryEndpointAsync` (`CoreLifecycleService.cs`) — per-start endpoint resolution.
- `DockerRuntimeAdapter.BuildTelemetryEnvironment` (`RuntimeAppManifest.cs`) — `OTEL_*` injection.
- `MetricStore.cs` — `IMetricStore` + `InMemoryMetricStore` rolling-window store (P3).
- `LogStore.cs` — `ILogStore` + `InMemoryLogStore` rolling-window OTLP-log store (P4).
- `TraceStore.cs` — `ITraceStore` + `InMemoryTraceStore` rolling-window span store (P6).
- `PrometheusTextParser.cs` / `DockerStatsParser.cs` — exposition-format and `docker stats` parsers (P3).
- `OtlpLogsJsonParser.cs` / `OtlpTracesJsonParser.cs` — tolerant OTLP/JSON parsers for the collector
  file output (P4/P6), sharing the low-level readers in `OtlpJsonParsing.cs`.
- `TelemetryScrapeService.cs` — the ~10s loop that fills the stores; metrics scrape + `docker stats`
  (P3) + the `FileLogTailReader` OTLP-logs/-traces tails (P4/P6).
- `CoreLifecycleService.GetMetricsAsync` / `GetOtlpLogsAsync` / `GetFleetOtlpLogsAsync` /
  `GetFleetTracesAsync` / `GetTraceAsync` + the `…/metrics`, `…/otlp-logs`,
  `/api/observability/logs`, and `/api/observability/traces[/{traceId}]` endpoints in
  `LifecycleEndpoints.cs`.
- `apps/shell/src/app/shell/observability/` — shared `MetricSeriesCard` + `OtlpLogTable` components
  (extracted from the removed per-app `observability-panel.tsx`; now used only by the section pages).
- `apps/shell/src/app/shell/pages/observability/` — the cross-resource Metrics / Console logs /
  Structured logs / Traces pages; routed via `apps/shell/src/app/observability/*` + `shell-routes.ts`.

## Roadmap (later phases)

- **P3 (done)** — Core scrapes the collector `/metrics` into an in-memory `IMetricStore` and collects
  container infra metrics (`docker stats`) itself; read API `GET /api/apps/{id}/metrics?range`.
- **P4 (done)** — **OTLP-logs support**: a `logs` pipeline in the collector config (OTLP → `file`),
  a Core tail path (`FileLogTailReader` → `OtlpLogsJsonParser` → `ILogStore`) that stores OTLP logs as
  their **own stream separate from the console (`docker logs`) stream**, read API
  `GET /api/apps/{id}/otlp-logs?range&severity&limit`; **plus the Shell Observability tab** — per-app
  metric charts and a distinct, structured OTLP-logs view (severity filters, trace-id chips), never
  interleaved with console logs.
- **P5 (done)** — the cross-resource **Observability section** in Shell (Aspire-style): Metrics /
  Console logs / Structured logs as first-class destinations, reusing the per-app read surfaces, plus
  one new fleet endpoint `GET /api/observability/logs` for cross-app structured-logs search/merge.
  (A "Resources" overview was considered but dropped — Installed Apps already covers it.) Traces
  deliberately out of scope.
- **P6 (done)** — **traces**: a real collector sink replacing `nop` (`file/traces` →
  `otlp-traces/traces.jsonl`), a Core tail path (`FileLogTailReader` → `OtlpTracesJsonParser` →
  `ITraceStore`), fleet read APIs `GET /api/observability/traces` (trace summaries) +
  `GET /api/observability/traces/{traceId}` (span detail), and the Shell **Traces** page — a
  cross-resource trace list opening into a span waterfall.
- **Later** — the Dashboard **fleet heat-map** (+ a Core fleet-summary endpoint); per-app OTLP ingest
  auth; trace→log correlation links in the UI (the data is already there: OTLP log records carry
  trace/span ids); external backend (SigNoz / Prometheus + Tempo + Loki) swap (changes only where the
  collector exports / where Core reads).

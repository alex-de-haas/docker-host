# Feature: Observability (telemetry collection)

## Goal

Collect telemetry **from hosted runtime apps** and surface it in Shell, without making Core itself an
observability backend. Apps are the OpenTelemetry producers; an OTel collector aggregates their OTLP
push and re-exposes it for Core to read; Core is the read boundary; Shell is the (later) read-only UI.

This page documents **phase P2** — the collection path. It is plumbing: with P2 alone there is no
user-visible UI yet. P3 adds Core's scrape + read API and Core-collected infra metrics/logs; P4 adds
the Shell Observability tab.

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
runtime apps ──OTLP/HTTP──▶ OTel collector (Hosty system app) ──Prometheus /metrics──▶ Core (P3) ──▶ Shell (P4)
  (opt-in telemetry)         unprivileged container               scraped by Core
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

## Key code

- `apps/collector/manifest.json` — collector system-app manifest.
- `apps/core/src/Haas.Hosty.Core/CollectorBootstrap.cs` — app id, container paths, the owned config.
- `EnsureCollectorInstalledAsync` (`HostyCoreApplication.cs`) — install + config write + autostart.
- `RuntimeTelemetrySettings.FromManifest` / `RuntimeAppTelemetryManifest` (`RuntimeAppManifest.cs`).
- `ResolveTelemetryEndpointAsync` (`CoreLifecycleService.cs`) — per-start endpoint resolution.
- `DockerRuntimeAdapter.BuildTelemetryEnvironment` (`RuntimeAppManifest.cs`) — `OTEL_*` injection.

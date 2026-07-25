# Feature: Observability (telemetry collection, storage, and UI)

Created: 2026-06-28
Updated: 2026-07-25

Runtime apps export OpenTelemetry to a collector; a Hosty-native **telemetry backend** stores the
three signals in embedded SQLite and serves a query API; a **telemetry UI** system app renders
Metrics / Structured logs / Traces. All three run as services of one installable system app,
`hosty.telemetry`.

Core is **not** on the telemetry read path. It contributes only what needs host Docker access —
`docker stats` infra metrics, re-exposed as a Prometheus endpoint the backend scrapes, and the
on-demand `docker logs` console tail Shell shows per app — plus the lifecycle and wiring that hands
every producer its endpoint.

## Non-goals

- **No second dashboard.** Grafana / SigNoz are deliberately not used; the platform's own UI renders
  the data.
- **No external OSS telemetry stack.** A TSDB stores only metrics, so adopting one re-lands the
  three-component (Prometheus + Tempo + Loki) deployment this design rejects. One SQLite covers all
  three signals behind one query API.
- **No privileged telemetry container.** Neither the collector nor the backend mounts the Docker
  socket or host log directories. Infra metrics and console logs come from Core precisely so the
  default-installed system app stays free of root-equivalent access.
- **No OTLP without a collector.** The collector is a docker service, so a fully docker-less host has
  no collector and no OTLP — it degrades to Core's health, process metrics, and console log tail.
  When the collector *is* running, both `docker` and `localCommand` apps export to it (a
  `localCommand` process runs on the host and reaches the collector's host-published port over
  loopback).
- **Console logs are not stored.** Docker already retains and rotates them; they are read on demand
  and never duplicated into the backend's database.

## Architecture

```text
                             ┌───────────── hosty.telemetry (one system app) ─────────────┐
runtime apps ──OTLP/HTTP────▶│ collector (otelcol)                                        │
  (opt-in telemetry)         │   ├─ Prometheus /metrics ─────────scrape────▶ backend      │
                             │   └─ file sinks: logs.jsonl, traces.jsonl ──tail──▶ backend│
Core ──docker stats─────────▶│ backend: embedded SQLite + query API ──────────▶ ui        │
  /api/internal/telemetry/metrics (scraped by the backend)                                │
                             └────────────────────────────────────────────────────────────┘
Core ──docker logs (on demand)──────────────────────▶ Shell per-app Console logs dialog
```

The collector is a **dumb funnel, not a store**: it has no query API, no history, no retention beyond
file rotation, and no app attribution. The backend is what turns that stream into something
range-queryable, and it owns the durability the funnel lacks.

## The telemetry system app

`apps/telemetry/manifest.json` declares a hidden `role: system` app with `provides:
["otlp-collector"]` and three services sharing one app-data mount (`/etc/otelcol-contrib`):

| Service | Image | Ports | Role |
| --- | --- | --- | --- |
| `collector` | `otel/opentelemetry-collector-contrib` | `otlp-http` 4318 (`expose: host`, pinned `localPort`), `metrics` 9464 (loopback) | receives OTLP, re-exposes metrics, writes the logs/traces file sinks |
| `backend` | `ghcr.io/alex-de-haas/hosty-telemetry-backend` | `query` 8080 | ingest loops + SQLite store + query API |
| `ui` | `ghcr.io/alex-de-haas/hosty-telemetry-ui` | `http` 3000 (`public: true`) | the Metrics / Structured logs / Traces pages |

`dependsOn` chains them (`backend` → `collector`, `ui` → `backend`), so each service receives its
sibling's intra-app URL as `HOSTY_SERVICE_<KEY>_URL`. The OTLP port is host-exposed and pinned
because sibling containers sit on isolated per-app networks and reach it via
`host.docker.internal:4318`; the pin keeps the advertised port stable across restarts.

**Core owns the collector config.** It is embedded in Core (`CollectorBootstrap.ConfigYaml`) and
mounted over the image's default config directory, so the stock `--config` entrypoint picks it up.
Core (re)writes it on the **start path**, keyed by the `otlp-collector` platform capability rather
than by app id or install path — so the collector is provisioned identically whether it arrived from
the boot bootstrap, the marketplace, or a direct `hosty apps install`. The config is OTLP in →
Prometheus out for metrics (with `resource_to_telemetry_conversion`, so `service.name` /
`hosty.app.id` become metric labels for attribution) and OTLP in → rotated newline-delimited JSON
files for logs and traces (separate files, so the two signals rotate and tail independently). Because
the upstream collector image is distroless and runs as a non-root UID, Core provisions the sink dirs
— and the backend's `store/` dir — world-writable on Unix at start
(`EnsureSystemAppDataSubdirectory`); the contents are non-secret telemetry.

## Enabling it

Observability is **off by default** — an install with no telemetry consumer never pulls the images.
The telemetry app is a distribution-list entry (`defaultEnabled: false`), so enabling it is a
bootstrap choice ([generic-bootstrap.md](../../ideas/generic-bootstrap.md)):

```sh
hosty setup --with hosty.telemetry   # or the Shell platform panel's Extensions section
```

From Shell, enabling installs and starts the app immediately; via `hosty setup` the choice applies on
the next `hosty core start`. Core's own producer follows the app: the `docker stats` exposition runs
whenever the telemetry app is installed and idles (serving empty text) otherwise, so a live enable
needs no Core restart. `HOSTY_OBSERVABILITY_ENABLED` is not a supported setting — an ambient export
is honored only as a legacy bootstrap override that enables the telemetry app.

Autostart is the normal per-app setting: the first install defaults to autostart on, and the
operator's later choice survives boots. The manifest location resolves from the distribution list;
`HOSTY_COLLECTOR_MANIFEST_PATH` and `HOSTY_COLLECTOR_BOOTSTRAP_RUNTIME` remain ambient-env-only
overrides for a fork or air-gapped mirror, not `hosty config` launch settings. The collector starts
**before** other autostart apps, so its OTLP endpoint is resolved and persisted before their
start-time env injection reads it.

## App opt-in

An app opts in with a `telemetry` block in its manifest (additive under `app.0.1`; both `docker` and
`localCommand`):

```jsonc
"telemetry": { "enabled": true, "sampleRatio": 0.1 }
```

When the app opts in **and** the collector endpoint is available, Core injects the standard `OTEL_*`
env at start (the docker adapter at docker-run, the localCommand adapter into the child process env;
both share `RuntimeTelemetrySettings.BuildEnvironment`), so any OpenTelemetry SDK exports with no
app-specific wiring:

- `OTEL_EXPORTER_OTLP_ENDPOINT` — the collector OTLP origin. For a **docker** app the loopback host is
  rewritten to `host.docker.internal:<port>` (the same rewrite as `HOSTY_CORE_ORIGIN`); a
  **localCommand** app runs on the host and gets the loopback origin unchanged.
- `OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf`
- `OTEL_SERVICE_NAME=<app id>`; `OTEL_RESOURCE_ATTRIBUTES=service.name=…,hosty.app.id=…,hosty.app.service=…`
- `OTEL_TRACES_SAMPLER=parentbased_traceidratio` with `OTEL_TRACES_SAMPLER_ARG=<sampleRatio>`.

The endpoint is the *base* OTLP URL, which every OTel SDK uses for all three signals (`/v1/metrics`,
`/v1/logs`, `/v1/traces`) — so an app that wants structured logs or traces only enables its
language's SDK, with no extra Hosty env or manifest field. **An app never learns about the backend**:
it exports to a URL Core handed it. The collector's presence is the gate — when observability is off
the endpoint resolves to null, no `OTEL_*` env is injected, and apps degrade to emitting nothing.

## Signals

**App metrics.** Apps push OTLP metrics to the collector, which re-exposes them as Prometheus text on
its loopback `metrics` port. The backend scrapes that URL (pinned in the manifest as
`HOSTY_TELEMETRY_METRICS_URL`; the `dependsOn` fallback would resolve the collector's *first* port —
the OTLP receiver — so the explicit pin is required) and attributes each series to its app via the
promoted `hosty_app_id` label, which is then dropped since the row is already keyed by app.

**Container infra metrics.** Core runs `docker stats` itself and renders a Prometheus snapshot every
10 s (`DockerStatsExposition`), attributing each container to its app/service from the `hosty.app.id`
/ `hosty.app.service` labels Core stamps at run, as `container.cpu.percent`,
`container.memory.bytes`, and `container.memory.percent`. The backend scrapes it as a **second
metrics target** at `GET /api/internal/telemetry/metrics`, so infra metrics land in the same store,
keyed the same way, as app OTLP metrics. This is the universal baseline: it works for every running
container regardless of instrumentation, and it keeps the telemetry containers unprivileged.

That endpoint **requires an app service token**, like every other app→Core route, and rejects a token
whose app is no longer installed. Any valid app token is accepted — the exposition is host-wide, so
there is no per-app scoping to enforce, and the token proves only that the caller is an installed
app. The backend presents its own `HOSTY_APP_SERVICE_TOKEN`, and only to Core — never to the
collector, which is a third-party image. Living under `/api/internal/` also places the route inside
the endpoint-authorization harness, which enumerates `/api` routes; the older `/internal` path sat in
that harness's blind spot, which is how it shipped unauthenticated for months (C-M10 in the
[2026-07-10 Core review](../../reviews/2026-07-10-core-code-review.md)). The related ingress work is
[internal-endpoint-exposure](../internal-endpoint-exposure/plan.md).

**OTLP logs** and **traces** ride the collector's `file` exporters. The backend tails each sink every
tick, resuming from a byte offset persisted in the store's `ingest_state` table (so a restart resumes
instead of replaying), aligning to whole lines and resetting on rotation, and parses the records with
tolerant OTLP/JSON walkers. Each record or span is attributed to its app via the `hosty.app.id`
resource attribute. Spans keep OTLP nanosecond precision in the store; the query API converts to
fractional unix-milliseconds, since raw nanos exceed the JS safe-integer range.

**Console logs** (`docker logs` stdout/stderr) are a separate stream that is **never merged** with
OTLP logs. Core serves them on demand from `GET /api/apps/{id}/logs` — no store, no instrumentation,
every app covered. Shell shows them in a per-app **Console logs** dialog opened from the Installed
Apps actions menu, gated on the app's `logs` capability, so minimal logs stay reachable even with the
telemetry app uninstalled or stopped. OTLP logs are the opt-in counterpart: structured records with
severity, attributes, and `trace_id` / `span_id` correlation, only for apps that wire a logs SDK.

## Store, retention, and pruning

The backend's store is **embedded SQLite** (`Microsoft.Data.Sqlite`) at
`/etc/otelcol-contrib/store/telemetry.db` on the shared app-data mount — one file, no separate server
process, surviving restarts, and covered by the app-data backup model like any other app file.

The ingest loop ticks every second for the log and trace tails, but **metrics scrape on their own
~15 s cadence**: the Prometheus exporter re-serves last values on every scrape, so scraping at the
tail cadence inserted roughly a row per series per second and collapsed retention into hours of prune
churn. A flat series is additionally skipped rather than re-inserted, with a ~60 s heartbeat so it
stays legible as live and range queries keep an anchor point.

Retention is a **per-signal age cap plus a global size ceiling** — metrics 14 days, logs and traces
3 days, ~1 GiB total, all overridable by env. Pruning runs on its own ~1-minute cadence and is
**budgeted to ~250 ms per tick**: the prune shares the ingest loop and the store lock with the tails,
so an unbounded pass starves them (on a ceiling-pinned database this produced logs arriving in 3–4
minute bursts). An in-progress pass resumes on later ticks at roughly a 25 % duty cycle.

## Query API

The backend serves appId-keyed reads on its `query` port. All of them answer 200 with an empty result
rather than failing when there is no data — observability just enabled, an app with no
instrumentation, and a stopped app all look the same:

- `GET /api/apps/{appId}/metrics?range=<seconds>` — one app's series (name, labels, timestamped points).
- `GET /api/apps/{appId}/otlp-logs?range&severity&limit` — one app's structured records.
- `GET /api/observability/logs?range&severity&limit&apps&q` — records merged across apps, with the
  severity floor and a case-insensitive body search applied, ordered chronologically and capped
  across apps.
- `GET /api/observability/traces?range&limit&apps&q` — the window's spans grouped by trace id into
  summaries (root span name/kind/app, falling back to the earliest span for a partial trace and
  flagged via `hasRootSpan`; start, duration, span/error counts, contributing apps), newest first.
- `GET /api/observability/traces/{traceId}` — every stored span of one trace, merged across apps,
  each tagged with its source app, ordered by start time. An unknown or aged-out id yields an empty
  span list, never a 404.

Traces are fleet-shaped by nature — one distributed trace's spans can come from several apps — so
unlike metrics and logs they have no per-app twin.

**This query API carries no auth today, and it is not confined to an internal-only network**: the
query port is published to host loopback and the collector's OTLP ingest port is host-exposed, so any
local process can read the fleet's telemetry, and anything that reaches the OTLP port can inject
spans or metrics attributed to any `hosty.app.id`. Run it on a trusted network and firewall the OTLP
port (4318). Closing this is tracked in [plan.md](plan.md); until then nothing here may assume a
trust boundary.

## Telemetry UI

The `ui` service is a Next.js app built on the marketplace system-app pattern. It reads **its own
backend directly**: its server routes proxy to `HOSTY_SERVICE_BACKEND_URL` and enrich the appId-keyed
payloads with display names from a generic Core app-token endpoint,
`GET /api/internal/apps/{appId}/app-directory` — a roster read any app can use, not a
telemetry-specific contract.

Its three pages (`/metrics`, `/logs`, `/traces`) appear under Shell's admin **System** nav group,
driven entirely by the manifest's `ui` block (`entrypoint` + `navigation`), exactly like Marketplace.
Shell itself contains no observability code: the section, the per-app Observability tab, and Core's
read proxy were all removed once the UI moved into the app. Console logs are the one telemetry view
that stayed in Shell, because they run off Core alone.

## Design decisions

**Why the store left Core.** Core does not consume telemetry for its own logic — it only re-served it
— while owning a store in the lifecycle kernel cost a 10 s poll latency, no persistence across
restarts, and a responsibility off-model relative to the platform's capability-provider split
([final-hosty-architecture.md](../final-hosty-architecture.md)). The fix was not "delete the store"
but "move it where it belongs": something has to be queryable, because the collector is a funnel, a
browser cannot tail `traces.jsonl` or run `docker stats`, and `container → app` attribution is
host-side knowledge.

**Why Core cannot fully exit.** Infra metrics and console logs fundamentally require host Docker
access, which only Core has, and the whole split exists to keep the telemetry containers
unprivileged. Giving the backend `docker.sock` is explicitly rejected — it re-introduces exactly the
root-equivalent access this design avoids. So Core keeps a thin producer role and loses only the
store.

**Why SQLite over a TSDB.** A TSDB natively stores only metrics (logs need Loki, traces need Tempo),
so "use a TSDB" re-lands the three-component external stack the non-goals reject; and at single-host
scale, with a ~15 s cadence and days of retention, its compression and high-cardinality advantages do
not pay for a second process, a foreign query language, and a separate ops model. SQLite is also
AOT-clean (`SQLitePCLRaw.bundle_e_sqlite3`) and backs up by copying a file. Its cost — no columnar
compression, and range-bucketing and eviction written by hand — is small here. Not chosen: a straight
in-memory lift (still loses data on restart) and DuckDB (immature .NET AOT story, weaker under
concurrent writes for a write-heavy profile). The store sits behind a store seam, so if *metrics*
volume ever outgrows it, only metrics need to move.

**Why writes go direct and reads no longer proxy.** Writes must go direct: routing every app's OTLP
through Core would re-seat Core on the high-volume data path — the exact thing this design removed —
and break the standard OTLP contract for no gain. Reads were briefly proxied through Core to reuse
its admin session gate; once the UI became a system app with its own origin and Hosty identity, the
proxy was pure indirection and was deleted. The generalized platform rule
([ai-agent-bridge.md](../ai-agent-bridge.md#authorization-and-delegation)) still holds: a thin Core
proxy is right only for admin-only, low-volume, request/response reads whose surface already lives in
Core.

**Auth model: reuse the platform's, split by direction.** Host-user auth (Core sessions) gates the
console-log read; app-service tokens gate app→Core routes, including the docker-stats exposition and
the app-directory roster; app-to-app auth is deliberately absent platform-wide
([cross-app-dependencies.md](../cross-app-dependencies.md): single-tenant homelab, all installed apps
trusted), and telemetry inherits that. The unresolved part is a **network** concern, not a token one:
ingest and the query port ride `host.docker.internal` and host-published ports, so they are
LAN-reachable, and the platform's planned shared internal-only docker network is what would make "no
auth on a trusted internal network" actually true. See [raw-ports.md](../raw-ports.md).

## Key code

- `apps/telemetry/manifest.json` — the three-service system-app manifest, endpoints, and `ui` block.
- `apps/core/src/Haas.Hosty.Core/CollectorBootstrap.cs` — app id, container paths, the owned collector
  config, and the capability provisioner.
- `apps/core/src/Haas.Hosty.Core/DockerStatsExposition.cs` — the `docker stats` producer loop and its
  Prometheus snapshot; `DockerStatsParser.cs` parses the CLI output.
- `apps/core/src/Haas.Hosty.Core/LifecycleEndpoints.cs` — `GET /api/internal/telemetry/metrics` (app
  service token required) and `GET /api/apps/{id}/logs` (console tail).
- `apps/core/src/Haas.Hosty.Core/DomainEndpoints.cs` — `GET /api/internal/apps/{appId}/app-directory`,
  the roster the UI labels appIds from.
- `RuntimeTelemetrySettings.FromManifest` / `BuildTelemetryEnvironment` (`RuntimeAppManifest.cs`) —
  manifest opt-in and `OTEL_*` injection; `ResolveTelemetryEndpointAsync` (`CoreLifecycleService.cs`)
  resolves the endpoint per start.
- `apps/telemetry-backend/src/Haas.Hosty.TelemetryBackend/` — `TelemetryBackendOptions.cs` (env
  contract, cadences, retention), `Ingest/TelemetryIngestService.cs` (scrape + tails + budgeted
  prune), `Ingest/MetricDeduplicator.cs`, `Telemetry/SqliteTelemetryStore.cs`, `Query/`, and
  `Program.cs` (the query routes).
- `apps/telemetry-ui/src/lib/backend.ts` / `roster.ts` — backend URL resolution and appId→name
  labelling; `src/app/api/**` — the UI's proxy routes; `src/app/{metrics,logs,traces}` — the pages.
- `apps/shell/src/app/shell/dialogs/app-details-dialog.tsx` — the per-app Console logs dialog, opened
  from `installed-apps-page.tsx` and gated on the `logs` capability.

## Testing Expectations

- **Collector config and bootstrap.** The provisioner writes the config and creates the logs, traces,
  and store subdirectories, keyed off the `otlp-collector` capability rather than an app id.
- **`OTEL_*` injection.** Opt-in manifests produce the full env set in both the docker
  (`host.docker.internal`) and localCommand (loopback) endpoint forms; an app that has not opted in,
  or a host with no resolvable collector endpoint, produces none.
- **Core producer.** `DockerStatsExposition` renders the three `container.*` series with app/service
  attribution, idles as empty text when the telemetry app is absent, and survives a docker-less host.
  The exposition endpoint rejects a missing, invalid, or uninstalled-app token with 401 and serves a
  valid one — the regression guard for the "internal means safe" class of mistake — and the
  endpoint-authorization harness must keep enumerating the route.
- **Backend ingest.** Prometheus parsing (including dotted metric names), OTLP/JSON log and span
  parsing, tail resumption across offsets and rotation, and the metric deduplicator's unchanged-skip
  plus heartbeat behaviour.
- **Backend store and query.** Schema init, per-signal retention and the size ceiling, prune
  resumption across budget slices, and every query shape returning an empty result — never an error —
  for unknown apps, empty windows, and unknown trace ids.

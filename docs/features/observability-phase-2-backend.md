# Observability Phase 2 — telemetry backend as a system app

Status: **2a + 2b + 2c + manifest + 2c-shell implemented (E2E live-verified); only 2d (SSE) remains.**
Successor to the shipped observability v1 (P3–P6 in [observability.md](observability.md)). This doc
records the decision to **move the telemetry store and query API out of Core** into a dedicated
telemetry-backend system app, and the boundary that keeps Core from exiting entirely.

**Implementation status.**
- **PR#1 (2a, merged)** — the standalone `Haas.Hosty.TelemetryBackend` service (`apps/telemetry-backend/`):
  embedded SQLite store + retention, ingest loops (Prometheus scrape + file tails, copied parsers), the
  appId-keyed query API mirroring Core's observability reads, Dockerfile + CI image, tests. Non-breaking.
- **PR#2 (2b + 2c + manifest)** — the Core cutover: Core exposes `docker stats` at
  `/internal/telemetry/metrics` (the backend scrapes it as a 2nd target — Prometheus, not OTLP push);
  Core's 5 read methods proxy the backend via `TelemetryBackendClient` (enriching appId→display name);
  the in-memory stores + scrape/tail loops + parsers are deleted; the collector app becomes a
  **multi-service** app (otelcol + backend, shared `/etc/otelcol-contrib` mount, `query` endpoint Core
  resolves). Console logs stay Core's on-demand `docker logs` (unchanged). E2E live-verified on a docker
  host (metrics/logs/traces render in Shell through the proxy).
- **PR#3 (2c-shell)** — Shell: console logs move out of the Observability section into a per-app
  **Console logs** action + dialog (Installed Apps actions menu, gated on the `logs` capability, reusing
  `GET /api/apps/{id}/logs`); the Observability section becomes backend-backed only (Metrics / Structured
  logs / Traces) and is hidden when the telemetry backend app is not installed/running.
- **Remaining** — 2d (SSE realtime).

## Motivation

v1 made **Core the telemetry store and query layer**: a background poller
(`TelemetryScrapeService`) fills in-memory stores (`InMemoryMetricStore`, `LogStore`, `TraceStore`) and
Core serves them over `GET /api/observability/*` and `GET /api/apps/{id}/metrics|otlp-logs`. Shell (a
browser SPA) and the CLI only ever talk to Core; they never touch the collector.

The recurring question: **why is Core the store at all?** It doesn't *consume* telemetry for its own
logic — it only re-serves it to Shell. Three real costs fall out of that:

1. **Poll latency.** `TelemetryScrapeService.ScrapeInterval` is 10 s
   ([TelemetryScrapeService.cs:154](../../apps/core/src/Haas.Hosty.Core/TelemetryScrapeService.cs)).
   Fresh data lags up to a tick. It's a cadence, not a fundamental limit — but it exists because Core
   *polls* the collector instead of receiving a push.
2. **No persistence.** The stores are in-memory (`InMemoryMetricStore`: 1 h / 720-point window). A Core
   restart drops the whole window.
3. **Store lives in the kernel.** Core is meant to be the lean lifecycle kernel; owning a telemetry
   TSDB is off-model relative to the platform's own component split (see
   [final-hosty-architecture.md](final-hosty-architecture.md): capability providers / "system apps" own
   capabilities, Core owns lifecycle).

### Why the premise "Core doesn't use the data, so drop it" is only half right

The collector is a **dumb funnel, not a store**. Its config
([CollectorBootstrap.ConfigYaml](../../apps/core/src/Haas.Hosty.Core/CollectorBootstrap.cs)) is OTLP-in →
`prometheus` exporter (a scrape endpoint) + two `file` exporters (`logs.jsonl`, `traces.jsonl`, rotation
only). It has **no query API, no history, no retention beyond file rotation, no app attribution**. So
someone *has* to be the queryable store. Today that's Core. Shell can't "just do it directly" because:

- Shell is a browser — it can't tail `traces.jsonl` on the host FS or run `docker stats`, and the
  collector exposes no query surface (its Prometheus port `9464` is loopback-only, for Core).
- **Container infra metrics (`docker stats`) and console logs (`docker logs`) are collected by Core
  itself** ([TelemetryScrapeService.cs:314](../../apps/core/src/Haas.Hosty.Core/TelemetryScrapeService.cs))
  using host-level Docker access — *specifically to keep the collector unprivileged* (no `docker.sock`).
  This data is not in the collector at all.
- **Attribution** (`container → app/service`, via the `hosty.app.*` labels Core stamps at run) is
  Core-only knowledge.
- **More than one consumer.** The CLI reads the same stores via `control/v1/observability/*`. A
  future health signal may too. A browser-only store serves none of them.

So the fix is not "delete the store" — it's "**move the store to where it belongs**": a telemetry
backend system app that owns ingest + storage + query, leaving Core as a *producer* of the
host-privileged signals only.

### Relationship to the v1 "external backend swap" non-goal

[observability.md](observability.md) already lists an "external backend (SigNoz / Prometheus + Tempo +
Loki) swap" as a later option that "changes only where the collector exports / where Core reads." **This
design is deliberately different.** We are *not* adopting an external OSS stack behind Core. We are
building a **Hosty-native telemetry backend** that takes over the store and query API — so it changes the
Shell/CLI read endpoints too, not just the collector's exporter. It also **keeps Shell as the only
dashboard** (the standing non-goal): the backend serves data, Shell renders it.

## Target architecture

```
                              ┌─────────────────────────────────────────┐
runtime apps ──OTLP/HTTP──────▶ Telemetry backend (Hosty system app)     │
  (opt-in telemetry)          │   OTLP receiver + light persistent store  │──query API──▶ Shell / CLI
                              │   (embedded SQLite) + query API           │
Core ──push (docker stats,────▶                                          │
  docker logs, attribution)   └─────────────────────────────────────────┘
```

Two moves:

1. **Promote the collector system app into a telemetry backend.** Instead of `otelcol-contrib`
   configured as a funnel, the system app becomes a service that **receives OTLP directly, stores it,
   and serves a query API.** Whether we keep `otelcol` in front (as a receiver that forwards to our
   store) or build the OTLP receiver into the service is an open question (below) — but the store +
   query API is ours.
2. **Core becomes a producer, not the store.** Core keeps only what needs host privilege — `docker
   stats` infra metrics, `docker logs` console tail, and `container → app` attribution — and **pushes**
   those into the backend (over OTLP, same as any app). Core stops owning `IMetricStore` / `LogStore` /
   `ITraceStore` and stops serving `/api/observability/*`.

### Store choice (decided): embedded SQLite

The backend store is **embedded SQLite** (`Microsoft.Data.Sqlite`) — a single file, no separate server
process, that survives restarts. This keeps the v1 spirit (no Grafana, no external TSDB, self-contained)
while fixing the "lose the window on restart" problem and giving us full control over the query API shape
Shell/CLI already expect.

**Why SQLite over a TSDB.** The real choice is *embedded single-file SQL store* vs. *purpose-built
TSDB* — and for us a TSDB means a **separate server process/image** (Prometheus, VictoriaMetrics,
InfluxDB); there is no production-grade embeddable TSDB for .NET. Two facts decide it:

1. **We have three signals** (metrics, logs, traces). A TSDB natively stores only **metrics** — logs
   need Loki, traces need Tempo — so "use a TSDB" re-lands us in the 3-component external stack this
   design's non-goal rejects. **One SQLite covers all three** with one schema and one query API.
2. **Scale doesn't need it.** Single host, ~10 s scrape cadence, hours-to-days retention, and v1
   already caps cardinality (256 series/app). A TSDB's compression / high-cardinality / long-retention
   advantages only pay off at a scale the platform isn't at — and only for metrics — while costing a
   second process, a foreign query language (PromQL), a heavier image, and its own ops model.

SQLite also fits the platform's AOT direction (`SQLitePCLRaw.bundle_e_sqlite3` is AOT-clean) and its
app-data backup model (backup = copy the file). Its cost — no columnar/time-series compression, and we
write the range-bucketing / retention-eviction logic ourselves — is small at this scale and is largely a
port of the existing `InMemoryMetricStore` windowing/`Prune`.

*Not* chosen: a TSDB / heavyweight OSS backend (metrics-only, separate process, foreign query language,
Shell/CLI rewrite); a straight in-memory lift (still loses data on restart); DuckDB (embedded columnar,
but immature .NET AOT story and weaker under concurrent writes for our write-heavy profile).

**This is not a dead end.** The store stays behind the `IMetricStore` / `ILogStore` / `ITraceStore`
seams, so if *metrics* volume ever outgrows SQLite we can move **only metrics** to a TSDB while logs and
traces stay in SQLite — the "external backend swap" escape hatch, kept open.

## The hard constraint — Core cannot fully exit

Infra metrics (`docker stats`) and console logs (`docker logs`) **fundamentally require host Docker
access**, which only Core has. The entire v1 split exists to keep the telemetry container unprivileged
(no `docker.sock`). So even in the target state, **Core retains a thin producer role**: collect the
privileged signals + attribution, push to the backend. What Core *loses* is **owning the store** (the
TSDB, aggregation, retention, the 10 s poll); it keeps a thin **read proxy** in front of the backend's
query API (see Auth & network model) so Shell/CLI keep one admin-gated endpoint.

Giving the backend `docker.sock` to collect these itself is explicitly rejected: it re-introduces the
root-equivalent access the current design was built to avoid.

## Auth & network model (decided)

Do not invent new auth — **reuse the platform's existing model, split by traffic direction.** The
platform already has three distinct auth axes, and telemetry maps cleanly onto them:

- **Host-user auth** — Core sessions + admin check. *Every* telemetry read is already gated by it: each
  `/api/observability/*` and `/api/apps/{id}/metrics|otlp-logs` route runs through
  `CoreSessionAuthorization.RequireAdminSessionAsync` (Host-admin only); the CLI uses the trusted local
  `control/v1/*` channel.
- **App-service auth** — `HOSTY_APP_SERVICE_TOKEN` (app → Core; Core resolves the calling app). Not
  needed on the telemetry data path.
- **App-to-app auth** — *deliberately none* ([cross-app-dependencies.md](cross-app-dependencies.md):
  single-tenant homelab, all installed apps trusted). Telemetry inherits this.

Applied to the backend:

1. **Ingest (writes) — runtime apps *and* Core → backend.** Reuse the collector pattern exactly: OTLP
   over the backend's OTLP port, **no auth**, trusted network. This is literally "how it's already done."
   The deferred v1 **per-app OTLP ingest auth** applies identically (collector and backend share the
   surface) and can land later for both.
2. **Query (reads) — Shell/CLI.** **Do not stand up a second authenticated endpoint.** Telemetry reads
   are already gated by Core's Host-admin session, so keep Shell → Core and CLI → `control/v1` unchanged
   and have **Core proxy** the read to the backend over the trusted internal channel. Core keeps the
   admin gating it already does and stops *owning* the store — the actual Phase 2 goal. The backend's
   query API is reachable **only by Core** (internal-network-only in the hardened topology), so it needs
   no auth of its own. *Not* chosen: making the backend a first-class discovered+authed endpoint (a
   "Hosty-aware app" doing the code-exchange/revalidate flow) — heavier, and the app-scoped identity
   model fits poorly with a fleet-wide admin view; deferrable if we ever need Core fully off the path.
3. **Core ↔ backend / backend ↔ other system apps.** Trusted internal channel, no app-to-app auth —
   consistent with the existing platform decision.

**The real follow-up is a network concern, not a token one.** Today cross-app + ingest traffic rides
`host.docker.internal` + host-published ports — i.e. it is on the host/LAN, and the no-auth ingest port
is LAN-reachable (the risk v1 already flags). The fix is the platform's **already-planned shared
internal-only docker network** (a `cross-app-dependencies.md` hardening): move ingest + the backend's
query port off the host/LAN so "no auth on a trusted internal network" actually holds. Telemetry rides
that hardening; it does not need its own.

**Generalized into a platform rule (2026-07-11,
[ai-agent-bridge.md#authorization-and-delegation](ai-agent-bridge.md#authorization-and-delegation)):**
the thin Core proxy twin is the right call only for admin-only,
low-volume, request/response reads whose surface already lives in Core — exactly this case. Anything
per-user, streaming, high-volume, or externally reachable (agent MCP traffic, the AI gateway) instead
gets a direct endpoint with a short-lived Core-issued token validated by the receiver, Core injecting
the verification key the same way it injects the OTLP endpoint. The proxy choice here stays one-way
reversible: the backend's query API is unchanged if Shell/CLI later switch to direct
token-authenticated reads (e.g. realtime tails), so starting proxied loses nothing.

## Read/write asymmetry & realtime

**Writes go direct (app → backend), reads proxy through Core — and that asymmetry is principled, not a
smell.** The framing is *control plane vs data plane*:

- **Core owns the control plane in both directions.** For writes it *injects* the OTLP endpoint —
  runtime apps receive an opaque `OTEL_EXPORTER_OTLP_ENDPOINT` (resolved fresh each start,
  `host.docker.internal`-rewritten; [RuntimeAppManifest.cs](../../apps/core/src/Haas.Hosty.Core/RuntimeAppManifest.cs)),
  so **an app never *knows about* the backend** — it exports to a URL Core handed it, exactly as it does
  for the collector today. For reads Core *authorizes + proxies*. Core stays the sole system-app wirer.
- **Only the *bytes* differ.** Writes flow direct (high-volume producer→sink, trusted network); reads
  proxy through Core (low-volume, admin-gated).

Writes *must* go direct: routing every app's OTLP through Core re-seats Core on the high-volume
telemetry data path — the exact thing Phase 2 removes — and breaks the standard OTLP contract for no
gain. This is the ordinary "open push-ingest / authenticated pull-query" split. The asymmetry already
exists today (writes app→collector, reads Shell→Core); Phase 2 only makes the write path *cleaner* (Core
leaves it entirely). "Shell hides the Observability section when the telemetry app is off" needs no
backend involvement — Core already knows system-app state from lifecycle.

**Realtime (SSE) through the Core proxy is feasible, and the pattern already exists.** Core already
serves SSE (`NotificationEndpoints` streams `text/event-stream`) and `System.Net.ServerSentEvents` is in
the AOT dependency set — so SSE-in-Core is proven and AOT-clean, not greenfield. Two shapes:

1. **Backend SSE, Core pipes it (clean end-state).** Backend exposes an SSE `/stream`; Core consumes it
   with an `SseParser` over a streaming `HttpClient` response and re-emits to Shell's `EventSource`.
   Latency ≈ backend push.
2. **Core tails the backend (simpler interim).** Core holds the admin SSE connection to Shell and emits
   deltas from a cheap ~1 s query of the backend over loopback/internal — no SSE on the backend yet.

Either way the SSE connection opens **through Core under the same admin session** as the REST reads, so
it does **not** reopen the auth question. Caveats: flush per event / no response buffering; tie upstream
cancellation to `RequestAborted`; drop on session expiry; `EventSource` auto-reconnects. At homelab
scale (one admin, a few tabs) the long-lived connection count is trivial for Kestrel.

**Do not block Phase 2 on SSE.** Phase 2 already improves freshness for free: once the backend ingests
OTLP directly (push), data is fresh within ~1 s (collector flush) vs the current 10 s Core poll — so even
light request/response polling from Shell is near-real-time. Add SSE as a later phase, highest value on
**live log/trace tail** (charts are fine on a poll).

## What moves, what stays

| Concern | v1 (today) | Phase 2 (target) |
| --- | --- | --- |
| OTLP receive | collector (funnel) | telemetry backend (receiver + store) |
| Metric/log/trace store | Core in-memory | backend, embedded persistent |
| Query API — where data lives | Core (owns store) | backend (owns store) |
| Query API — what Shell/CLI call | Core (owns + serves) | Core (thin admin-gated **proxy** → backend) |
| `docker stats` infra metrics | Core collects → Core store | Core collects → **push** (OTLP) to backend |
| `docker logs` console tail | Core `docker logs` on-demand (not stored) | **unchanged** — stays Core on-demand; **not** in the backend |
| `container → app` attribution | Core | Core (stamped at run; pushed with the signal) |
| Freshness | 10 s poll | push / near-real-time |
| Persistence | none (lost on restart) | survives restart |
| Shell Observability section | Metrics / Console logs / Structured logs / Traces | Metrics / Structured logs / Traces (**backend-backed only**) |
| Console logs UI | page inside the Observability section | **per-app dropdown action + dialog** (works without the backend) |

## Resolved decisions

- **Store = embedded SQLite** (over a TSDB). See Store choice above.
- **Auth = reuse, split by direction; Core proxies reads.** See Auth & network model above. No second
  authed endpoint; ingest reuses the collector's no-auth trusted-network pattern; the real follow-up is
  the shared internal-only network hardening, not new tokens. This also settles the read-path shape
  permanently (not just a migration window): Core keeps a thin admin-gated proxy, so Shell/CLI never
  change endpoints.
- **Receiver = keep `otelcol` unchanged; move Core's *existing* ingest into the backend.** Do **not**
  build an OTLP receiver (there is no ready-made one in .NET; the SDK only produces). The backend
  reuses Core's three current ingest mechanisms verbatim — Prometheus scrape for metrics
  (`PrometheusTextParser`) and file-tail for logs/traces (`OtlpLogsJsonParser` /
  `OtlpTracesJsonParser`) — plus a SQLite write. So the backend is effectively "Core's tail/scrape loops
  + SQLite + query API" extracted into a service; the hard protocol handling stays in the upstream
  image. `otelcol` runs as a **service inside** the telemetry-backend system app (multi-service manifest,
  shared volume) — one installable unit. Collapsing `otelcol` into an own receiver is a possible later
  simplification, not now.
- **Privileged signals: split by signal, and the scope shrinks.**
  - `docker stats` infra metrics → Core **pushes as OTLP** to the collector, becoming just another OTLP
    producer alongside apps; the backend ingests it through the one funnel. Reuses the runtime-app OTLP
    producer pattern. Metrics belong in the store (charts need history/range).
  - `docker logs` console logs → **do not move.** They stay Core's on-demand `docker logs --tail`
    (confirmed: `CoreLifecycleService.GetLogsAsync` runs it per request, not from a store; the Shell view
    is already per-app). Docker already retains/rotates them — no reason to duplicate into SQLite. Core's
    read facade serves console logs straight from docker; only metrics/OTLP-logs/traces come from the
    backend. **Net: only metrics + OTLP logs + traces move to the backend.**
- **Console logs UI leaves the Observability section → per-app dropdown action + dialog.** Because
  console logs run off Core alone (no telemetry backend needed), they should not sit in a section that
  implies the backend. Move them to a per-app action in the Installed Apps dropdown
  (`installed-apps-page.tsx` `AppAction` + `onAction`), opening a **dialog** that reuses the existing
  `/api/apps/{id}/logs?tail=200` fetch; gate on the app's existing `logs` capability. Drop the
  `obs-console` route / sidebar button / section page (`shell-routes.ts`, `shell-sidebar.tsx`,
  `shell-route-pages.tsx`, `types.ts`; repurpose `console-logs-page.tsx` into the dialog). The
  Observability **section then contains only backend-backed views** (Metrics / Structured logs /
  Traces), so "hide the section when the telemetry app is off" is correct **and** never hides console
  logs — minimal logs stay reachable per-app even with the backend uninstalled/stopped.
- **Retention = per-signal age cap + global size ceiling, configurable in the backend app's settings.**
  Two guards together: age (intent — keep N days) *and* a hard total-size cap (safety — evict oldest so
  telemetry can never fill the disk). Different caps per signal (metrics small/periodic → longer;
  logs/traces bursty → shorter). Starting defaults (tune later): metrics ~14 d, logs/traces ~3 d, global
  ceiling ~1 GB. Mechanics: index `(app_id, ts)`, periodic `DELETE WHERE ts < cutoff` + size guard (port
  of `InMemoryMetricStore.Prune`), `auto_vacuum` to reclaim. Retention is what keeps SQLite bounded — the
  reason a TSDB's compression isn't needed.

## Open questions

None blocking — the design is settled. Remaining items are 2a-implementation details (SQLite schema
per signal; exact scrape/tail wiring inside the backend; retention default tuning).

## Phasing (proposed)

- **2a — backend store + query API (PR#1, landed).** Standalone `Haas.Hosty.TelemetryBackend` service:
  embedded SQLite store + retention, ingest loops (Prometheus scrape + file tails), the appId-keyed query
  API mirroring Core's `/api/observability/*` + `/api/apps/{id}/metrics|otlp-logs` shapes, Dockerfile + CI
  image, 19 tests. Non-breaking — Core keeps its own stores until 2b/2c. The multi-service manifest that
  ties the backend to the otelcol collector's shared volume ships in PR#2 (coupled to Core's bootstrap).
- **2b — Core becomes producer.** Core **pushes `docker stats`** infra metrics to the collector as OTLP;
  remove Core's own OTLP tail/scrape loops and stores. `docker logs` console tail is **unchanged**
  (stays on-demand). Core stops owning the telemetry stores.
- **2c — Core read proxy.** Re-point Core's `/api/observability/*` + `/api/apps/{id}/metrics|otlp-logs`
  (and the `control/v1` twins) from its own stores to a thin admin-gated proxy of the backend query API.
  `/api/apps/{id}/logs` (console) keeps serving from docker. Shell and CLI endpoints are unchanged (see
  Auth & network model).
- **2c-shell — console logs move + section gating.** Move console logs out of the Observability section
  into a per-app dropdown action + dialog; the section becomes backend-backed only (Metrics / Structured
  logs / Traces) and Shell hides it when the telemetry app is off/unconfigured (Core already knows its
  state). Independent of 2a–2c and shippable on its own.
- **2d — realtime (later, optional).** Add SSE for live log/trace tail, proxied through Core under the
  admin session (see Read/write asymmetry & realtime). Not required for 2a–2c; push ingest already gives
  near-real-time via polling.

## Related

- [observability.md](observability.md) — v1 (P3–P6), the current Core-owned store + read boundary, and
  the "light in-memory store, no external backend" decision this design revises.
- [final-hosty-architecture.md](final-hosty-architecture.md) — capability-provider / system-app model
  this aligns Core back to.
- [raw-ports.md](raw-ports.md) — the OTLP ingest port exposure / firewall note (feeds the network
  hardening in Auth & network model).

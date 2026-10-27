---
created: 2026-10-27
updated: 2026-10-27
summary: Exact per-app Core API counters and Shell warnings, with demand-driven standard Core traces and correlated logs retained by Telemetry.
components: [apps/core, apps/shell, apps/telemetry, apps/telemetry-backend, apps/telemetry-ui]
---

# Core API activity and tracing

Core counts incoming API requests independently of Telemetry. Shell presents activity alongside
CPU/RAM. Telemetry retains sampled standard Core spans, correlated logs and exact counter samples.
No request is rejected, delayed or queued by the activity warning policy.

## Accounting and warnings

The existing credential-validation paths populate one request context. A caller app requires a
verified presented service credential and an already-read installed app record, or the installed
caller verified by the assistant MCP authorization path. Target app IDs, arbitrary headers,
Origin, IP and propagated trace baggage do not establish identity. Accounting adds no token
verification or registry I/O to a request. Operator, authenticated external MCP and unknown traffic use fixed separate buckets.

Each recognized `/api` or `/control` HTTP request is counted once; authenticated streams are counted
when opened, before disconnect. Events and heartbeats add no requests; retries and reconnects do.
Telemetry transport metadata and CORS preflight exclude requests from warning evaluation while
preserving their totals. Static files and health paths outside the API are outside accounting.
There is no service split, endpoint table, inter-app traffic accounting or durable Core history.

Each installed app has cumulative totals and a fixed ring of 60 one-second buckets, using monotonic
time. Removal retires state and replacement resets it. Core run and installation identities separate
counter generations. A one-second evaluator runs without resource viewers or Telemetry; it does not
activate Docker or process sampling.

| Setting | Default | Meaning |
| --- | --- | --- |
| `HOSTY_API_ACTIVITY_ENABLED` | `1` | Exact counting; `0` provides an explicit diagnostic baseline. |
| `HOSTY_API_ACTIVITY_SUSTAINED_REQUESTS` | `50` | Warn after exceeding this in each of three completed, non-overlapping 10-second windows. |
| `HOSTY_API_ACTIVITY_BURST_REQUESTS` | `200` | Warn above this in the rolling 10-second window; must be at least the sustained threshold. |
| `HOSTY_API_ACTIVITY_RECOVERY_SECONDS` | `60` | Clear after this long continuously below half the sustained threshold. |
| `HOSTY_CORE_TRACE_SAMPLE_RATIO` | `0.1` | Root trace sampling while capture has demand; `1` records all roots. |

These are validated, persisted settings in Core's normal admin/control settings surface. Request
thresholds accept integers 1–1,000,000, recovery accepts 10–3,600 seconds, and the sampling ratio accepts
finite 0–1 values. Reset removes the override. Apps cannot change these settings through their grants.
Warnings describe heuristics rather than capacity limits. Entry, reason changes and recovery are
logged once; continuing warnings log at most once per five minutes per app.

## Shell and exact metric delivery

The [resource envelope and shared SSE](../runtime-resource-usage/feature.md) carry an additive
`apiActivity` map keyed by app ID, with observation/run identity, effective thresholds, cumulative
and 10-/60-second counts, warnings and recovery time. The current snapshot includes counters even
with no CPU history. API-only frames preserve each service's actual CPU/RAM measurement timestamp.
Counts are never copied to services or multiplied by their number.

Dashboard app rows show calls/minute and an accessible warning indicator. Resource popovers and
app details show the counts, warning reason/threshold and available short history. Subscriptions
follow visible consumers through the existing shared stream; no app polling loop is added. Old
Core responses, disabled accounting and stale activity appear unavailable rather than zero.

The existing authenticated metrics pull exports `hosty_core_api_requests_total`,
`hosty_core_api_eligible_requests_total` and `hosty_core_api_activity_warning`, with app, run and
installation labels. Counter differences within one generation and continuous enabled accounting measure exact traffic;
sampled span counts do not. Disabling accounting deliberately creates a measurement gap. Accounting availability has its own gauge. Telemetry stores these through its
existing metric retention and exposes them in the metric API and MCP tools.

## Standard tracing with authenticated pull

Core pins OpenTelemetry .NET hosting, ASP.NET Core and HttpClient instrumentation to 1.20.1.
Standard incoming/outgoing activities provide timings, W3C parent IDs, route templates and status.
`Hosty.Core` is the stable ActivitySource for focused internal spans. The producer remains
`hosty.core`; the verified caller is the separate `hosty.caller.app.id` attribute, copied to Core
child activities where context is available. Unknown callers omit it.

Core does not send OTLP to a managed collector. Any installed reader with explicit `core.read` and
`apps.read` grants can call `GET /api/internal/telemetry/traces?runId=&after=&limit=` with its service
credential. Every read checks current grants and renews that installation's 30-second demand lease.
Multiple readers have independent cursors. Revocation, replacement/removal or expiry stops its demand.
The stable provider uses parent-based root-ratio sampling only while at least one reader has demand.
Health and telemetry-transport spans are excluded. Exact counters continue outside capture.

Completed spans have a 2,000-entry, 8 MiB accounted-memory and 60-second age cap, with a 4 KiB
serialized per-span limit. A contended writer drops a diagnostic span instead of waiting behind a
reader. Accounting includes a conservative managed-object estimate as well as serialized size.
This bound covers retained records; SDK listeners and in-flight activities have separate overhead.
Sanitization retains bounded method/route/status/protocol/error-type tags, a validated destination
hostname and verified caller. Raw URLs, query strings, arbitrary tags/baggage/events, headers,
bodies and exception messages are not copied into retained spans.

Contract version 1 reports run/capture identity, sampling, observation time, sequence range, next
cursor, pagination and drop/truncation counts. Reads are replayable and non-destructive. Core restart,
expired/ahead cursors and resumed capture expose coverage changes. This is a bounded diagnostic
buffer, not a durable audit trail and not retroactive capture.

Telemetry pulls about every 10 seconds, drains at most four 500-span pages per tick, and backs off
failures to 60 seconds. A SQLite transaction stores a page and its cursor together; the unique
source/run/trace/span identity makes replays safe across backend restarts. Stored coverage reports
sampling, gaps and unavailable/unsupported Core versions. External OTLP logs/spans claiming the
reserved Core producer are rejected; only authenticated pull assigns trusted Core span provenance.
This does not implement the broader per-app OTLP authentication work in the
[Observability plan](../observability/plan.md).

## Correlated logs and investigation

Core's existing logging provider captures trace ID, span ID and verified caller at emission time.
Repeat folding includes correlation identity, so equal messages from different traces remain
separate. Background logs keep null IDs; sampled-out traces may still have correlated log IDs.
The existing log pull remains the single delivery path with unchanged category/severity filtering.

Telemetry trace/log APIs accept `callerAppId`; MCP uses `caller_app_id`. The filter applies to Core
records and does not change the producer filter. Logs additionally accept `traceId` (`trace_id` in
MCP), searching retained history across the ordinary time-window boundary. Trace details link to
related logs, and correlated logs link back to trace detail. An absent trace explains sampling,
capture gaps, buffer drops or retention instead of presenting a request failure. UI/API/MCP expose
the latest coverage report separately from exact request metrics.

## Verification baseline

The 2026-10-27 macOS arm64 acceptance used a parent-managed disposable Core environment, normal
password login, Docker Shell/caller/Telemetry services and the Native AOT executable. It verified
250 exact calls and a warning before Telemetry installation, incoming/outgoing spans, a correlated
readiness log, caller filters, browser navigation, stopped Telemetry, expired capture and Core
restart gaps. Owner Finish removed the child resources and the fixture removed its parent process,
ports, test data and credentials. Dashboard resource details remain scrollable in a 720-pixel viewport.

Five alternating empty-instance launches compared installed Core 0.158.1 with the 0.159.0 candidate:
median readiness was 162/164 ms, idle RSS 109,968/112,816 KiB, and executable size
62,579,912/64,154,344 bytes. The approximately 2.8 MiB RSS increase includes the complete feature and
fixed SDK listeners; it is not a claim about active tracing or a universal host budget. One cold
candidate launch took 893 ms; these are local diagnostic measurements, not a startup guarantee.
The existing-counter increment test allocates zero bytes across 10,000 warmed increments.

## Testing Expectations

- Monotonic window, concurrent increment, warning/recovery and installation/run reset tests cover
  exact counts, exclusions, streams/retries and verified versus spoofed caller identity.
- Resource and Shell tests preserve old/new payload compatibility, independent CPU timestamps,
  app-level aggregation, unavailable states and consumer-scoped shared subscriptions.
- Standard SDK tests verify a custom child span and correlated log, parent sampling, demand expiry,
  revocation, bounded/replayable capture and sanitization. HTTP tests enforce installed-reader grants.
- Backend tests cover parsing, durable cursor transactions, replay/restart deduplication, reserved
  provenance isolation, caller filters and correlation across retained time ranges. UI tests cover
  caller filters, coverage and both navigation directions, including missing traces.
- `npm run test:integration -- observability` runs normal setup/login in a parent-managed child Core
  with dedicated Docker Shell, caller and Telemetry services. `HOSTY_OBSERVABILITY_BROWSER=1` holds
  previews for visual QA; `HOSTY_OBSERVABILITY_PERF=1` adds repeated controlled HTTP comparisons.
  Owner Finish removes child resources; raw credentials and diagnostics stay outside the repository.
- Publish and smoke-test Native AOT on supported release toolchains. Measure sampling/counter
  overhead separately from background builds and report variance, startup and memory limitations.

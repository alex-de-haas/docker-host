---
status: In Progress
created: 2026-10-27
updated: 2026-10-27
summary: Lightweight per-app Core request counters and Shell warnings, with standard Core traces and correlated logs stored by Telemetry.
components: [apps/core, apps/shell, apps/telemetry, apps/telemetry-backend, apps/telemetry-ui]
---

# Core API Activity and Tracing

## Goal and owner decision

On 2026-10-27 the owner approved the scope below and delegated the delivery choice: keep minimal
per-app request counters and warnings in Core/Shell; use standard tracing enriched with the calling
app ID and correlated logs in Telemetry. Service-level attribution is explicitly excluded.
Implementation was authorized on 2026-10-27, including a PR, CI/review fixes and a regular merge.

Make excessive app-to-Core API traffic visible before the operator notices host slowdown. Keep
request processing independent of Telemetry availability, and provide standard trace evidence for
investigating slow endpoints and later adding focused internal spans.

## Baseline and ownership

- [Runtime resources](../runtime-resource-usage/feature.md) already expose app/service CPU and RAM
  through one Core sampler, bounded RAM history, authenticated HTTP and a shared SSE stream.
  Resource acquisition is consumer-driven; there are no per-caller API counters today.
- [Observability](../observability/feature.md) stores telemetry outside Core. Its backend already
  pulls Core metrics and logs. Core has no OpenTelemetry SDK; its exported log records currently
  have no trace/span correlation IDs.
- App service credentials identify an app, not an individual service. The caller is different from
  an app named in the requested URL. Identity must come from successful credential validation.
- The existing [Observability plan](../observability/plan.md#deliverables) retains ownership of D4
  (shared bidirectional trace/log navigation), D1 (general authenticated OTLP ingest) and D12
  (application-neutral provider wiring). This plan consumes D4; it does not duplicate those
  deliverables or require the entire older plan to finish. If D4 is still open, complete its shared
  navigation in the same implementation PR and update that checkbox there.

## Target behavior

### Minimal always-on counters

Count incoming Core API requests once, attributed to the authenticated calling app where available.
Use a shared request context populated by the existing management, internal-service, identity and
MCP authorization paths. Reuse credential-validation results; do not add registry reads, token
validation or disk I/O solely for accounting. A verified installed app remains the caller when a
later authorization or handler step rejects the operation. Unverified claims never identify an app.
Direct operator/local-control, external and unknown callers use a bounded set of separate categories.
Do not infer callers from the target path, Origin, IP, arbitrary headers or trace baggage.

Use per-app cumulative totals since the current Core run and a fixed 60-second ring of one-second
buckets for rolling 10-second and 60-second counts. State is bounded by installed app identities plus
fixed unattributed categories; installation replacement/removal resets or retires its state. Use
monotonic elapsed time for windows and a run ID for resets. Count once as the request enters the
recognized API path, then attach the verified caller before completion; long-lived stream requests
must be charged when opened rather than waiting until disconnect. Each HTTP retry is another
request. MCP transport requests count as HTTP requests, not as a fabricated count of tool calls.

Expose total API requests and the count eligible for activity warnings separately. Exclude health
probes, static assets, CORS preflight and telemetry export/pull routes from warning evaluation;
identify exclusions by route metadata, never a first-party caller ID. Count each SSE opening once,
including reconnects, and never count individual events or heartbeats as requests. Inter-app traffic
that bypasses Core is outside coverage. Do not maintain endpoint tables, latency histograms, trace
search indexes or durable request history in Core's activity accountant.

Counters and the lightweight warning evaluator stay active without a Dashboard or Telemetry reader.
They do not activate Docker/process sampling. No per-request log entry, network export, awaitable
storage operation or unbounded allocation is introduced by accounting. Trace sampling never affects
these exact counters.

### Warning policy and Shell delivery

Initial defaults are diagnostic heuristics, not capacity guarantees:

| Signal | Default |
| --- | --- |
| Sustained high activity | More than 50 eligible requests in each of three consecutive non-overlapping 10-second windows |
| Large burst | More than 200 eligible requests in a rolling 10-second window |
| Recovery | Rolling 10-second count stays below half the sustained threshold (25 by default) continuously for 60 seconds |

Expose the effective thresholds and reason with the warning. Make thresholds operator-configurable
through Core's normal settings model with validated ranges; apps cannot silently raise their own
threshold. Startup bursts remain counted, while the sustained condition avoids warning on ordinary
short page loads. These warnings never reject, queue, slow down or stop application requests and
never replace independent existing authentication/abuse controls.

Log entry, material severity changes and recovery once, with a continuing summary at most once per
five minutes per app. Include app ID, time window, counts and threshold; use no request content.
All app counters and warning state remain current even when no UI is open.

Extend the existing resource response/event envelope with an additive app-level API activity map:
run ID, observation time, totals, rolling counts, coverage and warning/recovery state. Keep this
separate from service-level CPU/RAM samples: copying one app's count onto every service would count
it repeatedly. Reuse resource authorization, shared SSE, sequence/gap recovery and snapshot loading;
older clients ignore the extra fields and older servers show the metric as unavailable, not zero.
Deliver app activity even when CPU/RAM is unavailable; activity observation must not refresh the
measurement timestamp of stale CPU/RAM. Request counters continue while the viewer-driven resource
sampler is idle, and the first resource snapshot contains their current state.

In Shell, show a compact calls/minute value and an accessible high-activity indicator alongside app
resources on Dashboard. Its popover and the app details resource area show 10-second/60-second
counts, the reason and time of the warning, and the available short resource history. Do not add a
request list or endpoint table to Shell. App-details subscriptions are active only while visible;
there is no per-app polling fan-out. Existing administrator-only host diagnostics remain restricted.

### Standard Core tracing and caller enrichment

Add explicitly referenced, version-pinned OpenTelemetry .NET SDK/instrumentation compatible with
Core's net10.0 Native AOT build. Use standard ASP.NET Core incoming-request and HttpClient outgoing
activities for timing and parent/child context. Do not wrap every endpoint with custom stopwatches.
Register a stable Core ActivitySource for focused internal spans; verify it with a fixture span.
Instrumenting arbitrary internal methods, Git commands or data reads is outside this initial scope.

Core spans remain owned by the existing telemetry source `hosty.core`; this is a compatibility
storage identity, not an installed app or the platform authority `hosty:core`. Enrich incoming spans
with `hosty.caller.app.id` after authenticating the caller, and preserve that verified attribution on
its Core child activities where practical. Unknown callers omit the attribute. Do not overwrite
Core's resource `service.name` with the caller or infer a caller from a propagated parent span.
No service attribution, credential changes or SDK changes in calling apps are required.

Retain standard method, route template, status, timestamps, duration, trace ID, span ID and parent ID.
Use an explicit bounded attribute/event policy: no raw query strings, credential headers, bodies,
prompts, filesystem paths or arbitrary baggage. Outgoing destinations and error details require
sanitization before retention. Health and telemetry-ingestion transport spans are filtered to avoid
self-observation loops. A trace shows instrumented boundaries, not automatically every internal step;
cross-app chains require those apps to propagate context and export their spans.

### Delivery decision: authenticated pull

Use standard instrumentation with a small in-memory span exporter/adapter and an authenticated Core
pull endpoint, rather than adding a network OTLP exporter to Core. Telemetry already pulls Core
metrics/logs, so this reuses its connection, credentials, ingest loop and SQLite store. Core does not
resolve a specific collector app, depend on its startup or retry delivery to an unavailable receiver.
Any appropriately authorized reader can use the same versioned contract, independent of app ID.

This intentionally revises the earlier no-OpenTelemetry-SDK rationale in Observability: the SDK
provides standard instrumentation; delivery stays pull-based. Native AOT compatibility, startup cost
and bounded capture are acceptance gates, not assumptions. No collector deployment/configuration
migration is part of this work, and ordinary apps keep their existing OTLP path.

Proposed additive route: `GET /api/internal/telemetry/traces?runId=...&after=...&limit=...`.
Require a validated installed-app service credential and the same explicit `core.read` and
`apps.read` grants used for the metrics pull. Check current grants on every read. No new implicit
permission, first-party ID exception or automatic permission grant is allowed.

A successful authorized read renews a 30-second capture-demand lease for that reader installation.
Telemetry reads approximately every 10 seconds, with bounded page draining and error backoff.
Multiple readers share capture and keep independent cursors. Capture stops once all demands expire
or lose authority; Core still propagates trace context and counts API requests. The first read
starts capture and reports its start time: earlier requests are not retroactively available.

Use parent-based trace sampling with a default 10% root ratio while capture is active, configurable
by the operator including 100% for deliberate diagnosis. Sampling is not an error guarantee. Bound
retained completed spans by both 2,000 entries and 8 MiB, with a 60-second maximum age; bound each
serialized span and discard oversized records with an explicit counter. Request threads never wait
for a reader. Keep provider/listener instances stable across demand changes instead of rebuilding
instrumentation on each poll. All active-span and exporter overhead must pass the load checks.

Return contract version, run ID, capture/sampling state, available sequence range, next cursor and
dropped/truncated counts. Reads are non-destructive and replayable. Telemetry stores the cursor only
after successful ingestion and deduplicates Core spans on source/run/trace/span identity. Handle
restart, expired cursors, delayed readers, repeated pages, cancellation and revocation explicitly;
show coverage gaps rather than manufacturing a continuous history. This is diagnostic delivery,
not a durable audit trail. Shutdown never waits for an absent consumer to drain the buffer.

Only the authenticated pull ingest path assigns trusted Core provenance. Ordinary OTLP records
claiming the reserved Core source must not overwrite or impersonate these records; reject such
claims at that ingest boundary. This narrowly protects the new Core path and does not complete the
broader per-app OTLP authentication work owned by Observability D1.

### Logs, Telemetry UI and agent access

Extend the existing Core log envelope and pull parser with trace ID, span ID and verified caller
app ID captured when the log is emitted. Preserve existing severity/category filtering and the
bounded buffers. Logs from different traces must not collapse into one repeated-message record;
include correlation identity in deduplication. Background logs with no activity keep null IDs.
Retain the existing single log delivery path, avoiding duplicate records from a second OTLP export.
Framework request chatter stays filtered by default; diagnosis may explicitly enable more categories.

Persist spans and correlated logs using Telemetry's existing retention and query authority. Provide
Core-resource and caller-app filters, show caller IDs/attributes in span detail, and distinguish the
trace's producer from its caller. Shared trace-to-log and log-to-trace navigation remains owned by
Observability D4 and must work for these Core records. A sampled-out, expired or dropped trace is
shown as unavailable with an explanation, not a broken link or an invented record.

Expose caller filters, trace/log correlation and capture/sample/truncation metadata through the
existing Telemetry read APIs and MCP tools as well as the UI. Extend the existing Core metrics pull
with the app-level request counters so Telemetry can retain exact counts separately from sampled
spans; an agent must not infer total traffic from the number of retained traces. Querying stored
history never triggers an extra Core request per result. Automated optimization or app changes are
outside scope; this feature supplies evidence for later analysis.

## Deliverables

- [x] D1. Implement bounded per-app request accounting and verified caller attribution across Core API authentication paths; cover exclusions, streams, retries, installation changes and run resets without Telemetry.
- [x] D2. Implement the configurable warning/recovery policy, bounded transition logging, additive app-level resource delivery and Shell Dashboard/app-details presentation without polling fan-out or request enforcement.
- [x] D3. Add standard Core ASP.NET Core/HttpClient instrumentation, verified caller enrichment and bounded capture/sampling; prove the exact package set with Native AOT publish and a custom fixture span.
- [x] D4. Implement the authenticated replayable trace pull contract and Telemetry ingestion, demand lifecycle, deduplication, gap reporting and trusted Core provenance isolation.
- [x] D5. Preserve trace/span/caller identity through Core log creation, repeat folding, pull and storage; keep one log delivery path and cover uncorrelated and sampled-out records.
- [x] D6. Expose Core traces, caller filters, exact request metrics and coverage metadata in Telemetry UI/query/MCP; verify Core records with the shared correlation navigation owned by Observability D4.
- [ ] D7. Add managed integration/browser and performance acceptance, verify absent/stopped/restarted Telemetry and independent upgrades, update feature documentation and release versions, then remove this plan when all deliverables pass.

## Implementation sequence

Implement on one branch and ship one complete feature PR. Start with D1 and the Native AOT proof in
D3, then D2/D4/D5, then D6 and the shared Observability D4 integration, and finish with D7. If the
chosen tracing dependencies fail Native AOT or measured overhead gates, record the failing evidence
and revise the design before continuing; do not silently disable AOT or drop tracing from scope.

## Verification

- Unit tests use a controllable monotonic clock for window boundaries, concurrent increments,
  sustained/burst/recovery behavior, logging frequency, sampler independence and exact totals.
  Exercise known/unknown/spoofed callers, rejected authorization after valid app identity, all
  supported ingress/authentication paths, SSE opens, retries and telemetry self-traffic exclusions.
- Resource transport and Shell tests cover missing fields, unavailable CPU/RAM, no service double
  counting, hidden/no viewers, immediate snapshots, disconnect/reconnect, run/sequence gaps,
  administrative access and supported old/new Core/Shell combinations.
- Trace/log tests cover W3C context propagation, verified enrichment timing, custom child spans,
  duplicate HTTP instrumentation, sanitization, sampling, multiple readers, lease expiry/revocation,
  count/byte/age overflow, cancellation, Core/backend restart and persist-before-cursor failures.
  Verify that different traces never merge through log folding and untrusted OTLP cannot impersonate
  the reserved Core source or overwrite pulled spans. Test old/new payload readers explicitly.
- Publish and smoke-test Core in Native AOT for supported release RIDs using CI's native toolchains;
  a Debug/JIT build alone is insufficient. Record binary size, startup, CPU, allocations and RSS.
- Add an `observability` suite to `npm run test:integration -- observability` in the implementation
  PR; that suite does not exist yet. Use a Core-managed sandbox with normal setup/login, a fixture
  caller app and isolated Telemetry storage. Verify counters and warnings before Telemetry starts,
  then incoming/outgoing spans, a correlated fixture log, caller filters and MCP evidence. Stop and
  restart Telemetry and Core; verify gaps, bounded recovery, continued requests and resource cleanup.
  Exercise an empty registry and an authorized reader app with an unrelated ID. Finish the sandbox
  through its owner and confirm resource removal after exporting useful summaries.
- Compare the same workload with diagnostics disabled, counters only, and active tracing at 10%
  and 100%, with Dashboard open/closed and Telemetry responsive/unavailable. Include steady traffic,
  bursts and long-lived streams. Initial budgets: counters-only throughput/p95 regression at most
  2%; default sampled tracing at most 5%; trace retention at most 8 MiB plus measured fixed SDK
  overhead. Repeat runs and report variance; these are acceptance targets, not measured results.
- Run affected Core, Shell and Telemetry tests/builds, Native AOT smoke checks, version consistency,
  `node scripts/docs-index.mjs --check --base <verified-target-commit>`, and `git diff --check`.

## Release and documentation outcome

This planning-only change has no version bump. Implementation adds functionality and bumps the
shared Core/CLI platform, Shell and Telemetry release artifacts according to repository policy,
including synchronized package/manifest/image versions. Update the resource and observability
feature documents to describe verified reality, create this feature's `feature.md` with Testing
Expectations, complete linked shared deliverables, delete the completed plan and regenerate the
index in the implementation PR. No app/service credential redesign is included.

## References

- [.NET observability with OpenTelemetry](https://learn.microsoft.com/en-us/dotnet/core/diagnostics/observability-with-otel)
- [ASP.NET Core instrumentation](https://github.com/open-telemetry/opentelemetry-dotnet-contrib/blob/main/src/OpenTelemetry.Instrumentation.AspNetCore/README.md)
- [OpenTelemetry .NET exporters](https://opentelemetry.io/docs/languages/dotnet/exporters/)

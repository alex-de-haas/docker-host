# Observability — Remaining Work

Status: In Progress
Created: 2026-07-03
Updated: 2026-09-06

## Goal

Close the gaps left after the telemetry store, query API, and UI moved out of Core into the
`hosty.telemetry` system app (see [feature.md](feature.md) for what runs today): the telemetry data
path has **no auth of its own**, live tails still **poll**, and the fleet-wide views that were
promised alongside the per-app ones — a Dashboard heat-map and trace→log correlation — were never
built.

A fourth gap predates that move and is unrelated to it: **Core's own logs are the one stream no
surface shows.** Every installed app has a Console logs dialog one click away in Shell, and a
structured stream in the telemetry UI if it opts in. The host kernel has neither. Its logs exist only
as whatever its stdout was redirected into — `~/.hosty/core/logs/core.log` when the CLI started it in
the background, nothing at all in the foreground or under `npm run dev` — reachable only by
`hosty core logs` from a shell on the host. The component that starts, stops, updates, and proxies
everything else is the one an operator cannot look at from the UI they are already in.

Security comes first. The rest is freshness and reach.

## Target behavior

A diff against [feature.md](feature.md):

- The Query API section no longer says the API carries no auth — **done 2026-08-17** by
  [telemetry-mcp](../telemetry-mcp/feature.md): the backend requires a credential Core mints and
  injects, and rejects unauthenticated readers.
  **Reads only.** OTLP ingest is unchanged and still accepts anything that can reach the port, so a
  process on the network can still inject spans attributed to another app. Confining it moved to
  [cross-app-dependencies](../cross-app-dependencies/plan.md), which is building the network it needs;
  this bullet used to claim both halves and would have read as done when half of it was not.
- Logs and traces reach the UI as they arrive rather than on a poll: the backend exposes a stream
  endpoint and the UI's Structured logs and Traces pages tail it live, with the poll retained as the
  fallback when the stream drops.
- Stored OTLP log records link to the trace they belong to, and a trace's spans link back to the log
  records carrying the same `trace_id` — the ids are already stored on both sides, only the
  navigation is missing.
- A fleet heat-map summarizes per-app health/CPU/memory at a glance on Shell's Dashboard, over a
  single Core read rather than a fan-out per app — and it works with observability switched off,
  because it never touches the telemetry store.
- Shell shows **Core's own recent logs** the way it already shows an app's console logs: a dialog on
  the Dashboard Core card, admin-only, opening on Core's own records with the framework request trail
  behind a toggle. Its source is a pair of in-process ring buffers, not `core.log` — the file cannot
  back a live view (see the deliverable).
- With the telemetry app installed, Core's records reach the backend's store and appear in the UI's
  Structured logs page beside the apps', attributed to a reserved `hosty.core` id. Core gains no
  OpenTelemetry SDK: the backend **pulls** the records from an authenticated Core endpoint, exactly as
  it already scrapes Core's `docker stats` exposition.
- "Console logs are not stored" stays true for apps and gains its one exception, stated as such: a
  container's console stream is already retained and rotated by Docker, and Core's is not.
- Core's producer paragraph no longer describes only `docker stats` and the per-app `docker logs`
  tail: Core also produces its own log records, over the same authenticated pull.
- The background-start redirect no longer erases the previous run's log, so `core.log` keeps the one
  job the buffer cannot do — post-mortem for a Core that is no longer running. That file also stops
  being 96 % framework chatter and starts carrying timestamps.

### Why pull, and not an OTLP exporter inside Core

The symmetric-looking option is to give Core the `telemetry` treatment every app gets: an OTel SDK,
`OTEL_*` config, push to the collector. It is the wrong shape here for four reasons, in descending
weight:

1. **Core is an AOT binary with one dependency.** `PublishAot` is on and
   `Haas.Hosty.Core.csproj` carries a single `PackageReference`. The OTel SDK plus an OTLP exporter
   would be by far the largest dependency the kernel has ever taken, into the build configuration
   least tolerant of reflection. Recent OTel releases claim AOT compatibility; that is a claim to
   verify with a publish, not to design around.
2. **The dependency runs backwards.** Apps get their endpoint injected at start because the collector
   is already up — Core starts it. Core itself starts *before* the collector exists, so it would have
   to resolve and rebind the endpoint at runtime, which is not how the standard host wiring is
   configured.
3. **It puts a queue to a managed app inside the kernel.** An exporter that blocks, buffers, or
   retries against the collector is a new failure surface in the process that supervises the
   collector. An app can afford that coupling; the supervisor should not.
4. **Ingest is still unauthenticated.** Anything that reaches the OTLP port can already inject
   records under any `hosty.app.id`, including a synthetic one for Core — that is the **Ingest + query
   auth** deliverable, now carried by
   [cross-app-dependencies](../cross-app-dependencies/plan.md). Core's log is the closest thing the
   host has to an audit trail; routing it through the one door in this system that anybody can knock
   on inverts its value.

Pull inverts all four: no packages and no AOT risk, no ordering problem (the backend asks when it is
ready), no queue in the kernel, and auth that already exists — the app service token that guards
`GET /api/internal/telemetry/metrics`, on a route inside the endpoint-authorization harness. It also
matches the precedent Core already sets as a telemetry producer. The honest cost is that the backend
gains a third ingest path: it tails the collector's file sinks today, and would gain an HTTP cursor
loop against Core. That is real work in the app, paid once, instead of permanent weight in the
kernel.

## Deliverables

- [ ] **Ingest + query auth** — **shipped 2026-08-17 by [telemetry-mcp](../telemetry-mcp/feature.md)** for the query
      side; ingest confinement moved on to [cross-app-dependencies](../cross-app-dependencies/plan.md), which cannot ship its tools over an unauthenticated data path and so absorbed
      this rather than duplicating it. The credential shape is settled there — per-app tokens, the
      form the platform rule in [ai-agent-bridge/feature.md](../ai-agent-bridge/feature.md#token-mechanics)
      favours for anything streaming or high-volume — and so is its sequencing against the
      internal-only network that plan is building. Original wording: Core mints a shared credential for the telemetry app and injects it
      the same way it injects the OTLP endpoint; the backend requires it on the query port, and OTLP
      ingest requires it per app so `hosty.app.id` can no longer be spoofed. Remove the
      "known-open" `SECURITY` note in `apps/telemetry-backend/src/Haas.Hosty.TelemetryBackend/Program.cs`
      and the corresponding paragraph in `feature.md` when this lands.
- [ ] **Backend stream endpoint.** An SSE (or equivalent) endpoint over new log records and spans,
      filterable by the same `apps` / `severity` / `q` parameters as the query reads.
- [ ] **UI live tail.** Structured logs and Traces consume the stream through the UI's server routes;
      reconnect and backfill on drop; Metrics stay on the existing poll (charts do not benefit).
- [ ] **trace→log correlation links** in the telemetry UI, both directions.
- [ ] **Fleet heat-map** on Shell's Dashboard, served by Core rather than out of the telemetry
      store. Its home looked contested only while the data was assumed to live in the backend: then a
      Dashboard heat-map meant either resurrecting the deleted Core read proxy or giving Shell a direct
      backend read, and putting it in the telemetry UI meant taking it off the landing page where its
      value is. But "health/CPU/memory at a glance" is **current state, not a time series**, and Core
      owns both halves already — it tracks per-app health, and `DockerStatsExposition` runs
      `docker stats` with the host-level access the backend deliberately lacks. So the heat-map reads
      one Core summary endpoint, no telemetry data path is involved, and it keeps working on a host
      with observability off — the same reason console logs stayed in Shell. It must **not** reuse the
      exposition's cached snapshot, which idles empty unless the telemetry app is installed and
      running; the Dashboard read samples on demand, so a host nobody is looking at pays nothing.
      Trends and sparklines are a different feature and stay in the telemetry UI.
- [x] **Core log buffers + `GET /api/core/logs`.** Two fixed-capacity rings fed by one
      `ILoggerProvider` registered in `HostyCoreApplication.ConfigureServices`; every record carries
      timestamp, level, category, message, exception, and a monotonic sequence number, and the process
      mints a run id at start. **Two rings rather than one**, because the measured ratio of framework
      noise to Core's own records is roughly 1600:1 (see the dialog deliverable): sharing one ring lets
      request-pipeline chatter evict Core's own rare events inside an hour. The `hosty` ring
      (`Haas.Hosty.Core.*` and anything not framework, ~2000 records) then holds weeks; the `framework`
      ring (~2000 records) holds roughly the last hour of request trail. Repeated identical records
      collapse into one slot carrying a count and first/last-seen stamps — the trick
      `MetricDeduplicator` already plays on flat metric series. Without it a Docker outage burns 360
      slots an hour from `DockerStatsExposition`'s per-tick warning alone, and that outage is exactly
      when the telemetry containers are down too, so nothing is draining the ring either.
      Served by an admin-session-gated `GET /api/core/logs?ring=&tail=&level=` beside the rest of the
      `/api/core/*` family, returning records and the run id. Admin-only for the same reason the
      per-app console tail is: request paths are in there, and in Development so are secret *key
      names* ([app-secrets-store](../app-secrets-store/feature.md)). **Not backed by `core.log`,** because the
      file is absent under a foreground or `npm run dev` start, is truncated by the next background
      start, and is never rotated. The rings cost nothing when the telemetry app is absent and need no
      gate: the logging pipeline fills them either way, and nothing reads them until someone looks.
- [x] **Logging pipeline defaults.** Core sets no filters at all today, which is why everything in the
      measurement below arrives at Information. Put `Microsoft` and `System` at Warning for the console
      provider — the console *is* `core.log` — and restore Information for the buffer's provider with a
      provider-scoped rule (`AddFilter<T>`), so the file becomes legible while the dialog keeps the
      request trail in memory where it is bounded and free. These defaults belong in an in-memory
      configuration source inserted **ahead of** the environment source, not in an `AddFilter` call in
      code: `CreateSlimBuilder` already wires logging configuration, so `Logging__LogLevel__*` env
      overrides work today (and reach Core, since the CLI's start path passes its environment through),
      and they must keep winning over our defaults for the same category. No new `hosty config` key —
      the launch config deliberately holds only what has nowhere else to live, and this has somewhere.
- [x] **Shell Core logs dialog.** Opened from the Dashboard's `CoreSection` — where Core's read-only
      facts already live, by the convention stated in `settings-core-section.tsx` — and modelled on
      the per-app Console logs dialog. **The filter that matters is category, not severity.** Measured
      on a live host over 26.6 h of one run (77,918 records): ~96 % are the ASP.NET request pipeline
      (`Hosting.Diagnostics`, `Routing.EndpointMiddleware`, `Http.Result.*`, `CorsService`), ~4 % are
      `System.Net.Http.HttpClient.*` from Core's named clients, and **about 45 records — 0.06 % — are
      Core's own** (`Haas.Hosty.Core.*`). Every single record was Information: not one warning or error
      in 26 hours. A severity floor therefore filters nothing on a healthy host, while a
      Hosty-versus-framework split is the whole difference between signal and noise. So the dialog
      opens on the `hosty` ring, offers the request trail as an explicit toggle, and keeps severity as
      a secondary control that only earns its keep once something is actually wrong.
- [x] **`core.log` survives a restart.** The CLI's background start truncates the file
      (`> core.log`, `CoreCommand.StartBackground` and its Windows twin), so the run that just
      crashed is erased by the restart that follows it — including a restart triggered from the same
      Dashboard the dialog lives on. Rotate to `core.log.1` (keep a small N) instead. Triage of L-L3
      in the 2026-07-05 review (since superseded; see
      [the consolidated review](../../reviews/2026-09-06-consolidated-review.md#superseded-reviews)),
      pulled in here because it
      is the post-mortem half of the same story. Reproduced unprompted while this plan was being
      written: a Core update restarted Core mid-session and took the whole previous run's log with it,
      including the run these measurements were taken from. One more one-line gap belongs here:
      the default console formatter prints **no timestamps whatsoever**, so neither `core.log` nor
      `hosty core logs` can say when anything happened — `TimestampFormat` with `UseUtcTimestamp`
      closes it. In-run growth stays unbounded and stays out of scope: bounding it means Core owning
      the file instead of the shell redirect that creates it.
- [x] **Core logs in the store, pulled.** `GET /api/internal/telemetry/logs?after=<sequence>&limit=`,
      app-service-token gated exactly like the metrics exposition — any installed app's token, since
      the data is host-wide with no per-app scoping — answering with records, the run id, and the
      next cursor. The backend adds a third ingest loop that persists its cursor in the existing
      `ingest_state` table and restarts from zero when the run id changes (the same reset the file
      tails perform on rotation), attributing every record to `hosty.core`. The exported stream is
      **not** the raw firehose: ASP.NET's per-request categories are excluded and a per-tick record
      cap applies, so Core cannot evict the fleet's logs from a 3-day, ~1 GiB-ceilinged store — the
      failure this store has already demonstrated once.
- [x] **`hosty.core` as a reserved id.** The store, all six query routes, the three MCP tool schemas,
      and the app-directory endpoint each treat an app id as an opaque key with no roster validation,
      so the reserved id needs no schema change — only five localized special cases: a display name in
      the telemetry UI's `enrich.ts`; a synthetic entry in the logs and traces filter dropdowns **plus**
      an exemption from the guard that resets a selection missing from the roster (without it Core's
      records appear under "All resources" and can never be filtered to); exclusion from the `AppCount`
      the fleet responses report; and an explicit "this is the host kernel, not an installed app"
      answer from Core's MCP `tail_app_logs`, which today surfaces a raw exception for it. **Do not add
      the id to the roster** (`GET /api/internal/apps/{appId}/app-directory`) as a shortcut: the
      ai-gateway consumes that same payload for provider discovery, and Core would leak into it. The
      alternative — a first-class host/app `source` column — was rejected: ~19 SQL sites and 25–30
      files, on a backend that has no migration mechanism at all (`Initialize()` is pure
      `CREATE TABLE IF NOT EXISTS`, with no `ALTER TABLE` or `user_version` anywhere), so it would mean
      inventing one first.

## Phases

1. **Auth.** The credential, both enforcement points, and the tests that prove an unauthenticated
   caller is refused. Independently shippable and the highest-value item — everything else adds
   surface to a data path that is currently open.
2. **Realtime.** Backend stream endpoint, then the UI tail. Depends on phase 1 only in that a new
   endpoint should not ship unauthenticated.
3. **Fleet views.** trace→log links and the heat-map. Independent of 1–2, and independent of each
   other: the heat-map reads Core, the correlation links read the store.
4. **Core's own logs.** First the rings, the pipeline defaults, the endpoint, and the Shell dialog
   (useful on their own, on a host that never installs telemetry); then the pull endpoint, the
   backend's ingest loop, and the reserved-id special cases, which all read the same rings. The
   `core.log` rotation and timestamp fixes ride along with the first half and depend on nothing. Independent of phases 1–3, and — unlike everything else in this plan — it adds no surface
   to the unauthenticated data path: both new routes sit behind auth that already exists.

## Verification

Phases 1–3:

- Backend tests: an unauthenticated query is refused, an authenticated one succeeds, ingest rejects
  an unattributable or spoofed producer, and the stream endpoint emits the records a matching query
  would return.
- Core tests: the credential is minted and injected at start and does not leak to the collector
  (a third-party image), matching how the docker-stats scrape token is handled today.
- Live host: with the telemetry app running, a fresh app log record appears in the Structured logs
  page without a manual refresh; killing the stream falls back to polling and recovers on reconnect;
  a direct `curl` of the query port from the host is refused.
- Stream relay through the UI's Next route handlers, which is where this is most likely to break: the
  browser can only reach the UI origin, so the handler relays. Prove it flushes per event rather than
  buffering the response, that the route is not statically optimized, and that a client disconnect
  cancels the upstream read instead of leaking it.

Phase 4 — Core's own logs:

- Core tests: each ring keeps order and drops oldest-first at capacity; a repeated identical record
  collapses into one slot whose count and last-seen advance while its first-seen holds; the framework
  categories land in the framework ring and never in the `hosty` one; `GET /api/core/logs` refuses a
  non-admin session and honours `ring` / `tail` / `level`; the pull endpoint rejects a missing,
  invalid, or uninstalled-app token — the same regression guard the docker-stats exposition carries —
  and the endpoint-authorization harness keeps enumerating both routes.
- Logging defaults: a `Logging__LogLevel__Microsoft.AspNetCore=Information` override still beats the
  shipped default for that category (the ordering trap that motivated putting defaults in
  configuration), and the console writes UTC timestamps.
- Backend tests: the Core ingest loop resumes from its persisted cursor, restarts from zero when the
  run id changes, attributes records to `hosty.core`, and respects the per-tick cap; a Core stream at
  full rate does not push app logs out of a ceiling-pinned store.
- Live host: the dialog shows records with the telemetry app uninstalled (the rings are not gated on
  it); a foreground / `npm run dev` Core shows records there even though no `core.log` exists;
  restarting Core from the Dashboard shows the fresh run while the previous run survives on disk as
  `core.log.1`; with telemetry installed, a Core lifecycle event reaches the UI's Structured logs
  page under Hosty Core within one ingest tick, labelled by name, selectable in the app filter, and
  counted out of the fleet's app count.

In every case `node scripts/docs-index.mjs --check` passes, and `feature.md` is updated in the same
PR that completes each deliverable.

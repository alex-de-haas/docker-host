# App Readiness — Readiness Is Health

Status: Draft
Created: 2026-09-09
Updated: 2026-09-09

## Goal

Let a client — Shell, a dependent app, `hosty mcp` — act on an app's endpoint the moment that endpoint
can actually answer, and not a moment before, without adding a third state axis. Hosty already has the
two it needs: `runtimeState` says whether the runtime is up, per-service health says whether it is
well. Readiness is the second of those, kept per service, made default, and read by the consumers
that need it for the endpoint they need.

## Why

Starting `com.haas.demo-app` from its Shell panel on a live host (2026-09-09) rendered Chrome's own
`127.0.0.1 refused to connect` page inside the panel for the second the app took to bind its port.
Core had reported `running`, Shell embedded on that, and nothing was listening yet.

An earlier draft tried to fix that with a readiness gate on `runtimeState` driven by health. That
collides with a decision [App Lifecycle States](../app-lifecycle-states/feature.md) documents:
health-`starting` maps to app-`running` *because the runtime is already up*, and the supervisor's
health never produces a transitional state, or it and a lifecycle verb would fight over the record.
The model that does not collide is the one Aspire's dashboard shows as `Running (Unhealthy)`: two
fields composed into one label, dependents waiting on **healthy** rather than on running, and a
resource with no health check counted healthy as soon as it runs. Hosty is most of the way there.

## What already exists

- `runtimeState` (lifecycle) and per-service `health`, aggregated per app by
  `AppRuntimeHealthResult`. The rule (identical in both adapters): liveness first — every service
  `running` → look at probes; every service `stopped` → `stopped`; a mix → `unhealthy`. Among
  all-running services, any probe `unhealthy` → `degraded`, else any probe `starting` → `starting`,
  else `healthy`. A `healthcheck` is declared **per service**, not per app; a service without one
  contributes liveness only, which reads as `healthy` the moment its process is alive.
- `NetworkHealthProbe` — Core-side `http` (2xx/3xx) and `tcp` (connected) probes on loopback, used
  for a `localCommand` service that declares a `healthcheck`; container `HEALTHCHECK` for docker.
- The supervisor observes health every 15 s (`SuperviseInterval`), only for `IsUp` records, and
  reconciles `runtimeState` from it through `ResolveRuntimeStateFromHealth`; restart policy acts on
  `stopped` only. Autostart runs at most `MaxConcurrentAutostarts` (4) starts at once, by tier.
- A `localCommand` start returns `"running"` after a fixed `Task.Delay(250)` — the gap this plan
  closes. `RestartCoreAsync` calls the adapter's `StartAsync` directly rather than through
  `StartCoreAsync`, so a start-only change would leave restarts without the wait.

This vocabulary is liveness-first and **not** ASP.NET's, though it shares the words: there
`Degraded` and `Unhealthy` are two severities of a live process; here `unhealthy` is a process-level
partial outage and `degraded` is "alive, probe failing", covering both ASP.NET severities at once.
Decided 2026-09-09 to keep it as it is and name it, rather than realign — the difference is spelled
out in [App Lifecycle States](../app-lifecycle-states/feature.md#health-vocabulary-is-liveness-first),
and this plan's use of `degraded` for an expired wait follows from it.

What is missing: health is not persisted (it lives in the supervisor tick and in
`/api/apps/{id}/health`, never in the list — `core-read-path-caching` removed probing from the read
path on purpose); a service with no declared `healthcheck` is never probed; and every consumer that
needs readiness reads `IsUp` for the whole app instead of health for the service it is about to use.

## The two contracts, fixed before code

The review of this plan (2026-09-09) asked for two things to be settled before Phase 1, because they
decide the data model: what an endpoint's availability is, and how the wait behaves. Both are stated
here; the plan is not Ready until the user has accepted them.

**Endpoint availability.** Health is kept **per service**. The app-level aggregate exists for the
badge and nothing else. An endpoint is *ready* when the service that owns it is `healthy` — not when
the app is. This is not theoretical: `com.haas.demo-app` serves its UI from `frontend` (endpoint
`http`) and its MCP from `backend` (endpoint `api`, `/api/mcp`); a probe of the UI alone would open
the MCP catalog early, and a broken UI would hide a working MCP. Telemetry splits the same way.

**The wait.** The readiness wait lives in the runtime adapters' `StartAsync`, where the fixed delay is
today, so `StartCoreAsync` and `RestartCoreAsync` both get it. While it runs the record stays
`starting`: that state already means "a start is in flight, holding the lock", and the port-release
wait and the image pull are already counted as part of it. The supervisor observes only `IsUp`
records, so it is not a writer during the wait; Shell reads `starting` and offers progress, not Stop
— exactly today's behavior. The wait is bounded, checks liveness on every probe iteration, and honours
the verb's cancellation. What the adapter returns:

| outcome | `runtimeState` | service health |
| --- | --- | --- |
| probe passed | `running` | `healthy` |
| deadline expired, process alive | `running` | `degraded` — the supervisor keeps observing |
| process exited during the wait | the existing failed-start path | — |

A Stop requested during the wait waits for the lock, as it does for any in-flight start today; the
deadline bounds how long. `runtimeState`'s meaning and transitions are unchanged; the start verb's
duration grows by at most the deadline.

## Target behavior

Written as a diff against the feature documents it touches.

**Core** ([App Lifecycle States](../app-lifecycle-states/feature.md)):

- The app record persists per-service health as last observed, plus the aggregate; `/api/apps`
  projects both, still without probing.
- A start verb resets persisted health to `starting` at its head, so a previous `healthy` cannot
  survive into a new start. A stop, a failed start, a removal and an install clear it.
- Persisted health is meaningful only while `IsUp`; every readiness consumer reads
  `IsUp && <service>.healthy`, never health alone. `ObserveRuntimeHealthForAppAsync` skips apps that
  are not up, so without the clear a stopped app would keep its last `healthy` indefinitely.
- Every endpoint the app publishes — the UI entry, dependency-provided endpoints, interface endpoints
  such as MCP — gets an implicit `tcp` check on the service that owns it when that service declares
  no `healthcheck`. A declared `healthcheck` wins; for docker, the image's `HEALTHCHECK` wins. `tcp`
  rather than `http` because a 401 or a 404 is a server that is up, not one that is ill; a service
  wanting a stricter answer declares `http` with a path.
- The health observation takes the per-app operation lock non-blockingly and skips a held app — the
  docker sweep's rule. Not for the wait (the record is `starting` then, and the observer skips it),
  but for the steady state: an observation sampled before a Stop cleared health must not commit after
  it.

**Shell** ([Core App Shell](../core-app-shell/feature.md),
[App UI Surfaces](../app-ui-surfaces/feature.md)):

- The Dashboard's app-row badge composes `runtimeState` with the aggregate — `running · starting`,
  `running · degraded` — the way Aspire's does. Display only; per-service rows keep their own health.
- Health gates **opening** a surface, not the life of an open one. A tab embeds when the service
  behind its endpoint is `healthy`; a frame already open stays open through `healthy → degraded` — a
  transient probe failure must not destroy what the operator has typed — and is unmounted only by
  the lifecycle axis (`!IsUp`), as today.
- Three screens the strip needs and does not have: `starting` (progress — the state `starting`
  screen, reused), `degraded` ("up, but not answering — open anyway?"), and health not yet observed
  (`null`, possible after a Core restart adopts a running app before its first tick — treated as
  progress until the first observation lands).
- The sidebar's launch and the workspace follow the same opening rule.

**Other consumers:**

- `AppDependencySummary` keeps `Running` as the lifecycle fact and gains `Healthy` for the endpoint
  the dependency consumes; a computed `Ready = Running && Healthy` is fine, a third independently
  written axis is not. The contract is agreed with
  [Dependency-Ordered Autostart](../dependency-ordered-autostart/plan.md), which will wait on it.
- `hosty mcp`'s `ToolCatalog` includes an app's tools when the service behind its MCP endpoint is
  healthy.
- `hosty apps list` shows the composed status.

## Explicitly out of scope

- Restarting an app for being `degraded` or `unhealthy`. Restart policy stays crash-only.
- A `Waiting` state for dependents that hold their own start until a provider is healthy — that is
  [Dependency-Ordered Autostart](../dependency-ordered-autostart/plan.md)'s alone.
- `availability: "unavailable"` — an endpoint whose reserved port another process holds. Different
  fact, owned by [Automatic Runtime App Ports](../automatic-runtime-app-ports/plan.md).
- Realigning the health words with ASP.NET's severities (`unhealthy` = cannot serve, `degraded` =
  serving with impairment, a new word for the process-level mix). It needs a probe that reads the
  app's own severity, a mapper change, and a docker aggregate that has no `degraded` to give; worth a
  plan of its own if app authors need their severity to reach Hosty, and orthogonal to readiness.

## Open questions

- **The deadline.** Long enough for a cold `next dev`, short enough that a genuinely broken app does
  not hold `starting` for long; one value, or per runtime type.
- **Autostart.** With four concurrent starts by tier, a readiness wait delays every start queued
  behind it and the next tier. Acceptable as is, or do tiers release on `running` rather than on the
  adapter's return?
- **`starting` versus `degraded` after the wait.** Kept apart on purpose — "still coming up" is not
  "came up wrong" — and the review agreed; confirming it is a decision, not an accident.

## Deliverables

### Phase 1 — Core: health as persisted state

- [ ] Per-service health and the aggregate persisted on the app record; `/api/apps` projects them
      without probing.
- [ ] The readiness wait in both adapters' `StartAsync`, bounded, liveness-checked per iteration,
      cancellable; the record stays `starting` until the adapter returns; outcomes as in the table.
- [ ] Health reset to `starting` at the head of a start; cleared by stop, failed start, removal and
      install.
- [ ] Implicit `tcp` check on every published endpoint's owning service; declared `healthcheck` and
      image `HEALTHCHECK` take precedence.
- [ ] The health observation takes the operation lock non-blockingly and skips a held app.
- [ ] `CoreLifecycleServiceTests`: a late-binding endpoint reaches `healthy` inside the wait; one that
      never binds returns `running` + `degraded` and the next observation flips it; a process that
      exits mid-wait fails the start; a restart gets the same wait; a stopped app reads no health; a
      new start does not inherit the previous `healthy`; an observation that finds the lock held
      writes nothing; a declared `healthcheck` overrides the implicit one.

### Phase 2 — Shell: composed status, open on health

- [ ] App-row badge composes `runtimeState` with the aggregate.
- [ ] Surface tabs open when the endpoint's service is `healthy`; an open frame survives
      `healthy → degraded`; the `degraded` and not-yet-observed screens exist.
- [ ] Sidebar launch and workspace follow the same opening rule.
- [ ] `app-surface-tabs.test.mjs` covers the opening gate and the stay-open rule.
- [ ] Remove the known-gap paragraph from App UI Surfaces' `feature.md`.

### Phase 3 — Other consumers

- [ ] `AppDependencySummary.Healthy` (and `Ready`), contract agreed with dependency-ordered autostart.
- [ ] `ToolCatalog` gates on the MCP endpoint's service.
- [ ] `hosty apps list` shows the composed status.

### Verification — acceptance, both runtimes

- [ ] **Docker:** measure whether a `tcp` connect through a published port succeeds before the
      container listens (userland proxy vs. DNAT). If it does, the implicit check for docker must be
      `http` or defer entirely to the image `HEALTHCHECK`; the outcome is recorded in `feature.md`.
      Not optional — until it is measured, the main scenario may remain broken on docker.
- [ ] **Docker precedence:** an image `HEALTHCHECK` and a declared `healthcheck` each override the
      implicit check, verified live.
- [ ] **localCommand, live:** start `com.haas.demo-app` from its Shell panel and watch the row hold
      `starting`, then go `running`, with the panel opening on the second and never rendering a
      connection-error frame. No unit test observes what the browser renders inside a cross-origin
      frame.
- [ ] **Restart, live:** the same through Restart, since it takes the other code path.

## Links

- [App Lifecycle States](../app-lifecycle-states/feature.md) — the two axes, the health vocabulary,
  and why `running` is not delayed for health.
- [App UI Surfaces](../app-ui-surfaces/feature.md) — carries the known gap this closes.
- [Cross-App Dependencies](../cross-app-dependencies/feature.md) — the dependency summary this
  extends.
- [Dependency-Ordered Autostart](../dependency-ordered-autostart/plan.md) — owns `Waiting`, will
  consume `Ready`.
- [Automatic Runtime App Ports](../automatic-runtime-app-ports/plan.md) — the neighboring
  "honest state" work for `unavailable`.
- [Core Lifecycle Parallelism](../core-lifecycle-parallelism/feature.md) — the autostart fan-out the
  wait sits inside.

# App Readiness — Readiness Is Health

Status: Draft
Created: 2026-09-09
Updated: 2026-09-09

## Goal

Let a client — Shell, a dependent app, `hosty mcp` — act on an app the moment it can actually answer,
and not a moment before, without adding a third state axis. Hosty already has the two it needs:
`runtimeState` says whether the runtime is up, per-service health says whether it is well. Readiness
is the second of those, made visible, made default, and read by the consumers that need it.

## Why

Starting `com.haas.demo-app` from its Shell panel on a live host (2026-09-09) rendered Chrome's own
`127.0.0.1 refused to connect` page inside the panel for the second the app took to bind its port.
Core had reported `running`, Shell embedded on that, and nothing was listening yet.

An earlier draft of this plan tried to fix that by delaying `running` until the endpoint answered.
That collides with a decision [App Lifecycle States](../app-lifecycle-states/feature.md) already made
and documents: health-`starting` maps to app-`running` *because the runtime is already up*, and health
never produces a transitional state, or the supervisor and a lifecycle verb would fight over the
record. A readiness gate on `runtimeState` also does not hold — a `localCommand` service with no probe
reports health from process liveness alone, so the next supervisor tick would promote the record to
`running` regardless.

The model that does not collide is the one Aspire's dashboard shows as `Running (Unhealthy)`: two
fields composed into one label, dependents waiting on **healthy** rather than on running, and a
resource with no health check counted healthy as soon as it runs. Hosty is most of the way there; the
rest is below.

## What already exists

- `runtimeState` (lifecycle) and per-service `health`, aggregated per app by
  `AppRuntimeHealthResult`. The rule (identical in both adapters): liveness first — every service
  `running` → look at probes; every service `stopped` → `stopped`; a mix → `unhealthy`. Among
  all-running services, any probe `unhealthy` → `degraded`, else any probe `starting` → `starting`,
  else `healthy`. A `healthcheck` is declared **per service**, not per app; a service without one
  contributes liveness only, which reads as `healthy` the moment its process is alive.

This vocabulary is liveness-first and **not** ASP.NET's, though it shares the words: there
`Degraded` and `Unhealthy` are two severities of a live process; here `unhealthy` is a process-level
partial outage and `degraded` is "alive, probe failing", covering both ASP.NET severities at once.
Decided 2026-09-09 to keep it as it is and name it, rather than realign — the difference is spelled
out in [App Lifecycle States](../app-lifecycle-states/feature.md#health-vocabulary-is-liveness-first),
and this plan's use of `degraded` for an expired wait follows from it.
- `NetworkHealthProbe` — Core-side `http` (2xx/3xx) and `tcp` (connected) probes on loopback, used
  for a `localCommand` service that declares a `healthcheck`; container `HEALTHCHECK` for docker.
- The supervisor observes health every 15 s (`SuperviseInterval`) and reconciles `runtimeState` from
  it through `ResolveRuntimeStateFromHealth`; restart policy acts on `stopped` only.

What is missing: the aggregate is not persisted (it lives in the supervisor tick and in
`/api/apps/{id}/health`, never in the list — `core-read-path-caching` removed probing from the read
path on purpose); a service with no declared `healthcheck` is never probed; and every consumer that
needs readiness reads `IsUp` instead.

## Target behavior

Written as a diff against the feature documents it touches.

**Core** ([App Lifecycle States](../app-lifecycle-states/feature.md)):

- The app record carries the aggregate health status the supervisor last observed. `/api/apps`
  projects it without probing. `runtimeState` is unchanged in meaning and in every transition.
- A start verb, after the runtime is up, runs the first readiness wait itself — bounded — and writes
  health `starting` → `healthy` (or `degraded` on expiry) before returning. `runtimeState` is stamped
  `running` when the runtime is up, as today; the wait writes health only, so it never contends with
  the supervisor for the state. Without this the 15 s tick is the floor on how late readiness lands.
- A service that declares no `healthcheck` but exposes the app's UI endpoint gets an implicit `tcp`
  check on that endpoint. A declared `healthcheck` always wins. `tcp` rather than `http` because a
  401 or a 404 is a server that is up, not a server that is ill; a service that wants a stricter
  answer declares `http` with a path.
- An expired wait is **not** a failed start: the process is alive. It is health `degraded` — the
  value the aggregate already produces for "every process running, a probe failing" — which the
  supervisor keeps observing and flips to `healthy` when the app answers. Not `unhealthy`: at the app
  level that word is reserved for a liveness mix, and `ResolveRuntimeStateFromHealth` maps it to
  `unknown`, which would take the app's `running` away for a port that is merely late.
- Persisted health is meaningful only while `IsUp`. A stop, a failed start, a removal and an install
  clear it, and every readiness consumer reads `IsUp && healthy`, never health alone.
  `ObserveRuntimeHealthForAppAsync` skips apps that are not up, so without the clear a stopped app
  would keep its last `healthy` for as long as it stayed stopped.
- The health observation takes the per-app operation lock non-blockingly and skips an app whose verb
  is in flight — the rule the docker sweep already follows — so while a start verb runs its readiness
  wait, the verb is the only writer. Today the observation takes no lock, and a slow tick sampled
  before readiness could commit after the verb's `healthy` and revert it until the next tick.

**Shell** ([Core App Shell](../core-app-shell/feature.md),
[App UI Surfaces](../app-ui-surfaces/feature.md)):

- The Dashboard's app-row badge composes the two axes — `running · starting`,
  `running · degraded` — the way Aspire's does. Display only; the per-service rows keep their own
  health as today.
- A surface tab (panel, settings) embeds when the app is **healthy**. While health is `starting` it
  reports progress the way `runtimeState` `starting` does now. The known-gap paragraph in App UI
  Surfaces is removed when this lands.
- The sidebar's launch and the workspace follow the same rule.

**Other consumers:**

- `AppDependencySummary.Running` reports a provider **healthy**, not merely up — the summary's
  `installed` / `running` semantics are documented in
  [Cross-App Dependencies](../cross-app-dependencies/feature.md), and this changes what `running`
  answers there.
- `hosty mcp`'s `ToolCatalog` includes an app's tools when it is healthy.
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

- **Which services get the implicit check.** The minimum that closes the observed gap is the service
  carrying the app's UI endpoint. A dependent app, though, may consume a different endpoint of the
  same provider — an API port with no UI on it — and `AppDependencySummary.Running` then needs that one probed
  too. Every endpoint the app publishes to others (UI entry, dependency-provided endpoints), or the
  UI one only?
- **The aggregate rule under a persisted value.** The existing fold has one consequence worth a
  decision: one sidecar's failed probe makes the whole app `degraded`, and if embedding is gated on
  `healthy` alone, a UI that is perfectly reachable stays hidden behind a sidecar it does not need.
  Gate consumers on the *endpoint's own service* being healthy, or on the app aggregate?
- **The bounded wait.** Long enough for a cold `next dev`, short enough that the operator is not
  staring at `starting` for a genuinely broken app; and whether it is one value or per-runtime.
- **Docker port publishing.** With a userland proxy a `tcp` connect may succeed before the container
  listens. Measure before trusting the implicit check for docker; the container's own `HEALTHCHECK`
  wins wherever the image has one.
- **Autostart fan-out.** Start-verb waits under tier-parallel autostart
  ([Core Lifecycle Parallelism](../core-lifecycle-parallelism/feature.md)) need bounded concurrency,
  or the deadlines add up into boot time.
- **`starting` versus `degraded` after the wait.** Aspire collapses both into `Unhealthy`; keeping
  them apart tells the operator "still coming up" from "came up wrong". Worth the extra word?

## Deliverables

### Phase 1 — Core: health as persisted state

- [ ] The supervisor persists the aggregate health status on the app record; `/api/apps` projects it,
      still without probing.
- [ ] A start verb runs the bounded readiness wait and writes health before returning; `runtimeState`
      transitions are untouched.
- [ ] Implicit `tcp` healthcheck on the UI endpoint for a service that declares none.
- [ ] Stop, failed start, removal and install clear the persisted health; consumers gate on
      `IsUp && healthy`.
- [ ] The health observation takes the operation lock non-blockingly and skips a held app.
- [ ] `CoreLifecycleServiceTests`: a late-binding endpoint reaches `healthy` inside the wait; one that
      never binds leaves `running` + `degraded` and is picked up by the next observation; a declared
      `healthcheck` overrides the implicit one; a stopped app reads no health; an observation that
      finds the lock held writes nothing.

### Phase 2 — Shell: composed status, embed on health

- [ ] App-row badge composes `runtimeState` with health.
- [ ] Surface tabs embed on `healthy`; health `starting` reports progress.
- [ ] Sidebar launch and workspace follow the same rule.
- [ ] `app-surface-tabs.test.mjs` covers the health gate the way it covers the runtime-state one.
- [ ] Remove the known-gap paragraph from App UI Surfaces' `feature.md`.

### Phase 3 — Other consumers

- [ ] `AppDependencySummary` reports provider health.
- [ ] `ToolCatalog` gates on health.
- [ ] `hosty apps list` shows the composed status.

### Verification

- [ ] Live, on a host: start `com.haas.demo-app` from its Shell panel and watch the row go
      `running · starting` → `running`, with the panel opening on the second and never rendering a
      connection-error frame. This is the check that matters — no unit test observes what the browser
      renders inside a cross-origin frame.

## Links

- [App Lifecycle States](../app-lifecycle-states/feature.md) — the two axes, and why `running` is
  not delayed for health.
- [App UI Surfaces](../app-ui-surfaces/feature.md) — carries the known gap this closes.
- [Cross-App Dependencies](../cross-app-dependencies/feature.md) — the dependency summary whose
  `running` this redefines.
- [Dependency-Ordered Autostart](../dependency-ordered-autostart/plan.md) — owns `Waiting`.
- [Automatic Runtime App Ports](../automatic-runtime-app-ports/plan.md) — the neighboring
  "honest state" work for `unavailable`.

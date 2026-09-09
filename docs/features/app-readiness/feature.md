# App Readiness — Readiness Is Health

Created: 2026-09-09
Updated: 2026-09-09

A client — Shell, a dependent app, `hosty mcp` — acts on an app's endpoint when that endpoint can
answer, and not a moment before. No third state axis was added for it: `runtimeState` says whether
the runtime is up, per-service health says whether it answers, and readiness is the second of those —
kept per service, probed by default, persisted on the record, and read by every consumer for the
service that serves the endpoint it is about to use.

## The problem it closes

Core stamped `running` the moment a `localCommand` process started (a fixed 250 ms after spawn) and
a docker container came up — not when either listened. Shell embedded on `running`, and for the
second a `next dev` app took to bind its port the panel rendered the browser's own
`127.0.0.1 refused to connect` page. Nothing in Shell could observe that: the frame is cross-origin.

## Two axes, composed

- **`runtimeState`** (lifecycle, [App Lifecycle States](../app-lifecycle-states/feature.md)) is
  unchanged in meaning and in every transition.
- **Health** is observed per service — liveness (`running` / `exited` / `stopped`) and a probe result
  (`healthy` / `unhealthy` / `starting`, or null when nothing probes the service) — and folded per app
  (`healthy` / `starting` / `degraded` / `unhealthy` / `stopped` / `unknown`, the liveness-first
  vocabulary the lifecycle document defines). The fold exists for the badge only.
- **Readiness of an endpoint** is decided from the service that owns it: no lifecycle verb in flight,
  the service's status `running`, and its health `healthy` or null. Never from the app-level state or
  fold — a partial outage turns the app `unknown`, and a dead sidecar must not close a working
  endpoint.

The record persists the last reading (`AppRecord.Health` → `health` on the app summary: the fold, the
services, `observedAt`), so `GET /api/apps` carries it without probing on the read path. Surfaces and
navigation entries name the service that serves them (`service` on `settingsSurface`, `panelSurfaces`
and `navigation` entries), and interface summaries name theirs, so a consumer can find the reading.

## Probes

A service that declares an http/tcp `healthcheck` is probed by it (a health rule: 2xx/3xx, on the
declared path). A docker service with an image `HEALTHCHECK` reports the container's own verdict.
Neither is ever overridden. A service with no signal of its own gets an **implicit** probe on every
endpoint the app publishes from it — the UI entry, a dependency-provided endpoint, an MCP interface —
because those are exactly the addresses a client is about to use:

- **`localCommand`**: a tcp connect on loopback at the published host port.
- **docker**: an http request the container itself has to answer, on the service's http endpoints
  only, passing on **any** response — a 401 or a 404 is a server that is up. Measured on 2026-09-09
  (Docker Desktop on macOS): a tcp connect to a published port succeeds the instant the port exists,
  six seconds before the container listens, because the userland proxy accepts on the container's
  behalf; an http request fails (`RemoteDisconnected`) until the container serves. A docker endpoint
  that is not http (redis, raw tcp) gets no implicit probe — tcp would lie and http does not apply —
  and its image `HEALTHCHECK` is the only signal.

A service with neither a healthcheck nor a published endpoint has nothing to probe and reads as ready
the moment its process is alive. Probe targets are built once (`AppReadinessProbes`) and shared by
the start verb's wait, the supervisor's observation, and the on-demand `/api/apps/{id}/health`, so
the three never disagree about a service.

## The wait

Inside the start verb — after the runtime adapter has launched every process or container, before
`running` is written — Core waits for the app's services to answer. The record reads `starting` for
the whole wait: that state already means "a verb is in flight, holding the lock", the port-release
wait and the image pull are already counted inside it, and the supervisor observes only `IsUp`
records, so it is not a second writer. Shell shows progress and offers no Stop; a Stop requested
meanwhile waits for the lock, as for any in-flight start. `RestartCoreAsync` calls the adapter
directly rather than through `StartCoreAsync`, so the wait sits between the adapter's return and the
record write in both verbs.

The budget is **30 seconds** by default, one per app, overridable per runtime profile as
`readinessTimeoutSeconds` (validated positive). Counted after launch — image pulls and `setup` are not
inside it. Services are checked in parallel, about once a second, each probe bounded by 2 s. Liveness
is checked on every iteration, and the verb's cancellation is honoured. Outcomes:

| outcome | `runtimeState` | service health |
| --- | --- | --- |
| every probed service answers | `running` | `healthy` |
| budget expires, processes alive | `running` | `unhealthy` for the silent ones (fold `degraded`); the supervisor keeps observing |
| a process exits during the wait | the existing failed-start path (`app_start_service_exited`) | cleared |

An expired budget proves nothing about the app, so it is not a failure: services that already
answered keep `healthy`, and the next observation flips the rest when they answer. While the wait
runs a pending service reads `starting` whatever the raw probe said, and each change of reading is
persisted, so a client watching the row sees services come up. A service the adapter answered for — a
container `HEALTHCHECK` still in its `start_period` — keeps the adapter's word past the budget: the
image's `start_period` is its author's budget, and it reads `running · starting` until the container
decides. Measured on the live host: `com.haas.demo-app` (two `next dev` services) reaches `running`
about four seconds after Start from the panel, and a full restart — stop, `npm install`, start, wait —
takes about nine seconds; the budget never expired.

Health is reset to `starting` at the head of a start, so a previous run's `healthy` cannot survive
into the next, and cleared by a stop, a failed start, a cancellation settle, a removal and an
install. It is meaningful only while some service is alive; the observation clears it once every
service is gone and keeps it through a partial outage, so the living service's endpoint stays ready
while the app reads `unknown`.

## The observation

The supervisor's 15 s tick folds the same probes into the adapter's health, reconciles
`runtimeState` as before, and persists the reading — under the per-app operation lock, taken
non-blockingly (the docker sweep's rule), so an observation sampled before a Stop cleared the health
cannot commit after it, and only when the reading or the state actually changed, so a healthy app is
not rewritten every tick. A probed service is never regressed to `starting`: that word is the wait's
alone.

## Consumers

- **Shell** ([App UI Surfaces](../app-ui-surfaces/feature.md), [Core App Shell](../core-app-shell/feature.md),
  [Shell Navigation](../shell-navigation/feature.md)): the Dashboard badge composes the two axes
  (`running · starting`, `running · degraded`) with the health's tone; a surface tab opens when its
  service is ready, shows progress while `starting`, and offers **Open anyway** when `degraded` — and
  with no reading at all (an older Core, or an app not yet observed) the lifecycle state decides, so
  a Core that reports no readiness never holds a row; a frame already open survives `healthy → degraded` and is unmounted only by the
  lifecycle axis; the sidebar row and a workspace launch open by the readiness of the service serving
  the page — `starting` holds them, `degraded` lets them through (the click is the row's "open
  anyway").
- **Dependencies** ([Cross-App Dependencies](../cross-app-dependencies/feature.md)):
  `AppDependencySummary` keeps `running` as the provider's lifecycle fact and gains `healthy` —
  whether the provider services behind the consumed endpoints answer — and the computed
  `ready = running && healthy`; Shell raises a warning for a running provider that is not answering.
- **`hosty mcp`** ([Hosty MCP Connector](../hosty-mcp-connector/feature.md)): an interface enters the
  catalog when the service that serves it answers, so a sibling's outage neither hides a working
  interface nor lets a silent one in; a Core that reports no readiness falls back to the state alone.
- **CLI**: `hosty apps list` composes the state with the fold; `hosty apps health` shows the probe
  result per service.

## Out of scope, by decision

Restarting an app for being `degraded` or `unhealthy` (restart policy stays crash-only); a `Waiting`
state for dependents ([Dependency-Ordered Autostart](../dependency-ordered-autostart/plan.md));
`availability: "unavailable"` for a port another process holds
([Automatic Runtime App Ports](../automatic-runtime-app-ports/plan.md)); and realigning the health
words with ASP.NET's severities, which the lifecycle document records as deliberately left alone.
Autostart keeps its four slots and its barrier at the adapter's return; the worst added wait for a
tier of `N` apps is about `ceil(N / 4) × 30 s`.

## Testing Expectations

- `AppReadinessProbesTests`: the implicit target per runtime — docker http endpoint → any-response
  http; docker non-http endpoint → none; localCommand → tcp; a declared http healthcheck keeps the
  health rule and its own timeout; an endpoint with no published URL is not probed.
- `HealthProbeTests`: the any-response flag passes a 404 that the health rule fails, and still fails
  when nothing answers.
- `CoreLifecycleServiceTests` (readiness): a late-binding endpoint reaches `healthy` inside the wait;
  expiry leaves `running` + `degraded` and the next observation recovers; the profile budget wins over
  the default; a process that exits mid-wait fails the start; restart runs the same wait; stop clears
  health and a new start does not inherit it; an observation skips an app whose verb holds the lock;
  a partial outage keeps the living service ready while the app reads `unknown`; an observation never
  regresses a probed service to `starting`; a container `HEALTHCHECK` overrides the implicit probe
  and its word survives the budget; a non-positive `readinessTimeoutSeconds` is rejected; the
  dependency summary reads `healthy`/`ready` by the serving service.
- `app-surface-tabs.test.mjs`: the three readings on one lifecycle state, a service nothing probes,
  no reading at all being ready, a dead sibling not closing a working endpoint, a verb in flight blocking every
  open, the fold fallback, and the launch gate. `app-problems.test.mjs`: the not-answering warning.
- `ToolCatalogTests`: an interface is asked only when its service answers.
- Live, on a host (2026-09-09): Start from the panel holds `starting` and opens on the second with no
  connection-error frame; a killed sidecar leaves the row `unknown` with the sibling's panel open; a
  restart runs the wait; `hosty apps health` shows the probe per service.

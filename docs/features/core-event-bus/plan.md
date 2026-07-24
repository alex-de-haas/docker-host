# Core Event Bus — Ephemeral Domain Events With A Shell Realtime Consumer

Status: In Progress
Created: 2026-07-24
Updated: 2026-07-24

## Goal

Give Core an in-process, ephemeral domain event bus so that connected clients
learn "something changed — re-read it" without polling. The first consumer is
the Shell Installed Apps page, which today refreshes only on user action, after
mutations, and via a 4-second poll while update work is in flight.

## Semantics: hints, not facts

The bus deliberately stores nothing. Durability belongs to the data, not the
transport:

- Source of truth is always the Core API (`GET /api/apps` and friends). An
  event is a hint to re-read state, never a record of what happened.
- Core restart loses all in-flight events; a disconnected subscriber misses
  events until it reconnects. Both are fine because of the subscriber contract
  below.
- **Subscriber contract:** open the stream → resync the state you care about
  via the API → only then react to events; every reconnect repeats the same
  cycle. No `Last-Event-ID`, no replay, no cursors.
- Consequence, stated openly: consumers whose correctness depends on never
  missing a *transition* that leaves no trace in durable state (e.g. "run X
  after every crash" automation) are out of scope by design. Durable domain
  state already covers the realistic cases (restart counts in health, audit in
  `AuditStore`, undelivered notifications in `NotificationStore`). If a real
  need appears, a durable log can be added later as one more subscriber of the
  same in-process hub without touching publishers or existing consumers.

## Design

### Hub

- `DomainEventHub` (name TBD at implementation), modeled on
  `NotificationBroadcaster`: per-subscriber bounded `Channel` with
  `DropOldest` — losing a hint is harmless, the next event or a resync
  corrects it.
- Event shape v1: `{ name, appId?, occurredAt }`. No payload — clients
  re-read via the API. Payload fields may be added additively later. While the
  hub is in-process and Shell is the only consumer, the shape is not a public
  contract and may change freely.

### Taxonomy v1

Derived from the `AppRegistryStore` choke point, which every state commit
passes through:

- `app.changed` — record committed (covers install, every lifecycle verb,
  supervisor `RuntimeState` flips, reconcile). One name for all commits: v1
  consumers react identically (refetch the list), and the create-vs-update
  distinction is derivable at the choke point if a consumer ever needs an
  `app.installed` of its own.
- `app.removed` — record removed.
- `app.update-check.changed` — the app's update-availability verdict changed
  (a plan build refreshed it, a sweep check failed for it, or it was pruned).
- `apps.update-check.changed` — the fleet update sweep started or finished
  (drives the "Check updates" spinner).

Richer names (`app.started`, `app.crashed`, `app.updated`, …) follow the
event-subscription taxonomy sketched in
[core-extension-model](../../ideas/core-extension-model.md) and are added
additively from the lifecycle verbs when a consumer actually needs them.

### Publish points

- `AppRegistryStore.UpsertAppCoreAsync` — the private method both public
  writers (`UpsertAppAsync`, `UpdateAppAsync`) funnel into, so publishing
  `app.changed` there after a successful write covers every commit by
  construction: 28 call sites in `CoreLifecycleService` today (6 upserts
  including install and update-apply, 22 update-in-place), and any added
  later. Publishing from the two public methods instead would be equivalent
  but easier to bypass; publishing from a hand-picked list of lifecycle
  verbs would not be. `RemoveAppAsync` publishes `app.removed`.
  Implementation notes: the publish happens while the per-app mutex is held,
  so it must stay non-blocking (channel `TryWrite`, which the drop-oldest
  hub guarantees); `UpsertAppCoreAsync` can distinguish create from update
  (the record's `InstalledAt` is unset before normalization) if the
  taxonomy ever needs it.
- The update-availability projection — the in-memory
  `CoreLifecycleService.updateAvailability` dictionary, deliberately not part
  of `AppRecord` — is the second choke point: its three write points
  (successful plan build, `RecordUpdateCheckFailure`,
  `PruneUpdateAvailability`) publish `app.update-check.changed`. Verdicts
  never pass through the store, so `app.changed` cannot cover them; routing
  through the projection writes covers sweep results, dialog-open re-plans,
  refresh probes, and the post-apply re-plan uniformly, and verdicts reach
  the page incrementally as checks complete (the sweep runs 3-wide and takes
  tens of seconds on a large fleet). Rejected alternative: persisting
  verdicts into `AppRecord` to ride the store choke point — that turns a
  deliberately ephemeral projection into durable state (restart staleness,
  fleet-wide disk writes per sweep) to solve an eventing problem.
- `AppUpdateSweepService` — `apps.update-check.changed` on run-state
  transitions: start in `Trigger`/`RunAsync`, finish in a `finally` around
  the sweep body so the spinner clears even on a sweep-level failure.
- Events published by apps (via a Core API producer endpoint, service-token
  authed, namespaced by source app id so an app can never spoof a Core event)
  are a future phase — see Non-goals.

### SSE endpoint

Copies the proven `GET /api/notifications/stream` plumbing verbatim:
`text/event-stream` + `X-Accel-Buffering: no`, initial `: connected` comment,
20s `: ping` heartbeat (Cloudflare), and — critically — a CTS linked to
`ApplicationStopping` so an open stream never starves the shutdown sweep.

- **Unified endpoint (decided):** `GET /api/events` carries both domain
  events and notifications as named SSE events (`event: <name>`,
  `data: {json}`); the notification bell migrates onto it and
  `GET /api/notifications/stream` is removed in the same change — Shell is
  its only consumer, and an older Shell against a newer Core degrades to the
  bell's existing 30s polling fallback. One SSE connection per tab instead of
  two (HTTP/1.1 browsers cap ~6 per origin), and every future event type is
  free.
- Auth: `RequireSessionAsync` (cookie session, EventSource-compatible), with
  per-subscriber fan-out — notifications go to their recipient as today,
  domain events only to admin sessions, so they carry `appId` freely. If the
  non-admin launcher ever wants realtime, domain-event fan-out relaxes to the
  existing `AppAccessPolicy.CanAccessApp` filter — deliberately not now.

### Shell consumer

- The EventSource client lives in `ShellClient` (owner of `state.apps`),
  written in the shape of the future SDK API: a mandatory `onSync` callback
  runs on every (re)connect before events are delivered, so the
  resync-on-connect discipline is structural, not conventional.
- On event → debounced (~300 ms) light refetch of `GET /api/apps` only (not
  the full `refresh()` — status/session/global-mounts don't need re-reading).
  The debounce absorbs multi-commit verbs like install.
- Extra resyncs on `visibilitychange` → visible.
- The 4s update-work poll (`UPDATE_WORK_POLL_INTERVAL_MS`) becomes redundant —
  everything it can observe is a record commit, which now emits an event. It
  is removed in phase 2 after live verification.

## Non-goals (deferred, tracked elsewhere)

- **Durable log, cursors, at-least-once, event schema versioning** — the
  extension-model pull-subscription design
  ([core-extension-model](../../ideas/core-extension-model.md)) does not
  transfer its storage requirements into this feature. If that idea reaches
  Ready, its durable log subscribes to this same hub.
- **App-facing subscription and publication** (service-token SSE subscribe,
  producer endpoint) — future phase of the extension model, not this plan.
- **SDK extraction** — when app subscriptions ship, the client becomes
  `@hosty-sdk/app/events` (subpath of the umbrella per the granularity
  decision, never a separate package) plus a .NET counterpart in
  `HostySdk.App`, with the mandatory-`onSync` API carried over. Publishing the
  client before the app endpoint exists would freeze the wire format under the
  SDK's additive-only compat policy for zero consumers.
- **Notifications refactor** — inline `Notify*Async` call sites could later
  become event→notification mappers, but notifications embed targeting
  decisions a domain event doesn't carry; separate cleanup, separate plan.

## Deliverables

Phase 1 — Core (platform minor):

- [x] `CoreEventHub` with bounded drop-oldest per-subscriber channels.
- [x] Publishes from the `AppRegistryStore` commit choke point —
      `app.changed` from the private `UpsertAppCoreAsync` (covering both
      public writers), `app.removed` from `RemoveAppAsync`.
- [x] Publishes from the update-availability projection write points
      (`app.update-check.changed`) — four sites, not the three the plan
      assumed: the post-apply reset is one too, now routed through the same
      `SetUpdateAvailability`/`ClearUpdateAvailability` helpers.
- [x] Publishes from `AppUpdateSweepService` run-state transitions
      (`apps.update-check.changed`), finish via `finally`.
- [x] Unified `GET /api/events` SSE endpoint (session auth, admin-only
      domain-event fan-out, notifications folded in as named events;
      heartbeat, `ApplicationStopping`-linked CTS);
      `GET /api/notifications/stream` removed.
- [x] Tests modeled on `NotificationConsumerEndpointsTests`: auth gate,
      event delivery, disconnect cleanup, shutdown does not hang on an open
      stream.

Phase 2 — Shell (shell minor):

- [x] EventSource client in `ShellClient` with mandatory-`onSync` shape,
      auto-reconnect resync, `visibilitychange` resync.
- [x] Debounced `/api/apps`-only refetch wired to `app.*` /
      `apps.update-check.changed` events.
- [x] Migrate the notification bell onto the unified stream (drop its
      dedicated EventSource; keep the 30s polling fallback).
- [x] Remove the 4s update-work poll —
      both of its triggers are now covered: `operationStatus: "updating"`
      is a record commit (`app.changed`) and sweep progress is
      `apps.update-check.changed`.

## Open questions

None. Both were resolved with the owner in chat on 2026-07-24: unified
`/api/events` over a dedicated apps stream (endpoint decision), and the
update-availability projection writes as the second publish choke point
(verdicts verified to be in-memory only — `app.changed` cannot cover them).

**Status approval:** the owner reviewed this plan with no open questions
left and approved `Status: Ready` explicitly in chat on 2026-07-24, as
AGENTS.md requires. Implementation has not started; the first implementation
commit flips this to `In Progress`.

## Verification

- Core unit tests as listed in deliverables.
- Live: two browser windows on Installed Apps; install / start / stop /
  uninstall / update an app in one and watch the other update without manual
  refresh; kill and restart Core and confirm the page resyncs on reconnect.
- Confirm `hosty core stop` completes within the normal budget with an open
  events stream (regression guard for the SSE shutdown-starvation class).

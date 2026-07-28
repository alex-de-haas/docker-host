# App Lifecycle States — Intermediate `starting` / `stopping`

Status: In Progress
Created: 2026-07-28
Updated: 2026-07-28

## Goal

Give an installed app real intermediate runtime states, so clients stop having to infer "busy" from
the absence of "running". Today `AppRecord.RuntimeState`
([AppRegistryStore.cs:234](../../../apps/core/src/Haas.Hosty.Core/AppRegistryStore.cs)) is written
exactly once per lifecycle verb — **after** the adapter returns — so between the click and the result
the record says nothing changed. A start that pulls an image, resolves a source checkout, or waits out
a lingering host port can run for minutes with the row reading `stopped` and offering a **Start**
button.

The vocabulary becomes `running` · `starting` · `stopping` · `stopped` · `unknown`. A
dependency-gated `waiting` is a separate feature — see
[dependency-ordered-autostart](../dependency-ordered-autostart/plan.md) — because it needs machinery
(topological autostart ordering) that does not exist yet, and nothing here depends on it.

## Why in-record state rather than a transient projection

An in-memory "operation in flight" map would be cheaper and self-healing, and for `starting`/
`stopping` alone it would be defensible. It does not survive contact with the `waiting` state that
follows: an app that should be running but whose dependency is down is in a **durable** condition that
must outlive a Core restart. Since the vocabulary has to be persistable then, splitting it across two
mechanisms now would be worse than paying the persistence cost once. The price is a boot sweep, which
this plan pays explicitly.

## The central refactor: one boolean becomes three predicates

Every current call site asks its question as `== "running"` or `!= "running"`. Those are three
different questions that happen to coincide while the vocabulary is binary:

| Predicate | Question | Members |
| --- | --- | --- |
| `IsUp` | may traffic reach it? | `running` |
| `IsBusy` | is a verb mid-flight — keep hands off? | `starting`, `stopping` |
| `IsIdle` | is it safe to do something destructive? | `stopped` — **not** `!IsUp` |

The third is the dangerous one: it is written today as `!= "running"` in gates that mean "only when
stopped", and those gates silently widen the moment an intermediate state exists. A blanket
search-and-replace to a single `IsLive()` helper is therefore not just insufficient, it introduces
bugs (see the port preflight below). Each site must be read and classified.

## Audit of the ~20 `RuntimeState` reads

**Must change:**

- [CoreLifecycleService.cs:954](../../../apps/core/src/Haas.Hosty.Core/CoreLifecycleService.cs) —
  `StopCoreAsync` is straight-line with **no `try`/`catch`**. Stamping `stopping` at its head without
  adding one means the first docker failure strands the record in `stopping` forever. `StartCoreAsync`
  already has the pattern to copy (`catch` → `RecordForegroundLifecycleFailureAsync`).
- [CoreLifecycleService.cs:2253](../../../apps/core/src/Haas.Hosty.Core/CoreLifecycleService.cs) —
  `RestoreBackupCoreAsync` throws `app_must_be_stopped` only for `running`; an app in `stopping`
  would pass. Must become an `IsIdle` check. Mirrored in the Shell's Restore button
  ([app-details-dialog.tsx:343](../../../apps/shell/src/app/shell/dialogs/app-details-dialog.tsx)).
- [CoreLifecycleService.cs:5056](../../../apps/core/src/Haas.Hosty.Core/CoreLifecycleService.cs) —
  `ResolveRuntimeStateFromHealth` feeds both reconcilers; it must never emit an intermediate value and
  never clobber `waiting`, or the supervisor and the lifecycle verb will fight over the record.
- [CoreLifecycleService.cs:5006](../../../apps/core/src/Haas.Hosty.Core/CoreLifecycleService.cs) and
  [:5160](../../../apps/core/src/Haas.Hosty.Core/CoreLifecycleService.cs) — both reconcile filters gate
  on `== "running"`, so a record stranded mid-transition by a Core crash drops out of supervision
  permanently for localCommand apps. Needs a boot sweep, modelled on `RecoverInterruptedUpdatesAsync`
  ([:1555](../../../apps/core/src/Haas.Hosty.Core/CoreLifecycleService.cs)) and sequenced before
  autostart reconciliation like its caller at
  [HostyCoreApplication.cs:1319](../../../apps/core/src/Haas.Hosty.Core/HostyCoreApplication.cs).
- [SystemAppBootstrapService.cs:200](../../../apps/core/src/Haas.Hosty.Core/SystemAppBootstrapService.cs)
  — `if (!running) StartAsync(...)` force-starts anything not running, which will override a
  deliberately `waiting` app once that state exists.

**Must deliberately NOT change:**

- [CoreLifecycleService.cs:1072](../../../apps/core/src/Haas.Hosty.Core/CoreLifecycleService.cs) —
  `FindUnavailableLoopbackAssignments` returns `[]` for `running` precisely so an app's own bound
  ports are not reported as stolen. Teaching it that `starting` is "live" would disable genuine
  cold-start conflict detection and the structured `runtime_port_unavailable` error. This is the same
  class of bug as the earlier "update failed: port already in use" regression. It stays `== "running"`.

**Unaffected, verified:** Cloudflare ingress and publication
([CloudflareIngress.cs:79](../../../apps/core/src/Haas.Hosty.Core/CloudflareIngress.cs),
[CloudflarePublicationService.cs:117](../../../apps/core/src/Haas.Hosty.Core/CloudflarePublicationService.cs))
reconcile right after the settling write; the telemetry scrape gate
([DockerStatsExposition.cs:53](../../../apps/core/src/Haas.Hosty.Core/DockerStatsExposition.cs)) just
idles a few seconds longer; `AttachAvailability`
([AppRegistryStore.cs:920](../../../apps/core/src/Haas.Hosty.Core/AppRegistryStore.cs)) honestly reports
`assigned`; the `wasRunning` captures inside verbs (`:663`, `:1831`, `:1960`, `:2219`) are taken before
the operation under the app lock; removal-impact reporting (`:2032`, `:2083`) passes the string to the UI.

## The `starting` naming collision

Container health **already** has a `starting` value
([RuntimeAppManifest.cs:1765](../../../apps/core/src/Haas.Hosty.Core/RuntimeAppManifest.cs)), meaning
"container up, HEALTHCHECK not passed yet" — nearly the opposite of an app-level `starting` ("no
container yet"). Resolved under Decisions below: the names stay, because the two values render in
different places and each is correct where it appears.

## Phases

**Phase 1 — predicates, no behavior change.** Introduce `IsUp` / `IsBusy` / `IsIdle` and reclassify
every call site to the one it actually means, while the vocabulary is still binary. Pure refactor,
independently reviewable, and it makes phase 2 safe.

**Phase 2 — `starting` / `stopping` in Core.** Stamp at the head of `StartCoreAsync`, `StopCoreAsync`,
`RestartCoreAsync`; add the missing stop failure path; add the boot recovery sweep. The existing
registry write choke point
([AppRegistryStore.cs:127](../../../apps/core/src/Haas.Hosty.Core/AppRegistryStore.cs)) publishes
`app.changed` for free, so clients need no new transport.

**Phase 3 — clients.** Shell: a transitional bucket in `StatusBadge`
([ui.tsx:82](../../../apps/shell/src/app/shell/ui.tsx)); a third state for the Start/Stop toggle
([installed-apps-page.tsx:973](../../../apps/shell/src/app/shell/pages/installed-apps-page.tsx)), which
is binary today and would offer **Start** to an app that is already starting; the Restore gate; the
dashboard counters that would count a transitioning app as neither running nor needing attention
([dashboard-page.tsx:23](../../../apps/shell/src/app/shell/pages/dashboard-page.tsx)); and the
transient "required settings have no value" warning
([app-problems.ts:41](../../../apps/shell/src/app/shell/app-problems.ts)). CLI needs one line —
`ConsoleUi.State` ([ConsoleUi.cs:65](../../../apps/cli/src/Haas.Hosty.Cli/Commands/ConsoleUi.cs))
already colours `starting` and `stopping`.

## Decisions

1. **The app-level names stay `starting` / `stopping`; the collision is documented, not renamed.**
   Checked rather than assumed: the two values never reach the same cell. Container health seeds a
   per-**service** row and wins there (`health?.status || app.runtimeState`,
   [app-helpers.ts:329](../../../apps/shell/src/app/shell/app-helpers.ts)), while the app-level value
   renders in the **app** row badge. Each appears exactly where its own meaning is the true one.
   Renaming to something unfamiliar would make the API worse to fix a conflict that does not occur;
   docker itself carries the same pair (`State.Status` vs `State.Health.Status`).
2. **No separate `restarting`.** A restart stamps `stopping`, then `starting`. Both are `IsBusy`, so
   the client behaves identically to a dedicated value, and the operator gets to see which half is
   slow. `ConsoleUi.State` already colours `restarting`; nothing will produce it, which is harmless.

## Deliverables

- [ ] Phase 1: `IsUp`/`IsBusy`/`IsIdle` helpers; every `RuntimeState` comparison reclassified; the port
      preflight explicitly commented as intentionally `IsUp`-only.
- [ ] Phase 2: stamping in the three verbs; `try`/`catch` + failure recording in `StopCoreAsync`;
      boot recovery sweep for stranded intermediate states, sequenced before autostart.
- [ ] Phase 3: Shell transitional badge, tri-state lifecycle toggle, Restore gate, dashboard counters,
      settings-warning suppression.
- [ ] `feature.md` documenting the vocabulary, the three predicates, and the recovery guarantee.
- [ ] Version bump: platform in `Directory.Build.props`, `apps/shell` `manifest.json` + `package.json`.

## Verification

- Unit: a verb that throws mid-flight leaves the record in a terminal state, never `stopping`.
- Unit: the boot sweep clears an intermediate state written by a previous process, and leaves a
  legitimately in-flight verb alone (the same single-flight guard `RecoverInterruptedUpdatesAsync` uses).
- Unit: cold-start port conflict still raises `runtime_port_unavailable` after the refactor — the
  regression guard for the one site that must keep `== "running"`.
- Unit: `ResolveRuntimeStateFromHealth` never returns an intermediate value.
- Live: start an app with a cold image pull from one browser tab and watch a second tab show
  `starting` and a disabled toggle throughout, then settle — the whole point of the feature.
- Live: `hosty core stop` mid-start, restart Core, confirm the app is not stranded and is supervised.

## Related

- [dependency-ordered-autostart](../dependency-ordered-autostart/plan.md) — adds the `waiting` state
  to the vocabulary this feature establishes.
- [cross-app-dependencies](../cross-app-dependencies/feature.md) — its `AppSummary.Dependencies`
  projection is what that later feature gates on.
- [core-event-bus](../core-event-bus/feature.md) — the transport that makes these states visible
  without polling.

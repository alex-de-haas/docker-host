# Cross-App Dependencies — Dependency Status As State, Not Notifications

Status: Ready
Created: 2026-07-28
Updated: 2026-07-28

## Goal

Replace the start-time dependency advisory with derived state the Shell renders beside the app.
"Your dependency is not running" is a **condition** that resolves itself when the operator starts the
dependency — not an event worth a durable, individually-dismissable notification.

## Why the advisory has to go

Two defects, both structural rather than incidental:

- **It re-fires on every start.** `NotifyMissingDependenciesAsync` runs from `StartCoreAsync`
  ([CoreLifecycleService.cs:914](../../../apps/core/src/Haas.Hosty.Core/CoreLifecycleService.cs)), and
  the dedupe in
  [NotificationService.cs:69](../../../apps/core/src/Haas.Hosty.Core/NotificationService.cs) only
  matches notifications that are still **unread**. Once an admin reads it, the next start creates it
  again. Core boot starts every autostart app in capability-priority then alphabetical order
  ([CoreLifecycleService.cs:2481](../../../apps/core/src/Haas.Hosty.Core/CoreLifecycleService.cs)) —
  not dependency order — so a normal restart of the host reliably produces a burst of these.
- **Nothing ever retracts it.** The notification store has dedupe and `ReadAt`, but no revoke. When
  the dependency is started the advisory stays in the list, describing a world that no longer exists.

The information itself is worth surfacing. Only its shape is wrong.

## Target behavior

A diff against [feature.md](feature.md)'s `## Advisory` section, which this replaces with
`## Dependency State`.

**Core** projects resolved dependency state onto `AppSummary` — state, not verdict:

```jsonc
"dependencies": [
  { "appId": "com.haas.torrent-engine", "required": true, "installed": true, "running": false,
    "endpoints": [ { "key": "control", "alias": "torrent", "resolved": true } ] }
]
```

`AppRecord.Dependencies` already exists; `AppSummary` carries nothing about them today
([AppRegistryStore.cs:681](../../../apps/core/src/Haas.Hosty.Core/AppRegistryStore.cs)), which is the
one hard blocker — the Shell cannot derive any of this client-side.

**Shell** turns that into problem icons through the existing machinery: `collectAppProblems`
([app-problems.ts](../../../apps/shell/src/app/shell/app-problems.ts)) →
`AppProblemIcons`
([installed-apps-page.tsx:1013](../../../apps/shell/src/app/shell/pages/installed-apps-page.tsx)),
which already renders a red `CircleAlert` and an amber `TriangleAlert` in the row and expands to the
same list in the panel.

| Dependency state | Today | Target |
| --- | --- | --- |
| required, not installed | error notification | 🔴 icon |
| required, installed, not running | warning notification | 🔴 icon |
| optional, installed, not running | warning notification | 🟡 icon |
| optional, not installed | warning notification | nothing — an uninstalled optional dependency is a choice, not a problem |
| running, wired endpoint has no URL | warning notification | 🟡 icon |

`NotifyMissingDependenciesAsync` is then deleted whole, not halved.

**Deliberately unchanged:** the reverse direction. `torrent-engine` gets no icon for "3 apps depend
on me" — it has no problem, and a problem icon that does not mean a problem devalues every other
icon. Naming dependents in the stop confirmation is a separate, later idea; the data for it already
exists as `AppRemovalConsumer`
([CoreLifecycleService.cs:2083](../../../apps/core/src/Haas.Hosty.Core/CoreLifecycleService.cs)).

## Design note: why state, not verdict, crosses the wire

`collectAppProblems` takes **one** app and is deliberately a leaf module with no runtime imports so it
stays testable under `node --test`. Deriving dependency problems client-side would mean passing it the
whole app list and breaking both properties. Having Core emit a finished verdict instead would move
problem derivation out of the one place that owns it, which is exactly the drift the module's header
comment warns against. Projecting *resolved state per dependency* keeps the signature, keeps the
single derivation site, and lets the panel name which dependency is missing.

## Decisions

1. **Unread `dependency-*` notifications are purged once at boot.** Shipping a feature whose purpose
   is "stop the dependency noise" while leaving the accumulated noise in place would only half-deliver
   it, and nothing else will ever retract those records — the store has dedupe and `ReadAt`, but no
   revoke.
2. **Per-endpoint state nests inside its dependency.** The panel groups by dependency anyway, so a
   flat list would have to be re-grouped at render time.
3. **`optional, not installed` is silent.** An optional dependency the operator never installed is a
   choice, not a problem; an icon there would train operators to ignore the icon.
4. **Installed Apps only.** The sidebar and Available Apps carry no problem icons at all today, and
   introducing them there is a UI decision this feature does not need to make.

## Deliverables

- [ ] `AppSummary.Dependencies` projection in `BuildAppSummaryAsync`, with the dependency's installed/
      running state and per-endpoint resolution.
- [ ] Delete `NotifyMissingDependenciesAsync`, its call site in `StartCoreAsync`, and its tests.
- [ ] One-time boot purge of unread `dependency-*` notifications (decision 1).
- [ ] Shell: `dependencies` on `CoreApp` in `types.ts`; dependency rows in `collectAppProblems`; panel
      detail naming the specific dependency and what is wrong with it.
- [ ] Rewrite `feature.md`'s `## Advisory` as `## Dependency State`, and the `Non-goals` line that
      currently reads "It only notifies".
- [ ] Version bump: platform in `Directory.Build.props`, `apps/shell` `manifest.json` + `package.json`.

## Verification

- Unit (Core): the summary projection for each row of the matrix — not installed, installed+stopped,
  running, and running-with-an-unresolvable-wired-endpoint.
- Unit (Shell): `node --test` over `app-problems` covering all five matrix rows, including the silent one.
- Live: install media-server with `torrent-engine` stopped → red icon on the media-server row; start
  `torrent-engine` → the icon clears **without a Core restart**, arriving over the existing
  `app.changed` event ([core-event-bus](../core-event-bus/feature.md)).
- Restart Core with a dependency stopped and confirm no dependency notification is produced at all.

## Related

- [app-lifecycle-states](../app-lifecycle-states/plan.md) — the `waiting` runtime state consumes this
  projection as its trigger. That deliverable belongs there, not here.

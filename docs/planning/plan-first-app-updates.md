# Plan-First App Updates

Status: Draft
Created: 2026-07-16
Updated: 2026-07-16

Not yet approved for implementation. Captures the agreed design for one-click, reload-safe app
updates: update checking builds full reviewed-update plans up front, rows offer a silent "Update"
or an explicit "Review" based on the plan's change classes, apply runs as a Core-side background
operation with persisted progress, and "Update All" applies every routine update in one action.

## Goal

Collapse the current four-wait update ritual (check → open popup → apply → icon refresh, each a
multi-second network pass) into a single sweep that leaves per-app plans cached on Core, so the
common case — a routine image/version bump — is one click and ~zero extra waiting, while changes
that expand an app's footprint or privileges still require an explicit human review. Make every
piece of update state (availability, classification, progress, outcome) live on Core so a page
reload, Shell self-update, or second browser never loses it.

## Scope

- Classify every update plan on Core as routine or review-required (`requiresReview`), so clients
  never parse change strings.
- Replace per-app status probes with a fleet plan sweep: one pass builds and caches full update
  plans for every updatable app; `updateAvailable` derives from the cached plan.
- Add a read endpoint for the cached pending plan and project compact update availability into the
  app summaries Shell already fetches.
- Run the sweep periodically in the background (configurable interval, Core settings) and on the
  manual "Check updates" action; sweeps are single-flight and survive the triggering tab.
- Turn apply into an enqueue: persisted in-progress `OperationStatus`, execution detached from the
  HTTP request, completion/failure notification, boot sweep for interrupted applies.
- Parallelize per-service registry digest probes and share feed/manifest fetches within one sweep.
- Shell: plan-driven row buttons (blue "Update" split-button with a "Review" dropdown item for
  routine plans; yellow "Review" for review-class plans), silent apply by plan digest with
  error-plus-refresh on mismatch, per-app busy state derived from server state, "Update All".

## Out of Scope

- Auto-applying review-class changes under any flow, including "Update All": privilege/footprint
  escalations always need a human (see `role:runtime->system` rationale in `BuildUpdateChanges`).
- Changing the `app.0.1` manifest schema or the plan-digest/apply contract from PR #206.
- Push transport (SSE/WebSocket) for progress; polling stays in v1.
- Automatic rollback after a failed background apply (existing failure surfacing only).
- Scheduled unattended auto-apply (auto-update policy) — a possible later layer on top.
- CLI UX changes beyond staying compatible; adopting `requiresReview` in CLI plan rendering can
  follow separately.

## Current Behavior

- "Check updates" is a Shell-side loop of per-app `GET /api/apps/{id}/update-status`
  (4-wide pool). Each probe re-resolves the feed document, re-fetches the candidate manifest, and
  resolves per-service remote digests sequentially. Nothing is cached; a fleet check re-fetches a
  shared feeds.json once per app that uses it.
- Opening the update popup issues `POST /api/apps/{id}/update/plan`, which repeats the exact same
  resolution work the status probe just did. The plan is cached in `reviewedUpdatePlans` (one slot
  per app, 1h TTL) and apply consumes it verbatim by `planDigest` with a local base-state guard.
- Apply is request-scoped: the browser fetch carries the CancellationToken, so a page reload or
  Shell self-update mid-apply aborts the docker operations mid-flight and can leave the app
  stopped. `OperationStatus` has only post-hoc values (`installed`, `updated`, `failed`, ...).
- All progress and availability state is client memory: `updateStatusByApp` is page-level React
  state (lost on navigation), `busyAction` is a single slot (a second concurrent action clobbers
  the first's indicator), and `applyUpdate` closes/writes the single shared detail panel even if a
  different app's panel is open by then.
- After apply, Shell re-probes update-status from scratch (feed + manifest + registry) just to
  clear the row icon, even though a successful apply already implies "up to date".

## Target Behavior

- One sweep — the "Check updates" button or the background timer — builds plans for every
  updatable app. Rows render from the cached result: no changes → nothing; routine changes → blue
  "Update" split-button (dropdown: "Review"); review-class changes or an `artifact:...->unknown`
  entry → yellow "Review"; plan build failure → a "check failed" row state with the error.
- Clicking "Update" sends only the cached `planDigest`. Core validates fast (digest + base-state,
  both local), marks the record `operationStatus: "updating"`, runs the apply in the background,
  and answers immediately. Digest mismatch / staleness returns the existing error codes
  (`update_plan_digest_mismatch`, `update_plan_expired`, `update_plan_stale`); Shell toasts and
  refreshes that row's projection so the button reflects the new reality instead of resending a
  dead digest. No transparent client-side re-plan: with the background sweep keeping plans fresh,
  a mismatch means upstream genuinely moved and the operator should see that.
- "Review" opens the popup instantly over the cached plan (no rebuild). Applying from the popup
  uses the same enqueue path and closes the dialog immediately.
- "Updating…" is derived from `operationStatus` in the app list — reload the page, update Shell
  itself, open a second browser: the spinner is still there because it was never client state.
  Completion lands as a record flip (`updated`/`failed` + `LastError`) plus a notification through
  the existing notification hub, so a reloaded page still learns the outcome.
- "Update All" enqueues every routine plan (Shell's own app last), skips review-class apps, and
  summarizes: "5 updated, 2 need review, 1 failed". Closing the tab kills nothing.

## Acceptance Criteria

- A fleet sweep performs at most one fetch per distinct feeds.json / manifest URL and bounded
  parallel registry probes; a 10-app sweep is not 10× slower than a 1-app probe.
- `AppUpdatePlan` carries `requiresReview`; it is true iff the change list contains any entry
  that is not a routine `version:*`, `manifest`, or resolved-digest `artifact:*` change (an
  `artifact:*->unknown` entry always requires review), and false for a non-empty list of only
  routine changes.
- A plan with zero changes yields `updateAvailable: false` and no row button.
- `POST /api/apps/{id}/update` returns within ~1s; the apply continues on an application-lifetime
  token; aborting the HTTP request does not abort the apply.
- A record already `"updating"` rejects a second enqueue with `update_in_progress`.
- Core restart mid-apply leaves the record `failed` with an "interrupted" `LastError` after the
  boot sweep — never stuck at `"updating"`.
- After a successful apply the row settles to "up to date" without a full fresh fleet probe (the
  completion path rebuilds that one app's plan / clears the projection).
- All update-flow state survives a page reload and a Shell self-update.
- Review-class plans are never applied by "Update All" or the silent row button.

## Technical Design

### Plan classification

`BuildUpdateChanges` already emits a typed-by-prefix vocabulary. Classification lives next to it
on Core and rides the plan record:

- Routine: `version:*`, `manifest`, `artifact:{service}:{digest}->{digest}` (resolved target).
- Review: `runtime:*`, `role:*`, `service:*` (added/removed/changed), `setting:*`, `dependency:*`,
  `endpoint:*`, data-target changes, `capability:*`, and any `artifact:*->unknown` (applying an
  artifact nobody could resolve is not a routine act).

`requiresReview` is derived from `Changes`, which is already folded into the plan digest, so it
needs no separate integrity treatment. New field on `AppUpdatePlan` → additive for CLI (STJ
ignores unknown members); register in the Core and CLI source-gen serializer contexts (AOT).

### Fleet plan sweep

A Core service used by both the manual trigger and the scheduler:

- Targets every installed runtime/system app with a reviewed-update path (mirrors Shell's
  `appSupportsReviewedUpdate`: live-source apps are skipped).
- Builds each plan through the existing `CreateUpdatePlanAsync` path with per-app error capture —
  one broken feed marks that app "check failed" instead of failing the sweep.
- Per-sweep memoization of feeds.json and manifest fetches keyed by URL; bounded app-level
  concurrency (3–4) and parallel per-service digest probes with a small cap, so a sweep does not
  fan out unbounded docker CLI processes.
- Caching a plan overwrites the app's `reviewedUpdatePlans` slot — this is the "Check updates
  clears plan caches" semantic for free. Overwriting a plan an operator is mid-reviewing degrades
  exactly like today's popup re-open: their apply gets `update_plan_digest_mismatch` and re-reviews.
- Sweep is single-flight: a trigger while one is running joins it. The sweep runs on an
  application-lifetime token; the triggering request/tab may die freely.
- Sweep results persist as an in-memory projection per app: `{updateAvailable, requiresReview,
  planDigest, checkedAt, error}`.

### Availability projection and endpoints

- App summaries (the list Shell already renders) gain the compact projection block above, so row
  buttons render straight from the list and survive reloads for free.
- New `GET /api/apps/{id}/update/plan` returns the cached pending plan (respecting TTL) or an
  empty result — powers the instant "Review" popup. Admin session, read-only, no CSRF.
- `GET /api/apps/{id}/update-status` is reimplemented as a projection of the cached plan;
  `?refresh=true` rebuilds that single app's plan (row-level re-check). Response shape stays
  compatible (per-service digest detail comes from the plan's artifact entries).
- New sweep trigger `POST /api/apps/update-check` (admin + CSRF): starts or joins a sweep, returns
  immediately; an `updateCheck` status block (running/lastCompletedAt) on the list response drives
  the button spinner from server state.

### Background sweep scheduler

A `BackgroundService` (precedents: `AppBackupRetentionScheduler`, `NotificationRetentionScheduler`)
that runs the sweep on an interval from Core settings (`core-settings.0.1`, new key, default 1h,
explicit off value supported), with a startup delay so autostart settles first. With the scheduler
on, plans effectively never expire — each sweep replaces them — so the 1h plan TTL stays as a
backstop for scheduler-off installs.

### Background apply

`POST /api/apps/{id}/update` becomes enqueue-and-return:

- Synchronous part: resolve the confirmed plan by digest (existing `ResolveConfirmedUpdatePlan`),
  run the base-state guard, reject `update_in_progress` if the record is already `"updating"`.
  These are local and fast; mismatch errors keep their immediate-response UX.
- On accept: persist `OperationStatus = "updating"`, `LastOperation = "update"`, then run the
  existing `ApplyUpdateCoreAsync` body via the `RunBackgroundLifecycleActionAsync` wrapper on an
  application-lifetime token (the authoritative base-state guard re-runs inside, under the app
  lock, as it does today). Response returns the updated summary immediately.
- Completion: the existing success path already writes `OperationStatus = "updated"` and evicts
  the plan; add a notification ("Update applied: {app} {version}") and a single-app plan rebuild so
  the row settles without waiting for the next sweep. Failures go through
  `RecordBackgroundLifecycleFailureAsync` (`failed` + `LastError`) plus a failure notification.
- Boot sweep: on startup, any record still `"updating"` flips to `failed` with
  "interrupted by Core restart".

### Shell UX

- Row buttons from the summary projection: blue (info) "Update" split-button whose dropdown holds
  "Review" for routine plans; yellow (warning) plain "Review" for review-class; nothing when up to
  date; error state when the sweep failed for that app.
- Apply leaves the modal: both the row button and the popup's confirm enqueue and return; progress
  is the row-level `operationStatus`-driven spinner. The single `busyAction` slot is replaced by
  per-app derivation from server state; the shared detail-panel write/close in `applyUpdate` goes
  away with it.
- Enqueue errors (`update_plan_digest_mismatch` / `update_plan_expired` / `update_plan_stale` /
  `update_in_progress`): toast + refresh that app's projection (and pending plan) so the button
  corrects itself.
- Polling cadence increases while any app is `"updating"` or a sweep is running; notifications
  double as the completion toast source for reloaded pages.
- "Update All": enqueue all routine plans with Shell's own app last; if Shell was included, reuse
  the existing wait-for-own-origin + reload logic after its enqueue. Review-class apps are left
  untouched and counted in the summary toast.

## Risks

- Periodic sweeps add steady registry traffic (Docker Hub rate limits): bounded concurrency,
  per-sweep memoization, and a configurable interval keep a typical home fleet at trivial volume;
  document the interval setting.
- Silent routine applies reduce how often operators read plans; mitigated by the conservative
  classification (anything structural is review-class), the dropdown "Review" affordance, and
  notifications recording what was applied.
- The background sweep can invalidate a plan mid-review without any human action; accepted — the
  degradation path is the existing "reopen to review" error, now with a row that self-corrects.
- New plan/summary fields must land in both Core and CLI STJ source-gen contexts (AOT builds fail
  otherwise) — mechanical but easy to forget.
- In-memory sweep projection is lost on Core restart (buttons revert to "unknown" until the
  post-boot sweep repopulates them); accepted — see Resolved Questions.

## Resolved Questions

Decided 2026-07-16; no open questions remain.

- **Operator-tunable classification: no.** The classification is a security boundary, not a
  preference — `role:runtime->system` is deliberately operator-approved, and a "treat X as
  routine" knob turns that boundary into a switch that eventually ships enabled on the wrong
  install. The cost of the conservative default is one extra click. If a real need ever appears
  (an app whose shape changes constantly during development), the right home is the existing
  per-app Development Mode axis — "dev-mode app gets a softer review class" is scoped and
  meaningful — not a global setting.
- **Notification granularity: per-app, no batch notification.** Core is deliberately
  batch-unaware ("Update All" is N ordinary enqueues), so a batch summary would require threading
  a correlation id through the contract for cosmetics. Per-app notifications are the useful audit
  trail (which app, which version, which error); the batch summary is Shell's in-session toast.
  If the bell gets noisy on large batches, time-window grouping is a renderer concern (Shell is
  one renderer of notifications), not a Core contract.
- **Sweep projection persistence: no.** The projection is only truthful together with the cached
  plan it points at — its `planDigest` must match a live `reviewedUpdatePlans` entry, and those
  are in-memory. Persisting projections without plans renders buttons that lie after a restart
  (click → no pending plan); persisting full plans (with `Selection`) is heavy and stale-prone.
  Recovery is already built in: the scheduler's post-boot sweep repopulates everything within
  minutes. If the gap ever matters, tune the startup delay, not a cache file.

## Implementation Phases

### Phase 1 — Plan classification and read paths (Core)

`requiresReview` on `AppUpdatePlan` + serializer contexts; `GET /api/apps/{id}/update/plan`;
update-status reimplemented over the cached plan with `?refresh=true` single-app rebuild;
parallel per-service digest probes. Shell keeps working unchanged.

### Phase 2 — Fleet sweep (Core)

Sweep service with memoized fetches and per-app error capture; availability projection in app
summaries; `POST /api/apps/update-check` single-flight trigger + `updateCheck` status block;
background scheduler + Core settings interval key.

### Phase 3 — Background apply (Core)

Enqueue semantics with `"updating"` `OperationStatus`, `update_in_progress` guard, detached
execution, completion/failure notifications, post-apply single-app re-plan, boot sweep for
interrupted applies.

### Phase 4 — Shell UX

Plan-driven row buttons (split-button, info/warning colors), busy state from server state, popup
over the cached plan, enqueue error handling with row refresh, "Update All" with Shell-last
ordering, polling cadence.

### Phase 5 — Documentation and end-to-end verification

Feature docs update (reviewed-update flow, Core settings), CHANGELOG/versions, live verification.

## Verification

- Unit: classification table per change kind (incl. `->unknown`); sweep memoization and per-app
  error isolation; enqueue guards (`update_in_progress`, digest mismatch, base-state); boot sweep.
- Live: fleet sweep on a real install (shared feeds.json fetched once); silent routine update via
  the row button; review-class app blocked from the silent path and applied via popup; page reload
  mid-apply keeps the spinner and the apply completes; Core restart mid-apply → `failed` +
  notification; "Update All" including a Shell self-update; second browser sees identical state.

## Links

- `apps/core/src/Haas.Hosty.Core/CoreLifecycleService.cs` — `CreateUpdatePlanAsync`,
  `ApplyUpdateCoreAsync`, `ResolveConfirmedUpdatePlan`, `BuildUpdateChanges`,
  `GetUpdateStatusAsync`, `RunBackgroundLifecycleActionAsync`.
- `apps/shell/src/app/shell/pages/installed-apps-page.tsx` — current fleet check and row states.
- `apps/shell/src/app/shell-client.tsx` — `loadUpdatePlan`, `applyUpdate`, `busyAction`,
  `updateStatusInvalidations`.
- PR #206 — apply consumes the cached confirmed plan (the contract this design builds on).
- PR #183 — update-status candidate refetch for non-feed apps.
- `docs/ideas/notifications.md` — notifications are the completion transport.

## Notes

- The plan cache (`reviewedUpdatePlans`) keeps its one-slot-per-app shape; "clearing caches on
  Check updates" falls out of sweep overwrites rather than an explicit clear API.
- Apply already ignores `manifestPath`/`selectedRuntime` in the request body (plan is applied
  verbatim); the enqueue keeps `planDigest` as the only meaningful input.

# Runtime App Update

Created: 2026-06-04
Updated: 2026-09-11

## Description

Runtime app updates are reviewed changes from the currently installed `app.0.1` manifest to a new manifest or source snapshot, including a manifest resolved from the app's followed feed. Core owns the update check, plan, digest, classification, backup, apply, and failure state.

Update checking is **plan-first**: a check does not run a lighter probe than the update itself — it builds the real reviewed plan and caches it. That one resolution pass then answers everything: whether an update exists, whether it needs a human, and what an apply would do. See [Plan-First App Updates](../../planning/plan-first-app-updates.md) for the design.

## Update Flow

1. Core loads the installed app record and current manifest.
2. Core resolves the target manifest from the installed app's stored feed, explicit manifest, or source snapshot.
3. Core creates an update plan with changed version, runtime, services, images, commands, ports, environment keys, settings, endpoints, storage, dependencies, and capabilities; classifies it as routine or review-required; and caches it as the app's pending plan.
4. The caller applies the reviewed plan by passing its plan digest.
5. Core creates a `pre-update` backup when the app has a primary data directory.
6. Core applies runtime changes and records the final lifecycle state.

The browser surface runs step 4 in the background (see [Background Apply](#background-apply)); the CLI control plane applies synchronously.

## Digest Semantics

`manifestDigest` is the SHA-256 of the exact manifest JSON text loaded from a local manifest file, local app directory, `file://` URL, or HTTP(S) URL. For a locally installed `dev` runtime app, Core hashes the manifest JSON, not the app source folder or local command working directory.

If an update request does not provide a manifest reference and the app has both `FeedsUrl` and `FollowedFeedId`, Core re-fetches `feeds.json`, validates `app-feeds.0.1`, resolves the followed feed, and loads its current `manifestRef`. Otherwise Core resolves the source in this order: the stored manifest URL for remote direct installs; the original local manifest path or directory captured at install (so edits to the source folder are picked up on recheck); and finally the installed manifest copy under the app's Core state directory when that original source is no longer present.

`planDigest` is the SHA-256 of the reviewed update plan seed: app id, current and target versions, current and target runtimes, current and target manifest digests, the target manifest path, the resolved feed identity (feeds URL, feed id, and feed document digest), whether a pre-update backup will be created, and the reported changes.

## Pending Plans

Core keeps **one pending plan per app** (TTL 1 hour), written by every successful plan build — an operator opening the update view, a fleet check, or the post-apply re-plan. A new build overwrites the slot.

Apply consumes the cached plan **verbatim**; it never rebuilds. Rebuilding was never reproducible across the plan→apply gap: it re-resolved the feed and re-hit the registry, so a transient blip or a feed that moved between review and apply produced a digest that no longer matched the one the operator confirmed. What apply does check is local and cheap, under the app lock:

- the supplied `planDigest` names the pending plan (`update_plan_digest_mismatch` / `update_plan_expired` otherwise);
- the app has not moved since the plan was reviewed — version, runtime, and installed manifest digest still match the plan's base (`update_plan_stale` otherwise), which is what stops a stale plan from silently downgrading an app that a concurrent update already advanced.

All three errors mean the same thing to a client: re-review against current inputs, then apply. A successful apply evicts the plan.

## State Across Core Restarts

Core persists each app's last verdict and fully resolved pending plan together in
`core/update-checks/<app-id>.json`. Writes use an owner-only temporary file and atomic rename.
These snapshots are separate from app data and backups. They include the selected manifest and
runtime, artifact probes, resolved source commit, plan digest, original creation time, and the
verdict's checked time and target revisions. Restoring them does not contact a registry, feed, or
git server and works even when scheduled update checks are disabled.

Before serving a verdict or pending plan, Core matches its base against the current installation:
installation timestamp, version, runtime, installed manifest contents and paths, feed binding, source
identity and pin, development-mode settings, and artifact locks. Runtime state changes and ordinary
source timestamp refreshes do not invalidate it. A mismatched base or a live-source runtime drops
the snapshot; successful apply consumes it, removal and runtime/development-mode switches clear it,
and sweep pruning removes snapshots for apps that are no longer targets. A concurrent replacement
plan is identified separately so consuming an older plan cannot delete it.

The one-hour plan TTL starts at the original check and is not renewed by reading or restarting.
An expired plan is removed from the snapshot while its last-known verdict remains visible; applying
requires a fresh review. Missing, malformed, or incompatible snapshots are ignored and a later
check replaces them. Snapshot restoration never applies an update. Boot recovery clears the snapshot of an interrupted
apply so it requires fresh review.

Failed checks are persisted with their error and can retain an earlier, still-applicable reviewed
plan. A source or registry failure retains the last successful offer for the same installation.
`checkedAt` describes the latest attempt, while `lastSuccessfulCheckAt` preserves the successful
check time. A partially resolved replacement plan clears the one-click digest from the verdict
and requires review. A later successful check replaces the result and clears the error.

## Changes

The `changes` list is a human-review summary of the update plan. Core reports specific contract changes when it can classify them, such as `version`, `runtime`, `role`, `service`, `image`, `command`, `port`, `environment`, `setting`, `endpoint`, `data`, `dependency`, and `capability` changes, plus `artifact:{service}:{current}->{target}` for compiled-image digest movement. When the target manifest digest differs but none of those contract categories changed, Core reports `manifest` as a fallback meaning "manifest content changed." A recheck against the same installed manifest returns an empty `changes` list.

Core-reserved `HOSTY_PORT_*` host-port overrides are never reported as `setting:*:removed`: an update carries them forward, so reporting a removal would promise a change apply does not make — a same-version plan that could never converge.

## Classification (`requiresReview`)

Every plan carries `requiresReview`, derived from its change list. It is the gate for one-click updating: a client may apply a routine plan without showing it, but must never silently apply a review-class one.

**Routine** — the app's own build moving forward, with nothing else changing:

- `version:*` and the `manifest` fallback;
- `artifact:{service}:{current}->{target}` with a resolved target digest;
- `image:{service}:{currentRef}->{targetRef}` while both references point into the **same repository** (a tag advancing inside the app's own repository is an ordinary release).

**Review-required** — everything else, because it changes the app's shape, privileges, or where its bytes come from: `runtime`, `role` (a manifest newly declaring `role: system` escalates the app — surfacing it here is what makes the escalation operator-approved), `service` added/removed/changed, `setting`, `dependency`, `endpoint`, `data`, `capability`, an `image` change that redirects to a different repository, and `artifact:*->unknown` (applying an artifact nobody could resolve is not a routine act).

The classification is deliberately conservative and not operator-tunable: it is a security boundary, not a preference. The cost of a false review is one extra click.

`updateAvailable` is a separate question from the same list: any change except an `artifact:*->unknown` entry, which means "cannot tell", not "update available".

## Update Availability (`update-status`)

`GET /api/apps/{appId}/update-status` reports availability and per-service digest detail. It is a **projection of the app's cached plan**: with a fresh plan it does no network work at all. Without one it builds a plan (caching it) and projects that. `?refresh=true` forces a single-app rebuild — the "Check for updates" action on an expanded row.

The candidate is whatever the reviewed plan would use: the followed feed's current `manifestRef` for feed-bound apps, or a refetch of the stored manifest URL for non-feed URL installs. Refetching the external manifest matters for candidates that move to new *versioned* image tags: comparing the registry against the installed copy's old tags would report "up to date" forever. Resolution failures degrade service detail to `unknown` and set an explicit error on the summary verdict; the installed app is left untouched.

## Fleet Check

`POST /api/apps/update-check` (admin, CSRF) starts a fleet sweep, or joins the one already running, and returns immediately. The sweep runs on the application lifetime token, so the triggering request or tab may go away without stopping it. Progress is server state: `GET /api/apps` carries an `updateCheck` block (`running`, `lastCompletedAt`), so a page opened mid-sweep — or reloaded — still shows the check in progress, for every admin rather than only the one who clicked.

The sweep builds a plan for every app with a reviewed-update path (live source apps are skipped). Apps are checked concurrently; what is bounded is the registry digest probe, host-wide rather than per app, because that is the only scarce resource a check contends for — so an app with no compiled services never waits behind one with five.

Failures are captured per app: one dark feed marks that app's verdict with an `error` instead of failing the sweep. Two deadlines keep an unresponsive remote from holding the fleet's spinner, since the operations underneath carry budgets sized for their heavy cousins (`docker pull`, `git clone`):

- a single remote digest lookup gets 30 seconds, after which that service degrades to `unknown` like any other unreachable registry;
- a whole per-app check gets 90 seconds, recorded as that app's `error` verdict.

Neither is reached on a healthy host, where a check is a handful of registry round-trips.

### Resolving a Digest

A compiled service's candidate digest comes from the registry's HTTP API directly: `HEAD /v2/{repository}/manifests/{tag}`, declaring the OCI and Docker manifest media types, reading the `Docker-Content-Digest` response header. A `401` carrying a `WWW-Authenticate: Bearer` challenge is answered with an anonymous pull token from the realm it names, scoped to that repository and cached for its stated lifetime. Registries that omit the header on a `HEAD` are handled by fetching the manifest and hashing it — the digest is by definition the SHA-256 of those bytes.

`docker buildx imagetools inspect` (then `docker manifest inspect`) remains the fallback, used whenever the HTTP probe cannot answer cleanly: a registry needing real credentials, a redirect (not followed — a manifest probe must not be bounced to an unvetted host), a malformed digest, or any transport failure. This is what keeps a private registry working: the operator authenticated it with `docker login`, and Core never reads those credentials.

The reference is parsed the way docker's own parser does: a first path component is a registry only when it contains a dot or a port or is literally `localhost`, so `alex/app` is Docker Hub rather than host `alex`, and a single-component name resolves under the implicit `library/` namespace. A reference that cannot be turned into a URL unambiguously is declined rather than escaped.

The contract is the same either way: an unresolvable digest is reported as `unknown` and never fails the plan.

Each app's summary then carries the last-known verdict as `updateCheck`: `{ updateAvailable, requiresReview, planDigest, checkedAt, error, targetVersion, targetSourceCommit, targetArtifactDigests, lastSuccessfulCheckAt }` — null until a check has run for it, and suppressed for a live-source runtime so a verdict from before the app went live cannot keep offering an update the plan flow would refuse. Because caching a plan overwrites the app's pending slot, a fleet check also refreshes what a one-click apply would apply.

The last three fields name the target the verdict refers to, projected from the same plan build so a client can say *what* the update is without fetching its plan: the candidate manifest's version, the commit the source probe resolved, and the candidate image digest per service key. `targetVersion` equals the installed version whenever the update advances the build rather than the version — a source app tracking a branch, or a re-pushed image tag — which is why the revisions travel with it. Probes that did not resolve contribute nothing rather than a placeholder, so an unreachable registry is never rendered as a revision the operator would get.

Alongside them, `AppSummary.sourceCommit` reports the *installed* reviewed source pin, so the current build's revision is readable from the list without opening the app's Source tab.

A background scheduler runs the same sweep on an interval (`HOSTY_UPDATE_CHECK_INTERVAL_MINUTES`, default 60, `0` disables; first run 2 minutes after startup so autostart settles). The interval is re-read every cycle, so a change from the Core settings panel applies without a restart. Each successful scheduled check replaces the plan; delayed or failed checks do not extend its TTL.

## Background Apply

`POST /api/apps/{appId}/update` **enqueues** the apply and returns as soon as it is accepted. The synchronous part is only the local validation above plus an `update_in_progress` rejection when an apply is already running for that app; the apply itself runs detached on the application lifetime token.

This is what makes the flow reload-safe. The request-scoped cancellation token used to flow into the docker operations, so a page reload or a Shell self-update mid-apply aborted the apply half-done.

Progress and outcome live on the app record, not in a client:

- `operationStatus: "updating"` is persisted for the duration — every client renders progress from it, and it survives reloads, second browsers, and the Shell restarting itself. It is the **only** in-progress marker: a successful apply of a *running* app ends at `started` (the post-update restart), not `updated`.
- Completion flips the record (`updated`/`started`, or `failed` with `lastError`), so a reloaded page still learns the outcome. A post-apply single-app re-plan settles the app's verdict against its new base immediately instead of waiting for the next sweep.
- A record still marked `"updating"` at startup means Core stopped mid-apply: the boot sweep flips it to `failed` with an actionable "interrupted by a Core restart" error. It runs before autostart reconciliation, and skips any app whose apply is genuinely in flight.
- No update outcome is published to the notification inbox. An apply is always something the operator just asked for, and the record already carries the result onto the app row — a second copy in the bell was noise. Core purges any `app-update-applied:` / `app-update-failed:` advisories left by earlier versions on boot.

`POST /control/v1/apps/{appId}/update` stays synchronous — the CLI's confirm-and-wait shape is the right one there.

## Shell UX

After each app-record change, Shell re-reads the installed-app list through the shared Core event
stream. The same subscription resyncs after a reconnect or returning to the tab. Full-page and event
reads bypass the browser cache and share a request sequence: a late older response cannot replace
newer versions, runtime states, or update verdicts. Full refreshes still replace the app list when
the authenticated session changes. This applies to individual and bulk updates; Shell self-updates
additionally wait for their restart before reloading the page into the new assets.

Rows render from the app summary's `updateCheck` verdict, so the affordances survive navigation and reloads without re-probing:

- **routine** — a blue update icon applies the cached plan by digest with no dialog; the row's actions menu offers "Review and update" for the curious;
- **review-required** — an amber update icon opens the plan; there is no silent path;
- **check failed** — an amber icon carrying the error;
- **applying** — the current stage beneath the runtime status, matching the Core row, driven by `updateProgress` and `operationStatus`.

The update icon and the versions share the **Version** cell, because "an update exists" and "which version" are one statement. The cell stacks the installed version over the version the update resolves to, in the icon's own colour, with the icon after them. The second line names that version even when it equals the installed one: an update that keeps its version is the normal shape for a source app tracking a branch, and the row is answering "which version would I get". The commit that separates the two builds lives in the tooltip. A verdict naming no version at all — an older Core — leaves the installed version alone with the icon. The platform row follows the same rule for Core's own update.

Both version lines are tooltip triggers, marked with a dotted underline rather than an icon, and spell out the exact revisions that version identifies — the reviewed source commit, each service's image digest — in full. The installed line carries its tooltip whether or not an update exists: a version string alone cannot separate two builds of the same version, which is exactly what a source app tracking a branch ships.

The header "Check updates" triggers or joins the fleet sweep. "Update all (N)" applies every routine verdict, leaving review-class ones on their rows and counting them in the summary toast; the Shell's own app goes last, because its apply restarts the Shell serving the page.

Applying closes the dialog immediately. A rejected enqueue (stale, expired, consumed, or already updating) toasts the error and refreshes so the row corrects itself rather than resending a dead digest. The update dialog opens over the cached pending plan, rebuilding only for an explicitly supplied source or after a feed change. Progress needs no poll: every app-record commit publishes a hint on Core's event stream, and the page re-reads the list from it.

### Update stages and check feedback

App records persist `updateProgress: { stage, changedAt, service }` and publish their ordinary event
hints as the operation moves through queueing, preparation, stopping, backup, installation, runtime
start and readiness. Docker reports downloading only when it actually pulls an image; local-command
setup reports preparation. Running apps retain `operationStatus: updating` until readiness finishes.
The terminal status remains `started` for a restarted app and `updated` for an app left stopped,
maintaining compatibility with existing Shell self-update waiters. `lastOperation` remains `update`.
Update stages and outcomes appear below the status badge in the Status cell.
A healthy finish shows Updated for 30 seconds; an unhealthy finish shows Updated · not ready.
Failures and interrupted updates remain visible with their error.

Version/check tooltips distinguish never checked, no updates, and a failed attempt, and include the
last successful check time. A failed check keeps the found target visible and opens review; bulk
update skips failed verdicts. A fleet check with failures and no offers reports an incomplete check.

Core's detached updater does not expose download percentages or internal stages. Shell shows
installing, reconnecting and verifying based on live status reads. It confirms completion only when
Core is running and a fresh release-hash check reports no remaining update, then displays Updated
briefly. A five-minute deadline yields an unconfirmed result, without claiming success. Failed Core
checks retain the previous offer only for the same installed version and release channel.

## System Apps

System apps (Shell, Telemetry, Marketplace) update through this same reviewed flow, gated on `host.admin` alone. Lifecycle operations are inherent to Core managing an app and are authorized on the endpoint, never by the manifest `capabilities` list — an app cannot opt out of being updated by omitting a token (see [Core App Shell](../core-app-shell/feature.md)).

Core startup never applies updates: the boot reconcile installs missing distribution apps, re-applies Hosty-owned provisioning, and migrates a moved http(s) distribution manifest reference (pointer only — no content change, no restart). A Shell self-update briefly restarts the Shell serving the page; the apply survives the tab, so the UI warns, keeps the tab alive through the swap, and reloads into the new build — after two signals, in this order: Core's record settling the apply **and** the restart it hands off to, and then the page's own document URL answering again (the new server is listening). Settled means `"started"` after the post-update restart, `"updated"` when no restart is needed, or `"failed"` with an error. Core keeps `"updating"` throughout installation, runtime preparation and readiness. Shell also tolerates older Core versions that use an intermediate `"updated"` before starting the runtime. Both signals are needed because the enqueue returns before anything is torn down — the old Shell keeps serving its origin for the whole apply, so an origin probe on its own resolves immediately and reloads the old bundle. The record arrives on the event stream the page already holds (Core stays up across the swap), so no poll is involved; a `"failed"` record toasts the error instead of reloading, and a record that never settles — the deadline passed, the app was removed, or the page never saw the flip — leaves the operator on the working old page with a note to check the row and reload once the Shell answers. See [On-Demand System App Updates](../../ideas/system-app-updates.md) for the design and its deferred hardening (readiness gate, automatic rollback).

## Live Source Runtimes

A reviewed update does not apply to a **live source** runtime: an app whose selected runtime is a source artifact (`localCommand` in v1) running from the operator's own folder (a `source-override`, or the original folder install) with no recorded manifest URL. For these the manifest is the operator's own contract and is re-read, validated, and adopted on each start — there is no trust boundary to gate, so changes take effect on restart rather than through an update plan (see [Runtime App Marketplace](../runtime-app-marketplace/feature.md), "Live source").

Core reports this on the app summary as `live: true`. Clients mark the runtime **Live** and hide the Update affordance; it returns when the operator switches to a compiled (Docker) runtime. When no explicit manifest reference is supplied, `update-plan` for a live source app is refused with `update_live_source_runtime` instead of re-reading and validating the (possibly mid-edit) folder manifest. Passing an explicit `--manifest` path or URL remains available as an escape hatch for an out-of-band comparison. A URL/publisher install is never live source: its code may run live, but its manifest **contract** is still reviewed on change.

## CLI

```bash
hosty apps update-plan <app-id> --manifest apps/demo-app
hosty apps update <app-id> --plan-digest <digest> --manifest apps/demo-app
```

## Failure Behavior

Failed updates leave enough state for diagnosis and retry. Runtime state and app data are not deleted automatically. Restore uses normal app backup restore behavior.

## Testing Expectations

- **Plan and classification** — change detection per contract category, `requiresReview` routine/review split (including `role: system` escalation and a cross-repository `image` move), `updateAvailable` treating `->unknown` as "cannot tell", and plan-digest stability across a rebuild.
- **Apply** — digest mismatch, expiry, and stale-base rejection; verbatim consumption of the cached plan; `update_in_progress`; the interrupted-apply boot sweep.
- **Shell self-update wait** — the page stays put through `"updating"` and through the intermediate `"updated"` while the restart is still to report, settles on that restart's `"started"` (and on `"updated"` when no restart is coming), reports a `"failed"` record with its error, treats a failed read as no outcome at all, and gives up on its deadline (and when the app is gone) without reloading.
- **Fleet check** — availability projected into summaries (target version and revisions alongside the verdict, and nothing named for a probe that did not resolve), live-source apps skipped and an earlier verdict suppressed, per-app failures captured without failing the sweep, per-app timeout recorded as that app's error while the rest of the fleet still completes, shutdown not recorded as timeouts, single-flight joining, and the finish announced only once the run no longer reports running.
- **Version cell** — the target version shown whether or not it advances, and nothing shown when the verdict names no version; installed revisions read from the app record alone, so the tooltip stands without an update.
- **Digest resolution** — reference parsing (Docker Hub defaults, `library/` normalization, host detection) and rejection of references that cannot be turned into a URL unambiguously; bearer-challenge handling with token reuse and one re-challenge when a cached token stops working; the hash-the-manifest path when the digest header is absent; fallback to the docker CLI on every unclean answer (auth, redirect, malformed digest, transport failure); cancellation propagating rather than being swallowed as a fallback.

Digest resolution is covered offline against a stub transport — the suite must not depend on reaching a registry. Agreement with `docker buildx imagetools inspect` on real registries is verified out of band when the resolver changes.

- App-list refreshes — an older full-page response cannot overwrite an event-delivered update;
  an older event response cannot overwrite a newer full-page read; versions, source revisions,
  runtime state, and update verdicts move together, including multiple apps updated in one batch.

- Restart regression coverage recreates Core services over the same data directory, checks offline
  Docker and same-version local-command source updates, exact-plan apply and consumption, original
  TTL, disabled scheduled checks, changed bases, malformed snapshots, owner-only files, removal,
  retained failures, pruning, and unresolved git probes after restart.

- Update-feedback tests cover real download callbacks, continued updating through readiness, healthy
  completion, synchronous failure, retained offers after failed source/registry checks, and recovery.
- Core availability tests cover retained results and timestamps, successful recovery, and rejection
  of a retained offer after the installed version or release channel changes.
- Shell tests cover expiring success feedback, unknown/failed/empty checks, and bulk-update exclusion
  of failed, review-required, expired and already-updating offers.

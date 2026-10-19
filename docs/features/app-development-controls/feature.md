---
created: 2026-10-18
updated: 2026-10-19
summary: One recoverable dev-mode operation for ordinary installed apps, shared by Shell, Harness, CLI and direct MCP, using live source and ordinary data in the same Core.
components: [apps/core, apps/cli, apps/harness, apps/shell]
---

# Development Controls For Existing Apps

## Same Installation, Live Code

Managed dev mode switches an **ordinary installed application in its existing Core** to an installed
Docker profile marked `development: true`. It retains the installation, Core users and identity
signing domain, ordinary data, settings, permissions, dependencies and approved mounts. It creates
no child Core and imports no sandbox users or data. Only one ordinary runtime writes the data:
Core stops all services before selecting and starting the development profile.

Source is an existing Git working directory or a registered worktree. Uncommitted edits are allowed.
The Docker profile determines source mounts, caches, watchers and hot reload. Live code edits do not
require repeated runtime approval. A profile without browser HMR can require a page reload; Core
reports runtime health and restart requirements independently of browser verification.

The executable manifest must match the installed contract. Changing services, runtime commands,
permissions or mounts requires returning and reviewing/installing the new contract. Managed dev
mode does not silently adopt a changed manifest on restart. The installed recipe remains available
to stop and return even when the source manifest is broken.

System applications retain their existing manual workflow. Native/mixed profiles, non-Git folders
and managed checkouts without a registered worktree retain the existing manual Switch runtime
path. Shell explains when that path has no managed Return operation. Agents do not use it as a
fallback after a refused managed operation. Source overrides remain supported; their removal is
not part of this feature.

## Shared API And Authority

Core owns `plan`, `apply` and `status`; `enter`, `restart` and `return` are operation actions. Shell,
CLI, Harness and direct MCP call the same lifecycle service. The review includes installation,
source/HEAD, dirty-file count, runtime recipe changes, interruption, data effects and backup coverage.
The digest binds the actor and current installation/source/runtime/configuration facts. It does not
freeze future edits. A stale review requires a new plan before admission.

| Client | Entry point and authority |
| --- | --- |
| Shell/operator | Session-authenticated admin `/api/apps/{appId}/dev-mode`, POST `plan` / `apply`, CSRF and app-management authority |
| Local CLI | Authenticated local control equivalents; `hosty apps dev-status`, `dev-plan`, `dev-apply` |
| Harness | Session-bound internal API; normal administrator identity, current `apps.sources.full` and `apps.lifecycle`; registered worktree required for entry |
| Direct MCP | `get_app_dev_mode`, `plan_app_dev_mode`, `apply_app_dev_mode`; direct `mcp:lifecycle`, plus direct workspace authority and ownership when a worktree is involved |

MCP arguments use `action`; Harness tools `app_dev_status`, `app_dev_plan`, `app_dev_apply` use
`devAction` to distinguish the requested lifecycle action from the Harness transport action.
The user and installation come from authenticated authority, not caller-supplied approval flags.
Read-only/delegated credentials cannot gain mutation authority by choosing an unprompted policy.
The authenticated local control endpoint can use an already reviewed private-source connection;
its owner/connection validity is still rechecked. Browser and MCP actors retain owner checks.
Private source checks apply to entry, restart and pending-request recovery, using the persisted
manifest URL for private manifest grants. Generic Start/Restart refuse active private
trials because those calls carry no source-owner identity; the reviewed dev restart performs the
current grant checks. Ordinary Stop, logs and health use the installed recipe even when the live
manifest is damaged or changed; Stop remains available after source access is revoked. Return does not grant new source access;
restarting a prior private runtime can still fail if its required authority has been revoked.

Harness uses the existing **Ask / Run unprompted / Disabled** policy. Ask in Normal mode presents
the concrete tool request; denial or cancellation before dispatch leaves runtime state unchanged.
Run unprompted dispatches an authorized request without a second mandatory browser confirmation.
Disabled remains unavailable in Autonomous mode. Direct clients apply their own MCP confirmation
policy. Tool policy never creates missing Core permissions.

## Durable Entry, Recovery And Return

Each caller supplies a stable UUID `requestId`. Apply retains a journal before changing the app:
actor, installation, source/worktree/observed HEAD, manifest digest, prior source/runtime/artifact
selection, initial running state, configuration fingerprint, backup and action receipts. The app
points to this journal. Exact replay observes or resumes the original request. Harness clears a request superseded by
another client’s Return and explains the outcome before enabling a new operation. Changed arguments
or authority are refused; a request retired by a later trial cannot accidentally restart old work.
Terminal phase and successful receipt are persisted in one atomic journal write, so failure of the
following registry update or loss of the response cannot repeat a completed transition. Exact replay
repairs a missed terminal registry status without repeating runtime effects or overwriting later
ordinary lifecycle statuses. Internal dev starts retain their transition status until completion.
HTTP disconnect does not cancel an admitted transition. Core shutdown can interrupt it; retry uses
the same arguments and UUID. Interrupted restart and Return retain their actual phase and error.

Entry stops the app, verifies a stable managed-data backup, binds source/profile, then starts it.
A partial start remains inspectable; retry stops partial services before starting them again.
An active binding survives Core/Harness restart. A Core restart with `--keep-apps` does not stop an
active trial merely because the ordinary installation has autostart disabled. Autostart itself is
unchanged. Full shutdown and an explicitly stopped trial still require their normal lifecycle.

**Return to previous runtime** restores the recorded source/profile/artifact selection.
The original install-manifest path is preserved, including an absent path for URL/internal installs;
the journal snapshot never becomes an update source. It restarts
only an app that was running before entry. It retains current data, source edits, worktrees, caches
and backups. It performs no Git reset, commit, acceptance, push or publication. Configuration or
binding drift refuses a stale return instead of overwriting a later operator decision. Missing or
corrupt journals block mutations, including data restore, while the Dashboard identifies the
unavailable operation. Startup reports the failure per app and continues processing unrelated apps.

The worktree is a persistent ordinary-runtime consumer. Active authorized writers can continue
editing; transitions block new writers and destructive Git/cleanup operations. Manual transitions
refuse active writer leases. A preview consumer remains independent; releasing it does not release
the ordinary-runtime guard, and Return does not delete preview resources or source. This is
coordination for trusted agents, not a per-session filesystem isolation boundary.

## Data And Backups

The pre-entry backup includes managed application data. It excludes shared/external mounts,
remote databases, provider state and external side effects. Review identifies external mount paths
and access modes. Unsafe data links, unavailable backup storage or an unverifiable retained backup
prevent entry before development code starts. Replaying entry reuses the verified backup ID only
while managed data still matches the baseline saved before archive creation. Data drift across an
interrupted backup attempt refuses entry; Return followed by a new entry creates a fresh backup
without discarding the changed data.

Return never restores data. When managed data changed, Core cannot infer schema downgrade safety:
it stops and refuses an unaccepted return. `acceptDataChanges` explicitly accepts compatibility of
current data with the previous runtime. Shell and Harness explain that consequence before applying.
Restoring a backup is the separate existing authorized action and requires a stopped app; it can
lose newer data and does not reset source or erase the development journal.

## Operator Surfaces And Audit

Shell's runtime selector enters supported managed dev mode and offers Return and interrupted-request
retry even when the app has only one runtime profile. Harness adds the same actions beside the session's attached applications, with ordinary-data
wording, source, prior runtime, backup, phase, health and restart-required state. Open app uses the
normal app endpoint. Logs are bounded and require the existing `apps.logs` permission; missing
permission is displayed rather than granted implicitly. Both surfaces retain uncertain request
identities across page reload, and discard a definitively stale pre-admission review.

Core audit records apply attempts, refusals, progress and outcome with actor, installation,
worktree, source HEAD/manifest, review digest and request/operation IDs. Harness retains its normal
MCP approval/automatic-dispatch records. These are distinct from observed runtime readiness.
Journal/audit payloads contain execution references rather than copies of credentials or app data.

## Workspace Runtime Activation

[Workspace activation](../workspace-live-activation/feature.md) composes explicitly bound applications
and repository-matched Core with a reviewed selection, supervised handover and individual/group
Return. Runtime consumers persist independently of workspace Close and sandbox Finish. Core
participation requires separate Core authority; ordinary source or lifecycle access is insufficient.
Return preserves current data and live source edits.

## Testing Expectations

The [published-build acceptance](../../reviews/2026-10-18-unified-app-dev-mode-release-qa.md)
records Core/CLI 0.141.0, Harness/worker 0.58.0 and Shell 0.105.0 with real Codex, browser
live edits, Core/Harness restart, exact replay, preserved ordinary data and full fixture cleanup.

- Real Core-managed ordinary app, normal password login, real Harness agent, live source edit,
  browser write/read, prompted denial/approval, unprompted Return and preserved source/data.
- Manual Shell and direct external MCP without a chat; current authority and stale-review refusal;
  Disabled in Autonomous; no privileged fallback after a tool refusal.
- Running/stopped entry, stable backup replay, failed backup/start, interrupted restart/Return,
  original-ID recovery, retired IDs and corrupt/missing journal behavior.
- Separate explicit restore; compatibility acceptance; source/manifest drift and cleanup guards;
  independent preview consumer and writer coordination.
- Core/CLI tests, Harness policy/transport/UI tests, Shell tests, production builds, Core Native AOT,
  version consistency and documentation validation. Report native-host/profile coverage separately
  from macOS with Linux Docker containers.

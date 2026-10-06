---
created: 2026-09-18
updated: 2026-10-05
summary: A shared install dialog for Marketplace and Shell, with final authorization on a separate Core-origin confirmation page.
components: [packages/app-sdk, apps/marketplace, apps/shell, apps/core]
---

# App Installation SDK And Core Confirmation

## Installation Ownership

Marketplace and Shell mount the same `InstallDialog` from `@hosty-sdk/app/install/react`.
Marketplace supplies a feed source; Shell accepts a manifest, directory or URL. Neither uses a
Marketplace-to-Shell installation message. The dialog prepares settings and a runtime selection;
final authorization belongs to a separate Core-origin page.

The SDK provides three independent entry points:

- `/install`: typed request client and `InstallationFlow` for custom UIs, without React/Next.js.
- `/install/react`: `useInstallation` and the self-contained accessible native-dialog component.
- `/install/server`: an app-local route adapter forwarding only installation request operations,
  with separate app service and user identity credentials and same-origin mutation checks.

The server adapter accepts an explicit trusted `publicOrigin` for frameworks that expose an
internal request URL. Marketplace supplies Core's `HOSTY_PUBLIC_ORIGIN_HTTP`; forwarded-host
headers do not authorize browser requests. Without a configured public origin, the adapter also
accepts an exact Origin/Host match when the browser supplies `Sec-Fetch-Site: same-origin`.
This supports direct Core-managed local endpoints when Next reconstructs the request URL with
`localhost` but Shell opens `127.0.0.1`. Host alone, same-site metadata, opaque origins and
forwarded headers cannot authorize that fallback; configured public origins remain authoritative.

Core exposes create, submit and status operations under `/api/installations` for authenticated
operator clients, and `/api/internal/apps/{appId}/installations` for delegated app callers.
The app transport requires a currently enabled administrator and the installed app's approved
`apps.install` permission for installation, update and removal requests. An app can request review
of its own permission declarations and optional grants with `permissionsAppId` without that grant.
Shell uses app service and user identity credentials through its server, with the same permission
checks as other apps. Custom app clients use the SDK server adapter.

## Manifest Permissions

`corePermissions` is an optional array in `app.0.1`. The currently wired app-delegated operations use:

| Permission | App-delegated authority |
| --- | --- |
| `apps.skills.read` | Read agent skills published by installed apps |
| `apps.install` | Apply routine updates; prepare other installation/update/removal requests for Core confirmation |
| `apps.sources` | Session worktrees, local Git operations and session pull requests with the acting administrator's Git account |
| `providers.speech-to-text` | List and use all confirmed speech providers |
| `providers.assistant` | List and make user-attributed requests to all confirmed assistant providers |

`optionalCorePermissions` adds separately selectable offers, unchecked on install. Required and optional
sets are disjoint. Core stores both reviewed declarations plus effective grants and a revision. Optional
changes use the same confirmation page and reject stale reviews; Shell exposes the review in app settings.
Removed declarations revoke grants, unchanged accepted optional choices survive updates, and moving an
optional declaration to required needs review. See [Provider consumption](../provider-consumption/feature.md).

New installs and updates reject unknown and duplicate entries. Installed manifests retain unsupported
names for compatibility diagnostics. Core removes unsupported persisted grants at startup and on
registry writes, preserves their declarations and changes the permission revision when removing grants.
The catalogue also recognizes `apps.read`, `apps.logs`, `apps.notifications`, `apps.lifecycle`,
`apps.configure`, `core.read`, `core.update`, `core.lifecycle`, `core.configure`, `core.logs`,
`users.read` and `users.manage`; their management-API integration remains tracked in the
[local browser origins plan](../local-browser-origins/plan.md). These are distinct from lifecycle UI
`capabilities`, platform `provides` slots, and external-client OAuth/MCP scopes.

Core records the approved set as `GrantedCorePermissions` on installation and reviewed update.
Live-source projection, restart, runtime switching and manifest backfill preserve that stored
set; editing a source manifest does not grant new permissions. Update plans include additions and
removals. Routine updates requested by authorized apps use the queued apply endpoint without a
confirmation popup. The queued update path, including MCP callers, refuses additions with
`approval_required` and preserves existing grants without restoring revoked required rights.
App callers cannot use it for non-routine manifest changes; these retain Core review.
After accepting confirmation, Core applies the reviewed update in the background. Explicit local control-secret
operations remain trusted operator operations.

Live-source apps can review an explicit manifest path to approve permission changes. These plans
survive list reads and fleet checks without becoming automatic update offers. A source change
between review and apply invalidates the plan.

Confirmed `provides: ["assistant"]` roles are persisted separately as `ConfirmedRoles` and exposed
through app summaries. Install plans include `requestedRoles`, `permissionDescriptions` and
`roleDescriptions`; update plans include `currentConfirmedRoles` and `targetRoles`. Additions require
confirmation exactly like permission additions. Source projection never confirms a role.
See [assistant provider permissions](../assistant-provider-permissions/feature.md).

## Required Permissions And Runtime Lifecycle

Core checks the effective manifest before start, restart and runtime switching, and rechecks before
launching services. Unsupported required names produce `app_permissions_unsupported`; known but
ungranted requirements produce `app_permissions_required`. An unreadable contract produces
`app_permissions_unverifiable`. A last-good manifest fallback cannot bypass these checks. Optional
permissions, including unsupported names in an installed manifest, do not block execution.

The permission observer checks running apps every five seconds and stops apps with verified missing
or unsupported required permissions using the installed runtime contract. Unreadable manifests
produce stale permission observations without stopping a running app; launch still refuses them.
The observer skips apps whose lifecycle lock is busy and retries them on a later pass, so long
operations do not delay checks for the remaining apps. Boot reconciliation checks retained workloads
before autostart. Permission-blocked apps retain an explanatory error and do not enter automatic
restart loops. API authorization continues to check current grants independently of the stop sweep.
Shell shows unsupported requirements separately from missing approval; only supported requirements
can be approved. Direct Core navigation to `/install/permissions/{appId}` prepares a review without
running Shell or the target app. It requires an administrator cookie on Core's isolated origin,
then uses the ordinary nonce-protected confirmation page; visiting the URL grants no permissions.

## Trusted Confirmation

Removal uses the same request/submit/status flow with `removeAppId` and optional `removalOptions`.
Preparation freezes the installation identity and all five cleanup flags: `deleteRuntimeState`
(default true), `deleteData`, `deleteBackups`, `deleteSource` and `ignoreRuntimeErrors` (default false).
The isolated Core page shows the requester, target ID/name/version, each cleanup choice, permanent
deletion warning and advisory dependency/publication impact. Submit and decision payloads cannot
replace the target or flags. Approval revalidates the requesting app/user grants and checks the
installation identity under the target lifecycle lock immediately before removal. Missing,
reinstalled or changed targets require a new review. Audit events include the frozen cleanup choices.

App credentials cannot invoke `POST /api/apps/{appId}/remove` directly, even with `apps.install`.
Shell's removal panel opens Core confirmation and waits for successful execution before reporting
removal; denial leaves the target intact. Trusted operator sessions and the local CLI control-secret
route retain direct removal, including cleanup of retained data for an already absent application.

A request starts as `draft`. Submit freezes settings and autostart, then changes it to `pending`.
The SDK opens `/install/confirm/{id}` in a top-level window; a visible link is available when a
popup is blocked. The page displays the target, version, source, requester, provider roles and Core permissions.
Role and permission additions and removals are marked on updates. Direct host-command installs carry a warning.

Shell allows confirmation popups to escape the iframe sandbox only when Core's app summary
reports a persisted `apps.install` grant. Workspace, settings and panel surfaces
use the same policy; ordinary apps retain sandboxed popups. Missing grants remain restricted,
and a changed sandbox policy remounts the frame.

After Core accepts either decision, the response attempts to close the confirmation window.
Approved work continues on Core's application lifetime token, and the requesting app polls for
completion or failure. The final page retains a readable result for manually opened tabs that the
browser refuses to close. Its CSP permits only the fixed closing script by content hash; the review
page does not enable scripts, and closing does not reconnect the app to Core through `window.opener`.

The decision requires the requesting user's current administrator browser session, a nonce issued
only to this Core page and bound to that session, and a same-origin form submission. App tokens,
full-role bearer tokens and the ordinary CSRF token do not authorize this decision. The page
refuses framing, disables CORS and uses a restrictive CSP. App-authored strings are HTML-encoded.
An approval atomically claims exactly one execution; denial, expiration and failure cannot be
replayed. The request store is bounded to 64 entries, expires pending requests after 15 minutes,
and is cleared by a Core restart. Status responses expose neither secret settings nor decision
nonces. Approval events are recorded in the audit log.

If recording a decision fails, Core returns HTTP 503, marks the request failed and clears its
credentials without starting the operation. The error page stays open, and normal expiration
releases the failed request's store capacity.

Installations consume the cached manifest selection, including feed-selected content. Changes to
the source after review do not alter the approved installation. Legacy `/api/apps/install` and
`/api/apps/install/feed` apply routes refuse direct execution with `approval_required`.
Feed and direct-manifest plans share cache admission: expired entries are pruned and the oldest
pending plan is evicted when the 64-plan cache fills, so abandoned reviews do not block new ones.

## Browser Cookie Boundary And Migration

Cookies are scoped to a hostname, not a port. Confirmation therefore refuses to operate on a
hostname also used by any registered public app endpoint, its configured public origin or its
generated browser origin.
The Core browser session must have been issued on the exact confirmation origin; legacy sessions
need a fresh login. Core login preserves the confirmation continuation without requiring Shell.

The [local browser origin policy](../local-browser-origins/feature.md) supplies a dedicated Core
hostname by default. Browser compatibility is tracked there. Shell and Marketplace server transports
use app-scoped credentials and have no dependency on cross-origin Core cookies. Confirmation still
requires Core's own host-only browser cookie; merely moving Core to another port does not isolate it.

New trusted distribution installs record their declared permissions. Existing Marketplace/Shell
installations acquire declarations through a reviewed update, without silent ID-based grants.
The operator can approve that initial update through the browser Core-session request path or
apply it through the existing trusted CLI control plane. Changing public origins and deploying
new binaries to a running host are operational migration steps, not implicit SDK behavior.

This protects the app-token API boundary. Full operator credentials and localCommand processes
running as Core's OS account are separate trust boundaries; it is not an OS sandbox.

Permission-only reviews read the app's current local manifest in Core and freeze its digest and
installation/source/runtime identity. `submit` accepts only settings and autostart; requesting apps
cannot preselect or clear optional rights. Legacy `optionalPermissions` request fields are ignored.
Core checks only already granted rights from the reviewed plan; optional rights on a new install
start unchecked. Required/optional transitions
and removals are shown on the isolated page. See [App permission management](../app-permission-management/feature.md).

## Host Path Confirmation

`InstallationSource.hostPathChange` uses the same draft/submit/decision/status flow for source
selection, inline app mount bindings and shared-registry upserts. Each request contains exactly one
operation. Its required permission is respectively `apps.lifecycle`, `apps.configure` or
`core.configure`, not `apps.install`. Core renders the path and effects from its frozen plan and
revalidates the caller and snapshot under the mutation locks. Denial, expiry, replay and stale plans
do not apply the change. Shell tries the direct operation once and opens review only for a structured
confirmation-required error. Every app source-override POST returns that error, including worktrees;
protected paths are rejected during review preparation and never produce an approvable plan. Blocked popups retain an explicit link,
and completion is reported only after Core returns `succeeded`.

## Testing Expectations

- Test real HTTP decisions, separate app/user credentials, rejected cross-origin decisions,
  framing headers, nonce secrecy, ownership, expiration and single-use behavior.
- Test frozen manifest execution and persisted grants, including source changes during approval.
- Test direct app-removal denial with destructive flags; frozen cleanup options, Core-only decisions,
  denial/replay, missing or reinstalled targets, revoked grants, and trusted operator cleanup.
- Test Shell removal waits for completion, handles denial/errors and recovers a lost submit without
  repeating the mutation.
- Test cache recovery after abandoned reviews and decision audit failures without stuck execution.
- Test that only persisted installation grants enable unsandboxed popups across Shell surfaces.
- Test permission additions on updates and that source adoption cannot silently grant rights.
- Test required-permission launch refusal, running-app stop, unsupported-name cleanup and direct
  Core recovery, including a blocked Shell and optional-only revocation.
- Test client races, duplicate submits, lost responses, API errors and the server adapter boundary.
- Build and test Core, SDK, Shell and Marketplace; check package exports and artifact versions.
- Complete the remaining managed-runtime/browser verification in [plan.md](plan.md), including
  standalone Marketplace, embedding without an installation responder, and cookie-host isolation.

- Verify source/mount approval, protected paths and symlinks, stale snapshots and caller revocation;
  require confirmation for app-selected workspaces and preserve operator authority and intentional Docker source mounts.

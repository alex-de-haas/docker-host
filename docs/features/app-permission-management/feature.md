---
created: 2026-09-30
updated: 2026-10-07
summary: The Permissions tab where administrators review an app's declared, accepted and effective Core permissions.
components: [apps/shell, apps/core]
---

# App Permission Management

Administrators manage an installed app's permission declarations and optional choices from the
Permissions tab in its existing settings panel. The tab remains accessible for empty and legacy
installations. It distinguishes effective access from accepted declarations and the currently
observed manifest, with descriptions, technical identifiers, additions, removals and transitions.
The settings panel displays required and optional access read-only in separate compact groups.
Each row shows a short label and an icon with a text status. Expanding the row reveals Core's full
description and technical identifier; manifest additions, removals and transitions remain visible
without expansion. Rows use native keyboard-accessible disclosure controls and theme colors. Its **Change permissions**
button opens Core's isolated page for every app, including Shell itself. Required access is not an
optional toggle. Core checks only rights already granted to this application; new optional rights
default off. The user can select or revoke optional rights only on that Core page.

## Observation

Core observes installed apps sequentially every five seconds. It tries each app's lifecycle lock
without waiting and skips busy apps until a later pass. Running-app checks read the current manifest
without the parser cache; other observations use its file-stamp cache. Dashboard reads cached structured `permissionState` rather than parsing manifests
for each list request. A source/installation/permission identity mismatch suppresses old observations.
`GET /api/apps/{id}/permissions` requires an administrator and explicitly refreshes observation.
Changed observations publish `app.changed` events.

Development profiles use the effective local override, materialized source checkout or original
local install source. Locked profiles use the installed manifest; remote newer releases remain an
update-review concern. Missing or invalid sources retain grants and last verified information and
report unknown/stale state. Reads never adopt manifest fields or change grants.

Missing required access produces the actionable red "Required permissions need approval" problem,
which opens Permissions and contributes to Dashboard's attention count. Unsupported required names
produce a separate compatibility error, with no approval action. Missing or unsupported required
permissions never block start, restart, autostart, runtime switching, or retained workloads.
The observer reports permission state without stopping applications. An unreadable manifest marks
running-app state as `stale`, retaining verified declarations and the read error.
A later successful observation clears that error. Privileged API calls still require current grants.
Disabled or unsupported optional permissions do not block execution. Declaration-only changes do
not produce a red problem. Unconfirmed provider roles
are listed separately and require the existing app update review.

## Confirmation

The existing installation transport accepts `permissionsAppId`. A delegated app can target only
itself. For another app, Shell opens the Core-owned `/install/permissions/{appId}` page.
The direct Core operator interface can target any installed app. Core loads the candidate and
binds its review to installation time, permission revision, source/runtime identity and manifest digest.
Preparation and application bypass the parser cache when verifying the complete digest.

The submit request carries settings and autostart, without permission selections. Legacy or hostile
`optionalPermissions` JSON fields are ignored. Checkbox defaults come exclusively from Core's
persisted grants in the reviewed plan, including a previously granted required right that becomes
optional. The isolated Core page displays required permissions, optional choices, transitions and removals. Only its authenticated
administrator decision with a session-bound single-use nonce authorizes changes. Apply rechecks the
candidate under the app operation lock and rejects stale reviews.

Accepted required/optional declarations, effective grants and a new permission revision are persisted
together. No install, build, restart, unrelated manifest adoption or provider-role approval occurs.
Existing provider token/introspection and queued-update revision checks enforce revocation and stale
update rejection. Legacy null declarations use effective grants as their baseline; observation alone
never grants or revokes access. Startup cleanup and registry writes remove unsupported grants,
retain declarations for diagnostics and invalidate old permission reviews by changing the revision.

Shell refreshes permission state and app summaries when focus returns from Core and offers an
explicit Refresh button. It holds no editable permission draft and submits no choices. Closing the
confirmation window alone is not success; Core reports the decision and applies confirmed changes.
Updated grants drive the existing embedded-app iframe policy. Harness uses Core's
`reviewAvailable` capability for accurate dictation guidance, including legacy installations.

Core exposes `/install/permissions/{appId}` as an administrator recovery entry point. It works
without the target app or Shell running and forwards to the normal Core-only confirmation page.
An app with unsupported required declarations must be updated to a compatible manifest first.

## Verified Acceptance

The 2026-10-02 optional-default correction passes 35 Core tests with `dotnet test
apps/core/tests/Haas.Hosty.Core.Tests/Haas.Hosty.Core.Tests.csproj --artifacts-path
/tmp/hosty-removal-build --no-restore --filter 'FullyQualifiedName~Optional|FullyQualifiedName~InstallationApproval'
--verbosity quiet`. This includes app-token HTTP attempts to preselect optional rights through
both request transports, install/update/review defaults, preserved grants and Core-form grant/revoke.
`npm run test --workspace @hosty-sdk/app` passes 143 tests; Shell's corresponding workspace test
passes 177 Node and 71 component tests; Marketplace passes 104 tests. Core and SDK builds pass;
Shell and Marketplace production builds pass from isolated copies under `/tmp/hosty-removal-web`.
The Shell component tests cover read-only grants, Core navigation for itself and other apps,
blocked-popup fallback and focus refresh. No live browser deployment or Core restart is part of
this correction. Existing feature versions remain Platform 0.117.0, Shell 0.92.0 and SDK 0.19.0.

On 2026-10-02, seven observer regressions cover missing/invalid live manifests with and without a
prior observation, recovery, strict start/restart refusal, and a busy real lifecycle operation.
Before the correction, five failed and the two launch-refusal cases passed; after it, all pass.
The related suite passed 84 tests with:

```sh
dotnet test apps/core/tests/Haas.Hosty.Core.Tests/Haas.Hosty.Core.Tests.csproj \
  --artifacts-path /tmp/hosty-removal-build --no-build --no-restore \
  --filter 'FullyQualifiedName~Permission|FullyQualifiedName~StartAutostartAppsAsync|FullyQualifiedName~ApplyRuntimeSwitch' \
  --verbosity quiet
dotnet build apps/core/src/Haas.Hosty.Core/Haas.Hosty.Core.csproj \
  --artifacts-path /tmp/hosty-removal-build --no-restore --verbosity quiet
```

The final Core build succeeds. Documentation-index, version-consistency and whitespace checks pass.
This verification uses isolated stores and fake runtime adapters; no live workloads were restarted
or stopped. The existing platform feature bump remains 0.117.0.

On 2026-09-30, the owner confirmed the remaining real-installation checks: cancelling the Core
review preserves effective access, and revoking/restoring Harness speech permission updates the
interface without a page reload. This completes the permission-management acceptance plan.

Earlier Core-managed browser checks verified live/legacy manifest drift, isolated confirmation,
Dashboard warning removal and iframe microphone policy refresh without restarting Harness.
Automated coverage includes 2,233 passing Core tests (four environment-gated integrations skipped),
a final 46-test permission/installation/provider run, 177 Shell node tests, 40 Shell component tests
and 132 App SDK tests. The combined Harness changes pass 452 tests. Affected builds and lint pass;
Shell retains two pre-existing navigation warnings.

## Mixed operations

Personal account and Git identity management requires `sources.connections`; `apps.sources` permits
only selection/use and source operations. Shell declares connection management as optional, so a
manifest edit cannot silently grant it or make public management unavailable.

Private-source installation/update requests require `apps.install` plus either `apps.sources` or
`sources.connections`, including
retaining or removing existing private bindings. Current connection ownership and Core confirmation
still apply. Cached plans cannot bypass these checks; submission and execution recheck both grants.
Core's host-wide telemetry scrape requires `apps.read` and `core.read` even for system apps.

## Shared setup notice

The SDK provides `readOwnPermissionNotice` on the server, `permissionNotice` and
`requestPermissionReview` for framework-neutral clients, and `MissingPermissionsNotice`
for React. Shell, Harness, Marketplace and Telemetry UI expose an authenticated own-state
endpoint and use the shared component. The app service credential stays server-side.
Only administrators see actionable notices. Missing known required names open Core review;
unsupported required names explain that the app or Core needs updating without an approval
button. Optional-only declarations never trigger a notice. Dismissal lasts until reload.

Standalone review opens directly from a click. Embedded apps ask Shell with
`hosty:request-permission-review`; Shell checks the sending window and origin and derives
the app id from its mounted frame. Claimed ids and URLs in the payload are ignored. Shell
keeps a clickable fallback if the browser blocks the popup. Focus and pending polling refresh
state after review. Denial leaves the installed app running with the same grants.

## Launch authority

Core permissions are never minted from required or optional declarations at launch.
Local and Docker runtime environment builders inject an app service token identifying the
app; that token is not a permission grant. Core's management/provider/skills APIs
read persisted grants on each call. App identity authenticates the user and app separately.
Runtime mounts come from approved stored bindings and the mount path policy, not from
`corePermissions`; declaring `apps.configure` adds no mount. Provider provisioning uses
confirmed capabilities. Shell's iframe sandbox and microphone policy use persisted grants,
not manifest declarations. Local-command runtime and explicitly approved host mounts retain
their existing host access; Core permission names are not an OS sandbox.

## Testing Expectations

- Observe live edits without restart; retain installed-release behavior and recover from invalid sources.
- Keep running apps alive through missing/invalid manifests, including the first observation;
  expose stale/error state and recover without restart. Launch still rejects unreadable contracts.
- Hold a real lifecycle operation open and verify an observation pass skips it, checks other apps,
  and resumes checking the skipped app after its lock is released.
- Cover legacy declarations, additions, removals, required/optional transitions and optional revocation.
- Reject stale installation, source, runtime, revision and full manifest changes, including unchanged
  file stamps; reject replay, foreign callers and non-administrator browser access.
- Assert permission-only application preserves unrelated app state. Start apps with missing or
  unsupported requirements, retain them after revocation, and deny privileged calls with
  `app_permission_required` until explicit approval; never infer grants from declarations.
- Test cleanup idempotence, preserved declarations, stale reviews and Core-only recovery without Shell.
- Verify Dashboard severity/action/count semantics and read-only Shell grants, empty/unavailable
  states, Core navigation for Shell and other apps, blocked-popup fallback and return-focus refresh.
- Reject caller-selected defaults across installation, update and permission review; existing
  grants remain checked, new rights start unchecked, and only the Core form can grant/revoke them.
- Exercise Core-managed browser navigation, isolated confirmation, iframe policy changes and narrow
  layouts; do not infer runtime acceptance from a successful build alone.

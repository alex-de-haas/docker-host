# App Permission Management

Status: In Progress
Created: 2026-09-30
Updated: 2026-09-30

## Goal

Give administrators a discoverable, per-app permission editor and make unapproved required
permissions visible on Dashboard, including changes in live development manifests. Accept permission
declarations and optional choices through Core confirmation without reinstalling the app or applying
unrelated manifest changes.

Owner direction, 2026-09-30: prefer a Permissions tab in each app's existing settings panel; show
already approved permissions, enable or disable optional permissions, and approve newly required
permissions. Dashboard must surface missing required consent and provide a direct route to resolve it.
The owner approved this plan and authorized implementation in chat on 2026-09-30.

## Current Behavior And Ownership

- [Provider consumption](../provider-consumption/feature.md) defines required/optional declarations,
  effective grants, revision checks and revocation. Its remaining hardware acceptance stays in
  [that feature's plan](../provider-consumption/plan.md).
- [App installation SDK](../app-installation-sdk/feature.md) owns isolated Core confirmation.
  Its [remaining verification](../app-installation-sdk/plan.md) is separate from this feature.
- Shell's `AppPermissions` is embedded in App settings. It can review stored optional permissions
  through `permissionsAppId`, but it hides itself when stored declarations are absent. Required
  declaration changes currently require an application update review.
- Core's live source adoption reads ordinary manifest fields while retaining stored permission
  declarations and grants. An app can therefore run new code while its optional rights remain
  undiscoverable in settings. The local Harness installation exhibited this with speech-to-text.
- [Shell navigation](../shell-navigation/feature.md) owns the settings panel and Dashboard layout.
  This feature owns the new permission state, permission-only review and its UI, without duplicating
  the existing confirmation transport or provider authorization work.

## Proposed Behavior

### Per-App Permissions Tab

Add an administrator-only Permissions tab to the existing app settings panel. Keep it visible even
when the accepted permission declarations are empty, so legacy installations and new declarations
have a discoverable place to be inspected. Show an explicit empty or unavailable state.

Show a plain-language description and the exact permission identifier for each row, distinguishing:

| Declaration | Effective access | Presentation |
| --- | --- | --- |
| Required | Granted | Required, allowed; not an optional toggle |
| Required | Not granted | Required, approval needed; red |
| Optional | Granted | Optional, enabled; can be disabled |
| Optional | Not granted | Optional, disabled; can be enabled |
| Newly observed declaration | Not yet accepted | New in manifest; required/optional shown separately |
| Previously accepted declaration removed from the candidate | Still granted or accepted | Removal pending review |

Distinguish declarations accepted by Core from the currently observed valid manifest and effective
grants. Do not label a new required declaration as already approved merely because an earlier
optional grant covered the same permission; a required/optional transition still needs review.
Show declaration changes even when the effective access itself does not grow.

Optional toggles stage a draft. A clear Review changes action opens the existing isolated Core
confirmation page with the exact additions, removals, required/optional transitions and selected
optional choices. Only Core confirmation changes effective access. Preserve unchanged choices;
new optional permissions default to off. Required permissions are accepted together as requirements
of the reviewed declaration set; cancelling leaves the existing state and any missing-consent warning.

After success, refresh the permission rows, Dashboard summary and affected embedded app state.
Show waiting, applying, denied and failed states; a closed confirmation window alone is not success.
Existing microphone guidance should point to this tab using the capabilities actually available.

### Dashboard And Manifest Observation

Core computes permission drift and exposes it as structured app summary state. Shell uses this
shared state for the row, attention filter/count and settings panel rather than independently
comparing incomplete client-side fields.

- For a live source app, compare the current validated source manifest with accepted declarations
  and effective grants. Detect edits while the process is running, without requiring a reinstall
  or restart just to learn about a new permission. Use bounded, cached observation keyed to the
  effective source/runtime and manifest revision; do not parse every manifest for every list read.
  Recheck on settings open/refresh and lifecycle changes, and propagate changes through app events.
- Missing required grants produce a red, actionable problem: "Required permissions need approval".
  Explain that operations requiring those rights are blocked. Do not claim the process has stopped
  or all functionality has failed; runtime and health indicators remain factual. This feature does
  not automatically stop/restart the app or change its existing startup policy.
- Clicking the permission problem opens that app's Permissions tab. It remains reachable by opening
  Settings normally, including when other app problems are present.
- Optional permissions deliberately left off are not errors and do not inflate the attention count.
  Newly discovered optional declarations get a neutral "New optional permissions" indication in
  the tab, not a red Dashboard problem. Declaration changes requiring review without missing
  required access use a neutral review indication rather than claiming broken functionality.
- An invalid/unreadable source manifest produces a distinct observation error; retain established
  grants and last verified information, mark it stale, and do not invent a missing-permission diff.
- For pinned/release installs, use the installed manifest. A newer remote release requesting more
  permissions is an update-review concern and does not make the current installation unhealthy.

### Permission-Only Core Confirmation

Extend the existing permission-review path to review a complete candidate permission declaration
set for the target installation, rather than only toggling its already accepted optional entries.
Read and validate the candidate in Core using the app's effective source and runtime. A browser or
delegated app must not supply an arbitrary list of rights as the authoritative declaration source.

Bind review to the target installation identity, current permission revision, source/runtime identity
and candidate manifest digest. On approval, revalidate those inputs and reject drift or replacement
with an actionable request to review again. Persist accepted required/optional declarations, selected
grants and a new revision atomically, and audit the decision. Preserve the existing isolated Core
origin, administrator session, decision nonce, single-use and caller ownership checks.

Keep app-delegated review limited to the requesting app; it cannot change another app's permissions.
The administrator's Shell transport can review any installed app. Apply the existing revocation,
provider credential invalidation and queued-update invalidation behavior to these changes.

This operation changes only permission state. It must not reinstall, rebuild, restart, change runtime,
adopt unrelated settings/endpoints or silently approve provider roles. Provider-role additions remain
in the existing role/update review flow and should be identified separately if present. Legacy records
with null declarations retain their effective grants; reading a manifest never silently grants or
revokes access. Explicit review establishes their accepted declaration baseline.

## Placement Decision

Use the per-app tab for this increment. It makes the target unambiguous, fits the existing settings
surface and gives Dashboard warnings a direct destination. Its tradeoff is that an administrator
must inspect applications individually. A global permissions screen offers fleet-wide comparison
but adds navigation and duplicates editing surfaces; it is outside this increment and is not a
prerequisite for permission management.

## Deliverables

- [x] Define Core permission-observation and review contracts, including known/unknown/stale states,
      legacy records, required/optional transitions and the source used for each runtime.
- [x] Implement bounded live-manifest observation and structured Dashboard permission state, with
      explicit refresh and event propagation; preserve installed-release behavior.
- [x] Extend Core permission-only review/confirmation to accept current declarations and optional
      choices atomically, with stale-source/revision protection, audit and existing invalidations.
- [x] Add the administrator Permissions tab, human-readable rows, optional drafts and confirmation
      progress/results; keep empty/legacy installations reachable.
- [x] Add the actionable Dashboard required-permission problem and integrate its count/filter;
      preserve factual runtime/health status and normal disabled optional choices.
- [x] Align shared SDK contracts and Harness permission guidance with the new review capability;
      update only the packages/components actually affected.
- [ ] Complete automated and Core-managed browser verification below, including confirmation
      completion and UI refresh without a page reload.
- [x] Update affected feature documents, create this feature's reality document, apply per-artifact
      versions and regenerate the documentation index.
- [ ] After the remaining browser acceptance passes, remove this plan and regenerate the index.

## Phases

Implement all deliverables on one feature branch and one PR: Core state/confirmation first, Shell
and consumer integration second, then acceptance and documentation. No per-phase releases.

## Verification

- Core: newly required rights, new optional declarations, optional toggles, required/optional
  transitions, removals, no-permission manifests, legacy null declarations and denied confirmation.
- Core: current source edits without restart, invalid manifest recovery, changed source/runtime,
  reinstall identity, concurrent reviews, changed permissions after preparing an update, and no
  unauthorized grants on reads/start/restart/source adoption.
- Core: enforce administrator/caller boundaries; reject forged/stale/replayed decisions. Assert a
  permission-only apply does not invoke install/update/start/stop or adopt unrelated manifest fields.
- Shell: correct warning severity and attention counts, direct navigation to Permissions, keyboard
  access, narrow layouts, explicit empty/unavailable states and optional draft preservation on errors.
- Core-managed browser: exercise a live app whose manifest gains required and optional permissions;
  verify visible drift before restart, Core confirmation, updated rights and warning removal without
  reinstall or page reload. Repeat with legacy declarations and cancellation. Verify revocation
  removes subsequent provider access and updates iframe policy without losing unrelated UI state.
- Build/test affected Core, Shell, SDK and Harness targets. Follow the Core development feedback
  loop only if deploying Core changes; record exact runtime/source and process identity.
- Run `node scripts/check-versions.mjs`, `node scripts/docs-index.mjs --check` and `git diff --check`.

## Approval And Version Outcome

Approved by the owner in chat on 2026-09-30, including a red permission problem alongside a
still-running process, neutral optional changes, and permission-only confirmation without automatic
process restart.

Implementation versions: platform 0.115.1 → 0.116.0, Shell 0.90.0 → 0.91.0,
SDK 0.17.0 → 0.18.0, and Harness 0.38.0 → 0.39.0. The Harness release also contains
compact composer actions, inline app mentions, context icons in the chat header and history,
and dictation-guidance fixes. See [Assistant app context](../assistant-app-context/feature.md)
and [Chat UI](../ai-gateway-chat-ui/feature.md).

## Implementation Verification — 2026-09-30

- Full Core suite: 2,233 passed, four environment-gated integrations skipped. Final focused
  permission/installation/provider suite: 46 passed, including provider-token revocation through
  the permission-only apply path and stale runtime/source/manifest/revision checks.
- Shell: 177 node tests and 40 component tests passed; SDK: 132 passed; Harness: 452 passed (including the final header/history and mention changes).
- Core and CLI builds, SDK build, Shell/Harness Webpack builds and lint passed. Shell lint retains
  two pre-existing navigation warnings; Core retains unrelated compiler/platform warnings.
- Version checks, documentation index and whitespace checks pass. Versions: platform 0.116.0,
  Shell 0.91.0, SDK 0.18.0, Harness 0.39.0.
- Core-managed browser: Harness legacy declarations expose the new required publication permission
  and optional speech permission while its process remains running. The Dashboard warning opens
  Permissions using the keyboard. Core confirmation succeeded; rows, attention count and iframe
  microphone policy updated without a page reload or Harness restart. The microphone is enabled.
- Permissions fits a 760×900 viewport without horizontal overflow. The normal viewport is restored.
- Local runtime: `/Users/haas/.hosty`, source project
  `/Users/haas/Sources/haas/docker-host/apps/core/src/Haas.Hosty.Core/Haas.Hosty.Core.csproj`,
  dev PID 96737, started 2026-09-30T08:24:30.975567Z. Two detached launches did not remain alive;
  the verified source Core runs in a retained foreground CLI session. Running app trees were adopted.
- Remaining browser acceptance is tracked by the unchecked verification deliverable: cancellation
  and temporary speech revocation/restoration on the real Harness installation. The permission
  changes require action-time browser confirmation; automated rejection, cancellation, revocation
  and credential invalidation coverage already passes. Final plan removal awaits that acceptance.

## Pull Request Readiness

The implementation is submitted as a draft while the two remaining deliverables above are open.
Automated checks are complete; the remaining real-installation cancellation and speech
revocation/restoration acceptance requires action-time browser approval. Do not mark this plan
complete or make the PR ready based only on the automated coverage.

Assistant UI acceptance also verified image loading in the picker/header/history, navigation from
the shared plus menu, and a 360-pixel layout without horizontal overflow. Existing context is
preserved when a mention is removed. Harness lint and the Webpack static build pass.

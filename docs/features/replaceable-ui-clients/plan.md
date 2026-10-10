---
status: Draft
created: 2026-07-17
updated: 2026-10-10
summary: Proposed replaceable browser UIs using confirmed roles and shared defaults, preserving app authorization and Core-owned recovery when the selected UI is unavailable.
components: [apps/core, apps/cli, apps/shell]
---

# Replaceable UI Clients — The `ui-client` Role And Primary Selection

## Goal And Approval Boundary

Make Shell one of several ordinary, independently installed browser UI clients. Core resolves a
context-free destination through a confirmed role and a host preference, while each UI remains
usable directly. Bootstrap, Marketplace and direct manifests continue to create ordinary app records.
Removing the last UI remains allowed and does not remove Core, login or CLI recovery.

The owner requested coordination with [Default applications](../default-applications/plan.md) on
2026-10-10. This revision replaces the older draft proposals for `primaryUiAppId`, earliest-installed
fallback and browser CORS. The recommendations are not approved implementation decisions; this
plan remains Draft and owns its own deliverables. The later owner direction on the same day assigns
shared panels to the [SDK panel system](../sdk-panel-system/plan.md), with Plans → assistant in Shell
and standalone as its first scenario. This plan consumes that contract rather than owning it.

## Verified Baseline And Corrections

Inspected on 2026-10-10:

- [ShellPublicOriginResolver](../../../apps/core/src/Haas.Hosty.Core/ShellPublicOriginResolver.cs)
  still looks up `hosty.shell`. It prefers the public `web` endpoint and resolves its browser origin
  using the shared local/public-origin policy. A missing Shell is already a supported Core state.
- [Core app-open links](../../../apps/core/src/Haas.Hosty.Core/ControlIdentityEndpoints.cs) use
  `/workspace?app=<id>&path=%2F`. The old draft's `/apps/{id}` is not the Shell workspace route.
- `ShellCorsPolicyProvider` no longer exists. Shell management calls use its backend with app service
  identity and the current user grant, checked by
  [AppManagementAuthorization](../../../apps/core/src/Haas.Hosty.Core/AppManagementAuthorization.cs).
  Introducing a UI role must not restore browser access to Core's primary session or broad CORS.
- [PlatformCapabilities](../../../apps/core/src/Haas.Hosty.Core/PlatformCapabilities.cs) separates
  role declarations from confirmed roles. Assistant/speech provider authority is already reviewed;
  unknown `provides` strings are inert, not automatic grants or UI eligibility.
- [Assignments](../shell-access-and-system-apps/feature.md) apply to system and ordinary apps.
  A host default does not mean every user may enter it.
- Bootstrap choice controls future installation, not current eligibility. Disabling bootstrap does
  not remove a still-installed UI. Uninstall pins that choice off and must not be undone on restart.

## Recommended UI Contract

Add `ui-client` as a reviewed role in `provides`, represented in Core's confirmed roles. The role
means the app can be offered as the host's browser UI; it grants no Core permission. Management
features still need declared/reviewed permissions, and endpoints still check the acting user.
Installation/update review explains the role without selecting it as the default.

For the first contract:

- Serve `/` as the landing page and `/workspace?app=<encoded-app-id>&path=<encoded-relative-path>`
  as the app-opening adapter. This is a small compatibility route an alternative shell can translate
  into its own internal navigation. Do not add URL templates or require it to copy Shell's page tree.
- Choose the public HTTP(S) endpoint named `web`, otherwise a sole public HTTP(S) endpoint. Missing
  or ambiguous endpoints make the app ineligible, with a visible reason. Do not select a TCP
  endpoint or rely on manifest array order. Resolve the address through `LocalBrowserOrigins`.
- Honor app access and the current SDK embedder contract. Embedded apps own their Core sign-in and
  renewal; the UI never receives their grants or Core's primary credential as an embedding shortcut.
- Support the shared SDK panel-host protocol for app requests, with one composition owner for the
  window, including the UI client's own pages. Reuse the SDK host or implement its conformance
  contract in another framework. Exact layout/navigation may differ; a finalized handoff must open
  at its owning app/session without a new provider selection. Unsupported older clients have the
  SDK's explicit compatibility fallback, not a promise of complete new-contract conformance.
  Protocol v1 uses Core-verified host/child bindings for the same actor and directly mounted frames.
  Host discovery requires `apps.panels.read` or existing `apps.read`, independently of this role;
  consume the SDK's stable panel IDs and public API without defining another identity or bridge.
- Treat target IDs/paths as navigation, not authority. Validate/encode the relative app path; reject
  external, protocol-relative and ambiguous paths and check access to the target app separately.
- A UI-client declaration does not prove route implementation or live readiness. Role-specific
  eligibility belongs in the capability/resolution service, with review diagnostics and contract
  tests. Keep generic `provides` shape validation forward-compatible; do not probe app routes during
  installation or make declarations lifecycle immunity.

Domain apps such as Telemetry, Workspaces and Plans do not acquire this role simply by serving UI
or using the SDK to host panels when standalone. A local panel host is a composition capability;
`ui-client` is eligibility to be offered as a complete browser UI. Neither confers embedding
authority under the separately held [embedding restrictions](../app-embedding-restrictions/plan.md).
No new manifest schema version is needed for the additive role; older Core treats it as inert and
cannot offer replacement-UI selection.

## Host Selection And Recovery

Use the `ui-client` category of the shared default-applications store and API. Do not add another
`primaryUiAppId` field to Core settings. The preference is host-wide; this release has no personal
UI override. Other UI clients can be opened directly or chosen once without changing that setting.

1. A valid explicit navigation/return target stays bound to its app; it takes precedence over the
   host default. Changing the default never sends a pending login or deep link to a different app.
2. An explicit host UI reference chooses that installation, subject to current role/contract checks.
3. With `automatic`, a sole eligible installed UI is selected. Zero produces `no_ui`; several
   produce `choice_required`. Installation time and temporary readiness never break the tie.

Separate selection from readiness. Keep a stopped/updating/unhealthy UI selected and display its
state; do not redirect to a dead origin or silently substitute another UI. A removed, revoked,
incompatible or reinstalled explicit choice remains invalid until an administrator clears/reselects
it. Resuming the same installation restores availability without changing the setting.

Core supplies a small recovery/choice page when it cannot navigate: status, retry, an explicit
**Open another interface** action and CLI recovery instructions. Candidate enumeration and detailed
diagnostics require authentication; show only UIs accessible to the current user. An unassigned
default produces a generic access/unavailable message for that user, with allowed alternatives,
without changing the host default or granting an assignment. A one-time alternative does not become
the default unless an authorized administrator explicitly saves it through shared settings/control.

Login/setup/recovery remain Core-owned. Without a usable UI, successful login leaves the operator
on the Core page rather than returning a broken redirect. Before login, show only generic host/UI
availability, never a fleet inventory. Do not automatically start apps from this page. An
administrator can repair the selection through the local control plane even with every UI stopped
or removed; installation/removal continues through existing reviewed operations.

## Navigation And Status Integration

All context-free Core navigation uses the same structured resolver: login with no explicit return,
setup/invitation/recovery completion, control-plane `apps open --mode shell`, status and MCP directory
links to settings. Audit every current `ShellPublicOriginResolver` caller; origin substitution alone
is insufficient for callers that append first-party Shell-only paths.

Only `/` and the workspace adapter are required navigation routes in the new UI contract. Existing Shell-specific
management links must remain bound to an explicitly identified Shell installation, or degrade to
the selected UI's landing page without claiming the same deep destination exists. In particular,
an Agents settings link must not append Shell's `/settings` layout to an arbitrary UI.

Preserve the existing validated Core-relative login continuations for OAuth, app open and trusted
confirmation. For new UI return links, freeze the destination installation and validated relative
route in an expiring, opaque Core continuation; redeem it using the current actor/access and registry
origin. No caller-supplied absolute URL is authority. The reference carries no credential and cannot
mint an app grant. A removed/reinstalled destination produces recovery, not a new default lookup.
Legacy unqualified Shell-relative `returnTo` paths stay bound to the legacy Shell compatibility
installation; if it is absent, show recovery instead of interpreting the path in another UI.

For shell-mode CLI app-open links, return a Core-owned navigation link that resolves at browser
open under the browser's actor. It freezes the chosen UI and target before any login round trip;
this avoids baking an unauthenticated actor-independent destination into an authorized redirect.
Direct standalone app-open links retain their existing semantics.

The selected primary UI handles context-free navigation, not panel placement inside an already
open app. Standalone Plans hosts its assistant locally through the SDK even if another UI is the
host default. An embedded app delegates presentation to its current verified host, not whichever
UI became primary later. Changing the primary does not move panels, retarget sessions or reload
open standalone windows.

Preserve the legacy UI-origin status field's URL meaning for older clients, and add structured
selected UI identity, role/contract validity and availability to status. Do not use a non-null origin
as proof of readiness. Invalidate selection metadata after preference, role, installation or origin
changes; always recheck access/readiness before navigation. Clients with no support for the new
category cannot manage it and receive an explicit unsupported result.

## Settings, Removal And Authorization

Contribute one **Browser interface** row to **Settings → Default applications → This host**,
using the shared API, revision and `core.configure`/administrator checks. Show it with zero or one
candidate too. Keep unavailable selected entries and their reason visible; there is no duplicate
Primary UI control under Core settings. Personal assistant controls remain owned by the other plan.

Keep every installed UI's ordinary lifecycle available. Removal review warns when removing the
selected UI and separately when removing the last eligible UI, explaining Core/CLI recovery. The
reviewed removal remains allowed; no automatic promotion, reinstall or grant transfer follows.

No CORS expansion is part of this feature. Two UIs coexist through the same app-bound API contract.
Test both equally; being primary, first-party, system or `ui-client` conveys no additional authority.
Core confirmation and authentication pages retain their own origins and existing restrictions.

## Bootstrap And Upgrade Proposal

- Release Shell with the reviewed `ui-client` declaration through its ordinary update flow. Fresh
  setup can explicitly seed the UI it successfully installs when no previous UI policy exists;
  record this source of the choice. Later installs do not overwrite it.
- On upgrading Core, preserve an existing `hosty.shell` as an explicit default only if no UI policy
  was previously saved. Bind to that installation and record a one-time migration version. If Shell
  is absent, do not reinstall it or invent a preference; use automatic/no-UI behavior.
- For an existing Shell predating the role declaration, keep a narrow compatibility marker bound
  to that pre-upgrade installation. It preserves the existing navigation behavior and grants no new
  permission. A later app reusing the same ID does not receive the exception.
- Replace that installation's marker when it accepts the reviewed role-bearing manifest; removal
  invalidates the marker. Merely publishing a new Shell version is not a reason to remove support
  for installed older versions. Keep the compatibility path tested throughout this feature's release.
- Prepare/record migration atomically with the shared store revision. Retrying after a crash must
  neither overwrite operator choices nor enroll a new installation as the old legacy Shell.

## Deliverables

- [ ] D1. Implement reviewed `ui-client` roles, eligibility and the shared-store UI resolution adapter, specifying shared SDK panel-host conformance while separating selection from readiness and preserving explicit targets.
- [ ] D3. Integrate Core navigation, bound continuations, UI recovery through shared control/CLI and status; remove app-ID-based selection and audit every old resolver consumer.
- [ ] D4. Add the UI row to the shared settings page, the Core recovery/choice page and selected/last-UI removal warnings while preserving assignments and allowed headless operation.
- [ ] D5. Release Shell's role declaration and implement/test one-time default migration, bootstrap seeding and installation-bound compatibility for older installed Shell versions.
- [ ] D6. Complete cross-client navigation and panel-host conformance, migration and failure verification, update current feature documentation, remove this plan when complete and regenerate the index.
- [ ] D7. Verify all UI clients use the existing app-bound authorization contract; do not restore primary-session browser CORS or derive permissions from the UI role.

D2 is retired: its original task was to expand the removed Shell-specific CORS policy. D7 verifies
the replacement authorization boundary without treating that obsolete implementation as unfinished work.

- [ ] D8. Finish the app inventory and lifecycle presentation inherited from Core Extension Model D1: show distribution provenance and confirmed role/state badges from Core facts for all installed apps, and derive stop/restart/uninstall consequences from confirmed provider roles and dependents. Preserve shared lifecycle actions and live navigation; do not infer ownership from the manifest system flag. The read-only permissions inventory is owned by [app permission management](../app-permission-management/feature.md).

## Decisions Awaiting Approval And Delivery

Approve this proposal independently of Default applications and the SDK panel system. Recommended
delivery is the complete SDK panel feature, then shared defaults, then this complete UI-client
feature as one PR. The shared store/settings and panel protocol are dependencies; their selection,
renderer and Plans integration deliverables are not duplicated here. The principal changes from
the old draft are confirmed roles, no CORS expansion, no earliest-installed fallback, retained
failed selections with Core recovery, current workspace
routes and compatibility tied to installed upgrades rather than publication dates.

Marketplace listing, per-role autostart priorities, personal UI defaults, generic URL templates and
new notification-link features are outside this feature. Existing callers must still be migrated;
these exclusions do not excuse broken current deep links.

## Verification

- Two independently installed UI clients work directly; changing the primary affects only unbound
  navigation. Automatic selection covers zero/one/multiple clients, including stopped candidates.
- Use an alternative-client conformance fixture: Plans opens its exact finalized discussion in the
  current host beside the document, and tools also work on that host's own page. A primary-UI change
  leaves it in place. Standalone Plans has one local SDK host and needs no `ui-client` role. Test
  explicit unsupported-host recovery without requiring the alternative UI to use React.
- Ordinary users cannot enter an unassigned default; Core offers only accessible alternatives.
  Role declarations without confirmation, missing/ambiguous endpoints and lost grants are rejected.
- Stop, update, uninstall and reinstall the selected UI. Verify readiness messages, no silent
  substitution, retained preferences, last-UI removal and CLI recovery without any running UI.
- Login, setup, recovery, invitation, OAuth consent, app sign-in, CLI shell-mode open and existing
  MCP directory links work with either UI. Change the default during login and replay/expire a
  continuation; it remains bound and checks the current installation and actor.
- Cross-origin requests do not acquire primary Core-session access from the role. Both UIs obey
  independent grants, assignments and normal app-owned identity/renewal through Core-managed runs.
- Upgrade Core before Shell, Shell before Core, and resume an interrupted migration; preserve
  existing choices and deliberate uninstalls. Existing Shell without a role keeps working only
  through its recorded installation-bound compatibility path.
- Run Core/CLI tests/builds, Shell tests/build/lint, affected identity/navigation integration tests,
  version checks and documentation checks. This draft is documentation-only and requires no bump;
  implementation versions the affected platform and Shell artifacts per repository policy.

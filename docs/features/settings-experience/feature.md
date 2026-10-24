---
created: 2026-10-20
updated: 2026-10-23
summary: Shell unifies personal, host and application settings; Core confirms protected changes while Harness owns invocation preferences and instruction acceptance.
components: [apps/core, apps/shell, apps/harness, apps/marketplace]
---

# Settings Experience

Shell supplies a single settings destination. Core owns authorization and compact trusted
confirmation forms. Applications own their preferences and render the same settings page
embedded in Shell or standalone. Each field has one authoritative store and editor.

## Navigation And Ownership

| Destination | Tabs and contents |
| --- | --- |
| My profile | Profile; Connections; Tokens & devices. Credential lists default to the current user, including browser sessions, device/manual tokens and OAuth grant metadata. |
| Host | Updates; Network; Shared folders; Core source. Source uses the existing development/source checks and does not select an application runtime. |
| Users & security | Users and invitations; App permissions; Policies. Authorized support for another user's credentials opens in that user's detail. OAuth client registrations stay in Policies. |
| Shell | Shell preferences and tool presentation. |
| Apps | One app-named entry per declared app-owned `ui.settings` surface. Internal tabs belong to the app; host-managed App Details is separate. |

Shell has one Settings sidebar entry. The page owns grouped navigation, destination headings and
line tabs; narrow layouts wrap its navigation above the content. Its Apps group contains only apps
with a declared `ui.settings` surface, including stopped apps with their existing readiness/start
path. There is no duplicate installed-app catalog or general App settings entry. The former
`/settings?tab=apps` destination canonicalizes to Dashboard, subject to existing role authorization.

Entries retain their existing role/permission checks. Ordinary users can open personal Profile
and Tokens & devices; host administration and app management remain administrator surfaces.
Bookmarks using former settings tab names resolve to the corresponding destination.

Host > Updates includes read-only Core information from Shell's existing status snapshot: listen
address and public origin with copy buttons, data root, runtime host and ingress mode. It makes no
additional requests or polling and does not change editable settings or reset their drafts. Missing
status or fields show Unavailable; a known status without a public origin shows Not configured.
This block retains the same administrator access as the surrounding host settings. Core metadata,
status, resources, Logs and runtime/workspace, restart, update and Source settings actions remain
on Dashboard.

App Details/Manage is a standalone page at `/apps/<app-id>?section=<section>`, outside Settings.
An administrator sees `Dashboard / <app name>` with a native Dashboard link to `/dashboard`.
Former `/settings?tab=manage:<app-id>&section=<section>` bookmarks migrate to the same app and
section on the canonical page. Dashboard app-row activation opens this view, replacing the former
More > Manage application entry and runtime app service expander. Row actions, menus and source/version/resource disclosures
retain their independent behavior. Core also has no Dashboard expander or inline detail panel.
Applicable tabs expose Launch, Logs, Parameters, Folders, Network, Permissions, Updates and Backups.
Logs follows Launch when the app declares the logs capability.
Existing section IDs remain valid (`app`, `publicOrigins`, `mounts`, `source`); `parameters` addresses
the typed manifest parameters, including secret replacement controls. Launch saves autostart
independently. Parameters saves no autostart or public-origin values. A save in either section does
not clear the other's draft. Discard restores only the visible form. Network retains its existing
endpoint address controls and does not submit hidden parameter drafts.
The header provides Open app when a page exists, administrator Start/Restart/Stop, and More for
logs, assistant and removal when supported. Ordinary users viewing the retained logs-only page
keep a Home breadcrumb to the empty `/` start surface, without an administrator destination.

Dashboard Logs, More > Console logs, the readiness action and update-notification Open logs all
open `/apps/<app-id>?section=logs`, selecting the Logs tab rather than a Shell popup.
Logs requests the existing Core console tail of 200 lines on selection and explicit Refresh, with
per-service selection and aggregate-text fallback. Loading, empty output and Core errors remain
visible. Leaving Logs, changing app or user/Core scope, and unmounting abort obsolete reads; hidden
tabs do not fetch logs. Existing configuration forms stay mounted so visiting Logs retains drafts.
Core console logs retain their separate dialog.

An authenticated ordinary user can retain the logs-only Shell entry for a visible assigned app
with the logs capability. It exposes no management forms or lifecycle/removal controls and does
not authorize other Manage sections. Core still requires administrator authorization for its
console-log API; a refusal remains visible. The page grants no additional access.
App-owned preferences are separate embedded Settings destinations at their existing app tab URLs.
They retain normal Hosty identity, app-owned authorization and internal navigation. The settings
iframe fills the available content height; a small Shell header links to standalone App Details.
Dashboard keeps Runtime / workspace selection and Publish;
Core's Source settings remains a separate configuration destination.
Its checked **Autostart** menu item changes the same existing startup preference as Launch;
it does not change the active runtime and does not stop a running application.

Settings uses line tabs and label/value/note rows; narrow forms stack their fields without changing
store ownership. Manage keeps its mounted section forms across tab changes. Launch composes the
existing autostart form, declared dependency readiness and a union of runtime, health, artifact-lock
and cached update service inventory, including image-only workers. Service details retain full
health/runtime messages, start/restart observations, locked/running/candidate image references and
drift or matched-revision evidence. Missing observations stay Unknown rather than inheriting the
app's runtime state; missing candidate/registry information is explicit.

Launch reads detailed health and cached update status on entry, explicit Refresh services and
relevant runtime/source/revision changes. These reads do not refresh the registry or poll repeatedly.
Each read keeps its own visible error, and exit or identity changes abort stale results. Resources
subscribe only while Launch needs observed active-service readings; stopped/exited/unknown services
show none. CPU uses the existing one-logical-core convention. General app problems and the readiness
logs action remain above the Manage tabs. Endpoint editing remains solely in Network.

Folders separates primary app data from declared host-folder slots and retains the authorized
bindings through ReUI selects. Core does not project the primary-data path or size here; size is
explicitly unavailable. Network reuses existing endpoint service/browser addresses, copy/open,
local port reassignment and public-origin configuration. It does not offer public-origin changes
for internal endpoints. Backups retains its existing actions. Save never starts a process.
Loading and empty app states use the shared motion-aware Hosty grid/cell artwork.

Updates shows the installed version, last check, source/feed, available target, Core review class
and What changed from an applicable Core plan. Check now and Update/Review update reuse Dashboard's
existing plan, routine queue and isolated Core confirmation flow, including Shell self-update
recovery. Live source retains its own restart explanation rather than release-update controls.
Unknown permission deltas and download sizes are not fabricated; there is no automatic-update
preference. Source, feed and account controls remain mounted across tab changes and read only while
their section is visible. Superseded source reads cannot replace a newer observation. A changed
confirmed feed preserves an unsaved different choice and displays a notice; a successful own
selection rebases that draft. Failed/revoked reads retain drafts but freeze new feed/source review
actions until recovery. Selected Manage tabs scroll only their own strip into view on selection
and width changes; page scroll and mounted forms remain intact. Existing Core review, stale
revisions and operation recovery still apply.

Permissions shows required, optional and previously declared access in read-only groups, with
plain-word labels, technical identifiers, Core descriptions and allowed/unsupported/approval-needed
states. Confirmed provider roles remain separate from unconfirmed roles that require an app update.
Review permissions opens the existing Core page; Shell grants no access locally.

## Host Settings Presentation

Updates, Network, Shared folders and Core source use the existing Core information Frame pattern:
a muted outer frame, aligned header and a card-colored content panel. Core setting labels sit above
their controls with their existing inline descriptions and duration/reset details. Save settings
stays one action for the current form; provider-dependent fields retain their draft-driven visibility.

Network connection, Core publication and diagnostics retain separate framed sections with wrapping
actions and long-address disclosure. Shared mounts uses the same frame around its toolbar and table,
including usage expansion, read-only indicators, binding review, edit and delete confirmation. Its
pending/error/empty states remain inside that surface. A failed first read offers Retry and never
claims an empty library. A transient failure for the same actor and Core retains the last confirmed
table with a stale-data note; actor, origin or authority changes clear cached rows and mount-editor
drafts. Read generations and mutation scope guards reject old responses while successful same-actor
mutations reconcile across concurrent refreshes. Source repository fields and source-folder choices
use separate frames; running/selected project facts, source revisions and restart instructions stay
visible. Layout changes neither source selection nor Core/app lifecycle.

## Shared Form Controls

Shell's visible selection and input controls use the shared shadcn/Radix primitives alongside ReUI
Frame surfaces. Generic Core/app settings, shared mount modes, invitation roles/expiry, address
providers and open tool views use Select; checkboxes and source-folder radio choices use Checkbox
and RadioGroup. Text, numeric, URL and password fields keep the shared Input and boolean settings
keep Switch. No page owns a styled native select or a separate native checkbox/radio input.

Generic settings round-trip exact option values, including explicitly empty values, without
selecting a default on entry. An unknown saved value is shown as unavailable and remains unchanged
until the user chooses a supported option. Labels, disabled states, numeric invitation expiry,
source revisions, scope conflicts and original protected submissions stay with their existing
owners. Source path text remains separate from radio labels so it can be edited independently.
Dismissing a portaled Open views menu with Escape keeps the narrow tool panel open; Escape from
the panel itself still closes it.

## Tokens And Devices

The existing personal tab and authorized user-detail view use an in-place credential grid. Search
covers names, fingerprints, client metadata, audiences and scopes; type/access filters, sorting,
48/36 px row density, optional columns, page selection and 10/20/50-row pagination act on the
returned metadata. The API lists active credentials only and supplies no current-session marker;
the grid does not invent revoked/expired/current-device status. Token values are never shown.

Rename drafts survive refresh and refused saves. Core/actor/selected-user changes reset local rows,
selection and drafts and abort obsolete reads or mutations. Loading and failed reads remain
separate from an empty account or filters with no matches. Create token and Connect device stay on
Core's own pages for the current user; another user's detail offers neither creation action.

Selected credentials are revoked sequentially through each existing protected Core DELETE. Core
reviews every fingerprint; cancellation, an error, an uncertain reply or authority change stops the
sequence. Confirmed removals and remaining selected rows are shown with factual partial counts,
including when some selected rows are hidden by a filter. Bulk revocation is not atomic and can end
the browser session performing it.

The credential grid keeps OAuth client names and IDs available in its optional OAuth client column.
Its fixed minimum table width scrolls within the existing page container at narrow widths.

Background app access uses the same Frame and table surfaces, with search over names, app IDs and
returned scope metadata. It retains expired and revoked grant history, shows factual revocation
and expiry metadata, and offers a scoped row action. Its source remains the current administrator's
background grants; normal sign-out preserves these explicitly delegated grants. Loading and failed
reads are distinct from an empty or filtered list, and actor/Core changes abort obsolete work.

The personal Tokens & devices section places Revoke all my authorizations above the credential
grid for administrators. Its explanation includes browser sessions, tokens, OAuth authorizations
and background access. It uses the existing protected global POST and redirects to Core login only
after a confirmed success; cancellation, failure or a changed actor does not redirect. The action
is absent from ordinary-user and selected-user support views. Individual background revocation and
OAuth-client removal keep their separate protected DELETE endpoints.

## Protected Core Changes

The authenticated original API receives the proposed request. Protected mutations return 428
with an immutable review ID, status and isolated Core confirmation URL. Core binds the review to
the acting user, requesting installation, exact method/path/query/body and current relevant state.
The Core browser page renders server-generated labels and before/after values. Secret values
remain hidden. A browser session, same-origin decision and single-use nonce confirm or cancel.
App/service credentials cannot submit that decision.

After approval, the requesting app repeats the exact request with `X-Hosty-Settings-Change`.
Core revalidates current user and caller authority, installation identity, payload and revision
before dispatching through the existing domain endpoint. Replays return the recorded result;
changed payloads and stale state fail. In-memory requests expire after fifteen minutes and are
bounded to 128 entries and 128 KiB bodies. A Core restart expires outstanding reviews; it does
not convert them into a grant. Domain validation and audit still apply. Property lookup follows the
endpoint's case-insensitive Web binding. Protection and summary selection use the matched endpoint
route and bound parameters, including requests with different path casing or a trailing slash. Duplicate or case-ambiguous keys at any depth are rejected
before routine-change detection or review, so displayed and applied values cannot diverge.

| Operation | Review path |
| --- | --- |
| Core authentication/security/network settings, Core source, Cloudflare connection and Core publication | Exact protected settings request. Update-interval-only changes remain an ordinary preference. |
| User roles/status/assignments and invitations | Protected settings request. Public invitation acceptance retains its existing token flow. |
| Credential revocation, background access revocation and OAuth client removal | Protected settings request; owner/support authority checked before metadata disclosure and again on apply. |
| Application permissions and install/update decisions | Existing installation approval service. |
| Shared host paths and workspace source access | Existing domain-specific review and authority. |
| Autostart, typed app launch parameters, personal metadata and Harness Ask/Run preferences | Existing authorized editor; no additional popup just because a value is stored by Core. |

Shell opens a confirmation window and offers a visible fallback link. It polls only while a
review is pending. Cancellation preserves the draft; failed or stale requests report their cause.
Unknown apply results retain the operation identity. Trusted local control/recovery remains a
separate authority and does not depend on Shell being available.

The inline Core source form keeps the revision of its displayed draft, including after saving.
Background refresh adopts new source values only when there are no unsaved edits. A concurrent
change cannot silently replace the revision used to save an older draft.

## Credentials

Shell receives fingerprints, labels, audience/scopes and supported activity/expiry metadata;
it never receives token values from a listing. Owners can rename their credentials. Authorized
administrators can inspect and revoke credentials in a selected user's detail, with the additional
user-management permission for cross-user changes. There is no global token table.

Core login preserves the account action or exact settings-confirmation continuation on Core
without requiring Shell. Core `/account/tokens` contains manual token creation and its one-time result, `/account/device`
contains device-code approval, and `/account/background` contains the background-grant action.
Metadata tables live in Shell. OAuth consent and authorization remain Core-owned.
The [Core confirmation design](../core-confirmation-design/feature.md) covers the shared forms.

## Harness MCP Settings

Harness **MCP access** contains one expandable row per application and its individual tools.
Catalogs load on entry and explicit refresh; settings do not poll in the background.
All changes remain a draft until Save. Refresh preserves edited fields and incorporates concurrent
changes to untouched fields. Overlapping edits keep their original revisions and report a conflict;
Discard loads the refreshed values for an explicit new edit. A stale-review refusal permits a new
revision after refresh only when edits do not overlap. Unknown transport outcomes retain the
original request ID for recovery.

Core stores enabled assistant/provider relationships plus explicit tool exclusions. Enabled
providers include current and future tools. Missing tools keep their exclusions, including after
reappearance. Core checks exclusions on direct Core MCP calls and target introspection, independently
of Harness. Disabling a provider blocks its tools without erasing saved local invocation preferences.
One compact information popover explains automatic future-tool availability. Tool discovery itself
adds no update notice or extra approval.

Harness stores provider-wide Ask/Do not ask defaults and per-tool exceptions. Provider and page-wide
controls change these defaults without granting excluded tools. New tools inherit the provider's
saved default. Built-in development tools keep their Harness-local disabled choices: Core does not
serve these tools. Bulk invocation preferences preserve those exclusions, and the same editor
can explicitly enable or disable an individual built-in tool. App instructions are accepted locally against their installation and exact content
digest, without a Core popup. Changed content remains unaccepted. Instruction acceptance grants no
MCP capabilities and does not approve instructions for other consumers.

Save submits all Core access changes as one installation-bound review and atomic policy update,
then writes Harness preferences. This is not a distributed transaction: a local failure after Core
success retains the actual saved access and only the remaining local draft for retry. Cancellation
saves neither the requested access nor its associated local preferences. Local-only changes bypass
the Core review. The narrow `apps.mcp.access.request` permission requests the caller's own review;
configuring another assistant requires the administrative permission. Neither permission approves it.

External OAuth/facade discovery uses the current user's assignments and reviewed credential scope,
without the former Offered switch. Target/audience bounds, expiry, revocation, per-tool scope and the
facade's read-only filter remain effective. CLI instruction delivery retains its separate global
digest contract. See [agent MCP directory](../agent-mcp-directory/feature.md).

## Native Preferences And Migration

Harness persists legacy transcript retention into its own settings once. Marketplace persists its
catalog URL in app data, initializing once from the former environment setting or official default.
Its `/settings` page works embedded and standalone; writes require the app's administrator identity
and an expected source revision. Corrupt storage is not silently overwritten.

Core retains the two retired bootstrap values for upgrade initialization but hides them from the
manifest editor and rejects competing configure writes. Subsequent preferences come from app storage.
Typed manifest parameters remain supported for wrappers and headless apps. Whisper's model setting
continues to use Shell's Launch form and needs no application-specific web UI.

Legacy Harness tool exclusions migrate through Core review before the local disabled rule is removed.
Accepted instructions transfer only when the old approved digest, enabled assistant relationship and
provider installation match. Existing Ask/Run rules and other consumers' approvals are preserved.
Default-app resolution, object links and the shared skills library have their own plans.

A completed operation retains its captured status and response even when delivery to the caller
fails. Retrying the same reviewed request replays that result without executing the mutation again.

## Testing Expectations

- Exercise exact-payload review, replay, stale revisions, cancellation, revoked callers/users,
  CSRF/origin/nonce boundaries, duplicate/case-ambiguous JSON rejection and absence of legacy
  mutation bypasses over real Core HTTP routes, including casing/trailing-slash variants and
  personal credential revocation with bound fingerprints.
- Verify pristine Core source refresh, unsaved drafts and revision preservation after successive saves.
- Verify Host > Updates retains all five read-only Core facts and address copy controls from the
  shared status, with explicit unavailable/not-configured states, administrator gating and no
  additional requests or draft resets when status changes.
- Verify own versus selected-user credential metadata, secret-free lists, label preservation,
  trusted issuance, revocation and current-session effects.
- Cover independent assistant grants, both installation identities, discovery-only credentials,
  direct denied calls, future tools and persistent exclusions across catalog outages/removals.
- Cover one batched Save, local-only saves, cancellation, partial-save recovery, stable operation IDs,
  refresh with unsaved edits, bulk defaults and exact instruction digest migration.
- Run affected Core/CLI, Harness, Shell and Marketplace tests, builds, lint and version/docs checks.
  Use normal password login and Core-managed app lifecycle for browser acceptance; a standalone-only
  app test is not evidence of Shell identity or embedding.
- Verify Dashboard Logs, More > Console logs, readiness and update-notification actions select the
  same addressable Logs tab without a runtime-app log dialog. Cover tail/Refresh, service selection,
  empty/error states, no hidden-tab requests, aborts on exit/scope changes and preserved form drafts.
  Cover logs-only ordinary-user entry, visible-app/capability checks, refused non-log sections and
  factual Core authorization errors without management controls or expanded grants. Core logs
  remain a dialog.
- Verify standalone `/apps/<app-id>` navigation, preserved section links and legacy Manage URL
  migration. Administrator breadcrumbs return to Dashboard; ordinary-user logs retain Home at `/` as their
  accessible parent. Removed `tab=apps` does not render an installed-app catalog, and Settings Apps
  contains only declared `ui.settings` entries, including stopped-app readiness. Preserve role gates,
  app-owned identity/authorization, full-height embedding, internal tabs and existing app bookmarks.
- Verify Host settings frame/header/table consistency, long path/address wrapping and retained form
  drafts in light/dark and narrow views. Keep mount binding and source revision/confirmation tests.
- Verify responsive forms, dashboard runtime/Publish continuity, deep management links, autostart,
  trusted Core summaries and embedded/standalone app settings. Stop isolated runtime consumers after QA.

---
created: 2026-10-20
updated: 2026-10-21
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
| Installed applications | Their declared `ui.settings` page, or Manage application when no settings page exists. Internal tabs belong to the app. |

Entries retain their existing role/permission checks. Ordinary users can open personal Profile
and Tokens & devices; host administration and app management remain administrator surfaces.
Bookmarks using former settings tab names resolve to the corresponding destination.

Manage application is addressable as `/settings?tab=manage:<app-id>&section=<section>`.
Applicable tabs expose Launch, Permissions, Network, Folders, Source & updates and Backups.
Launch contains autostart and typed manifest parameters, including secret replacement controls.
App-owned preferences are separate. Dashboard keeps runtime/workspace selection and Publish.
Its checked **Autostart** menu item changes the same existing startup preference as Launch;
it does not change the active runtime and does not stop a running application.

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
- Verify own versus selected-user credential metadata, secret-free lists, label preservation,
  trusted issuance, revocation and current-session effects.
- Cover independent assistant grants, both installation identities, discovery-only credentials,
  direct denied calls, future tools and persistent exclusions across catalog outages/removals.
- Cover one batched Save, local-only saves, cancellation, partial-save recovery, stable operation IDs,
  refresh with unsaved edits, bulk defaults and exact instruction digest migration.
- Run affected Core/CLI, Harness, Shell and Marketplace tests, builds, lint and version/docs checks.
  Use normal password login and Core-managed app lifecycle for browser acceptance; a standalone-only
  app test is not evidence of Shell identity or embedding.
- Verify responsive forms, dashboard runtime/Publish continuity, deep management links, autostart,
  trusted Core summaries and embedded/standalone app settings. Stop isolated runtime consumers after QA.

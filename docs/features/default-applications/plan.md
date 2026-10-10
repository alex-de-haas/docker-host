---
status: Draft
created: 2026-10-08
updated: 2026-10-10
summary: Proposed shared defaults for host UI and assistants, with personal overrides, explicit migration and no silent replacement of selected providers.
components: [apps/core, apps/cli, apps/shell, apps/plans, packages/app-sdk]
---

# Default Applications

## Goal And Approval Boundary

Owner direction, 2026-10-08: move assistant selection from a Shell-only preference to Core and
provide shared defaults for supported roles/interfaces. See [vision decision 22](../../vision.md).
On 2026-10-10 the owner requested concrete proposals coordinated with
[replaceable UI clients](../replaceable-ui-clients/plan.md). The recommendations below answer the
design questions; they are not yet approved for implementation. The later owner direction on the
same day assigns shared panel presentation and the first Plans discussion flow to the separate
[SDK panel system](../sdk-panel-system/plan.md). These plans remain Draft.

The first categories are browser UI and assistant. Workspaces and Plans remain ordinary apps;
this work creates no workspace/plan-provider role, default agent, model selector or speech default.
Defaults apply where a caller needs one destination. They neither make a role exclusive nor change
permissions, assignments, provider execution policy or existing session ownership.

## Verified Baseline

Inspected on 2026-10-10:

- [Shell selection](../../../apps/shell/src/app/shell/assistant/use-assistant-selection.tsx) persists
  an app ID in a cookie keyed by Core origin and user. Its
  [resolver](../../../apps/shell/src/app/shell/assistant/assistant-client.ts) picks a sole assistant
  when no preference exists and retains an invalid explicit choice without silently replacing it.
  Shell chooses the `default` interface key, or the first declaration, within an app.
- [Plans discussions](../../../apps/plans/src/lib/discussion-server.ts) independently enumerate
  providers and require an explicit app ID/key, interface version 1, attachments and a UI destination.
  They preserve the selected provider and request ID through prepare/upload/finalize retries.
- [Provider access](../../../apps/core/src/Haas.Hosty.Core/ProviderEndpoints.cs) already discovers
  confirmed roles and binds credentials to caller/provider installations. Listing currently checks
  the consumer's permission; user access is additionally checked at credential issuance. A new
  user-aware default resolver must not treat that listing as an already user-filtered directory.
- [Shell origin resolution](../../../apps/core/src/Haas.Hosty.Core/ShellPublicOriginResolver.cs)
  still names `hosty.shell`. The UI-client plan owns replacing that lookup and Core navigation.
- Host administration already uses `core.configure`; Shell has it, while Plans needs only its
  existing `providers.assistant` permission to consume assistants. Shell uses its own backend with
  app service/user credentials, not privileged browser CORS access to Core.

## Recommended Scope And Precedence

| Preference | Scope and initial value | Who changes it |
| --- | --- | --- |
| Browser UI | Host-wide; `automatic` on an unconfigured host, with explicit bootstrap/upgrade preservation below | Administrator |
| Assistant baseline | Host-wide; `automatic`, or an explicit provider, or `ask` | Administrator |
| My assistant | Per Core user; `inherit`, or an explicit provider, or `ask` | That administrator, for their own account |

No per-user browser UI in this release: Core needs a destination before login and for links minted
without a user. Other installed UI clients remain directly usable. Assistant controls/dispatch in
Shell and Plans remain administrator-only; this feature does not introduce regular-user agent access.

Resolve an assistant in this order:

1. An existing session's owner, a pending handoff's frozen target, or an explicit choice for this
   request. Existing session references are opened at their owner, never recreated elsewhere.
2. The current user's explicit provider or `ask` policy.
3. The host's provider or `ask` policy when the user inherits.
4. Automatic selection only when the effective host policy is `automatic`.

`ask` is an intentional policy, including when only one provider exists; it must not fall through.
Resetting a personal preference means `inherit`. A one-time picker choice does not change either
default. An unchecked **Use as my default** option explicitly saves a personal selection where the
calling UI has management authority; other consumers link to Default applications for that change.

In automatic mode, count compatible, installed, confirmed providers accessible to both the actor
and the calling consumer, including required capabilities for this operation. Exactly one app/key
pair is selected; zero produces `no_candidate`, and several produce `choice_required`. Distinct
interface keys are distinct candidates; never choose the first array entry. Runtime readiness does
not reduce this count: two eligible providers with one stopped still require a choice. A sole
stopped provider stays selected but unavailable. Resolution does not install, start or grant anything.

## Selection, Availability And Changes

Store assistant references as `{ appId, key, installation }`; UI references omit `key`. `installation`
is Core's existing installation identity (currently the record's `InstalledAt`), captured by Core,
not a client assertion. Stable app/key identity survives ordinary updates; the installation binding
prevents a removed and reinstalled app from silently inheriting a previous routing decision.
Resolve endpoints from current registry state; never persist URLs, tokens or manifest versions as
the destination. Preferences and grants remain separate records.

An explicit selection never falls through to a lower-priority policy when it is stopped, removed,
unassigned, incompatible, missing a required capability, or reinstalled. Retain the preference and
return a reason. Restarting the same installation can restore availability without reselection;
reinstallation requires an explicit selection. Revocation remains effective immediately at use.
Before returning names/metadata, apply caller/actor visibility; inaccessible selections receive a
generic unavailable result rather than leaking another app's details.

For example, if the selected assistant accepts text but not attachments, Shell text requests can
use it. Plans' **Discuss document** explains the missing capability and offers a compatible one-time
choice. It never drops the document or silently sends it to another assistant. A configured host
provider unavailable to one user likewise does not fall back behind their back.

Return policy and result separately: `source` (`explicit`, `user`, `host`, `automatic`), selected
reference when visible, preference revision, and a structured state (`ready`, `choice_required`,
`no_candidate`, `unavailable`, `incompatible`, `selection_changed`, `configuration_error`). Resolution reads mint no tokens.
Credential issuance rechecks actor, consumer grant, provider contract, installation and readiness.

Freeze actor, consumer, provider installation/app/key and request ID before the first handoff write.
Recover a pending request before resolving a new default. Preference changes, tab changes, a Core
restart or an uncertain response cannot transfer that request to another provider. A stale
installation is refused, not rebound by app ID. This preserves the existing prepare/finalize model.

## Storage, API And Authority Proposal

Use one Core-owned `default-applications.json` store with typed host choices and per-user assistant
choices, rather than independent Shell cookies or a second `primaryUiAppId` setting. One serialized
atomic write path serves management, migration and recovery. Maintain a revision for the host scope
and each personal scope; saves require the observed revision and reject stale writes with 409.
An absent file uses the documented initial policies. An unreadable/unsupported file reports a
configuration error, leaves the file intact and does not silently route using fresh defaults.
Delete personal entries when the corresponding user is permanently purged.

Proposed surfaces:

| Surface | Contract and authority |
| --- | --- |
| `GET/PUT /api/core/default-applications` | Host policies, candidate summaries and revision; administrator plus `core.configure` for app callers |
| `GET/PUT /api/profile/default-applications` | Current actor's assistant override and migration decision; same management checks, no supplied user ID and no write to another user |
| `POST /api/internal/apps/{appId}/providers/assistant/resolve` | Read-only resolution with optional explicit app/key, supported interface versions and required capabilities; service token, actor app grant and `providers.assistant` |
| Local control/CLI | Host read/set/reset through the same service and revision checks; usable with no UI installed |

Personal settings are administrator-only in this first scope. Reuse `core.configure` for shared
preference management rather than granting every assistant consumer permission to rewrite global
routing or adding a new permission category. Plans can resolve and choose once, but cannot save a
shared preference. A UI client without `core.configure` can consume defaults without editing them.
Direct Core browser writes retain session/CSRF checks; app-backed writes retain service token,
current app identity/activity, permissions and actor-role checks. Audit preference mutations with
scope, actor, caller and old/new references, without credentials or prompts.

Add `ProviderClient.resolveAssistant(...)` and browser-safe result types to the TypeScript SDK;
retain explicit provider selection and `assistant(...)` for actual invocation. The resolver requires
the current actor rather than a user ID in the body, and validates access even on a cache hit. Return
only metadata necessary for selection; transport URLs continue to be resolved by provider issuance.
Expose supported default categories and contract version in the resolver/management responses
and Core status; a consumer must not need a new `core.read` grant just to discover this support.
Shell/Plans must report an unsupported Core explicitly; do not emulate shared settings in cookies.
Existing explicit provider calls remain compatible during a staggered upgrade.

## Settings And Migration Proposal

One **Settings → Default applications** destination contains **This host** and **My assistant**.
Show configured choice, effective source and availability separately. Keep the row visible even
with zero or one candidate so `ask`, inheritance and unavailable selections remain understandable.
Remove Shell's competing assistant-preference control. Changing a default does not switch the
current conversation, close other assistant tabs or override explicitly opened sessions.

Migrate Shell's cookie by an explicit, one-time offer to the currently signed-in user:

- Read only the cookie for the exact current Core/user scope. Never scan other account or host keys.
- If Core has no personal migration decision or explicit override, offer **Use this browser's
  assistant for me** and **Use Core settings**. Validate an imported provider against current
  installation/access; map its app-only ID to `default` if present, otherwise a sole interface key.
  Multiple non-default keys require a choice; do not import array order.
- Both actions save a personal migration decision with compare-and-set. A competing browser sees
  the newer Core value and cannot overwrite it automatically. An existing personal choice wins.
- After Core acknowledges the decision, stop using and remove the matching cookie. An invalid or
  unscoped legacy value is not imported. Shared preference API failure must not reactivate it.
- Until the offer is answered, this browser asks for an explicit target for new unbound requests;
  existing sessions and frozen handoffs continue normally. Merely rendering the offer saves nothing.

UI migration and fresh setup use the same store but belong to the UI-client plan. Preserve the
existing installed Shell as an explicit host UI once, without overwriting an already saved policy.
Fresh reviewed setup may record the UI it just installed when the host has no previous UI policy;
this is a documented bootstrap action. Ordinary installs never change a default. This intentionally
replaces the UI plan's former earliest-installed fallback; installation time is not user intent.

## Coordination And Delivery

Provider selection and presentation are separate. This plan answers which assistant should handle
a new unbound request; the SDK panel system answers where the resulting surface opens. A completed
handoff is opened at its original provider/session, including when Shell's own default differs.
Neither an assistant preference nor the host Browser interface setting selects a panel host for an
already open window. Standalone Plans continues to host its tools locally instead of redirecting
to the selected full UI.

| Owner | Deliverables owned here or there |
| --- | --- |
| This plan | Shared store/API/revisions and host control commands, assistant selection, personal migration, settings container, resolver SDK and Shell/Plans selection integration |
| [SDK panel system](../sdk-panel-system/plan.md) | Generic placement/host protocol and renderer, Shell/standalone composition, first Plans → assistant discussion beside its document, presentation retry and explicit separate opening |
| [UI-client plan](../replaceable-ui-clients/plan.md) | Confirmed `ui-client` role, UI eligibility/resolution adapter, navigation/links, Core recovery page, UI settings row, UI recovery through shared CLI, manifest rollout and legacy UI migration |
| Existing identity/readiness features | App authentication, assignments, grants, Core confirmation and readiness observations; reuse without redesign |

Recommended order: complete the SDK panel scenario with today's explicit provider selection, then
implement this shared-default foundation and complete assistant selection journey as this feature's
single PR. The panel feature does not depend on this Draft or invent temporary default storage.
This feature subsequently replaces Shell/Plans selection policy while reusing its presentation API.
The UI-client feature consumes both in its own complete PR; these are separate features, not phase
splits. Only advertise/render the UI category after its adapter is present. Do not create a temporary
independent Primary UI selector or claim replaceable shells shipped with assistant defaults.
Each proposal needs its own approval; accepting one does not implicitly approve the others.

## Deliverables

- [ ] D1. Finalize and obtain approval of the scope, precedence, compatibility, migration and coordination specified here; preserve independent SDK panel-system and UI-client ownership and approval.
- [ ] D2. Implement the shared Core store, revisioned management/control contracts, permission-aware assistant resolver and TypeScript SDK, with explicit unsupported-version behavior.
- [ ] D3. Add the single Default applications settings surface, host/personal policies and explicit cookie migration; remove competing Shell preference writes.
- [ ] D4. Integrate shared selection into Shell and Plans, operation-specific capabilities, one-time choice and frozen pending targets; preserve handoff authorization and delegate exact-session presentation to the SDK panel system without reselecting the owner.
- [ ] D5. Complete the verification below, update current feature documentation, remove this plan only after all deliverables pass and regenerate the index.

## Decisions Awaiting Approval

The recommendation is the complete proposal above: host-only UI; host assistant plus personal
inherit/provider/ask; sole-candidate automatic selection without readiness-based substitution;
retained failed explicit choices; explicit cookie migration; one shared store and settings page;
management under existing `core.configure`; presentation owned by the preceding SDK panel feature;
UI-client delivery as a coordinated separate feature.
There are no intentionally unspecified product choices in this draft. These recommendations do
not set the plan to Ready; owner approval is still required.

## Verification

- Resolver table: explicit owner/request, personal provider/ask/inherit, host provider/ask/automatic;
  zero/one/multiple app-key candidates; missing capabilities, access, roles and unsupported versions.
- Readiness and lifecycle: one of two providers stops; selected provider restarts, changes interface,
  loses grants, is removed or reinstalled. No silent substitution or automatic start occurs.
- Authorization: no user-ID impersonation, no cross-user preference writes, no consumer escalation
  from resolve to manage, no inaccessible candidate metadata, and no credentials in read responses.
- Concurrency/recovery: two browsers make conflicting saves/imports; host and personal updates do
  not overwrite each other; Core restarts; storage is corrupt; the user is disabled/purged.
- Handoffs: default changes between resolve/prepare/finalize, upload fails, response is lost, browser
  reloads and provider installation changes. Retry remains bound and does not duplicate execution.
- Core-managed browser acceptance: Shell and Plans share one preference across browsers; Plans
  requires attachments; an explicit workspace-owner session still opens at its original assistant.
  In both Shell and standalone, changing defaults after handoff creation opens that same session
  beside the document through the SDK host. Exercise optional permission denial/revocation and
  normal password login. Panel rendering/transport implementation remains owned by its own plan.
- Run affected Core/CLI/SDK/Shell/Plans tests and builds, Core AOT validation where its contracts
  change, version consistency and docs checks. The implementation bumps each changed release
  artifact according to repository policy. This proposal changes documentation only, with no bump.

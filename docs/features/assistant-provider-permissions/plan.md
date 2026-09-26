# Assistant Provider Permissions

Status: Ready
Created: 2026-09-26
Updated: 2026-09-26

Part of [shared assistant development sessions](../assistant-development-sessions/plan.md).
The umbrella's common invariants apply; this feature has independent scope and requires its own Ready approval.

## Goal And Owner Direction

Owner direction, 2026-09-26: the authority an app currently obtains by declaring the `ai-gateway`
interface comes instead from declarations the operator confirms at installation, in the same way as
`apps.install` and `apps.update`. The interface remains discovery metadata only.

Follow-ups the same day:

- Authority has two axes. What an app **provides** is a role other components route work to; what an
  app **may do** is a permission. The `role: system` label is not a privilege for either axis, so this
  plan adds no system restriction. The general model — few permissions, required and optional
  permissions, retiring `system` as a privilege — belongs to
  [core extension model](../core-extension-model/plan.md); this plan is its first slice and declares
  everything Harness needs as required.
- An **assistant** is an app with a full assistant UI that manages agents; Hosty Harness is one.
  Several assistants may be installed at once. An **agent** provider — an app that supplies agents
  for assistants and other apps — is a separate future role recorded in the core extension model,
  not part of this plan.
- Which assistant a UI client's own features use is that client's setting, not a Core setting. Hosty
  Shell shows every assistant as its own panel tab and keeps the choice for features such as "Ask
  assistant" in its settings; another UI client may have no such features at all.

## Current Behavior

Baseline: `origin/main` at `dfc36204`, inspected on 2026-09-26.

Core shape-validates `interfaces` and never shows them on installation or update review, yet
declaring `interfaces["ai-gateway"]` acts as authority in three places:

- Shell's `findAssistantGateway` (`apps/shell/src/app/shell/assistant/assistant-client.ts`) treats
  the first app declaring the interface as the only assistant. It receives the operator's prompts,
  `ask-assistant` drafts with other apps' context, and session creation; Shell's delegated-token
  handshake (`appMayReceiveDelegatedToken`) answers only that app's frame. The handshake token's
  audience is the app itself, so the handshake is not an escalation on its own.
- `GET /api/internal/apps/{appId}/agent-skills/{targetAppId}` (`DomainEndpoints.cs`) lets a declaring
  app read any other app's agent skill.
- `OAuthEndpoints.ResolveResourceAsync` recognizes the declaring app's origin plus `/mcp` as the
  host-wide MCP facade resource. The same method already recognizes any app's declared `mcp`
  interface URL; both yield a token whose audience is that app.

The manifest reference (`skills/hosty-app-skill/references/app-manifest.md`) states that declaring an
interface grants nothing; for `ai-gateway` the code contradicts it. Separately, the delegated-token
exchange and on-behalf-of tokens that let an app act toward other apps as the user are gated by
`role: system`, not by the interface (`AuthEndpoints.cs`, `OnBehalfOfTokenEndpoints.cs`).

`provides` holds slot tokens that Core reacts to only when its `PlatformCapabilities` registry knows
them (today only `otlp-collector`); slots pass through no operator confirmation. `corePermissions` is
a closed vocabulary (`CoreAppPermissions` in `InstallationApprovalStore.cs`: `apps.install`,
`apps.update`); unknown entries fail manifest validation. Core records the approved set as
`GrantedCorePermissions` at installation and reviewed update; queued updates that add permissions
require confirmation, and editing a source manifest grants nothing. Core's confirmation page shows
permission descriptions; the SDK `InstallDialog` that Shell uses lists requested permissions by raw id.

## Target Behavior

### Assistant Role

- A manifest declares `provides: ["assistant"]` and keeps the `ai-gateway` interface to locate its
  API. Core adds the slot to its registry as a role that requires operator confirmation. Its
  cardinality is fan-out: every confirmed assistant is available, and none is a Core-level default.
- The role is inert until confirmed. Installation and reviewed-update review show it with a
  description; Core records the confirmed role on the app record next to `GrantedCorePermissions`
  and exposes confirmed roles through the apps API. An update that adds the role re-enters
  confirmation; editing a source manifest confirms nothing.
- Other slots keep their current behavior. Confirmation for existing slots such as `otlp-collector`
  is part of the core extension model, not this plan.

### Permission

- One new permission, `apps.skills.read`: read the agent skills of installed apps. The agent-skill
  endpoint checks `GrantedCorePermissions` instead of the interface.
- It is a required permission of the Harness manifest. When the core extension model ships optional
  permissions, Harness may move it to the optional set.

### MCP Facade

Owner decision, 2026-09-26: Core becomes the directory of MCP servers agents may use
([agent MCP directory](../agent-mcp-directory/plan.md)), and the single-entry facade becomes a
separate app later ([MCP facade](../mcp-facade/plan.md), On Hold). This plan leaves the gateway facade
unchanged: `ResolveResourceAsync` keeps its special case for the `ai-gateway` app's origin plus `/mcp`.
It grants no authority — the token's audience is that app, exactly as for a declared `mcp` interface.

### Common Rules

- No role or permission is inferred from app id, interface or system role, consistent with the
  installation feature's rule against silent ID-based grants.
- Review surfaces list the role and permission with plain descriptions: the operator installs with all
  of them or declines. Core's confirmation page, the install dialog Shell uses and update plans mark
  additions.
- An older Core rejects a manifest that requests an unknown permission (it ignores an unknown slot),
  so Core ships before any manifest requests `apps.skills.read`.

### Assistants In Hosty Shell

- An app is an eligible assistant when it holds the confirmed assistant role and declares the
  interface. Shell shows one assistant panel tab per eligible app; the operator talks to whichever
  assistant's tab they write in. The delegated-token handshake answers each eligible assistant's own
  frame, with a token whose audience is that assistant.
- Shell's own features that hand work to an assistant — `ask-assistant` drafts from apps, "ask the
  assistant" on operation errors and similar entry points — use the assistant selected in Shell's
  settings, stored with Shell's existing preferences. With one eligible assistant it is used without
  a setting. With several and no selection, Shell asks the operator to choose.
- When the selected assistant becomes ineligible (uninstalled, role removed by a reviewed update,
  interface dropped), those features ask the operator again; drafts are never rerouted to an
  assistant the operator did not select. A stopped assistant keeps its tab and is shown as unavailable.
- Other UI clients decide for themselves whether and how they use assistants; the
  [Harness Swift client](../hosty-harness-swift/plan.md) talks to Harness directly.

### Release And Transition

No migration code. This plan ships before the [Harness rename](../hosty-harness-rename/plan.md), in
one PR that changes Core, Shell, the SDK install dialog and the existing Gateway manifest. Hosts
update Core first; the operator then confirms the Gateway update that adds the role and permission.
Until then the Gateway does not appear as an assistant on the new Core — the intended, visible
result, not something to auto-grant. The renamed `hosty.harness` later declares the same on its fresh
installation.

Version outcome when implemented: platform minor (slot registry, permission vocabulary, confirmed
roles in the apps API and the new checks), Shell minor for assistant tabs and the setting,
`@hosty-sdk/app` for permission descriptions in its install dialog, and the Gateway manifest.

## Not In This Scope: Delegated MCP Use By Other Apps

Calling other apps' MCP tools on the user's behalf through the delegated-token exchange requires
`role: system` today. Code comments record the domain-app trust story as undesigned. A non-assistant
app that uses selected MCP tools needs a target-scoped permission (the operator approves the listed
target apps), audit and revocation. The [core extension model](../core-extension-model/plan.md) owns
replacing that gate; this plan leaves it unchanged.

## Deliverables

- [ ] Add the confirmed fan-out `assistant` slot and the `apps.skills.read` permission to Core with
  descriptions, confirmation recording, manifest validation and confirmed roles in the apps API.
- [ ] Replace interface-based authority in Core: agent-skill reads check the permission instead of the
  interface.
- [ ] Show every eligible assistant as its own Shell panel tab with the delegated-token handshake per
  assistant, and add Shell's assistant setting for its own entry points with the no-selection state.
- [ ] Show role and permission descriptions and additions in every install/update review surface,
  including the SDK install dialog used by Shell.
- [ ] Declare the role and permission in the Gateway manifest.
- [ ] Update the manifest reference in `hosty-app-skill` and the installation feature's permission
  vocabulary, publish `feature.md`, remove this plan and regenerate the index.

## Open Questions

None. Names and assistant selection were settled with the owner on 2026-09-26; the agent provider
role and the general permission model are tracked in the core extension model, and the facade's
future in the MCP facade plan.

## Verification

- An app that declares `ai-gateway` without a confirmed assistant role gets no Shell tab; without
  `apps.skills.read` it receives 403 on agent-skill reads.
- Install and update review show the role and permission with descriptions; adding either by update
  requires confirmation; editing a source manifest grants nothing; an older Core rejects the manifest
  that requests the new permission.
- With two eligible assistants, Shell shows two tabs and each answers in its own tab. Shell's entry
  points ask for a selection, then reach only the selected assistant. Uninstalling it or removing its
  role makes Shell ask again instead of falling back; a stopped assistant is shown as unavailable.
- Removing the permission or role through a reviewed update revokes the corresponding access on the
  next check.
- Harness works end to end: its assistant tab and skill injection into sessions.

# Assistant Provider Permissions

Status: Draft
Created: 2026-09-26
Updated: 2026-09-26

Part of [shared assistant development sessions](../assistant-development-sessions/plan.md).
The umbrella's common invariants apply; this feature has independent scope and requires its own Ready approval.

## Goal And Owner Direction

Owner direction, 2026-09-26: the authority an app currently obtains by declaring the `ai-gateway`
interface becomes explicit Core permissions that the app requests and the operator approves, in the
same way as `apps.install` and `apps.update`. The interface remains discovery metadata only. Several
apps may hold assistant authority; an operator setting selects which one is the default assistant.

Split the authority along the enforcement points that exist today rather than as one bundle. Hosty
Harness requests all of them, but a later app may need only part — for example, using selected
MCP tools without being a full assistant. Splitting after grants exist would force every installed
assistant through a reviewed update, so the split happens before the first grant is issued.

## Current Behavior

Baseline: `origin/main` at `dfc36204`, inspected on 2026-09-26.

Core shape-validates `interfaces` and never shows them on installation or update review, yet
declaring `interfaces["ai-gateway"]` acts as authority in three places:

- Shell's `findAssistantGateway` (`apps/shell/src/app/shell/assistant/assistant-client.ts`) treats
  the first app declaring the interface as the assistant. It receives the operator's prompts,
  `ask-assistant` drafts with other apps' context, and session creation; Shell's delegated-token
  handshake (`appMayReceiveDelegatedToken`) answers only that app's frame. The handshake token's
  audience is the app itself, so the handshake is not an escalation on its own.
- `GET /api/internal/apps/{appId}/agent-skills/{targetAppId}` (`DomainEndpoints.cs`) lets a declaring
  app read any other app's agent skill.
- `OAuthEndpoints.ResolveResourceAsync` recognizes the declaring app's origin plus `/mcp` as the
  host-wide MCP facade resource, so external agents complete OAuth against it.

The manifest reference (`skills/hosty-app-skill/references/app-manifest.md`) states that declaring an
interface grants nothing; for `ai-gateway` the code contradicts it. Separately, the delegated-token
exchange that lets an app call other apps on the user's behalf is gated by `role: system`, not by
the interface (`AuthEndpoints.cs`).

`corePermissions` is a closed vocabulary (`CoreAppPermissions` in `InstallationApprovalStore.cs`:
`apps.install`, `apps.update`). Unknown entries fail manifest validation. Core records the approved
set as `GrantedCorePermissions` at installation and reviewed update; queued updates that add
permissions require confirmation, and editing a source manifest grants nothing. Shell already derives
iframe sandbox policy from persisted grants. Core's confirmation page describes each permission; the
SDK `InstallDialog` that Shell uses lists requested permissions by raw id.

## Target Behavior

### Permissions

Working names; final names and wording are an open question.

| Permission | Authority | Replaces the check in |
| --- | --- | --- |
| `assistant.provider` | Eligible to be the host assistant: receives assistant requests and app drafts with their context, creates sessions, receives Shell's delegated-token handshake | Shell assistant selection and handshake |
| `agents.skills.read` | Reads other apps' agent skills | Core agent-skill endpoint |
| `mcp.facade` | Publishes a host-wide MCP connector for external agents, recognized as an OAuth resource | `OAuthEndpoints.ResolveResourceAsync` |

- Checks read persisted `GrantedCorePermissions`. The interface only locates the API:
  `assistant.provider` requires the grant and the interface declaration; the other two require the grant.
- No grant is inferred from app id, interface or system role, consistent with the installation
  feature's rule against silent ID-based grants.
- Core's confirmation page, the install dialog Shell uses and update plans show a human-readable
  description of each permission and mark additions.
- Proposal: accept these permissions only in `role: system` manifests initially. Assistant sessions
  are administrator-only, and the delegated-token exchange needed to use other apps' MCP tools is
  system-only; relaxing either belongs to the delegated MCP design below.
- An older Core rejects a manifest that requests an unknown permission, so Core ships the vocabulary
  before any Harness manifest requests it.

### Default Assistant

- A Core-owned host setting in the existing Core settings store (`CoreSettings.cs`), editable by an
  administrator, audited and exposed through the apps/platform API. Shell, Swift Shell, the
  [Harness Swift client](../hosty-harness-swift/plan.md) and app entry points resolve the same assistant.
- An app is eligible when it is installed, holds `assistant.provider` and declares the interface.
  With exactly one eligible app and no explicit choice, that app is the effective default. With
  several, the operator chooses; the first match is never selected silently.
- When the chosen app becomes ineligible (uninstalled, permission removed by a reviewed update,
  interface dropped), there is no effective assistant and clients ask the operator to choose.
  Prompts are never rerouted to an app the operator did not select. A stopped default stays
  selected and is shown as unavailable.
- The assistant panel, `ask-assistant` routing and the delegated-token handshake follow the effective
  default only, not every holder of the permission.

### Release And Transition

No migration code. Either ship with the [Harness rename](../hosty-harness-rename/plan.md), where the
fresh `hosty.harness` installation requests the permissions and the operator approves them, or ship
earlier and let the existing Gateway request them through a reviewed update that the operator
confirms. In both cases a Gateway without the grants stops acting as the assistant on the new Core;
that is the intended, visible result, not something to auto-grant. Shipping with the rename is preferred.

Version outcome when implemented: platform minor (manifest vocabulary, Core checks and setting),
Shell for selection and the no-assistant state, the Harness/Gateway manifest, and `@hosty-sdk/app`
if its install dialog gains permission descriptions.

## Not In This Scope: Delegated MCP Use By Other Apps

A fourth power is calling other apps' MCP tools on the user's behalf through the delegated-token
exchange, which today requires `role: system`. Code comments record the domain-app trust story as
undesigned. A non-assistant app that uses selected MCP tools needs a target-scoped permission (the
operator approves the listed target apps), audit and revocation. This plan does not change the
exchange gate; that design gets its own plan when a concrete consumer exists.

## Deliverables

- [ ] Finalize permission names, descriptions and the system-role restriction; add them to Core's
  closed vocabulary and manifest validation.
- [ ] Replace interface-based authority in Core (agent-skill reads, facade resource resolution) with
  grant checks; keep interface declarations for discovery.
- [ ] Add the default-assistant setting with eligibility rules, audit and API exposure.
- [ ] Resolve the assistant in Shell through the effective default (panel, `ask-assistant`,
  delegated-token handshake); add the chooser and the no-assistant state.
- [ ] Show permission descriptions and additions in every install/update review surface, including
  the SDK install dialog used by Shell.
- [ ] Request the permissions in the Harness/Gateway manifest in the chosen release order.
- [ ] Update the manifest reference in `hosty-app-skill` and the installation feature's permission
  vocabulary, publish `feature.md`, remove this plan and regenerate the index.

## Open Questions

- Final permission names and granularity: are `assistant.provider` and `mcp.facade` separate rights,
  and what wording does the operator see?
- Restrict the permissions to `role: system` manifests initially, as proposed?
- Keep the facade as "origin plus `/mcp`" or declare its path explicitly through an interface entry?
- Per-user default assistant, or one host-wide default only?
- Which plan owns target-scoped delegated MCP use once a non-assistant consumer appears?

## Verification

- An app that declares `ai-gateway` without the grants is not offered as an assistant, receives 403 on
  agent-skill reads and is not recognized as a facade OAuth resource.
- Install and update review show the requested permissions with descriptions; adding one by update
  requires confirmation; editing a source manifest grants nothing; an older Core rejects the manifest.
- With two eligible assistants, the operator chooses; the panel, `ask-assistant` drafts and the
  delegated-token handshake reach only the default. Uninstalling or revoking the default leaves no
  assistant and does not fall back to the other app; a stopped default is shown as unavailable.
- Removing a permission through a reviewed update revokes the corresponding access on the next check.
- Hosty Harness with all three permissions works end to end: assistant panel, skill injection into
  sessions and OAuth for external MCP clients.

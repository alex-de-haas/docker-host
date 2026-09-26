# Hosty Harness Rename

Status: Draft
Created: 2026-09-26
Updated: 2026-09-26

Part of [shared assistant development sessions](../assistant-development-sessions/plan.md).
The umbrella's common invariants apply; this feature has independent scope and requires its own Ready approval.

## Target Behavior

Owner direction, 2026-09-25: rename **AI Gateway** to **Hosty Harness** as part of this broader
redesign. Use that spelling consistently in the resulting product UI, app display metadata, setup
guidance and documentation. References to Gateway in this Draft still identify the existing
component and baseline; this documentation change does not rename the installed app today.

Owner clarification, 2026-09-25: change the application id as well as its display name. Planned
target: `hosty.ai-gateway` -> `hosty.harness`. The transition is an operator-performed uninstall of
the old app followed by a fresh Hosty Harness installation and manual configuration. No migration
or preservation of old sessions, history, provider settings, credentials or grants is required for
this replacement; the owner has no valuable state to carry over. Do not build an in-place upgrade,
legacy-id alias or automatic state import for this rename.

Update manifest identity, system-app registration/discovery, feeds/install references, token audiences,
permissions and client configuration coherently for the new id. Inventory related paths/routes and
documentation during implementation. A new installation must not silently reuse old credentials or
depend on the old app. This clean-install decision is specific to replacing the current AI Gateway;
the new Harness's normal source/session retention and safe workspace-cleanup requirements still apply.
This Draft does not uninstall anything now; the operator performs the replacement when it is ready.

## Interface, Distribution And Release Contract

Keep application ID and discovery-interface name distinct. `DomainEndpoints.cs` gates cross-app
skill reads on `interfaces["ai-gateway"]`; `OAuthEndpoints.cs` recognizes the facade resource by
that interface; Shell's `assistant-client.ts` discovers the same key. Proposed first rename keeps
the interface key `ai-gateway` while changing app ID/display identity. It is a protocol contract,
not a legacy app-ID alias. Renaming that key instead requires a coordinated Core/Shell/Harness
contract release and must be selected explicitly before Ready.

Owner direction, 2026-09-26: [assistant provider permissions](../assistant-provider-permissions/plan.md)
moves the authority out of that interface into a confirmed assistant role and an approved skill-read
permission; Shell shows every confirmed assistant as its own tab. The key then only locates the API,
so keeping `ai-gateway` carries no authority. That plan ships first and the existing Gateway receives
the role and permission through a confirmed update; the new `hosty.harness` manifest declares the
same and the operator confirms them at the fresh installation, so no grant migration is needed. The
MCP facade stays in Harness until it becomes a separate app ([MCP facade](../mcp-facade/plan.md), On Hold).

The old Core distribution descriptor and app feeds reference raw `main/apps/ai-gateway` files.
Do not remove those paths without a retirement policy. Proposal: release Core with the new
installation descriptor first; keep the old manifest/feed URLs as frozen old-ID installation
metadata for a defined compatibility window, with clear replacement guidance. They must never
silently return the new app ID under an old installation's update URL. A supported tombstone
would need a consumer contract, not an invented valid-looking manifest. Neither retained files
nor release ordering migrates app state; the owner still uninstalls/reinstalls manually. Decide
how older Core users are informed and when old URLs can be retired before removing them.

Re-register external MCP clients and authenticate against the actual new Harness facade resource.
The app origin/port may change with the new installation; query the assigned endpoint rather than
assuming the old one survives or that a particular new port is guaranteed. Cover Codex, Claude and
the Hosty connector/plugin. Old credentials are not imported.

Inventory app IDs, interfaces, token audiences, discovery, manifests/feeds, distribution descriptors,
CI job names and path filters, image/package names, root npm workspaces and `ai-gateway:*` scripts,
`scripts/check-versions.mjs`, SDK/skill examples and documentation links. Existing `ai-gateway*`
feature folders have stable documentation identities: update their content/links deliberately;
renaming every folder is not required by a product display-name change.

Choose whether the new artifact starts at 0.1.0 or continues the Gateway version line. Add its
manifest/package version sources and independent release policy to `AGENTS.md` when the rename
ships; bump Core/Shell only for changes they actually ship under repository policy. The rename
can ship independently of AHP and the session-workspace implementation.

## Deliverables

- [ ] Inventory identity, interface, build, distribution and client references; implement the selected
  rename contract.
- [ ] Implement and document the old manifest/feed URL retirement and Core release order without app-state
  migration.
- [ ] Update native/external client discovery and reconnection guidance, documentation and skill references.
- [ ] Apply the chosen artifact version policy, add its AGENTS.md entry, and verify fresh install/update
  behavior.

## Open Questions

- Which repository paths, routes, build/publish references and client setup details need updating
  alongside the new `hosty.harness` app id? Inventory them for a coherent fresh installation; the owner
  has already chosen manual replacement without migration or legacy-id aliases.
- Keep the ai-gateway interface key as proposed, or coordinate a new interface contract?
- Which old-URL retention window and operator notification are supported, and which artifact version
  starts the new identity?

## Verification

- Verify a fresh `hosty.harness` installation and the documented operator uninstall-old/install-new
  flow. Configure providers anew and check Shell/client discovery, permissions, new sessions and
  subsequent updates under the new identity. No old sessions/settings/credentials are imported and
  no old-app dependency or legacy-id alias is needed.
- The fresh installation shows the assistant role and requested permission for confirmation, and
  Harness appears as an assistant only after they are confirmed.

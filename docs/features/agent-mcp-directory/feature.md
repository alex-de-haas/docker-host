---
created: 2026-09-26
updated: 2026-10-21
summary: Core enforces installation-bound assistant MCP access and tool exclusions; Harness owns invocation preferences and app instruction acceptance.
components: [apps/core, apps/harness, apps/shell]
---

# Agent MCP Directory

Core owns which MCP providers and tools an installed assistant can use. Harness edits its own
relationships in Settings → MCP access; there is no fleet-wide Shell Agents tab. An assistant
starts without provider grants, including `hosty:core`. Current user assignments and role further
restrict every invocation. The [settings experience](../settings-experience/feature.md) owns navigation.

## Access And Reviews

Each assistant/provider relationship binds both installations and carries a revision, enabled
state and explicit denied-tool names. Enabled relationships include future tools automatically.
Denials survive discovery failure and tool disappearance. Disabling and re-enabling cannot revive
old credentials; reinstalling either party requires a current relationship.

Harness requests an `assistantAccess` batch through the existing installation request API. The
`apps.mcp.access.request` permission permits requesting a review for the caller's own installation;
`core.configure` is required for another assistant. A current administrator browser confirms the
exact before/after batch on Core's isolated origin. Caller credentials cannot approve it.
Core rechecks request identity, directory revision, current user/caller authority and installations
under the affected application locks before one atomic policy write. Other assistants' grants remain
unchanged. Same-ID retries require identical inputs and recover the retained request.

The former direct `PUT /api/core/agents/{targetId}` cannot bypass review. Trusted legacy Core
`/install/agents` review remains for compatible consumers and global instruction acceptance.
Legacy relationships without an explicit enabled value use their old Offered bound. New reviewed
relationships use their own enabled value; the extra host-wide offer is not their gate. Batch changes
preserve the global offer: without a stored policy, Core defaults to offered and other providers to
not offered. Existing global values and other assistants' legacy grants remain unchanged.

Core filters the assistant-facing directory and checks live relationships at token issuance,
Core MCP invocation and app MCP introspection. Per-tool exclusions apply even when a caller uses
a cached catalog or sends tools/call directly. Harness also filters its proxy, but is not Core's
security boundary. See [MCP delegation](../delegated-token-exchange/feature.md).

## Invocation Preferences And Instructions

Harness stores provider Ask/Do not ask defaults and per-tool exceptions locally. Bulk controls
never remove Core denials. New tools inherit the provider default. Existing read-only/default rules
retain their compatibility behavior until the operator selects an explicit provider default.

Application instruction acceptance is local to Harness, keyed by provider installation and reviewed
digest. Core provides authorized text with the existing `apps.skills.read` permission; Harness does
not require global Core instruction approval. Migration transfers only the matching previously
approved content from an enabled relationship. Changed or unreadable content is withheld. Acceptance
does not grant tools or approve text for another consumer. Fresh sessions receive accepted text;
already delivered conversation history cannot be retracted.

CLI/facade instruction delivery retains the global approved digest in `core/agent-policy.json`.
The existing skill identity is the first 32 lowercase hex characters of SHA-256 over trimmed UTF-8
text. Tools and instructions remain independent decisions. The shared skills library belongs to the
[agent skills plan](../agent-skills/plan.md).

## Directory And Discovery

`GET /api/internal/apps/{appId}/app-directory` authenticates the installed service identity and
returns the app roster plus `agents: { revision, targets, settingsUrl }`. Targets include identity,
MCP interfaces/readiness, installation and instruction digests. In this assistant-specific view,
`offered` projects that assistant's enabled relationship and `deniedTools` its exclusions. Other
assistant IDs and credentials are omitted. `?revision=<current>` returns 304 for unchanged data.
Policy, installation, fleet metadata, endpoints, readiness and skill changes invalidate the revision.
The trusted local control endpoint exposes a credential-free administrative directory.

Settings catalog discovery needs a current administrator app activity and the narrow request
permission, but can preview a provider before access is granted. Core mediates initialize/tools-list,
with a 30-second discovery-only credential that never reaches Harness. It cannot invoke tools or
create chat authority. Catalog exchange is bounded to 20 seconds, 20 pages and 1,000 tools.
Unavailable catalogs do not reset access or preferences.

## Consumers

Harness sessions refresh at start and before turns. The proxy obtains fresh target tokens and checks
current access for calls. Claude reconfigures servers between turns; Codex restarts its idle app
server and resumes the native thread after a successful replacement. A failed resume retains the
old process, while revoked access remains blocked. Unrelated metadata changes do not emit a server
change notice or restart a conversation.

External OAuth/facade clients see providers available to the user and reviewed credential without
an Offered gate. Facade tool export remains read-only, validates every call and introspects the
external credential online. Its per-user cache has a 30-second TTL under an unchanged revision;
cache retention during discovery failure grants no offline invocation authority. Direct OAuth
credentials and assistant delegation retain distinct provenance and scopes.

The local CLI retains its compatible offer/instruction path. Removing a user assignment, disabling
a user or revoking a grant still blocks subsequent calls. Already dispatched work is not rolled back.

## Testing Expectations

- Check batch identity/revision/nonce/Origin authority, same-ID recovery, disabled direct mutation,
  cancellation, global offer defaults and preservation of other assistants' legacy bindings.
- Check installation replacement, parent logout, per-tool denial on direct calls/introspection and
  rejection of discovery credentials for calls or chat authority.
- Cover future tools, absent-tool exclusions, default inheritance, local-only saves, bulk controls,
  stale refresh, partial-save recovery and exact-content instruction migration.
- Verify external OAuth user/scope bounds and facade read-only filtering without Offered gating;
  global instruction approval must not be implicitly broadened.
- Run Core/CLI and Harness tests and production builds; verify normal authenticated Shell embedding
  and standalone settings. Repeat the native protocol probe when pinned agent SDK behavior changes.

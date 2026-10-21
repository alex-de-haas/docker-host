---
created: 2026-08-15
updated: 2026-10-20
summary: Core grants individual assistants access to selected MCP targets through administrator-configured delegation.
components: [apps/core, apps/harness]
---

# Assistant MCP Delegation

Core grants individual installed assistants access to selected MCP targets. The relationship is
stored in the Core agent policy and requires administrative configuration. A host-wide offer, the
`system` flag, an assistant declaration or an ordinary app login alone grants no cross-app access.
The [agent directory](../agent-mcp-directory/feature.md) exposes and edits these relationships.

## Issuance And Identity

`POST /api/internal/apps/{appId}/mcp/token` authenticates the assistant with its service bearer and
the acting user with `X-Hosty-User-Token`, an app grant issued to that same assistant. The body names
`targetAppId` and a conversation `sessionId`. Core checks current browser/native app authority
and the live authorizing Core sign-in, app grant, confirmed assistant role/interface, explicit target
enabled relationship, both installation identities and user access to the target. Core MCP
also requires the current user to be an administrator.

An explicit [background grant](../continuous-app-access/feature.md) supplies an alternative source:
its short-lived app-bound credential pins the target and exact allowed tools. That path needs no
browser principal or conversation ID, but keeps the confirmed relationship, installation and user
checks. Ordinary logout does not revoke it; grant revocation and account authorization changes do.

The five-minute `hosty_mcp.1` credential is signed and distinct from app sessions and legacy delegated
tokens. Its claims bind the assistant, target, user, installations, relationship revision and a
one-way reference to the parent app grant. The parent secret is never exported. A grant predating
an assistant reinstall cannot mint credentials for that new installation.

## Validation And Revocation

MCP handlers use `introspectMcpToken` in the JavaScript SDK or `IntrospectMcpAsync` in the .NET SDK.
These call the existing target-service-authenticated introspection endpoint with `purpose: mcp`.
The response includes the current user/role, `callerAppId`, and `mcp:read`/`mcp:invoke` scopes. The
receiving application applies its own user permissions to every tool. Invocation scope permits MCP
operations within that user policy, not arbitrary HTTP API access.

Ordinary scoped introspection omits the MCP purpose and rejects these credentials. App-session and
legacy delegated-token validators also reject the separate token format. Applications must use
the MCP-specific helper only on their MCP surface and must not cache introspection. Applications
using only the old local delegated validator need an SDK/handler update before accepting this format.

Introspection rechecks current app authority, its live source, enabled relationship, installations,
parent app grant, explicit tool exclusions and current user access on every call. Revoking the relationship or parent
grant, removing a user assignment or disabling the user refuses subsequent calls. Regranting a relationship
does not revive a token carrying its old revision. Core outages refuse validation; already-dispatched
operations are not rolled back.

Core MCP additionally checks the assistant's existing Core permissions for each tool: app reads/logs,
Core state/logs, application lifecycle/install and Core lifecycle. A relationship with Core alone
does not grant management authority. Harness declares additional Core MCP permissions as optional;
the administrator approves only the operations needed.

## Harness Transport

Harness keeps the user's app credential in memory and requests target-specific MCP tokens from
Core with its service credential. The local session proxy forwards only the target credential.
Native agent processes receive a session-local proxy key, never the Core cookie or app grant.
Source/workspace operations retain their own app-credential path. Session transcripts persist no
credentials. Normal app recovery and silent maintenance refresh all live conversations owned by
the actor without a per-chat consent screen.
Harness owns Ask / Do not ask defaults and exceptions. Core owns provider/tool denial; a local
invocation preference cannot restore denied access.

## Settings Catalog Discovery

`POST /api/internal/apps/{appId}/mcp/catalog/{targetId}` accepts only a target identifier. It requires
the assistant's service bearer, an active app grant belonging to a current administrator, the own-access
request permission, confirmed assistant and current installation/user access. An enabled target
relationship is not required for this pre-grant preview.
It requires no conversation and cannot invoke tools.

Core resolves the registered target endpoint and performs a bounded MCP initialize/tools-list
exchange. It pins the initialize handshake to protocol `2025-06-18`, disables HTTP redirects and
limits the exchange to 20 seconds, 20 pages and 1,000 tools. Only the tool catalog returns to Harness.
No caller-supplied upstream URL, RPC method, tool name or arguments are forwarded.

The internal discovery credential expires after 30 seconds and binds the parent grant and installation.
An administrator with the own-access request permission can preview an ungranted provider. It
revalidates current administrator authority on introspection. It has only `mcp:read`; introspection
with any tool name is inactive, and Core MCP rejects tool calls and other arbitrary RPC methods.
The ordinary `/mcp/token` request cannot select discovery mode. Interactive execution retains
conversation context, current app authority and the assistant's granted Core permissions for Core tools.

## Legacy Compatibility

Direct Core-session issuance of legacy app tokens and their same-audience renewal remain available
for existing clients. Cross-app branching through `/api/apps/{appId}/delegated-token` is refused,
including for system apps: callers use the explicitly authorized MCP-only endpoint instead.
The CLI and external scoped/OAuth credentials retain their own authorization paths; assistant grants
do not enlarge those credentials.

## Testing Expectations

- Exercise the real Core HTTP pipeline for successful issue/use and missing relationships, wrong
  service/user audience, target substitution, signature tampering and ordinary API rejection.
- Verify current user role/assignment, both reinstallations, parent logout, provider disable and
  revoke/regrant; existing global offers must not become assistant grants.
- Verify Core MCP tool permissions independently of the target relationship and legacy branch refusal.
- Verify catalog discovery never exposes its credential, permits tool invocation or creates a chat
  lease; stale parent grants and non-administrators are refused. Pre-grant preview confers no call authority.
- Verify both SDKs' explicit MCP-purpose request and assistant identity, and Harness service/user
  credential separation, target selection and refusal without fallback.
- Verify Core-managed embedded/standalone Harness discovery and calls, including revocation while a
  session is open; fake chat output alone is not proof of a completed MCP operation.

# Agent MCP Directory

Created: 2026-09-26
Updated: 2026-09-26

Core owns the host policy for MCP targets offered through Hosty assistants, the Gateway facade and
`hosty mcp`. Administrators edit it in Shell **Settings → Agents**. Runtime apps start disabled;
`hosty:core` starts enabled. Gateway auto-allow remains a separate assistant setting.

## Policy And Skill Review

`core/agent-policy.json` stores each target's offer and an approved digest per skill key. App entries
are bound to their installation timestamp. Uninstall clears the entry even when app data is retained;
a later installation of the same id starts disabled. Legacy Gateway `mcpProviders` and
`mcpSkillDigests` are not imported or accepted as writes. Administrators enable targets and approve
instructions once in Core.

The Agents tab shows every installed MCP target, interface readiness and complete packaged skill
text. Enabling tools does not approve instructions. Approval submits the displayed digest and directory
revision; stale submissions receive 409. The current single skill uses key `agent` and the first 32
lowercase hex characters of SHA-256 over trimmed UTF-8 text. A changed or unreadable skill is withheld
until reviewed; tools keep their offer state. Already delivered conversation text cannot be retracted.
Sessions receive approved instructions at session start; facade and CLI deliver them at initialize.

Reads and updates of `/api/core/agents` require an administrator session; browser writes additionally
require CSRF. Successful updates are audited as `agent.policy.updated`, with actor, target, offer and
approved digests. Offers bound what Hosty consumers list and call. They do not change user assignments,
app authorization or software outside Hosty.

## Directory Contract

The service-token endpoint `GET /api/internal/apps/{appId}/app-directory` retains its app roster and
adds `agents: { revision, targets, settingsUrl }`. Targets include identity, display name, offer state,
MCP interface keys and resolved URLs, per-service readiness, installation identity and skill digests.
It contains no credentials or skill text. A request with `?revision=<current>` receives 304 and no body.
Policy, installation, fleet metadata, URL, readiness and skill changes invalidate the revision.

The local control endpoint `GET /control/v1/agents/directory` exposes the same credentials-free
configuration behind the control secret. Admin reads additionally include the complete skill text.
Skills remain subject to the existing `apps.skills.read` permission on cross-app text reads.

## Consumers

| Consumer | Refresh | Call enforcement |
| --- | --- | --- |
| Harness sessions | Start and before each turn, with revision revalidation | Loopback proxy reads current policy, resolves current URL and mints a fresh token for each request |
| Gateway facade | Every catalog access; a revision change invalidates the per-user 30-second cache | Exact currently offered interface plus fresh on-behalf-of token |
| `hosty mcp` | Listing and background polling | Current offered interface and URL plus fresh delegated token |

Each user sees only targets for which Core issues a delegated token. Core's own switch applies on all
three surfaces. Facade and CLI retain their read-only tool filter. Gateway settings display offer
state and link to Shell; they retain provider authentication, prompt and auto-allow controls.

Disabling refuses subsequent calls even from a stale harness tool list; an in-flight request completes.
On a directory outage consumers retain their last catalog/configuration and add nothing. Calls fail
closed; a still-live token is never an offline fallback. The facade also requires online credential
introspection before answering external requests. No tool traffic is relayed through Core.

Claude reconfigures servers through the SDK between turns. Omitted startup servers require an explicit
`toggleMcpServer(false)` because the pinned SDK retains them across `setMcpServers`; only Hosty-owned
names are touched. Codex prepares a new app-server with the changed configuration and resumes the same
native thread between turns. It replaces the old idle process only after successful resume. A failed
resume keeps the old process and shows a notice; disabled targets remain blocked by the proxy. A later
turn retries the update, and a new session uses the current directory.

## Native Protocol Verification

Verified on 2026-09-26 with Codex CLI **0.155.0** and Claude Agent SDK **0.3.276**, using isolated
homes, local model responses and MCP fixtures; no provider credentials or external inference.
Reproduce with `npx tsx apps/ai-gateway/test/agent-directory-native.mts`.

- Codex completes a fixture turn, restarts, resumes the same thread with its user and assistant text,
  and discovers a replacement MCP server and its new tools.
- Claude receives `notifications/tools/list_changed` on the proxy SSE connection, issues another
  `tools/list`, and exposes the updated tool. Adding a server succeeds; explicitly disabling the
  omitted startup server removes its tools.
- Codex opens the proxy SSE connection but does not reread tools after the same notification in this
  probe. The proxy forwards the notification unchanged, but live tool-list refresh in Codex is not
  promised. A directory change causing restart/resume or a new session reloads tools. The facade
  itself sends no live notifications; external clients refresh with `tools/list` or reconnect.

A Core-managed runtime smoke check also exercised the published native CLI against demo-app:
Core-only initial listing, Core disabled, approved demo tools listed and called with a real Hosty
identity, then a stale tool call refused after disabling the app. The source Shell rendered the Agents
tab and full approved instructions through its normal sign-in flow. The disposable Core and apps were
stopped after verification.

This feature is independent of the [AHP plan](../assistant-ahp/plan.md) and the parked standalone
[MCP facade plan](../mcp-facade/plan.md).

## Testing Expectations

- Defaults, admin/CSRF boundaries, exact-digest approvals, stale revision refusal, audit and retained-data
  uninstall/reinstall behavior through the real Core HTTP pipeline.
- Credentials-free conditional discovery, per-interface readiness, Core's switch and rejection of
  legacy offer policy; revisions invalidate cached catalogs.
- Proxy current-URL forwarding, revoked offers, fresh tokens during outages and byte-preserving SSE.
- Shell full-text review submits the displayed digest; switching offers cannot approve instructions.
- Harness restart/resume keeps thread identity and approvals, with explicit fallback on failure.
- Run Core/CLI suites, Gateway tests and lint, Shell tests and production builds; repeat the native
  protocol probe when either pinned harness changes.

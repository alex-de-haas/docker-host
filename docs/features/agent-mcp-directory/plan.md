# Agent MCP Directory — Core Lists What Agents May Use

Status: Ready
Created: 2026-09-26
Updated: 2026-09-26

Part of [shared assistant development sessions](../assistant-development-sessions/plan.md).
The umbrella's common invariants apply; this feature has independent scope and requires its own Ready approval.

## Goal And Owner Direction

Owner direction, 2026-09-26: Core is the directory of the host's MCP servers and owns the decision
which of them agents may use. Agents run on the host — the direction set by
[AHP as a client interface](../assistant-ahp/plan.md) — and configure their MCP servers themselves
from that directory, calling each app directly. Core never carries tool traffic, so the
[ai-agent-bridge](../ai-agent-bridge/feature.md) boundary "normal agent traffic does not pass through
it" stands.

The single-entry facade for full external clients such as Claude Code or Codex is a separate app for
later, parked in the [MCP facade plan](../mcp-facade/plan.md). Accepting this directory is expected to
be part of the future `agent` provider contract in the
[core extension model](../core-extension-model/plan.md).

## Current Behavior

- Which apps' tools may reach agents (`mcpProviders`) and which skill texts the operator approved are
  stored in the gateway's own settings (`apps/ai-gateway/src/settings/store.ts`) and edited on its
  settings page. With several assistants, each would keep its own copy.
- Assistant sessions discover providers at session start from Core's app directory
  (`GET /api/internal/apps/{appId}/app-directory`, service token), filter them with those settings,
  obtain one delegated token per app and call each app directly through the gateway's forwarding
  proxy. The gateway facade applies the same settings.
- `hosty mcp` takes every running app that declares `mcp` and ignores those settings.

## Target Behavior

### Policy In Core

- A Core-owned host setting records, per app, whether its MCP tools are offered to agents (default
  off, as the vision requires) and which skill-text digest the operator approved. Administrators edit
  it in Shell's platform settings; every change is audited.
- The gateway's `mcpProviders` and skill approvals are not imported. The operator enables providers and
  approves skills once in Core; the gateway's own MCP-access settings page is removed.

### Directory Configuration

- The existing app directory carries, per app, whether it is offered to agents, its `mcp` interface
  declarations with resolved URLs and per-service readiness, and the approved skill digest, plus a
  directory revision that changes whenever the policy or the fleet changes.
- The configuration holds no credentials. An agent obtains a short-lived delegated token for the
  acting user and each target app when it needs one, as sessions do today, so every call stays bounded
  by what that user may reach and authorized by the app itself.
- Until app-readable Core events exist, consumers re-read the directory at session start and before
  each turn, sending the revision so an unchanged directory costs one cheap request. When a running
  session's set changes, its agent receives `notifications/tools/list_changed`. Event subscriptions
  from the core extension model can replace polling later.

### Consumers

- Assistant sessions (Harness today) and the gateway facade use the Core policy instead of their own
  settings.
- `hosty mcp` offers only enabled apps. Its skill delivery keeps the rule documented in
  [hosty-mcp-connector](../hosty-mcp-connector/feature.md).
- Consumers enforce the offer policy and their own approval rules; Core remains the authority on who
  may reach an app. A consumer that ignored the policy could still reach only what the acting user
  can reach.

## Deliverables

- [ ] Add the Core offer policy (per-app enablement, approved skill digests) with its admin API,
      Shell platform settings UI and audit.
- [ ] Extend the app directory with offer state, `mcp` declarations, readiness, approved skill digests
      and a directory revision.
- [ ] Switch assistant sessions and the gateway facade to the Core policy, refresh running sessions
      with `list_changed`, and remove the gateway's own MCP-access settings.
- [ ] Make `hosty mcp` offer only enabled apps.
- [ ] Update `feature.md` for this feature, [ai-gateway](../ai-gateway/feature.md),
      [mcp-facade](../mcp-facade/feature.md) and [hosty-mcp-connector](../hosty-mcp-connector/feature.md);
      remove this plan and regenerate the index.

Version outcome when implemented: platform minor (policy, directory fields, CLI), Shell minor for the
settings UI, and the gateway/Harness for consuming the policy.

## Open Questions

None.

## Verification

- A newly installed app with an `mcp` interface is offered to no agent until the operator enables it;
  enabling it adds its tools to a running session on the next turn through `list_changed`, and
  disabling removes them.
- Harness sessions, the gateway facade and `hosty mcp` show the same set of apps for the same user.
- A second user sees only apps they may reach; a disabled app's tools are neither listed nor callable
  through any consumer.
- The directory contains no credentials, and an unchanged revision is answered without a full
  payload.
- Uninstalling an app removes it from the directory and from running sessions on the next turn.

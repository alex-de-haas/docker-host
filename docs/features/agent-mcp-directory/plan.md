# Agent MCP Directory — Core Lists What Agents May Use

Status: Ready
Created: 2026-09-26
Updated: 2026-09-26

Part of [shared assistant development sessions](../assistant-development-sessions/plan.md).
The umbrella's common invariants apply; this feature has independent scope and requires its own Ready approval.

Revised on 2026-09-26 after review found that `tools/list_changed` cannot add or remove a server;
this revision defines refresh, enforcement and adapter behavior and was re-approved by the owner the
same day.

## Goal And Owner Direction

Owner direction, 2026-09-26: Core is the directory of the host's MCP servers and owns the decision
which of them agents may use. Agents run on the host and configure their MCP servers themselves from
that directory, calling each app directly. Core never carries tool traffic, so the
[ai-agent-bridge](../ai-agent-bridge/feature.md) boundary "normal agent traffic does not pass through
it" stands. How clients reach host-side agents is a separate question: [AHP](../assistant-ahp/plan.md)
is the candidate client interface, pending its spike, and this directory does not depend on it.

The single-entry facade for full external clients such as Claude Code or Codex is a separate app for
later, parked in the [MCP facade plan](../mcp-facade/plan.md). Accepting this directory is expected to
be part of the future `agent` provider contract in the
[core extension model](../core-extension-model/plan.md).

## Current Behavior

- Which apps' tools may reach agents (`mcpProviders`), which skill texts the operator approved
  (`mcpSkillDigests`) and which providers run without an approval card (`mcpAutoAllow`) are stored in
  the gateway's settings (`apps/ai-gateway/src/settings/store.ts`) and edited on its settings page.
- Core itself is treated differently per surface: assistant sessions list `hosty:core` as a provider
  with the same switch and approval mode as apps (auto-allow on by default), while the gateway facade
  always offers Core, independent of that switch.
- Assistant sessions discover providers from Core's app directory
  (`GET /api/internal/apps/{appId}/app-directory`, service token) and pass the harness one MCP server
  per provider, each a loopback URL on the gateway's forwarding proxy (`apps/ai-gateway/src/mcp/proxy.ts`).
  The proxy obtains a delegated token for the acting user at the moment each request goes out.
- Changing a running session's server set depends on the adapter: the Claude adapter reconfigures a
  live session (`setMcpServers`, `liveReconfigure: true`); the Codex adapter has no equivalent, and a
  change takes effect at the next session. `tools/list_changed` only reports a changed tool list of a
  server the client is already connected to; it cannot add or remove a server.
- The gateway facade builds its catalog from the same settings with a 30-second per-user cache that is
  dropped on a policy change; it refuses the streamable-HTTP GET stream, so it sends no notifications.
- `hosty mcp` takes every running app that declares `mcp` and ignores those settings.

## Target Behavior

### Policy In Core

- A Core-owned host setting records, per target, whether its MCP tools are offered to agents and,
  per app, the skill-text digest the operator approved. Approvals are keyed by app and skill, so a
  later manifest with several skills per app is an additive change. Every change is audited.
- Administrators edit it in a new host tab of Shell's settings, **Agents**, beside Access tokens and
  Shared mounts. It lists Hosty Core and every app with an `mcp` interface, each with its offer
  switch, readiness and skill status (approved, or changed with the new text to review and approve).
  A newly installed app appears there disabled.
- Targets are the installed apps with an `mcp` interface, default off as the vision requires, and
  Core itself (`hosty:core`), default on. Core's MCP is read-only and administrator-only, and every
  surface applies the same switch to it.
- Uninstalling an app removes its entry, so a reinstalled app with the same id starts disabled. A
  changed skill digest stops delivery of that skill until the operator approves the new text; the
  app's tools stay offered.
- The policy decides what is **offered** to agents through Hosty consumers. It does not revoke a
  user's own access to an app and does not bind software outside Hosty.
- Approval rules stay with the assistant: `mcpAutoAllow` remains in Harness, owned by
  [assistant approval rules](../assistant-approval-rules/plan.md). Offering a tool and running it
  without a card are separate decisions.
- The gateway's `mcpProviders` and skill approvals are not imported. The operator enables providers and
  approves skills once in Core. The gateway's settings page keeps its auto-allow switches and shows
  each target's offer state with a link to the Agents tab.
- Different targets for different assistants are outside this plan. They arrive with the
  target-scoped delegation permission of the [core extension model](../core-extension-model/plan.md),
  which Core enforces when issuing tokens and which narrows this host policy rather than replacing it.

### Directory Configuration

- The existing app directory carries, per target, whether it is offered, its `mcp` interface
  declarations with resolved URLs and per-service readiness, and the approved skill digest, plus a
  directory revision that changes whenever the policy or the fleet changes.
- The configuration holds no credentials. An agent obtains a short-lived delegated token for the
  acting user and each target when it needs one, so every call stays bounded by what that user may
  reach and authorized by the app itself.

### Refresh And Enforcement Per Consumer

| Consumer | Reads the directory | Enforces |
| --- | --- | --- |
| Harness sessions | at session start and before each turn, sending the revision | per call in the forwarding proxy |
| Gateway facade | when building a catalog; the cache is dropped when the revision changes | on list and on call |
| `hosty mcp` | when building its listing | on list and before each call |

- **Disabling** refuses new calls to that target from the consumer's next directory read; a call
  already in flight completes. For Harness this happens at the latest before the next turn, and the
  forwarding proxy refuses calls to a disabled target even when the harness still lists its tools.
- **Core unavailable**: consumers keep the last applied set for listing but never add targets from an
  unreadable directory, and every call still needs a fresh token from Core, so no call reaches an app
  while Core is down.
- **External clients of the facade** see changes on their next `tools/list` or reconnect; live
  notifications stay with the parked [MCP facade plan](../mcp-facade/plan.md).

### Changing A Running Harness Session

| Change | Claude adapter | Codex adapter |
| --- | --- | --- |
| Target enabled (server added) | `setMcpServers` before the next turn | restart the app-server between turns and resume the thread; fallback: next session with a visible notice |
| Target disabled (server removed) | `setMcpServers`; the proxy refuses calls immediately | the proxy refuses calls immediately; the tool leaves the list on restart or next session |
| URL or readiness changed | `setMcpServers` | as for an added server; the proxy resolves the current URL per call meanwhile |
| Tools of a connected app changed | the app's own `tools/list_changed` through the transparent proxy — verified below | the same — verified below |

The Codex restart path uses the adapter's existing `thread/resume` and is adopted only after the
verification deliverable below; until then the fallback applies.

## Deliverables

- [ ] Add the Core offer policy with its `hosty:core` entry and defaults, uninstall cleanup, approved
      skill digests keyed by app and skill, admin API, the Shell **Agents** settings tab and audit.
- [ ] Extend the app directory with offer state, `mcp` declarations, readiness, approved skill digests
      and a directory revision.
- [ ] Switch Harness sessions to the Core policy: per-turn refresh, per-call enforcement in the
      forwarding proxy, and server-set updates per adapter as tabled above. Keep `mcpAutoAllow`, and
      replace the gateway's offer switches with the offer state and a link to the Agents tab.
- [ ] Verify the Codex path — restart with `thread/resume` between turns keeps the conversation and
      picks up the new servers — and whether a connected app's `tools/list_changed` passes the
      forwarding proxy and reaches each harness. Record the results and use the fallbacks where they
      fail.
- [ ] Switch the gateway facade to the directory with a revision-aware catalog cache.
- [ ] Make `hosty mcp` offer only enabled targets and check the policy before each call.
- [ ] Update `feature.md` for this feature, [ai-gateway](../ai-gateway/feature.md),
      [mcp-facade](../mcp-facade/feature.md) and [hosty-mcp-connector](../hosty-mcp-connector/feature.md);
      remove this plan and regenerate the index.

Version outcome when implemented: platform minor (policy, directory fields, CLI), Shell minor for the
settings UI, and the gateway/Harness for consuming the policy.

## Open Questions

None. The Codex restart path and `tools/list_changed` delivery have defined fallbacks and are settled
by the verification deliverable.

## Verification

- A newly installed app with an `mcp` interface appears disabled in the Agents tab and is offered to no
  agent until the operator enables it there.
  Enabling it adds its tools to a running Claude session before the next turn, and to a Codex session
  by restart-and-resume or, failing that, at the next session with a notice.
- Disabling an app during a long turn lets the in-flight call finish and refuses its next call in the
  proxy, although a Codex harness may still list the tool until restart.
- With Core stopped, no consumer adds a target and no call reaches an app; after Core returns, the
  next read applies the current policy.
- Uninstalling and reinstalling an app with the same id leaves it disabled.
- Changing an app's skill text marks it changed in the Agents tab and stops its delivery until
  re-approved there, while its tools stay offered.
- `hosty:core` is on by default and follows the same switch in sessions, the facade and `hosty mcp`.
- After a refresh, Harness sessions, the facade and `hosty mcp` offer the same set for the same user;
  a second user sees only targets they may reach.
- Auto-allow settings survive the switch and still apply only to offered tools.
- The directory contains no credentials, and an unchanged revision is answered without a full payload.

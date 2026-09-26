# MCP Facade — One Remote Endpoint For The Whole Fleet

Status: On Hold
Created: 2026-08-24
Updated: 2026-09-26

The facade ships on the `hosty.ai-gateway` system app ([feature.md](feature.md)). It was built so that
full external clients with their own agents — Claude Code, Codex, VS Code — could reach the whole host
through one configuration entry.

Owner decision, 2026-09-26: agents run on the host, so the facade is no longer on the main path;
how clients reach them is a separate decision, with [AHP](../assistant-ahp/plan.md) the candidate
pending its spike. Core is the directory of MCP servers and agents configure themselves from it
([agent MCP directory](../agent-mcp-directory/plan.md)); Core never proxies tool traffic. The single-entry facade for full external clients becomes a separate
app later, one more consumer of that directory. There is no current need, so this plan is parked.
Until it resumes, the gateway facade keeps working and follows the Core policy through the directory.

## Target When Resumed

- A separate app (working name "MCP bridge") serves the single-entry endpoint for external clients.
  It reads the Core directory like any agent, calls each app directly with a delegated token for the
  acting user, and never gives a client an app-facing credential.
- It keeps the gateway facade's rules: connector-compatible tool names; read-only, fail-closed
  filtering on list **and** call; one budget per source; a failed source costs only itself; a listing
  cache that never grants anything; the per-address rate limit ahead of introspection; approved
  skills in `instructions`; and the distinct failure answers.
- Acting for a user without a browser interaction uses the on-behalf-of route today, which requires
  `role: system`. The bridge gets that ability through the delegation permission of the
  [core extension model](../core-extension-model/plan.md) instead of the system label.
- When the bridge ships, the gateway facade and Core's special case for it in
  `OAuthEndpoints.ResolveResourceAsync` are removed, and external clients re-register once.

## Deliverables

- [ ] Resume this plan with the owner and choose the bridge's app identity and first external clients.
- [ ] Build the bridge on the agent MCP directory and move the facade behavior listed above into it.
- [ ] `notifications/tools/list_changed` on fleet changes, which the gateway endpoint still refuses
      rather than half-implements.
- [ ] Live verification from a stock Claude Code over a **non-loopback** origin. The loopback half was
      proven on the gateway on 2026-08-25 (recorded in [feature.md](feature.md)); external origin, TLS
      and a proxy in the path remain unexercised for this endpoint.
- [ ] Remove the gateway facade, update `feature.md`, the ai-agent-bridge topology-4 note and decision
      log, and regenerate the index.

## Earlier Decisions (2026-08-24, owner approval in chat)

1. **On-behalf-of for Core MCP**: Core gained an on-behalf-of route and `hosty:core` as a delegation
   target, recorded in [feature.md](feature.md).
2. **`hosty mcp` stays** the answer for hosts reached locally or over SSH; the
   [agent MCP directory](../agent-mcp-directory/plan.md) makes it follow the same Core policy.
3. **Generic-surface degradation is deferred** until a real fleet approaches the connector's
   ~60–80-tool threshold; the facade ships namespaced export only.
4. **Sessions are ephemeral**: a restart drops them and clients re-initialize.

## Verification

A stock client with a single bridge entry lists tools from Core and at least two apps, calls one
read-only tool per source, sees a newly installed app's tools arrive via `list_changed`, is refused
on a non-read-only tool, and receives approved skills in `instructions` with the bridge's text first.
A second user's token shows a smaller catalog matching their app access. All of it against a
non-loopback origin.

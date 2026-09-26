# MCP Facade — One Remote Endpoint For The Whole Fleet

Status: Draft
Created: 2026-08-24
Updated: 2026-09-26

The facade ships on the `hosty.ai-gateway` system app ([feature.md](feature.md)). Owner decision,
2026-09-26: move it into Core, and let Core own the policy that decides which apps' tools reach
agents. The plan returns to Draft because the move needs its own Ready approval. Its two remaining
gateway deliverables — `notifications/tools/list_changed` and non-loopback live verification — are
carried into the Core implementation instead of being finished on the gateway.

## Why Core

Core already decides what is *allowed*: it introspects the client's credential, mints every
delegated token and bounds it by what the acting user may reach. The facade adds what is *offered*
and carries the traffic. Keeping that second half in an assistant app no longer fits:

- **The aggregation exists twice.** The CLI connector (`apps/cli/.../Mcp/ToolCatalog.cs`) and the
  gateway facade (`apps/ai-gateway/src/facade/`) each select providers, name tools, filter to
  read-only and fan out, and the gateway keeps a hand port of the connector's naming (`tool-key.ts`)
  so the two do not drift.
- **The offer policy already diverges.** Which apps' tools may reach agents (`mcpProviders`) and which
  skill texts are approved live in the gateway's settings. The facade and assistant sessions honour
  them; `hosty mcp` takes every running app that declares `mcp`. The vision makes enabling an MCP
  provider a host decision, not an app's.
- **Several assistants may be installed** ([assistant provider permissions](../assistant-provider-permissions/plan.md)).
  The host's remote MCP endpoint should not belong to one of them, and removing Harness should not
  remove remote agent access to the fleet.
- **A system-app privilege disappears.** The on-behalf-of route
  (`/api/internal/apps/{appId}/delegated-token`) exists for the facade alone: it is the one place an
  app acts as a user without that user's click. Core minting the tokens itself needs no such route.

This reverses one boundary of [ai-agent-bridge](../ai-agent-bridge/feature.md) — "normal agent
traffic does not pass through" Core — for MCP tool traffic only. Other domain actions still do not
pass through Core. Tool calls are human-paced rather than a hot path, and the limits below keep a slow
app from costing more than its own slot.

## Target Behavior

### Offer Policy In Core

- A Core-owned host setting records, per app, whether its MCP tools may be offered to agents
  (default off) and which skill-text digests the operator approved. Administrators edit it in Shell's
  platform settings; changes are audited and drop cached catalogs at once.
- Every aggregator reads it: the Core facade, `hosty mcp` and assistant sessions (Harness today).
  Assistants keep their own approval rules for tools that are not read-only; the host setting only
  decides which apps are offered.
- The gateway's `mcpProviders` and skill approvals are not imported. After the move the operator
  enables providers and approves skills once in Core.

### The Endpoint

- A streamable-HTTP MCP server on Core's origin: `initialize`, `tools/list`, `tools/call`, and
  `notifications/tools/list_changed` driven by Core's own fleet events. It lists Core's tools and the
  read-only tools of every enabled app the acting user may reach, with approved skills in
  `instructions` (the host's text first and unwrapped, app text fenced and attributed).
- Authentication is a scoped access token with Core's audience and `mcp:read`, the credential Core
  MCP already accepts. For each app call Core mints a delegated token for the acting user in
  process, bounded by `RequireAccessibleUserAsync` and audited as the on-behalf-of route is today.
  Core's own tools run in process.
- Behavior carried over from the gateway facade: connector-compatible tool names; read-only,
  fail-closed filtering on list **and** call; one budget per source across handshake and pages; a
  failed source costs only itself; a 30-second per-user listing cache that never grants anything;
  the per-address rate limit ahead of introspection; the 64 KB body limit; and the distinct failure
  answers.
- Added limits: a per-call timeout, a response size cap and per-user concurrency, so a slow or chatty
  app degrades its own tools rather than Core.
- Direct connection to Core-only MCP tools stays supported.

### One Implementation

Selection, naming, readiness per service and the read-only filter move from the CLI into a shared
.NET library used by Core and the CLI. The gateway's TypeScript facade, its catalog and naming port,
Core's special case for the gateway facade in `OAuthEndpoints.ResolveResourceAsync` and the
on-behalf-of route are removed when the Core endpoint ships.

### Transition

One PR: the Core endpoint, the policy and its Shell settings, the CLI change, and removal of the
gateway facade. External clients re-register once against Core's endpoint. This is independent of the
[Harness rename](../hosty-harness-rename/plan.md); if it ships first, the rename needs no facade
re-registration.

Version outcome when implemented: platform minor (Core endpoint, policy and CLI), Shell minor for the
policy settings, and the gateway/Harness for removing the facade and reading the Core policy.

## Deliverables

- [ ] Add the Core-owned offer policy (per-app enablement, approved skill digests) with its admin API,
      Shell settings UI, audit and cache invalidation.
- [ ] Extract the shared .NET catalog library from the CLI and use it from Core and the CLI.
- [ ] Serve the Core facade endpoint: authentication, in-process delegated tokens, Core tools,
      read-only fail-closed list and call, approved skills, carried-over and new limits, and
      `notifications/tools/list_changed` from fleet events.
- [ ] Make `hosty mcp` honour the Core policy in the shape chosen below.
- [ ] Switch assistant sessions to the Core policy; remove the gateway facade, its catalog and naming
      port, Core's gateway-facade OAuth special case and the on-behalf-of route.
- [ ] Verify from a stock Claude Code over a non-loopback origin: one entry, Core and two apps'
      tools, a read-only call per source, refusal of a non-read-only tool, `list_changed` on install,
      approved skills, and a smaller catalog for a second user.
- [ ] Update `feature.md` here, [core-mcp](../core-mcp/feature.md),
      [hosty-mcp-connector](../hosty-mcp-connector/feature.md), the boundary and decision log in
      [ai-agent-bridge](../ai-agent-bridge/feature.md) and plugin guidance; remove this plan and
      regenerate the index.

## Earlier Decisions

Still in force from 2026-08-24: generic-surface degradation waits until a real fleet approaches the
connector's ~60–80-tool threshold, and facade MCP sessions are ephemeral — a Core restart drops them
and clients re-initialize.

Superseded on 2026-09-26: on-behalf-of for Core MCP through a new Core route (Core now mints in
process), and "`hosty mcp` is unchanged by this feature" (the connector now shares the facade's
implementation and policy).

## Open Questions

- Does the facade extend `/api/mcp` or live on a separate Core path? Recommendation: a separate path,
  so clients already connected to Core-only `/api/mcp` keep their tool names and permission rules.
- Does `hosty mcp` keep aggregating with the shared library, or become a stdio bridge to Core's
  endpoint? Recommendation: a bridge, so the host has one catalog.
- Should assistant sessions later call apps through the Core facade instead of their own per-app
  path? Recommendation: not in this plan; they need non-read-only tools and approval integration.
- Which timeout, size and concurrency limits fit real app tools?

## Verification

The deliverable above names the live acceptance run. In addition: two users with different app access
see different catalogs; disabling an app in the Core policy removes its tools from the facade,
`hosty mcp` and new assistant sessions; a slow app times out without delaying other sources; a
non-read-only tool is refused on call even from a cached listing; the on-behalf-of route no longer
exists; and a host without Harness still serves the full facade.

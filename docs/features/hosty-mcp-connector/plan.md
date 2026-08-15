# Hosty MCP Connector

Status: Ready
Created: 2026-08-15
Updated: 2026-08-15

`hosty mcp`: a stdio MCP server inside the existing CLI, spawned by an agent client on the user's
machine, that presents the whole Hosty fleet as one MCP server. Rollout step 7 of the
[AI Agent Bridge](../ai-agent-bridge/plan.md), whose Step 7 section holds the session-flow design this
plan does not repeat.

## Goal

Two problems, one shape.

**A static client config cannot follow a dynamic fleet.** MCP clients fix their server list at session
start, so per-app entries go stale the moment an app is installed, removed, or renamed.

**A static config also cannot hold a credential that expires.** This stopped being theoretical on
2026-08-15: connecting Claude Code to Core MCP meant pasting a **full-role admin token in plaintext**
into `~/.claude.json`, which `claude mcp get` prints back unmasked — and app endpoints are worse still,
since a delegated token lives five minutes, so a static header is dead almost immediately
([app-mcp](../app-mcp/feature.md) records that cell of step 6 as unreachable for exactly this reason).

A connector fixes both by being a process rather than a file: it discovers on the fly and mints a
fresh token per call.

## What The Live Runs Changed

Written down because these contradict assumptions in the umbrella's design, and a reader comparing
the two should know which is current.

- **Clients namespace tools by server themselves.** A tool called `list_apps` on a server named
  `hosty` arrives as `mcp__hosty__list_apps`. The connector's own `<appKey>__<tool>` scheme therefore
  produces `mcp__hosty__<appKey>__<tool>` — long, and the app key is buried mid-name. Worth deciding
  deliberately rather than inheriting.
- **Tools are deferred behind tool search**, not loaded eagerly into the prompt. That substantially
  weakens the argument for the 60–80 tool threshold and the generic `call_app_tool` fallback: the
  flooding it guards against may not happen. The threshold should be re-derived against a real fleet
  rather than kept because it was written down.
- **The connector is the same mechanism the gateway needs.** The
  [delegated-token-exchange](../delegated-token-exchange/feature.md) has an open defect — an app-MCP
  call approved later than five minutes fails, because a paused call is bound to the connection it was
  prepared on, and re-minting configuration was *verified live not to fix it*. The fix there is a
  per-session proxy injecting a fresh token per request, which is precisely what this connector does
  for external clients. **Build the token-injecting proxy once and host it in both places** rather
  than twice.

## Deliverables

- [ ] `hosty mcp` as a stdio MCP server: `initialize`, `tools/list`, `tools/call`.
- [ ] Discovery through Core, filtered to apps declaring `mcp` that are running and visible to the
      actor; parallel `tools/list` fan-out with a per-app timeout, an unreachable app omitted rather
      than fatal.
- [ ] Namespaced re-export passing schemas and annotations (`readOnlyHint`, `destructiveHint`)
      through unchanged, so client permission policy can key off them.
- [ ] A fresh delegated token minted per call, so no credential is ever written to a client config.
- [ ] `notifications/tools/list_changed` on a fleet change, from a registry poll.
- [ ] A stopped app yields a structured `app_stopped` error for that call only; the session and the
      other apps keep working.
- [ ] Tests: discovery filtering, fan-out with one app timing out, namespacing, per-call token
      refresh, and the change notification — each with the succeeding half beside it.
- [ ] Docs: `feature.md`, umbrella step 7, index.

Version outcome: platform minor (a new CLI command).

## Decisions

All four were open until 2026-08-15; none remain.

- **Local topology first; remote is a second phase.** On the same machine the CLI has the trusted local control channel and needs no login. For a
  remote host `hosty login` contexts exist — but **no CLI command currently spends a saved context**,
  which is a known gap, so the remote topology cannot work until that is closed.
  Decision: ship local first, gate remote on that gap. It also keeps the first cut honest — local is
  the case that removes the plaintext token today, and shipping a remote path that cannot authenticate
  would be shipping a promise.

- **The CLI mints directly; it never uses the app-to-app exchange.** The CLI acts as the *user*, not as an app, so it can use the ordinary session-authenticated
  issue route and never needs the app-to-app exchange. That is a meaningful simplification — none of
  the exchange's bounds apply here.
  Decision: mint through the ordinary session-authenticated route. Routing the CLI through the
  exchange would have imported bounds designed for a different actor, for no gain.

- **One server entry per environment.** Already decided in the umbrella — one entry per context (`hosty-local`, `hosty-prod`), so
  the environment is explicit in every tool name, client policy can differ per server, and failures
  stay isolated. Restated here only because this plan is where it gets implemented.

- **No generic-fallback surface in the first cut.** See above — deferred loading may make it unnecessary, and an unnecessary fallback surface is
  worse than none because it splits the tool contract in two.
  Decision: build without it, measure against the real fleet, and add it only if the measurement asks.
  An unnecessary fallback is worse than none: it splits the tool contract in two and every consumer
  then has to handle both shapes forever.

## Verification

- Unit and integration tests as above.
- Live, and it is the point of the feature: register `hosty mcp` in a stock client, confirm the tools
  of an app appear without any token in the client config, call one, then install or stop an app and
  confirm the list changes without restarting the client.
- The negative that matters: an app the actor may not reach must not appear in `tools/list` at all —
  verified beside a permitted actor who does see it, since a connector that exports nothing would
  satisfy the refusal alone.

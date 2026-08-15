# Hosty MCP Connector

Status: In Progress
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

A connector fixes both by being a process rather than a file: it discovers on the fly and holds the
credential itself, obtaining a live token for each call rather than storing one.

## What The Live Runs Changed

Written down because these contradict assumptions in the umbrella's design, and a reader comparing
the two should know which is current.

- **Clients namespace tools by server themselves.** A tool called `list_apps` on a server named
  `hosty` arrives as `mcp__hosty__list_apps`, so `<appKey>__<tool>` yields
  `mcp__hosty__<appKey>__<tool>` — long, with the app key buried mid-name. The exact mapping is an
  open question below, not a detail: it has to be collision-free.
- **Tools are deferred behind tool search**, not loaded eagerly into the prompt. That substantially
  weakens the argument for the 60–80 tool threshold and the generic `call_app_tool` fallback: the
  flooding it guards against may not happen. The threshold should be re-derived against a real fleet
  rather than kept because it was written down.
- **The connector is the same *design* as the gateway's proxy — but not the same code.**
  [delegated-token-exchange](../delegated-token-exchange/feature.md) had an open defect: an app-MCP
  call approved later than five minutes failed, because a paused call is bound to the connection it
  was prepared on, and re-minting configuration was *verified live not to fix it*. That is now fixed
  by a per-session proxy minting a fresh token per request — precisely what this connector does for
  external clients.
  An earlier draft of this plan concluded "build the token-injecting proxy once and host it in both
  places". **Corrected 2026-08-15, before any code:** it cannot be. The gateway's proxy is
  TypeScript running in a Node app (`apps/ai-gateway/src/mcp/proxy.ts`); `hosty mcp` lives in the
  Native-AOT C# CLI. What transfers is the design and the lessons — obtain the token on the
  connector's side of the hop, cache it until a margin before expiry, keep the client's own
  credential off the wire to the app, answer a lapsed credential as a readable JSON-RPC error — not a
  line of code. The connector's effort estimate should not have been discounted for reuse that does
  not exist.

## Deliverables

- [x] **Core: a control route issuing a delegated token** for a named app on behalf of the local
      operator, mirroring the existing `identity` control route. Gated exactly as the rest of the
      channel is, and audited like the exchange, since it is another path to a data-plane credential.
- [x] `hosty mcp` as a stdio MCP server: `initialize`, `tools/list`, `tools/call`, hand-rolled per
      Decisions below.
- [x] Discovery through the existing `GET /control/v1/apps`, filtered to apps declaring `mcp` that are
      running and visible to the actor; parallel `tools/list` fan-out with a per-app timeout, an
      unreachable app omitted rather than fatal.
      **No new discovery route is needed** — verified 2026-08-15: that response already carries
      `AppSummary.Interfaces` resolved to ready-to-call URLs. Only the token route below is new.
- [x] Namespaced re-export per the mapping in Decisions, passing schemas and annotations through
      unchanged so client permission policy can key off them.
- [x] **The token is obtained by the connector, never by the client** — minted at call time and
      cached only while it is comfortably valid, re-minted otherwise, so nothing expiring is ever
      written to a client config. See "Cached, not per-call" in Decisions for why this wording
      replaced "a fresh token minted per call", which the plan asserted in three places while the
      design it borrowed from caches.
- [x] `notifications/tools/list_changed` on a fleet change, from a registry poll.
- [x] A stopped app yields a structured `app_stopped` error for that call only; the session and the
      other apps keep working.
- [x] **An enforced read-only filter, fail-closed.** External clients stay read-only until token
      scopes and an audit callback exist — an established boundary in
      [ai-agent-bridge](../ai-agent-bridge/feature.md). A mutating app tool must be refused by the
      connector, not merely labelled: `readOnlyHint` and `destructiveHint` are advisory client
      metadata, and a hostile or careless client ignores them.
- [x] **`readOnlyHint` on demo-app's MCP tools.** Not optional polish, and the reason is the
      fail-closed rule above: **nothing in this repository declares tool annotations today** — not
      demo-app, not Core MCP (checked 2026-08-15). A connector that treats a missing `readOnlyHint`
      as "not read-only" therefore exports *zero* app tools until this lands, so the two ship
      together or the feature demonstrates nothing. The reference implementation is copied as-is by
      app authors, which is the second reason it belongs there.
- [ ] **Packaging**: the Claude Code plugin bundling the connector `.mcp.json`, a Hosty skill, and
      PreToolUse hooks implementing allow-read-only / ask-writes / deny-destructive. Part of the
      umbrella's step 7 scope, so step 7 cannot be checked off without it.
- [ ] Tests: discovery filtering, fan-out with one app timing out, the tool-key mapping including
      every collision **and length** case named in Decisions, the read-only refusal, token reuse
      inside the margin against a re-mint outside it, and the change notification — each with the
      succeeding half beside it.
- [ ] Docs: `feature.md`, umbrella step 7, index.

### Blocked, and unchecked on purpose

- [ ] **Remote-host topology.** Blocked on the prerequisite below; kept here rather than in prose so
      the local boxes cannot be ticked and the feature reported complete while this is unbuilt.
- [ ] **A CLI command that spends a saved context** (owned by [access-tokens](../access-tokens/feature.md)).
      Nothing consumes `hosty login` credentials today, so remote cannot work until it does.

Version outcome: platform minor — a new CLI command **and** a new Core control route. The earlier
"CLI only" estimate was wrong for the reason recorded in Decisions. Plus `apps/demo-app` patch for
the annotations, which version independently from the platform.

## Open Questions

None. The three reopened earlier on 2026-08-15 were settled with the owner the same day and moved
into Decided below, together with a fourth the plan had never recorded.

## Decisions

### Settled 2026-08-15

- **The actor is named explicitly: `hosty mcp --user <email-or-id>`**, falling back to the named
  context's stored `user` when `--context` is given, and failing with a clear error when neither is
  present.
  Reasoning: the control secret identifies no user, yet a delegated token needs a concrete `sub` and
  role for the receiving app's access checks. This is exactly why the existing
  `/control/v1/apps/{appId}/identity` route makes its caller name a user, and following that
  precedent keeps one rule on the channel instead of two. It stays workable for a non-interactive
  server because the argument lives in the client's `.mcp.json` rather than being prompted for.
  Rejected: a silent default, which would have the connector impersonate whichever administrator it
  found first; and binding the local channel to a designated operator identity, which would give the
  control channel an identity it has never had and change every other control route with it.

- **The tool key is an escape with `default` omitted, bounded in length.** Precisely, so
  implementation has no latitude:
  1. Escape the app id: `_` → `_u`, `.` → `_d`; `a-z`, `0-9`, `-` pass through. The result contains
     only `[a-z0-9_-]`, and **cannot contain `__`**, because every `_` it produces is followed by
     `d` or `u`.
  2. Key = `<escapedAppId>` when the interface key is `default`, else
     `<escapedAppId>__<interfaceKey>`. Interface keys match `^[a-z][a-z0-9-]{0,62}$`, so they carry
     neither dots nor underscores.
  3. **If the key exceeds 32 characters, replace it with its first 23 characters, a `-`, and the
     first 8 hex of `sha256(appId + " " + interfaceKey)` (a literal space, which neither an app id nor an
     interface key may contain)** — exactly 32. Applied per app, so a
     truncated key is a pure function of *that app's own* id and interface key.
  4. Exported tool name = `<key>__<toolName>`. A tool whose name would push the total past the
     configured ceiling is omitted with a logged warning, never truncated: truncating tool names
     collides them with each other, which is worse than not offering one.
  5. **Refuse to export an app tool whose own name contains `__`**, with a logged warning rather
     than silently.
  Injective, and worth checking rather than asserting: escaped ids contain no `__`, so the first
  `__` always delimits the app segment; rule 5 is what stops `X` + tool `admin__foo` colliding with
  `X` + interface `admin` + tool `foo`. Rule 3 does not break this — the connector keeps its own
  key → (appId, interfaceKey, toolName) table to route a call back, so the exported name has to be
  *unique and stable*, not decodable, and 64 bits of app-specific digest is what carries uniqueness
  once the readable prefix is cut.
  Reasoning for omitting `default`: client tool-name limits are real and the composed name already
  carries the client's own `mcp__<server>__` prefix, so every character the connector spends is one
  the app's own tool names cannot have.
  **Rule 3 was added 2026-08-15 after review, and the plan was wrong without it.** It claimed the
  omission of `default` made ordinary ids "fit". That is true of ids like `com.haas.project-manager`
  and false in general: Core accepts an app id of up to 63 characters
  (`^[a-z0-9][a-z0-9._-]{0,62}$`), and the escape can nearly double it, so a legal app could have had
  *every* tool silently rejected by a client. A stated budget with an unbounded mapping under it is
  not a specification.
  Rejected: sanitize-plus-hash-**on-collision**, as the gateway does for *server* names. It reads
  best, but a tool's name would change when an *unrelated* app is installed, and client permission
  rules keyed on names would silently stop matching. Note this is not what rule 3 does — hashing on
  *length* depends only on the app itself, so it keeps the stability that rejecting the other option
  was about.

- **A tool that fails the read-only filter is hidden from `tools/list` and refused on call.**
  Both, not either: hiding gives the model no false affordance, and refusing anyway catches a client
  calling from a cached list. The server's `instructions` state that write tools are filtered, which
  is where the "explain why an obvious capability is missing" benefit belongs — one sentence rather
  than N tools that exist only to say no.
  **Fail-closed:** a tool without `readOnlyHint: true` counts as mutating. There is no honest
  alternative — the field is optional and advisory, so treating its absence as "read-only" would make
  the filter decorative. Its consequence is the demo-app deliverable above, and that consequence is
  the reason this is stated here rather than left to implementation.

- **Cached, not per-call.** A token is reused while it has more than a margin left before expiry and
  re-minted otherwise — the same rule `apps/ai-gateway/src/mcp/proxy.ts` follows, and the connector
  should not diverge from it without a reason.
  Recorded because the plan contradicted itself, caught in review on 2026-08-15: the goal, a
  deliverable, and the test list all said "a fresh token minted per call" while the design note
  imported from the gateway said "cache until a margin before expiry". Those are different amounts of
  control-route traffic and different credential-reuse semantics, and an implementer could not have
  satisfied both.
  Decision: cache. What the "per call" wording was actually protecting is that **no expiring
  credential is written into a client config** — a property caching keeps entirely, since the cache
  lives in the connector process and dies with it. Minting per call would add a control round trip to
  every tool call to buy a shorter reuse window on a token that is already short-lived.

- **The stdio server is hand-rolled, not built on the `ModelContextProtocol` SDK.**
  Reasoning: the CLI is Native AOT (`PublishAot`) with exactly one dependency, Spectre.Console, and
  no IL2026/IL3050 warnings — a property worth keeping and cheap to lose. The SDK Core uses
  (`ModelContextProtocol.AspNetCore`) brings `Microsoft.Extensions.AI` and DI, and its tool
  registration is reflection-based; the connector's tools are discovered at runtime, so almost none
  of what that buys applies here. The surface is three methods and one notification, and `demo-app`
  hand-rolled the server half for the same reason. The client half — calling app endpoints — is an
  HTTP POST of JSON-RPC.
  This decision had never been recorded, which is how a plan arrives at implementation with a
  dependency choice nobody made.

### Decided earlier

- **Local topology first; remote is a second phase.** On the same machine the CLI has the trusted
  local control channel and needs no login. For a remote host `hosty login` contexts exist — but
  **no CLI command currently spends a saved context**, which is a known gap, so the remote topology
  cannot work until that is closed. Re-checked 2026-08-15 and still true: `CredentialStore.Save` is
  written only by `LoginCommand`, and nothing reads a stored credential back except the delete path.
  Decision: ship local first, gate remote on that gap. It also keeps the first cut honest — local is
  the case that removes the plaintext token today, and shipping a remote path that cannot authenticate
  would be shipping a promise.

- **The CLI mints through a new control route; it never uses the app-to-app exchange.**
  The CLI acts as the *user*, not as an app, so none of the exchange's bounds apply to it — that part
  of the earlier reasoning stands.
  **Corrected 2026-08-15, before any code:** the rest of it did not. An earlier draft said the CLI
  would use "the ordinary session-authenticated route", which it cannot reach — the CLI talks to Core
  over the **control channel** (`/control/v1/...`) and holds no Core session, while
  `POST /api/apps/{appId}/delegated-token` is session-gated. The control channel's existing
  `/control/v1/apps/{appId}/identity` mints an *app identity* token, a different mechanism that app
  MCP endpoints do not accept.
  Decision (owner): add a **control route that issues a delegated token**. The channel already carries
  unconditional host-operator power, so this adds no new axis of trust — only a new *form* of
  credential on it. The alternative, giving the CLI a real Core session, would have cost the local
  topology its defining property that no login is needed.
  This is the same class of blocker the gateway hit, found the same way: by checking rather than by
  reading the design.

- **One server entry per environment.** Already decided in the umbrella — one entry per context
  (`hosty-local`, `hosty-prod`), so the environment is explicit in every tool name, client policy can
  differ per server, and failures stay isolated. Restated here only because this plan is where it
  gets implemented.

- **No generic-fallback surface in the first cut.** See above — deferred loading may make the
  tool-count threshold unnecessary.
  Decision: build without it, measure against the real fleet, and add it only if the measurement asks.
  An unnecessary fallback is worse than none: it splits the tool contract in two and every consumer
  then has to handle both shapes forever.

## Verification

- Unit and integration tests as above.
- The mapping's collision cases specifically, since "collision-free" is a claim and not an
  observation: `com.example.notes` against `com-example-notes`; an app whose id contains `_`; the
  same app's `default` and non-`default` interfaces; and an app tool literally named `admin__foo`
  beside an interface named `admin`, which is the pair rule 5 exists for.
- The length bound, with a **63-character app id** — the longest Core accepts — and one whose escape
  expands worst-case: the exported name stays inside the ceiling, two such ids differing only past
  the truncation point still map apart, and the key for a given app does not change when another app
  is installed or removed.
- Live, and it is the point of the feature: register `hosty mcp` in a stock client, confirm the tools
  of an app appear without any token in the client config, call one, then install or stop an app and
  confirm the list changes without restarting the client.
- The negative that matters: an app the actor may not reach must not appear in `tools/list` at all —
  verified beside a permitted actor who does see it, since a connector that exports nothing would
  satisfy the refusal alone. The read-only filter needs the same treatment and has a trap of its own:
  with fail-closed enforcement and no annotations anywhere, an empty `tools/list` is the *expected*
  output of a broken build and of a correct one alike. Verify it against demo-app **after** its tools
  declare `readOnlyHint`, with a deliberately mutating tool absent beside a read-only one present.

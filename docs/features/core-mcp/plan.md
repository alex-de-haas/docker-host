# Core MCP

Status: Draft
Created: 2026-08-09
Updated: 2026-08-09

Step 5 of the [AI Agent Bridge](../ai-agent-bridge/plan.md) rollout, and the start of its MCP track.
The umbrella's 2026-07-11 decisions govern this feature: Core MCP is **embedded in Core** as a route
over registry data Core already owns, it stays **control-plane only**, and it never proxies app
domain calls.

## Goal

Give agent clients typed tools for the things Core already knows — which apps exist, what state they
are in, what their logs say — instead of leaving them to guess at shell commands.

The motivating observation is concrete: on the shipped assistant, "stop Solitaire" turned into a
series of exploratory `bash` calls while the agent worked out that this was a Hosty app, that a
`hosty` CLI existed, and what its verbs were. Nothing in its context said otherwise. A typed
`list_apps` + `stop_app` pair replaces that entire detour with one call, and the same surface serves
any external MCP client (Claude Code, Codex, Claude Desktop) pointed at the host.

## Target Behavior

- Core serves MCP over Streamable HTTP at `/mcp`, in the same process, with no new service.
- Tools are **read-only in v1**. Lifecycle mutations (start/stop/restart/update) are designed here
  but land behind the approval story, not in the first cut — see Open Questions.
- Every call is authenticated and admin-gated, reusing the existing session/bearer credential paths;
  an unauthenticated call gets a JSON-RPC error, never data.
- Tool results are shaped for a model, not for a UI: small, flat, and naming apps by their reverse-
  DNS id so a follow-up call needs no disambiguation.
- The Hosty assistant reaches the same endpoint as an external client. No private path.

### Tools (v1)

| Tool | Returns | Notes |
| --- | --- | --- |
| `list_apps` | id, display name, version, runtime state, operation status, whether it is a system app | The roster the agent needs before anything else |
| `get_app` | one app's detail: endpoints, runtime profiles, declared interfaces, last error | Detail on demand keeps `list_apps` small |
| `get_host_status` | Core version, app counts by state, whether an update is available | The "is anything wrong" question in one call |
| `tail_app_logs` | the tail of one app's console output, with a line budget | Core's logs are an on-demand `docker logs` tail, not a queryable store — the tool name says so rather than promising search |

## Deliverables

- [ ] MCP endpoint embedded in Core (Streamable HTTP), registered like any other endpoint group,
      with the four read-only tools above. The transport mechanics Core's SSE endpoint already
      solved — connected-flush so proxies forward the response start, heartbeats under the ~100s
      origin timeout, and a CTS linked to `ApplicationStopping` so an open stream cannot hold
      shutdown — apply here and should be reused rather than rediscovered.
- [ ] Authorization: admin-gated, accepting the existing bearer credentials; unauthenticated and
      non-admin calls fail closed with a JSON-RPC error.
- [ ] Result shaping: bounded sizes for every tool (log line budget, app list projection), so a
      large fleet cannot flood a model's context.
- [ ] Tests: an HTTP suite over the real pipeline (initialize → `tools/list` → `tools/call` for each
      tool), the auth gate, and the bounding behavior.
- [ ] AOT verification in CI: Core's own `dotnet publish` must stay warning-free with the SDK added.
- [ ] Docs: `feature.md`, umbrella rollout step 5 checked off, index regenerated.

## Spike Outcome (2026-08-09) — the MCP C# SDK is AOT-clean; adopt it

The umbrella flagged this as the implementation risk: Core is Native AOT, and if
`ModelContextProtocol` could not survive trimming we would hand-roll the JSON-RPC surface. Tested
`ModelContextProtocol.AspNetCore` 2.1.0 on net10.0 with Core's own AOT settings
(`PublishAot`, `InvariantGlobalization`, plus `TrimMode=full`):

- **Publish: clean.** Zero `IL2xxx`/`IL3xxx` trimming or AOT warnings, zero errors, native binary
  produced (~16.6 MB for a bare web host plus the SDK; Core's own binary is ~26.8 MB today).
- **Runtime: works.** The published native binary served `initialize`, then `tools/list` returned the
  attribute-declared tool with its generated input schema, and `tools/call` executed it and returned
  the result. This is the part a publish check alone would not have caught — attribute-based tool
  discovery is exactly the kind of thing that survives compilation and then finds nothing at
  runtime, so both `list` and `call` were exercised, not just the handshake.

Technically, therefore, hand-rolling is no longer justified: it would mean owning protocol-version
negotiation, session handling, and schema generation for no benefit. **But the choice is not purely
technical — see the first open question.**

## Open Questions

- Question: Should Core take its first NuGet dependency for this?
  Answer: **Core has zero `PackageReference` entries today** — its csproj has no `ItemGroup` at all,
  and that has been load-bearing: the telemetry backend gave up AOT rather than fight SQLite,
  Windows DPAPI was rejected because it "would mean a package reference this AOT build avoids", and
  the extension model is HTTP+JSON specifically because Core takes no in-process plugins. Adopting
  `ModelContextProtocol.AspNetCore` (which itself pulls `ModelContextProtocol.Core` plus two
  `Microsoft.Extensions.*` abstractions) ends that streak. The spike says it is AOT-clean, so the
  question is not risk but precedent: the next dependency argues from this one.
  Recommendation: adopt it, because the alternative is hand-maintaining a wire protocol that is
  actively evolving (session handling, protocol-version negotiation, schema generation), and pin the
  version. **This is the decision the owner should make explicitly, not the one to infer from the
  spike passing.** If the answer is no, the fallback is unchanged and still viable: `initialize`,
  `tools/list`, `tools/call` hand-rolled on the existing source-generated JSON — roughly a few
  hundred lines, at the cost of tracking the spec ourselves.

- Question: How does an MCP POST satisfy Core's endpoint guardrails?
  Answer: two test suites enforce them. One walks the live endpoint table and fails any `/api` route
  that does not reject anonymous callers; the other scans endpoint source and requires
  `requireCsrf: true` on every session-authenticated `/api` mutation — and MCP is a POST. Bearer
  callers are already CSRF-exempt by design, so an external client with an access token is
  unaffected; a cookie-bearing browser caller would need the double-submit pair.
  Recommendation: register the route under `/api` and satisfy both guardrails as written rather than
  routing around them — an MCP endpoint that skipped the anonymous check would be the one route in
  Core that does.

- Question: Do lifecycle mutations (`start_app` / `stop_app` / `restart_app`) belong in v1?
  Answer: They are the payoff — "stop Solitaire" is a mutation — but Core MCP has no approval
  mechanism of its own, and the assistant's approval gate lives in the harness, which only pauses
  *its own* tool calls. A mutation tool called by an external MCP client would bypass the gate
  entirely.
  Recommendation: read-only in v1. Ship mutations only alongside a decision about where their
  approval lives (harness-side annotation, a Core-side confirmation token, or admin-scope-only).

- Question: Where do log queries come from — Core or the telemetry backend?
  Answer: Core owns only an on-demand `docker logs` tail per app — not stored, not searchable.
  Structured, queryable logs live in the telemetry backend, an optional app whose query API
  currently carries **no authentication** and which Core deliberately stopped proxying (the read
  proxy was removed).
  Recommendation: v1 exposes the tail Core actually has, named so it does not promise search, and
  works on a host with no telemetry installed. Reinstating a Core proxy over an unauthenticated app
  API to get search would undo a decision already made; the telemetry backend should instead declare
  its own `mcp` interface and own those tools.

- Question: How does an external client authenticate, given Core has no token scopes yet?
  Answer: Access tokens exist and carry their approver's full role; scopes do not exist. So an
  external client's token is as powerful as its owner.
  Recommendation: v1 requires an admin credential and exposes only read-only tools, which keeps the
  blast radius equal to "an admin can read their own host". Scoped tokens are a prerequisite for
  anything more, and belong to the access-tokens feature, not here.

- Question: Does the assistant get these tools automatically?
  Answer: The Claude harness can attach an MCP server; the gateway would configure it per session.
  Recommendation: wire it in a follow-up once the endpoint exists, so this feature can be verified
  with a stock external client first (the umbrella's "cheapest first milestone").

## Verification

- Unit/HTTP: `dotnet test` including a new suite driving the real endpoint through
  `initialize` → `tools/list` → `tools/call`, plus 401/403 for anonymous and non-admin callers.
- AOT: `dotnet publish -r <rid> -c Release` on Core stays warning-free.
- Live: point a stock MCP client (Claude Code) at the host's `/mcp` with an admin credential and
  confirm the tools appear and answer — the umbrella's stock-client milestone, done for real rather
  than simulated.

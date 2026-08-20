# Core MCP

Created: 2026-08-09
Updated: 2026-08-20

An embedded Model Context Protocol endpoint on Core, giving agent clients typed tools for the things
Core already knows — which apps exist, what state they are in, what their logs say — instead of
leaving them to guess at shell commands. This is step 5 of the
[AI Agent Bridge](../ai-agent-bridge/plan.md) rollout; the umbrella's 2026-07-11
[decisions](../ai-agent-bridge/feature.md#decision-log) govern it:
Core MCP is embedded in Core rather than a separate service, and it stays control-plane only — it
never performs or proxies work that belongs to a runtime app's own domain API.

## Endpoint

- Streamable HTTP at `/api/mcp`, served in the Core process by
  `ModelContextProtocol.AspNetCore`, registered alongside every other endpoint group.
- The route lives under `/api` deliberately. Core's authorization guardrails sweep the live endpoint
  table and require every `/api` route to reject an anonymous caller; putting MCP anywhere else would
  have made it the one route in Core exempt from that sweep. A test asserts the route is visible to
  the sweep, so the SDK changing how it maps endpoints cannot silently drop the coverage.
- The transport is **stateless** — the SDK's default since the `2026-07-28` protocol revision removed
  `Mcp-Session-Id`. Each POST is self-contained: no session is negotiated, no `/sse` endpoint is
  exposed, and no stream is held open. That suits read-only tools, which never need a
  server-to-client request, and it means the SSE lifetime problems Core's event stream had to solve
  (connected-flush, heartbeats, shutdown-linked cancellation) do not arise here.

## Authorization

- Admin-gated by an endpoint filter that runs before the protocol handler sees the request, so a
  non-admin never learns which apps exist. An anonymous browser-shaped POST is refused by the CSRF
  gate (403); an invalid bearer gets 401; a valid non-admin session gets 403.
- `requireCsrf: true` as on every session-authenticated `/api` mutation. Bearer credentials are
  CSRF-exempt platform-wide, so an external MCP client presenting an access token is unaffected.
- Core has no token scopes yet — an access token carries its approver's full role. Requiring an admin
  credential and shipping only read-only tools keeps the blast radius at "an admin can read their own
  host". Scoped tokens belong to [access-tokens](../access-tokens/feature.md).

## Tools

All four are read-only, and each **says so on the wire**: every tool advertises
`annotations.readOnlyHint: true`. Being read-only by design is not something a client can see, and an
agent client with an approval gate must assume an unannotated tool may mutate — which, run
unattended, means it refuses to call it at all. Hosty already holds *apps* to this bar (`hosty mcp`
will not export a tool that does not declare it), so Core declaring nothing was Core exempting itself
from its own contract.

Results are shaped for a model rather than a UI: small, flat, and naming apps by their reverse-DNS id
so a follow-up call needs no disambiguation.

| Tool | Returns |
| --- | --- |
| `list_apps` | Every installed app's id, display name, version, runtime state, operation status, system flag, and last error |
| `get_app` | One app's detail: description, selected runtime profile, resolved endpoint URLs, declared platform interfaces, last error |
| `get_host_status` | Core version and app counts — total, running, not running, and how many report an error |
| `tail_app_logs` | The tail of one app's console output, with the line budget that was used |

- **Bounded by construction.** `tail_app_logs` clamps its line count to 1–500 and echoes the budget
  it actually used, so an agent that asked for more knows it was capped rather than concluding the app
  only ever logged that much. `list_apps` projects a fixed small set of fields; everything else costs
  one `get_app`.
- **Failures come back as results, not transport errors.** An unknown app id answers with a message
  naming the id and pointing at `list_apps`; an unreadable log answers with the reason alongside the
  app id and budget. A model can act on an explanation but can only give up on a JSON-RPC error.
- `tail_app_logs` is named for what Core has: an on-demand read of container or process output, not a
  searchable store. Structured, queryable logs live in the telemetry backend — an optional app whose
  query API carries no authentication and which Core deliberately stopped proxying. It should declare
  its own `mcp` interface and own those tools rather than have Core reinstate that proxy.
- Payloads serialize through Core's source-generated JSON context, the same path as every HTTP
  response, and are returned as JSON strings inside the MCP tool result.

Lifecycle mutations are absent on purpose. They are the payoff — "stop Solitaire" is a mutation — but
Core MCP has no approval mechanism of its own, and the assistant's gate lives in its harness, which
pauses only that harness's own calls. A mutation tool here would be reachable by any external client
holding a credential, bypassing the gate entirely. Shipping one means first deciding where its
approval lives.

## Dependency And AOT

`ModelContextProtocol.AspNetCore` (pinned at 2.1.0) is **Core's first NuGet package reference**. Core
having none had been load-bearing — the telemetry backend gave up AOT rather than fight SQLite,
Windows DPAPI was rejected for needing a package, and the extension model is HTTP+JSON precisely
because Core takes no in-process plugins. The dependency was adopted deliberately: the alternative was
hand-maintaining an evolving wire protocol (session handling, version negotiation, schema generation)
for no benefit, once a spike showed the SDK publishes AOT-clean and its attribute-declared tools are
discovered and callable from a published native binary.

Because a package that is AOT-clean today can stop being so on any version bump, `npm run core:aot`
publishes Core as a native binary and fails on any trim/AOT warning outside an explicit per-file
allowlist. CI runs it on every Core change; before this, `dotnet publish` ran only in the release
workflow, so a trimming regression could sit on main until a release surfaced it. The allowlist is
empty — Core's one remaining hazard was fixed separately — so today any warning at all fails the
build.

A root `NuGet.config` pins the package source and clears inherited ones. Core having no packages made
the machine's global NuGet configuration irrelevant here; with one, a developer who has an unrelated
private feed configured gets every restore in this repository blocking on that feed's authentication,
which presents as a build that hangs for minutes with no output.

## Testing Expectations

- HTTP suite over the real pipeline: `initialize`, then `tools/list`, then `tools/call` for **every**
  tool. Listing alone is not enough — attribute-declared tools are discovered by reflection, so the
  failure worth catching is a server that initializes cleanly and then advertises nothing, or
  advertises a tool that throws when invoked.
- **Every tool advertises `readOnlyHint: true`, asserted on the wire** rather than on the attribute:
  what a client acts on is the `tools/list` payload, and an attribute that stopped mapping to it
  would leave the tools uncallable by any gated client while every other test stayed green.
- The auth gate in all three shapes it can be reached: anonymous, invalid bearer, valid non-admin.
- The log-line clamp asserted at both ends of the range through the budget the tool reports back.
- Route visibility in the live `EndpointDataSource`, so the platform-wide anonymous-caller sweep
  provably covers this route.
- `npm run core:aot` gates trim/AOT regressions; extending the allowlist in
  `scripts/check-core-aot.mjs` must stay a reviewed decision, not a reflex.
- The gate is verified in both directions, because a green run proves nothing on its own: a build that
  does warn must turn it red. That is not hypothetical — the first version passed with the allowlist
  emptied against a still-warning tree, since MSBuild skipped the compile on a warm build and the scan
  read a log containing no warnings at all. The script clears the Release intermediates for exactly
  that reason. With the allowlist now empty, re-checking the failing direction means introducing a
  deliberate warning rather than shrinking the list.
- Exercised live on 2026-08-11 against Core 0.79.0 (the published native binary, not the test host):
  handshake, `tools/list`, and every tool called with real data — `get_host_status` reported the
  actual fleet (10 apps, 10 running), `get_app` resolved a real interface URL, `tail_app_logs`
  clamped a 100000-line request to 500 and returned real output, and an unknown app id came back as
  an explanation rather than a transport error. The fail-closed direction was checked on the same
  binary: anonymous 403, forged bearer 401.
- **Verified with a stock client on 2026-08-15** (Claude Code, registered as an HTTP MCP server with
  an admin access token in an `Authorization` header): `claude mcp list` reported the server
  connected, and a session that asked which apps are installed answered from the real fleet — ten apps
  with their actual versions and system flags. The direct HTTP check above could not reach this half:
  driving the protocol with `curl` proves the server and says nothing about whether a client
  negotiates the same way.
- Two things that showed up only through a real client, and that matter for anything wiring these
  tools into a harness:
  - The client namespaces tools by server, so `list_apps` arrives as `mcp__hosty__list_apps`.
  - Tools are **deferred behind tool search** rather than loaded eagerly — the session searched for
    the tool before calling it. A consumer that assumes every MCP tool is present in the prompt from
    the first turn is assuming something this client does not do by default.
- Not covered: Codex as a client, a client carrying a Hosty skill, and any client reaching Core over
  a non-loopback origin. Tracked as unchecked items under step 6 of the
  [AI Agent Bridge](../ai-agent-bridge/plan.md) rollout rather than as prose here.

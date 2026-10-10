---
status: In Progress
created: 2026-06-09
updated: 2026-10-10
summary: Durable agent jobs and the ownership map for deferred user sessions, agent providers and workspace-based development.
components: [apps/core, apps/harness]
---

# AI Agent Bridge — Remaining Rollout

The current shared model and decision log live in [feature.md](feature.md). This document retains
the completed rollout evidence, records ownership transfers and tracks the remaining work that has
no feature folder of its own. Completed evidence is historical, not a new acceptance run.

Each independently owned feature carries its own approval and deliverables. On 2026-10-10 the owner
retained user conversations after verified isolation and app-facing agent/model providers, and
replaced the separate development bridge with workspace and Sandbox work. D9, D10 and D12 are retired
here by transfer, not marked implemented; their ownership is recorded below. D11 remains this plan's
open deliverable. Siblings grew out of this work and are tracked separately:
[delegated-token-exchange](../delegated-token-exchange/feature.md), a dependency of isolated user sessions,
and [agent-background-sessions](../agent-background-sessions/feature.md) — both since shipped. On
2026-08-24 four more were drafted against the gaps this document records:
[scoped-access-tokens](../scoped-access-tokens/feature.md) (the token scopes and audit callback of open
question 3 and the step-6 plaintext-admin-token cost), [mcp-facade](../mcp-facade/plan.md) (step-7
topology 4's deferred "mcp-hub", placed on the existing gateway system app; on 2026-09-26 the owner
parked it as a future separate app, with Core serving only the
[agent MCP directory](../agent-mcp-directory/feature.md)),
[mcp-oauth](../mcp-oauth/feature.md), and [core-mcp](../core-mcp/feature.md) mutations.

## Deliverables

- [x] D1. Document the shared concept and boundaries — [feature.md](feature.md).
- [x] D2. Token infrastructure — [access-tokens](../access-tokens/feature.md). Its first consumer was
      `hosty login`, removed 2026-08-17 when the CLI was made local-only; the Swift Shell is the
      consumer now, and the credential itself is unchanged.
- [x] D3. Manifest interface discovery metadata, no model execution. Shipped 2026-08-11 alongside step
      4: `interfaces` validated as a draft `app.0.1` extension, normalized onto the app record and
      resolved to URLs on `AppSummary` and the app-directory roster.
- [x] D4. One demo app MCP interface. Shipped 2026-08-11 — `apps/demo-app` serves `/api/mcp` and Core
      reports declared interfaces to apps: [app-mcp](../app-mcp/feature.md).
- [x] D5. Embedded Core MCP: discovery and read-only observability. Shipped 2026-08-09 —
      [core-mcp](../core-mcp/feature.md). Delegated token issuance shipped with
      [ai-gateway](../ai-gateway/feature.md) as a Core HTTP route rather than an MCP tool.
- [x] D6. Validate with stock external agent clients — no gateway code. Every cell of the matrix
      below is closed, the last two on 2026-09-06.
- [x] D7. The `hosty mcp` connector and the Claude Code plugin packaging. Shipped 2026-08-15 and
      verified live on 2026-08-16 — [hosty-mcp-connector](../hosty-mcp-connector/feature.md): the
      connector, the Core control route it mints through, and `packages/hosty-claude-plugin`. Claude
      Code connects, and a session called an app's tool with no credential in its config. Plugin
      skill loading was verified on 2026-08-20, as recorded below. The remote facade is separate
      [On Hold work](../mcp-facade/plan.md), not an unfinished part of the local connector.
- [x] D8. The operator milestone — the `hosty.ai-gateway` system app plus the Shell assistant surface.
      Shipped 2026-08-09 and verified live: [ai-gateway](../ai-gateway/feature.md).
- [ ] D11. Durable delegation and job runner, plus notifications.

Backward compatibility is preserved throughout: an app without an `mcp` interface stays an ordinary
runtime app.

## Step 6 — Stock client validation

Initial HTTP probes on 2026-08-11 established server behavior, not stock-client compatibility.
All four client/endpoint combinations below now have dated evidence; skill loading and the external
Core OAuth path have separate records because they prove different claims.

- **Claude Code → Core `/api/mcp`** (2026-08-15). Registered as an HTTP server with an admin
      access token in an `Authorization` header; `claude mcp list` reports connected and a session
      answered from the real fleet. Recorded in [core-mcp](../core-mcp/feature.md).
- **Claude Code → demo-app `/api/mcp`** (2026-08-16), **through the connector, which is the only
      way it was ever going to work**. A static header entry was not merely undone but unreachable:
      the app endpoint wants a delegated token, which lives five minutes. `hosty mcp` holds the
      credential instead, so the client config carries none at all. A session called
      `get_my_app_role` and came back with demo-app's own `host-admin-bootstrap` and its seven
      permissions — values that cannot be guessed, which is why they were the ones asked for.
      Recorded in [hosty-mcp-connector](../hosty-mcp-connector/feature.md).
- **Codex → Core `/api/mcp`** (2026-09-06). A stock `codex exec` with `-c` overrides — no
      gateway code, and the operator's own `~/.codex/config.toml` untouched — called
      `get_host_status` over HTTP with a credential scoped to `hosty:core`, and answered with Core
      `0.97.1` and 9 running, 0 stopped, 0 errored apps: values matching `hosty apps list` and the
      version `initialize` reports, which is the unguessable standard the Claude cell set. The run
      carried `approval: never`, the condition the earlier attempt died under with "user cancelled
      MCP tool call". Core's annotations were confirmed on the wire first — the five read tools
      carry `readOnlyHint: true`, the five mutating ones `destructiveHint`/`idempotentHint` and no
      read-only claim. That the annotation was the **only** cause remains unproven: the Codex CLI
      moved between the two runs as well, and no isolating experiment was made.
- **Codex → demo-app `/api/mcp`** (2026-08-20), through the connector, exactly as Claude reached
      it. A stock `codex exec` with `-c` overrides — no gateway code, and the operator's own
      `~/.codex/config.toml` untouched — called `com_dhaas_ddemo-app__get_my_app_role` and returned
      role `admin` with its seven permissions, matching what Shell's demo-app panel shows. Values
      that cannot be guessed, which is the standard the Claude cell set.
- **A Hosty skill** telling a client how to discover apps and which tools need confirmation
      (2026-08-20). `packages/hosty-claude-plugin/skills/hosty-mcp-connector`, installed as a
      user-scoped plugin, demonstrably reaches the client: asked why a running app's tool is missing
      from the connector, a headless `claude -p` answered with the connector's own fail-closed rule —
      only `readOnlyHint: true` is exported, anything else is treated as potentially mutating. Run
      **outside the repository and told not to read files**, so the source could not be the answer;
      the rule is a Hosty design choice, not general MCP knowledge. What this proves is that a loaded
      skill supplies facts the model otherwise lacks — the assumption
      [app-provided-skills](../app-provided-skills/feature.md) rests on.
- **A non-loopback origin** (2026-09-06). A stock Claude Code reached Core `/api/mcp` at the
      prod host's public origin — external ingress, TLS and Cloudflare's proxy in the path, the
      client arriving over IPv6 — and completed the whole OAuth flow with no credential in its
      config; recorded in [mcp-oauth](../mcp-oauth/feature.md). What this does **not** cover is the
      facade over such an origin, which [mcp-facade](../mcp-facade/plan.md) still owns and states.

Record what each connection proves in the corresponding feature.md as it lands.

The initial validation cost was a full-role administrator token in plaintext client configuration,
printed back by `claude mcp get`. At that baseline, scopes did not exist and the endpoint's read-only
behavior did not limit the credential's authority elsewhere. The changes below supersede that cost.

**Paid off for the app path on 2026-08-16, and for Core MCP on 2026-08-24.** The connector's entry is
`{"command":"hosty","args":["mcp","--user","…"],"env":{}}` — `claude mcp get` prints it back with
nothing to redact. The two Core MCP entries above carried admin tokens in plaintext, because Core MCP
is reached as an HTTP server rather than through the connector; the fix was the second of the two
options recorded here — [scoped-access-tokens](../scoped-access-tokens/feature.md) shipped, and a
credential with audience `hosty:core` and scope `mcp:read` is refused as a Core session everywhere
else. An
existing client config keeps working; it is an admin token until it is replaced with a scoped one.

Credential paths differ: an already-issued delegated token can validate locally until its TTL
expires; scoped-token introspection checks live Core state. The connector obtains a fresh token per
request and cannot fall back to a saved token during a Core outage. The isolated user-session plan
owns the choice and verification of revocation semantics for that new profile.

## Step 7 — The `hosty mcp` connector

The local connector and plugin are shipped; their current discovery, per-request credentials,
read-only filtering and client configuration are owned by
[Hosty MCP connector](../hosty-mcp-connector/feature.md). The original proposed context/keychain,
remote-login and tool-routing design is superseded by that feature's implementation.

Topologies retain their original numbers for references from the facade plan:

1. On the Core host: stdio plus the trusted local control channel, with an explicit `--user` actor.
2. Remote CLI login: dropped on 2026-08-17; the CLI remains local-only.
3. Remote operator: run `hosty mcp --user <actor>` on the server through SSH, with a separate client
   server entry for each host. There is no saved remote CLI context.
4. External clients needing one hosted app-MCP entry: a separate
   [MCP facade](../mcp-facade/plan.md), On Hold. Core supplies the
   [agent MCP directory](../agent-mcp-directory/feature.md), not the app-tool proxy. Clients of
   host-resident agent conversations have their own [AHP investigation](../assistant-ahp/plan.md).

## Step 9 — The user profile

D9 moved to [Isolated user agent sessions](../user-agent-sessions/plan.md), On Hold. The owner retains
direct ordinary-user conversations after verified agent isolation, with MCP authority limited to
the user's current rights. Isolation is a prerequisite, replacing the earlier optional-hardening
language. That plan owns the profile, permission/approval design, memory decision and acceptance;
the current administrator-only Harness is unchanged. See vision decision 28, dated 2026-10-10.

## Step 10 — App-to-model gateway

D10 moved to [Agent and model provider interface](../agent-provider-interface/plan.md), Draft. Apps
still need prompt-to-result calls, including JSON. The owner now describes independently provided
agents/models, multiple models per provider and an established API shape to investigate. Neither
the old `/api/ai/generate` endpoint nor a mandatory central Gateway is the selected contract.
Existing speech/assistant providers supply infrastructure, not completion of this feature.
The new plan owns protocol selection, extraction, authority and a real consuming-app integration;
see vision decision 29, dated 2026-10-10.

## Step 11 — Durable jobs and notifications

Existing [background sessions](../agent-background-sessions/feature.md) provide work after a tab
closes and waiting notifications. [PR lifecycle](../assistant-pr-lifecycle/feature.md) provides its
own persistent publication observations. Neither is a general scheduled/retryable agent runner.
D11 retains that remaining work, including any later non-interactive source-job scheduling. Such
jobs reuse registered workspaces, publication operations and Sandbox validation; they own none of
those mechanisms and do not create a second development task registry.

Some requests outlive a session: monitor until complete, scheduled summary, retryable action,
long-running import, branch/PR status tracking. Core owns durable delegation grants and revocation —
who approved, which app and action scopes, what resource scope, expiry or revoke condition, maximum
run budget, audit reference — while the job runner itself is a replaceable system app or authorized
agent client. Jobs store their delegation scope, budget, status, last observation, next check time and
audit references. Delivery is [notifications](../notifications/feature.md); the job model leaves room for it.

A job must stop or pause when its delegation expires, when app assignment is removed, when the actor's
role changes mid-flight, or when the action contract changes underneath it.

## Step 12 — Development Agent Bridge

The owner retired D12 as a separate workstream on 2026-10-10; it is superseded, not completed by this
documentation change. The source/workspace and Sandbox features now own its mechanisms:

- [Session workspaces](../assistant-session-workspaces/feature.md) and
  [PR lifecycle](../assistant-pr-lifecycle/feature.md) already own checkout/Git/publication identities
  and operations. [Workspace lifecycle controls](../workspace-lifecycle-controls/plan.md) and
  [execution authorization](../assistant-execution-authorization/plan.md) retain their pending scope.
- [App Sandbox](../app-sandbox-runtimes/plan.md) D1–D8 own worktree execution, isolated test data,
  browser validation and revision-bound results. That feature stays On Hold.
- [Development sessions](../assistant-development-sessions/plan.md) D1–D2 own integration and
  acceptance of workspace, validation and PR results. Publish, Merge and Complete remain distinct;
  a passing test never grants promotion authority.
- D11 owns any general non-interactive scheduling/retry/delegation layer that consumes those APIs.
  Reuse registered workspaces and collision/lease checks; do not invent another checkout registry.

[App authoring](../app-authoring/plan.md), [prototype workspaces](../app-prototype-workspaces/plan.md)
and [development controls](../app-development-controls/plan.md) retain their existing scopes.

## Open Questions

- Provider protocol and app/user authority decisions belong to
  [agent providers](../agent-provider-interface/plan.md). Isolated user-profile decisions belong to
  [user sessions](../user-agent-sessions/plan.md); disposable validation belongs to
  [App Sandbox](../app-sandbox-runtimes/plan.md).
- **What does the audit callback contract look like?** **Answered for the scoped-token path on
  2026-08-24**, and the answer is that no callback contract was needed: an external client presenting
  a [scoped access token](../scoped-access-tokens/feature.md) *does* pass through Core, because the
  app introspects the credential on every call, and the request names the tool being invoked. Core
  writes `auth.credential.used` for that call and for every refusal. Still open for the other two
  paths — a delegated token is validated locally inside the app, and `hosty mcp` calls apps directly,
  so neither is visible to Hosty audit today.

## Verification

Each step is verified inside the feature that implements it. The umbrella's own check, run whenever a
step lands: the cross-cutting invariants in [feature.md](feature.md#testing-expectations) still hold,
this checklist matches what shipped, and any decision the implementation revised is corrected in the
decision log rather than left to be reconstructed later.

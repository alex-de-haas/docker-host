# AI Agent Bridge — Remaining Rollout

Status: In Progress
Created: 2026-06-09
Updated: 2026-08-15

The shared model, the boundaries and the decision log live in [feature.md](feature.md) and are in
force. This document holds only what is **not built**: the rollout checklist, and the design for the
steps that have no feature folder of their own yet.

Each step is designed here and then implemented under its own plan, which is what carries the Ready
approval. Two sibling plans grew out of this work and are tracked separately rather than as steps:
[delegated-token-exchange](../delegated-token-exchange/plan.md), which step 9 cannot ship without,
and [agent-background-sessions](../agent-background-sessions/plan.md).

## Deliverables

- [x] 1. Document the shared concept and boundaries — [feature.md](feature.md).
- [x] 2. Token infrastructure, with remote CLI contexts as its first consumer —
      [access-tokens](../access-tokens/feature.md).
- [x] 3. Manifest interface discovery metadata, no model execution. Shipped 2026-08-11 alongside step
      4: `interfaces` validated as a draft `app.0.1` extension, normalized onto the app record and
      resolved to URLs on `AppSummary` and the app-directory roster.
- [x] 4. One demo app MCP interface. Shipped 2026-08-11 — `apps/demo-app` serves `/api/mcp` and Core
      reports declared interfaces to apps: [app-mcp](../app-mcp/feature.md).
- [x] 5. Embedded Core MCP: discovery and read-only observability. Shipped 2026-08-09 —
      [core-mcp](../core-mcp/feature.md). Delegated token issuance shipped with
      [ai-gateway](../ai-gateway/feature.md) as a Core HTTP route rather than an MCP tool.
- [ ] 6. Validate with stock external agent clients (Claude Code / Codex plus a Hosty skill, static
      endpoint entries) — no gateway code.
- [ ] 7. The `hosty mcp` connector and the Claude Code plugin packaging.
- [x] 8. The operator milestone — the `hosty.ai-gateway` system app plus the Shell assistant surface.
      Shipped 2026-08-09 and verified live: [ai-gateway](../ai-gateway/feature.md).
- [ ] 9. The user profile: MCP-only sessions with delegated user tokens and approval-gated writes.
- [ ] 10. Replace one app-local model integration with a discovered `/api/ai/generate`.
- [ ] 11. Durable delegation and job runner, plus notifications.
- [ ] 12. Development Agent Bridge: source checkout, PR, and an approved isolated-validation workflow.

Backward compatibility is preserved throughout: an app without an `mcp` interface stays an ordinary
runtime app.

## Step 6 — Stock client validation

Both endpoints were driven live over HTTP on 2026-08-11, which proves the servers completely and
client compatibility not at all. No stock MCP client has connected to either
([core-mcp](../core-mcp/feature.md), [app-mcp](../app-mcp/feature.md) both record this). A client that
negotiates differently — protocol revision, transport, auth header handling — is still an open
question, and it is the cheapest step remaining.

Connect Claude Code and Codex with static endpoint entries plus a Hosty skill, against both Core's
`/api/mcp` and demo-app's `/api/mcp`, and record what the connection proved in each feature.md.

One edge case is recorded for every external path, this step included: a client holding previously
issued Core tokens keeps calling an app MCP endpoint while Core is down or unreachable, because
delegated tokens validate locally until their TTL expires. The recorded escape hatch — an optional
Core token introspection or revalidation endpoint for high-risk calls — is deliberately unbuilt.

## Step 7 — The `hosty mcp` connector

MCP clients fix their server list at session start and cannot attach a newly discovered server
mid-session, so static per-app configuration cannot follow a dynamic app fleet. The answer is a
client-side aggregator: `hosty mcp`, a stdio MCP server embedded in the existing CLI and spawned by
the agent client on the user's machine — not a hosted service, nothing added to the host runtime.
While only one or two apps expose MCP, static entries are enough and this is not urgent.

```jsonc
{ "mcpServers": { "hosty": { "command": "hosty", "args": ["mcp"] } } }
```

Session flow: read host and credential from CLI context config or the keychain → discover through
Core `list_apps`, filtered to `mcp` interfaces visible to the actor and running → parallel
`tools/list` fan-out with a per-app timeout, an unreachable app omitted rather than fatal → re-export
each tool namespaced `<appKey>__<tool>`, passing schemas and annotations (`readOnlyHint`,
`destructiveHint`) through unchanged so client permission policy can key off them → poll the registry
(~30–60 s) and emit `notifications/tools/list_changed` on a change → on call, refresh the app's
short-TTL delegated token and invoke the app directly, a stopped app yielding a structured
`app_stopped` error for that call only.

Above roughly 60–80 exported tools the connector degrades to a generic surface (`list_app_tools` /
`call_app_tool`) to avoid flooding client context; the threshold and a per-app allowlist live in
connector config. Build order: generic mode → namespaced re-export →
`notifications/tools/list_changed` → remote login.

The connector's credential authenticates to Core only; per-app delegated tokens are fetched per
session and neither ever reaches model context. It needs discovery and token-exchange rights and
never operator rights — which means it wants scopes, and Core has none
([feature.md](feature.md#token-mechanics)). The same gap holds back the other recorded scoped-token
ideas: a read-only monitoring token for scripts, and per-tool agent scopes such as a token limited
to `read_tasks` plus `track_time` against a single app.

Topologies — the connector runs where the agent client runs:

1. Everything on one machine: stdio plus the trusted local control channel, no login.
2. Agent client on a user machine, Core on a server (the primary remote case): `hosty login --host`
   once; needs discovery to return external origins and TLS on token-carrying endpoints.
3. CLI only on the server: `"command": "ssh", "args": ["user@server", "hosty", "mcp"]` — stdio over
   SSH, zero new code.
4. No CLI at all (web or mobile clients): needs a remote HTTP MCP endpoint with OAuth, a future
   `mcp-hub` system app. Explicitly deferred; Core never hosts it.

Multi-environment maps one MCP server entry per CLI context (`hosty-local`, `hosty-prod`) rather than
one connector taking an environment argument, so the environment is explicit in every tool name,
client policy can differ per server, and failures stay isolated.

Packaging: a Claude Code plugin bundling the connector `.mcp.json`, a Hosty skill (how to discover
apps, which tools need confirmation) and PreToolUse hooks implementing allow-read-only / ask-writes /
deny-destructive from the tool annotations. Codex gets the same connector through `config.toml` plus
the skill; it has no hooks, so its guardrail is token scopes — the real boundary for every client.

## Step 9 — The user profile

An agent loop with no shell and no file tools, MCP-only over HTTP, on the same chat surface and
session API the operator profile already uses. Every tool call carries a Core-issued delegated token
for the acting user; enforcement is server-side, so a fully prompt-injected session still cannot
exceed what the user could do personally. Optional hardening: run the loop in a container with no host
mounts and network access limited to Core and app MCP origins — machinery Hosty already has.

**Blocked on [delegated-token-exchange](../delegated-token-exchange/plan.md).** The whole security
model is "every tool call carries a token for the acting user", and there is no way for the gateway to
obtain one for a target app today.

Each action gets a risk class — `read_only`, `draft_only`, `write_internal`, `write_external`,
`communication`, `financial`, `destructive`, `privileged_admin`. Read-only queries run when the user
has app access; drafts run automatically; internal writes are approval-gated, then allowlisted for
repeated low-risk actions under user-configured policy; external communication, financial,
destructive, privileged and identity actions always require explicit approval. Unknown tools, unknown
arguments, stale approvals and oversized results are denied or returned as structured errors. The
classes apply to both profiles: operator sessions enforce them through the harness callback, user
sessions through client approvals plus the hard boundary of token audience and app-domain checks.

Edge cases this step has to answer: the user loses app assignment between planning and execution; the
app's tool schema changes after the model proposes a call; the app returns more data than context
allows; the same request is retried and duplicates a side effect such as time tracking; the mapped
app-local user has lost access to the target resource while the Hosty identity is still valid.

Hosty-level durable agent memory is designed together with this profile
([feature.md](feature.md#decision-log)). Verification when the step ships includes that a session
exposes no shell or file tools and cannot reach endpoints outside Core and the permitted app MCP
origins.

## Step 10 — App-to-model gateway

Hosty-aware apps that need model output for app-local features (a checklist generated from a task
description) call a discovered `ai-gateway` interface rather than a provider directly — otherwise
every app duplicates provider configuration and policy and audit have nowhere to live.

`POST {AI_GATEWAY_ORIGIN}/api/ai/generate` with a Hosty-issued token. The gateway owns provider
configuration, credentials, model profiles and adapters, and can route to local runtimes or hosted
providers. Apps request **capabilities or model profiles** — `fastText`, `structuredJson`,
`longContext`, `localOnly` — never a named provider, and disable the feature cleanly when no gateway
interface is installed rather than falling back to app-local provider config. The contract stays
provider-neutral: result limits, timeouts, streaming where needed, audit metadata and per-app,
per-data-class policy, with no provider credentials or raw provider configuration exposed to apps.

Ship it by replacing one real integration, so the contract is proven against a real caller.

Edge cases: the configured provider is offline, slow, or missing a requested capability; an app sends
sensitive data to a non-local provider without a policy saying it may; a provider supports something
the neutral contract does not expose yet.

## Step 11 — Durable jobs and notifications

Some requests outlive a session: monitor until complete, scheduled summary, retryable action,
long-running import, branch/PR status tracking. Core owns durable delegation grants and revocation —
who approved, which app and action scopes, what resource scope, expiry or revoke condition, maximum
run budget, audit reference — while the job runner itself is a replaceable system app or authorized
agent client. Jobs store their delegation scope, budget, status, last observation, next check time and
audit references. Delivery is [notifications](../notifications/feature.md); the job model leaves room for it.

A job must stop or pause when its delegation expires, when app assignment is removed, when the actor's
role changes mid-flight, or when the action contract changes underneath it.

## Step 12 — Development Agent Bridge

The source-changing layer, building on [agent-bridge-workflow](../../ideas/agent-bridge-workflow.md).
In the operator profile this work is already interactive — an admin's session edits source through
existing dev-mode and source workflows with approval-gated writes — so what remains is the
**non-interactive** contract: one-shot sandboxed jobs (`codex exec`, `claude -p`) in an isolated
worktree whose only output is a branch or draft PR, never a merge and never live app data.

1. A UI client captures app id, route, runtime profile, followed feed, optional DOM target and note.
2. The agent client creates a request with authorization and audit records.
3. It resolves source metadata and a safe checkout through Core source APIs or Core MCP.
4. It produces changes on an isolated branch or PR.
5. A validation service prepares a disposable environment without touching the installed app's feed or
   lifecycle state.
6. The user reviews results produced against synthetic, copied or otherwise isolated data.
7. Promotion or merge stays a separate explicit step.

Development actions never mutate production app data or repoint an installed app's feed.

Two operator sessions, or a session and a human, modifying the same checkout concurrently is an open
edge case here.

## Open Questions

- **Should the AI Gateway expose a provider-native API or a neutral Hosty one?** A provider-native
  passthrough is useful for compatibility and leaks provider differences into every app.
  Recommendation: start with a small provider-neutral API for common app-local tasks and add
  compatibility shims only when something concrete needs one. Blocks step 10.
- **What is the disposable-runtime and data-isolation contract for validation?** Current feeds and
  source overrides are installed-app mechanisms, not disposable environments, and can affect
  production lifecycle state or data. Must be resolved before step 12 is implemented.
- **What does the audit callback contract look like?** An external client acting on an app never
  passes through Core, so the action is invisible to Hosty audit unless the app or client reports it.
  Until this exists, external clients stay read-only by scope — so this gates the write half of steps
  6 and 7.

## Verification

Each step is verified inside the feature that implements it. The umbrella's own check, run whenever a
step lands: the cross-cutting invariants in [feature.md](feature.md#testing-expectations) still hold,
this checklist matches what shipped, and any decision the implementation revised is corrected in the
decision log rather than left to be reconstructed later.

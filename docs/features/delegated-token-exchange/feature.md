# Delegated Token Exchange

Created: 2026-08-15
Updated: 2026-08-15

A system app trades the delegated token it holds for one scoped to another app, so an agent session
can call app MCP endpoints on behalf of the user currently talking to it — without Core entering the
data path, and without any app holding a credential stronger than that user.

This is what makes the [ai-gateway](../ai-gateway/feature.md) MCP provider toggle do something, and
it is the mechanism rollout step 9 of the [AI Agent Bridge](../ai-agent-bridge/plan.md) — the user
profile — depends on.

## The Exchange

`POST /api/apps/{appId}/delegated-token` takes two credentials. A **Core session** is the browser
path, unchanged. A **delegated token** is the exchange: Core reads its claims, applies the bounds
below, re-runs the same access policy the session path runs, and mints a token for the same `sub`
with `aud` = the requested app. The result is therefore never stronger than what that user could
obtain through Shell themselves.

The caller is **the presented token's audience** — not something it asserts. That is why the claims
are read without pinning an audience, unlike ordinary validation.

## Bounds

- **Only a system app may exchange.** A domain app calling another is
  [cross-app-dependencies](../cross-app-dependencies/plan.md), a different trust story nobody has
  designed. Opening this later is a decision; opening it now would have been an accident.
- **A branched token may be refreshed, never branched again.** What chaining endangers is reach
  *spreading across apps* — each hop launders it, and the premise that justifies the mechanism ("the
  caller holds proof that this user is talking to it right now") decays with every step.
- **The chain expires an hour after the human interaction it descends from**, carried in the claims
  as an origin instant rather than measured from the last hop, so the cap is absolute and not
  sliding. Extending in *time* is a separate axis from spreading across apps, which is why one rule
  does not cover both.
- **Nothing about the target's interfaces is checked.** Gating on "declares `mcp`" would be theatre:
  the access policy is the real gate, and the check would break non-MCP uses for no security gain.

Two claims carry this: `chainOrigin` (absent on a session-minted token, whose own `iat` is the
origin) and `branched` (absent rather than false, so an unexchanged payload is byte-identical to what
shipped before this feature). The SDK validator needed no change — it reads the fields it needs and
ignores the rest.

**Every attempt is audited, refusals included.** This is the one place where an app acts as a user
toward another app; a refusal is the more interesting half of that record.

### One consequence worth knowing

A branched token is only refreshable when its audience is *itself* a system app — the system-only
rule and the refresh rule meet nowhere else. A token branched to a domain app cannot be presented at
all. That is not a gap: a caller keeps app credentials fresh by **re-branching from its own token**,
never by renewing the branched one, which is exactly what the gateway does.

## How The Gateway Uses It

- The token the operator's client presents seeds the session's chain. Every message replaces it, so
  an active conversation always holds the freshest one.
- At session start the gateway discovers providers from Core, keeps the ones the operator enabled,
  and branches one token per app. Each becomes an MCP server on the harness, named after the app —
  a client namespaces tools by server, so the name is what the model reads.
- A provider that is disabled, stopped, has no resolved URL, or whose exchange is refused is simply
  absent. Offering a tool that cannot work is worse than offering nothing: the failure would surface
  mid-task as a confusing error rather than as a capability the agent never had.
- Tokens live five minutes, so they are re-minted **before** they die rather than after a call has
  failed. The gateway self-refreshes its own credential (which is what keeps its right to branch) and
  rebuilds the server list through `setMcpServers`.
- **Credentials are also re-minted at the moment an app-MCP call is approved.** The timer alone is not
  enough, and this was found only by running it: a tool call is prepared when its approval is raised,
  so an operator who thinks for longer than the TTL releases a call carrying a dead token. Observed on
  2026-08-15 — an approval held for nine minutes failed with an authorization error while the refresh
  timer had been working correctly the entire time, because refreshing helps the *next* call, not the
  paused one. A five-minute credential and a gate that waits for a human are in tension by
  construction; re-minting on release is what resolves it for the case that matters.
- Past the one-hour chain cap, self-refresh is refused and the credential is dropped. The session
  keeps its host tools and loses app MCP until the operator says anything at all — degraded, not
  broken.

Codex reports `liveReconfigure: false` and has no `setMcpServers` equivalent, so there a provider
change waits for the next session.

## Testing Expectations

- Core HTTP suite, every bound tested **as a pair** — the refusal beside the acceptance it must be
  distinguishable from. A route that refuses everything satisfies each negative alone and is
  completely broken, which is a failure mode this repository has hit more than once. The pairs:
  system caller succeeds / domain caller refused; branched token refreshes / cannot reach a third
  app; self-refresh keeps the right to branch; a chain inside the hour works / past it is refused;
  a permitted user succeeds / one who may not reach the target is refused; a live token works /
  an expired one does not.
- The session path is covered too, including that a token it mints is still branchable — otherwise
  Shell's tokens would be dead ends.
- Gateway (vitest): one server per enabled provider each with **its own** token (the audience claim
  is the point); disabled, stopped, URL-less and refused providers all absent; self-refresh asks for
  its own audience; an unreachable Core degrades to no providers rather than throwing.
- Verified live on 2026-08-15 against Core 0.80.0 and gateway 0.8.0 on a running host: the full chain
  (session token → gateway token → branched app token → a call to demo-app's MCP returning the real
  domain role), the bounds as pairs (a branched domain-app token refused onward, self-refresh
  succeeding, branching still allowed after self-refresh), and the audit trail carrying both outcomes.
  A live session reached demo-app through `mcp__com-haas-demo-app__get_my_app_role`, which the model
  found via tool search — MCP tools are deferred, not loaded eagerly.
- Two things that live run exposed and unit tests could not: an app-MCP tool raises an approval card,
  because MCP tools are not in the harness's auto-allow list; and the expiry-under-approval defect
  above.
- Not yet done: the re-mint-on-approval fix has itself not been re-verified live against a long wait.

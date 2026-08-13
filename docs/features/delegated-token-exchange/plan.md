# Delegated Token Exchange

Status: Draft
Created: 2026-08-11
Updated: 2026-08-13

Give an agent session a credential for the app MCP endpoints it is allowed to reach — without Core
entering the data path, and without any app ever holding a credential stronger than the user it acts
for.

**Decided 2026-08-11 (owner): the exchange.** The alternative — Shell minting per-target tokens from
the user's own session — was rejected because it ties the agent's reach to an open browser tab, and
leaving an agent working in the background is a wanted feature, not an accident. The cost is accepted
knowingly: this creates a genuinely new capability, a system app acting as a user toward another app,
which is what the Bounds section exists to contain.

Blocks two things that are already designed and cannot ship without it:

- the [ai-gateway](../ai-gateway/feature.md) MCP provider toggle, which today stores a decision
  nothing can execute — the gateway has no way to authenticate to `com.haas.demo-app`;
- rollout step 9 of the [AI Agent Bridge](../ai-agent-bridge/plan.md), the user profile, whose entire
  security model is "every tool call carries a Core-issued token for the acting user".

## Goal

Close the one gap between "Core knows which apps expose MCP" and "an agent can call them".

Discovery already works end to end (verified live 2026-08-11: `get_app` returns
`http://127.0.0.1:31984/api/mcp`, and demo-app validates a delegated token and applies its own
permission model). What is missing is only how a system app **obtains** a token for a target other
than itself.

## Current Behavior

`POST /api/apps/{appId}/delegated-token` authenticates with a **Core session** and nothing else
(`CoreSessionAuthorization.RequireSessionAsync`, `requireCsrf: true`). It then re-runs the full access
policy (`AppIdentityService.RequireAccessibleUserAsync`) and mints a 5-minute ECDSA token through
`DelegatedTokenService.CreateToken(appId, userId, role)`.

Shell has a session, so it can call this. The gateway cannot: it holds an app service token (scoped to
`/api/internal/*`) and the acting user's delegated token whose `aud` is the gateway itself. Neither
reaches a session-gated route.

## Target Behavior

Written as a diff against the route above.

- The same route **additionally** accepts a delegated token as its credential. Presented token must be
  well-formed, unexpired, signed by Core, and its `aud` must be an **installed** app.
- Core re-runs `RequireAccessibleUserAsync(targetAppId, claims.sub)` — the same policy the session path
  runs, not a parallel one — and mints a token for the same `sub` with `aud = targetAppId`. The result
  is therefore never stronger than what that user could obtain through Shell themselves.
- Failure modes stay distinguishable: an unknown or uninstalled `aud` is not the same answer as a user
  who may not reach the target.

### Bounds

These are the feature, not decoration — the route becomes reachable by app code rather than only by a
browser holding a human's session.

- **Only apps with `role: system` may exchange.** A domain app wanting to call another domain app is
  [cross-app-dependencies](../cross-app-dependencies/plan.md), a different feature with a different
  trust story. Restricting now is reversible; opening later is a decision, opening now is an accident.
- **No chaining to a new audience.** A token obtained *by* exchange may not be exchanged for a
  *different* audience. What chaining endangers is reach **spreading across apps** — each hop launders
  it, and the premise that justifies the mechanism ("the caller holds proof that this user is talking
  to it right now") decays with every step. Extending in *time* is a separate axis, bounded separately
  by the cap below.
  An earlier draft stated this without the audience qualifier, which contradicted the recommended
  self-refresh: refreshing means presenting an exchanged token back to this route, so an unconditional
  rule would have made the recommendation impossible to implement. Same-audience refresh is therefore
  the one permitted continuation, and it is what the exchanged token's claims must allow.
- **Nothing about the target's interfaces is checked.** Gating on "declares `mcp`" would be theatre:
  the access policy is the real gate, and an interface check would break non-MCP uses of the same
  exchange for no security gain.

## Deliverables

- [ ] Route accepts a delegated token as an alternative credential, with the session path unchanged.
- [ ] `system`-only caller bound, and the no-new-audience chaining claim plus its enforcement —
      including that a same-audience refresh is accepted while a different-audience hop is refused.
- [ ] The refresh answer chosen in Open Questions, implemented.
- [ ] Core HTTP suite: exchange succeeds for a system caller; is refused for a non-system caller, an
      expired token, a forged signature, an `aud` that is not installed, and a chained token aimed at
      a *different* audience — while a same-audience refresh of that token succeeds; a user
      who may not reach the target is refused **while** the same call for a permitted user succeeds —
      the pair matters, since a route that refuses everything looks identical to a working gate.
- [ ] Gateway consumes it: enabled providers reach the harness with a working credential, and the
      settings toggle stops storing a decision nothing executes.
- [ ] Docs: `feature.md`, the ai-gateway plan's toggle deliverable closed, index regenerated.

Version outcome: platform minor (new Core API surface), `apps/ai-gateway` minor.

## Open Questions

- Question: How does the caller keep a working credential during a long agent turn?
  Answer: This is the hard part, and the reason this needs a decision rather than an implementation.
  `McpHttpServerConfig.headers` is a static `Record<string, string>` — no per-request callback — so a
  5-minute token baked into an MCP server config expires mid-turn. Worse, the gateway only receives a
  fresh user token *when a client sends a request*; during a long turn there is nothing fresh to
  exchange, so a refresh timer has no input. Three ways out:
  1. **Self-refresh.** Let a caller exchange for its *own* audience too, so it can keep itself alive —
     the same-audience exception in Bounds above exists for exactly this, and without it the option is
     self-contradictory rather than merely risky.
     Cheap, and the revocation property survives — every issue re-runs the policy, so a downgraded
     user stops getting fresh tokens within one TTL, exactly as a browser session behaves. The cost is
     real and should be named: a compromised gateway then holds indefinite reach for every user who
     ever talked to it, where today it holds five minutes past the last interaction.
  2. **Session-scoped grant.** Core issues a longer-lived, individually revocable grant bound to the
     agent session. `AppSessionGrantStore` and the `hostyg_` prefix already exist for app identity and
     may be reusable. Strongest, and the largest.
  3. **Accept the limit.** Tokens are attached at turn start; a turn outliving the TTL loses its MCP
     servers. Cheapest and visibly broken for exactly the long diagnostic sessions this assistant is
     for.
  Recommendation: **(1) with an absolute cap** — carry the chain's origin instant in the claims and
  refuse to refresh beyond a fixed window (an hour, say) from the original human interaction. That
  bounds the compromise window without a new store, and keeps (2) available later if agent sessions
  ever need individual revocation.

- **Decided 2026-08-11:** the exchange, not Shell-minted tokens. Recorded with the reasoning because
  the rejected option is the cheaper one, and a later reader will wonder why it was passed over.
  Raised by the owner, and it belonged on the table because it removes this feature rather than
  shaping it. Shell already holds the user's Core session, so it — not the
  gateway — could mint a token per enabled provider and hand them over for the session, refreshing
  them on the SSE reconnect it already performs every TTL. The gateway would apply them through
  `setMcpServers`, which it can do.
  What that buys: **the "a system app may act as a user toward another app" capability is never
  created.** Nothing to bound to system callers, no chaining rule, no audit trail to design, no new
  Core surface reachable by app code. The entire Bounds section above becomes unnecessary.
  What it costs: **the agent's reach dies with the browser tab.** Closing the assistant panel
  deliberately does *not* stop a running harness today — that is shipped, deliberate behavior
  ([ai-gateway](../ai-gateway/feature.md)) — so a long diagnostic run left to finish would lose its
  app MCP servers mid-turn, while keeping Core MCP and the host tools it already has. It also puts
  Shell in the business of knowing which providers the gateway enabled, which is gateway state; Shell
  would have to read it back, inverting the "the gateway owns policy" split.
  Decision: the exchange. Background agent work is wanted, and of the two only the exchange survives a
  closed tab. This also settles the refresh question above in the exchange's favour, since Shell can no
  longer be the thing that refreshes.

- Question: Should the exchange be audited?
  Answer: Core already receives app-reported audit for the gateway's lifecycle and approvals, and
  issuance itself is Core-side, so it can record it without an app being trusted to self-report.
  Recommendation: yes, record actor, caller app, target app, and outcome. This is the one place where
  one app acts as a user toward another; if it is ever abused, the absence of a trail is what will
  make it unexplainable.

## Verification

- Core HTTP suite as above, both directions on every gate.
- Live: with the gateway's own token, exchange for `com.haas.demo-app` and call its `/api/mcp` —
  the same sequence already verified by hand on 2026-08-11 with an admin credential, now with the
  gateway as the caller instead of a human.
- Live negative: confirm a token obtained by exchange is refused when presented back to the exchange
  **for a different app**, that the same-audience refresh of it succeeds, and that a non-system app is
  refused outright.

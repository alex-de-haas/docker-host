# Delegated Token Exchange

Created: 2026-08-15
Updated: 2026-08-17

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
  mid-task as a confusing error rather than as a capability the agent never had. That start-of-session
  exchange is an availability probe as much as a credential: the tokens it produces seed the proxy's
  cache, so the first real call does not repeat the round trip.
- The gateway self-refreshes its own credential on a timer, which is what keeps its right to branch.
  It does **not** rebuild the harness's server list on that tick: since the proxy below, that list
  holds no expiring credential, and pushing an identical config would tear down and rebuild every
  live MCP connection for nothing.
- A provider toggle is pushed into live sessions the moment it is saved, not at the next refresh tick,
  because the settings page tells the operator it applied. A provider switched off has to stop being
  callable then — the rebuilt list drops it and the proxy discards the token cached for it, so neither
  half waits for a TTL.
- Past the one-hour chain cap, self-refresh is refused: the credential is dropped, **the harness's MCP
  servers are cleared**, the proxy registration is removed, and the refresh timer stops. Clearing
  matters — leaving the servers in place would keep dead tools on offer. The session keeps its host
  tools and regains app MCP the moment the operator says anything.

## The Per-Session Proxy

The harness never holds a delegated token. Each enabled provider is an MCP server pointing at a
loopback route on the gateway itself — `/internal/mcp/{sessionId}/{appId}` — authenticated with a
random per-session key. The gateway mints the app token as the request goes out and forwards the
call.

This exists because **MCP server headers are static for the life of a connection**. A five-minute
token baked into that config dies mid-session, and — the part that took a live run to learn — it
cannot be repaired by replacing the configuration: a call paused on an approval is bound to the
connection it was prepared on, so new configuration reaches the *next* call and never that one. An
approval gate exists so a human can think, and thinking for six minutes made the call fail. Re-minting
on release was implemented first and verified live not to work; the proxy replaces it, and that
re-mint is gone rather than kept as decoration.

Properties worth naming:

- **The key outlives the session; the token does not.** The TTL becomes a property of the hop the
  gateway makes, invisible to the harness. A token is reused while it has more than a minute left and
  re-minted otherwise, so Core stays out of the steady-state path without the credential ever going
  stale.
- **It is a transparent forwarder, not a JSON-RPC implementation.** An app may serve plain POST
  JSON-RPC (demo-app does) or full streamable HTTP with SSE and `Mcp-Session-Id`; the proxy has no
  business knowing which, so it copies the protocol headers and pipes the body rather than buffering.
- **The caller's own credential never travels onward.** The session key authorizes the hop in; what
  reaches the app is only the Core-signed token minted for it.
- **The 256-bit per-session key is the gate**, and the loopback check is a narrowing, not a wall.
  Said plainly because the opposite is the easy assumption: this app's endpoint is `public: true`, and
  Cloudflare ingress routes a public hostname straight at its port from `cloudflared` running on the
  same host — so a tunneled request presents as loopback and passes that check. What loopback does buy
  is the direct-network path to the published port. What refuses everything else is the key, which is
  random per session, compared in constant time, and gone when the session ends.
- **A lapsed chain answers as a JSON-RPC error**, not a transport failure — a sentence telling the
  model to ask the operator to send a message, which is what actually renews it. An unreachable app is
  a 502, keeping "this tool failed" distinct from "the assistant broke".
- The registration dies with the session: cancelled, failed, or shut down, the route stops minting.

## Which App Tools Run Without Asking

The harness auto-allows a fixed set of its own read-only tools (`Read`, `Grep`, `WebFetch`, …). App
tools are **not** in it, and the reason is the distinction the whole feature turns on: those built-ins
are read-only because the gateway knows what they are, while an app tool is read-only because the app
*said so* in its `readOnlyHint`.

So the operator decides, per app. Each provider carries a second control beside its enable toggle,
off by default: *run this app's read-only tools unprompted*. Turning it on is the operator vouching
for that app's declarations about itself; the annotations then select which of its tools the decision
covers. An app with the grant still gets a card for any tool it did not declare.

What this guards is not a hostile app — an installed app already runs code on the host and needs no
trickery — but an honest mislabelled annotation on a mutating tool, which would otherwise run with no
card at all. A single global switch would have been the rejected "just trust the hint" wearing a
checkbox.

Mechanically: for a trusted, enabled provider the gateway runs `initialize` then `tools/list` against
the app, following `nextCursor` to the end, and keeps the names declaring `readOnlyHint: true`. **An
unreadable list — or an unreadable later page — grants nothing**: "we do not know" and "it offers
nothing read-only" are different answers, only the second may lead to skipping a card, and a partial
grant is indistinguishable from a complete one where it is consulted.

The grant is rebuilt from scratch, never merged, on every provider-policy change and on the session's
existing refresh tick. Both matter for different reasons. The first makes withdrawing trust apply to a
running session at once rather than at the next one. The second bounds a subtler staleness: the grant
is keyed by tool *name*, and a trusted app updated mid-session can keep a name while making it
mutating — rebuilding periodically caps that window at one interval instead of at the length of the
session. It costs one listing per *trusted* app, and the tick skips the work entirely when nobody has
vouched for anything, which is the common case. The grant is also dropped when the delegation chain
lapses, and cleared on every path that leaves the session with no providers at all.

Codex reports `appMcp: false`: it gives an enabled provider **no tools at all**, not merely no live
updates. Configuring MCP servers there means writing them into Codex's own config before the thread
starts, a shape not verified against a live run — and guessing at that adapter's protocol is what has
caught this code twice already. The flag says so rather than the gateway quietly doing nothing.

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
- Auto-allow, as pairs: an enabled but unvouched-for app still raises a card, while the same call on
  the same tool runs unprompted once the operator vouches — the only difference being their decision;
  a tool the app declared nothing about stays out of the grant even for a trusted app; revoking trust
  empties the grant on the running session; and an app whose tool list cannot be read grants nothing.
  The read-only discovery is covered on its own too: only a literal `true` counts, the MCP lifecycle
  runs before the listing with the session id carried, an SSE-framed answer is understood, and an
  unreachable or wrong-shaped answer returns null rather than an empty set.
- Gateway (vitest): one server per enabled provider each with **its own** token (the audience claim
  is the point); disabled, stopped, URL-less and refused providers all absent; self-refresh asks for
  its own audience; an unreachable Core degrades to no providers rather than throwing; the harness
  config points at the proxy and contains no delegated token.
- The proxy is driven over **real sockets against a real upstream**, because what matters is
  transport-level: which credential the app actually receives and when it was minted. A mocked
  `fetch` would assert the shape of a call the harness never makes. Covered: a stale cached token is
  re-minted at request time while a live one is reused; the caller's key never reaches the app; an
  unknown session, unknown app, and wrong key are refused identically **beside a permitted call that
  succeeds** in the same test; an unregistered session stops serving; a switched-off provider's
  cached token is discarded; a lapsed chain is a JSON-RPC error; an unreachable app is a 502; SSE is
  streamed rather than buffered; the key survives a re-register, so a policy change does not drop
  connections for providers nobody touched.
- Verified live on 2026-08-15 against Core 0.80.0 and gateway 0.8.0 on a running host: the full chain
  (session token → gateway token → branched app token → a call to demo-app's MCP returning the real
  domain role), the bounds as pairs (a branched domain-app token refused onward, self-refresh
  succeeding, branching still allowed after self-refresh), and the audit trail carrying both outcomes.
  A live session reached demo-app through `mcp__com-haas-demo-app__get_my_app_role`, which the model
  found via tool search — MCP tools are deferred, not loaded eagerly.
- Two things that live run exposed and unit tests could not: an app-MCP tool raises an approval card,
  because MCP tools are not in the harness's auto-allow list; and the expiry-under-approval defect the
  proxy now answers.
- **The proxy was verified live on 2026-08-17**, on the case it exists for and nothing less. Against
  gateway 0.9.0 on a running host: the assistant called demo-app's `get_my_app_role`, the approval
  card was raised at 5s, held for 390 seconds — **96 seconds past the five-minute TTL the call would
  once have been bound to** — then released. It came back with `host-admin-bootstrap 7`, demo-app's
  own answer, and the session went idle on success.
  The value asked for was deliberately `source` plus a permission count rather than the role:
  `admin` is guessable from context and would have proved only that the model answered, not that the
  call reached the app.
  The driver reconnected its own event stream mid-hold, because the operator token authenticating it
  also lives five minutes — which is what a real client does, and skipping it would have tested a
  gentler scenario than the real one.

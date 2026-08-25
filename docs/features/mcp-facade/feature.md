# MCP Facade — One Remote Endpoint For The Whole Fleet

Created: 2026-08-24
Updated: 2026-08-25

`POST /mcp` on the `hosty.ai-gateway` app is an MCP server that is the whole host: one entry in an
external agent client's configuration yields Core's control-plane tools, every enabled app's tools,
and those apps' skills, over HTTP with no CLI or SSH anywhere on the path.

That last clause is the gap it closes. [`hosty mcp`](../hosty-mcp-connector/feature.md) already
aggregates the fleet, but it is a *process* and the CLI is local-only, so it must run on the host —
locally or over SSH. A client with neither had only Core's four read-only tools, reached directly
with an administrator token in its config.

## What Authenticates What

Three credentials, one per hop, and no hop reuses another's:

| Hop | Credential | Checked by |
| --- | --- | --- |
| client → facade | a [scoped access token](../scoped-access-tokens/feature.md) with the gateway as its audience | Core, by introspection, on every request |
| facade → Core | the gateway's own app service token | Core |
| facade → an app | a delegated token minted for **the acting user** | the app, locally |

The client's credential never reaches an app, and no app-facing credential ever reaches the client.
The facade decides what is *offered*; Core decides what is *allowed*.

### Acting for a user who never opened a browser

The delegated-token exchange could not serve this. It branches off a token the caller was already
handed, and that token descends from a person clicking something in Shell within the last hour —
right for the assistant panel, impossible for a client whose authorization is a standing credential.

So `POST /api/internal/apps/{appId}/delegated-token`
([OnBehalfOfTokenEndpoints.cs](../../../apps/core/src/Haas.Hosty.Core/OnBehalfOfTokenEndpoints.cs))
takes the credential the client presented and returns an ordinary, unbranched delegated token for a
named target. Issuing that credential *was* the user's consent; it is revocable, and it is
re-validated on every call, which is why the chain-lifetime bound does not apply and is not missed.

Four things bound it, and they are the whole safety argument:

- the caller authenticates with its **own service token**, validated against the id in the path;
- the credential's **audience must be that caller** — the same issuer-side check introspection makes,
  so a credential addressed to one app cannot be spent by another, even by another system app;
- only an installed **system app** may ask at all, the same bar the exchange sets;
- `RequireAccessibleUserAsync` bounds the result, so an app acting for a user reaches **exactly what
  that user could reach personally**.

Every attempt is audited as `auth.delegated-token.on-behalf-of`, refusals included — this is the one
place an app acts as somebody, and a refusal is the more interesting half of that record.

### Core's own tools in the same catalog

`hosty:core` is a delegation target beside the app ids, so one entry really does cover the host.
Core mints a delegated token addressed to it, and `/api/mcp` accepts one — checking the actor's role
against the directory rather than trusting the claims, because Core MCP is administrator-only and a
five-minute token outlives a demotion.

Connecting directly to `/api/mcp` remains fully supported. The gateway is a removable system app, and
a host without it must not lose agent access to Core; the facade is convenience, never a monopoly.

## The Catalog

Assembled per acting user, in parallel across sources, from the providers the operator enabled — the
same `mcpProviders` policy the assistant's own sessions use, because the question "may this app's
tools enter an agent's context" is one question, not two.

- **Read-only, fail-closed.** Only a tool declaring `annotations.readOnlyHint: true` is exported.
  Anything else — `false`, absent, a string, the hint at the wrong nesting — means "we do not know
  what this does". A filtered tool is hidden from the listing **and refused on call**: hiding alone
  would still let a client call from a list it cached.
- **Names are the connector's** ([tool-key.ts](../../../apps/ai-gateway/src/facade/tool-key.ts)), a
  deliberate port rather than a second scheme. Client permission rules are written against these
  strings, so a divergence would mean a rule that works through `hosty mcp` and silently does not
  here. The tests assert the port against the connector's own worked examples.
- **One source per declaration, not per app.** An app may declare several `mcp` interfaces, and the
  interface key is part of the exported name for anything but `default`. Discovery originally kept
  only the first URL and dropped the key, which renamed every tool of a non-default interface and
  made the extra declarations unreachable — the divergence the port exists to prevent. Policy stays
  per app: one toggle covers everything an app declares.
- **One budget per source**, spent across the handshake and every page rather than refreshed per
  page. This is the connector's own rule, and it has one because an app answering each page just
  inside a per-page ceiling would otherwise hold the fan-out for twenty times as long — and the
  fan-out is what a client waits on before it sees any tools at all.
- **Descriptions carry the app.** A model choosing between two similar tools from different apps has
  nothing else to go on, and an app's own text has no reason to carry it.
- **Visibility is Core's answer.** An app the acting user may not reach produces no token and
  therefore no tools. No access rule is re-implemented here.
- **A failed source costs that source.** An app that cannot be reached, or a page that cannot be
  read, leaves the rest of the catalog intact — the opposite policy from
  [readonly.ts](../../../apps/ai-gateway/src/mcp/readonly.ts), which produces a permission answer and
  refuses on any doubt. Both are correct for what they produce. A failure of *discovery itself* is
  bounded the same way: it costs the apps, never Core, whose endpoint is configured independently.

### The cache, and why it cannot grant anything

An assembled catalog is reused for one user for 30 seconds, and dropped at once when the operator
changes provider policy. This caches a **listing**, never an authorization: every call still
introspects the credential and still mints a fresh delegated token, so a stale catalog can offer a
name whose call then fails at Core, and can never make a refused call succeed. That exact hazard is
asserted rather than argued.

## Skills

Delivered through `initialize`'s `instructions`, as the connector does — only for apps whose tools
this client actually received, because instructions for tools a client does not have read as a
capability rather than as an absence.

Unlike the connector, the facade **honours the operator's skill approvals**. That difference is the
caller: `hosty mcp` runs on the host's control channel, where a gate would refuse someone who could
simply uninstall the app, while a facade caller is a remote user who is not that person.

The host's own text comes first and unwrapped, and app text is fenced and attributed by the shared
`composeSystemPrompt` — an app must not be able to appear above the text that describes the surface.

## The Perimeter

A per-address sliding window (60 requests per 10 seconds) runs **ahead of introspection**, and that
ordering is the whole point. This endpoint is meant to be publicly exposed, and every request
carrying a bearer costs a Core round trip *and* an audit line appended to a durable file — so
without it an unauthenticated flood of junk credentials would spend the host's disk and I/O rather
than merely being refused. The limiter is what makes a refusal cheap.

The bucket is the socket's peer address, never a header a caller supplies, so nobody may choose
their own. The residual is the one Core's device-code cap already records: behind a proxy that does
not preserve the peer address, every request shares one bucket and the per-address limit degenerates
into a global one. Widening that is an ingress decision rather than this endpoint's to make.

## Failure Answers

An external client can act on these only if they differ, so they do:

| Situation | Answer |
| --- | --- |
| no credential | `401` with `WWW-Authenticate: Bearer` |
| credential Core rejected | `401` |
| Core unreachable | `503` — nothing could be checked; the credential may be perfectly good |
| body over 64 KB | `413` — well-formed bytes, too many of them, which a client fixes differently from malformed JSON |
| too many requests | `429` with `Retry-After` |
| tool not in the catalog | JSON-RPC error naming that the surface is read-only |
| delegation refused | JSON-RPC error naming the app, so "you may not" is distinguishable from "no such tool" |
| the app's own refusal | passed through as the app's **result**, unexamined — it is what the model must read |

## Verified Live (Loopback)

2026-08-25, dev host, gateway 0.18.0. One `hosty.ai-gateway`-scoped token, one entry: the catalog
aggregated Core's four tools beside Demo App's and Telemetry's (nine in all, every description
naming its app, the host's own text first in `instructions`); `list_people` and `get_host_status`
answered real data through per-user on-behalf-of tokens; `restart_app` by its facade name was
refused as "read-only tools only" without reaching Core — while the introspection that preceded the
refusal still put the attempt in Hosty audit, tool name included. A stock `claude -p` holding
nothing but the facade entry called Demo App's `get_my_app_role` and answered
`appRole=admin source=host-admin-bootstrap permissions=7` — the same unguessable values the
connector's live cell set as the standard. Non-loopback (external origin, TLS, a proxy in the path)
remains open; the dev host runs no ingress.

## Testing Expectations

- The naming port asserted against the connector's worked examples, plus injectivity on the ids a
  naive sanitizer merges and the no-`__` invariant the boundary rests on.
- Over real sockets against a fake Core and a fake app: only read-only tools offered; the client's
  credential reaching Core and never an app; the minted token reaching the app; the app called by its
  own name for the tool.
- A filtered tool refused on call with nothing reaching the app.
- Rejected-credential (`401`) beside unreachable-Core (`503`).
- The stale-catalog hazard: a tool offered from cache whose call is still refused at Core.
- A non-default interface key reaching the exported name; Core's tools surviving a discovery
  failure; `413` distinguished from a parse error; and a flood refused *before* it becomes Core
  round trips, asserted on the call count rather than on the status alone.
- On the Core side, as pairs: a system app allowed beside an ordinary one refused; a credential
  addressed to one app refused for another system app; the acting user's access as the ceiling;
  revocation stopping the next call; and the `hosty:core` target both issuing a token and that token
  actually opening `/api/mcp`, refused for a non-administrator.

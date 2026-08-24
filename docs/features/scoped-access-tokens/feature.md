# Scoped Access Tokens — Audience-Bound Credentials For External Clients

Created: 2026-08-24
Updated: 2026-08-24

An [access token](../access-tokens/feature.md) may carry an **audience** and **scopes**. Without
them it is the credential that always existed: its approver's whole role, accepted wherever a Core
session is. With them it is refused as a Core session outright, accepted only at the one audience it
names, and validated against live state on every call through an endpoint the audience calls itself.

This is what a client's configuration file can hold. The two credentials that existed before could
not be: an unscoped access token in a config is an administrator in a config, and a delegated
identity token lives five minutes because nothing can revoke it.

## The Record, Not A Second Store

`Audience` and `Scopes` are two more nullable fields on `AuthSessionRecord`
([UserDirectoryStore.cs](../../../apps/core/src/Haas.Hosty.Core/UserDirectoryStore.cs)) — the same
choice `Kind` made, for the same reason: revocation, the sliding idle window, the logout cascade and
the credential listing already work on that record, and a parallel store would have duplicated all
four. Records written before this shipped have neither field and behave exactly as before.

**One audience per credential, never a list.** A bearer is handed whole to the party it addresses,
so a credential valid at two audiences lets the first replay it against the second as the user.
Introspection cannot tell the presenter from the subject — nothing in a bearer identifies who is
holding it — so isolation has to come from the credential naming one audience and Core enforcing it.
That is what keeps *installing app A grants A's declared reach and nothing more*
([platform vision](../hosty-platform-vision/plan.md), decision 5) true for this credential too.

## Not A Session

The refusal lives in `ResolveSessionAsync`
([CoreSessionAuthorization.cs](../../../apps/core/src/Haas.Hosty.Core/CoreSessionAuthorization.cs)):
a record with an audience is never a session, once, ahead of every route. Adding the fields to the
shared record is what makes this mandatory rather than tidy — without it, a credential minted to
read one app's read-only tools would have installed apps the moment it was issued, on every `/api`
route that existed and every one added later. A route that wants to accept a scoped credential says
so itself and checks the scope it needs.

The answer is `403 credential_scoped` naming the audience, not a bare 401. The holder knows what
they presented, so naming it is the difference between a fixable mistake and an unexplained refusal.

**One endpoint resolved sessions by hand and needed the rule restated.** `GET /api/auth/session`
([AuthEndpoints.cs](../../../apps/core/src/Haas.Hosty.Core/AuthEndpoints.cs)) does its own lookup
rather than going through `CoreSessionAuthorization`, so until this feature it answered with the
whole user record — email, display name, role — for a scoped credential. It is the first call most
clients make. The duplicated-prologue seam the 2026-08-18 review recorded is what made this possible,
and the test asserts the probe separately rather than assuming it inherits anything.

## Introspection

`POST /api/internal/apps/{appId}/token/introspect`
([TokenIntrospectionEndpoints.cs](../../../apps/core/src/Haas.Hosty.Core/TokenIntrospectionEndpoints.cs)),
authenticated by the app's own service token, answering `active` plus `sub`, `role` and `scopes`.

- **The audience check is the route's own shape.** The service token is validated against the id in
  the path, exactly as every other `/api/internal/apps/{appId}/…` route does, and the credential's
  audience is compared to *that* — never to an audience read out of the token. Enforcement sits with
  the issuer rather than in each verifier's memory, which is the shape of the hole the review
  recorded as H3 against `hosty_app_identity`.
- **One shape for every refusal.** Unknown, revoked, idled out, another app's, or a user who lost
  access all answer `active: false` with nothing else. An app that could tell them apart could probe
  for which credentials exist.
- **Access is re-checked on every call**, through `AppIdentityService.RequireAccessibleUserAsync` —
  the same gate every identity flow uses, not a second copy. A credential outlives the state it was
  minted against: an assignment is removed, a role downgraded, an app becomes a system app, and this
  is where that catches up with it.
- **Authenticated use slides the idle window**, so a credential used daily through an app does not
  idle out as unused.

### No cache, deliberately

Core and the app share a host, so this is a loopback hop against an in-memory read, and the traffic
is agent tool calls rather than a request flood. A cache would buy microseconds and sell back the one
property the design exists for: an operator who revokes a credential has revoked it, with no window
to explain. The accepted cost is that while Core is down, this credential cannot be validated — the
same envelope as delegated-token minting, and a state in which the host is already degraded.

The SDK helpers therefore distinguish *inactive* from *unreachable*, and callers owe their clients
different answers: 401 for the first, 503 for the second. Collapsing them would tell a client with a
perfectly good credential to go and get another one whenever Core happens to be restarting.

### Introspection is the audit callback

An external client acting on an app never passes through Core, which is why
[ai-agent-bridge](../ai-agent-bridge/plan.md) recorded the missing audit callback as what gates the
write half of external access. With this credential the call *does* pass through Core, once, and the
request names the tool being invoked.

`auth.credential.used` is written for every refusal, and for a success that names a tool. Protocol
round trips that name none (`initialize`, `tools/list`) are not recorded — the log would fill with
handshakes and bury the actions among them. A refusal carries no fingerprint: the value presented
was not this app's credential, so hashing it would write an identifier for something that may not
exist, or for a live credential belonging to someone else.

## Scopes

`mcp:read` — may call MCP tools that declare `annotations.readOnlyHint: true`. That is the whole
vocabulary ([AuthLifetimes.cs](../../../apps/core/src/Haas.Hosty.Core/AuthLifetimes.cs)); mutation
scopes belong to the feature that introduces mutations.

An unknown scope is **refused at issuance**, never dropped. A typo silently becoming a narrower
credential is a credential that mysteriously does not work, with nothing on screen to explain it.
Audience and scopes arrive as a pair or not at all, and an audience naming an app that is not
installed is refused while the operator is still looking at the form.

## Core MCP Accepts One

`hosty:core` is an audience beside the app ids. **The colon is load-bearing**: an app id must match
`^[a-z0-9][a-z0-9._-]{0,62}$`, which admits a plain `core` — so a bare name would have been an
audience an installed app could occupy, and the one-audience guarantee would have quietly stopped
holding for exactly the credential that reaches the control plane.

Every Core MCP tool declares `readOnlyHint: true`, so
`mcp:read` is the whole of what that surface offers, and such a credential carrying it is
accepted by the endpoint filter ([McpEndpoints.cs](../../../apps/core/src/Haas.Hosty.Core/McpEndpoints.cs))
ahead of the admin-session path — which would otherwise refuse it for not being a session.

**A scope narrows what a credential does; it never widens who may hold one.** Core MCP is an
administrator surface, so the actor behind that credential must still be a `host.admin` — checked
at issuance so an ordinary user is told why, and again on **every call**, because a role downgrade
has to reach a credential that outlives it. Without the second check the scope would have been an
escalation wearing the clothes of a restriction: any signed-in user could have minted themselves a
`hosty:core` credential and read the whole fleet through it.

This is the first credential narrower than "an administrator" that reaches Core at all, and it
retires the cost [ai-agent-bridge](../ai-agent-bridge/plan.md) step 6 recorded: connecting a stock
client no longer means a full-role admin token in plaintext in its config.

## The App Side

Both SDKs ship a helper, and neither caches:

- **TypeScript** — `@hosty-sdk/app/scoped-token`: `introspectScopedToken`, `hasScope`,
  `SCOPE_MCP_READ`. Its own entry, like `./delegated`, because an app's MCP endpoint is usually not
  a Next route and the server slice pulls in `server-only`.
- **.NET** — `HostyScopedTokenClient`, registered by `AddHostyScopedTokens`.

Both fail closed on the answer's shape: only a literal `active: true` with a subject is a grant.
Neither constructs a Core URL — they use the `HOSTY_CORE_ORIGIN` Core injects, already resolved for
the runtime the app is in, because a container reaches Core by a different address than a host
process does.

**`apps/demo-app` is the reference**, and it accepts both credentials
([route.ts](../../../apps/demo-app/src/app/api/mcp/route.ts)): the delegated token first, because it
validates locally and costs no round trip, and introspection only for a bearer that is not one. The
rest of the file never learns which arrived — the app's authorization model does not depend on it.

## Management

The Shell **Access tokens** tab gains an *Access* selector (full access, Core MCP, or any installed
app declaring an `mcp` interface) and an *Access* column that says **Full access** in words rather
than leaving a blank cell — an absent audience is the widest credential on that page, and a reader
should not have to infer that from an absence. Full access stays the default: narrowing is a
deliberate choice.

## Testing Expectations

- **The load-bearing pair**: a scoped credential refused on a Core route beside an unscoped one
  accepted. Either half alone is satisfied by a broken build — refusing everything passes the first,
  accepting everything passes the second.
- The hand-rolled `GET /api/auth/session` probe asserted separately from the shared gate.
- Introspection as pairs: right audience active beside wrong audience inactive; an unscoped
  credential inactive; a value that is not a credential answering in the same shape.
- Revocation taking effect on the very next call.
- Access re-checked per call: an assignment removed mid-life turns a credential inactive, beside an
  administrator's credential unaffected — so the refusal is shown to come from the access rule
  rather than from the credential going stale.
- Issuance refusing half a pair, an unknown scope, and an audience that is not installed.
- Core MCP accepting a `hosty:core`-scoped credential and refusing one scoped to an app.
- The scope-is-not-an-escalation pair: an ordinary user refused at issuance, and a credential issued
  to an administrator refused at use once that administrator is demoted.
- SDK helpers: the tool name reaching Core, inactive distinguished from unreachable, fail-closed on
  every answer that is not `active: true` with a subject, no cache (two calls, two round trips), and
  no invented Core origin.

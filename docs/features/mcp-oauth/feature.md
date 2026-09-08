# MCP OAuth — Automated Issuance For Scoped Tokens

Created: 2026-08-25
Updated: 2026-09-08

Core is an OAuth 2.1 authorization server, per the MCP authorization specification, so a capable
client (Claude Code, an editor) obtains and rotates [scoped access
tokens](../scoped-access-tokens/feature.md) itself instead of a person generating one and pasting it
into a config. **The manual path stays forever**: it works in every client including ones that never
learn OAuth, and both paths mint the same token records, revoked on the same page, validated by the
same introspection. OAuth replaces issuance only, nothing downstream of it.

## The Flow

1. A client finds the authorization server through RFC 9728 resource metadata, by one of two routes,
   and which one it takes depends on what it presented. A call carrying a **rejected** bearer
   credential is answered `401` with `WWW-Authenticate` naming the resource-metadata URL; Core MCP
   sets that header on the response's way out
   ([McpEndpoints.cs](../../../apps/core/src/Haas.Hosty.Core/McpEndpoints.cs)), so no `401` can forget
   it, and apps and the facade serve theirs through the SDK helpers. A call carrying **no credential
   at all** never gets that far: the CSRF gate the browser case needs refuses it first with
   `403 csrf_invalid` and no challenge. A client starting cold therefore reads the well-known
   resource-metadata path directly, which is the route the live run below took.
2. The client reads `/.well-known/oauth-authorization-server` (RFC 8414) and registers itself via
   Dynamic Client Registration (RFC 7591).
3. `GET /api/auth/oauth/authorize` validates everything — client, redirect_uri, PKCE (S256 only),
   resource, scopes — **parks the validated request server-side**, and sends the browser to Shell's
   consent page with nothing but a request id in the URL. Nothing the user consents to can be
   swapped between validation and the render. Sign-in is Shell's ordinary login continuation.
4. The consent page (`/oauth/consent`) renders Core's copy: client name, the resource's display
   name, the scopes in words, the acting user. Approval mints a one-time code; **denial is
   first-class** — the browser carries `access_denied` back to the client's own redirect_uri, an
   answer rather than an error. Core never cross-origin redirects here, so the page can show a
   failure instead of stranding the user.
5. `POST /api/auth/oauth/token` redeems the code with the PKCE verifier and answers an access token
   plus a refresh token. Refreshing **rotates**: the presented token is spent and replaced
   atomically inside the store's lock, so two racing refreshes redeem one rotation between them.
   The chain remembers its spent hashes (bounded), and a **replayed** spent token kills the whole
   grant — access tokens included. Two parties presenting one token means one of them stole it, and
   whichever refreshed first holds the live chain; without the kill, a thief who won the race would
   keep a credential while the victim was quietly locked out. Issuance also re-checks the grant
   *after* appending the access token, which closes the race with a concurrent revocation in either
   ordering: a revoke landing before the re-check is caught there, one landing after finds the
   token in its own cascade scan.

## What Comes Out

The access token is an ordinary scoped access token — `Kind: oauth` on the same session record,
audience-bound, introspected per call — with one difference: a **one-hour absolute expiry**
(conventional; introspection already revokes instantly, so the short TTL buys nothing but
spec-shaped client behavior). Every other `/api` surface refuses it exactly as it refuses a manually
minted scoped credential.

The **grant** (the refresh chain) is the durable thing, in
[OAuthStore.cs](../../../apps/core/src/Haas.Hosty.Core/OAuthStore.cs) with the refresh token stored
as a SHA-256 hash, the way invitation tokens already are. Its lifetime rides the access-token idle
budget the operator already tunes, refreshed on every rotation.

## Resource Indicators Are The Audience Rule

The client names the MCP endpoint it wants a token for (RFC 8707), and Core resolves that URL to
exactly one audience: its own `/api/mcp` → `hosty:core` (consent then requires an administrator,
the same bar manual issuance sets), an app's declared `mcp` interface URL → that app, or the `/mcp`
facade of an app declaring the `ai-gateway` interface → that app. **A request without a resource,
or naming anything else, is refused — never defaulted to something broad.** A resource repeated at
code redemption must be the one consent was given for. App and facade audiences accept only
`mcp:read`. Core accepts `mcp:read`, optionally with `mcp:lifecycle` and/or `mcp:update`;
all combinations require read. Unknown scopes and control scopes on other resources are refused.

The AS metadata advertises all three scopes; Core's protected-resource metadata advertises only
read. An omitted authorization scope defaults to read. Consent requires a browser session and CSRF;
Core consent also requires an administrator. Read is required, while requested lifecycle/update
permissions initially appear unchecked. The decision endpoint validates the selected subset against
the parked request and stores only approved scopes in the code, grant and access token. OAuth never
issues a full-role credential.

Refresh validates an explicitly supplied scope before rotating: it must be a nonempty valid subset
of the approved grant, including read. Invalid/unknown/wider scopes return `invalid_scope` without
consuming the refresh token. An omitted scope issues the grant's approved set. A narrower refresh
limits that access token only; it does not edit the grant or the replacement refresh token's authority.
The token response reports the access token's actual scopes.

## Registration Is Behind A Breaker

DCR is an anonymous write, so it exists only while the operator has deliberately turned it on:
**"OAuth client registration" in Core settings, off by default**, live-editable from the platform
panel and backed by `HOSTY_OAUTH_DCR_ENABLED`. Turning it off closes the door without touching what
walked through it — registered clients and issued grants keep working. While on, a per-source
sliding window (5 per 10 minutes, a DI singleton rather than a static so its state belongs to one
application instance) bounds the flood the toggle would otherwise admit.

**The AS metadata says so.** `registration_endpoint` is optional in RFC 8414, and the document omits
it entirely while the breaker is off — read live per request, so it appears and disappears with the
toggle in the same process. A client that reads an endpoint it cannot use spends the flow finding
that out from a `403`; a client that reads no endpoint falls back to the manual token path, which is
the answer that was true all along. Nothing already registered depends on the field: registration is
a one-time step, and the endpoints that carry a registered client through the flow stay advertised.

Both well-known documents answer `Cache-Control: no-store`, because a live read is only as live as
the copy the client holds: each is rendered from settings an operator edits (the breaker, and the
public origin they are built from), so a document stored by a client or by a proxy in the path is a
copy of a decision that has since changed. Discovery runs once per connection, so the re-fetch costs
nothing worth trading the correctness for.

Public clients only: no secret is issued (`token_endpoint_auth_method: none`), PKCE is what binds a
code to the client that requested it. Redirect URIs must be https or loopback-http — a routable
http URI would carry the code in clear. Registered clients are listed for administrators
(`GET /api/auth/oauth/clients`, rendered on the tokens Settings tab) with name, registration
source address, and live-grant count.

## One Page Revokes It All

The [credentials page](../access-tokens/feature.md#management-surface) groups grants by exact client id,
with a stable fingerprint and an optional operator label per grant. Each new authorization creates
a separate grant; refreshing keeps the same row. Existing grants remain valid until explicitly
revoked or expired. There is no automatic matching, replacement or permission editor.

The credentials page lists each grant as **one row** — not the hourly access
tokens it issues, which would bury the durable credentials in churn. Revoking the row kills the
refresh chain and every access token it issued (each found by its `GrantId` and its event stream
closed): the client's next call fails and its next refresh fails too. The hourly tokens are
otherwise left to expire.

## Removing A Client

`DELETE /api/auth/oauth/clients/{clientId}` requires an administrator browser session and CSRF.
Shell confirms the exact registration and its affected grant references. One atomic OAuth-store
write tombstones the client and revokes all its grants, followed by session revocation and stream
closure. The active registration list hides tombstones. Same-name registrations are unaffected.
Authorize, consent, code redemption and refresh reject a deleted registration; grant creation and
rotation recheck under the store lock, and issuance rechecks after appending a session.

Success means the cascade completed. If cleanup fails after the OAuth write, the endpoint returns
`503 oauth_cleanup_incomplete`: new issuance is blocked, but existing access tokens can remain
usable until retry, successful restart recovery or their one-hour expiry. Expiry does not close an
already-open stream. Repeating deletion reruns the cascade, including stream closure. A synchronous
startup sweep finishes revoked/deleted grant cascades in one user-directory update before HTTP starts;
failure aborts startup.
Registration with no live grants can still have pending authorization. Deletion is not a software
ban: with DCR enabled the client can register a new id and seek fresh consent.

## The Perimeter Caveat

The authorization server must be reachable from the user's browser and the client, so the remote
scenario needs a public origin for Core — and metadata uses `EffectiveCorePublicOrigin` throughout,
because a loopback URL in that document would send both to the wrong machine. The manual path has no
such dependency, which is one more reason it is permanent. Apps refuse to build resource metadata
without a public identity (null, not a guess): no metadata simply means the manual path.

## Verified Live

2026-09-06, against the prod host over its public origin: the perimeter the caveat above describes,
with Cloudflare's proxy and TLS in the path and the client arriving over IPv6. A stock Claude Code
whose config entry carried **no credential** registered itself through DCR, sent its operator to the
consent page, redeemed a token and called a tool. Revoking the grant's one row then stopped the next
call **inside the same live session** — the property introspection-per-call buys over a token
validated locally until its TTL runs out.

## Testing Expectations

- The whole flow over the real pipeline: register → authorize → consent → redeem → the token
  working on the surface it names and refused as a Core session — then rotation and the one-row
  revocation stopping both the live access token and the next refresh.
- The theft signal: a replayed spent refresh token killing the whole chain, including the winner's
  access token and its refresh — asserted from the victim's and the thief's side both.
- The breaker: registration refused off, working on, refused again when turned back off — with
  already-issued credentials untouched; and the AS metadata's `registration_endpoint` absent, then
  present, then absent again across those same states, with both documents answering `no-store`.
- PKCE pairs: wrong verifier refused; a code dying on first presentation, valid or not.
- Resource pairs: absent and unknown refused via redirect; an app resource minting a token active at
  that app's introspection and refused at Core MCP.
- Consent bars: a non-administrator refused for `hosty:core` at the decision; denial reaching the
  client as `access_denied`.
- Discovery: both metadata documents, and the 401 challenge naming the resource-metadata URL.
- An unregistered redirect_uri answered 400 in place — never a redirect to an unvalidated URI.
- SDK helpers: the RFC 9728 metadata-URL derivation, and refusal to guess when either URL is
  missing.

- Selectable consent cannot add unrequested scopes; refresh subset validation runs before rotation
  and preserves grant authority. AS scope catalog and read-only PRM are distinct.
- Client deletion isolates exact ids, invalidates pending codes/consent, races safely with code
  redemption and refresh, and closes associated streams. Recovery failure prevents startup;
  repeated recovery completes after storage recovers.

# MCP OAuth — Automated Issuance For Scoped Tokens

Created: 2026-08-25
Updated: 2026-08-25

Core is an OAuth 2.1 authorization server, per the MCP authorization specification, so a capable
client (Claude Code, an editor) obtains and rotates [scoped access
tokens](../scoped-access-tokens/feature.md) itself instead of a person generating one and pasting it
into a config. **The manual path stays forever**: it works in every client including ones that never
learn OAuth, and both paths mint the same token records, revoked on the same page, validated by the
same introspection. OAuth replaces issuance only, nothing downstream of it.

## The Flow

1. A client calls an MCP endpoint without a token and gets `401` with `WWW-Authenticate` pointing at
   RFC 9728 resource metadata naming Core as the authorization server. Core MCP sets the header on
   the response's way out ([McpEndpoints.cs](../../../apps/core/src/Haas.Hosty.Core/McpEndpoints.cs)),
   so no refusal path can forget it; apps and the facade serve theirs through the SDK helpers.
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
the token endpoint must be the one consent was given for. This feature issues `mcp:read` only;
requesting more is `invalid_scope`.

## Registration Is Behind A Breaker

DCR is an anonymous write, so it exists only while the operator has deliberately turned it on:
**"OAuth client registration" in Core settings, off by default**, live-editable from the platform
panel and backed by `HOSTY_OAUTH_DCR_ENABLED`. Turning it off closes the door without touching what
walked through it — registered clients and issued grants keep working. While on, a per-source
sliding window (5 per 10 minutes, a DI singleton rather than a static so its state belongs to one
application instance) bounds the flood the toggle would otherwise admit.

Public clients only: no secret is issued (`token_endpoint_auth_method: none`), PKCE is what binds a
code to the client that requested it. Redirect URIs must be https or loopback-http — a routable
http URI would carry the code in clear. Registered clients are listed for administrators
(`GET /api/auth/oauth/clients`, rendered on the tokens Settings tab) with name, registration
source address, and live-grant count.

## One Page Revokes It All

The credentials page lists each grant as **one row named for the client** — not the hourly access
tokens it issues, which would bury the durable credentials in churn. Revoking the row kills the
refresh chain and every access token it issued (each found by its `GrantId` and its event stream
closed): the client's next call fails and its next refresh fails too. The hourly tokens are
otherwise left to expire.

## The Perimeter Caveat

The authorization server must be reachable from the user's browser and the client, so the remote
scenario needs a public origin for Core — and metadata uses `EffectiveCorePublicOrigin` throughout,
because a loopback URL in that document would send both to the wrong machine. The manual path has no
such dependency, which is one more reason it is permanent. Apps refuse to build resource metadata
without a public identity (null, not a guess): no metadata simply means the manual path.

## Testing Expectations

- The whole flow over the real pipeline: register → authorize → consent → redeem → the token
  working on the surface it names and refused as a Core session — then rotation and the one-row
  revocation stopping both the live access token and the next refresh.
- The theft signal: a replayed spent refresh token killing the whole chain, including the winner's
  access token and its refresh — asserted from the victim's and the thief's side both.
- The breaker: registration refused off, working on, refused again when turned back off — with
  already-issued credentials untouched.
- PKCE pairs: wrong verifier refused; a code dying on first presentation, valid or not.
- Resource pairs: absent and unknown refused via redirect; an app resource minting a token active at
  that app's introspection and refused at Core MCP.
- Consent bars: a non-administrator refused for `hosty:core` at the decision; denial reaching the
  client as `access_denied`.
- Discovery: both metadata documents, and the 401 challenge naming the resource-metadata URL.
- An unregistered redirect_uri answered 400 in place — never a redirect to an unvalidated URI.
- SDK helpers: the RFC 9728 metadata-URL derivation, and refusal to guess when either URL is
  missing.

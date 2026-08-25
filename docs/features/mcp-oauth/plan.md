# MCP OAuth — Automated Issuance For Scoped Tokens

Status: Ready
Created: 2026-08-24
Updated: 2026-08-24

An OAuth 2.1 issuance path per the MCP authorization specification, so clients that speak it
(Claude Code, VS Code, Cursor) obtain and rotate scoped access tokens themselves instead of a user
generating one and pasting it into a config. **The manual path stays forever**: it works in every
client including ones that never learn OAuth, and both paths mint the same token records, revoked on
the same page, validated by the same introspection — OAuth replaces issuance only, nothing
downstream of it.

**Depends on [scoped-access-tokens](../scoped-access-tokens/feature.md)**, which builds everything this
feature issues into. Pairs naturally with the [mcp-facade](../mcp-facade/plan.md) — one resource,
one consent, the whole catalog behind it — but neither blocks the other.

## Target Behavior

The flow a capable client runs, end to end:

1. The client calls an MCP endpoint without a token and gets `401` with `WWW-Authenticate` pointing
   at protected-resource metadata (RFC 9728) naming Core as the authorization server. App endpoints
   and the facade serve this via the SDK helpers, so no app hand-rolls it.
2. The client reads the AS metadata (RFC 8414), registers itself via Dynamic Client Registration
   (RFC 7591) — the MCP spec leans on DCR because pre-registering every client is impossible; the
   endpoint is rate-limited since registration is anonymous.
3. Authorization code + PKCE (mandatory in OAuth 2.1): the user's browser lands on a Core/Shell
   consent page that names the client, the resource, and the scopes in plain terms. Consent is the
   natural future home of standing mutation grants ([core-mcp](../core-mcp/feature.md)) — approving a
   scope *is* the approval — but this feature ships read scopes only.
4. The client receives a short-lived access token plus a refresh token and rotates on its own; the
   refresh token is the long-lived revocable credential, and it lives in the client — never in an
   app's hands.
5. **Resource indicators (RFC 8707) map to audience**: the client names the MCP server it wants a
   token for, Core mints the token with that single audience — the per-app isolation
   scoped-access-tokens requires falls out of the spec instead of out of user discipline.

Perimeter note: the authorization server must be reachable from the user's browser and client, so
the remote scenario requires a public origin for Core's auth surface — an explicit part of this
feature's scope, not an assumed given. The manual path has no such dependency, which is one more
reason it is permanent.

## Deliverables

- [ ] AS metadata, `/authorize`, `/token` (code + refresh grants), PKCE enforced, refresh rotation,
      revocation wired to the existing token management page.
- [ ] Dynamic Client Registration with rate limiting and an operator-visible client list.
- [ ] Shell consent page showing client, resource, scopes; refusal is first-class.
- [ ] Resource-indicator handling minting single-audience tokens; a request without a resource is
      refused, never defaulted to a broad token.
- [ ] Protected-resource metadata served by the SDK helpers (TS + .NET) and the facade.
- [ ] Live verification: a stock Claude Code completes the flow against a non-loopback origin with
      no token in its config, and a revoked grant stops a session on its next call.

## Resolved Questions (2026-08-24, owner approval in chat)

1. **Claude Code is the acceptance gate.** VS Code and Cursor are recorded as separate verification
   cells in the style of ai-agent-bridge step 6 — "supports OAuth" is one claim per client — and
   they never block the ship.
2. **Access-token TTL stays conventional (one hour).** Introspection already revokes instantly, so
   the short TTL buys nothing in security — it is kept purely for spec-conventional client
   behavior, and that is reason enough.
3. **DCR ships behind an operator toggle, default off.** Turning the OAuth surface on is an
   explicit act, coherent with hosts that never expose a public origin.
4. **A broader scope is always a fresh consent** — no in-place upgrades.

## Verification

The full flow with a stock client and zero manual token handling; pair tests on the AS: wrong PKCE
verifier refused beside correct accepted, token minted only for the named resource, refresh rotation
invalidates the predecessor, DCR rate limit trips. The manual-path regression: a pasted scoped token
keeps working with the OAuth machinery entirely disabled.

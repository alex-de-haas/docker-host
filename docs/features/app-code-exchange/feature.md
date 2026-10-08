---
created: 2026-10-05
updated: 2026-10-08
summary: Authorization codes require target-app service identity and private S256 proof, with browser-origin and nonce-bound sign-in attempts.
components: [apps/core, apps/cli, packages/app-sdk, apps/shell, apps/harness, apps/shell-swift]
---

# App Code Exchange

Core binds authorization-code redemption to both the installed app and the private proof of its
sign-in attempt. A disclosed code, state or S256 challenge cannot by itself produce an app grant.
The app server supplies its service credential and the locally created verifier to Core. Origin
headers on an app's public exchange endpoint do not substitute for either requirement.

## Browser initiation and continuation

An app creates independent random state and a 32-byte private verifier. Its public challenge is
base64url SHA-256 of that verifier. An app-owned form navigates to
`POST /api/apps/{appId}/sign-in-intent` with the approved callback, state, S256 challenge and mode.
Core requires an exact non-null Origin matching the installed app's callback origin and appropriate
navigation metadata. It freezes a five-minute intent and creates a unique browser nonce;
only the nonce hash is stored on the server. HTTPS and literal-IP HTTP use an HttpOnly cookie
and a 303 to `/open?requestId=...` in the same context.

The continuation verifies the matching nonce before login or issuance. Caller-supplied overrides
and direct proof-bearing GET issuance are refused. A narrowly validated protocol-1 navigation
shape returns only correlated `protocol_required` to the installed app callback, or its existing
popup, without resolving a session or issuing a code. Unknown or malformed shapes retain the
JSON refusal; the request cannot create, claim or consume an intent. Normal top-level password login preserves the
request ID. An authorized continuation atomically claims the intent once and issues one bound code.
A claim remains consumed if subsequent issuance fails. Wrong nonce, app or proof does not consume
another valid attempt. Unknown, expired and replayed attempts fail closed.

HTTPS uses unique `__Host-` nonce cookies with Secure, HttpOnly, Path=/, no Domain, SameSite=Lax and
five-minute lifetime. Both HTTPS and HTTP require separation from every configured runtime endpoint
cookie hostname, including internal, generated, public-override, private and non-HTTP origins.
HTTP permits literal IPs and canonical `localhost` or `.localhost` names. Other HTTP DNS hosts are
refused. Canonical comparison covers IPv4 aliases, IPv6, IDN, case and trailing dots; unsafe topology
returns actionable refusal. There are at most 16 intents per browser cookie jar or named-localhost
storage context, and 4096 global intents, alongside authentication rate limits.
Capacity refusal preserves existing attempts.

Named HTTP localhost uses Core-origin sessionStorage because Safari does not accept the Secure
host-prefix cookie on that transport. Only the validated app-origin initiation POST initializes
the per-intent proof. A GET continuation reads existing proof and cannot initialize or issue it.
The Core document submits the nonce and bounded live-proof map in a same-Core-Origin form POST;
Core validates exact Origin, navigation mode and nonce before login or issuance. Neither a copied
request URL nor a sibling app's parent-Domain cookie supplies this proof. Bodies are bounded to
8 KiB, multipart is refused, and terminal outcomes clear only their own storage entry. Expired
entries are pruned without evicting other live attempts. JavaScript and working Core-origin
sessionStorage are required; there is no nonce-cookie fallback for this transport.

Silent initiation requires an iframe and establishes identity without privileged activity. Missing
Core session returns a state-bound login-required callback. A known same-app silent intent whose
nonce is unavailable also returns only that credential-free error to its frozen callback; this
restores popup fallback when third-party cookies are blocked. Other missing-nonce contexts return
refusal. Core never frames its password login.

Ordinary validated `/open?redirectUri=...` links carry no credentials: they bootstrap the app,
which creates its own attempt. The full issuance contract is independent of CLI/browser launch links.

## Atomic redemption and authority

`POST /api/auth/apps/token` requires the target app service bearer and JSON `{ code, codeVerifier }`.
Under one store lock, Core matches the app and validates RFC verifier syntax and the constant-time
S256 digest before consuming the code. Missing/invalid service identity is
`app_service_token_invalid`; wrong app or proof is `invalid_code`. Those failures leave a valid
code redeemable by its original app and verifier. Correct-proof replay and expiry retain their
existing `code_consumed` and `code_expired` results. Persisted unbound codes are refused.

SDK handlers, Harness, Shell renewal and Project Manager validate verifier syntax before fetching
Core. Code-only or malformed-proof requests return local 400. Fixed-origin proof POSTs use
`redirect: error`. Codes, verifier, challenge, nonce and tokens are excluded from refusal audits and
request-body logging. Existing grants, assignments, auth revisions, parent-session cascade,
permission checks and lifetime rules remain enforced.

Authenticated `/authorize` and `/launch-code` issuers require a challenge and S256 method. Cookie
callers retain CSRF requirements. Generic/native initial issuance remains identity-only. Native
in-place renewal uses `interactiveRenewal: true` only with a live primary Core session bearer;
device, app-service and scoped/delegated credentials cannot use it to establish privileged activity.

## App-owned proof lifecycle

Navigation attempts live in bounded app-origin sessionStorage for five minutes. The callback
selects the exact locally created attempt, removes it once and cleans code/state from the URL before
exchange. Public navigation fields cannot import proof. A failed storage round trip prevents
navigation and leaves explicit popup recovery available. Popup and renewal proof remains in app
memory; Core/browser/native result messages contain only public state and code or a correlated error.
Strict Mode, stale responses and duplicate/late completion cannot exchange a newer attempt.

Shell's server generates its own state and verifier, retains them in separate short-lived HttpOnly
attempt cookies, submits its app-origin form and exchanges only after callback correlation. Its
renewal endpoint updates the app cookie without exposing the grant to browser JavaScript.
App-owned intent documents use origin-only referrers and a fixed Core action. DNS/IPv4 Core
origins retain exact Core-plus-self `form-action` CSP. For parsed configured IPv6 Core origins,
the minimal SDK/Shell form omits only `form-action`, because CSP host sources cannot represent
an IPv6 literal. It keeps `default-src`/`base-uri` and the existing script/frame policies. This
omission removes CSP form-destination enforcement; the fixed target and Core Origin/nonce/proof
checks remain in force. Shell global headers preserve the route-owned nonce-bearing policy
while retaining frame protection for ordinary pages. Local recovery recognizes reserved
`.localhost` subdomains, including Core-generated app hosts, alongside existing loopback literals.

Embedded grants retain the per-tab persistence described in
[embedded app sign-in](../embedded-app-sign-in/feature.md). Identity rejection and explicit logout
clear them; activity expiry retains the mounted document and draft until an explicit renewal.
Pending proof and established grant lifetimes remain separate.

## Native and CLI launch

Swift first loads the approved app with `hosty_launch=native`. The SDK creates proof locally;
Swift intercepts its public proof-bearing Core navigation before network dispatch and checks Core
origin, app, callback, state, challenge, source/target main frame and source origin/document generation.
It calls authenticated launch-code and loads the validated app callback. It never reads the verifier.

Every in-place native renewal opens a fresh nonpersistent normal Core login sheet and verifies the
same account as the native host session. It keeps the app document mounted and returns public
code/state through a fixed completion event, paired by the SDK with its memory proof. The saved
device credential is unchanged. Owned primary confirmation sessions remain only in workspace memory
for ordinary logout cleanup; cancellation, eviction, logout and host replacement invalidate pending
work and preserve revocation semantics.

Swift Open in Browser and CLI/control open links are credential-free. The browser signs in using
its own Core account. `apps open` emits its plain URL or JSON without terminal line wrapping, so redirects and
script-parsed URLs remain intact. `apps open --user` is refused with migration guidance; the separate diagnostic
`apps identity --user` remains available. Cardputer and the .NET identity SDK do not exchange app codes.

## Protocol discovery

Enforcing Core exposes fixed read-only `/api/auth/apps/protocol` metadata `{ version: 2 }`. App
servers include it in recovery responses and native discovers it on its configured connection.
Only an actual metadata 404 plus strict public Core status identifying a running version below
0.120.0 permits old-Core protocol 1 with additive challenge/proof/service fields. Timeout, 5xx,
malformed data, unknown version and protocol-2 refusal never downgrade. Once protocol 2 is observed,
it remains the minimum for that tab/connection. A pending old-Core attempt is discarded and restarted
once with fresh proof only after app-local recovery metadata verifies the same app, configured Core
origin and protocol 2. The restart reuses the existing gesture-opened popup, or replaces the
navigation attempt, without importing caller-supplied proof. Shell correlates its own state cookie
and stored protocol before clearing the old attempt and returning to its own fresh start route.
Unknown metadata and protocol-2 refusals remain terminal. Old-Core compatibility does not claim
the new protection.

SDK 0.21.0 is published; both external clients use its verified npm artifact in their actual
dependency locks. Production client rollout before Core enforcement and native live acceptance
remain tracked in [the plan](plan.md); isolated QA deployment is not production release evidence.

## Testing Expectations

- Core tests require authenticated app service identity and matching S256 proof for every code,
  preserve valid redemption after wrong caller/proof, and cover replay, expiry, concurrency,
  unbound records, access/auth revisions, parent sessions, silent activity and audit confidentiality.
- Browser intent tests cover exact/null/foreign Origin, navigation modes, immutable continuation,
  nonce-before-login, login preservation, one claim, cookie prefixes, named-localhost storage
  initialization/continuation, bounded form bodies, terminal cleanup, canonical all-endpoint cookie
  host isolation, rate/capacity limits and independent simultaneous attempts.
- SDK/server tests cover RFC challenge vectors, independent randomness, bounded local correlation,
  storage refusal, bootstrap field injection, redirect rejection, stale/duplicate completion,
  cancellation, renewal/logout and strict metadata downgrade limits.
- Real Core-managed browser acceptance uses normal setup/password login and checks standalone,
  silent/popup, blocked cookie/storage fallback, attack relay/public-proxy refusal, concurrent tabs,
  HTTPS sibling cookie injection, mounted renewal and external clients.
- Swift tests/builds and native acceptance cover strict frame/source authority, account matching,
  fresh-login renewal, draft retention, page reuse/LRU, late completion and primary-session cleanup.
  CLI tests require credential-free URLs and explicit rejection of legacy impersonation options.

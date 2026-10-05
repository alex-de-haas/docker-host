# App Code Exchange — Bind Redemption To The App And Its Sign-In Attempt

Status: In Progress
Created: 2026-10-05
Updated: 2026-10-05

## Goal

An authorization code disclosed in a URL, access log, trace, browser history or browser message
cannot produce an app grant through Core or an app's public exchange route. Redemption requires
both the target app's service credential and the private proof of the app-owned sign-in attempt.
Browser authorization also binds that attempt to the browser which started it, so an attacker
cannot choose their own proof and relay its authorization link to another user's browser.

This covers disclosure of the code and public state/challenge. It does not cover compromise of
the verifier, Core session cookies, already-issued grants, app-origin script, or a transport that
discloses the proof request. The separate cross-port session-capture investigation remains separate.

## Approval Boundary And Implementation State

The owner approved the original service-token plan on 2026-10-05 and the expanded protocol later
the same day. Core, SDK, Harness, Shell, first-party app, Swift, CLI and both external-client source
changes are implemented locally. Production publication, actual external registry locks and live
acceptance remain tracked below; local SDK tarballs do not establish release completion.

Inspection found that an app's public code handler forwards an arbitrary supplied code using its
own credential. On 2026-10-05 the owner chose to expand this same plan and review the protocol
before implementation. The owner approved the complete expanded protocol on 2026-10-05, including
CLI/Swift behavior and HTTP constraints. Implementation proceeds in the isolated
`feat/app-code-exchange` worktree; existing service-token changes are part of this feature.

## Current Behavior And The Two Bypasses

The baseline is the completed embedded sign-in change, commit `497a4e85`, in PR #546.

- Core exchanges `{ code }` without authenticating the caller at that baseline. The local
  service-token slice now authenticates the calling app and atomically matches it before consumption.
- SDK `createAppCodeRouteHandler`, Harness `/api/app-code`, Project Manager's custom handler and
  Shell's renewal endpoint accept a code, forward it through their server, and return or install a
  grant. Origin and Fetch headers cannot authenticate a server-side caller. Service-token enforcement
  alone leaves these routes usable as redemption proxies.
- S256 alone is also insufficient for the full goal: an attacker can choose their own verifier,
  induce a victim browser to navigate Core's GET `/open` with its challenge, read the resulting code
  from the app's log, and supply their known verifier to the public proxy. Browser-local callback
  state does not constrain that direct server-to-server redemption.
- Additional code issuers are Core's `/authorize` and `/launch-code`, the control `open-link` used
  by CLI standalone open, and Swift's initial launch and browser handoff. Every issuer is in scope.
- Cardputer has no runtime-app browser launch or code exchange. The .NET SDK validates identities
  but does not exchange app codes. Neither needs changes.

## Proposed Protocol

### 1. Independent private proof

For each attempt the app generates 32 CSPRNG bytes and base64url-encodes them without padding into
a 43-character `codeVerifier`. It separately generates the existing 256-bit public state.
`codeChallenge = base64url(SHA256(ASCII(codeVerifier)))`; only `S256` is supported, following
[RFC 7636, section 4](https://www.rfc-editor.org/rfc/rfc7636.html#section-4).

Core accepts RFC verifier syntax (43–128 ASCII unreserved characters) and a canonical 43-character
challenge encoding exactly 32 digest bytes. The verifier never appears in a URL, fragment, Core
authorization request, popup message, parent-frame message, audit record or trace. It travels only
in the app's code-exchange POST body and the app server's fixed-origin Core exchange POST body.
Those server fetches reject redirects, so a 307/308 cannot forward the proof elsewhere.

Use a maintained browser-compatible SHA-256 dependency when `crypto.subtle` is unavailable on
HTTP app origins. Do not introduce handwritten cryptography, `plain`, or a randomness downgrade.

### 2. Core verifies browser initiation before issuing a code

Add browser-navigation `POST /api/apps/{appId}/sign-in-intent`, with form fields:
`redirectUri`, `state`, `codeChallenge`, `codeChallengeMethod=S256`, and the existing mode selectors
(`prompt=none` for silent, `responseMode=web_message` for popup, neither for standalone).

The route validates the redirect against the installed app and requires the browser's exact
non-null `Origin` to equal that redirect's origin. It accepts the appropriate navigation/frame
metadata for the selected mode. A null, absent, foreign or sibling-app Origin is refused. This
route does not require a Core session and does not issue a code; a cross-site form POST may omit
Core's Lax session cookie.

Core records an immutable five-minute pending intent containing an unpredictable request ID,
app ID, approved redirect, state, challenge and mode. It generates an independent 256-bit browser
nonce, stores only its hash, and sets that nonce in a unique HttpOnly cookie for this intent.
The nonce is never returned in the body. Expired records are cleaned on access; use existing
auth rate limits and bounded pending records/cookies (at most 16 live intents per browser and
4096 per Core). At capacity, refuse new intents instead of evicting another live attempt. Incorrect
nonce/proof does not clear another attempt's cookie or record. An issuance failure after claim
leaves that request consumed. A 303 navigates the same context to
`GET /api/apps/{appId}/open?requestId=...`, where the normal Core session is available.

The GET verifies the matching intent cookie before any login redirect. It accepts no overrides
of the stored fields, never creates/replaces the nonce, and does not issue from caller-supplied
challenge query parameters. Missing/wrong nonce, wrong app, unknown/expired intent or field
overrides return a refusal without issuing or consuming the valid intent. For a known unexpired
same-app silent intent in an actual iframe, nonce refusal may return only `login_required` and the
stored correlation state to its already validated app callback. This credential-free refusal
restores the app-owned popup fallback after third-party-cookie blocking; it never issues a code
or consumes the valid intent. Other missing-nonce contexts retain the JSON refusal. A server-forged Origin
can create only the attacker's own request/cookie pair; its copied URL does not authorize a victim.

After nonce validation, existing session/access checks apply. A missing top-level Core session
continues through normal login with this exact request ID; a silent frame returns its existing
state-bound error instead of framing login. An authenticated authorized continuation claims the
intent atomically once and issues one bound code. Replay/concurrent continuations cannot issue a
second code. Terminal refusal, successful claim and expiry clear the cookie; an uncertain transport
outcome requires a fresh attempt rather than reissuing a code.

Cookie isolation is a protocol requirement. Follow the
[host-cookie prefix contract](https://datatracker.ietf.org/doc/html/draft-ietf-httpbis-rfc6265bis-22#section-4.1.3.2).
On HTTPS use a unique `__Host-` cookie name, `Secure`,
`HttpOnly`, `Path=/`, no Domain, `SameSite=Lax`, and Max-Age 300. The existing exact-host app/Core
separation check also applies. A sibling app must not be able to shadow the nonce using a parent
Domain cookie. Plain HTTP is supported only when Core's public host is a literal IP and every
runtime-app browser host differs from it; this preserves an isolated local/LAN setup without a
parent-domain cookie bypass. Compare canonical browser cookie hosts, not raw strings or DNS
resolution: normalize IP representations, IDN, case and trailing dots, and reject ambiguous forms
that cannot be safely compared. An unsafe configuration returns an actionable refusal, never an
unbound fallback. Tests cover IPv4 aliases, IPv6, same-host ports and sibling-domain shadowing.

Ordinary `/open?redirectUri=...` links with no intent or proof validate the destination and redirect
to the app without a code. The app then initiates this protocol. A proof-bearing GET without an
intent is refused. This is a bootstrap navigation, not a legacy issuance path.

### 3. App service identity and proof are checked atomically

`POST /api/auth/apps/token` requires `Authorization: Bearer <target app service token>` and JSON
`{ code, codeVerifier }`. Core resolves the app exactly as revalidation does. The code record
stores its required S256 challenge, never the verifier.

Under the existing code-store mutex, redemption checks: code lookup, app match, verifier syntax
and constant-time hash comparison, consumed/expiry state, then consumption. A missing/invalid
service token returns 401 `app_service_token_invalid`. Wrong app or missing/malformed/wrong proof
returns 401 `invalid_code`. These failures leave the valid code untouched. The right app/proof
receives the grant; correct-proof replay retains `code_consumed`, and expiry retains `code_expired`.

User access, auth revision, authorizing Core session, logout cascade, grant lifetime and activity
propagation are preserved. Silent issuance still does not authorize activity. Refusals audit known
calling/code app IDs and the internal reason, never code, verifier, challenge, nonce or token.
Existing persisted codes without a challenge are rejected; existing grants remain valid. There is
no unbound issuance/exchange overload or compatibility setting in the enforcing Core.

Trusted Core-session APIs `POST /api/auth/apps/authorize` and
`POST /api/apps/{appId}/launch-code` require `codeChallenge` and
`codeChallengeMethod=S256` in addition to their existing fields. Cookie callers retain CSRF
requirements and bearer callers retain their existing session authority. Native callers preserve
state in the app callback and validate the initiating app document before using this authority.
The browser GET broker never substitutes for these authenticated APIs.

Native in-place renewal sets `interactiveRenewal: true` only after a fresh normal Core password
login in a separate nonpersistent sheet. Core accepts this flag only from a live primary session
bearer: device, delegated, app-service and audience/scoped credentials cannot establish activity.
The confirmation must identify the same user as the native host session. Swift preserves its saved
device credential and the mounted app document; confirmation sessions remain only in workspace
memory for ordinary Core logout cleanup on native logout, eviction or host replacement. Every
renewal requires fresh login, so an app timer cannot reuse a cached primary session to extend
activity. Cancellation and document-generation changes invalidate pending confirmation.

### 4. Browser and server attempt lifecycle

SDK navigation flows keep a state-specific, bounded attempt record in app-origin sessionStorage:
state, verifier, app ID, Core origin, redirect URI, creation time and mode. Verify a successful
storage round trip before navigating. Records expire after five minutes; concurrent frames/tabs
and renewals must not overwrite one another. The callback matches local state before reading its
verifier; it never imports an attempt, challenge or verifier from navigation parameters. It copies
the proof into one exchange promise and removes the code/state from the URL early. For older-Core
compatibility, standalone/native redirect URIs already carry the reserved correlation state before
issuance, so legacy Core preserves it without needing new state-echo behavior.
React Strict Mode and stale responses cannot start a second exchange or discard a newer attempt.

Popup flows keep their proof in app memory. Open the popup synchronously from the user gesture,
then submit the intent form from the app-owned document into it. Core still posts only code and
state to the validated app origin/window. The SDK returns `{ code, codeVerifier }` internally to
its app-owned exchange callback. Activity renewal uses the same protocol and retains the loaded
page and draft state.

Storage failure skips silent/full-document navigation and offers the explicit app-owned popup.
Third-party cookie refusal makes silent initiation fail closed and use the same fallback. A blocked
popup offers retry; it never falls back to an unbound code. Pending proof and grant lifecycles remain
separate and clear on completion, terminal refusal, cancellation, expiry and logout.

The SDK renders a minimal app-owned form document in the current app context (navigation/silent)
or the synchronously opened, app-origin `about:blank` popup. It sets `Referrer-Policy: origin` through
a head meta policy, constructs fixed-Core-action form inputs from its local attempt using DOM APIs,
and submits without importing a public bootstrap URL or inline caller-supplied script. Navigation
proof is persisted before replacing the document; popup proof stays in the opener app's memory.
Shell's server `/auth/start` returns its own minimal form document with an explicit origin policy
and nonce-protected auto-submit/noscript action. Auth documents/pages permit only the configured
Core origin and their own validated callback origin in form-action CSP, covering both the form
submission and its return redirect chain; inherited iframe restrictions are verified in acceptance. No public app bootstrap/start route may reflect caller-supplied
state/challenge/verifier into this form: Shell generates a fresh attempt on the server, and SDK
forms derive their fields only from the matching locally created attempt. Navigating the victim
through a trusted app URL must not launder an attacker-selected challenge into a valid Origin.
In particular, Shell's current `no-referrer` start response must not
turn the cross-origin form's Origin into `null`, as specified by
[Fetch's Origin-header rules](https://fetch.spec.whatwg.org/#origin-header). Query details and credentials are not sent as a
referrer. Browser acceptance checks real Origin, cookies, redirects, sandbox and popup behavior.

Shell's server start/callback flow generates its own verifier alongside state, stores it in a
short-lived HttpOnly app cookie, renders the app-origin Core intent form, validates callback state,
then forwards the cookie's verifier. It does not return a browser grant. Shell popup renewal uses
the browser memory-held proof. The existing broader app-cookie isolation investigation is separate.

SDK, Harness, Shell renewal and Project Manager public exchange handlers require and validate the
verifier before contacting Core. A code-only request returns a local 400; a syntactically valid
attacker proof reaches Core and is refused without consuming the code. Updated Media Server uses
the published SDK handler. Raw proof/request bodies are excluded from auth logs and telemetry.

### 5. Native and CLI launch changes

Swift first loads the approved app URL with `hosty_launch=native`, without a preissued code.
The app SDK creates its attempt locally. In native mode it builds the existing Core `/open` GET
navigation with public challenge, method, state and redirect fields; the native coordinator intercepts
it before network dispatch. Enforcing Core refuses that GET if interception does not occur. Native
recovery accepts this navigation only from the approved app's main frame and forwards the public challenge through
the authenticated launch-code API, and loads the returned callback. Verify destination Core,
source and target main-frame status, the source frame's scheme/host/port, app ID, redirect, state,
method and challenge. Native activity renewal adds the fixed `responseMode=web_message` field to
the same validated main-frame navigation. The coordinator cancels it before dispatch, requests a
bound code after the fresh login described above, and delivers only correlated code/state through a fixed native-completion event to
the unchanged initiating app document. The SDK pairs it with its memory-held verifier. Both sides
reject wrong state, late/duplicate completion, stale document generation and logout; no callback
navigation discards the draft during renewal. Only a specifically
tracked continuation may originate elsewhere. Native never reads/transfers the verifier or accepts
an arbitrary `/login` navigation as authority to mint a code. Preserve page reuse, the four-view
LRU, nonpersistent stores, logout clearing and recovery throttle.

Swift "Open in Browser" opens the plain app URL. The external browser creates its own attempt and
uses its own Core account; it can require login or use a different account than native Shell.

CLI/control `open-link` likewise returns a validated credential-free app or Shell workspace URL,
with no code and no expiry/claimed user identity. Remove `--user` from `hosty apps open`; old explicit
`--user` requests fail with migration guidance rather than being ignored. The control endpoint also
rejects a supplied legacy user field. Opening no longer impersonates a selected user; the browser
performs normal sign-in. `hosty apps identity --user ...` stays a separate local diagnostic helper
and is not used to authenticate browser acceptance.

## Client-First Rollout Without A Legacy Core Mode

The new intent route cannot be assumed to exist in older Core. Add fixed, read-only
`GET /api/auth/apps/protocol` metadata (`{ version: 2 }`) on the known Core origin. App servers
expose this in the existing identity recovery payload; native reads it through its configured Core
connection. Discovery uses `no-store` and strict metadata/version validation. Protocol 2 means
origin-bound intent plus S256. Only a definite metadata 404 together
with a verified public `/api/core/status` version below 0.120.0 allows protocol 1's existing
navigation with additive challenge/proof/service-header fields. Unknown version, timeout, 5xx,
malformed metadata or any protocol-2 refusal never triggers a downgrade. Once protocol 2 is observed
for a Core origin, the client does not downgrade that connection/session to protocol 1. Discovery
never sends proof or authority to a caller-selected origin. Invalidate stale metadata on protocol
mismatch so deployment does not create redirect loops. An upgrade during a pending protocol-1
attempt discards that attempt and restarts once with fresh protocol-2 proof; it never reuses proof
or repeatedly bootstraps without a code.

Ship the complete SDK, native and custom client changes first. Refresh real registry locks and
verify/deploy Project Manager and Media Server before Core enforcement. Protocol-1 Core retains
its existing weakness until replaced; this compatibility does not claim protection. The next
Core release immediately requires protocol 2 for browser issuance and bound proof/service tokens
for exchange. It contains no report-only release or temporary legacy-exchange switch.

SDK publishing, actual external dependency locks, client deployment and live acceptance are explicit
deliverables below. Local tarball tests are not evidence of those release/deployment steps.

## IPv6 CSP Compatibility Amendment — Awaiting Owner Approval

A fresh Chromium probe on 2026-10-05 rejects bracketed IPv6 host sources in CSP, so the approved
exact-Core `form-action` directive blocks an otherwise valid literal-IP deployment. The proposed
bounded exception applies only when the verified configured Core hostname is an IPv6 literal:
the minimal SDK/Shell intent document omits `form-action` rather than emitting an ineffective or
wildcard destination. It retains `default-src 'none'`, `base-uri 'none'`, the existing script policy,
fixed DOM/server-generated Core form action, exact app-Origin checks and nonce/proof binding.
Non-IPv6 Core origins retain Core-plus-self `form-action`. No verifier enters this public form.
This exception changes the agreed CSP defense, so implementation awaits explicit approval.

- [ ] Approve and implement the IPv6-only CSP exception; verify real submission and unchanged
  destination construction, Origin/nonce checks and proof confidentiality. Without approval,
  retain the original policy and leave IPv6 browser acceptance unfinished.

## Owner Decisions

1. 2026-10-05: approve the original service-token plan; clients precede immediate Core enforcement,
   with no report-only release or temporary legacy setting.
2. 2026-10-05: wrong-app redemption is 401 `invalid_code` and does not consume the target code.
3. 2026-10-05: expand this plan to bind the public app-code path to the original sign-in attempt;
   prepare the protocol and obtain approval before implementing the expansion.
4. 2026-10-05: approve the full protocol above, including origin/nonce browser initiation, constrained
   HTTP support, app-first native/browser/CLI launches and removal of `apps open --user` semantics.

## Deliverables

Already implemented under the original approval, in the same uncommitted change:

- [x] SDK and Harness send their service token and return `app_service_token_missing` before fetch
  when missing/blank; all in-repo exchange callers identified.
- [x] Core authenticates the calling app, atomically matches it before consuming, and audits refusals;
  existing callers/tests updated and 16 Core regression cases added.
- [x] Project Manager's custom exchange sends the token, with seven regression cases.

Remaining work:

- [x] Implement Core browser-intent store, Origin checks, isolated nonce cookies, login continuation,
  one-time claim, silent/popup handling and credential-free ordinary bootstrap.
- [x] Require S256 on every authenticated issuer; store challenges and atomically verify proof before
  code consumption; reject unbound legacy records and preserve grant/access/activity semantics.
- [x] Add Core protocol metadata and client discovery with explicit old-Core-only compatibility,
  mismatch invalidation and no transient-error downgrade.
- [x] Update SDK proof generation/lifecycle, standalone, silent, popup and activity renewal; require
  proof in server exchange/handlers and refuse redirected proof POSTs.
- [x] Update Harness browser/server exchange and Shell server login/renewal/CSP/referrer behavior.
- [x] Update Swift app-first launch, trusted navigation validation, proof-bearing launch requests,
  external-browser handoff, tests and documentation. Cardputer remains unchanged.
- [x] Remove credential-bearing CLI/control open links and explicit `apps open --user` impersonation;
  update public contracts, help, tests and relevant feature documentation.
- [ ] Update Project Manager custom proof flow; publish the complete SDK, update both external clients'
  real dependency locks, verify and deploy them before Core enforcement. Supersede local header-only
  SDK/Media candidate patches with the full protocol.
- [ ] Update app auth references and affected feature documents, create current `feature.md`, remove
  this plan only after all deliverables, and regenerate the documentation index. Touched legacy
  auth/direct-UI docs use their migrated feature folders.
- [x] Apply one final version bump per artifact from PR #546's baseline: platform 0.119.0→0.120.0;
  SDK 0.20.0→0.21.0; Swift 0.10.1→0.11.0; Shell 0.93.1→0.94.0; Harness 0.41.1→0.42.0;
  demo-app 0.12.1→0.13.0; Marketplace 0.6.1→0.7.0; Telemetry 0.12.1→0.13.0;
  Project Manager 0.12.0→0.13.0; Media Server 0.85.5→0.86.0. Broader required auth contracts
  replace the current header-only patch candidates. Keep manifest/package/image/lock sources in step.
- [ ] Complete the automated and real-browser acceptance below; record any platform/hardware
  verification that cannot run and leave its deliverable open rather than claiming completion.

## Phases

1. Implement the approved complete clients and compatibility discovery.
2. Implement enforcing Core, native/CLI launch changes, documentation and final versions.
3. Verify the full protocol; publish/update/deploy clients before enforcing Core. One branch and
   one PR cover this feature, not one PR per phase; external repositories retain their own changes.

## Verification

Automated Core cases cover service token/proof absence, wrong app/verifier, valid exchange after
refusal, replay, expiry, concurrency, legacy codes, access/auth revision/activity and secret-free
audit. Every issuer rejects unbound issuance. Broker cases cover foreign/null Origin, attacker
intent relayed into a victim session without its nonce, no GET creation/overrides, login continuation,
one claim, independent simultaneous attempts, expiry, cookie prefixes and allowed HTTP host topology.

SDK/app cases cover the RFC S256 vector, CSPRNG/state independence, callback/proof correlation,
storage refusal, attacker-selected fields passed to app bootstrap, popup cancellation/activation,
Strict Mode, stale responses, renewal/logout,
redirect refusal and metadata errors/downgrade limits. CLI tests verify secret-free text/JSON links
and explicit --user errors. Swift tests verify request fields and strict native navigation origin,
frame, app, redirect/state, duplicate/late-callback and logout handling.

Run `npm run sdk:test`, `npm run core:test`, `npm run cli:test`, `npm run harness:test`,
`npm run shell:test`, `npm run marketplace:test`, `npm run telemetry-ui:test`, demo and external
client suites; exact Core/CLI, SDK and all changed production web builds; docs-index/version checks.
Run Swift HostyKit tests and macOS/iOS Simulator builds according to its repository instructions.

Live acceptance uses a fresh isolated Core-managed data root, normal setup and password login:

1. Standalone, initial silent, explicit popup and activity-renewal sign-in work with normal and
   blocked storage/third-party cookies. Real cross-origin form Origin, nonce cookie, 303 and Core
   login continuation are observed; a TestServer cannot establish browser behavior.
2. Take a code from a real app-owned attempt and call the public app-code handler with forged
   Origin/Fetch headers. Code-only is refused locally; unrelated verifier is refused by Core;
   the original browser/proof still succeeds. Direct Core exchange without a service token fails.
3. Create an attacker-owned intent/challenge, relay its GET URL to the logged-in victim browser,
   and prove no code is issued without that browser's matching nonce. A foreign-origin form and
   direct challenge GET also cannot issue; app bootstrap URLs cannot reflect the attacker's
   challenge into a trusted form. Check concurrent legitimate tabs and sibling-domain
   cookie injection on HTTPS.
4. Harness protected settings, Shell login/renewal, demo, Marketplace, Telemetry and updated
   Project Manager/Media Server sign-in work through Core-managed lifecycle.
5. Native first-open, page switch/LRU reopen and renewal retain drafts; external-browser handoff
   and CLI open use the browser's account, including logged-out and different-account cases.
   Foreign WebView source origins cannot invoke native launch-code authority.
6. Old-Core compatibility is checked separately before upgrading; enforcing Core never creates
   or redeems an unbound code. External clients are deployed before enforcement is released.

Header-only verification on 2026-10-05: Core 2496 passed / 4 opt-in skipped; SDK 215, Harness 510,
Shell 267, Marketplace 104, Telemetry UI 10 and demo 4 passed (3606 passed total). Exact Core and
all affected SDK/web production builds passed. Project Manager 126 and the local Media candidate
163 tests/builds/lint passed. These results do not verify the unimplemented expanded protocol or
client publication/deployment/live acceptance. Telemetry UI's Turbopack build could not resolve
shared-workspace dependency symlinks; its webpack production build passed.

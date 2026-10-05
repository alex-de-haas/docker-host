# Embedded App Sign-In

Created: 2026-10-05
Updated: 2026-10-05

Embedded apps keep their own sign-in grant for the tab and attempt silent initial sign-in directly
through Core. Shell mounts only the selected workspace and destroys its frame when the user leaves;
restoring identity does not require retaining hidden app frames. Core delivers a code to the app's
own frame. Shell sees no app code or credential and gains no authority to redeem one.

## Per-tab app sessions

`rememberAppGrant` keeps the grant in document memory and, for embedded documents only, in
app-origin `sessionStorage` under `hosty.auth.app-grant`. `AppIdentityBridge` restores it before its
first identity probe. Leaving an app, switching its pages, opening its same-origin settings surface
and reloading Shell can reuse that grant within the tab. A new tab performs its own initial sign-in.
Browser session restore is not a promised extension of this lifetime.

Standalone documents do not write the grant because their first-party HttpOnly cookie carries the
session. The SDK never writes grants to `localStorage`. Throwing or blocked `sessionStorage` falls
back to document memory. The storage belongs to the app's origin; the embedder cannot read it.
`appFetch` sends the grant only to the same app origin and refuses redirects.

`token_invalid`, `token_revoked`, `token_expired` and `token_app_mismatch` remove the grant, as does
`forgetAppGrant`. `reauth_required` keeps it: app identity remains valid when the separate
[activity window](../app-activity-window/feature.md) expires. Popup renewal replaces it with the
renewed grant. The Harness server continues to keep credentials out of durable session records;
browser session persistence does not change that boundary.
Harness's HTTP 200 identity probe retains Core's error metadata so the bridge can clear a rejected
stored grant while still classifying recovery and denial by Core's HTTP status.

## Silent initial sign-in

While resolving its first identity, an embedded bridge with no restored grant attempts silent
sign-in after a `not-present` or `expired` probe. It generates independent random state and a
private S256 verifier, persists the attempt in app-origin sessionStorage, applies a once-per-tab,
per-app guard, and submits an app-owned form to Core's `sign-in-intent` route using `prompt=none`.
A failed storage round trip leaves the app mounted and offers the explicit popup. The redirect URI
is the current app URL without a fragment.

Core accepts this mode only for an actual iframe navigation with the exact app Origin, valid state
and S256 challenge. It validates the callback against the installed app, stores a five-minute
immutable intent and sets a unique HttpOnly browser nonce. The 303 continuation requires that
nonce before it can claim the intent once and issue a code.
[App code exchange](../app-code-exchange/feature.md) defines the complete initiation and proof contract.
The resulting continuation has these outcomes:

| Core result | Redirect back to the app | App result |
| --- | --- | --- |
| Live session and accessible app | `code` and `state` | Exchange through the app server, persist the grant, clean the URL and resolve identity |
| No live session | `error=login_required` and `state` | Inline **Sign in via Hosty** button |
| Disabled, unassigned or otherwise denied user | `error=access_denied` and `state` | Access-denied card |

The bridge ignores missing or mismatched state and does not exchange that code. Matching state
selects only its locally created attempt; the app exchanges the code with that private verifier,
and its server authenticates to Core with its own service token. A code alone cannot redeem a grant. Core never sends a
silent frame to `/login`, whose framing policy remains restrictive. Ordinary top-level `/open`
navigation and the app-owned `web_message` popup retain their existing behavior.

Silent codes establish identity only. They do not establish privileged app activity; an action that
needs activity still uses the Core popup. Their Core-session provenance participates in explicit
logout revocation. Logout clears a stored grant when the app next presents it and receives identity
rejection.

A bridge that has been active never starts a silent redirect after session expiry. It keeps the
mounted content and unsaved work, and offers the inline recovery button. Popup initiation still
requires a user gesture inside the app frame. Shell does not answer authentication messages, change
the frame URL or broker app credentials.

## Deployment

Core's session cookie remains host-only and `SameSite=Lax`. The silent path succeeds when the
browser sends both its session and the matching intent nonce to Core from the frame. Hosty uses one flow and no browser detection.
Where the cookie is unavailable, Core returns `login_required` and the existing popup remains the
sign-in path; the successful grant is then kept for the tab.

The recommended deployment puts Core, Shell and apps on subdomains of one registrable domain,
such as `core.example.com`, `shell.example.com` and `media.example.com`. A parent that is a public
suffix, including a shared dynamic-DNS zone, does not satisfy this rule. Configure these addresses
through [Public Origins](../public-origins/feature.md) and, where used,
[Cloudflare ingress](../cloudflare-ingress/feature.md).

Generated HTTP DNS Core origins now require an isolated literal-IP Core origin or HTTPS before
creating an intent. Source development uses a `[::1]` public Core origin with app hosts elsewhere;
its cross-site arrangement uses the popup fallback. A cookie
probe on 2026-10-05 showed Chromium sending Core's Lax cookie from Shell's frame and Safari treating
the same origins as cross-site without sending it. This is evidence of deployment behavior, not a
browser-specific policy in the product.

The silent flow adds no embedder permission. A cross-origin parent cannot read the app frame's
state, URL, code or grant. Core does not restrict an app's framing parents. Same-site embedders can
still frame another app and overlay its UI.

Cookies ignore ports. A process listening on another port of the same Core or app hostname can
receive that hostname's cookies; separate app origins do not prevent that capture. Embedded sign-in
does not resolve this boundary.

## Verification

On 2026-10-05, acceptance passed against the final source Core in a uniquely isolated Core-managed
instance, using normal setup, password login and production app bundles. In Chromium's natural
same-site deployment, Demo App and Harness signed in on their first embedded open with zero clicks.
Their silent grants had `ActiveUntil: null`. Harness's Source providers request returned
401 `reauth_required`; a user-initiated Core popup renewed activity and the retry returned 200.

The cookie-blocked outcome used controlled browser request interception to suppress iframe cookies
while retaining the browser's `Sec-Fetch-Dest: iframe`. Each first silent attempt returned one
302 `login_required`, followed by the inline button without a loop. After one popup sign-in per app,
Demo App retained its authorization-header identity and stored grant through leaving and returning,
People and Settings page switches, panel use and Shell reload, without another sign-in button.
Harness retained identity through the same-origin Shell settings remount and reload. A fresh
no-opener tab showed the initial button. These checks exercise both Core outcomes without a browser
matrix; the blocked-cookie case is controlled, rather than evidence of Chromium blocking cookies
in that deployment.

A real page on `127.0.0.1` framed the Core-managed Demo App with interception disabled. Its one
silent attempt returned 302 `login_required`, and the app cleaned its callback URL. Normal Core
logout used the primary session cookie and CSRF pair and returned 200. Harness's next identity
probe cleared its previously stored grant and showed the button. A fresh same-site app frame after
logout also returned `login_required` once and showed the button.

Mounted-expiry acceptance moved only genuinely issued Demo App grants from the isolated instance
past their expiry. A real `appFetch` request to `/api/people` returned 401 `app_identity_required`,
cleared the stored grant and showed **Renew access**. A QA-only textarea inside the existing app
`main` retained its typed draft; the frame URL stayed unchanged and there were zero frame
navigations. Browser automation keeps user activation active, so this QA document alone overrode
`navigator.userActivation.isActive` to `false` to model a background request. Browser session
restore was neither configured nor tested, and no restored session lifetime is promised.

The final automated runs passed: Core 2,480 tests with four opt-in tests skipped, SDK 209, Harness
506, Shell 267, Marketplace 104, Telemetry UI 10 and Demo App four. The SDK package and all changed
web apps passed production builds. The four opt-in Docker/Node and companion torrent/VPN integration
tests were not enabled. Core was built after the final code edit with a separate temporary artifacts
directory; its `apps` symlink pointed at this checkout so manifest fixtures resolved correctly.
The final verification commands ran from the repository root:

```bash
dotnet test apps/core/tests/Haas.Hosty.Core.Tests/Haas.Hosty.Core.Tests.csproj --no-build --no-restore --artifacts-path /private/tmp/hosty-silent-sign-in-artifacts
npm run sdk:test
npm run harness:test
npm run shell:test
npm run marketplace:test
npm run telemetry-ui:test
npm run test --workspace @haas/hosty-demo-app
npm run build --workspace @hosty-sdk/app
npm run shell:build
npm run build --workspace @haas/hosty-harness-web -- --webpack
npm run build --workspace @haas/hosty-marketplace -- --webpack
npm run telemetry-ui:build
npm run demo-app:build
```

## Testing Expectations

- Embedded grants survive module/document recreation in the tab, restore before the first probe,
  clear on identity rejection and explicit forget, remain on `reauth_required`, and tolerate blocked
  storage. Standalone grant persistence and `localStorage` writes are excluded.
- Harness protected settings use the restored own-app grant and retain the server-side boundary
  against writing credentials to durable session records. Its real HTTP 200 identity probe forwards
  revoked and wrong-app error codes, and the bridge clears storage with sign-in and denial UI.
- Core requires exact app Origin, iframe navigation, a locally created S256 attempt and its nonce;
  a known silent nonce refusal returns only a state-bound login-required callback.
- Core preserves redirect-origin validation and atomic one-time intent claim, returns code,
  login-required and access-denied outcomes, never frames login, establishes no silent activity and
  revokes silent grants on explicit logout.
- The bridge's preconditions and once-per-tab guard prevent redirect loops. Missing/mismatched
  state cannot exchange a code; login-required and access-denied returns show their respective UI.
- Identity/activity expiry while mounted preserves unsaved input and never starts a silent redirect.
- Core-managed browser acceptance covers both cookie-reachable and cookie-blocked outcomes,
  recreated frames, page/settings switches, Shell reload, a new tab, explicit logout, a foreign-site
  embedder and expiry while mounted, using normal setup and password login in an isolated instance.

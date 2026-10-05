---
created: 2026-10-02
updated: 2026-10-05
summary: App grants keep identity after their privileged activity window expires, and activity never adds a permission.
components: [apps/core, packages/app-sdk]
---

# App Activity Window

App identity and authority to perform privileged Core operations have separate lifetimes.
An app grant remains usable for identity after its privileged activity expires. Current app
permissions, user role and assignments still constrain every call; activity never adds a permission.

## Browser-established activity

Core stores nullable `ActiveUntil` with each app grant. Exchanging a code issued by a real browser
top-level navigation to `/api/apps/{id}/open` establishes the deadline, including
`responseMode=web_message`.
The navigation uses an isolated Core cookie host and a live Core browser session. Generic code
issuance, diagnostic CLI grants, app service calls and revalidation establish no activity. Old grants
without a deadline need browser renewal for privileged actions.

The frame-only `prompt=none` mode issues identity-only codes, so silently opening an embedded app
establishes no activity. Its resulting grant is still bound to the authorizing Core session for
explicit-logout revocation. [Embedded app sign-in](../embedded-app-sign-in/feature.md) owns that
initial sign-in and the embedded grant's per-tab persistence.

The default is one hour. `HOSTY_AUTH_APP_ACTIVITY_HOURS`, exposed in Core authentication settings,
sets the duration for newly exchanged grants. Calls and revalidation never extend the deadline.
Core also checks that the grant's authorizing browser session exists, belongs to the same user,
and remains live under its idle and absolute limits. This check does not touch the parent session.

Activity expiry returns HTTP 401 `reauth_required` without revoking app identity. Management route
permissions, assistant-provider issuance, workspace/publication operations and assistant MCP
issuance enforce the boundary. Identity-only profile/session routes and installation requests retain
their separate existing authorization and Core confirmation. Delegated tokens without browser
provenance cannot substitute for this authority. Provider child-token introspection checks current
activity again; assistant MCP tokens carry a session lease revision and recheck it on use.
The SDK therefore retains the embedded grant in `sessionStorage` on `reauth_required`; successful
popup renewal replaces it. Identity rejection clears it. Expiry while mounted never starts a silent
redirect or discards the app's draft.

## Recovery without losing work

The JavaScript SDK exposes `configureAppActivity`, `renewAppActivity`, `appActivityNeedsRenewal`,
`appFetch` and `AppActivityBridge`. `AppIdentityBridge` installs recovery after its identity probe
reports an active app, and keeps children mounted through later expiry. The app's identity probe
passes through `activeUntil` and `activityRequired` from Core revalidation. Code exchange passes
through the new deadline. Applications with no Core permissions do not proactively renew.

A trusted click within ten minutes of expiry can proactively open the existing Core sign-in popup.
An expired request emits `APP_SESSION_ENDED`; without browser activation an inline button owns the
popup. Renewal exchanges the code through the app's same-origin endpoint, updates its credential,
and retries the refused request once. It does not navigate or reload the existing document.
Core-review and recovery controls do not also start a competing proactive popup.

Sign-in and renewal use the same SDK notice component: a pale yellow bottom bar with dark text,
an amber top border, a dark primary button and an outlined secondary Later button for renewal.
The shared palette stays visible on both light and dark app backgrounds. Its styles are included by the SDK,
so Shell and embedded apps do not need their own stylesheets for these notices. The bar belongs to
the current app document (or its iframe); the authentication popup itself belongs to Core.

Shell uses `/api/auth/renew` to update its HttpOnly cookie without returning the credential to browser
JavaScript. The endpoint checks the request origin, JSON content type and exchanged app audience.
The Core event stream reconnects and resynchronizes after `APP_ACTIVITY_RENEWED`. Dashboard input,
app frames and other mounted state survive renewal.

The .NET SDK has no browser management client or popup UI. Its provider client already preserves
HTTP status and machine-readable error codes in `HostyProviderException`; server applications pass
401 `reauth_required` to their UI rather than retrying in a background loop. Its identity validator
remains identity-only. No .NET SDK code or version change is needed for this feature.

## Assistant session authority

Harness tool authority is an explicit Core-owned lease, keyed by assistant installation, user and
assistant session ID. `/activity/assistants/{appId}/{sessionId}` displays the decision to the signed-in
administrator on Core's isolated origin. Its same-origin form uses a short-lived, single-use nonce
bound to that browser session and installation. Core stores approved leases under its auth root.
App service credentials cannot create, renew or revoke a lease.

Each approval grants one hour; renewal and revocation are manual. The lease replaces the ordinary
app activity deadline for that conversation's MCP and workspace/publication calls, while both its
approving Core session and the app grant's parent session must remain live. Ordinary browser
activity cannot substitute for this lease. A renewed lease invalidates child tokens from its previous
revision. MCP tokens expire no later than the lease and are rechecked online before use.

Harness shows a per-conversation **Allow tools in Core** / **Renew or revoke in Core** control.
Embedded reviews ask Shell to open the page; Shell derives the assistant app ID from the sending
frame and validates its origin and session-ID syntax. After a decision, polling/focus refresh updates
session credentials and available tools without replacing the run or transcript. Parent-session
expiry returns 401 from the status endpoint so browser identity can recover before lease approval.
Expiry refuses new tool authority; it does not stop the agent run. Sending messages does not extend
the lease. Tool-catalog refresh in settings requires selecting an owned, authorized conversation.

## Verification

On 2026-10-02, the complete Core suite passed 2,427 tests with four existing skips. The additional
Core-owned form/nonce regression passed in the seven-test activity suite. SDK tests passed (156),
Shell tests passed (177 node tests and 74 component tests), and Harness passed its 476-test suite;
the new session-authority component passed separately. The unchanged .NET SDK passed 56 tests. SDK and isolated production Shell/Harness
web builds passed. Harness web used webpack because Turbopack rejected the temporary fixture's
external workspace symlink. Lint completed with two existing Shell warnings.

An isolated Core on port 28770 used normal setup-token bootstrap and interactive password login,
with Docker disconnected and no default distribution apps. Its Core-managed Shell used port 28771
and a 36-second test window. In the in-app browser, expiry showed an inline renewal control; the
Core popup renewed the HttpOnly session and resumed management with the typed Dashboard search
still present. React DOM tests additionally prove that the same mounted input survives activity
and identity expiry.

On 2026-10-03, embedded acceptance passed in Firefox on macOS against the final tested Core build.
A Core-managed SDK probe ran inside Shell with a 36-second activity window and a 36-second app-grant
idle timeout. Normal Core password login established the browser session. Click-triggered renewal
preserved the draft and mount identifier after activity and identity expiry. A separate 60-second
background request then outlived both windows, showed an inline renewal button inside the iframe,
and remained pending without navigation. Clicking that button completed the Core popup exchange
and retried the request successfully (HTTP 200); the exact draft and mount identifier were unchanged.
Renewing Shell afterward also preserved the embedded app. The isolated Core and test apps were
stopped after verification.

The in-app browser's iframe input remained unavailable even after unlocking macOS, so the acceptance
result comes from Firefox's native UI. Safari, Linux and external ingress were not rerun for this
change. The operator's running Core and apps were not restarted.

## Testing Expectations

- Browser-open code exchange establishes activity; generic code, diagnostics and revalidation do not.
- Expiry, revoked/expired parent sessions and alternate credential representations deny privileged
  calls while valid identity-only calls continue; browser renewal restores access.
- Provider and MCP child tokens cannot outlive revoked authority, installations or lease revisions.
- Assistant leases enforce user/session/installation binding, nonce replay refusal, same-origin
  confirmation, fixed expiry, renewal and revocation without terminating a run.
- SDK popup renewal preserves mounted input and retries once; no permission declarations means no
  proactive activity prompt. Shell cookie renewal and event resynchronization preserve page state.
- Embedded authority requests cannot forge the app identity, and Core parent expiry remains recoverable.

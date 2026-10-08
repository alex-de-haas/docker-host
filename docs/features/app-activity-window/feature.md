---
created: 2026-10-02
updated: 2026-10-08
summary: App grants keep identity after their privileged activity window expires, and activity never adds a permission.
components: [apps/core, apps/harness, apps/shell, packages/app-sdk]
---

# App Activity Window

App identity and authority to perform privileged Core operations have separate lifetimes.
An app grant remains usable for identity after its privileged activity expires. Current app
permissions, user role and assignments still constrain every call; activity never adds a permission.

## Browser-established activity

Core stores nullable `ActiveUntil` with each app grant. A real app-origin intent POST followed by
a nonce-bound top-level `/api/apps/{id}/open?requestId=...` continuation establishes the deadline,
including `responseMode=web_message`. The continuation uses an isolated Core cookie host and a live
Core browser session; redemption requires the app service identity and matching S256 proof.

Native in-place renewal uses a separate authenticated `launch-code` request with
`interactiveRenewal: true`. Core accepts this flag only from a live primary-session bearer, with
no kind/audience/grant binding or delegated scopes. A device token, app service or delegated
credential cannot establish this activity. Every Swift renewal opens a fresh normal password-login
sheet, matches the native account and retains the mounted app and saved device credential. Temporary
confirmation sessions remain only in workspace memory for ordinary Core logout cleanup on native
logout, eviction or host replacement; they are never reused to automate renewal.

Generic code issuance, diagnostic CLI grants, app service calls and revalidation establish no activity. Old grants
without a deadline need browser renewal for privileged actions.

The frame-only intent mode `prompt=none` issues identity-only codes, so silently opening an embedded app
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
activity again; assistant MCP tokens bind the app grant and recheck its activity on use.
The SDK therefore retains the embedded grant in `sessionStorage` on `reauth_required`; successful
popup renewal replaces it. Identity rejection clears it. Expiry while mounted never starts a silent
redirect or discards the app's draft.

## Recovery without losing work

[HostyOverlay](../hosty-overlay/feature.md) is the standard root UI in the six repository React
consumers. It shares the existing coordinators, hides mounted content at the known activity deadline,
and validates user identity and required setup before waiting SDK requests resume. Same-user recovery
preserves the component tree; a changed user reloads only the app document and cancels old work.
The lower-level bridges described below remain compatible for existing consumers.

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
JavaScript. The endpoint checks the request origin, JSON content type, private sign-in verifier and exchanged
app audience. It refuses code-only requests locally and uses a fixed-origin, redirect-refusing Core
exchange with its app service credential.
The Core event stream reconnects and resynchronizes after `APP_ACTIVITY_RENEWED`. Dashboard input,
app frames and other mounted state survive renewal.

The .NET SDK has no browser management client or popup UI. Its provider client already preserves
HTTP status and machine-readable error codes in `HostyProviderException`; server applications pass
401 `reauth_required` to their UI rather than retrying in a background loop. Its identity validator
remains identity-only. No .NET SDK code or version change is needed for this feature.

## Assistant activity authorization

Harness conversations share the assistant app's browser-established activity window. Creating or
opening a chat requires no separate Core tool approval. MCP issuance and introspection and assistant
workspace/publication operations check current app activity, a live authorizing Core sign-in,
assistant installation and the acting user's current access. Existing assistant-target assignments
and operation permissions remain required; an active session never adds a grant.

The session ID still identifies tool context and workspace ownership. It cannot create or extend
activity. App service credentials, diagnostic grants and silent identity-only sign-in cannot establish
activity. Expiry uses the ordinary SDK recovery flow, and normal browser renewal supports all chats
using the renewed app credential. Calls and background revalidation do not extend the deadline.

Harness synchronizes the selected conversation's in-memory credentials on mount, focus and
`APP_ACTIVITY_RENEWED`, including an existing run. Recovery preserves the transcript and draft and
requires no new message. The refresh endpoint requires the authenticated app user to own the chat
and a same-origin request; Core still independently checks every privileged call. Other conversations
pick up the current credential when opened or sent a message. Native Normal/Autonomous rules remain
independent, and activity expiry does not stop the agent's native run.

The retired per-conversation review/status endpoints and Shell popup handling are removed. The SDK's
legacy message parser remains inert for compatibility. Old `assistant-session-authority.json` files
are unused and confer no access; no migration or operator-data deletion is required. Previously
issued MCP tokens carrying a lease revision are refused and reminted through normal issuance.
Deploy Core 0.125.0 before Harness 0.46.0; older Core still requires the retired conversation lease.

## Verification

On 2026-10-08, removal of per-chat consent passed the 32 focused Core activity/MCP/workspace/source
HTTP tests and the full Core suite (2,961 passed, four existing opt-in integration skips). The exact
Core project builds with isolated output under `build/chat-activity-artifacts`; tests also use this
directory because repository-contract fixtures locate manifests relative to their assembly.
Harness passed 511 tests, including same-origin/ownership credential refresh, recovery during an
in-flight update and draft preservation. Shell passed 182 Node and 187 component tests.
Harness type checking/lint and Harness/Shell webpack production builds passed. Shell lint has no
errors and two existing warnings. Version consistency and the generated documentation index pass.

The verification commands are `dotnet test` for `Haas.Hosty.Core.Tests.csproj` and `dotnet build` for
`Haas.Hosty.Core.csproj`, both with the isolated artifacts path; `npm run harness:test`,
`npm run shell:test`, `npm run harness:lint`, `npm run shell:lint`, and each web workspace's
`npm run build -- --webpack`. No live operator Core/app restart, grant change or paid model call was
performed. Browser acceptance of the new release is not claimed; the running installation was not
replaced. The HTTP fixtures verify the actual Core endpoint pipeline with isolated in-process users.

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

- Nonce-bound top-level browser intent exchange establishes activity; generic code, diagnostics and
  revalidation do not. Native flagged renewal requires a live primary bearer and fresh same-account
  login in Swift; device/delegated/service credentials are refused and a timer cannot reuse authority.
- Expiry, revoked/expired parent sessions and alternate credential representations deny privileged
  calls while valid identity-only calls continue; browser renewal restores access.
- Provider and MCP child tokens cannot outlive revoked authority, installations or assistant-target grant revisions.
- Multiple assistant chats work with one active app grant and no chat approval. App activity expiry,
  parent expiry/idle/revocation, wrong audience, missing permissions and changed installations refuse
  MCP and workspace operations; normal browser recovery restores authorized access.
- Credential refresh enforces chat ownership and same-origin app authentication, handles renewal
  during an in-flight refresh, and preserves the run and draft without opening another review.
- SDK popup renewal preserves mounted input and retries once; no permission declarations means no
  proactive activity prompt. Shell cookie renewal and event resynchronization preserve page state.
- Core parent expiry remains recoverable through standard app authentication.

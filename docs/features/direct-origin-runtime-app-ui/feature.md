# Direct Origin Runtime App UI

Created: 2026-06-04
Updated: 2026-10-05

Shell opens runtime app UIs from the app's own origin. The app document owns its sign-in flow and
protected API transport. Core delivers authorization codes directly to the app through validated
navigation or a state-bound popup response. Shell mounts the selected frame and receives no target
code or grant.

## Identity flow

An app-owned form submits a public S256 challenge and state to Core's `sign-in-intent` endpoint.
Core checks the app Origin, creates an isolated nonce cookie and redirects to an immutable one-time
`/open?requestId=...` continuation. That continuation verifies the nonce before login or issuance.
Missing Core identity continues through the password form; silent frames receive state-bound errors.
App popups validate their response window, Core origin and initiation state.

The app server exchanges `{ code, codeVerifier }` with its `HOSTY_APP_SERVICE_TOKEN` bearer. Core
checks both the app and the proof before consuming the code; wrong-app or wrong-proof requests leave
it usable by the original attempt. Public handlers reject code-only requests before contacting Core.
See [App Code Exchange](../app-code-exchange/feature.md).

The server validates the resulting own-app grant, writes an app-origin HttpOnly cookie and returns
the grant to its own SDK browser transport. Embedded grants survive frame recreation through
app-origin `sessionStorage`; standalone documents use their first-party cookie. Grants never go to
Shell or `localStorage`. Mounted expiry keeps the app's content and offers inline popup recovery.

## App requirements

- Declare a public UI endpoint and entrypoint in `manifest.json`; app browser origins constrain
  Core's sign-in redirect allowlist.
- Use `HOSTY_CORE_PUBLIC_ORIGIN` for browser navigation and `HOSTY_CORE_ORIGIN` for server calls.
- Generate proof only in the app-owned attempt, exchange code plus verifier with the server-held
  app service token, and refuse exchange redirects.
- Configure an isolated Core hostname: HTTPS uses `__Host-` intent cookies; HTTP requires a literal
  IP distinct from all app origins. Verify storage before full-document recovery navigation.
- Keep Core and app cookie namespaces separate; configure protocol-appropriate app-cookie attributes.
- Use protected app-local API requests through the SDK's own-origin bearer transport and classify
  Core 401, 403 and unavailable outcomes as recovery, denial and retry respectively.
- Keep the existing sandbox: popup support enables sign-in; the frame navigates its own document.

## Demo App

The repository Demo App implements `/api/auth/app-code` and `/api/auth/identity`, with client-loaded
protected resources. It runs through Core-managed lifecycle for Shell, app-identity and assignment
acceptance. [App auth separation](../app-auth-origin-separation/feature.md) describes the full contract.

## Testing Expectations

- Core-managed standalone open and app-owned embedded sign-in exchange a code with the target
  service identity and load protected content.
- Recreated app frames reuse only their own tab grant; Shell sees no app code or credential.
- Missing/wrong-app credentials and missing/wrong proof fail before code consumption, and the matching app can
  still redeem the code.
- Mounted expiry preserves app state and provides inline recovery without a silent reload.

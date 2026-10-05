# App Auth And Origin Separation

Created: 2026-06-03
Updated: 2026-10-05

Hosty-aware runtime apps authenticate through Core-issued app-scoped authorization codes and
app-local sessions. Core owns password login, setup, recovery, invitations, OIDC callbacks,
browser sessions, CSRF, user access and app assignments. Shell uses its own app grant; it does not
receive another app's code or credential.

## App-owned sign-in

1. The app creates a fresh private verifier and independent 256-bit state. It submits an app-owned
   form to `POST /api/apps/{appId}/sign-in-intent` with the redirect URI and public S256 challenge.
2. Core validates the exact app Origin and browser navigation context. It stores a five-minute intent,
   sets an isolated HttpOnly nonce cookie and returns a 303 to `/open?requestId=...`. That continuation
   checks the nonce before login and claims the intent once after normal account/access checks.
3. Core returns a five-minute single-use code directly to the app. Popup messages contain only code
   and state; silent frames return a state-bound code or login/access error without framing login.
4. The app server exchanges `{ code, codeVerifier }` at `/api/auth/apps/token` with
   `Authorization: Bearer <HOSTY_APP_SERVICE_TOKEN>`. Core atomically checks the calling app and proof
   before consuming the code. Missing/malformed proof is refused locally by public app handlers.
5. The app validates its own grant, writes an app-origin HttpOnly cookie and returns the grant to its
   own browser transport. Embedded documents can retain it in app-origin `sessionStorage` for that tab.
6. Protected app calls revalidate through `/api/auth/apps/revalidate`, authenticating with the service
   token and presenting the app grant. A grant from another app is refused.

Missing or invalid exchange service credentials return 401 `app_service_token_invalid`. A wrong app
or proof receives 401 `invalid_code` without consuming the target code. Correct-proof replay and expiry
retain `code_consumed` and `code_expired`. Refusal audit records contain known app IDs and reasons,
never code, verifier, challenge, nonce or service credentials. Existing unbound code records are refused;
already-issued grants retain their lifecycle. See [App Code Exchange](../app-code-exchange/feature.md).

Ordinary `/open?redirectUri=...` links bootstrap the validated app without issuing a code. A direct
proof-bearing GET is refused; native Shell intercepts its specifically validated app-origin request
before dispatch and uses the authenticated challenge-bearing launch API instead.

## Sessions and recovery

App grants are opaque `hostyg_` credentials backed by hash-only Core records. Revalidation checks
user enablement, app access and the auth revision, slides the idle window and respects absolute
expiry. `expiresInSeconds` describes the remaining absolute lifetime; app cookies derive their
`Max-Age` from it. Explicit Core logout revokes the grants it authorized. Ordinary Core-session
expiry does not end established app identity. See [session lifecycles](../auth-session-lifecycle/feature.md).

Apps classify Core 401 as recoverable, 403 as terminal denied access, and network/503 failures as
unavailable. Recovery never auto-redirects a denied user or deletes a cookie on a transient outage.
Standalone apps navigate through Core with a once-per-tab loop guard. Embedded initial resolution
can try silent sign-in once; subsequent recovery uses the app-owned popup from a user gesture.
A mounted app retains its content and unsaved work during identity or activity expiry.

App identity and privileged [activity](../app-activity-window/feature.md) are separate. Silent codes
establish identity only. Privileged Core calls need the app's confirmed permissions, current user
and activity window; the popup renews activity without giving Shell authority over the target app.

## Origins and integration

`HOSTY_CORE_ORIGIN` is the server-reachable Core origin for exchange, revalidation and scoped APIs.
`HOSTY_CORE_PUBLIC_ORIGIN` is the browser-reachable origin for navigation and popup recovery.
`HOSTY_APP_ID` identifies the installed app; `HOSTY_APP_SERVICE_TOKEN` authenticates its server.
Service tokens belong on the server and never in browser code, cookies, URLs or log output.

[Local browser origins](../local-browser-origins/feature.md) give Core and each app distinct generated
hostnames, including a non-default instance suffix. [Explicit public origins](../public-origins/feature.md)
retain their configured hostnames. Browser intents require an isolated Core cookie host. HTTPS uses
unique `__Host-` nonce cookies; HTTP requires a literal-IP Core host distinct from every installed
app origin. The source development profile uses Core `[::1]` and app `localhost` names. Unsafe
topology receives an actionable refusal. Keep app-specific cookie names, validate redirect origins and
use explicit message target origins. Cookies ignore ports, so a listener on another port of the
same hostname can receive that hostname's cookies; origin-scoped app storage does not change this.

App cookies use `SameSite=None; Secure` over HTTPS and `SameSite=Lax` over plain HTTP. The SDK's
own-origin bearer transport covers embedded documents where app cookies are unavailable. A shared
DNS suffix alone is not evidence that Core's Lax cookie reaches an embedded frame.

The SDK's server handler implements the exchange and app-cookie boundary; its React bridge and
`appFetch` implement the app-owned browser recovery transport. The Demo App exercises both embedded
and standalone entry. [Direct-origin app UI](../direct-origin-runtime-app-ui/feature.md) describes
how Shell mounts app-owned documents.

## Testing Expectations

- Missing, invalid and wrong-app service credentials or proof cannot consume a target app's code; a matching
  caller can subsequently redeem it. Single use, expiry, access/revision checks and activity survive.
- Verifiers, challenges, nonce cookies and credentials do not appear in refusal audit entries.
- Relayed intent links cannot issue a code in another browser; missing nonce and direct proof GETs fail.
- Legitimate parallel attempts remain independent and each intent issues at most one code.
- App APIs prefer the own-origin bearer to a stale cookie and revalidate with their service token.
- Core-managed password-login acceptance covers standalone, silent embedded and popup entry,
  identity denial, transient outage and mounted expiry without discarding app state.

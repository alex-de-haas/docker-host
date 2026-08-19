# App Auth And Users

Runtime apps should use Core-owned app auth and app-local sessions.

## App Session Flow

1. Core creates an app open link with a short-lived authorization code.
2. Shell opens the app origin with the code.
3. The app exchanges the code through `/api/auth/apps/token`.
4. The app stores the returned app identity token in an app-origin HttpOnly cookie. Derive the cookie's `Secure`/`SameSite` attributes from the effective request protocol (`X-Forwarded-Proto` or the request URL): use `SameSite=None; Secure` only over https, and fall back to `SameSite=Lax` without `Secure` on plain http — browsers silently drop `Secure` cookies on insecure origins (Safari even on localhost), which breaks the app session. Set the cookie `Max-Age` from the exchange response `expiresInSeconds` (time to the token's absolute expiry); do not hardcode a fixed cap.
5. The app revalidates through `/api/auth/apps/revalidate`, authenticating with `Authorization: Bearer <HOSTY_APP_SERVICE_TOKEN>`. Core rejects revalidation when the identity token was issued for a different app.

## Core Origin Variables

Two origins are injected; use the right one for the caller:

- `HOSTY_CORE_ORIGIN` — server-reachable (container/host-internal). Use for server-side calls: code exchange (`/api/auth/apps/token`), revalidation (`/api/auth/apps/revalidate`), scoped directory.
- `HOSTY_CORE_PUBLIC_ORIGIN` — browser-reachable. Use for anything the user's browser navigates to, e.g. the standalone recovery redirect below. Never send the browser to `HOSTY_CORE_ORIGIN`.

## Handling Expired Or Invalid Sessions (Recovery)

> Design reference: [`docs/features/auth-session-lifecycle/feature.md`](../../../docs/features/auth-session-lifecycle/feature.md). Fully shipped: the 401/403 recovery contract, the Shell `hosty:auth-required` responder, opaque server-side app session grants (Core stores only the token hash), and sliding idle + absolute session lifetimes. The app identity token is an opaque `hostyg_` value — never assume a JWT — and its `expiresInSeconds` is the grant's absolute lifetime; set the app cookie `Max-Age` from it.

An app session ends eventually (idle/absolute expiry, revoke, admin change). The app must **recover, not dead-end** — never render a bare "not authorized" page with no way forward. Classify the revalidation outcome into three cases and act differently:

- **Recoverable — Core `401`** (`token_expired`, `token_invalid`, `token_revoked`, or any code error): clear the app cookie and start re-authorization (below).
- **Terminal — Core `403`** (`user_disabled`, `app_access_denied`, `system_app_admin_required`, `token_app_mismatch`): render an access-denied state. Do **not** auto-redirect — the user is authenticated but not allowed, and redirecting loops forever.
- **Core unavailable — `503` / network error / timeout** (app-side classification): keep the cookie and offer a retry. A transient Core outage must never log the user out.

Pick the recovery channel by embedding mode (`window.self === window.top` → standalone; otherwise embedded).

### Standalone Recovery

Top-level page, recoverable failure:

1. Navigate the **top window** to `{HOSTY_CORE_PUBLIC_ORIGIN}/api/apps/{appId}/open?redirectUri=<current app URL>`. Build the redirect URI from `location.origin + location.pathname + location.search` — **exclude any `#` fragment**, which Core rejects (`redirect_uri_invalid`) and which would not survive the redirect anyway. Core issues a fresh code and redirects back with `?code=`; if the Core session is also gone, Core routes through `/login` and returns the user to the same app URL afterward.
2. **Guard against loops:** auto-navigate at most once per tab (e.g. a `sessionStorage` flag cleared on a successful code exchange). If the flag is already set, render an explicit **"Sign in via Hosty"** button pointing at the same URL instead of redirecting again.
3. On return, exchange the `?code=` as in the App Session Flow and reload.

### Embedded (iframe) Recovery

Embedded in Shell, the app must **not** navigate the top window — the Shell iframe sandbox forbids top navigation. Use `postMessage`:

1. `window.parent.postMessage({ type: "hosty:auth-required", appId: <appId> }, <shellOrigin>)`. Never put tokens or secrets in the payload.
2. Shell verifies the message source/origin/appId, re-issues a launch code, and reloads the iframe with a fresh `?code=`.
3. **Learn `shellOrigin` from the parent's own postMessage handshake**, not from `document.referrer` — the referrer changes to the app's own origin after the identity bridge self-reloads, which silently breaks the target origin. See the marketplace `embedding-origin` handling for the pattern.
4. **Non-Shell fallback:** if no parent response arrives within a few seconds (the app is embedded by something other than Shell), render the sign-in card whose button opens the standalone `/open` URL in a **new tab**.

### What Not To Do

- Do not render a terminal "not authorized" page with no recovery affordance.
- Do not delete the app cookie or trigger recovery on `503`/network errors.
- Do not auto-redirect on `403` (terminal denial).
- Do not navigate the top window from inside a Shell iframe.
- Do not derive the embedded target origin from `document.referrer`.

## Direct Probes

```bash
TOKEN="$(hosty apps identity com.haas.demo-app --user user@docker-host.local --format token)"
curl -H "X-Docker-Host-Identity: $TOKEN" <assigned-demo-app-origin>/api/auth/identity
```

## Scoped App Directory

Runtime apps that need assigned Host users can call:

```text
GET /api/internal/apps/{appId}/directory/users
Authorization: Bearer <HOSTY_APP_SERVICE_TOKEN>
```

The directory is scoped to enabled users explicitly assigned to the app, plus enabled Host admins (who have implicit access to every app and are never stored as explicit assignments).

## Asking The Assistant

An embedded app can hand text to the operator's assistant with `askAssistant(text)` from
`@hosty-sdk/app`, which posts `hosty:ask-assistant` to the embedder:

```ts
import { askAssistant } from "@hosty-sdk/app";

askAssistant(`${appName} logged ERROR at ${when}:\n\n${message}`);
```

**It fills the operator's draft. It does not send.** That is the contract, not a limitation of the
current version: app-provided text entering a model that holds host shell is the same trust boundary
that keeps MCP providers off by default, and an error message is exactly the shape a prompt injection
arrives in. The operator reads it, sees which app it came from, and decides.

- **Plain text only.** No structured payload beyond the text: shape the operator cannot read at a
  glance is shape they cannot check.
- **No reply.** The call answers whether the message could be *posted*, never whether anyone acted on
  it — that is the operator's business.
- **Safe to call unconditionally.** Standalone there is no embedder to hear it; an embedder with no
  assistant ignores it.
- **The embedder caps the length** (4000 characters) and verifies the sender against its own DOM, so
  a message that is not from the mounted app frame's own origin is dropped with a console warning.
  Do not pre-truncate; do not expect a message from another origin to arrive.

Shell reveals the assistant panel, selects its tab, and forwards the text with the app id it mounted
— never one the frame claims.

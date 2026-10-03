# App Auth And Users

Runtime apps should use Core-owned app auth and app-local sessions.

## Local Sign-In And Test Boundaries

Core `/login` requires an email and password in every environment, including Development. There is
no user-selector login or `POST /api/auth/session` creation API. For a new isolated validation data
root, start Core and run `hosty --data-root <absolute-test-root> auth setup-token`; complete the Core
setup form. Existing passwordless development accounts use `auth recovery-token` against that same
root. Recovery changes the credential and revokes existing sessions. Do not create default users,
passwords or browser-session shortcuts in runtime apps or development launch scripts.

Browser acceptance must use normal password login and Core-managed app launch. In-process test
fixtures may seed their own isolated stores, but those sessions do not verify the browser login
flow. A CLI app-identity token remains a direct-endpoint diagnostic only.

## App Session Flow

1. The app navigates to Core or opens its sign-in popup. Core checks the user and app assignment.
2. Core returns a short-lived single-use code directly to the app; Shell does not mint it.
3. The app exchanges the code through `/api/auth/apps/token`.
4. The app validates the exchanged token against its own service identity, then stores the app identity token in an app-origin HttpOnly cookie. Derive the cookie's `Secure`/`SameSite` attributes from the effective request protocol (`X-Forwarded-Proto` or the request URL): use `SameSite=None; Secure` only over https, and fall back to `SameSite=Lax` without `Secure` on plain http — browsers silently drop `Secure` cookies on insecure origins (Safari even on localhost), which breaks the app session. Set the cookie `Max-Age` from the exchange response `expiresInSeconds` (time to the token's absolute expiry); do not hardcode a fixed cap.
5. The app revalidates through `/api/auth/apps/revalidate`, authenticating with `Authorization: Bearer <HOSTY_APP_SERVICE_TOKEN>`. Core rejects revalidation when the identity token was issued for a different app.

## Core Origin Variables

Two origins are injected; use the right one for the caller:

- `HOSTY_CORE_ORIGIN` — server-reachable (container/host-internal). Use for server-side calls: code exchange (`/api/auth/apps/token`), revalidation (`/api/auth/apps/revalidate`), scoped directory.
- `HOSTY_CORE_PUBLIC_ORIGIN` — browser-reachable. Use for anything the user's browser navigates to, e.g. the standalone recovery redirect below. Never send the browser to `HOSTY_CORE_ORIGIN`.

## Handling Expired Or Invalid Sessions (Recovery)

> Design reference: [`docs/features/auth-session-lifecycle/feature.md`](../../../docs/features/auth-session-lifecycle/feature.md). Implemented: the 401/403 recovery contract and opaque server-side app session grants (Core stores only the token hash), and sliding idle + absolute session lifetimes. The app identity token is an opaque `hostyg_` value — never assume a JWT — and its `expiresInSeconds` is the grant's absolute lifetime; set the app cookie `Max-Age` from it.

An app session ends eventually (idle/absolute expiry, revoke, admin change). The app must **recover, not dead-end** — never render a bare "not authorized" page with no way forward. Classify the revalidation outcome into three cases and act differently:

- **Recoverable — Core `401`** (`token_expired`, `token_invalid`, `token_revoked`, or any code error): clear the app cookie and start re-authorization (below).
- **Terminal — Core `403`** (`user_disabled`, `app_access_denied`, `token_app_mismatch`): render an access-denied state. Do **not** auto-redirect — the user is authenticated but not allowed, and redirecting loops forever.
- **Core unavailable — `503` / network error / timeout** (app-side classification): keep the cookie and offer a retry. A transient Core outage must never log the user out.

Pick the recovery channel by embedding mode (`window.self === window.top` → standalone; otherwise embedded).

### Standalone Recovery

Top-level page, recoverable failure:

1. Navigate the **top window** to `{HOSTY_CORE_PUBLIC_ORIGIN}/api/apps/{appId}/open?redirectUri=<current app URL>`. Build the redirect URI from `location.origin + location.pathname + location.search` — **exclude any `#` fragment**, which Core rejects (`redirect_uri_invalid`) and which would not survive the redirect anyway. Core issues a fresh code and redirects back with `?code=`; if the Core session is also gone, Core routes through `/login` and returns the user to the same app URL afterward.
2. **Guard against loops:** auto-navigate at most once per tab (e.g. a `sessionStorage` flag cleared on a successful code exchange). If the flag is already set, render an explicit **"Sign in via Hosty"** button pointing at the same URL instead of redirecting again.
3. On return, exchange the `?code=` as in the App Session Flow and reload.

### Embedded (iframe) Recovery

Use the SDK `AppIdentityBridge` around protected client content. It offers a sign-in button that
opens Core from a user gesture, validates the response window/origin/state, and exchanges the
single-use code on the app's own server. Custom `renderState` views must wire `state.signIn` and
show `state.error` when present. The password form belongs to Core.

Use `appFetch` from `@hosty-sdk/app/browser-auth` for all protected same-origin API calls, including
streams. The bridge keeps the app-only grant in document memory when iframe cookies are blocked;
`appFetch` attaches it as an explicit bearer and starts recovery on 401. The server reads the bearer
before a possibly stale app cookie and revalidates it with its own service credential. A server-only
cookie reader is insufficient for this browser mode. Never store grants in localStorage or
sessionStorage, send them to Shell, or rely on Shell to mint another app's credentials.

The frame keeps its sandbox. Sign-in needs popup support, not top-navigation permission or
`apps.install`. Test both embedded and standalone entry; SSR-only protected pages need an explicit
client loading path because a document-memory grant cannot authenticate the initial HTML request.

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

The receiver decides whether to keep a draft or start immediately. Hosty Harness defaults to a draft;
its explicit immediate-handoff setting applies equally to authorized app and user requests. No field
claims to prove who authored the prompt. Authentication and tool permissions still apply.

- **Plain text only.** No structured payload beyond the text: shape the operator cannot read at a
  glance is shape they cannot check.
- **No reply.** The call answers whether the message could be *posted*, never whether anyone acted on
  it — that is the operator's business.
- **Safe to call unconditionally.** Standalone there is no embedder to hear it; an embedder with no
  assistant ignores it.
- **The embedder caps the length** (4000 characters) and verifies the sender against its own DOM, so
  a message that is not from the mounted app frame's own origin is dropped with a console warning.
  Do not pre-truncate; do not expect a message from another origin to arrive.

Shell prepares and finalizes a version-1 handoff with the text and the app ID it mounted, then opens the returned UI destination. It does not trust an app ID claimed by the frame.

## User access and administrative operations

Core applies assignments to both ordinary and system apps. Enabled administrators have implicit
access; other users need explicit assignment, including for Shell. Do not treat `role: system`
as proof that every authenticated caller is an administrator. Check operation-level roles in
the app; Core management also checks the user separately from the calling app's grants.
Standalone login goes through Core and returns to the requesting app, without requiring Shell.

## Shell transport transition (2026-10-01)

Shell uses its own app grant and confirmed app permissions, not the primary Core cookie. Never
restore cross-app launch-code or delegated-token minting to Shell as an implicit privilege.
Profile and provider-connection UI belongs to apps. Core `/api/profile` accepts a service token
plus an app grant for current-user profile reads and edits; no `users.read/manage` grant is
required for this self-service API. It returns ID/email/display name and edits only display name;
never use it to expose provider connections, Git identity, roles or assignments. Ownership follows
the acting user, never a supplied ID. Shell uses its same-origin BFF and has no `apps.sources`.
Harness settings owns source-provider UI. `/api/source-connections` reads/mutations require
`apps.sources`, the current administrator and connection ownership; stored tokens never leave Core.
Device authorization binds internally to the app grant's live parent browser session. Private-source
installation/binding requires both `apps.install` and `apps.sources`, connection ownership and final
Core confirmation. Harness owns the selection/rebinding UI; configuring a connection alone does not
authorize installation or MCP delegation. Core retains credential issuance
(`/account/tokens`) and OAuth consent; it serves no profile/source-settings pages. The JavaScript SDK supports app-owned popup recovery. Assistant-to-target MCP grants and the remaining
acceptance matrix are tracked in `docs/features/local-browser-origins/plan.md`; app login does not
authorize cross-app tools.

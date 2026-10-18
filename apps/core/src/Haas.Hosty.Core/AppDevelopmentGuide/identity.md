# Identity and direct HTTP protocol

Core-managed launch injects HOSTY_APP_ID, HOSTY_APP_SERVICE_TOKEN, HOSTY_CORE_ORIGIN (server)
and HOSTY_CORE_PUBLIC_ORIGIN (browser). Keep the service token server-side. Protected app APIs
validate the app's own opaque grant; do not decode it as a JWT or trust client-supplied user/role.
The bootstrap serves public UI/health, then authenticates protected data. Running standalone
without Core is not acceptance evidence for identity, assignment or Shell embedding.

## Browser initiation

Use the SDK bridge when available. A direct implementation first reads
`GET <CORE_ORIGIN>/api/auth/apps/protocol` and expects `{ "version": 2 }` on this Core.
Unknown, malformed or unavailable metadata must not downgrade authentication.
Generate independent random state and a 32-byte random private PKCE verifier on the app origin;
encode the verifier with base64url and derive the public challenge as base64url SHA-256 of its ASCII
bytes. Keep the verifier in the originating tab's private attempt storage, never in a URL or message.

Navigate an app-owned form to the configured Core PUBLIC origin:

```http
POST /api/apps/com.example.notes/sign-in-intent
Content-Type: application/x-www-form-urlencoded
Origin: https://notes.example.test

redirectUri=https%3A%2F%2Fnotes.example.test%2F&state=PUBLIC_RANDOM_STATE&codeChallenge=PUBLIC_S256_CHALLENGE&codeChallengeMethod=S256
```

This is a browser navigation, not a server curl login: Core checks Origin and navigation metadata,
binds its own nonce, and continues through normal password login. The redirectUri must be an
approved app callback. Core and app must use separate cookie hostnames (different ports alone do
not separate cookies). Local Core deployments support loopback IPs and named localhost with their
own nonce-storage handling. Never invent a default password, seeded administrator or user picker.
A public app-open URL is a credential-free entry point, not a sign-in proof.

On callback, match the locally stored state, take that attempt's verifier once, strip code/state
from the address bar, then send code and verifier only to the app's own exchange handler. Embedded
popup completion must verify the exact window, origin and state. Do not give app grants to Shell.

## Server exchange and protected request validation

The app server sends to HOSTY_CORE_ORIGIN with redirects disabled and a bounded timeout:

```http
POST /api/auth/apps/token
Authorization: Bearer <HOSTY_APP_SERVICE_TOKEN>
Content-Type: application/json

{"code":"<single-use-code>","codeVerifier":"<private-verifier>"}
```

A successful response includes `accessToken`, `tokenType`, `expiresAt`, `expiresInSeconds` and
possibly `activeUntil`/`continuity`. Revalidate before establishing the app session:

```http
POST /api/auth/apps/revalidate
Authorization: Bearer <HOSTY_APP_SERVICE_TOKEN>
Content-Type: application/json

{"accessToken":"<opaque-own-app-grant>"}
```

Success includes `active: true`, `appId`, `userId`, `hostRole`, `expiresAt` and possibly
`activeUntil`, `activityRequired`, `continuity`. Require active true, the expected app and a usable
user ID; malformed success is unavailable, not authenticated. Apply operation-specific role checks
after authentication. App assignment and service permissions are separate from the user's role.

Store the own-app grant in a scoped HttpOnly cookie, Path=/, with Max-Age from expiresInSeconds.
HTTPS uses SameSite=None; Secure, plain HTTP SameSite=Lax. For embedded tabs with blocked cookies,
`appFetch` uses an own-app bearer from memory/tab sessionStorage. Read that bearer before a stale
cookie. Do not use localStorage. Revalidate protected API calls; the platform permits at most a
30-second positive cache, never cache refusals. Forward continuity metadata to the browser adapter;
server validation alone does not maintain browser activity or renewal.

Handle status independently of error-code wording: 401 clears invalid identity and starts normal
recovery; 403 shows a terminal access denial without a redirect loop; network/5xx keeps the credential
and offers retry. Do not silently replay a mutation after recovering auth. Keep service tokens,
passwords, codes, verifiers and grants out of logs and evidence. Diagnostic CLI identity tokens test
an endpoint only; browser QA still uses normal child Core login and the real advertised app origin.

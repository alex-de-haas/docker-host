# @hosty-sdk/app

Auth and host integration for [Hosty](https://github.com/alex-de-haas/docker-host) runtime
apps: the app-session state machine, silent session recovery, Core revalidation, and the
embedder responder for shells.

```
npm install @hosty-sdk/app
```

| Entry | Runtime | Contents |
| --- | --- | --- |
| `@hosty-sdk/app` | anywhere | status taxonomy, recovery decision, `hosty:auth-required` and `hosty:request-delegated-token` schemas, URL/env helpers |
| `@hosty-sdk/app/server` | server only | Core revalidation with caching, cookie helpers, the app-code route factory, the app secrets client |
| `@hosty-sdk/app/react` | client | `<AppIdentityBridge />` — probe, silent recovery, fallback cards |
| `@hosty-sdk/app/embedder` | client | verified responders — launch-code recovery and delegated tokens — for anything that embeds Hosty apps |

Minimal Next.js wiring:

```tsx
// app/layout.tsx
import { AppIdentityBridge } from "@hosty-sdk/app/react";
// mount <AppIdentityBridge /> at the top of <body>

// app/api/auth/app-code/route.ts
import { createAppCodeRouteHandler } from "@hosty-sdk/app/server";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const POST = createAppCodeRouteHandler({
  appIdFallback: "com.example.my-app",
  identityCookieName: "my_app_hosty_identity",
});
```

App secrets — the Core-managed keychain for runtime-acquired credentials (OAuth tokens and the
like), kept by Core outside the app's backed-up data directory:

```ts
import { getAppSecret, setAppSecret } from "@hosty-sdk/app/server";

// null means no secret is stored — an expected "reconnect required" state, not an error.
const tokens = await getAppSecret("trakt.connection.1.tokens", config);
await setAppSecret("trakt.connection.1.tokens", refreshed, config);
```

Reads are served from a write-through cache, namespaced by Core origin and app id; pass
`{ refresh: true }` to force a live read.

Delegated tokens — the credential a browser client (Shell) presents when calling a system
app's API directly. Core signs them (ECDSA P-256, 5-minute TTL) and injects the verification
key as `HOSTY_DELEGATED_TOKEN_PUBLIC_KEY`, so validation is fully local — no Core round-trip:

```ts
import { validateDelegatedToken } from "@hosty-sdk/app/server";

// null for anything invalid (bad signature, wrong audience, expired) — treat like a missing token.
const claims = validateDelegatedToken(bearerToken);
if (claims?.role !== "host.admin") { /* 401/403 */ }
```

An embedded page cannot mint a delegated token itself — that needs the user's Core session in a
first-party context — so it asks whoever embeds it:

```ts
import { DELEGATED_TOKEN_REQUEST_TYPE, DELEGATED_TOKEN_TYPE } from "@hosty-sdk/app";
import { parseActiveFrameDelegatedTokenRequest } from "@hosty-sdk/app/embedder";

// In the embedder, per app frame. A verified request says who asked, never whether to answer: the
// token is user-scoped, so grant it only to apps you decided to grant it to, and post it to that
// frame's own origin — never "*". Attach the listener before the frame can run (apps ask as soon as
// their document does, and they re-ask until answered), and honour `refresh`: it means the token the
// app holds was refused, so a cached mint must not be handed back.
const intent = parseActiveFrameDelegatedTokenRequest(event, frame.contentWindow, frame.src);
if (intent) {
  const { token, expiresAt } = await mintDelegatedTokenFromCore(appId, { force: intent.refresh });
  frame.contentWindow.postMessage({ type: DELEGATED_TOKEN_TYPE, token, expiresAt }, frameOrigin);
}
```

The design contract lives in the Hosty repository:
[`docs/features/hosty-app-sdk/feature.md`](https://github.com/alex-de-haas/docker-host/blob/main/docs/features/hosty-app-sdk/feature.md).

License: AGPL-3.0-only.

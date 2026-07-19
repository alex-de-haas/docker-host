# @hosty-sdk/app

Auth and host integration for [Hosty](https://github.com/alex-de-haas/docker-host) runtime
apps: the app-session state machine, silent session recovery, Core revalidation, and the
embedder responder for shells.

```
npm install @hosty-sdk/app
```

| Entry | Runtime | Contents |
| --- | --- | --- |
| `@hosty-sdk/app` | anywhere | status taxonomy, recovery decision, `hosty:auth-required` schema, URL/env helpers |
| `@hosty-sdk/app/server` | server only | Core revalidation with caching, cookie helpers, the app-code route factory |
| `@hosty-sdk/app/react` | client | `<AppIdentityBridge />` — probe, silent recovery, fallback cards |
| `@hosty-sdk/app/embedder` | client | verified `hosty:auth-required` responder for anything that embeds Hosty apps |

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

The design contract lives in the Hosty repository:
[`docs/ideas/hosty-app-sdk.md`](https://github.com/alex-de-haas/docker-host/blob/main/docs/ideas/hosty-app-sdk.md).

License: AGPL-3.0-only.

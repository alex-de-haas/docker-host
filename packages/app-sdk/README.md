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
| `@hosty-sdk/app/embedder` | client | verified responders — launch-code recovery and delegated tokens — plus the theme sender half, for anything that embeds Hosty apps |
| `@hosty-sdk/app/theme` | anywhere | the shell→app theme protocol: constants, `resolveTheme`, `applyTheme`, `parseShellThemeMessage`, `themeBootstrapScript` / `createThemeBootstrapScript` |

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

Following the shell's theme — the launch parameters decide the theme a document loads with, the
`hosty:shell-theme` post covers changes while the frame is up, and the bootstrap keeps the first
paint right:

```tsx
// app/layout.tsx
import { launchModeBootstrapScript } from "@hosty-sdk/app";
import { HostLaunchBridge, HostThemeBridge } from "@hosty-sdk/app/react";
import { themeBootstrapScript } from "@hosty-sdk/app/theme";

<html suppressHydrationWarning>
  <head>
    <script dangerouslySetInnerHTML={{ __html: launchModeBootstrapScript }} />
    <script dangerouslySetInnerHTML={{ __html: themeBootstrapScript }} />
  </head>
  <body>
    <HostThemeBridge /> {/* followSystem={false} onTheme={setTheme} when the app runs its own provider (next-themes) */}
    <HostLaunchBridge />
  </body>
</html>
```

An embedder declares the theme on every frame URL and posts changes to the frame's own origin:

```ts
import { appendThemeLaunchParams } from "@hosty-sdk/app/embedder";
import { createShellThemeMessage } from "@hosty-sdk/app/theme";

frame.src = appendThemeLaunchParams(launchUrl, theme, preference);
frame.contentWindow.postMessage(createShellThemeMessage(theme, preference), frameOrigin);
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

## Installing apps

Declare `"corePermissions": ["apps.install"]` in the manifest and have an administrator approve
that permission when installing/updating your app. This grants the ability to **request** an
installation; it never grants the ability to approve it on the user's behalf.

Mount an app-local handler using the existing Hosty identity-cookie configuration:

```ts
// app/api/hosty/installations/[[...path]]/route.ts
import { createInstallationRouteHandler } from "@hosty-sdk/app/install/server";
export const GET = createInstallationRouteHandler({
  appIdFallback: "com.example.marketplace",
  identityCookieName: "my_app_hosty_identity",
}, {
  publicOrigin: process.env.HOSTY_PUBLIC_ORIGIN_HTTP,
});
export const POST = GET;
```

Set `publicOrigin` to the Core-injected public origin for your UI endpoint when the framework
exposes an internal request URL. The adapter checks browser `Origin` against this configured
value, or against the request URL when it is omitted; forwarded-host headers are never trusted.

The default dialog includes runtime selection, settings and a link to Core confirmation:

```tsx
"use client";
import { createInstallationClient } from "@hosty-sdk/app/install";
import { InstallDialog } from "@hosty-sdk/app/install/react";
const client = createInstallationClient();

// Render conditionally while open; unmount it when closed.
<InstallDialog
  client={client}
  source={{ feedsUrl: "https://example.com/feeds.json", feedId: "stable" }}
  onClose={() => setOpen(false)}
  onInstalled={() => { setOpen(false); refreshInstalledApps(); }}
/>;
```

For a custom UI, use `useInstallation(client)` or the framework-independent `InstallationFlow`.
For direct API use, the same client provides the full request sequence:

```ts
const draft = await client.prepare({ manifestPath: "https://example.com/manifest.json" });
// Render draft.plan and collect settings in your UI.
const pending = await client.submit(draft.id, { APP_MODE: "standard" }, true);
// Open pending.approvalUrl from a user gesture, or render it as a new-tab link.
// Poll client.status(pending.id) until succeeded, denied or failed.
```

Open an empty confirmation window synchronously in the click handler with
`openInstallationConfirmation()`, before awaiting `submit`, then navigate it using
`showInstallationConfirmation(popup, pending)`. Always retain a visible new-tab link for popup
blocking. No installation-specific Shell messages or shared administrative credentials are needed.
`prepare({ updateAppId, planDigest })` similarly requests approval of a reviewed update for clients
with `apps.update`. A transport override supports existing Core operator clients:
`createInstallationClient({ baseUrl: coreOrigin + "/api/installations", request: sendCsrfJson })`.

Core's final page cannot be embedded or replaced by a custom permission-grant dialog. It requires
an administrator browser login issued on a dedicated Core hostname, separate from app cookie
hosts. Existing sessions need a fresh login. Requests expire after 15 minutes and Core restart
invalidates them. Closing your UI does not cancel a confirmed operation; status is the authority.
Never automatically retry an execution after a lost response.

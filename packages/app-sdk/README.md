# @hosty-sdk/app

Auth and host integration for [Hosty](https://github.com/alex-de-haas/docker-host) runtime
apps: app-session classification, Core-owned sign-in, app-local request transport and revalidation.

```
npm install @hosty-sdk/app
```

| Entry | Runtime | Contents |
| --- | --- | --- |
| `@hosty-sdk/app` | anywhere | status taxonomy, recovery decision, `hosty:auth-required` and `hosty:request-delegated-token` schemas, URL/env helpers |
| `@hosty-sdk/app/server` | server only | Core revalidation with caching, cookie helpers, the app-code route factory, the app secrets client |
| `@hosty-sdk/app/react` | client | `<AppIdentityBridge />` — probe, Core popup/navigation recovery, content gate |
| `@hosty-sdk/app/embedder` | client | theme sender and legacy embedder message parsers; Shell no longer mints app credentials |
| `@hosty-sdk/app/browser-auth` | client | `appFetch` for app-local API requests and bound Core popup sign-in |
| `@hosty-sdk/app/providers` | anywhere | permission state, provider descriptors, speech contract types |
| `@hosty-sdk/app/providers/server` | server only | `ProviderClient`: discovery, speech recognition, assistant handoffs and live credential validation |
| `@hosty-sdk/app/theme` | anywhere | the shell→app theme protocol: constants, `resolveTheme`, `applyTheme`, `parseShellThemeMessage`, `themeBootstrapScript` / `createThemeBootstrapScript` |

Minimal Next.js wiring:

```tsx
// app/layout.tsx
import { AppIdentityBridge } from "@hosty-sdk/app/react";
// wrap protected client content: <AppIdentityBridge>{children}</AppIdentityBridge>

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

Protected browser requests use the app-only credential held by the bridge:

```ts
import { appFetch } from "@hosty-sdk/app/browser-auth";
const response = await appFetch("/api/items");
```

The server must accept the explicit app bearer as well as its cookie (`readAppIdentityToken`), then
revalidate it with the app service token. This supports embedded browsers that block cookie access.
The bridge retains the grant only in memory and never sends it to Shell. `appFetch` rejects foreign
origins and redirects; 401 starts recovery, while 503 preserves the credential. Custom bridge views
must call `state.signIn` from a click and display `state.error` if present.

Embedded recovery opens Core in a popup and accepts a one-time code only from that window, the exact
Core origin and matching random state. The app exchanges and validates the code on its own server.
Standalone recovery uses Core navigation. No Core session credential is copied into either app.

Legacy signed clients can still use `validateDelegatedToken` from `@hosty-sdk/app/delegated` for
local signature/audience/expiry checking. An app login is not permission to mint cross-app MCP
tokens. Do not ask Shell for a delegated token; its old responder is disabled.

The design contract lives in the Hosty repository:
[`docs/features/hosty-app-sdk/feature.md`](https://github.com/alex-de-haas/docker-host/blob/main/docs/features/hosty-app-sdk/feature.md).

License: AGPL-3.0-only.

## Installing apps

Declare `"corePermissions": ["apps.install"]` in the manifest and have an administrator approve
that permission when installing/updating your app. This grants the ability to **request** an
installation, update or removal; it never grants the ability to approve it on the user's behalf.

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
with `apps.install`. A transport override supports existing Core operator clients:
`createInstallationClient({ baseUrl: coreOrigin + "/api/installations", request: sendCsrfJson })`.

Removal uses the same flow: `prepare({ removeAppId, removalOptions: { deleteData: true,
deleteBackups: false } })`, then `submit(draft.id, {}, false)`, Core confirmation and status polling.
Core freezes the target installation and cleanup options during preparation; later payloads cannot
change them. `deleteRuntimeState` defaults to true; `deleteData`, `deleteBackups`, `deleteSource`
and `ignoreRuntimeErrors` default to false. Only report removal after status is `succeeded`.
App credentials cannot call the direct removal endpoint, even with `apps.install`.

Core's final page cannot be embedded or replaced by a custom permission-grant dialog. It requires
an administrator browser login issued on a dedicated Core hostname, separate from app cookie
hosts. Existing sessions need a fresh login. Requests expire after 15 minutes and Core restart
invalidates them. Closing your UI does not cancel a confirmed operation; status is the authority.
Never automatically retry an execution after a lost response.

Optional permission choices belong exclusively to the Core confirmation page. The client cannot
preselect them: `submit` accepts only the request ID, settings and autostart. Core starts new optional
rights unchecked and checks rights already granted to that app. The user can grant or revoke them
there. App settings should display grants read-only and link to Core to change permissions.

## Assistant handoffs

`@hosty-sdk/app/assistant` exposes the version-1 client. Discover the confirmed assistant's
interface URL, version and capabilities through Core. Keep request and attachment identities
until the operation is resolved; do not create a new ID after an uncertain response.

```ts
import { AssistantClient, createAssistantRequestId } from "@hosty-sdk/app/assistant";
const client = new AssistantClient(interfaceUrl, { version: 1, capabilities: ["attachments"] }, issueToken);
const requestId = createAssistantRequestId(); // persist with the intent before the first request
const handoff = await client.prepare({ requestId, prompt: "Inspect this", appIds: [appId] });
// Optional: client.upload(handoff.handoffId, stableAttachmentId, file, file.name, { signal })
const finalized = await client.finalize(handoff.handoffId, []);
// Validate result.open with resolveAssistantDestination against Core's declared UI surfaces.
// Opening never submits the prompt again. client.status/cancel inspect or cancel preparations.
```

The receiver owns draft/immediate-start policy. `askAssistant(text)` remains the small embedded-app
message helper; Shell turns that message into a handoff using its verified mounted app ID. Its boolean
result reports message delivery to the embedder, not execution. Files use the separate `attachments`
capability and raw upload API. See [the complete contract](../../docs/features/hosty-harness-rename/feature.md).

Assistant control requests use a 60-second deadline. Uploads accept an optional caller-owned
`AbortSignal` and have no SDK-imposed deadline, so slow valid transfers are not aborted after a minute.

## Speech And Assistant Providers

Core 0.115.0 supports required `corePermissions` and optional `optionalCorePermissions` with
`providers.speech-to-text` / `providers.assistant`. Each accepted permission covers all confirmed
providers of that category. Read `new ProviderClient().permissions()` before offering optional UI.
Select an app ID and interface key explicitly, use `list("speech-to-text")`, `speechCapabilities(...)`
and `transcribe(selected, wavBlob, { signal })` on the server. Never expose the app service token to
a browser. Transcription accepts the provider's documented format; the v1 baseline is 16 kHz mono
PCM16 WAV. Browser microphone consent is separate from Core permission.

`assistant(selected, getUserToken)` returns the existing `AssistantClient` with bounded provider
credentials and the acting user's access. It does not expose general agent execution.
See [Provider consumption](../../docs/features/provider-consumption/feature.md) for the full contract.

### Assistant MCP credentials

MCP handlers use `introspectMcpToken` from `@hosty-sdk/app/scoped-token` for online validation of
external scoped tokens and Core's assistant-only `hosty_mcp.1` tokens. The latter require explicit
Core assistant-to-target grants and include `callerAppId` in the result. Require `mcp:read` for
reads or `mcp:invoke` for assistant mutations, then apply your application's user permissions.
Do not cache validation. Keep `introspectScopedToken` on ordinary APIs: it does not opt into accepting
MCP-only credentials. Neither token permits skipping the application's own authorization.

## Privileged activity renewal

Identity probes used by `AppIdentityBridge` pass `activeUntil` and `activityRequired` through from
`resolveAppSession().identity`. Keep app APIs on `appFetch`; a 401 can then request a user-click
Core popup, exchange a code on the same origin and retry once without replacing mounted content.
For another UI framework, use `configureAppActivity` with an app-owned `exchangeCode` function,
listen for `APP_SESSION_ENDED`, and call `renewAppActivity` directly from a click. Do not navigate
or reload to renew access. `appActivityNeedsRenewal()` supports proactive click renewal near expiry.
See [the activity contract](../../docs/features/app-activity-window/feature.md), including the
separate Core-approved assistant session leases.

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
| `@hosty-sdk/app/next` | Next client | `HostyNextOverlay`, `HostyNextNavigationBridge` for App Router navigation |
| `@hosty-sdk/app/ui` | client | policy/navigation snapshots, replayable navigation, chooser and presentation operations |
| `@hosty-sdk/app/ui/react` | React client | navigation boundaries/hooks, app frames and retained panel workspaces |
| `@hosty-sdk/app/react` | client | `<HostyOverlay />` — shared loading, identity, required setup and recovery UI; legacy bridges remain available |
| `@hosty-sdk/app/session/server` | server | Framework-neutral session response adapter for authenticated Node servers |
| `@hosty-sdk/app/embedder` | client | theme sender and legacy embedder message parsers; Shell no longer mints app credentials |
| `@hosty-sdk/app/browser-auth` | client | `appFetch` for app-local API requests and bound Core popup sign-in |
| `@hosty-sdk/app/providers` | anywhere | permission state, provider descriptors, speech contract types |
| `@hosty-sdk/app/providers/server` | server only | `ProviderClient`: discovery, speech recognition, assistant handoffs and live credential validation |
| `@hosty-sdk/app/theme` | anywhere | the shell→app theme protocol: constants, `resolveTheme`, `applyTheme`, `parseShellThemeMessage`, `themeBootstrapScript` / `createThemeBootstrapScript` |

Minimal Next.js wiring (the configuration object stays server-side):

```tsx
// app/layout.tsx — inside the body and the existing theme/launch providers
import { HostyNextOverlay } from "@hosty-sdk/app/next";
// <HostyNextOverlay>{children}</HostyNextOverlay>

// lib/hosty.ts
export const hostyConfig = {
  appIdFallback: "com.example.my-app",
  identityCookieName: "my_app_hosty_identity",
};

// app/api/hosty/session/route.ts
import { createHostySessionRouteHandler } from "@hosty-sdk/app/server";
import { hostyConfig } from "@/lib/hosty";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const GET = createHostySessionRouteHandler(hostyConfig);
// Administrator-only app: pass { administratorOnly: true } as the second argument.

// app/api/auth/app-code/route.ts
import { createAppCodeRouteHandler } from "@hosty-sdk/app/server";
import { hostyConfig } from "@/lib/hosty";
export const POST = createAppCodeRouteHandler(hostyConfig);
```

Replace the protected scope's `AppIdentityBridge`, `AppActivityBridge`, custom sign-in rendering
and `MissingPermissionsNotice` with one `HostyOverlay`. Keep public routes outside that scope.
Existing launch/theme bridges stay in place for transport compatibility; add the composition
bootstrap below. `probePath` and `appCodePath` support existing route names. `chrome`, `navigation`
and `panelLayout` configure UI composition without replacing authentication/recovery rendering.
API routes and server-rendered data still enforce their own authorization. The overlay delays
protected client mounting; it is not a server data-access boundary.

The session adapter resolves identity and checks the app's declared required permissions together.
Only an administrator receives permission details and a Core review action; a regular user sees an
administrator-setup explanation without buttons. Optional permissions do not block the app.
A missing setup capability on Core displays a compatibility state instead of exposing content.
Keep service credentials on the server and use `appFetch` for app-local browser requests.

For a plain Node server, call `createHostySessionResponse(validatedSession, recovery, options)` from
`@hosty-sdk/app/session/server` and forward its response. Pass a server-validated session, never an
identity supplied by the request body. Harness is the in-repository example. Shell retains its
HttpOnly-only code exchange; the shared coordinator also accepts a successful exchange without a
browser-readable token.

After first mount, blocked content and app portals become hidden and inert while the component tree
remains mounted. Same-user renewal restores it. A different stable user ID reloads the app document
and refuses to replay old pending requests. `APP_SESSION_RESTORED` from `/browser-auth` is an optional
DOM notification with `detail.userId`; it contains no credential. There is no generic draft persistence
across reloads or cache-clearing framework. Current user/app permissions and the authorizing principal's idle/absolute lifetime still apply.
Core 0.130.0 advertises continuous app sessions; older servers retain their actual activity policy.

Compatible SDK updates change standard presentation and recovery after a dependency update and
rebuild, without editing this wiring. New mandatory Core capabilities can require upgrading Core.
`node packages/app-sdk/scripts/check-overlay-upgrade.mjs` checks the published export layout using
identical consumer source before and after a dependency-only presentation revision (run SDK build first).

Standard SDK presentation uses the Hosty ink/mist palette, lime interaction and focus treatment,
light/dark cards and notices, and reduced-motion-aware progress. The package carries its own local
IBM Plex Sans and JetBrains Mono subsets and OFL notices; a browser bundler resolves their static
asset URLs without a CDN or an app-side CSS/font import. Server markup and initial hydration use
identical base styles; mounted chrome shares one document-owned font sheet using browser-resolved
URLs. StrictMode and access-portal replay retain that sheet, and the last owner releases it.
The private family names apply only to SDK-owned controls. The app document keeps its own typography, palette and focus styles; the four
`--hosty-panel-*` overrides remain supported. This is scoped styling of the existing light-DOM
renderers, not a Shadow DOM boundary or a change to the composition/authentication contracts.

The installation dialog collects only the source, opens Core confirmation and reports Core's
actual outcome. Preparation and execution have indeterminate progress; installed does not imply
configured, running or healthy. Closing the dialog does not cancel a Core-confirmed operation.

Legacy `AppIdentityBridge` exports, `renderState` and `onSession` remain compatible for consumers
that have not migrated. See [Hosty Overlay](../../docs/features/hosty-overlay/feature.md) for behavior.

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

The default dialog prepares installation and links to Core confirmation:

```tsx
"use client";
import { createInstallationClient } from "@hosty-sdk/app/install";
import { InstallDialog } from "@hosty-sdk/app/install/react";
import { openInstallationConfirmation } from "@hosty-sdk/app/install";
const client = createInstallationClient();

// In the Install click handler, before awaiting source preparation:
const confirmationWindow = openInstallationConfirmation();
// Render conditionally while open; unmount it when closed.
<InstallDialog
  client={client}
  confirmationWindow={confirmationWindow}
  source={{ feedsUrl: "https://example.com/feeds.json", feedId: "stable" }}
  onClose={() => setOpen(false)}
  onInstalled={() => { setOpen(false); refreshInstalledApps(); }}
/>;
```

The default dialog immediately prepares the selected source and submits defaults. Core alone
asks for runtime, automatic startup and permissions. Choose the channel before opening the
dialog; changing the source creates a new request. Missing required configuration does not
prevent installation: configure the stopped app afterwards. The dialog shows preparation,
errors, status and an explicit confirmation link when the popup is blocked. An uncertain
submission retains its ID and offers status-only recovery.

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

## Continuous app access (Core 0.130.0 / SDK 0.26.0)

Pass `continuity`, `activeUntil` and `activityRequired` from Core revalidation through custom identity
probes. Standard SDK adapters do this automatically. `HostyOverlay` / `useAppIdentity` maintain a
live browser parent through a Core-owned frame and refresh the app-local probe. Checks coalesce,
run on mount/return/network recovery, and repeat at a jittered five-minute interval. App backends
cannot keep the browser parent alive with app credentials alone.

Keep protected client requests on `appFetch`. An outage returns 503 without clearing identity or
replaying a mutation. Real expiry uses normal recovery, preserving same-user state. Optional
`<HostyOverlay localContent={<LocalNotes />}>…</HostyOverlay>` places explicitly local/public
content outside the protected root during an outage; do not place private actor-bound data there.

For another framework, use `configureAppContinuity` / `ensureAppContinuity` from
`@hosty-sdk/app/continuity/browser`, with validated metadata from `/continuity` and a probe that
checks the same actor. The probe must bypass maintenance (`appFetch(path, init, false)`) to avoid
recursion. Clean up the coordinator on unmount. `APP_CONTINUITY_UPDATED` reports silent success;
`APP_ACTIVITY_RENEWED` continues to mean explicit recovery. Do not replay handoffs/messages on either.
Missing continuity metadata keeps older Core's `configureAppActivity`/click renewal behavior.

Server-only unattended work requires an explicit Core grant:

```ts
import { BackgroundGrantClient } from "@hosty-sdk/app/background/server";
const background = new BackgroundGrantClient(grantId, "health"); // HOSTY_* service configuration
const response = await background.core("/api/apps/example.target/health");
```

The client coalesces credential issuance and refreshes before expiry. It sends each operation once;
Core enforces the immutable selected scope online. `token()` can supply the existing provider/MCP
client's user-token input. Keep tokens server-side. See
[Continuous App Access](../../docs/features/continuous-app-access/feature.md) for creation, logout,
revocation, exact MCP tools and installation boundaries. Background grants do not create a scheduler.

## Shared panels (Core 0.131.0 / SDK 0.27.0)

`HostyOverlay` composes one UI owner per top-level browser document. Its default
`panelLayout="auto"` adds an opened-tool rail, an **Add tool** chooser and a resizable
workspace. In a directly embedded app it delegates presentation to the verified parent
and renders no local rail. Use `panelLayout="slot"` with a `HostyPanelWorkspace` per workspace
ID inside your chrome, or `"none"` with an explicitly registered custom renderer. Without a renderer,
disable local tools; an opening otherwise fails with `presentation_unavailable`.
Panel hosting requires reviewed optional `apps.panels.read` (or existing `apps.read`);
participating as a child does not require catalog access.

Panel headers expose **Minimize panel (keep tool open)** (`−`) without a close button.
Hosts with a tool rail can set `minimizeControl="drawer"` on `HostyPanelWorkspace` to omit the
minimize button in docked panels and use the active rail icon to toggle them. Responsive drawers
keep a visible minimize button because the rail is inert while a drawer is open. The default
`minimizeControl="always"` retains the button in standalone layouts.
Custom host layouts can use `UiHost.closePresentation(presentationId)` to release a tool view;
this does not end its conversation or background work.
To match host chrome, set `--hosty-panel-background`, `--hosty-panel-foreground`,
`--hosty-panel-muted` and `--hosty-panel-border` on the workspace or an ancestor.
These overrides apply in both themes; omitted properties retain the SDK light/dark defaults.

```ts
// app/api/hosty/ui/[...action]/route.ts — own app configuration/session only
import { createHostyUiRouteHandler } from "@hosty-sdk/app/server";
const handler = createHostyUiRouteHandler(config);
export const GET = handler;
export const POST = handler;
```

Non-Next servers use `createHostyUiResponse` from `@hosty-sdk/app/ui/server` with their
revalidated own app-user session/token. `UiServerClient` provides only `bootstrap`,
`listPanels`, `resolvePanel`, `navigation` and `resolveNavigation`; never expose a generic Core proxy or caller-supplied credentials.
Both server adapters return `no-store` metadata. The React root's `uiPath` defaults to
`/api/hosty/ui` and must be a same-origin path.

Finalize a business handoff before requesting placement. Freeze the provider's app ID,
installation ID and interface key before `ProviderClient.assistant(...)`, then read its
current descriptor and map the completed result:

```ts
import { resolveAssistantPresentation } from "@hosty-sdk/app/assistant";
import { buildSurfaceOpenUrl } from "@hosty-sdk/app/ui";
const presentation = resolveAssistantPresentation(currentProvider, finalized, { expectedProvider });
const href = buildSurfaceOpenUrl(bootstrap.coreOrigin, presentation.destination);
// bootstrap.pinnedOpen must be true before relying on this link.
```

The pure mapper never selects an assistant or invokes it. Explicit `result.open.panelId`
selects a matching declared panel; otherwise the unique longest endpoint/path boundary
wins. Ties return `ambiguous_surface`, navigation-only providers return `no_panel`, and
both retain the exact same-session destination for explicit separate opening. A changed
provider installation is refused. Core validates pinned links again after login.

```tsx
import { useHostyUi } from "@hosty-sdk/app/ui/react";
import { createPresentationRequestId } from "@hosty-sdk/app/ui";
const ui = useHostyUi();
const requestId = createPresentationRequestId(); // retain with the completed result
const result = await ui.openSurface(presentation.target!, { placement: "side", requestId });
// Reuse requestId and target for retries; do not repeat the business action.
const current = await ui.getPresentation(requestId);
const unsubscribe = ui.subscribe(event => { /* environment or presentation update */ });
```

`opened` confirms placement, with separate `loading`, `auth-required`, `ready` or
`unreported` readiness. Providers call `ui.reportSurfaceState({ route, state: "ready" })`
after their exact route has loaded; iframe load alone is not readiness. Deadline/abort
returns `uncertain`, not cancellation. Query or retry the same ID. An unsupported host
never automatically opens a tab or creates a nested workspace. **Open separately** is an
explicit `target="_blank" rel="noopener noreferrer"` link to the pinned destination.

Framework-neutral clients use `createUiHost` from `@hosty-sdk/app/ui/host`, its snapshots,
`registerFrame`, `openSurface`, `getPresentation`, `setExpanded`, `setWidth` and `dispose`.
React clients normally use the overlay-owned controller via `useHostyUiHost` and the shared
`HostyAppFrame`. Core projects the target's minimal microphone/popup policy; an app message
cannot widen it. No delegated-token responder is required.

Trust is limited to exact mounted window/origin, document generation and stateless Core
peer metadata. Matching opaque Core/user contexts prevents accidental account mixing
between cooperating apps; it is not attestation of app code or delegated API authority.
Every target API still authorizes its own session. Older surfaces remain `unreported`.
See [the panel contract and verification](../../docs/features/sdk-panel-system/feature.md).

## Navigation and UI composition

Supply identical root defaults to the before-paint bootstrap and overlay. Omitted defaults show
navigation and enable the standalone tool rail/chooser. Hints and verified host policy can override
each leaf independently; neither framing nor copied launch-mode storage hides the new navigation.

```tsx
// app/layout.tsx
import { chromeBootstrapScript } from "@hosty-sdk/app";
import { HostyNextOverlay } from "@hosty-sdk/app/next";

const chrome = { navigation: "show" as const, tools: { enabled: true, launcher: "show" as const } };
// In <head>, before hydration and the legacy launch bridge:
// <script dangerouslySetInnerHTML={{ __html: chromeBootstrapScript(chrome) }} />
// In <body>, around protected app content:
// <HostyNextOverlay chrome={chrome}>{children}</HostyNextOverlay>
```

For React without Next, use `HostyOverlay` and optionally pass
`navigation={{ renderer: "standard", router }}`. A router implements `getRoute(): string`,
`subscribe(listener): () => void` and `navigate(relativeRoute): void | Promise<void>`; optional
`endpoint` disambiguates several endpoint names on the same origin. Without an adapter the SDK
uses document navigation. The Next entry is optional and does not add Next to plain SDK consumers.

The standard renderer uses only manifest `ui.navigation`. Own navigation needs ordinary app access,
not `apps.panels.read`. Unavailable metadata has a retry state; an empty declaration adds no menu.
Same-endpoint links use cached validated metadata and the app router; endpoint changes revalidate
through Core and replace the same host view. Modified clicks use pinned standalone links.

For custom navigation, suppress the automatic menu and wrap only page navigation/branding:

```tsx
import { HostyNavigationBoundary, useHostyChrome, useHostyNavigation } from "@hosty-sdk/app/ui/react";

// <HostyNextOverlay navigation={{ renderer: "custom" }}>
//   <HostyNavigationBoundary><MyPageNavigation /></HostyNavigationBoundary>
//   <ProjectSelector />  // Contextual controls stay reachable when navigation is hidden.
//   {children}
// </HostyNextOverlay>
```

The boundary retains component state while hidden and moves hidden focus to the content landmark.
Alternatively place `HostyNavigation` at a custom location. Framework-neutral renderers subscribe
to `ui.getChrome/subscribeChrome` and `ui.getNavigation/subscribeNavigation`, then apply equivalent
hidden/inert/focus behavior. Snapshots are immutable. `tools.owner` is derived by the SDK; it is not
a configurable default or URL field.

```ts
const result = await ui.navigate(entry.key, { requestId: crypto.randomUUID() });
// Explicitly promote a declared page into the embedder's main application area.
const main = await ui.navigate(entry.key, {
  requestId: crypto.randomUUID(), placement: "main", search: "?session=selected-session",
});
const picker = await ui.openToolPicker({ requestId: crypto.randomUUID() });
// accepted means navigation was accepted / the chooser became visible.
// Retain request IDs for uncertain retries; an accepted replay does not repeat the action.
```

Hosts opt in with `host.setMainNavigator(async surface => launchMainPage(surface))`. The SDK resolves
that caller's entry through Core before invoking it. Main placement preserves the originating panel;
only the destination query can be overridden. Legacy/standalone hosts report it unavailable instead
of silently navigating the panel. Normal navigation keeps its existing current-surface behavior.

Document hints are `hosty_navigation=show|hide`, `hosty_tools=enabled|disabled` and
`hosty_tool_launcher=show|hide`. The SDK removes them from the visible URL, preserving history
state. They are not persisted. Verified host overrides take precedence, then hints, app defaults,
the current document's legacy launch fallback for navigation, and standalone defaults. Hints grant
no access or hosting authority. Hiding a launcher permits programmatic presentation; disabling
tools rejects new requests. A root disable applies to every source and collapses retained tools.

### Host views and retained tools

`HostyAppFrame` accepts a view descriptor. A desktop host can choose different policy from Shell:

```tsx
<HostyAppFrame surface={validatedSurface} title="Plans"
  view={{ viewId: "plans-window-1", workspaceId: "default",
    chrome: { navigation: "show", tools: { enabled: true, launcher: "hide" } },
    navigate: surface => replaceWindowSurface(surface) }} />
```

Omit `navigate` for the SDK's plain iframe replacement, or use it to update the host's route/window
model. Key a replaced React frame by its immutable surface; live `chrome` updates keep that key.
One top-level coordinator handles direct app/tool children. It never delegates credentials.

Panel declarations and presentations have different identities. `PanelRef` identifies a manifest
tool. `openSurface` returns an SDK `presentationId`; its `requestId` identifies only the operation.
Default `reuse: "exact"` focuses the matching target in the destination workspace. A distinct route
retains another frame; `reuse: "new"` creates another even for the same route. Rails have one item
per declaration and an instance switcher. Replaying a closed presentation's operation does not
resurrect it; use a new request to reopen. Domain sessions remain owned by the app.

```ts
const opened = await ui.openSurface(target, {
  placement: "side", requestId: crypto.randomUUID(), reuse: "exact",
});
// A host may satisfy "side" with a dock or tool window.
```

Hosts use `useHostyUiHost()` or `createUiHost()`:

```ts
host.setViewChrome("plans-window-1", { navigation: "show", tools: { launcher: "hide" } });
host.setPlacementResolver(({ source, target, presentations }) => ({ workspaceId: "shared" }));
host.focusPresentation(presentationId);
host.collapseWorkspace("shared");
await host.movePresentation(presentationId, "floating");
host.closePresentation(presentationId); // Does not delete the conversation.
```

Register destinations before their views. React's `<HostyPanelWorkspace workspaceId="shared">`
implements the renderer; `panelLayout="slot"` lets the host place multiple named workspaces.
`layout="dock"` keeps dock geometry inside an independent tool window. The default `responsive`
layout switches to a drawer in a narrow region. Keep populated workspaces mounted until their
presentations are moved or explicitly closed.

Non-React hosts call `registerWorkspace({ workspaceId, renderer })`. A renderer implements async
`present(instance, signal)` and `showToolPicker(signal)` returning `accepted | unavailable`, plus
`focus(id)`, `collapse()` and `release(id)`. Acceptance requires an attached visible destination,
not a promise of later UI. Matching `frameLayer` object identities allow movement; the renderer
must preserve iframe DOM parent and browsing context, changing geometry instead of reparenting.
The supplied React renderer does this. A failed move leaves the original presentation in place.

A placement resolver can nominate `presentationId` together with its actual workspace, but only
an exact resolved target is accepted. Requests are ordered per destination before asynchronous
resolution; a newer selection or collapse supersedes older work. Closing an app view cancels its
unaccepted requests and preserves accepted shared presentations. All browser IDs and ledgers are
local to the document; Core stores no browser workspace/session registry.

### Compatibility and migration

Both peers negotiate `ui.composition.v1` inside the existing verified wire-v1 handshake. New/old
peers keep legacy openings without new options. Explicit reuse, remote navigation or picker calls
to old hosts return `unsupported_composition`; the SDK does not silently discard those options.
Host loss preserves stale policy and exposes reconnect/separate recovery, without taking local
ownership. Silent session renewal preserves same-actor frames and drafts.

Remove `hosty-shell-chrome`/`data-hosty-launch` visibility CSS when adopting navigation boundaries.
Keep launch/auth exports for older hosts and native transport. Native clients send explicit hidden
navigation/launcher and disabled tools until they provide a panel host. `panelLayout="none"` is a
rendering choice, not a disable policy: explicitly disable local tools or register a renderer.
See [UI composition and browser acceptance](../../docs/features/sdk-ui-composition/feature.md).

## Child Core sandbox controls

`@hosty-sdk/app/sandbox/react` exports `CoreEnvironmentPanel` for operator-facing child Core
management. Supply an authenticated `EnvironmentRequest` transport, a tab-local replay storage key
and optionally a workspace with its active worktrees. Shell and Workspaces use this shared panel
for create/start, current/source Core selection, normal test-account setup, app status, preview and
confirmed deletion. The component does not grant authority: Core independently checks the optional
`core.environments.inspect/operate` grants, administrator identity and workspace source access.

`@hosty-sdk/app/sandbox/server` provides the server-side clients for independent app sandboxes and
child Core environments. Caller-owned `core.environments.read/manage` authority remains distinct
from the operator panel's cross-caller permissions. See the
[sandbox contract](../../docs/features/app-sandbox-runtimes/feature.md) for lifecycle and cleanup rules.

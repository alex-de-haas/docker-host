# Hosty App SDK

Created: 2026-07-15
Updated: 2026-10-02

Shared Host integration for runtime apps, in two published packages: **`@hosty-sdk/app`** on npmjs
(TypeScript, 0.19.0) and **`HostySdk.App`** on NuGet (.NET, 0.6.0). They own the app half of the
[auth session lifecycle](../auth-session-lifecycle/feature.md) contract — session classification,
recovery, Core revalidation, launch-mode awareness — plus the app secrets client, delegated-token
validation, and (TypeScript only) the theme protocol between a shell and the pages it embeds.

The packages exist because that logic was previously a private copy in every app. Six runtime apps
held at least five incompatible copies of the same security-sensitive code, and the copies had drifted
into a production incident: media-server collapsed every identity failure to `null`, never posted
`hosty:auth-required`, and never read `HOSTY_CORE_PUBLIC_ORIGIN`, so an expired grant dead-ended with
neither recovery channel available (confirmed live 2026-07-17 — Core's `app-auth-codes.json` showed an
offered code sitting at `consumedAt: null`). Marketplace, separately, rendered a missing
`HOSTY_APP_SERVICE_TOKEN` — an operator problem — as a login prompt the user could not act on, which
is what the `misconfigured` state exists to prevent.

Installation also has a pure client/state flow, a React dialog and an app-local server adapter.
[App installation](../app-installation-sdk/feature.md) owns their permission and Core confirmation
contract; none depends on the default Shell or its embedding messages.

## Packages And Slices

```text
@hosty-sdk/app                 # npmjs — types, constants, state machine, launch mode, message schema
@hosty-sdk/app/server          # import "server-only": Core revalidation, code exchange, app secrets
@hosty-sdk/app/delegated       # local ECDSA validation of Core-issued delegated tokens
@hosty-sdk/app/react           # 'use client': AppIdentityBridge, HostLaunchBridge, HostThemeBridge, useLaunchMode
@hosty-sdk/app/embedder        # theme sender and legacy message parsers
@hosty-sdk/app/browser-auth    # same-origin appFetch and Core popup sign-in
@hosty-sdk/app/install         # pure: typed client and InstallationFlow
@hosty-sdk/app/install/react   # client: useInstallation and InstallDialog
@hosty-sdk/app/install/server  # server-only: app-local installation route adapter
@hosty-sdk/app/theme           # pure: the shell→app theme protocol, its resolver, and the bootstrap script

HostySdk.App                   # NuGet — Hosty auth scheme, cached Core revalidation,
                               # HOSTY_* options binding, HostySecretsClient
```

The server/client boundary is enforced by subpath exports: the root slice is pure TypeScript with no
React or Next dependency (usable from a plain `server.mjs`), `server` is marked `import "server-only"`
so the service token can never reach a client bundle, and `react`/`embedder` are `'use client'`.
`delegated` is deliberately separate from `server` so plain Node services can import it without
pulling in `server-only`.

`@hosty-sdk/app` is an umbrella package: one dependency per app, forever. New functions arrive as
subpaths, not as new packages — they are 50–150-line utilities, and package-per-utility would mean
micro-package noise plus a shared base package whose bumps cascade. The split axis, if it is ever
used, is function/audience rather than runtime, so auth can never end up smeared across packages.

What each slice holds:

- **Root:** `AppSessionStatus` and `classifyRevalidationHttpStatus`, the recovery decision
  (`decideRecoveryAction`), Core `/open` URL construction with the loopback guard, launch-mode
  detection and its bootstrap script (`hosty_launch`, `data-hosty-launch`,
  `hosty-shell-chrome`), and the `hosty:auth-required` / `hosty:request-delegated-token` message
  schemas.
- **`server`:** `resolveAppSession` and `classifyAppSessionFromCookie` (online revalidation against
  Core), `exchangeAppCode`, `createAppCodeRouteHandler`, identity-token reading, cookie attribute
  building, and the app secrets client (`getAppSecret` / `setAppSecret` / `deleteAppSecret` /
  `listAppSecretKeys`).
- **`react`:** `AppIdentityBridge` (renders the state machine and drives recovery), `HostLaunchBridge`,
  `HostThemeBridge`, `useLaunchMode`, and `readProbedSessionStatus`.
- **`embedder`:** `parseActiveFrameAuthRequired`, `parseActiveFrameDelegatedTokenRequest`,
  `createReissueRateLimiter`, and `appendThemeLaunchParams`.
- **`theme`:** the protocol constants (`hosty:shell-theme`, the `hosty_theme` /
  `hosty_theme_preference` launch parameters, the `hosty.theme.resolved` / `hosty.theme.preference`
  storage keys, the `data-hosty-theme` / `data-hosty-theme-preference` attributes), `resolveTheme`,
  `applyTheme`, `parseShellThemeMessage`, `createShellThemeMessage`, the two normalizers, and
  `themeBootstrapScript` (`createThemeBootstrapScript` for the `followSystem` switch).
- **`HostySdk.App`:** `HostyAuthenticationHandler` (identity token from bearer, cookie, or inbound
  header), `CoreIdentityValidator` behind `CachingIdentityValidator`, `HostyAppOptions` binding of the
  `HOSTY_*` environment, `HostySession`, `HostySecretsClient` (`AddHostySecrets`),
  `HostyScopedTokenClient`, and `HostyDelegatedToken` (local ECDSA validation).

**The two packages are not interchangeable, and the summary above once implied they were.** Delegated
validation was listed as something "the packages" own while only the TypeScript one had it — which is
why a C# app could authenticate a browser and refuse every agent, and why nothing said so until an
operator hit it. Where a capability exists on one side only, this document names the side.

## Session State Machine

One state machine, one gate, one source of truth: content, header badge, and diagnostics all read the
same state, which is what stops the three-contradicting-errors failure.

| State | Cause | Embedded (in a shell) | Standalone |
| --- | --- | --- | --- |
| `resolving` | probe in flight | quiet skeleton, never an error | same |
| `active` | token valid | app content | app content |
| `recoverable` | Core **401** | offer a button opening Core sign-in; exchange a bound one-time code in the app | redirect to Core `/open` once per tab; Core bounces through `/login?returnTo` and returns a fresh code. Only the loop-guard terminal state shows a message with an explicit link |
| `denied` | Core **403** | "signed in, no access", no login button — a redirect would loop | same |
| `unavailable` | **503** / Core unreachable | "can't reach Hosty, retrying" + Retry; the cookie is kept | same |
| `misconfigured` | no service token or no Core origin | "misconfigured on the host, contact the administrator", no login button | same |

Core owns the password form. Embedded apps offer a sign-in action that opens Core; standalone
apps navigate through Core with a once-per-tab loop guard. Shell follows the same standalone rule.
Denied, unavailable and misconfigured states remain distinct from recoverable authentication.

The one piece of complexity that survives the simplicity pressure is the standalone once-per-tab
redirect guard: without it a failing code exchange becomes an infinite redirect loop, which is worse
than any error page. A second guard covers off-machine access — when the injected Core origin is
loopback but the page host is not, the redirect cannot succeed, so the SDK skips it and shows the
message. It deliberately does not try to derive Core's origin from the page hostname: Core's default
bind is loopback and its redirect-URI allowlist would reject an origin it does not know
(`redirect_uri_denied`), so the heuristic is dead twice over. Off-machine access is supported by
configuring public origins.

The React identity bridge keeps a pending one-time launch-code exchange across development effect
cleanup and replay. The replay waits for that exchange before probing or recovering the session;
only the active effect reloads after success. Cleanup still cancels probes and recovery timers,
while an already submitted code exchange runs to completion so its single-use code is not lost.

## Classification And Caching

- **Classification is by HTTP status, never by error-code string.** 401 → `recoverable`, 403 →
  `denied`, 503 or unreachable → `unavailable`, missing configuration → `misconfigured`. Code strings
  (`token_expired`, `app_access_denied`, …) pass through untouched for logging but never drive
  branching, so a new Core code cannot break an app. The consequence for Core is that
  `MapIdentityErrorStatus` is normative: moving a code between 401 and 403 is a breaking change.
- **Positive revalidations are cached 30 seconds, clamped to the grant's expiry; failures are never
  cached.** Both packages use the same numbers (`CachingIdentityValidator` on .NET, a bounded
  process-global map in the `server` slice), so a stuck-unauthenticated state is impossible and the
  cache cannot be grown without bound by an attacker spraying tokens.
- Every service validates its own public endpoints against Core — not a trusted-header relay. Private
  intra-app calls need no validation (the per-app network is the boundary), which is why the .NET
  package exists at all: media-server's Jellyfin/Infuse surface is a public endpoint the TypeScript
  layer could never front.

## Launch Mode And Logout

The SDK reports how an app is running — `embedded`, `native`, or `standalone` — as a first-class
helper, resolved from the `hosty_launch` parameter with a `sessionStorage` fallback and exposed as the
`data-hosty-launch` attribute plus the `hosty-shell-chrome` class, so an app can drop the navigation
its embedder already renders without a flash.

Logout UI is the app's discretion, gated by that helper: embedded can hide logout to avoid duplicating the host account controls (the app still owns
its session), standalone may offer a control that drops the app cookie and navigates to Core's
login page. Logout is a cookie drop only — the grant then lives until its idle expiry.

## Theme Bridging

An embedded page renders in the theme its shell is set to. The shell declares it over two channels
and the page reads them in a fixed precedence:

1. **The launch parameters** `hosty_theme` (`light` | `dark`) and `hosty_theme_preference` (`light`
   | `dark` | `system`), appended by the shell to every URL it loads into a frame — the workspace
   page, a settings tab, a panel — with `appendThemeLaunchParams`. This channel decides the theme a
   document loads with. It travels with the document, so it cannot be missed, and the shell
   re-derives it on every launch and every page switch it drives, so it cannot be stale.
2. **The value persisted for the tab** under `hosty.theme.resolved` / `hosty.theme.preference` in
   `sessionStorage`, written whenever a shell declared a theme. App-internal navigation carries no
   parameter and must not lose the theme.
3. **The operating system**, followed live only while no shell has spoken. A declared theme is a
   choice, and a choice is not overruled by the OS.

The `hosty:shell-theme` post (`{ type, theme, preference }`, built with `createShellThemeMessage`)
is the shell's channel for **changes made while the frame is already up**; it is also posted when
the frame fires `load`, but that post is not load-bearing. It routinely lands before the app's effect
has attached a listener, and the copies this slice replaced depended on it: lost, they read whatever
an earlier post had stored, so one session in dark pinned an app dark for the life of the tab
whatever the shell was set to — the telemetry-ui defect that opened the extraction (2026-09-07).

`parseShellThemeMessage` accepts the post from the parent frame alone: `event.source ===
window.parent` is set by the browser and is the trustworthy gate. The parent's origin is deliberately
not checked — a page learns which origin embeds it from messages like this one, so it cannot be used
to pre-filter them, and `document.referrer`, which two copies used instead, goes stale the moment the
page reloads itself. Theme is not sensitive; the source check is sufficient.

Applying a theme writes four things to the root, in `applyTheme`: the `dark` class every app's
Tailwind `dark:` variant keys on, `color-scheme` so native controls and scrollbars follow, and the
`data-hosty-theme` / `data-hosty-theme-preference` attributes for anything that wants the words.
`themeBootstrapScript` does the same from the same precedence before hydration, so a document never
paints in the wrong theme for a frame; `HostThemeBridge` then persists a declared theme, cleans the
parameters out of the URL (a copied link must not carry a shell's presentation into a plain tab — the
launch mode's rule exactly), and follows posts for the life of the document. Cleaning is the
bridge's job rather than the script's because a `history.replaceState` before hydration is a
router's business.

An app that also runs its own theme provider for standalone use (project-manager on next-themes)
passes `followSystem={false}` to the bridge and creates its head script with
`createThemeBootstrapScript({ followSystem: false })`: the host then applies only a theme a shell
declared and leaves the standalone case — where the operator may have picked a theme with the app's
own toggle — to the provider, whose stored choice the operating system must not overwrite. The
bridge's `onTheme` callback hands the provider each declared theme, so the app's own components
render in it too.

Shell consumes the sender half — `appendThemeLaunchParams` on every frame URL and
`createShellThemeMessage` in its post — so the reference sender and the shipped one are the same
code. Every embedded first-party page reads the protocol from this slice: no app implements it
again, and `apps/harness/web` declares the SDK itself rather than relying on the gateway
package's copy, because npm scopes a nested-workspace install to the workspace it is run from. The native client (`apps/shell-swift`) declares no theme; its web view reads the operating
system, which is what a native app's chrome follows anyway.

## Embedded App Sign-In

Shell opens the app URL without minting credentials. An app with a valid own-origin session opens
immediately; otherwise `AppIdentityBridge` offers a user-initiated Core sign-in popup. The frame does
not navigate its parent or ask Shell for a user token.

Core `/api/apps/{appId}/open?responseMode=web_message&state=...` requires a browser navigation and
its own origin-bound session cookie. It validates the app assignment and registered callback origin,
then posts a single-use code to that exact app origin. The SDK accepts the message only from the
opened popup, at the configured Core origin, with the matching random 256-bit state. Missing Core
sessions go through Core's password form. Invalid targets, mismatched state and code replay fail.

The app's own server exchanges the code and validates the result with its service credential before
returning its app grant and setting its host-only HttpOnly cookie. Where iframe cookie access is
blocked, the bridge keeps the app grant only in document memory; `appFetch` attaches it exclusively
to same-origin requests and refuses redirects. The token is never stored in browser storage or sent
to Shell. A reload discards that memory and probes the cookie again. A 401 triggers recovery, a 403
is terminal denial, and a 503 preserves credentials.

Use `appFetch` from `@hosty-sdk/app/browser-auth` for protected client API calls and streams. Gate
protected content with the bridge's children or `renderState`; a custom sign-in view must invoke
`state.signIn` directly from a user gesture. Popup cancellation, blocking and timeout return a
retryable sign-in state. Server-rendered protected data needs its own compatible loading design;
a client-held frame grant is not automatically available to an initial server render.

The SDK retains legacy embedder parsers for compatibility. Their presence grants no authority;
Hosty Shell does not issue cross-app launch codes or answer delegated-token requests. MCP access
requires a separate authorization basis from app sign-in. The remaining Harness migration and
browser acceptance are tracked in [local browser origins](../local-browser-origins/plan.md).

## Distribution And Versioning

- **Public registries: npmjs for TypeScript, NuGet for .NET.** GitHub Packages token-gates even public
  installs, which is friction in every external repository's CI; git-tag installs cannot address a
  monorepo subfolder; and NuGet has no git dependencies at all, so NuGet.org was unavoidable — at which
  point avoiding npmjs saved nothing. The git-tag channel remains an auxiliary for installing from a
  branch during debugging. The `@hosty` scope was taken, so the owner registered `@hosty-sdk`.
- **No version synchronization between Core and the SDK.** Compatibility is behavioral: Core avoids
  breaking API signatures, new APIs are additive, apps track the current SDK. Any sync mechanism would
  itself be a place to break — Core changing a signature but forgetting to bump a required version
  fails on the check rather than on the call.
- **Versioned dependencies, never floating.** Apps depend with a wide semver range, SDK releases reach
  external repositories as Dependabot PRs with auto-merge on green CI, and in-tree apps use the npm
  workspace symlink and build against the working tree. Floating versions were rejected: lockfiles make
  them a lie on npm, NuGet floating trades away reproducibility, and a bad release would hit every app
  fleet-wide with no gate — the same rolling-vs-pinned choice already made for app images.
- Publishing is automatic on merge and skips when the version already exists in the registry.

## Adoption

| App | Status |
| --- | --- |
| shell | consumes the `embedder` slice (#245), the launch/event helpers, and the theme sender half |
| marketplace | full — server + react + app-code factory (#241, #248) + the theme slice |
| telemetry-ui | full (#241, #248) + the theme slice |
| ai-gateway | consumes the SDK for its app auth; its web workspace declares the SDK too and takes the theme slice |
| demo-app | partial — `AppIdentityBridge`, the launch and theme bootstraps, `HostThemeBridge`, the app-code factory, and `delegated` for its MCP route; its 545-line `host-auth.ts` still hand-rolls session resolution |
| media-server web | full (media-server #63/#64), theme slice included (media-server #253) |
| media-server .NET | full — `HostySdk.App` (media-server #65); a Core timeout fails closed as 401 |
| project-manager | adopted (PM #27), with a pre-SDK wrapper layer still duplicating SDK exports; theme slice included (PM #77), keeping a thin next-themes hand-off |
| solitaire | nothing to adopt — vanilla JS, no auth, two `localStorage` keys and zero npm dependencies |

The remaining adoption debts and the second-wave extraction inventory are in [plan.md](plan.md).

## Boundaries

- The SDK owns the auth contract and logic, not each app's visual design — the gate UI is overridable.
- It never signs or verifies browser app tokens locally; their revalidation stays online against Core,
  per the token rule in [ai-agent-bridge](../ai-agent-bridge/feature.md#token-mechanics). Delegated
  agent-bridge tokens are that rule's other half, and `delegated.ts` verifies those locally against the
  Core-injected public key.
- Cookie and header names stay per-app, parameterized through the config object
  (`{ appId, identityCookieName, internalHeaderPrefix, mapHostRole? }`). No forced cookie migration.
- The Shell iframe sandbox forbids top navigation. App sign-in uses its existing popup capability.
- Adoption is layered and opt-in. An app with no protected data is never forced to take the full gate.
- Rejected shapes, recorded so they are not re-proposed: a React-first component library (solitaire is
  vanilla JS); copy-and-keep-in-sync with a lint rule (a lint rule flags drift, it does not stop it);
  unifying cookie and header names across apps (a forced migration for no functional gain).

`AppIdentityBridge` accepts an optional `renderState` callback, receiving recovering, active,
signin, denied, unavailable or misconfigured state. Apps can gate their content and data requests
on `active`, using the same recovery lifecycle as the bridge. Omitting the callback keeps the
default recovery UI; optional children render only after an active probe. The initial state is recovering; an active identity probe permits
content, while failed probes never expose an active state.

## Assistant Handoff Client

`@hosty-sdk/app/assistant` provides v1 contract checking, UUIDv7 request IDs, prepare/upload/finalize,
status/cancel and UI-destination validation. `attachments` is optional; unsupported uploads are refused
before sending. Delegated-token refresh retries once on 401. Callers preserve intent identity through
transport failure. The receiving assistant applies its draft/immediate-start setting; embedded
`askAssistant` reports only whether its message was posted. See [the contract](../hosty-harness-rename/feature.md).

## Assistant MCP Validation

JavaScript `introspectMcpToken` and .NET `IntrospectMcpAsync` explicitly identify the MCP surface
when calling Core introspection. They validate external scoped credentials and assistant MCP-only
tokens, return the current user/scopes and calling assistant, and do not cache. Ordinary scoped
helpers omit that purpose and reject assistant MCP-only credentials. App identity and delegated
validators also reject their distinct format. Applications keep MCP validation out of general API
authentication and enforce their domain user permissions after validation.

## Required-permission setup notice

`@hosty-sdk/app/permissions/server` exports `readOwnPermissionNotice` for an
app-authenticated server route. Pass the authenticated viewer's host role. The helper
reads only this app's `/api/internal/apps/{appId}/permissions` using its private service
credential, including unsupported required names. It returns no permission details to
non-administrators. Do not take the role or app id from browser input.

`@hosty-sdk/app/permissions` exports the framework-neutral `permissionNotice` classifier
and synchronous click handler `requestPermissionReview`.
`MissingPermissionsNotice` is exported from `/react` and `/permissions/react`; mount it
after identity recovery. Its default authenticated GET endpoint is `/api/hosty/permissions`.
The component handles administrator-only review, unsupported names, focus/pending refresh,
and dismissal until remount. Optional permissions do not trigger a notice.

Standalone clicks open Core review directly. Embedded clicks send a credential-free
`hosty:request-permission-review` message. Embedders use
`parseActiveFramePermissionReview` from `/embedder` to verify window and origin and derive
the target from the mounted frame. Payload app ids and URLs never choose the target.
See [permission management](../app-permission-management/feature.md) for first-party adoption.

## Testing Expectations

- The classification table is exercised per status, including that a 503 keeps the cookie while a 401
  drops it — the pair is the contract, and a package that treats every failure alike passes any
  single-case test.
- The revalidation cache is asserted in both directions: a positive result is reused inside the window
  and clamped to the grant's expiry, a failure is never cached, and the map stays bounded.
- Recovery decisions are covered for both channels — embedded opens a bound Core popup, standalone builds the
  `/open` URL — plus the two guards: once per tab, and no redirect when the Core origin is loopback and
  the page host is not.
- Legacy embedder parser compatibility tests reject a foreign `event.source`, a mismatched origin, and a mismatched
  `appId`, and its rate limiter holds under repeated intents.
- The two responders are covered against each other, not only against forged senders: a
  delegated-token request must not satisfy the auth-required parser or the reverse, since one
  reissues a code and the other hands over a credential. The `refresh` flag is read as a strict
  boolean, so a truthy-but-not-`true` payload cannot force a re-mint.
- Delegated-token validation rejects an expired token, a wrong audience, and a forged signature while
  accepting a well-formed one.
- The secrets clients survive a briefly unavailable Core through their write-through cache, and a read
  issued before a concurrent write does not overwrite the newer value.
- The theme resolver is covered for its precedence — a launch parameter over a stale stored theme
  (the regression the slice exists for), the stored theme across a page switch that carries no
  parameter, the operating system when nothing is declared — and for ignoring an unrecognized value
  on either channel rather than honouring it. The bootstrap script is run as a function against a
  document double for the same rows, including a blocked `sessionStorage`, which must still paint.
- `parseShellThemeMessage` rejects a foreign sender, a document with no parent, another message type,
  and an unrenderable theme, and defaults a missing preference to the theme. The sender half replaces
  rather than duplicates the parameters on a URL that already carries them, and keeps the app path,
  query, and fragment.
- CI runs both suites (`npm run sdk:test`, the `HostySdk.App.Tests` project) on any change under the
  package paths; the publish workflows re-run the tests before releasing.
- Identity-bridge regression tests replay development effect setup/cleanup, checking one exchange,
  no premature probe, one successful reload, recovery after failed exchanges, and no navigation
  after an actual unmount.
- Bridge render-state tests keep content gated until an active probe and cover denied, unavailable
  and misconfigured responses without replacing the default recovery contract.

- Popup tests reject wrong window, origin and state; code exchange rejects foreign app audiences and replay.
- Browser transport tests reject cross-origin requests and redirects, preserve credentials on 503, and initiate recovery on 401.

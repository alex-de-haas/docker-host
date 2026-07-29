# Plan: Swift Shell

Status: In Progress
Created: 2026-07-29
Updated: 2026-07-29

## Goal

Ship a native Apple-platform client for a Hosty host — `apps/shell-swift`, a SwiftUI
app for iOS, iPadOS, and macOS — that manages installed apps: their state,
lifecycle, and updates.

It is a **remote client**, not a runtime app. It is not installed on the host, has
no `manifest.json`, and never becomes the `ui-client` Core redirects browsers to
(see [Replaceable UI Clients](../../ideas/replaceable-ui-clients.md)). It talks to
Core over the existing browser API from the operator's own device.

Core gains one small capability so a non-browser client is a first-class caller
rather than a browser emulator: a Core session may travel as a bearer token, and a
bearer-authenticated request needs no CSRF token.

The first version is deliberately narrow. The surface grows in later, separate
plans rather than by widening this one.

## Non-goals

This version does not:

- open runtime app UIs (no `WKWebView` workspace, no launch codes, no
  `/api/apps/{id}/open`) — a later plan decides between embedded web views and
  handing the URL to the system browser;
- install or remove apps, browse available apps, or accept install intents;
- manage users, invitations, or app assignments;
- expose Cloudflare ingress, backups, global mounts, runtime switching, source
  overrides, app settings, or Core settings;
- serve non-administrator Host users with a management surface (see
  [Administrator-only](#administrator-only));
- add named, per-device credentials. Sessions stay anonymous session records with
  the existing lifetimes; a device-token store with per-device naming and
  revocation is a separate Core feature, not a phase of this plan;
- change how a session is *created*. Login stays Core-owned, on Core's own login
  page, so any future provider (OIDC, trusted proxy) works without client changes;
- replace, deprecate, or change `apps/shell`. The browser Shell stays the primary
  UI and is untouched by this work;
- distribute the app. Installation is by local Xcode build onto the operator's own
  Mac and devices. TestFlight is the intended next step and the App Store follows a
  full release, but both need an App Store Connect record, distribution signing, a
  release workflow, a privacy manifest, and a review-facing justification for
  local-network HTTP access — that is a separate plan.

## Target Behavior

### Repository placement

The client lives in this repository, beside Core.

Its models are hand-written mirrors of Core's browser contracts, which are
`internal sealed record` types with no OpenAPI spec and no contract versioning.
Only in one repository can a pull request that changes `AppSummary` update the Swift
models in the same commit. The sibling app repositories (project-manager,
media-server, torrent-engine) are a different case: they are runtime apps consuming
stable public contracts — the manifest schema and app identity — not Core's internal
browser API.

Reconsider when the Swift app acquires an independent App Store release cadence, or
when the browser contract is published as a package rather than mirrored by hand.

### Core: a session as a bearer credential

Today a Host user session is only ever a `hosty_session` cookie, and every mutation
additionally requires the double-submit CSRF pair. Both are browser mechanisms, and
both are actively wrong for a native client:

- **Cookies are not isolated by port** (RFC 6265). `http://10.0.0.5:7070` and
  `http://10.0.0.5:7071` share one cookie jar, so a multi-host client backed by the
  system cookie store would let two hosts on one address overwrite each other's
  sessions. Any correct native client must therefore attach the credential itself.
- **CSRF exists because cookies are ambient.** A credential the client attaches
  explicitly cannot be replayed by a hostile origin, so the double-submit pair
  protects nothing here.

Core therefore accepts the existing session id in `Authorization: Bearer`, and
treats a bearer-authenticated request as CSRF-exempt. `ReadBearerToken` already
exists next to the session code
([CoreSessionAuthorization.cs:116](../../../apps/core/src/Haas.Hosty.Core/CoreSessionAuthorization.cs))
and is used by the app-service-token endpoints; session ids and service tokens live
in disjoint value spaces, and no endpoint accepts both.

Three rules make this safe, and each is a requirement rather than an implementation
detail:

1. **The cookie always wins.** Resolution is `cookie ?? bearer`, never the reverse.
   If a browser request carrying a session cookie could opt into the bearer path by
   adding a header, it would opt out of CSRF — so a request that has a cookie is a
   cookie request, full stop.
2. **CSRF is skipped only for bearer-sourced sessions.** This requires resolving the
   session *before* the CSRF check; today `RequireSessionAsync` and
   `RequireAdminSessionAsync` check CSRF first.
3. **No new credential is minted.** The bearer value *is* the session id, so
   expiry, sliding idle window, revocation, and the explicit-logout cascade are
   unchanged and shared with the browser.

There is no XSS regression: the cookie stays `HttpOnly`, so page JavaScript cannot
read the session id and therefore cannot construct the bearer header.

Every place that reads the session id directly from the cookie must move to the
shared resolution, or a native session will authenticate but be unable to inspect or
end itself:

- `ResolveSessionAsync` ([CoreSessionAuthorization.cs:148](../../../apps/core/src/Haas.Hosty.Core/CoreSessionAuthorization.cs));
- `ReadSessionId`, which stamps issued grants with the authorizing session for the
  logout cascade ([CoreSessionAuthorization.cs:113](../../../apps/core/src/Haas.Hosty.Core/CoreSessionAuthorization.cs));
- `GET /api/auth/session` ([AuthEndpoints.cs:32](../../../apps/core/src/Haas.Hosty.Core/AuthEndpoints.cs));
- `LogoutAsync` ([AuthEndpoints.cs:329](../../../apps/core/src/Haas.Hosty.Core/AuthEndpoints.cs)).

A welcome side effect: `GET /api/events` authenticates through `RequireSessionAsync`,
so the native client can subscribe with a bearer header — something a browser
`EventSource` cannot do, and the reason the browser Shell must rely on the cookie.

### Host requirement

The client authenticates **only** with `Authorization: Bearer`, which Core learned to
accept in platform `0.70.0` (Phase 1). Against an older host every authenticated
request answers 401, so a sign-in appears to succeed — the cookie is harvested — and
then bounces straight back to the sign-in screen with nothing to explain why.

So the version is checked rather than discovered: `AddHostView` refuses to add a host
below the minimum, and `HostSession` checks once per session (the version cannot
change while Core is running) and renders an explicit "update the host" state. An
*unparseable* version counts as supported — a scheme this client cannot read is far
more likely to be newer than older, and refusing a host over a parsing failure is the
worse mistake.

### Connecting to a host

The operator enters a host origin. The app probes the public `GET /api/core/status`
to confirm a Hosty Core answers there and to read its version, then stores the
connection. Several hosts can be stored; one is active at a time, and each keeps its
own credential.

When the typed address carries no scheme, both are tried — **https first** — and
whichever answers is what gets stored. There is no defensible default: a LAN host is
plain HTTP (`192.168.1.50:7070`) while a tunnelled host is HTTPS-only
(`core.example.com`). Guessing `http` for a public name fails in the least useful way
available, because App Transport Security refuses the cleartext request and reports a
TLS policy error that says nothing about adding `https://`. Guessing `https` for a LAN
address merely fails to connect, and the next candidate is tried immediately.

### Signing in

Core has no JSON login: a session is created by the HTML form at `GET/POST /login`
([HostyCoreApplication.cs:219](../../../apps/core/src/Haas.Hosty.Core/HostyCoreApplication.cs)).
The app presents Core's own login page in a `WKWebView`, takes the resulting session
id from the web view's cookie store **once**, and thereafter authenticates with a
bearer header. The web view is used only to create the session; no request in the
app's normal operation depends on cookie handling.

Success is detected by **observing the cookie**, never by watching for the redirect:

- `returnTo` cannot be pointed at anything the app controls —
  `AuthEndpoints.IsAllowedLoginReturnTo` accepts only relative paths matching
  `/api/apps/*/open`
  ([AuthEndpoints.cs:242](../../../apps/core/src/Haas.Hosty.Core/AuthEndpoints.cs));
- so a successful login redirects to the Shell public origin, which the device may
  not be able to reach, or renders Core's "this host has no web UI installed" page
  when no Shell is installed.

Both outcomes are successes, and a failed navigation to an unreachable Shell origin
must not be reported as a failed login. The app polls `WKHTTPCookieStore` after each
navigation callback and finishes as soon as `hosty_session` appears for the Core
host.

The session id is stored in the Keychain per host. On launch the app restores it and
probes `GET /api/auth/session`; an unauthenticated answer reopens the login web view.
Sessions slide on use over a 7-day idle window with a 30-day absolute cap
([AuthLifetimes.cs:23](../../../apps/core/src/Haas.Hosty.Core/AuthLifetimes.cs)), so a
`401` is an expected periodic event that reopens login rather than an error to
report.

### Installed apps

`GET /api/apps` returns `AppSummary` records; Core serializes with
`JsonSerializerDefaults.Web`, so Swift `Codable` types map to camelCase without
custom `CodingKeys`.

The list shows each app's display name, icon, version, selected runtime, and
runtime state. Runtime state uses the full vocabulary from `AppRuntimeStates`
([AppRegistryStore.cs:379](../../../apps/core/src/Haas.Hosty.Core/AppRegistryStore.cs)) —
`running`, `starting`, `stopping`, `stopped`, `unknown` — and the client mirrors the
three predicates rather than testing `== "running"`: `starting`/`stopping` are busy,
not stopped. `LastError`, `ManifestError`, and unmet dependencies surface as problem
markers.

App detail shows services, endpoints with their availability, assigned ports,
capabilities, the `live` and lock badges, and the last error.

### Lifecycle

Start, Stop, and Restart call `POST /api/apps/{appId}/{verb}`, which require an
administrator session
([LifecycleEndpoints.cs:84](../../../apps/core/src/Haas.Hosty.Core/LifecycleEndpoints.cs)).
With the bearer path they need no CSRF token.

Controls are disabled while the app is busy. The client does not invent its own
optimistic state machine: Core reports `starting` and `stopping` as real runtime
states, and the UI follows the record.

### Updates

- Per-app availability comes from the app summary and `GET /api/apps/{appId}/update-status`.
- A fleet check posts `/api/apps/update-check` and follows progress through the
  `updateCheck` block on `GET /api/apps` plus `apps.update-check.changed` events.
- Applying an update is plan-first: `POST /api/apps/{appId}/update/plan` returns an
  `AppUpdatePlan` with `Changes`, `RequiresReview`, and `PlanDigest`; the app renders
  it and only then posts `/api/apps/{appId}/update` with that digest. A plan whose
  `RequiresReview` is true is never applied without showing the change list.
- Apps whose selected runtime is `live` have no reviewed-update path; the update
  affordance is hidden for them, as in the browser Shell.
- The apply is asynchronous — it returns immediately and reports progress as
  `operationStatus: "updating"` on the record — so the client returns to the list and
  follows the record instead of blocking on the response.

### Live refresh

`GET /api/events` is the same SSE stream the browser Shell uses. The bus is
hint-only: events carry no state, and the subscriber contract is *connect → resync
through the API → react*, repeated on every reconnect
([core-event-stream.ts](../../../apps/shell/src/app/shell/events/core-event-stream.ts)).
The Swift client implements exactly that contract over `URLSession.bytes`, resyncing
on connect, on reconnect, and when the app returns to the foreground.

Relevant event names: `app.changed`, `app.removed`, `app.update-check.changed`,
`apps.update-check.changed`.

### Administrator-only

`GET /api/apps` filters per user, but Installed Apps, every lifecycle verb, and every
update endpoint are administrator-only. Rather than showing a non-administrator an
empty or permission-denied list, the app detects the role from
`GET /api/auth/session` and renders an explicit "this host user is not an
administrator" state. Broadening to ordinary Host users belongs to whichever later
plan gives them something to do.

### Platform behavior

One SwiftUI app for iOS, iPadOS, and macOS. `visionOS` is removed from
`SUPPORTED_PLATFORMS`: the scaffold claims it, and nothing in this repository can
build or test it.

Three platform constraints are load-bearing and must be handled, not discovered late:

- **iOS App Transport Security.** Hosty hosts on a LAN speak plain HTTP. The app
  declares `NSAppTransportSecurity.NSAllowsLocalNetworking` so `http://` origins on
  the local network are permitted without weakening ATS globally.
- **iOS local network permission.** Reaching a local address requires the local
  network privacy prompt, so `NSLocalNetworkUsageDescription` must be present or
  every request to a LAN host fails.
- **macOS App Sandbox.** The scaffold sets `ENABLE_APP_SANDBOX = YES` with no network
  entitlement, so a sandboxed build cannot reach any host until outgoing network
  connections are enabled.

### Project layout

The generated scaffold is a bare Xcode template — one folder, a `ContentView`, no
tests. It is restructured into a testable contract layer plus a thin app:

```text
apps/shell-swift/
├── Hosty.xcodeproj
├── Config/Version.xcconfig       # MARKETING_VERSION, readable by check-versions.mjs
├── HostyKit/                     # local SwiftPM package: no UI, no platform frameworks
│   ├── Package.swift
│   ├── Sources/HostyKit/         #   CoreClient, CoreEventStream, HostConnection, Models/
│   └── Tests/HostyKitTests/      #   `swift test` — no simulator, no signing
└── Hosty/                        # SwiftUI app target
    ├── HostyApp.swift
    ├── Assets.xcassets
    ├── Onboarding/               #   host entry, login web view
    ├── Apps/                     #   list and detail
    └── Support/                  #   Keychain, formatting
```

The package split is not cosmetic. Every model in `HostyKit` is a hand-written mirror
of a C# record with no spec to check it against, so that layer must stay small,
separately reviewable, and testable against recorded Core payloads without launching
a simulator.

The target and product are renamed `Hosty` (the scaffold's lowercase `hosty` yields
`hosty.app`); the bundle identifier `com.haas.hosty` is already correct. The language
mode moves to Swift 6 with strict concurrency, matching the
`SWIFT_APPROACHABLE_CONCURRENCY = YES` the scaffold already sets.

## Deliverables

### Phase 0 — Project shape and repository integration

- [x] Restructure to the layout above: `HostyKit` package, `Hosty` app target, and a
      unit test target; rename target and product to `Hosty`.
- [x] Narrow `SUPPORTED_PLATFORMS` to `iphoneos iphonesimulator macosx` and
      `TARGETED_DEVICE_FAMILY` to `1,2`; move to the Swift 6 language mode.
- [x] `Config/Version.xcconfig` with `MARKETING_VERSION = 0.1.0` (the repository is
      in `0.x`; the scaffold's `1.0` would claim a stability guarantee that does not
      exist).
- [x] Add the Info.plist keys and entitlements above: `NSAllowsLocalNetworking`,
      `NSLocalNetworkUsageDescription`, macOS outgoing network connections.
- [x] Ignore Xcode user state (`xcuserdata/`, `*.xcuserstate`) and remove the stray
      `.DS_Store` files under `apps/shell-swift`.
- [x] Record the new artifact in `AGENTS.md` ("Where the version lives") and in
      [Repository And Release Model](../repository-release-model.md).

The unit test target is `HostyKitTests`, inside the package. The app target has no
test bundle of its own: an app-hosted test bundle has to be signed and launched,
which buys nothing while the app layer is a view over `HostyKit`. Phase 3 adds one
when the login web view first puts real logic there.

### Phase 1 — Core: session as a bearer credential

- [x] `ResolveSessionAsync` resolves `cookie ?? bearer`, in that precedence.
- [x] `RequireSessionAsync` / `RequireAdminSessionAsync` enforce CSRF only when the
      session did not arrive as a bearer.
- [x] `ReadSessionId`, `GET /api/auth/session`, and `LogoutAsync` accept the bearer
      credential, so a native session can inspect and end itself and the logout
      cascade still stamps issued grants.
- [x] Tests: bearer authenticates; bearer needs no CSRF; **a cookie request cannot
      escape CSRF by also sending a bearer header**; a revoked or expired session
      fails identically on both paths; logout by bearer revokes and cascades.
- [x] Update [Core API](../core-api.md) and [Auth And Gateway Model](../auth-gateway.md).

Implementation note: the CSRF gate is expressed as "only a bearer-presented session is
exempt" rather than "only a cookie-presented session is checked". The two differ for a
request with no credential at all, and the first spelling leaves that case answered
exactly as before — so the only behavior that moved is the one a browser cannot
produce. The check also had to be added to `POST /api/auth/logout`, which gates on CSRF
directly without requiring a session; without it a bearer client could sign in and never
sign out.

### Phase 2 — HostyKit

- [x] `HostConnection`: host origin and display name, with the origin as identity.
- [x] `CoreClient` over `URLSession` with `httpShouldSetCookies = false`, explicit
      bearer attachment, and typed error mapping for the `401` / `403` / `503` split.
- [x] `Codable` models for the consumed contracts: `CoreStatus`, `AuthSession`,
      `AppSummary` (the fields this version renders), `AppUpdateCheckStatus`,
      `AppUpdateStatus`, `AppUpdatePlan`.
- [x] `CoreEventStream`: SSE reader over `URLSession.bytes` implementing the
      connect → resync → react contract with reconnect backoff.
- [x] `HostyKitTests` covering SSE framing, model decoding against recorded Core
      payloads, and error mapping.
- [x] Active-host selection and per-host credential storage. Deliberately moved to
      Phase 3: both are persisted app state (`UserDefaults` and the Keychain) rather
      than contract, and the Keychain work is already there.

Two things worth carrying forward:

- `CoreTimestamp` exists because System.Text.Json writes up to seven fractional
  digits and a numeric offset, and Foundation's obvious parsers handle neither —
  `ISO8601DateFormatter` with `.withFractionalSeconds` takes exactly three digits.
  Every shape Core can emit is pinned by test.
- The event stream yields `.resync` as a stream *element* rather than taking a
  callback. The bus is hint-only, so a subscriber that merely listened would serve
  stale data after any gap; making the resync unavoidable is the point.

### Phase 3 — Connection and session

- [x] Host onboarding: enter an origin, probe `GET /api/core/status`, report a
      non-Hosty or unreachable origin clearly.
- [x] `LoginWebView`: Core's `/login` in a `WKWebView`, success detected by observing
      `hosty_session` in `WKHTTPCookieStore`, with a post-login navigation failure to
      an unreachable Shell origin treated as success.
- [x] Credential persistence in the Keychain per host, restore on launch, re-login on
      `401`.
- [x] Sign out: `POST /api/auth/logout`, then clear the Keychain entry and the
      `WKWebsiteDataStore`.
- [x] Non-administrator state.

Two notes from the build:

- **The status probe compared against the wrong value.** Core reports itself as
  `hosty-core`, not `core`; the invented fixture said `core`, so the check would have
  rejected every genuine host while accepting a near miss. Caught by reading a real
  `GET /api/core/status` off a running Core, and that response is now a test fixture
  in its own right — it also carries the anonymous redaction (`corePort` 0) and a
  five-digit fractional second.
- **Scheme probing replaced a wrong default**, found by driving the real app against a
  tunnelled host: a bare hostname was assumed to be `http://`, and ATS then blocked it
  with a TLS policy error. See [Connecting to a host](#connecting-to-a-host).
- **The add-host footer is one view, never a `switch` over view types.** A
  `@ViewBuilder` switch that yields `Text` in some states and `Label` in others changes
  the section's structure on the first keystroke after a check, which rebuilds the
  section and costs the `TextField` its first responder — the first character lands and
  the rest go nowhere. The state is also no longer rewritten on every keystroke.
- **The minimum-host-version guard was added here**, not planned. It is a direct
  consequence of Phase 1: a bearer-only client against a pre-0.70.0 host produces a
  sign-in loop with no stated cause. See [Host requirement](#host-requirement).
- **The login web view uses a non-persistent `WKWebsiteDataStore`.** Nothing it
  collects outlives the sheet, so sign-out has no web state to clear — the session
  leaves the web view as a value and lives only in the Keychain from then on. That is
  a stronger guarantee than clearing on the way out, and it is why the deliverable
  above is satisfied without an explicit clear.

### Phase 4 — Installed apps and lifecycle

- [x] App list from `GET /api/apps` with runtime-state badges covering the full
      vocabulary, system/user separation, and problem markers.
- [x] App detail: services, endpoints and availability, ports, capabilities, version,
      runtime profile, `live`/lock badges, last error.
- [x] Start / Stop / Restart, disabled while the record is busy.
- [x] Live refresh driven by `app.changed` / `app.removed`.

Notes:

- **Services are derived, not fetched.** Core's `AppSummary` carries no services list;
  each endpoint names the service that owns it, and `artifactLocks` is keyed by the
  same name. The detail view groups endpoints by service and hangs the lock badge off
  that grouping.
- **Manifest icons are deferred.** `GET /api/apps/{id}/assets/{path}` requires a
  session, so `AsyncImage` cannot fetch them — it has no way to attach the bearer
  header. The list uses SF Symbols until an authenticated image loader exists.
- **`inFlight` is not an optimistic state machine.** It covers only the gap between a
  tap and Core committing the transition, so a button cannot be pressed twice; the
  displayed state always comes from the record, which is why `starting`/`stopping`
  appear as themselves rather than as "stopped".

### Phase 5 — Updates

- [x] Per-app update availability and a manual per-app refresh.
- [x] Fleet update check with progress from the `updateCheck` block and
      `apps.update-check.changed`.
- [x] Plan-first apply: render `Changes`, honour `RequiresReview`, post the reviewed
      `PlanDigest`, then follow `operationStatus: "updating"` on the record.
- [x] Hide the update affordance for `live` apps.

Notes:

- **The change list is always shown, not only when `requiresReview` is set.** The flag
  raises the emphasis — a badge and a warning — but it does not decide whether the
  operator is told what would change. Review is the point of the screen.
- **Three states that must not be collapsed into "up to date":** `updateCheck` null
  means never checked; a service marked `unknown` means the registry could not be
  reached or there is no lock to compare against; and an empty change list with
  `sourceConfigured: false` means Core had nothing to compare against. Each is
  rendered as itself.
- **A `live` app gets prose, not a disabled button.** It has no reviewed-update path at
  all, and a greyed-out control would imply one exists.
- **The spinner reads server state.** `updateCheck.running` comes from the host, so a
  sweep another client started shows here too, and joining one is indistinguishable
  from starting it.

### Phase 6 — Verification, CI, documentation

- [x] A `swift-shell` job in `ci.yml` on `macos-latest`, gated by a new `swift_shell`
      paths filter, building for macOS and the iOS Simulator and running the package
      test suite. The repository is public, so GitHub-hosted macOS runners cost
      nothing; the gate keeps the job off unrelated pull requests anyway.
- [ ] Live verification against a real Core (see [Verification](#verification)).
- [ ] Write `feature.md`, delete this `plan.md`, regenerate the docs index.

CI notes:

- **The job asserts Xcode 26 up front.** A runner's *default* Xcode is not necessarily
  its newest, and this project needs the iOS/macOS 26 SDKs plus the Swift 6.2 tools.
  Selecting the newest installed and checking the major version makes "this runner is
  too old" one readable line instead of an SDK error several steps later. This is the
  one part of the job that cannot be proven locally — the runner images are the
  variable — so it is written to fail loudly rather than confusingly.
- **The iOS build uses `generic/platform=iOS Simulator`.** Which simulators an image
  ships changes between releases; naming a device would break on an image bump for no
  benefit.
- Every command in the job was run locally in exactly the form CI uses, and the
  workflow passes `actionlint` 1.7.12 — the same image and version the `actionlint`
  job pins.

**Live verification is the only thing standing between this plan and completion.** It
needs a host running platform 0.70.0, which does not exist yet outside this branch.
Note for whoever runs it: do **not** start a second Core on a machine that already has
a live Hosty host — Core adopts running containers by image match, so a fresh
`HOSTY_HOME` isolates the app registry but not the containers, and stopping the second
Core stops the first one's apps.

## Verification

Per `AGENTS.md`, live app work is verified through Core-managed lifecycle, not by
running things standalone.

- `dotnet test` for Core, including the new bearer/CSRF cases.
- `swift test` in `HostyKit`, and `xcodebuild` builds for
  `-destination 'platform=macOS'` and `-destination 'platform=iOS Simulator,…'`.
- Against a running Core (`hosty core start`): connect to the host, sign in through
  the embedded login, and confirm `GET /api/auth/session` reports the expected user
  over the bearer path.
- Confirm the browser Shell still works unchanged — same login, same CSRF-protected
  mutations — since it shares every code path touched in Phase 1.
- Start, stop, and restart an installed app from the Swift client and confirm the
  transition through `hosty apps list` — including that `starting`/`stopping` are
  displayed while in flight, not collapsed to `stopped`.
- With the client open, drive a lifecycle change from the CLI and confirm the list
  updates from the event stream without a manual refresh.
- Run a fleet update check and a per-app reviewed update, confirming the plan's
  change list is shown before apply and the digest is echoed back.
- Two hosts on one address with different ports, signed in simultaneously, keep
  distinct sessions — the cookie-jar hazard the bearer path exists to remove.
- On a physical iOS device, confirm a plain-HTTP LAN host is reachable (ATS and the
  local network prompt) — the simulator does not exercise either.

## Version Outcome

- Platform (`apps/core` + `apps/cli`): `0.69.0` → `0.70.0` in `Directory.Build.props`
  — new functionality (bearer-authenticated Core sessions).
- `apps/shell-swift`: starts at `0.1.0`, versioned independently in
  `Config/Version.xcconfig`.
- `apps/shell` and every runtime app: unchanged.

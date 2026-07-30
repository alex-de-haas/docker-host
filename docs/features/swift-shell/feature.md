# Swift Shell

Created: 2026-07-29
Updated: 2026-07-30

`apps/shell-swift` is a native SwiftUI client for iOS, iPadOS, and macOS that manages a Hosty host's
installed apps: their state, lifecycle, and updates.

It is a **remote client, not a runtime app**. It is installed on the operator's own device, has no
`manifest.json`, and is never the `ui-client` Core redirects browsers to. It consumes the same browser API
as `apps/shell`, which it neither replaces nor changes.

## Host requirement

The client authenticates **only** with `Authorization: Bearer`, which Core accepts from platform `0.70.0`.
Against an older host every authenticated request answers 401, so a sign-in appears to succeed — the
cookie is harvested — and then bounces straight back to the sign-in screen with nothing to explain why.

The version is therefore checked rather than discovered: `AddHostView` refuses to add a host below the
minimum, and `HostSession` checks once per session (it cannot change while Core runs) and shows an
explicit "update the host" state. An *unparseable* version counts as supported — a scheme this client
cannot read is likelier newer than older, and refusing a host over a parsing failure is the worse mistake.

## Core: a session as a bearer credential

A Host user session is a server-side record; the credential pointing at it travels either as the
`hosty_session` cookie or as `Authorization: Bearer <session id>`. See
[Auth And Gateway Model](../auth-gateway/feature.md) for the full rules. Two of them are load-bearing:

1. **The cookie wins.** Resolution reads the cookie first and only falls back to the header, so a browser
   request carrying a cookie cannot select the CSRF-exempt path by adding a header.
2. **Only an actual bearer session is exempt** from CSRF. A request presenting no credential is answered
   exactly as before the bearer path existed.

The bearer form mints nothing: same record, same sliding idle and absolute windows, same instant
revocation, same explicit-logout cascade.

Native clients need it for a second reason beyond CSRF. Cookies are not isolated by port (RFC 6265), so
two Hosty hosts reachable at one address on different ports share a jar and overwrite each other's
sessions. The client disables cookie handling entirely and attaches the credential itself.

## Connecting and signing in

The operator types an address. Without a scheme both are tried, **https first**, and whichever answers is
stored: a LAN host is plain HTTP while a tunnelled host is HTTPS-only, and guessing `http` for a public
name fails as an App Transport Security policy error that says nothing about adding `https://`.

`GET /api/core/status` confirms a Hosty Core answers there. Core identifies itself as `hosty-core`; a
well-formed JSON reply from anything else is not accepted as a host.

Core has no JSON login, so sign-in shows Core's own `/login` page in a `WKWebView` and takes the session
**once**. Keeping login inside Core's page means any provider Core gains later works with no client
change. Success is detected by observing the cookie, never the redirect: `returnTo` accepts only
`/api/apps/*/open`, so a successful login lands on a Shell origin the device may be unable to reach, or on
Core's "no web UI installed" page. Both are successes, and a failed navigation to an unreachable Shell is
not a failed login.

The session id is stored in the Keychain per host, keyed by origin. The login web view uses a
non-persistent data store, so nothing it collects outlives the sheet. A `401` on any request drops the
credential centrally, so "signed out" never depends on which concurrent request noticed first; a `403`
deliberately does not, because the session is valid and the answer is still no.

Installed Apps, every lifecycle verb, and every update endpoint are administrator-only, so a signed-in
non-administrator gets an explicit explanation rather than an empty list.

## Installed apps and lifecycle

The list shows each app's icon, name, version, selected runtime, and runtime state, in one list — a
system app carries a `System` badge rather than sitting in a separate section, the same shape as the
browser Shell's Installed Apps page. A `Live` badge marks an app whose runtime re-reads the operator's
own folder.

Icons are the manifest-declared display assets Core reports as `iconUrl`. The client fetches them itself
rather than pointing an image view at the URL, for two reasons: a manifest-relative icon is served by
Core's session-authorized asset endpoint and this client's credential travels as a header, which an
image view cannot attach; and the first-party icons are SVG, which no Apple image decoder reads on iOS.
An SVG is rasterized once through an offscreen `WKWebView` — loaded via an `<img>` data URI with
JavaScript disabled, the same inert-image guarantee the browser gets — and cached per host session,
fetched one at a time. The credential is attached only when the icon URL resolves to the host's own
origin; an absolute URL to a third party is fetched bare — and because it never presented the session, a
`401` from it cannot clear the credential either. Only a request that offered the session is allowed to
end it.

An app with no icon, an icon that 404s, or a format the client cannot render gets a placeholder. That
verdict is remembered for the session, but only for a definite answer *about the asset*: an unreachable
host, a Core mid-restart, and an expired session are retried on the next appearance, or a screen of
placeholders would outlive the condition that caused it — including a re-sign-in.

Runtime state carries Core's full vocabulary — `running`, `starting`, `stopping`, `stopped`, `unknown` —
and the client mirrors its three predicates rather than comparing against `"running"`: `starting` and
`stopping` are busy, not stopped. A state this client has never heard of degrades to `unknown` rather than
failing the whole list.

`operationStatus` is the outcome of the **last** operation (`started`, `restarted`, `installed`,
`updated`, …), not a busy flag; only `updating` means work is in flight. There is no `idle` in that
vocabulary.

Start, Stop, and Restart are disabled while a lifecycle verb is in flight on the host, while an update
owns the record, and while the client's own request is outstanding. That last one covers only the gap
between the tap and Core committing — the displayed state always comes from the record.

App detail opens with an identity header — icon, name, and the `System`/`Live` badges — and shows
services (derived by grouping endpoints, since Core reports no services list), endpoint availability,
ports, capabilities, artifact locks, dependencies, and the last error.

## Navigation

Three destinations: **Dashboard**, the host you manage; **Apps**, the apps you use; **Settings**, what
belongs to this device. One `TabView` under `.sidebarAdaptable` renders them as a tab bar on a phone
and a sidebar on iPad and macOS. The same information architecture as the browser Shell — see
[Shell Navigation](../shell-navigation/feature.md). The two clients share the shape and no code.

Managing an app and using one are different jobs for different people, which is why they are different
destinations: a headless app has no UI to open at all, and an ordinary user has no business reading
artifact locks and dependency state.

**The session gate lives above the tabs.** Connecting, signed out, unsupported and unreachable are
states of the host, not of a section of it, and three tabs over a sign-in prompt would describe
nothing.

**A host is the session's account, not a section.** A switcher in every destination's toolbar names
the active host and offers the saved ones; it is present in the pre-session states too, because a host
that cannot be reached is exactly when the operator needs to leave it. Selecting another host rebuilds
the session, its app model, and its event stream as one unit, and clears every per-host selection —
an app id left over from the previous host either selects nothing or, if both hosts run the same app,
silently opens a different machine's copy.

**Apps appear as sidebar entries in regular width and as a pushed screen in compact.** In compact they
are not declared as tabs at all: `defaultVisibility(.hidden, for: .tabBar)` does not keep a
`TabSection`'s tabs out of the compact tab bar, so declaring them there pushes the destinations
themselves behind a "More" item. One router state drives both presentations.

The router is hoisted out of the views because the destinations cross-reference each other: Open from
an app's management detail moves to its workspace, and Manage from a workspace moves back and selects
it. A selection naming an app that has been removed resolves to the Apps list rather than rendering an
empty tab.

## Dashboard

Administrator-only, and absent rather than disabled for anyone else — Core answers none of it to a
non-administrator.

Core's own row sits above the app list: its version, and the update action when a newer release is
waiting. The list header carries one line of counts — running, in progress, needs attention, total —
describing every row, system apps included. Apps mid-verb are counted in neither the running nor the
attention bucket: calling them "not running" reads as a shortfall during a boot that is going fine.

Selecting an app drives the detail column rather than creating a second navigation hierarchy, so on
iPad the client is three columns: destinations, apps, detail.

The tab carries a badge counting what is actionable on that screen: apps with an update available,
plus Core itself as one more.

## Core updates

`GET /api/core/update-status` reports whether a newer Core binary is available; a check that could not
run is not "up to date" and does not offer the action. `POST /api/core/update` answers **202** and
Core then spawns the CLI and restarts itself, so the reply means *started*, not finished — the
connection loss that follows is the update working. The two ways it refuses before any work begins,
`503` when the CLI cannot be located and `500` when the spawn fails, read as ordinary errors.

## Apps and workspaces

The Apps destination lists exactly the apps Core resolved a UI for — a headless app never appears, and
public endpoints alone do not make one. There is no system/ordinary split: Core already filters
`GET /api/apps` per user and refuses a launch code for a system app to a non-administrator, so a
second visibility rule here would be a copy of an authorization decision.

Opening an app is the browser Shell's mechanism exactly, with no Core change: `POST
/api/apps/{id}/launch-code` against the URL Core advertises, then load the URL it returns and let the
app exchange the code for its own identity. The bearer session is CSRF-exempt, so no CSRF pair is
involved. A code is single-use and expires in five minutes, so re-opening always mints again rather
than replaying a spent URL — which would land on a signed-out app. A page switch inside an app that is
already open is a plain navigation: its cookie is already set on that origin.

**Web views are cached per app for the host session**, so switching apps or looking at Dashboard does
not reload the page and re-run the code exchange. The cache is bounded — a web view is an expensive
object — and an evicted app re-opens the way a first open does. One non-persistent data store per host
holds their identity cookies, and sign-out discards both.

**Identity expiry arrives as a navigation, not a callback.** In a web view the app is the top frame,
so the app SDK takes its standalone path: a redirect to Core's `/api/apps/{id}/open`, which without a
Core cookie lands on `/login`. That navigation is intercepted and turned into a fresh launch — main
frame only, this host's Core origin only, this app only, and at most one re-mint every few seconds, so
an app that fails immediately after recovering cannot drive an unbounded loop. Nothing in the SDK
changes.

**Open in Browser mints its own code** immediately before handing the URL over: the one already loaded
in the web view has been spent.

**A loopback app URL is diagnosed rather than loaded.** Core advertises `127.0.0.1:<port>` by default,
which means "this machine" and so resolves to the reader's device rather than the host. The client
cannot rewrite it — Core's redirect allowlist only accepts an origin the app itself declares — so it
explains what to configure instead of presenting a dead web view. The predicate covers the whole
loopback space: `localhost`, all of `127.0.0.0/8`, and `[::1]`. An app carrying an operator-configured
public origin is unaffected. The Core-side fix is
[Advertised App Origins](../advertised-app-origins/plan.md).

## Settings

Saved hosts, adding and forgetting them, and signing out. The host-level configuration the browser
Shell keeps in Settings — users, Core settings, shared mounts — has no counterpart in this client yet,
so the tab is deliberately small rather than merged away.

## Interaction details

App rows switch to a vertical information hierarchy at accessibility Dynamic Type sizes, and the
Dashboard counts stack rather than truncate when their icon-and-number pairs cannot share a line.
Lifecycle controls use the available horizontal width when they fit and stack when they do not. Stop
and Forget are confirmed before dispatch; a failed per-app update refresh remains visible beside the
action instead of being discarded.

The add-host form has explicit field labels and examples, deterministic address-to-name focus order,
keyboard submission, and an inline progress state. Its first field receives default focus when the
sheet opens.

SwiftUI previews use isolated defaults and decoded local fixtures rather than saved hosts or a running
Core. The native App Icon catalog is generated from `assets/hosty-brand/build-assets.mjs`: iOS receives
opaque light, dark, and tinted artwork for the system mask, while macOS receives the rounded brand
tile at every required raster size.

## Live refresh

`GET /api/events` is the same hint-only stream the browser Shell uses: events carry no state, so the
contract is *connect → resync through the API → react*, repeated on every reconnect. The client models
`.resync` as a stream element rather than a callback, so a subscriber cannot consume the stream without
being told when to re-read.

Two details the framing depends on:

- The bytes are split into lines **by the client**, not by `AsyncBytes.lines`, which drops empty lines —
  and a blank line is what dispatches an SSE frame. Fed from `.lines`, a correct parser never dispatches
  anything.
- Comments (`: connected`, `: ping` every 20 seconds) never dispatch. The event stream's idle timeout
  clears that heartbeat, so a quiet host is not mistaken for a dropped connection.

The stream's lifetime is the **app's foreground**, and it follows the host scene rather than any one
destination: a non-administrator has no Dashboard at all, and the operator watching a restart is as
likely to be looking at an app's workspace. Returning to the foreground also forces a re-read, because a suspended connection
dies quietly and its reconnect can be several backoff steps in.

A `401` on the stream ends it and is handed to the session, which owns the signed-out screen; every other
failure is an ordinary gap and reconnects with capped exponential backoff.

## Updates

Per-app availability comes from the record and from `GET /api/apps/{id}/update-status`. A fleet check
posts `/api/apps/update-check` and reads progress from the server's own `updateCheck` block, so a sweep
another client started is visible here too.

Applying is plan-first. `POST /api/apps/{id}/update/plan` builds a plan and returns a `planDigest`, and the
apply must echo that digest back, so an apply can never act on a plan that changed after a person saw it.
The change list is **always** shown; `requiresReview` raises the emphasis but does not decide whether the
operator is told. The apply is asynchronous — the record reports `operationStatus: "updating"` while it
runs.

Three states are never rendered as "up to date": a null verdict means never checked, a service marked
`unknown` means the registry could not be reached, and an empty change list with `sourceConfigured: false`
means Core had nothing to compare against. An app on a live source runtime has no reviewed-update path at
all and gets prose rather than a disabled button.

## Platform

One SwiftUI target for iOS, iPadOS, and macOS. `HostyKit`, a local SwiftPM package, holds the Core
contract layer — models, HTTP client, event stream — with no UI and no platform frameworks, so `swift test`
exercises it without a simulator or a signing identity. Its models are hand-written mirrors of `internal
sealed record` types in `apps/core` with no OpenAPI spec between them, which is why that layer is kept
small and separately reviewable.

Three platform requirements are load-bearing: `NSAllowsLocalNetworking` (LAN hosts speak plain HTTP),
`NSLocalNetworkUsageDescription` (iOS gates local-network access behind a prompt), and the macOS
outgoing-network entitlement (the app is sandboxed).

Timestamps go through `CoreTimestamp`, because System.Text.Json writes up to seven fractional digits and a
numeric offset, and `ISO8601DateFormatter` with `.withFractionalSeconds` accepts exactly three.

The version lives in `Config/Version.xcconfig` and moves independently of the platform and of `apps/shell`.
Distribution is by local Xcode build; nothing packages or publishes this app.

## Testing Expectations

- `HostOrigin` keeps the port as part of identity, and scheme candidates offer https before http.
- Timestamp parsing covers every shape Core emits: no fraction, three digits, seven digits, `Z`, and a
  non-UTC offset.
- SSE framing is tested **from raw bytes**, not from hand-split lines, including a frame torn across
  chunks — testing a parser against hand-split lines hides the one bug that matters.
- Model decoding runs against payloads shaped like Core's real responses, including a recorded
  unauthenticated `GET /api/core/status`, and pins `operationStatus` against Core's real vocabulary.
- An app is openable only when Core resolved a UI for it; a one-page app yields its entry so no caller
  special-cases an empty navigation list, and a declared page without a URL is dropped rather than
  offered. Both UI fields are optional, so a Core that omits them describes a headless app rather than
  failing the whole list decode.
- The launch-code request carries the bearer and a JSON body and no CSRF header, and the Core update
  apply maps 202 (started), 503 and 500 (nothing started) apart.
- The loopback predicate covers `localhost`, `127.0.0.1`, another `127.0.0.0/8` address and `[::1]`;
  an operator-configured public origin is never flagged, a loopback URL read *on* the host is never
  flagged, and an unparseable URL is not reported as unreachable — guessing there would replace a
  truthful load failure with a wrong explanation.
- Client error mapping distinguishes 401 (re-sign-in, credential dropped), 403 (terminal, credential
  kept), 503 (transient), and a non-JSON error body.
- Requests carry the credential as a bearer header and never a cookie; `update/plan` sends a JSON body,
  which Core's model binding requires.
- Asset fetches attach the session only for the host's own origin — a relative icon URL keeps its
  cache-busting query and the bearer header, an absolute third-party URL gets neither, and an absolute
  URL that normalizes back to the host's origin (default port, letter case) is recognized as the host.
- A `401` clears the credential only when the failing request presented it: the host's own asset
  endpoint does, an off-host icon URL does not, and both directions are pinned so the exemption cannot
  widen.
- SwiftUI previews cover an empty host list, a representative app row, its accessibility-size layout,
  and app detail at standard and accessibility text sizes without contacting Core.
- Visual verification covers the compact tab bar holding exactly the three destinations — the per-app
  tab leak is invisible to every other check — and the expanded iPad hierarchy of destinations, apps
  and detail. App rows and the Dashboard counts are also inspected at an accessibility Dynamic Type
  size.
- Live verification against a running host covers sign-in, the app list, lifecycle verbs, an
  externally-driven change arriving over the event stream while both the list and a detail screen are
  open, a fleet update check, a reviewed update applied end to end, opening an app and confirming it
  reports the signed-in user, switching apps and back without a reload, two apps open at once keeping
  their own identity in the shared data store, a workspace recovering after its app session expires,
  and a Core update surviving the restart it causes.

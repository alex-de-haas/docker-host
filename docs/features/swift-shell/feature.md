# Swift Shell

Created: 2026-07-29
Updated: 2026-07-29

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

The list shows each app's name, version, selected runtime, and runtime state, split into user and system
apps, with a `Live` badge on an app whose runtime re-reads the operator's own folder.

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

App detail shows services (derived by grouping endpoints, since Core reports no services list), endpoint
availability, ports, capabilities, artifact locks, dependencies, and the last error.

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

The stream's lifetime is the **app's foreground**, not a view's appearance: stopping it when a view
disappears would kill it behind a pushed detail screen, which is exactly where an operator watches a
restart or an update. Returning to the foreground also forces a re-read, because a suspended connection
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
- Client error mapping distinguishes 401 (re-sign-in, credential dropped), 403 (terminal, credential
  kept), 503 (transient), and a non-JSON error body.
- Requests carry the credential as a bearer header and never a cookie; `update/plan` sends a JSON body,
  which Core's model binding requires.
- Live verification against a running host covers sign-in, the app list, lifecycle verbs, an
  externally-driven change arriving over the event stream while both the list and a detail screen are
  open, a fleet update check, and a reviewed update applied end to end.

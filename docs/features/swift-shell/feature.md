# Swift Shell

Created: 2026-07-29
Updated: 2026-08-28

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

Signing in happens **in the operator's own browser**, through Core's device authorization flow
([access-tokens](../access-tokens/feature.md)). The sheet asks for a device name, requests a code, shows
it as `ABCD-EFGH` with the time it has left, and opens the host's approval page. The operator signs in
there — where their saved password, their password manager, and their passkeys actually are — approves
the code, and the sheet closes on its own when the poll collects the credential.

That detour is the whole point. A `WKWebView` embedded in a third-party app gets **no** AutoFill: it
belongs to Safari, not to WebKit's public API, and the credential saved for `https://core.example` is
bound to that web origin, so a native `TextField` would not be offered it either without an Associated
Domains entitlement — which a client that talks to arbitrary operator-owned hosts cannot declare. Every
fix that stays inside the app is unreachable by design; handing sign-in to a real browser is the only one
that is not.

What comes back is an access token rather than a harvested browser session: the same `AuthSessionRecord`
presented the same way, with a 90-day idle window instead of a browser session's, revocable from Shell's
Access tokens tab. The label the sheet prefills from the device's own name is what the approving human
reads before they say yes — and it stays editable, because on iOS the system name is a model name to an
unentitled app and two phones in one household would otherwise be the same word.

The approval address is shown before it is opened and is opened only when it is `http` or `https`. It is
a string the *host* chose, and this is the last point where a person can see where they are being sent.

**The web view remains, for the hosts that need it.** Core gained the device routes in 0.73.0, so an
older host still shows Core's own `/login` page in a `WKWebView` and takes the session once — and so does
a host whose Core has no Shell to approve a code in, or an operator who simply picks "sign in with a
password instead". The choice is made from the version the status probe already reported, not discovered
from a 404 halfway through showing a code, and it is not a setting: two ways in, one of which cannot
offer a saved password, is not a preference worth exposing.

In the web view, success is detected by observing the cookie, never the redirect: `returnTo` accepts only
`/api/apps/*/open`, so a successful login lands on a Shell origin the device may be unable to reach, or on
Core's "no web UI installed" page. Both are successes, and a failed navigation to an unreachable Shell is
not a failed login.

The sign-in sheet carries an explicit minimum size on macOS, where a sheet is sized by its content and a
web view has no size of its own to give: without one the sheet collapses to its title bar, and the login
page loads where nobody can see it.

The credential is stored in the Keychain per host, keyed by origin — in the **data protection keychain**
on both platforms, so one set of semantics covers both. On macOS that keychain refuses every write from
an app with no keychain access group, and a macOS dev build gets one only from an entitlement:
`Config/Hosty.entitlements` declares `$(AppIdentifierPrefix)com.haas.hosty`, and automatic signing embeds
the provisioning profile that authorizes it. Without it nothing was ever stored — `errSecMissingEntitlement`
on each write, discarded — and the only symptom was a sign-in on every launch, on macOS alone, because an
iOS build always carries the group via its application identifier. The store now asserts on a failed
write instead of discarding the status, so losing the entitlement is a named error rather than a silent
one. The login web view uses a non-persistent data store, so nothing it collects outlives the sheet, and
the device flow presents no credential at all on the two routes whose purpose is producing one — a dead
session must not be offered to the endpoint that replaces it. A `401` on any request drops the credential
centrally, so "signed out" never depends on which concurrent request noticed first; a `403` deliberately
does not, because the session is valid and the answer is still no.

The poll belongs to the sheet, not to a detached task: closing the sheet cancels it, or a device code
would go on being polled for its full ten minutes after the screen that showed it is gone. A host that is
briefly unavailable is waited out rather than reported — the operator is mid-approval in a browser and a
Core that blinks must not cost them the request — while a failure that repeating cannot fix ends the wait
at once. Requests live in Core's memory only, so the poller also stops on its own deadline: a Core that
restarted mid-approval answers `pending` for a code nobody can approve any more.

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

**A host is the session's account, not a section.** Switching one is a rare act, so once there is a
session the Hosts list in Settings is the only place that offers it — a switcher standing above every
destination spent a toolbar naming a host the operator already knows they are on. What it named is
kept: each destination carries the host as its navigation subtitle, so which machine the screen
describes is still on screen, without a control spending a row to say it. The pre-session states keep
the switcher itself, because a host that cannot be reached is exactly when the operator needs to leave
it and Settings is behind the very session that is missing. Selecting another host rebuilds the
session, its app model, and its event stream as one unit, and clears every per-host selection — an app
id left over from the previous host either selects nothing or, if both hosts run the same app,
silently opens a different machine's copy.

**Chrome is spent on the host, not on the client.** Every destination uses a leading inline title with
the host beneath it (`toolbarTitleDisplayMode(.inlineLarge)`), and the two searchable ones collapse
their search field into a toolbar button rather than a band above the list. A large title costs a
screen's worth of height to repeat the word the selected tab already says, and swapping *only* the
title gains nothing — the search field takes the band the large title vacates. `inlineLarge` rather
than `inline` because a plain inline title is centered until the toolbar runs out of room and then
jumps to the leading edge, which would move the title depending on whether an update happens to be
waiting. Pushed and modal screens keep an ordinary centered inline title: they are titled by what the
operator came from, not by where they are.

**Apps appear as sidebar entries in regular width and as a pushed screen in compact.** In compact they
are not declared as tabs at all: `defaultVisibility(.hidden, for: .tabBar)` does not keep a
`TabSection`'s tabs out of the compact tab bar, so declaring them there pushes the destinations
themselves behind a "More" item. One router state drives both presentations.

**The flat Apps list is a compact destination only.** In regular width the sidebar lists every app by
name a few rows below the destinations, so a destination whose entire content is a grid of those same
rows leads back to what the operator can already see. It is therefore not declared at all outside
compact, rather than declared and hidden. Two destinations can then name a tab that is not there —
Dashboard for a non-administrator, and the Apps list in regular width — and both resolve to the first
one that exists: Dashboard, else the first app, else Settings, which is the one destination every role
gets on every host.

Sidebar rows carry one repeated grid symbol rather than each app's own artwork. A `Tab` draws an icon
only from its `systemImage`/`image` initializers. Measured on macOS 26: a custom `label` handed a
plain `Color` with an explicit frame drew nothing at all, and handed the app's own `Image` drew it
stretched into a tall pill that also grew the row — an explicit square frame and a 1:1 aspect ratio
were both ignored. Per-app artwork in the sidebar needs a `List`-backed sidebar rather than a
`TabSection`.

The router is hoisted out of the views because the destinations cross-reference each other: Open from
an app's management detail moves to its workspace, and Manage from a workspace moves back and selects
it. A selection naming an app that has been removed resolves to the Apps list rather than rendering an
empty tab — and, where that list is not itself a destination, on to the first one that is.

## Dashboard

Administrator-only, and absent rather than disabled for anyone else — Core answers none of it to a
non-administrator.

Core's own row sits above the app list: its version, and an `Update` action when a newer release is
waiting. The action is labelled by the verb alone — the row already says what is being updated, and
the release tag it could name is a build identifier that on a dev channel reads as a branch name. The
toolbar carries the two fleet-wide actions: check for updates, and apply every routine one.

The list header carries one caption-sized line of counts describing every row, system apps included:
running, total, in progress, updates available, needs attention. Each is an icon and a number with no
word — the words fit one line only while there were three counters, and the extra ones appear exactly
when the host is busiest and the header is worth reading. The word survives in the accessibility
label, where it costs no width.

Running and total are always there; the other three appear only when non-zero, which is why they come
last — the line grows rightwards from a shape the operator already knows. A zero beside a warning icon
is the normal state of a healthy host, and that is how a warning stops being read. Updates available
is in the blue of the markers on the rows it counts. Needs attention is red when any of those apps has
**failed** — a failed operation, a recorded error, or a manifest Core cannot read — and orange when
the only problem is a shortfall such as an unmet dependency, so the alarm colour still means something
when an app is genuinely broken. Apps mid-verb are counted in neither the running nor the attention
bucket: calling them "not running" reads as a shortfall during a boot that is going fine. Core is in
none of these counts — it is its own row, with its own update action.

A row's update marker is the action, not just the news: one tap applies a routine update, and opens
the plan of one that must be read first. It carries a 44pt target of its own and a borderless button
style, because the row around it is a navigation link and a `List` would otherwise hand the button
every tap in the row. The marker is disabled, not hidden, while the host already owns work on that
app.

Selecting an app drives the detail column rather than creating a second navigation hierarchy, so on
iPad the client is three columns: destinations, apps, detail.

**On macOS the two panes are an `HSplitView`, not a second `NavigationSplitView`.** Nesting one
navigation container's split inside another's makes macOS 26 subtract the outer sidebar's width a
second time. Measured in a 1200pt window with a 148pt tab sidebar and a 308pt list, the nested detail
was laid out in `1200 − 148 − 308 − 148`: its content came out 556pt wide instead of 704 and pinned to
the right edge of its pane, and the window refused to be dragged below 1453pt. An outer
`NavigationSplitView` fails identically, so the fault is the nesting rather than the `TabView`.
`HSplitView` is a plain `NSSplitView` and takes the inset once: the detail fills its pane, and the
window floor fell to 1048pt — the sidebar, the list's own minimum, and what the detail's form
actually needs. Each pane carries its own `NavigationStack`: the list's title, subtitle, search field
and toolbar have to hang from something now that the split view is gone, and one shared stack would
put the list's title and the detail's in the same container, where which of them wins is decided by
view order rather than by intent.

iOS keeps the `NavigationSplitView` it had. `HSplitView` is a macOS type, and iPadOS 26 was measured
and does not share the defect: on a 1376x1032 iPad in landscape the same nesting puts the detail's
content at x=610 with width 746 — the list column ends at 590, plus a 20pt margin, filling the rest of
the window exactly. The same shape on macOS was out by the width of the tab sidebar.

The list pane is 300–460pt, ideally 352. The floor is what an app row needs to keep one line per
fact: at 260 the name and its `System` badge wrapped, and "Running" broke in two, as soon as a detail
appeared beside it and the split gave the list its minimum. A declared width is also what stops the
pane being the one AppKit hands the whole delta to during a live resize — before it had one, the list
ballooned from 352pt to 711pt for the length of a window-edge drag and snapped back on release.

Rows carry the selection as a `tag` rather than a `NavigationLink`: the pane beside the list reads
that selection, and on macOS there is no navigation destination left for a link to push. This still
pushes in compact width, where the iOS split view collapses into a stack — verified on an iPhone
simulator against the same shape the client uses, an observable router with the list in a child view
and the detail reading the property the list writes: tapping a row shows the detail with a working
back button.

The tab carries a badge counting what is actionable on that screen: apps with an update available,
plus Core itself as one more.

## Core updates

`GET /api/core/update-status` reports whether a newer Core binary is available; a check that could not
run is not "up to date" and does not offer the action. `POST /api/core/update` answers **202** and
Core then spawns the CLI and restarts itself, so the reply means *started*, not finished — the
connection loss that follows is the update working. The client polls until the host answers again,
then re-reads the version, the verdict and the app list; the once-per-session version check is cleared
first, because a Core update is the one thing that changes a version while the app is running. It
gives up after a bounded wait rather than claiming progress indefinitely. The two ways Core refuses
before any work begins, `503` when the CLI cannot be located and `500` when the spawn fails, read as
ordinary errors.

A check that could not run leaves no verdict behind: keeping the previous one would offer the update
action, and count toward the Dashboard badge, on the strength of an answer a failure has just
contradicted.

## Apps and workspaces

The Apps destination shows exactly the apps Core resolved a UI for — a headless app never appears, and
public endpoints alone do not make one. There is no system/ordinary split: Core already filters
`GET /api/apps` per user and refuses a launch code for a system app to a non-administrator, so a
second visibility rule here would be a copy of an authorization decision.

**A grid of icons, not a list of rows.** This destination answers one question — which app do I want to
open — and an icon answers it faster than a line of text. Everything a row carried besides the name is
management detail and lives on Dashboard: version, runtime, and the `System` badge, which marks
ownership and has nothing to say to someone opening an app. The columns are `.adaptive` against a
scaled minimum width, so Dynamic Type reflows the grid to fewer, wider tiles rather than squeezing
names; the name itself takes two reserved lines rather than the home screen's single truncated one,
because "Hosty Marketplace" and "Project Manager" do not fit in one and a reserved second line keeps
every tile the same height.

Being openable and being ready stay different questions. An app that is not running is dimmed and
carries a corner dot in that state's own colour, and its accessibility label names the state in words,
since neither dimming nor a colour survives being read aloud. All five states keep their own
appearance here as they do on a management row: an app Core cannot classify is not an app at rest, and
one grey dot for both `stopped` and `unknown` would say it is. The words and colours live on
`AppRuntimeState` rather than being restated per view — two lists for the same five states drift, and
the one that drifts is the one shown least often.

Opening an app is the browser Shell's mechanism exactly, with no Core change: `POST
/api/apps/{id}/launch-code` against the URL Core advertises, then load the URL it returns and let the
app exchange the code for its own identity. The bearer session is CSRF-exempt, so no CSRF pair is
involved. A code is single-use and expires in five minutes, so re-opening always mints again rather
than replaying a spent URL — which would land on a signed-out app. A page switch inside an app that is
already open is a plain navigation: its cookie is already set on that origin.

**The client declares its launch mode on the URL it loads**, `hosty_launch=native`, so the app drops
the name and page navigation this client already renders in its navigation bar and pages menu — see
[Embedded App Chrome](../embedded-app-chrome/feature.md). It is declared on both paths that open a
page, the fresh launch and the plain navigation of a loaded web view, and deliberately not on *Open
in Browser*, which exists to leave the client. The loopback diagnosis still reads the address Core
advertised: what it judges is where the app lives, which a parameter cannot change.

`native` rather than `embedded` because the two modes differ in exactly the way this client does. In
a web view the app is the top frame, so it has no parent to post `hosty:auth-required` to; `native`
keeps the standalone redirect, which is the navigation the recovery interception below is built on.

**Web views are cached per app for the host session**, so switching apps or looking at Dashboard does
not reload the page and re-run the code exchange. The cache is bounded — a web view is an expensive
object — and an evicted app re-opens the way a first open does. One non-persistent data store per host
holds their identity cookies, and both are discarded whenever the session ends, not only when the
operator taps Sign out: an expired or revoked bearer ends it just as finally, and an app's own grant
outlives the Core session that authorized it, so a workspace left loaded would hand the next person to
sign in the previous user's app identity.

The cache has **two accessors, and only one of them may be called from a `body`**. Looking a web view
up is a pure read; creating one, recording it as most recently used, and evicting the oldest are
writes. The store is `@Observable`, so a write made while SwiftUI is rendering invalidates the very
view being rendered — `body` reads the store, the store writes its use-order, the write invalidates,
and `body` runs again. That loop pinned a core and grew until the process was killed, and the app
never appeared at all: the run loop never got far enough to load the page. The lookup used from `body`
therefore writes nothing, and the mutating one is called from the task that opens the app, before the
state that renders the web view is set.

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

Core writes its changes as machine tokens — `artifact:backend:sha256:f05e…->sha256:1df5…`,
`setting:apiKey:type:string->secret`. Each is parsed into the thing that changed and the values it
moved between, and the two are rendered apart: the subject as prose, the values on their own
monospaced line, with digests shortened to twelve hex characters. Run together as Core writes them,
a change list is a wall of tokens nobody reviews, which defeats the point of showing it. The
vocabulary mirrors `formatUpdateChange` in the browser Shell — two clients reading the same tokens
must not invent two names for them. An unrecognized token is shown verbatim rather than dropped:
Core's vocabulary grows, and a dropped line is approval given for something never seen.

Two parts of that parse are deliberately non-structural, because Core's value signatures are built from
the same punctuation as its tokens. A named facet (`type`, `secret`, `runtimeType`) is recognized from a
closed list rather than from "there is a separator before the arrow" — an endpoint signature is
`http:public=True:service=web:port=8080`, whose first field is a protocol. And the arrow that separates
old from new is the **middle** one, not the first: a port signature is `{protocol}:{host}->{container}:…`
and carries an arrow of its own, so a port transition holds three. Both sides of a transition are the
same grammar and therefore hold the same number of internal arrows, which makes the middle occurrence
the separator whenever the count is odd; an even count means that assumption does not hold, and the
value is shown whole rather than split in the wrong place. Both rules fail towards raw text, so a
signature grammar that moves degrades to something unhelpful rather than to something untrue.

A verdict is **routine** when it is applicable without a person reading the plan: `updateAvailable`,
not `requiresReview`, a `planDigest` to echo back, and no update already running. That is the same
filter the browser Shell uses, and it lives on `AppSummary` so the count shown and the set sent are
provably one set. The digest clause belongs to the filter rather than to send time: an app with no
plan to echo back is refused by Core, so counting it would promise an apply that cannot happen.

Routine verdicts have two one-tap paths, both of which apply the plan the fleet check already built
rather than building a new one. A row's marker applies that app; **Update all** in the toolbar applies
every routine verdict at once, confirming first with the count — a toolbar button renders icon-only,
so the count the browser Shell puts in its label has nowhere else to go. Neither path can reach a
review-class plan: the batch skips it and the confirmation says how many it left behind for that
reason, and the row marker opens the plan instead of applying it. A count smaller than the markers on
screen would otherwise read as apps being missed.

The batch's applies are separate requests, and a refusal is counted rather than ending the sweep; the
rows carry the progress, because each accepted apply shows as `updating`. There is no "Shell last"
ordering as in the browser Shell: this client is not served by any app on the host, so nothing it runs
from can restart underneath it. The button is absent, not disabled, when there is nothing routine to
apply.

Both paths reserve an app for the length of its own request, and re-read the digest from the current
list immediately before sending. Neither is optional: an apply this client has already sent is invisible
in the record until Core commits `updating` and a reload brings it back, and the batch awaits between
sends, so its snapshot can name an app a row tap has meanwhile applied. Without the reservation the two
submit the same plan twice, Core's single-flight guard refuses one, and the client reports a failed
update that in fact started. An app skipped for being no longer applicable is skipped, not counted as a
failure — the summary counts what was actually sent.

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
- Device login is covered as a state machine, not as a screen: each status maps to its outcome, an
  approval with no token and an unknown status are refused rather than stored, the loop honours the
  interval Core asked for, a transient failure is waited out while a permanent one ends the wait, and a
  request that outlives its own lifetime expires locally. Neither device route presents a credential
  even when the client still holds a stale one, and only an `http`/`https` verification address is
  opened.
- The version floor for device login is pinned in both directions, including the two ways a version is
  not a number: unreadable counts as new enough, absent does not.
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
- The launcher's readiness treatment is covered by preview rather than by live checking: every app on a
  healthy host is running, so a dimmed tile and its corner dot cannot be seen against one without
  stopping something real. The fixture reaches the other states by round-tripping an `AppSummary`
  through its own wire format, which keeps HostyKit from needing a public initializer for a preview.
- The routine-update filter is pinned on `AppSummary` rather than in a view: each clause is a refusal
  (review-class, no digest, already updating), and routine and needs-review are asserted exclusive, so
  the count an operator confirms cannot drift from the set that is sent.
- Change-token parsing is covered per token shape against Core's own vocabulary, including the two
  digest endpoints that are not digests (`none`, `unknown`), `data:compatible` — which means the
  opposite of a change — and an invented token, which must survive verbatim. A plan is approved on the
  strength of this list, so a mis-read or dropped line is approval given for something else.
- The signature shapes are pinned with Core's real output, not with simplified stand-ins: a colon-built
  endpoint and dependency signature, whose first field must not be read as a facet, and a port
  transition, whose signature carries an arrow of its own so that the separating arrow is not the first
  one. An arrow count that cannot be resolved is asserted to leave the value whole.
- Visual verification covers the compact tab bar holding exactly the three destinations — the per-app
  tab leak is invisible to every other check — and the expanded iPad hierarchy of destinations, apps
  and detail. It also covers every sheet **on macOS**, where a sheet without an explicitly sized
  content view collapses to its title bar while behaving correctly everywhere else. App rows and the
  Dashboard counts are also inspected at an accessibility Dynamic Type size, where the update marker
  becomes a labelled row rather than a glyph at the far edge.
- Column widths on macOS are verified **during** a window-edge drag, not from before-and-after
  screenshots: a pane with no width of its own absorbs the whole resize while the mouse is down and
  snaps back on release, so both still frames agree and the defect is invisible. A synthetic
  press-move-release also has to move in steps — a single jump resizes the window without AppKit ever
  entering a live resize, which is exactly the state that shows the bug.
- The window's own floor is checked by dragging an edge until it stops, and read back from the window
  frame rather than judged by eye. A layout that insets itself twice does not look wrong at rest; it
  shows up as a window that refuses to get smaller and springs back.
- Signing in on macOS is verified across a relaunch, not only within one: the credential surviving a
  quit and reopen is the check that catches a keychain write failing silently, which inside a single
  run looks like nothing at all. The built product's entitlements must carry the keychain access group:
  `codesign -d --entitlements - <path to the built Hosty.app>`.
- Opening an app is verified with the process's CPU in view, not only with a screenshot: a render loop
  in the workspace shows up as a pinned core and a growing footprint while the screen sits on its
  spinner, which reads as "the app is slow to open" in a screenshot and as nothing at all in a test.
- The sign-in sheet is verified against a host that answers the device routes: the label reaching the
  host as typed, the code and its countdown, approval closing the sheet on the collecting poll, a
  denial stating itself, the password fallback reaching the web view, and a host below 0.73.0 going
  straight to it.
- Live verification against a running host covers sign-in, the app list, lifecycle verbs, an
  externally-driven change arriving over the event stream while both the list and a detail screen are
  open, a fleet update check, a reviewed update applied end to end, opening an app and confirming it
  reports the signed-in user, switching apps and back without a reload, two apps open at once keeping
  their own identity in the shared data store, a workspace recovering after its app session expires,
  and a Core update surviving the restart it causes.
- A row's update marker is verified against a live host in both directions: the tap applies the update
  rather than opening the app, and a tap anywhere else on the row still navigates. A `List` gives a
  plain button the whole row, so this is the check that the borderless style and the marker's own
  target actually took effect.

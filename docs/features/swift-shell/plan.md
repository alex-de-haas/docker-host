# Swift Shell — Tabbed Navigation And App Workspaces

Status: Ready
Created: 2026-07-30
Updated: 2026-07-30

## Goal

Let the native client open an app's own UI, and give that ability a home that is not the management
screen.

The two are one piece of work because the second is what makes the first honest. Managing an app and
using an app are different jobs for different people: a headless app has no UI to open at all, and an
ordinary user has no business reading artifact locks and dependency state. An "Open" button bolted onto
the management hierarchy would merge both audiences into one screen and leave the client unable to grow
a non-administrator surface later. So the navigation is split first, and the workspace lands on the
using side of the split.

The same information architecture is being applied to the browser Shell — see
[shell-navigation](../shell-navigation/feature.md). The two clients share the shape and no code.

## Target behavior

A diff against [feature.md](feature.md), sections `## Adaptive interface and interaction` and
`## Installed apps and lifecycle`:

**Root becomes a `TabView`, not a three-column split.** Three destinations — Dashboard, Apps,
Settings — under `.tabViewStyle(.sidebarAdaptable)`, so one declaration yields a tab bar on compact
iPhone and a sidebar on iPad and macOS. A `TabSection("Apps")` carries one entry per UI-capable app,
hidden from the compact tab bar; the flat Apps list is hidden from the sidebar, where it would only
duplicate the section. The result is the browser Shell's sidebar on a Mac and an ordinary tab bar on a
phone, from one structure.

**Hosts stop being a navigation column and become the session's account.** A switcher in the toolbar
names the active host and lists the saved ones plus "Add host…"; it is present in every tab and in the
pre-session states, because a host that cannot be reached is exactly when the operator needs to leave
it. Adding and forgetting hosts moves to Settings. Session states that are not `signedIn` —
connecting, signed out, unsupported, unreachable — render above the `TabView` rather than inside a
tab: three tabs over a sign-in prompt describe nothing.

**Dashboard is the management surface**: a compact Core section (version, status, and the update
action), then today's app list with the existing list-and-detail split, its header carrying one line
of counts — running, needs attention, total. Same order and the same split of
responsibility as the browser Shell's merged Dashboard — facts about the host sit beside the table
they describe, while editable configuration belongs to Settings. On iPad that nests inside the tab
sidebar and the client is three columns again. Administrator-only, and absent — not disabled — for
anyone else.

**Apps is the launcher.** It lists only apps Core reports with an entry URL, which is exactly the apps
that declare a `ui` block; a headless app never appears. Selecting one opens its own UI in a web view.
The system/ordinary split is not reproduced here: Core already filters `GET /api/apps` per user and
refuses a launch code for a system app to a non-administrator
(`AppAccessPolicy.CanAccessApp`), so an administrator sees one list with a `System` badge and everyone
else sees only what was assigned to them. A second client-side visibility rule would be a copy of an
authorization decision, which is how the asset endpoint once became a hole.

**Settings holds what belongs to this device**: saved hosts, adding and forgetting them, and signing
out. The host-level configuration the browser Shell keeps in Settings has no counterpart in this
client yet, so the tab starts small on purpose rather than being merged away — the three-destination
shape is the part the two clients share.

**One badge, on Dashboard**, counting available updates with a waiting Core update counted as one.
Everything it counts is actionable on that screen; a badge pointing at a tab with nothing to act on
would be the wrong kind of consistency.

**Opening an app** follows the browser Shell's mechanism exactly, with no Core change:
`POST /api/apps/{id}/launch-code` with the app's entry URL as the redirect URI, then load the returned
URL. The client's credential is a bearer session, and a bearer-presented session is CSRF-exempt
(`CoreSessionAuthorization`), so the request needs no CSRF token. The code is single-use and expires
in five minutes, so re-opening always re-mints rather than reloading a spent URL.

Three consequences the implementation has to respect:

- **Identity expiry is a navigation, not a callback.** In a web view the app is the top frame, so the
  app SDK picks its standalone recovery: a redirect to Core's `/api/apps/{id}/open`, which without a
  Core cookie lands on `/login`. The native equivalent of the browser Shell's `hosty:auth-required`
  handling is to intercept that navigation, cancel it, mint a fresh code and load the new URL. Nothing
  in the SDK changes.

  The interception is narrow and rate-limited, for the same reason the browser Shell's is: only a
  main-frame navigation, only to this host's own Core origin, only for this workspace's app id, and at
  most one re-mint per app per few seconds. An app that fails immediately after recovery would
  otherwise drive an unbounded mint-and-reload loop against Core. Past the throttle the workspace
  shows an explicit failure instead of trying again.
- **Reachability is a real failure mode, not an edge case.** An endpoint URL is built as
  `{protocol}://{RuntimePublicHost}:{port}` with `127.0.0.1` as the default, which no other device can
  reach — and the client cannot rewrite the host, because Core's redirect allowlist only accepts an
  origin the app itself declares. The client must recognise a loopback entry URL on a host it did not
  reach over loopback and say what to configure, rather than presenting a dead web view. The predicate
  covers the whole loopback space — `localhost`, all of `127.0.0.0/8`, and `[::1]` — not the default
  literal alone.

  An app whose endpoint carries an operator-configured public origin is unaffected: Core advertises
  that origin instead and the allowlist accepts it, so a tunnelled or proxied app opens from anywhere
  with nothing extra from this client.
- **A web view per app, cached for the host session.** Switching between apps, or to Dashboard and
  back, must not reload the page and re-run the code exchange. The cache dies with the host session,
  along with a non-persistent data store shared by that host's apps. It is bounded rather than
  unbounded: a web view is an expensive object and an operator with a dozen apps would otherwise
  accumulate a dozen live ones. Least-recently-used eviction, and an evicted app re-opens by minting a
  fresh code — the same path a first open takes.

  Sharing one data store across a host's apps is what makes the identity cookies coexist, and it is
  also the thing that would break if two apps ever chose the same cookie name. The contract says they
  will not; this is worth confirming with two apps open rather than assuming.

## Deliberately not doing

- **Fixing loopback reachability**, which is a Core-side concern and belongs to
  [advertised-app-origins](../advertised-app-origins/plan.md). No client can fix it: the address Core
  advertises is the address the redirect allowlist accepts, so rewriting it here would only produce
  `redirect_uri_denied`. This client ships the explanation. Until that plan lands the diagnosis is a
  heuristic — a loopback entry URL against a non-loopback host origin — because the endpoint contract
  carries no bind scope yet; that plan makes it exact, and this one should not invent a second signal
  in the meantime.
- **Host-level administration in Settings.** The browser Shell's Settings aggregates user management,
  Core settings, and shared mounts. None of those surfaces exist in this client, and building three of
  them is a larger piece of work than everything else here combined. The tab ships with the device
  group; growing it is a separate decision, not deferred work belonging to this plan.

## Deliverables

- [ ] `HostyKit`: `AppSummary` decodes the app entry URL and manifest navigation pages; `CoreClient`
      gains launch-code minting; tests cover both against Core-shaped payloads.
- [ ] `HostyKit`: Core update support, which does not exist in this client at all today — a
      `CoreUpdateStatus` model, `GET /api/core/update-status` (including its `refresh` query), and
      `POST /api/core/update`. Both are administrator-only, and the apply answers **202** with a status
      and a log path: it spawns the CLI and Core then restarts itself, so the client must treat the
      reply as "accepted, not finished", stop treating the ensuing connection loss as an error, and
      reconnect. `503` (CLI not found) and `500` (spawn failed) are the two ways it refuses before any
      work starts and must read differently from a restart.
- [ ] Core status and update state held on the host session, so Dashboard and the tab badge read one
      snapshot rather than each fetching their own.
- [ ] Root restructure: `TabView` with the three destinations, `TabSection` for apps, per-placement
      visibility, and the session-state gate above it.
- [ ] Host switcher in the toolbar of every destination and of the gate; host add/forget moves to
      Settings; removing the active host still resolves to a defined state.
- [ ] Navigation state hoisted to one observable router so cross-tab jumps work: "Open" from app
      detail selects the app in Apps, "Manage" from a workspace selects it in Dashboard.
- [ ] Dashboard: Core section (version, status, update action) above the existing list-and-detail
      hierarchy, with running / needs attention / total counts in the app list header; tab badge
      counting app updates and a waiting Core update.
- [ ] Apps: list of UI-capable apps, compact and regular presentations, search.
- [ ] Workspace: web view per app cached per host session under an LRU bound, launch-code minting on
      open, manifest navigation pages in the toolbar, and "open in browser" minting its **own** fresh
      code immediately before handing the URL over — a code is single-use, so the URL already loaded
      in the web view has been spent and would open a signed-out app.
- [ ] "Manage" from a workspace, administrator-only, since its destination is the Dashboard tab that a
      non-administrator does not have.
- [ ] Identity-expiry interception: a navigation to Core's login or open endpoint re-mints and reloads.
- [ ] Loopback-reachability diagnosis with an explanatory state instead of a dead web view.
- [ ] Settings: saved hosts, add and forget, sign out.
- [ ] Non-administrator behavior: Dashboard absent, Apps and the device group present, with no
      client-side filtering beyond the role check.
- [ ] `MARKETING_VERSION` minor bump in `Config/Version.xcconfig`.
- [ ] `feature.md` rewritten for the shipped navigation and workspace; this plan deleted; docs index
      regenerated.

## Phases

One branch, one PR. The order below is what keeps the app buildable between commits.

### Phase 1 — Contract

- [ ] `HostyKit`: entry URL, navigation, launch codes, Core update status and apply, with tests.

### Phase 2 — Structure

- [ ] `TabView`, session gate, host switcher, router, Settings.

### Phase 3 — Surfaces

- [ ] Dashboard with the Core section and counts; Apps list; badge.

### Phase 4 — Workspace

- [ ] Web view, cache and eviction, recovery interception, reachability diagnosis, open in browser.

### Phase 5 — Close-out

- [ ] Version bump, `feature.md`, plan deletion, index.

## Open questions

None.

## Verification

- `swift test` for `HostyKit`: entry-URL and navigation decoding, launch-code request shape (bearer,
  no CSRF header, JSON body), Core update status decoding and the apply's 202/503/500 mapping, and the
  loopback predicate across `localhost`, `127.0.0.1`, another `127.0.0.0/8` address, and `[::1]`.
- Build for iOS and macOS.
- Visual: compact iPhone tab bar and iPad/macOS sidebar from the same build; Dashboard's three-column
  hierarchy on iPad; an accessibility Dynamic Type size on the Apps list and on the Dashboard counts
  header, which has to stay legible when its icons and numbers can no longer share a line.
- Live against a running host: open a UI app and confirm the app reports the signed-in user; switch
  apps and back without a reload; leave a workspace open until the app session expires and confirm it
  recovers without a visible sign-in; open a headless app's Dashboard entry and confirm it offers no
  workspace; sign out and confirm every cached web view is discarded. Open two apps at once and
  confirm each keeps its own identity in the shared data store. A host with a Core update pending
  shows the Dashboard badge, applies from the Core section, survives the restart that follows, and
  comes back with the new version.
- Live negative: a host whose apps advertise `127.0.0.1` shows the configuration explanation on every
  device except the host itself — a loopback URL is only correct when the client runs **on** the Hosty
  host, and on any other machine it points at that machine. An app carrying a public origin opens
  normally on the same host, which is what isolates the failure to the advertised address.

# Embedded App Chrome — Apps Drop Their Own Top Navigation Inside A Shell

Status: Draft
Created: 2026-08-04
Updated: 2026-08-04

## Goal

When an app's UI is displayed inside a shell — the browser Shell's workspace iframe or the Swift
Shell's workspace web view — the app suppresses its own app-level chrome: the wordmark or app title
and the top navigation between its manifest pages. The shell already renders both, so today they
appear twice: the manifest `ui.navigation` pages are drawn by the browser Shell's sidebar, by the
Swift Shell's pages menu, *and* by the app's own header. The Swift client even documents the
double-header in code — `AppWorkspaceView` keeps its title bar inline because "the app's own
interface starts immediately below this bar and has its own header".

Opened standalone — a browser tab on the app's direct origin, or *Open in Browser* from the native
client — the app keeps its full chrome, because there is no shell around it to navigate with.

## Current reality

There is no signal an app can use to make this decision in both shells.

- In the browser Shell's iframe, `detectLaunchMode` in `@hosty-sdk/app` answers `embedded` from
  `window.self !== window.top`. Today its only consumer is the recovery decision
  (`decideRecoveryAction`); no first-party app uses it for layout.
- In the Swift Shell's `WKWebView` the app **is** the top frame, so the same heuristic answers
  `standalone`, and every parent-postMessage path is dead. The client relies on that: identity
  expiry is recovered by intercepting the SDK's *standalone* redirect to Core's `/open`/`/login`
  in a `WKNavigationDelegate` (`WorkspaceStore.RecoveryCoordinator`).
- The only launch-time, URL-borne contract that exists is the theme pair: the browser Shell appends
  `hosty_theme` / `hosty_theme_preference` to the `redirectUri` before minting a launch code, and
  each app's theme bridge reads the params, persists them in `sessionStorage`, and cleans them from
  the URL. The Swift client appends nothing and loads Core's advertised `embeddedUrl` verbatim.

## Target behavior

### The signal: a third launch mode, carried the way the theme already is

`AppLaunchMode` grows a third value:

- `embedded` — framed by the browser Shell. Chrome hidden; recovery posts `hosty:auth-required`
  to the parent. Unchanged.
- `native` — top frame inside a native shell's web view. Chrome hidden; recovery takes the
  **standalone** path (the Core `/open` redirect), which is exactly the navigation the Swift
  client's interception is built on. Nothing about recovery changes for it.
- `standalone` — a plain browser tab. Chrome shown; recovery redirects. Unchanged.

Two orthogonal decisions read the one mode: *chrome* is hidden whenever the mode is not
`standalone`; *recovery* posts to the parent only when the mode is `embedded`. This is why hiding
chrome cannot be done by flipping the existing heuristic to `embedded` in a web view — it would
send recovery down the postMessage path to a parent that does not exist.

The mode travels as one query parameter on the launch `redirectUri`, `hosty_launch`, next to the
theme pair and by the same rules:

- The **browser Shell** appends `hosty_launch=embedded` where it appends the theme params
  (`appendHostyThemeParams` grows a sibling or a parameter). The frame heuristic already answers
  `embedded` there, so the explicit value is hardening plus one shared code path with the native
  client — and the fallback that keeps an app correct under an older Shell.
- The **Swift Shell** appends `hosty_launch=native` to the page URL in `AppWorkspaceView.open(page:)`
  — in both branches: the plain navigation of an already-loaded web view and the `redirectUri` sent
  to `POST /api/apps/{id}/launch-code`. Recovery re-mints through the same `open(page:)` path, so
  one construction site covers it. *Open in Browser* deliberately does **not** append it: that
  hand-off exists to leave the shell.
- The **SDK** resolves the mode with explicit precedence: a valid URL param wins, then the value
  persisted in `sessionStorage`, then the frame heuristic. The winning param is persisted and
  cleaned from the URL, exactly the theme bridge's contract — so app-internal navigation, which
  carries no params, keeps the mode for the life of the tab or web view. An unknown param value is
  ignored, not stored: a newer shell must degrade an older app to today's behavior, never to a
  broken mode.

The Swift client re-sends the param on every page switch it drives, so persistence there only has
to cover navigation the app initiates itself. An evicted web view relaunches through the mint path
and re-learns the mode the same way it first did.

### What the apps do with it

The SDK surfaces the resolved mode the way the theme bridges surface the theme: a root attribute
(`data-hosty-launch` on `<html>`) set by a bridge component, plus a React hook for logic that needs
it. The resolution helper lives in `@hosty-sdk/app` — the theme bridge is already copied per app
three times; the launch bridge should not become a fourth copy.

**The rule for what hides: an app drops only what the shell already renders — its own name and the
navigation between its manifest pages. Everything else stays.** Contextual controls and information
that no shell renders are not duplication, whichever bar they happen to sit in: a project picker in
project-manager, a refresh action, an identity badge. If removing an element would take away
something the operator can no longer reach through the shell, it was never chrome in this plan's
sense.

Each first-party app then drops its duplicated chrome when the mode is not `standalone`:

- **telemetry-ui** — `AppShell` hides its `<header>`: the "Telemetry" wordmark and the
  Metrics / Structured logs / Traces tab bar, which mirror the manifest navigation the shells
  already render.
- **demo-app** — `DemoNavigation` (Overview / People / Roles / Settings) disappears; the page
  header keeps the *page* title and description, which no shell renders.
- **marketplace** — the header's `<h1>Marketplace</h1>` and description go; Refresh and the
  identity badge stay, per the rule above — the badge is information (the app-origin session and
  who holds it), not navigation.

The signal is a platform convention, not a first-party trick: external apps (project-manager,
media-server, torrent-engine) duplicate their navigation the same way and adopt the same rule —
project-manager, for example, keeps its project selection while dropping its page tabs. The
`hosty-app-skill` documents `hosty_launch`, the SDK helper, and the hide-only-duplication rule
next to the theme-param contract it already describes.

Hiding is a client-side decision (the pages are prerendered), so first paint matters. In the
browser Shell the iframe is faded in on `load`, which masks it. The Swift web view surfaces first
paint directly, so the bridge must set the attribute before hydration paints the header — the same
inline-script-in-head pattern dark-mode bridges use — or accept a one-frame flash. The
implementation should start from the attribute-plus-CSS shape, which leaves the no-flash hardening
a pure addition.

### Compatibility matrix

Every pairing degrades to a state that already exists today:

- Older browser Shell, newer app: no param, but the frame heuristic still answers `embedded` —
  chrome hidden, correct.
- Older Swift Shell, newer app: no param, top frame — `standalone`, chrome shown. Today's behavior;
  fixed by updating the client, not broken by updating the app.
- Newer shell, older app: the param is ignored entirely. Today's behavior.
- Standalone open of an app that is also open embedded elsewhere: separate tab, separate
  `sessionStorage`, full chrome. The param is cleaned from the URL on arrival, so a copied link
  cannot carry the mode into a foreign context.

One known leak is accepted, because the theme already accepts it: a tab the app itself opens with
`window.open`/`target="_blank"` duplicates `sessionStorage`, so it would inherit a hidden-chrome
mode into a plain browser tab. First-party apps open no such internal tabs today; if one appears,
`native`/`embedded` recovery still works there (both resolve to a working path), and the record of
this trade-off is this paragraph.

## Deliberately not doing

- **A postMessage-only signal.** It cannot reach a `WKWebView` (no parent), and it arrives after
  first paint, so it could not be the primary mechanism even where it works.
- **A Core-reported launch channel** — the launch-code request carrying the channel, Core binding
  it to the code, the app learning it at exchange and keeping it on its session. It is the most
  authoritative shape and the SDK comment has anticipated it since `detectLaunchMode` was written;
  but it costs a Core API change, a launch-code contract change, and both SDKs, to harden a signal
  that is purely cosmetic. The mode vocabulary here (`embedded` / `native` / `standalone`) is
  chosen so a later Core channel can supersede the param without renaming anything — resolution
  precedence would simply gain a stronger source.
- **A manifest field.** The mode is a property of a launch, not of an app: the same app can be open
  embedded and standalone at the same time.
- **User-Agent sniffing** for the native client. Per-client sniffing is the thing the explicit
  param exists to avoid.
- **Removing app navigation outright.** Standalone opens on the direct origin remain first-class
  ([Direct Origin Runtime App UI](../direct-origin-runtime-app-ui.md)) and need it.

## Decisions

- **Mode resolution lives in the SDK.** Confirmed as the load-bearing deliverable: apps consume a
  helper, never re-implement the precedence.
- **Only shell-duplicated chrome hides; contextual information and controls stay.** The rule above
  settles the per-app scope, including the marketplace identity badge (kept — it is information,
  not navigation) and project-manager's project selection (kept, by the same rule).
- **The convention is documented for external apps.** `skills/hosty-app-skill` describes
  `hosty_launch`, the SDK helper, and the rule once this ships, alongside the theme-param contract
  it already covers.

## Phases

### Phase 1 — SDK

- [ ] `AppLaunchMode` gains `native`; `resolveLaunchMode` with param → storage → heuristic
      precedence, persistence, URL cleanup, and rejection of unknown values.
- [ ] The recovery matrix is pinned: `native` redirects exactly as `standalone` does; `embedded`
      still posts. This is the invariant that keeps the Swift interception working.
- [ ] React slice: the bridge setting `data-hosty-launch`, and a hook exposing the mode.

### Phase 2 — Shells

- [ ] Browser Shell appends `hosty_launch=embedded` alongside the theme params.
- [ ] Swift Shell appends `hosty_launch=native` in `open(page:)` (both branches), and deliberately
      not in `openInBrowser()`.

### Phase 3 — Apps

- [ ] telemetry-ui, demo-app, and marketplace hide their duplicated chrome off the signal, per the
      per-app list and the hide-only-duplication rule above.
- [ ] `skills/hosty-app-skill` documents the convention for external apps.

## Deliverables

- [ ] SDK: mode, resolver, recovery pinning, bridge, hook, tests.
- [ ] Browser Shell and Swift Shell send the param from their workspaces only.
- [ ] All three first-party apps drop duplicated chrome when not standalone; contextual controls
      and information (Refresh, the identity badge) remain.
- [ ] The `hosty-app-skill` reference covers `hosty_launch`, the SDK helper, and the rule.
- [ ] Versions: minor bumps for `apps/shell`, `apps/marketplace`, `apps/demo-app`,
      `apps/telemetry` (manifest + `package.json` kept in step), `@hosty-sdk/app`, and
      `apps/shell-swift` (`MARKETING_VERSION`). No platform bump — Core and CLI are untouched.
- [ ] `feature.md` for this folder; the swift-shell and core-app-shell feature docs updated where
      they describe the double header and the embedded contract; this `plan.md` deleted.

## Verification

- `npm run ci`, the shell and app builds, SDK tests, `node scripts/docs-index.mjs --check`.
- Unit: resolver precedence (param beats storage beats heuristic), persistence and URL cleanup,
  unknown values ignored; `decideRecoveryAction` for `native` returns the redirect, and the
  embedded/standalone rows are unchanged.
- Live, browser Shell: an embedded app shows no wordmark/top nav and the sidebar pages still
  navigate it; the same app on its direct origin shows full chrome; identity expiry inside the
  iframe still recovers via the parent.
- Live, Swift Shell: a workspace shows exactly one header (the native bar), the pages menu
  navigates, expiry recovery still re-mints through the interception, *Open in Browser* lands on
  full chrome, and an app evicted from the web-view cache re-opens with chrome still hidden.

## Links

- [Shell Navigation](../shell-navigation/feature.md) — the browser Shell sidebar that renders app
  pages.
- [Swift Shell](../swift-shell/feature.md) — the native workspace chrome and the recovery
  interception this plan must not break.
- [Core App Shell](../core-app-shell/feature.md) — the embedded-apps contract (iframe, launch
  code, theme post).
- [Direct Origin Runtime App UI](../direct-origin-runtime-app-ui.md) — why standalone keeps full
  chrome.

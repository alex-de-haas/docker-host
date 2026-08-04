# Embedded App Chrome

Created: 2026-08-04
Updated: 2026-08-04

An app opened inside a shell drops the chrome that shell already renders — its own name, and the
navigation between its manifest pages. Opened standalone on its own origin it keeps both, because
nothing else is drawing them.

Before this, the manifest `ui.navigation` pages were rendered three times over: by the browser
Shell's sidebar, by the native client's pages menu, and by the app's own header. The native client
had gone as far as keeping its title bar inline to soften the collision, which its own source
records: "the app's own interface starts immediately below this bar and has its own header".

## What hides, and what does not

**Only what a shell already renders.** That is the app's name and the navigation between its
manifest pages — nothing else. Contextual controls and information a shell does not render are not
duplication, whichever bar they happen to sit in: Marketplace keeps its identity badge and its
Refresh action, an app with a project picker keeps the picker, and a page's own title and
description stay because no shell has ever shown them.

The test is what the operator loses. If hiding an element takes away something they cannot reach
through the shell instead, it was never chrome in this sense.

## The signal

A launch mode, declared by the shell on the URL it launches:

| Mode | Where | Chrome | Identity recovery |
|---|---|---|---|
| `embedded` | the browser Shell's workspace iframe | hidden | `hosty:auth-required` to the parent |
| `native` | a native shell's web view (`apps/shell-swift`) | hidden | redirect to Core's `/open` |
| `standalone` | a plain browser tab on the app's origin | shown | redirect to Core's `/open` |

**The three modes exist because two different decisions read them, and they do not split the same
way.** Chrome is hidden for anything that is not `standalone`; the parent post belongs to
`embedded` alone. In a native web view the app *is* the top frame, so there is no parent to post
to — calling it `embedded` to get its chrome hidden would send recovery into a window with no
shell listening. `native` is that mode's own name, and its recovery is the standalone redirect,
which is exactly the navigation the native client watches for to re-mint a launch code.

`hosty_launch` travels as one query parameter on the launch `redirectUri`, beside `hosty_theme`
and by the same rules — Core appends its one-time `code` to whatever the shell asked for, and the
redirect allowlist judges the origin, not the query.

- The **browser Shell** appends `hosty_launch=embedded` to the workspace URL only. The standalone
  href behind *open in a new tab* deliberately never carries it: that link exists to leave the
  Shell. This is also why a reissued launch code moves the frame's URL and leaves the standalone
  href alone — the frame's URL declares a mode, and a new tab opened on it would be an app hiding
  navigation nothing else renders.
- The **native client** appends `hosty_launch=native` in both branches of opening a page: the
  fresh launch, and the plain navigation of a web view that is already loaded. *Open in Browser*
  does not, for the same reason the Shell's standalone href does not.

The frame heuristic would reach `embedded` on its own inside an iframe. The Shell declares it
anyway, so there is one code path with the native client — where the heuristic cannot work at all
— and so an older app that ignores the parameter still behaves exactly as it did.

## Resolution

`resolveLaunchMode` in `@hosty-sdk/app` takes the declared parameter, the value persisted for this
tab, and the structural heuristic, in that order. The winning parameter is persisted under
`hosty.launch.mode` and cleaned out of the URL, which is the theme bridge's contract exactly: app
-internal navigation carries no parameter and must not lose the mode, and a copied link must not
carry a shell's presentation into a plain browser tab.

**An unrecognized value is ignored and not stored.** A newer shell has to degrade an older app to
what it did before, never to a mode it cannot render. Every pairing therefore lands on behavior
that already existed: an older Shell leaves the frame heuristic to answer `embedded`; an older
native client sends nothing, and its web view reads `standalone` and keeps full chrome, which is
what it did before this existed; a newer shell against an older app is a parameter nobody reads.

One leak is accepted, on the same terms the theme already accepts it: a tab an app opens itself
duplicates `sessionStorage` and would inherit a hidden-chrome mode into a plain tab. No
first-party app opens one, and recovery still works there. A tab opened from the Shell is not
affected — it is a different origin's storage.

**Recovery keeps reading the structural heuristic, not the declared mode.** Whether a parent frame
exists is a fact about the document that a persisted value must not be able to override; a stale
`embedded` would otherwise post into a window with no shell listening. The declared mode drives
chrome, and `decideRecoveryAction` is pinned so that a caller passing `native` still gets the
redirect.

## How an app hides it

Chrome is hidden with CSS keyed on a root attribute, never by conditional rendering. App pages are
prerendered, so a render that depends on a client-only value costs a frame and risks a hydration
mismatch.

- `launchModeBootstrapScript` runs inline before hydration and writes
  `<html data-hosty-launch="…">` from the same precedence the resolver implements. Without it the
  app's header is painted for a frame and then hidden — invisible in the browser Shell, which
  fades its iframe in on `load`, and plainly visible in a native web view, which shows first paint
  directly.
- `HostLaunchBridge` applies the attribute after mount, persists a declared mode, and cleans the
  parameter out of the URL.
- `SHELL_DUPLICATED_CHROME_CLASS` marks the elements, and each app's `globals.css` hides them for
  `embedded` and `native`. The selector names those two modes rather than negating `standalone`,
  because an **absent** attribute — an older shell, a blocked script — has to leave chrome visible.
- `useLaunchMode` exposes the mode for logic CSS cannot express. It returns `null` until the first
  effect, which is the honest shape for a value that does not exist during a prerender.

The first-party apps hide: Telemetry's wordmark and its Metrics / Structured logs / Traces tab bar;
the demo app's Overview / People / Roles / Settings navigation; Marketplace's title and
description.

## Links

- [Shell Navigation](../shell-navigation/feature.md) — the sidebar that renders app pages.
- [Swift Shell](../swift-shell/feature.md) — the native workspace chrome and the recovery
  interception the `native` mode must not disturb.
- [Core App Shell](../core-app-shell/feature.md) — the embedded-apps contract this rides on.
- [Direct Origin Runtime App UI](../direct-origin-runtime-app-ui.md) — why standalone keeps
  everything.

## Testing Expectations

- Resolution precedence is pinned in all three directions, along with the two refusals: an
  unrecognized value is neither applied nor persisted, and an empty one falls through.
- The bootstrap script is executed in the tests rather than read, against the same cases as the
  resolver. It runs before hydration, where a throw would leave the page unrecoverable.
- `decideRecoveryAction` is pinned for `native`: the redirect, never the parent post. The native
  client's recovery is built on that navigation, so this row failing would break re-authorization
  in the web view and nowhere else.
- The Shell's parameter builder is covered for idempotence — a workspace URL is re-derived on a
  reissue — and for preserving the app path and the theme parameters it rides beside.
- The native client's URL helper is covered for replacing rather than duplicating an existing
  value, preserving other query items and the fragment, and leaving anything that is not an
  absolute URL alone. That last one is not a formality: `URLComponents` reads `not a url` as a
  relative path and percent-encodes it rather than refusing it, so a helper that trusted the parse
  would rewrite an address Core never advertised and misname the failure the operator sees.
- Visual verification covers both shells: an embedded app showing one header rather than two while
  the shell's own navigation still moves it between pages, the same app standalone showing
  everything, and *open in a new tab* / *Open in Browser* landing on full chrome.

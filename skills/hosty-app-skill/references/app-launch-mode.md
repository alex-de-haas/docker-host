# App Launch Mode

A Hosty app's UI is opened in three different places, and one of them wants less of the app than
the others. This is the contract that tells the app which one it is in.

## The duplication this exists to remove

Both shells render an app's identity and its `ui.navigation` pages themselves: the browser Shell in
its sidebar, the native client in its navigation bar and pages menu. An app that also draws its own
name and page tabs shows each of them twice, in two different type sizes, and spends a band of its
own UI doing it.

## The parameter

A shell appends `hosty_launch` to the URL it launches the app with, beside the `code` Core adds:

| Value | Where | What the app should do |
|---|---|---|
| `embedded` | the browser Shell's workspace iframe | hide its own name and page navigation |
| `native` | a native client's web view | hide its own name and page navigation |
| `standalone` | a plain browser tab on the app's origin | render everything |

`native` is not a variant of `embedded`, and the difference is load-bearing. In a web view the app
is the **top** frame, so `window.self !== window.top` reports a plain browser tab — the structural
check cannot see a native shell at all, which is the reason this parameter exists. It is also why
the two values stay apart: identity recovery in `embedded` posts `hosty:auth-required` to a parent
frame, and a web view has no parent to receive it. A `native` app recovers the standalone way, by
redirecting to Core's `/api/apps/{id}/open`, which the native client watches for.

## Resolving it

Precedence, in order:

1. the `hosty_launch` parameter on the current URL;
2. the value persisted in `sessionStorage` under `hosty.launch.mode`;
3. the frame heuristic — framed means `embedded`, otherwise `standalone`.

The winning parameter is persisted and then cleaned out of the URL. Both halves matter: app-internal
navigation carries no parameter and must not lose the mode, and a copied link must not carry a
shell's presentation into a plain browser tab.

**An unrecognized value is ignored and never stored.** An app that meets a mode it does not know has
to behave as it did before the value existed. The same applies in reverse: an app that ignores
`hosty_launch` entirely keeps working exactly as it does today, so adopting this is optional and
can be done at any time.

## Implementing it in a TypeScript app

`@hosty-sdk/app` owns the resolution — do not re-implement the precedence:

| Export | From | Use |
|---|---|---|
| `launchModeBootstrapScript` | `@hosty-sdk/app` | inline `<script>` in `<head>`; writes `data-hosty-launch` on `<html>` before first paint |
| `HostLaunchBridge` | `@hosty-sdk/app/react` | mount once in the root layout; applies the attribute, persists, cleans the URL |
| `SHELL_DUPLICATED_CHROME_CLASS` | `@hosty-sdk/app` | the class to put on elements a shell duplicates |
| `LAUNCH_MODE_ATTRIBUTE` | `@hosty-sdk/app` | the root attribute name, for writing the CSS rule |
| `useLaunchMode` | `@hosty-sdk/app/react` | the mode for logic CSS cannot express; `null` until the first effect |
| `hidesAppChrome` | `@hosty-sdk/app` | mode → boolean, if you need the predicate directly |

**Hide with CSS, not with conditional rendering.** App pages are prerendered, so a render that
depends on a client-only value costs a frame and risks a hydration mismatch. The rule belongs in the
app's global stylesheet:

```css
html[data-hosty-launch="embedded"] .hosty-shell-chrome,
html[data-hosty-launch="native"] .hosty-shell-chrome {
  display: none;
}
```

Name the two modes rather than negating `standalone`. An **absent** attribute — an older shell, a
blocked script — has to leave the app's chrome visible.

Mount the bootstrap script as well as the bridge. The bridge runs after first paint, so without the
script the app's header is painted and then removed: invisible in the browser Shell, which fades its
iframe in on load, and plainly visible in a native web view, which shows first paint directly.

Setting `suppressHydrationWarning` on `<html>` goes with the script — the attribute it writes is one
the server never rendered.

## Implementing it in a .NET app

There is no launch-mode helper in `packages/app-sdk-dotnet` today. A .NET app that renders its own
HTML has to read the parameter, apply the same precedence, and write the attribute itself.

## What to hide, and what to keep

**Hide only what a shell already renders: the app's own name, and the navigation between its
manifest `ui.navigation` pages.**

Everything else stays. Contextual controls and information a shell does not render are not
duplication, wherever they sit — including inside the same header bar:

- project-manager keeps its project selection and drops its page tabs;
- Marketplace keeps its identity badge and its Refresh action, and drops its title;
- a page's own title and description stay, because no shell has ever shown them.

The test is what the operator loses. If hiding an element takes away something they cannot reach
through the shell instead, it was not chrome in this sense and must stay.

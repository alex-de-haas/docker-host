---
created: 2026-08-04
updated: 2026-10-11
summary: Navigation visibility uses explicit SDK composition policy while legacy launch modes retain transport and old-client compatibility.
components: [packages/app-sdk, apps/shell, apps/shell-swift]
---

# Embedded App Chrome

Navigation visibility is independent of embedded/native transport. The current browser Shell hides
its app's page navigation because its sidebar renders those pages. A desktop host can keep the
same navigation visible inside an app window and use shared tools outside it. Standalone apps show
navigation by default. The [SDK UI composition contract](../sdk-ui-composition/feature.md) owns
policy, navigation rendering, host negotiation and retained tool instances.

## Visibility And Contextual Controls

The configurable `navigation` policy covers app branding and page navigation, not contextual
controls. Project selectors, document actions, identity badges and conversation controls remain
available when page navigation is hidden. Hiding navigation does not disable app routing or history.

`HostyOverlay` provides a standard manifest menu, or `navigation={{ renderer: "custom" }}` for an
app-owned top bar/sidebar. `HostyNavigationBoundary` hides custom navigation from layout, tab order
and the accessibility tree without discarding component state. It returns hidden focus to the app
content landmark. `HostyNavigation` and `useHostyChrome` consume the same effective policy.

`chromeBootstrapScript(defaults)` runs before hydration with the overlay's defaults. It captures
current-document URL hints and writes `data-hosty-navigation`. The root then removes the hints
without losing router history state. The precedence is verified host overrides, valid document
hints, app defaults, current-document legacy launch fallback, then standalone show. Invalid or
duplicated hints fall through. Presentation hints never enter cookies or session storage.

First-party apps use composition boundaries and `data-hosty-navigation` CSS. They no longer combine
that policy with legacy `data-hosty-launch` hiding. Plans, Marketplace and Workspaces use the
standard manifest menu; Shell, Demo, Harness and Telemetry retain custom page navigation.

## Legacy Launch Modes And Authentication

`AppLaunchMode`, `resolveLaunchMode`, `HostLaunchBridge`, `launchModeBootstrapScript`,
`hidesAppChrome` and `SHELL_DUPLICATED_CHROME_CLASS` remain exported for compatible older consumers.
Their use for new navigation visibility is deprecated.

| Mode | Transport context | Legacy chrome behavior |
| --- | --- | --- |
| `embedded` | Browser iframe, app-owned silent/popup authentication | Hidden |
| `native` | Native web view, Core navigation intercepted by the native client | Hidden |
| `standalone` | Plain browser document, Core sign-in navigation | Shown |

The legacy resolver still checks explicit `hosty_launch`, then tab-local `hosty.launch.mode`, then
its structural heuristic. The legacy bridge cleans a declared parameter and publishes
`data-hosty-launch`. Authentication uses the actual frame environment; a stale stored mode cannot
send recovery into a nonexistent parent. No app credential passes through Shell.

The composition resolver reads only an explicit legacy hint captured for the current document,
below new URL/root settings. It never inherits hidden navigation from copied session storage or
from the mere presence of a parent. A verified new host's policy takes precedence. Older child
apps that hide navigation structurally cannot support a host's live show override until migrated.

## Host Launches

The browser Shell sends explicit navigation-hide and child-launcher-hide with tools enabled,
alongside `hosty_launch=embedded` for legacy apps. Its standalone links omit embedded composition
hints. Host policy updates change the current document without reloading it.

The native client sends `hosty_launch=native` plus `hosty_navigation=hide`, `hosty_tools=disabled`
and `hosty_tool_launcher=hide`, on fresh launches and SDK-managed page navigation. Its web view
provides no browser panel-host capability; separate opening remains explicit recovery. Open in
Browser starts a standalone document. The URL helper replaces duplicate hints while preserving
application query items and fragments; invalid/non-absolute input stays unchanged.

## Links

- [SDK UI composition](../sdk-ui-composition/feature.md) — policy and navigation API.
- [Shell navigation](../shell-navigation/feature.md) — manifest pages in Shell's sidebar.
- [Swift Shell](../swift-shell/feature.md) — native launch and recovery interception.
- [Continuous app access](../continuous-app-access/feature.md) — renewal and offline boundaries.

## Testing Expectations

- Keep legacy resolver/bootstrap and native recovery compatibility tests.
- Execute the composition bootstrap before hydration; cover invalid/duplicate hints, root defaults,
  precedence, URL cleanup preserving history state and copied legacy storage.
- Verify live show/hide without iframe remount or lost app state, focus return, custom boundaries
  and contextual actions that remain available.
- Verify current Shell hides app navigation, standalone shows it, and the two-window desktop
  fixture keeps it inside app windows while sharing tools.
- Cover native hint idempotence and parameter/fragment preservation, with native unit tests and
  browser checks for separate-opening standalone defaults. No WKWebView runtime check is implied
  by the browser composition fixture.

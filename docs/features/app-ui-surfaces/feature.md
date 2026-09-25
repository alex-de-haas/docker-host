# App UI Surfaces

Created: 2026-08-19
Updated: 2026-09-24

An app declares **where** its pages belong, and Shell places them. Before this, an app had exactly
one placement — the sidebar — so operator configuration, domain work, and always-at-hand tools all
competed for the same list.

## The Three Placements

Chosen by **who the page is for and what it changes**, not by whether it looks like settings:

| Manifest field | How many | Audience | Where it lands |
| --- | --- | --- | --- |
| `ui.navigation` | any | users | the shell's sidebar |
| `ui.settings` | at most one | administrators | one app-named entry under Settings |
| `ui.panels` | any | users | icons on Shell's right panel |

Litmus tests: *would a `host.user` ever legitimately open it?* → sidebar or panel. *Does it change
behaviour rather than produce and consume content?* → settings.

Both new fields are additive under `app.0.1` with no `schemaVersion` bump — that number tracks the
contract format, not additions to it. Core resolves each surface to a URL exactly as it resolves a
navigation entry, so Shell discovers placements without reading manifests.

**`ui.settings` is singular and `ui.panels` is a list, deliberately.** One app has one place its
operator configuration lives; the same app may ship several distinct tools, and the right icon rail is
where they belong. The fields stay per-kind rather than collapsing into one `ui.surface`, leaving
room beside them for kinds not built yet.

**Endpoint, path and label validation is stricter for system apps.** For `role: system` the endpoint must exist and be
explicit, paths absolute, every panel labelled and labels unique within the app — its pages render as
administrator Shell surfaces, so it must not lean on the permissive fallbacks ordinary `app.0.1`
manifests keep for compatibility. An ordinary app keeps those fallbacks, so Shell supplies a label
for a panel that declared none.

New installs and updates require a non-empty `ui.panels[].icon` Lucide name in both
ordinary and system apps. Settings surfaces do not require one. Core carries the icon
through its persisted surface contract and API projection. Existing installed manifests
remain readable/startable without icons; Shell renders a visible fallback for missing,
unknown or loading icons, with the full app and panel label in the tooltip.

## Settings Navigation

Settings is expandable in the sidebar and opens a flyout in compact mode. It contains the built-in
Users, Access tokens, Core, Ingress and Shared mounts sections, followed by one entry per app declaring
`ui.settings`, labelled with the app name. Internal settings navigation belongs to the app. Ordinary users only see their own Access tokens section. Stopped apps keep
their settings entries and display the existing start/readiness UI when selected.

The former horizontal tab strip is removed. Selection stays in `/settings?tab=...`, so bookmarks,
reload and back/forward retain the page. App entries use the app id as their key.
Old page-specific bookmarks resolve to the same app entry. Removed or unknown apps fall back to
the host's normal default.

An app settings iframe fills the workspace surface beside the sidebar and beneath the header, with no
Shell padding inside that surface or height subtraction for tabs. The app owns content padding; its modal overlay covers
the full iframe without covering Shell navigation or an independently docked panel. Built-in host
settings remain native Shell pages and retain their own layout.

## Placement Is Not Access Control

A declaration says where a page is shown, and nothing else. The page stays reachable standalone
(`hosty apps open`), and being embedded grants it nothing — the app keeps enforcing its own
authorization on every request.

The direct-link question this raises has a better answer than expected for system apps: Core's
`RequireAccessibleUserAsync` runs on **every** identity flow including revalidation, so it refuses a
non-administrator a session for a system app at all, and a downgraded administrator loses access at
the next revalidation rather than the next login. The app does not have to remember to check. An
ordinary app gets no such rule, and its own authorization decides — which is the app's
responsibility, stated as such in the skill reference.

## Embedded Surfaces Authenticate Like Every Other Page

Shell mints a launch code and the frame lands with a real Hosty app session, exactly as a sidebar
page does. This is the part that is easy to get subtly wrong: embedding Core's resolved endpoint URL
directly produces a frame with **no** session, and an app authenticating the ordinary way then loads
unauthenticated and cannot recover, because `hosty:auth-required` recovery is scoped to the active
workspace.

So the mechanism is shared rather than copied, at two levels:

- **`EmbeddedAppFrame`** — one embedder for every context Shell embeds an app in: the workspace, a
  Settings tab, a panel tab. It owns the theme post, auth recovery, the delegated-token handshake,
  and the mixed-content refusal.
- **`useAppSurfaceSrc`** — one launch-code exchange for every placed surface, including the
  stale-answer rule: an answer belongs to the surface it was minted for, so a slow response for a tab
  the operator has left cannot land under the label of the one they are looking at.

A copy per context is how the gap this replaced happened: only the workspace answered the
delegated-token handshake, so a settings page embedded elsewhere never loaded at all.

**Recovery is the placed surface's own.** When a frame reports `hosty:auth-required`, the workspace's
recovery re-mints against the workspace's URL and does nothing unless the centre pane belongs to that
same app — so a panel docked beside a Shell page, or beside a *different* app, could never recover
and would sit unauthenticated until it was remounted. A placed surface re-mints its own code instead,
behind the same per-app rate limiter, since a frame that never accepts the new code must not drive an
unbounded reissue storm. The previous answer stays on screen until the new one lands, so recovery
does not blank the tool being used.

The gateway used to be the one app that authenticated differently — a delegated token where every
other app used a session. It now uses a session for its settings page and keeps the delegated token
only for the Shell assistant panel, which is a genuinely different client rather than an exception.

## Shell's Chrome

Two rails and a strip, so content stays visible beside its tools rather than under them.

The navigation and 48 px top strip share the Shell's background without an enclosing border.
The left navigation toggle and page title sit together above the workspace, aligned to its
left edge. The brand occupies the navigation width and shows only its mark in compact mode.
Notifications, theme selection and the right panel toggle stay at the right edge.
The workspace and optional right panel are separate rounded, bordered surfaces, with 12 px
outer spacing beside navigation, at the right edge, and along the bottom. The right tool
surface contains the selected body on its left and a 48 px icon rail at its right edge. Both
share the rounded border and frame background, including in dark mode. The selected
icon has a muted fill. Shell adds no title header; the app owns the full body height,
while tooltips and accessible labels identify each panel. Compact left
navigation retains its own icon rail. Embedded content is clipped at rounded corners.

**The right panel** holds `ui.panels` tools, in declared order. With no declaring apps,
the whole surface is absent. Otherwise its icon rail remains visible when the body is
collapsed. Clicking any icon while collapsed opens its panel; clicking the selected
icon while expanded collapses the body; clicking another selects and opens that tool.
The top-strip toggle retains the selection, and Assistant shortcuts, deep links and
Ask actions select/open Assistant as before. Body visibility uses the existing cookie.

The rail scrolls vertically. Tooltips name the app and panel, buttons expose their
open/hidden state, and app-level attention remains visible beside the icon. Up/Down
and Home/End move focus without activating a tool; Enter/Space activates it. Hidden
content is inert and cannot receive keyboard focus. A collapsed rail does not mint
launch codes or mount an unopened iframe. Once opened, the selected iframe stays
mounted across collapse/expand, retaining unsent input; switching still uses only one
selected iframe. Runtime disappearance and authentication recovery still apply while hidden.

A [resizable gap](../shell-panel-resize/feature.md) separates the surfaces when the
body is expanded, with a remembered body width, keyboard controls and double-click reset.

Tabs are keyed rather than indexed, because stopping or removing an app reorders the strip and an
index would then point at somebody else's tool. A stopped app **keeps** its tab, dimmed and saying
why, with a start action offered only to a user who can actually start apps — panels are deliberately
not administrator-only, but Core's start route is, so offering everyone the button would promise
something guaranteed to fail: a surface that vanished with its app would read as uninstalled, and the
operator would go looking for the app rather than starting it. If the chosen tab's app disappears,
the strip falls back to the first rather than rendering blank.

Whether a surface can be embedded is decided by the app's runtime state, not by whether Core handed
Shell a URL. An endpoint keeps its reserved port while its app is down, so Core projects a
well-formed URL for a stopped app that nothing answers; embedding it renders the browser's own
connection-error page inside the tab, and the app then looks broken rather than stopped. The strip
itself carries the state as dimming and a tooltip only: a glyph beside the label was tried and read
as decoration rather than as "stopped", since no shape in Shell's vocabulary means it. Dimming
reaches nobody using a screen reader, so an unavailable tab says so in text for that reader alone.

Whether a tab leads anywhere and *why it does not* are kept as two questions. A tab dims on the URL
alone — the rule above has already folded the runtime state into it — while the runtime state picks
only the wording, so a tab can never dim for one reason and explain itself with another. The two
agree for a stopped app; where they differ, an app running with no address resolved yet is told
exactly that, and is not offered a Start it does not need.

A third state sits between the two: while Core reports `starting` or `stopping`, a verb is already in
flight, so the surface reports progress and offers nothing. "Not running" admits that state too, and
reading it as "stopped" told the operator to start an app that was already starting, behind a button
whose click would have raced it.

Readiness is the softer question on top ([App Readiness](../app-readiness/feature.md)): a surface
whose service is alive has a URL, and *opens* when that service's reading is `healthy` (or nothing
probes it, or Core has no reading for it — an older Core must not hold a tab). While the reading is
`starting` the tab shows progress; when it is
`degraded` the tab says readiness is not confirmed and offers **Open anyway**, since an expired budget
proves nothing about the app. Readiness gates opening only: a frame already on screen survives
`healthy → degraded` — a transient probe failure must not destroy what the operator has typed — and is
unmounted only when its own service stops running or a lifecycle verb takes the app down. Decided per
service, so a dead sibling leaves the living service's tab open while the app reads `unknown`. No
launch code is minted for a tab that has not opened.

**The top strip** owns what belongs to neither rail: a toggle for each rail, and the name
of whatever fills the content area — an app's page, or the Shell page — plus the notification bell
and the theme control, both relocated here from the sidebar footer. The right-rail toggle is absent
while the rail does not exist. Apps contribute nothing to the strip; an app that could write there
would be writing outside its frame.

Navigation collapses and expands through its top-strip toggle, retaining the persisted
desktop preference and mobile drawer state. There is no button on the sidebar's edge.
The right panel keeps its top-strip toggle and a resize gap, without an edge button or
grip icon.

## Current Placements

- **The gateway** declares an Assistant panel with the `bot` icon, plus `ui.settings` and no sidebar entry: its whole page is operator
  configuration. It still declares `ui.entrypoint`, because a system app's `ui` block requires one —
  but an entrypoint no longer buys a place in the sidebar (below).
- **Telemetry** keeps Metrics/Traces/Logs in the sidebar — routine use, possibly by non-admins.
- **Demo App** declares a `Session` panel with the `contact-round` icon, which is the platform's worked example of the contract:
  narrow, chrome-free, and showing the session itself, since a panel reporting no session is exactly
  what a broken embedding looks like.
- Core-injected manifest `settings` stay native in Shell — platform-owned state, uniform by
  construction.

### A Sidebar Row Comes From `ui.navigation`, And Nothing Else

An app with no `ui.navigation` has no pages in Shell — no sidebar row, and no entry on the Apps page.
Shell used to derive a "Home" row from `ui.entrypoint` when navigation was absent, and placed
surfaces made the cost of that visible: the gateway declares only `ui.settings`, yet the entrypoint
it is obliged to keep put it back in the sidebar on a row that opened the very page its Settings tab
already hosts.

Declaring UI and having a browsable page are different claims, and only navigation makes the second.
The derived row also had Shell inventing the label "Home" for someone else's app, which is the
opposite of an app saying where its pages belong.

The consequence for app authors is worth stating plainly: **an app that declared only an entrypoint
and relied on the derived row now has to declare navigation** — which the manifest reference has
always asked for. Nothing becomes unreachable by it: `hosty apps open` and an explicit deep link both
still resolve a path against the entrypoint, because asking for a page by name is not the same as
being offered one.

An embedded settings page owns the **whole content column**, including its background, spacing and
scrolling. Shell uses the same full-height container as a workspace app.

Shell never learns any app's settings schema. That was the objection that moved the gateway's page
out of Shell in the first place, and hosting an iframe honours it.

Version outcome for settings navigation: Shell **0.77.0 → 0.78.0**; Core/CLI is unchanged.
Gateway's internal settings tabs are included in its **0.30.0** provider-connections release.

Shell sends the initial theme only after the embedded app document loads. The initial blank frame
inherits Shell's origin and receives no messages intended for the app's different origin.

The icon rail ships in Shell **0.82.0**, with the icon authoring/projection contract in
Core/CLI **0.107.0**. Gateway **0.32.2** declares `bot`; Demo App **0.11.2** declares
`contact-round`. The manifest format remains `app.0.1`.

## Testing Expectations

- Shell: `npm test --workspace apps/shell` includes both pure rules and the jsdom rail
  tests (40 tools, missing/unknown icons, readiness, hidden auth recovery and iframe identity).
  Run `npm run lint --workspace apps/shell` and a production build as well.
- Core: run `AppManifestServiceTests`, `AppUiSurfaceContractTests`, `AppRegistryStoreTests`
  and the install/update lifecycle tests, including `PanelIconAuthoringIsEnforcedAtInstallAndUpdateBoundaries`.

- New install/update validation requires a non-blank panel icon in both app roles;
  settings remain exempt. Legacy startup/read paths accept missing icon metadata.
- Verify icons survive manifest normalization, storage and summary projection; several
  panels from one app keep distinct icons, labels and keys. Missing/unknown icons render
  a visible fallback with a tooltip.
- Verify persistent collapsed rail, icon activation, keyboard focus navigation, top toggle,
  selection fallback and no-panel state. Collapsing preserves an unsent draft and the same
  iframe; fresh collapsed loads must not open a frame. Hidden content is inert.

- Each declaring app contributes exactly one app-named Settings entry in compact and expanded
  navigation. Old page-specific links resolve to that entry, including for stopped apps.
- App settings fill the workspace; internal tabs and modal overlays belong to the app. Host
  sections retain administrator gating and the viewer's own Access tokens section.
- Check rounded workspace/panel surfaces in light and dark themes, expanded and compact
  navigation, and narrow windows. The top strip stays on the shared background, and outer
  spacing must not introduce viewport scrolling or clip navigation flyouts.
- **Tab derivation as a pair**: a declaring app and a non-declaring one in the same fleet, since
  either assertion alone is satisfied by a rule that always answers the same way. Independence of the
  two surfaces is asserted the same way.
- **Several panels from one app** keep their order, their labels, and distinct keys.
- **The label fallback** — app name when a panel declares none, numbered only when the app ships
  more than one, since "Demo App 1" is worse than "Demo App" when there is nothing to tell apart.
- **A stopped app keeps its tab**, carrying the reason rather than vanishing.
- **A stopped app's tab drops the URL Core still projects for it**, paired with a running app that
  keeps its URL — a gate that always answered null would satisfy either assertion alone.
- **The active tab survives what it can and falls back rather than pointing at nothing.**
- **Manifest validation both ways** (Core): a surface inherits the entrypoint endpoint or keeps its
  own, paths normalise like every other UI path, declaring one surface says nothing about the other.
- **Verified live** on a host running these versions (2026-08-19), because the property that matters
  most here is not unit-testable: a placed surface must land with a real Hosty app session rather
  than as an anonymous visitor to the app's origin.
  - The panel's `Session` tab reports `status: active`, the operator's own user and `host.admin`,
    and — the part that proves the mechanism — **`tokenSource: cookie`**. An anonymous frame or one
    leaning on a delegated token would say something else.
  - The Settings tab renders the gateway's page *with its data*: the MCP provider list comes from an
    API that answers 401 without a credential, so a page that merely painted would not show it.
  - The strip renders on every page, its toggle collapses the sidebar, the theme control works from
    its new home, and the right-rail toggle is absent until an app declares a panel.
  - The top-strip sidebar toggle preserves keyboard focus and works in expanded, compact,
    and mobile drawer layouts without changing the right panel.
  - The gateway is gone from the sidebar, and — the pair that matters, since the page-link rule is
    shared — an ordinary app page still embeds in the workspace, its frame carrying the launch code,
    `hosty_launch=embedded` and the theme parameters.
  - Measured rather than eyeballed: the content column and the embedded frame resolve to the same
    colour, and a non-app settings tab keeps the page's own surface.

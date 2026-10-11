---
created: 2026-08-19
updated: 2026-10-10
summary: Apps declare where their pages belong, such as settings, panels or navigation, and Shell places them.
components: [apps/shell, apps/core]
---

# App UI Surfaces

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
explicit, paths absolute and every panel labelled — its pages render as
administrator Shell surfaces, so it must not lean on the permissive fallbacks ordinary `app.0.1`
manifests keep for compatibility. An ordinary app keeps those fallbacks, so Shell supplies a label
for a panel that declared none.

Panels optionally declare a stable `id` (lowercase letter followed by up to 63 lowercase letters,
digits or hyphens). IDs are unique within the app and cannot start with the reserved `legacy-` prefix.
Without an ID, Core derives one from the effective endpoint and normalized route; identical legacy
declarations coalesce. Labels, icons and array order do not identify a panel. The SDK addresses a
panel by app ID, installation identity and panel ID; reinstalling invalidates old references.

New installs and updates require a non-empty `ui.panels[].icon` Lucide name in both
ordinary and system apps. Settings surfaces do not require one. Core carries the icon
through its persisted surface contract and API projection. Existing installed manifests
remain readable/startable without icons; Shell renders a visible fallback for missing,
unknown or loading icons, with the full app and panel label in the tooltip.
Update checks accept a candidate whose digest exactly matches the reviewed installed
manifest, so unchanged legacy panels do not create update warnings. Changed candidates
and new installations still require icons.

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

Core's `RequireAccessibleUserAsync` checks assignments on every identity flow, including
revalidation, for both system and ordinary apps. Administrators have implicit app access; other
users need an explicit assignment. Losing that assignment terminates access on revalidation.
An assignment allows entry, not administrative actions: each app checks its own operation-level
roles, and Core management checks the user's authority independently of the app's grants.

## Embedded Authorization

Shell opens resolved app URLs without a launch code in workspaces, settings and panel surfaces.
`EmbeddedAppFrame` supplies the theme, launch mode and mixed-content checks. Its legacy auth/delegated
callbacks confer no authority. `useAppSurfaceSrc` resolves a surface URL and discards stale results;
it does not exchange credentials.

Each app owns its recovery. The JavaScript SDK probes the app's session, offers a Core sign-in popup
when needed, and validates the reply's window, exact origin and initiation state. Its same-origin
`appFetch` supports an in-memory app grant when iframe cookies are unavailable. This works independently
of which Shell surface hosts the app. Core checks assignments on every revalidation.

Harness uses the same app identity for its browser API, with its own administrator requirement.
Legacy signed direct clients remain supported; app identity alone is refused as MCP delegation
consent. The remaining consent mechanism and chat/tool acceptance are tracked in
[local browser origins](../local-browser-origins/plan.md).

## Shell's Chrome

Two rails and a strip, so content stays visible beside its tools rather than under them.

The navigation and 48 px top strip share the Shell's background without an enclosing border.
The left navigation toggle and page title sit together above the workspace, aligned to its
left edge. The brand occupies the navigation width and shows only its mark in compact mode.
Notifications, theme selection and the right panel toggle stay at the right edge.
Shell places the shared SDK workspace inside its own navigation and top strip. The document and
right tool body share a resizable area with a 48 px rail; a tool header provides its title,
**Open separately** and **Return to document**. The same component supplies standalone panels.
See [SDK Panel System](../sdk-panel-system/feature.md) for the host protocol and [panel resizing](../shell-panel-resize/feature.md).

**The right panel** lists actor-accessible `ui.panels` in catalog order. The rail remains visible
when the body is collapsed. Selecting another tool retains every previously opened iframe in this
window, hidden and inert, while unopened tools are not mounted. Central navigation, Shell-owned
pages, collapse and tool switches preserve the selected conversation and draft. Removed access,
installation replacement and frame-policy revocation invalidate affected tools rather than silently
selecting a replacement. The top-strip toggle and assistant shortcut use the same host.

Each panel has an explicit app-local ID or a Core-derived legacy ID. Selection uses app ID,
installation ID and panel ID, never label or array index. Labels/icons/reordering do not change
explicit identity. An ID-less endpoint/route change does; identical legacy declarations coalesce.
Core supplies typed provider surfaces so navigation entries never become implicit side panels.

Tooltips name app and panel. Buttons expose expanded state and attention; Up/Down and Home/End
move rail focus without activating a tool. The shared workspace is a dock at widths of at least
900 px and a dismissible modal drawer below that boundary. It retains the same frame tree across
that change and restores document access/focus on dismissal.

Catalog and target resolution apply current user assignments and reviewed host authority. App
startup is offered only through Shell's authorized lifecycle callback. Stopped apps keep their
catalog entry and explain their state. A working service remains usable during a sibling outage;
a failing probe is advisory and the panel identifies degraded readiness. Temporary probe failures
retain mounted drafts. Protocol placement and domain readiness are separate: a provider reports
its exact requested route after loading; an older/refused frame remains unreported with explicit
separate-open recovery. A frame's app-owned sign-in is not a delegated-token exchange.

**The top strip** owns what belongs to neither rail: a toggle for each rail, and the name
of whatever fills the content area — an app's page, or the Shell page — plus the notification bell
and the theme control, both relocated here from the sidebar footer. The right-rail toggle is absent
when no app contributes a panel. Apps contribute nothing to the strip; an app that could write there
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
  settings remain exempt. Legacy startup/read paths accept missing icon metadata. Update checks
  also accept a byte-identical reviewed legacy manifest; changed candidates still require icons.
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
    shared — an ordinary app page still embeds in the workspace, its frame carrying
    `hosty_launch=embedded` and the theme parameters.
  - Measured rather than eyeballed: the content column and the embedded frame resolve to the same
    colour, and a non-app settings tab keeps the page's own surface.

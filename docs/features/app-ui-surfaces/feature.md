---
created: 2026-08-19
updated: 2026-10-25
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
| `ui.panels` | any | users | Shell Tools catalog and optional pinned top-strip launchers |

Litmus tests: *would a `host.user` ever legitimately open it?* → sidebar or panel. *Does it change
behaviour rather than produce and consume content?* → settings.

Both new fields are additive under `app.0.1` with no `schemaVersion` bump — that number tracks the
contract format, not additions to it. Core resolves each surface to a URL exactly as it resolves a
navigation entry, so Shell discovers placements without reading manifests.

**`ui.settings` is singular and `ui.panels` is a list, deliberately.** One app has one place its
operator configuration lives; the same app may ship several distinct tools, and the Tools menu is
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

Shell's sidebar has one Settings entry. The Settings page owns grouped navigation for My profile,
Host, Users & security and Shell, followed by an Apps group with one app-named entry only for each
declared `ui.settings` surface. There is no installed-app settings catalog. Apps without their own
settings page remain manageable through standalone App Details at `/apps/<app-id>` from Dashboard.
Internal settings navigation belongs to the app. Ordinary users see personal Profile and
Tokens & devices. Declaring stopped apps keep their settings entries and display the existing
start/readiness UI when selected.

The former horizontal tab strip is removed. Selection stays in `/settings?tab=...`, so bookmarks,
reload and back/forward retain the page. App entries use the app id as their key.
Old page-specific bookmarks resolve to the same app entry. Removed or unknown apps fall back to
the host's normal default.

A small Shell header links the app settings page to standalone App Details. Host-managed details
use Dashboard as their administrator breadcrumb parent; app-owned settings remain in Settings.
The iframe fills the remaining
workspace surface beside the sidebar and beneath that header, with no
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

Shell has a left navigation rail, a 48 px top strip and a retained tool workspace.
The top strip provides pinned panel launchers and a ReUI Tools menu beside notifications and theme.
Tools lists every actor-accessible panel in catalog order with its app name, availability and
observed attention. Each row has separate opening and pin actions; Enter or Space on the pin keeps
the menu open. All tools opens the searchable picker, including authorized app startup, catalog
refresh and the same pin controls on mobile. Unpinned and overflowed tools remain reachable here,
including when every launcher is unpinned.

The current assistant starts pinned by default. Explicit choices are stored in this browser's
local storage, scoped by Core origin and signed-in user, using the SDK's
`{ appId, installationId, panelId }` key. The versioned data contains only boolean overrides.
Choices survive metadata updates and temporary catalog removal; a replacement installation gets
a new identity. Invalid storage falls back to defaults. Storage denial or quota failures retain
in-memory choices and show a warning. Other tabs on the same origin observe storage changes;
other browsers and standalone hosts do not share these Shell preferences.

Pinned buttons show icons and labels while their measured width fits the available strip space.
They switch together to icons with accessible names and tooltips when labels no longer fit. If
even icons overflow, only the fitting prefix appears; Tools still contains the complete catalog.
Growing the available space restores buttons and labels without changing the saved selection.

Unpinning changes only the launcher: it keeps retained frames, drafts, conversations, backend
sessions and running apps intact. Explicit menu opens, assistant shortcuts, session links and
finalized handoffs resolve their intended target without changing pins or selecting another
provider. Attention remains in Tools and its aggregate count. Restoring an expanded layout with
no retained selection chooses only a pinned, available panel; an all-unpinned catalog stays closed
until an explicit open. Changing a pin cancels a pending automatic restore and does not open a tool.
SDK enabled/launcher policies remain independent of pin preferences.

The document and open tool body share a resizable area. A tool header provides its title,
Open separately, Hide and a menu containing End this tool view. Hide collapses the workspace while
keeping frames mounted and inert. Ending a view uses the SDK's presentation-close operation.
Unopened tools are not mounted. Central navigation, collapse and tool switches preserve the selected
conversation and draft. Removed access, installation replacement and frame-policy revocation
invalidate affected tools rather than silently selecting a replacement.
See [SDK Panel System](../sdk-panel-system/feature.md) for the host protocol and [panel resizing](../shell-panel-resize/feature.md).

Each panel has an explicit app-local ID or a Core-derived legacy ID. Selection uses app ID,
installation ID and panel ID, never label or array index. Labels/icons/reordering do not change
explicit identity. An ID-less endpoint/route change does; identical legacy declarations coalesce.
Core supplies typed provider surfaces so navigation entries never become implicit side panels.

Menu items name app and panel, and retain ReUI keyboard navigation and focus handling. The shared workspace is a dock at widths of at least
900 px and a dismissible modal drawer below that boundary. It retains the same frame tree across
that change and restores document access/focus on dismissal.

Catalog and target resolution apply current user assignments and reviewed host authority. App
startup is offered only through Shell's authorized lifecycle callback. Stopped apps keep their
catalog entry and explain their state. A working service remains usable during a sibling outage;
a failing probe is advisory and the panel identifies degraded readiness. Temporary probe failures
retain mounted drafts. Protocol placement and domain readiness are separate: a provider reports
its exact requested route after loading; an older/refused frame remains unreported with explicit
separate-open recovery. A frame's app-owned sign-in is not a delegated-token exchange.

**The top strip** owns navigation controls and the current page title. Tools are absent when the
host disables their launcher. Applications do not write arbitrary content into Shell chrome.

Navigation collapses and expands through its top-strip toggle, retaining the persisted
desktop preference and mobile drawer state. There is no button on the sidebar's edge.
The right panel keeps a resize gap while docked; collapsing it leaves the document its full width.

## Current Placements

- **Harness** declares its development page in `ui.navigation`, a compact Assistant panel and its
  settings surface. Explicit main navigation promotes a selected session from the panel to Shell's
  content area. Session query parameters preserve the declared page pathname without duplicating
  its entrypoint. Ordinary app navigation keeps its existing surface.
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

The Shell tool picker groups the authorized catalog by application, retains app startup actions,
and distinguishes an unavailable catalog from a genuinely empty catalog or a search with no
matches. Clearing a failed search keeps the picker open. Phone tool sheets use the same visible
viewport height as Shell dialogs; hiding and crossing the phone breakpoint retain mounted frames
and local drafts.

## Local Verification

The 2026-10-25 panel-pinning change completes visibility-plan deliverables D1–D5 and changes only
Shell, from 0.113.2 to 0.114.0. `npm run shell:test` passes 206 logic tests and 765 component tests after integrating current main;
`npm run shell:build` succeeds. `npm run shell:lint` has no errors and three existing warnings.
Core and CLI build successfully for the local fixture; their implementation is unchanged.

Browser acceptance uses a parent-managed source child Core on macOS with locally built Docker
Shell and a 12-panel fixture. Normal setup/password login and reviewed invitation/app assignments
exercise two isolated users. Their independent pins survive reload, sign-out/sign-in and a reviewed
Shell image update. Keyboard pinning, all-unpinned recovery, explicit opening and retained textarea
drafts pass. A fresh all-unpinned expanded-layout restore remains closed when a launcher is pinned. Checks at 1280, 700 and 390 px cover labels, icon overflow, mobile picker access and
absence of horizontal page overflow; light and dark menu styling are inspected. Geometry tests
also cover growing space and complete icon overflow. Session-link and assistant-shortcut behavior
use isolated SDK component tests; the browser fixture has no live assistant provider credentials.
The disposable sandbox is finished through its parent after verification; ordinary host data and
apps are separate from this test.

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
- Verify per-user/per-Core pin isolation, reload and cross-tab persistence, malformed/denied storage,
  independent panels from one app, metadata changes, temporary removal and reinstall identities.
- Verify keyboard pin/unpin, separate opening actions, all-unpinned recovery, mobile picker pins,
  label/icon fitting and overflow recovery. Pin changes and resizing preserve retained iframe identity.
- Verify explicit session links, assistant shortcuts and attention for unpinned panels without
  preference changes or provider substitution. Collapsing preserves an unsent draft and the same
  iframe; fresh collapsed or all-unpinned loads must not open a frame. Hidden content is inert.

- Each declaring app contributes exactly one app-named Settings entry in compact and expanded
  navigation; non-declaring apps contribute none. There is no duplicate installed-app settings
  catalog. Old page-specific links resolve to the same declared entry, including for stopped apps;
  host-managed App Details opens separately at `/apps/<app-id>`.
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
    its new home, and Assistant and Tools honor the host launcher visibility.
  - The top-strip sidebar toggle preserves keyboard focus and works in expanded, compact,
    and mobile drawer layouts without changing the right panel.
  - The gateway is gone from the sidebar, and — the pair that matters, since the page-link rule is
    shared — an ordinary app page still embeds in the workspace, its frame carrying
    `hosty_launch=embedded` and the theme parameters.
  - Measured rather than eyeballed: the content column and the embedded frame resolve to the same
    colour, and a non-app settings tab keeps the page's own surface.

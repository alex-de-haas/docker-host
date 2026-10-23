---
created: 2026-07-30
updated: 2026-10-22
summary: Shell's three destinations, Dashboard, Settings and Apps, with the route table and the sidebar.
components: [apps/shell]
---

# Shell Navigation

The browser Shell has three top-level destinations: **Dashboard**, the host you manage; **Settings**,
the host you configure; and **Apps**, the apps you use. This document owns the route table and the
sidebar; [Core App Shell](../core-app-shell/feature.md) owns what the Shell *is*, and
[Shell Access And System Apps](../shell-access-and-system-apps/feature.md) owns who sees what.

The same information architecture is being applied to the native client — see
[Swift Shell](../swift-shell/feature.md). The two share the shape and no code.

## The line the structure draws

**Dashboard summarizes runtime state and actions; Settings holds host details and configuration.**
Core's version, status, resources, update and runtime/workspace actions remain on Dashboard. Its
listen address, public origin, data root, runtime host and ingress mode are read-only Core information
in Settings > Host > Updates, alongside the host settings without becoming editable fields.

## Routes

Top-level navigation is route-backed and refresh-safe. One persistent client layout wraps every route
child, so the sidebar, session, Core status, app registry, dialogs, and workspace launch state stay
mounted while the operator moves between routes.

| URL | Renders |
|---|---|
| `/`, `/dashboard` | Dashboard: the Core row, app counts, installed-apps table |
| `/settings?tab=profile\|general\|ingress\|mounts` | Settings, one addressable group per surface |
| `/settings?tab=security&section=users\|tokens\|connections\|policies` | Security and its selected inner tab |
| `/settings?tab=harness&section=agents\|shell` | Harness and its selected inner tab |
| `/apps` | The apps overview — every UI-capable app this session may open |
| `/workspace?app=<id>&path=<app-path>` | An app's UI, embedded |
| `/installed-apps` | Dashboard, then the URL is replaced with `/dashboard` |
| `/users` | Settings, then the URL is replaced with `/settings?tab=security&section=users` |
| `/system-apps/<id>?path=<p>` | The workspace, then the URL is replaced with `/workspace?app=<id>&path=<p>` |

The last three still resolve because they were documented and bookmarkable. Their route files exist so
Next.js serves them rather than 404ing before the client can canonicalize; each redirect target is
itself canonical, which is what makes the replacement terminate.

A settings group and its inner tab travel in `tab` and `section` query parameters, so both survive
refresh, Back and copied links. Legacy flat links such as `?tab=tokens` and `?tab=agents` still open
the corresponding grouped destination; `?tab=core` opens General. A missing or invalid inner tab
selects the first tab in that group. A missing or unrecognized `tab` falls back to Users for an
administrator. App-owned settings keep their app ID in `tab`.

A path the app does not route — no catch-all segment and no `not-found.tsx` — is answered by Next.js
with its own 404; the Shell client never renders it. The route parser still resolves such a path to
Dashboard, because it runs on every render against whatever `usePathname()` reports and must be
total, but that resolution is never a screen anyone sees.

`/workspace` URLs carry the app id and app-relative destination in `path`. The destination retains
its query and fragment under the installed app's origin and base path. For example, an encoded
`/?workspace=<id>&worktree=<id>` selects that worktree in Workspaces instead of requesting a
pathname containing an encoded question mark. A protocol-relative destination cannot change the
installed app origin.

On load Shell asks Core for a fresh launch code
before loading the iframe; codes are single-use, so a refresh re-mints rather than replaying.

## Sidebar

Two groups:

- **Host** — Dashboard for administrators; Settings contains administrator sections and the viewer's own Profile and Access tokens sections.
- **Apps** — every UI-capable app the session can see, ordinary and system alike, a system app marked
  by a badge. The Shell itself is excluded: opening it inside itself resolves back to Dashboard, so a
  row for it could only be a dead end.

There is no System group. The gate it expressed is Core's: `GET /api/apps` filters per user through
`AppAccessPolicy`: administrators have implicit access, and other users see only explicitly
assigned apps, including assigned system apps. Identity issuance and revalidation enforce the
same rule. A client-side system/ordinary split would duplicate Core's access decision.

Below 768px the sidebar defaults to a 60px icon rail, independently of the saved desktop width.
The top-bar toggle expands it over the content, up to 280px wide. The toggle, Escape, the backdrop,
or selecting a destination closes it. Crossing the viewport breakpoint closes a temporary mobile
expansion and restores the saved desktop preference on wide screens. Mobile toggles do not rewrite
that preference. The top bar hides the brand wordmark and subtitle on phones so the page title and
navigation controls fit together.

The top-bar brand and sidebar rows share a 20px icon slot starting 20px from the left edge,
with labels starting at 48px. Compact navigation retains the same horizontal padding, including
app flyout triggers, so collapsing or expanding the rail does not move its icons sideways.
Navigation has symmetric 12px inner padding and no extra workspace gutter on its right
in either mode. The frame and top-strip controls begin directly after the 60px compact
rail or 280px expanded sidebar, keeping their left edges aligned.

The compact rail is 60px wide, centering these icons and the 28px account avatar on the
same axis. The account trigger retains a 36px click target.

The **Apps heading is a link to `/apps`**: the heading is the overview, the rows are the shortcuts.
Collapsed, the sidebar renders no headings, so the rail carries an equivalent control with its own
icon — deliberately not the one app rows fall back to, which an icon-less app would be
indistinguishable from.

Collapsed, an app row is only its icon, so a running app with more than one page makes that icon a
flyout trigger instead of a direct launcher: a menu beside the rail lists the app's pages and the
standalone-open link — both of which the expanded sidebar shows inline and the rail has no room
for. The menu opens on click (which also covers keyboard and touch) and, for a mouse, on hover
after a short delay; it is non-modal so sliding along the rail previews one app after another. A
hover open never takes focus and a hover close never returns it to the trigger — pointing at the
rail must not pull focus out of the embedded app. A single-page app and an app that is not running
keep the plain icon behavior: direct launch, or the disabled state tooltip.

Settings has a single direct navigation button in compact and expanded modes. Expanded app page lists place their vertical guide beneath the parent app icon.

A row opens by the readiness of the service that serves its primary page, not by the app's state
([App Readiness](../app-readiness/feature.md)): while that service is still inside its readiness
budget the row is held and its tooltip reads "is starting"; a `degraded` reading lets the click
through — the click is the row's "open anyway"; and a page whose service is alive stays openable
through a sibling service's outage. A workspace launch follows the same gate, and a route held at
"starting" resolves itself once the service answers. Nested page links are gated the same way.

A stopped app's row stays in the list — hiding it would say the app is gone rather than down — with
the row itself disabled and its name greyed. Where a running app's row carries the chevron that
expands its page list, a stopped one carries **Start** instead: its pages lead nowhere, so the slot
holds the only action that does, and the operator starts the app without first finding it on the
Dashboard. The control appears only for a user who may start apps, since Core refuses everyone else,
and the page list is gated on the runtime state as well as on the expander — an app stopped while
its pages were open would otherwise leave behind a list of launch buttons Core cannot serve.

While a lifecycle verb is already in flight the control reports progress instead of offering Start
again: an app that is mid-start or still shutting down is not running either, and that state is
server-side, so it is true for every administrator in every tab. The predicate is the one the
Dashboard's own lifecycle controls disable on, rather than a second spelling of "not running" that
would let a click race the verb under way.

Navigation rows carry a 20px icon and the page links nested under an expanded app row a 16px one,
so the second level reads as subordinate without a second indent doing all the work. The controls on
a row — the expand chevron, the standalone-open link — stay at 16px: they belong to the row rather
than naming it, and matching the row's own icon would put them on equal footing with it. Collapsed,
a row is only that icon, so every icon-only control names itself with `aria-label` as well as a
tooltip; a title attribute is a tooltip and not an accessible name.

The footer carries the account block only. Core's version, a shortcut into host settings,
and the Core update action are not repeated there: the Dashboard's Core row already states the
version and carries the update button, and Settings is a row in the Host group above.

## Dashboard

Core console logs retain a wide dialog, up to 1280px with viewport margins on smaller screens.
Runtime-app console logs use the capability-gated Logs tab after Launch in App Details. Dashboard
Logs and More > Console logs, readiness links and update-notification Open logs navigate to the
same `/apps/<app-id>?section=logs` destination. There is no runtime-app log popup.
The viewer retains its 200-line tail, explicit Refresh, per-service selection, aggregate fallback
and visible empty/error states. Only the selected Logs tab reads output; exit and app/user/Core
scope changes abort stale requests, while mounted configuration forms retain their drafts.

The logs-only Shell route retains entry for an authenticated user's visible assigned app with the
logs capability, without admitting other Manage sections or management controls. Core's existing
administrator requirement for console-log data still applies; the viewer displays any refusal
without adding grants.

Dashboard sits in a rounded workspace frame with compact page padding: 16px vertically and
12px horizontally, increasing to 16px horizontally on larger screens. Core appears first
in a headerless [ReUI Frame](https://reui.io/docs/components/radix/frame), with a separate card-colored
FramePanel. Core and installed apps use the default Frame variant, providing a thin muted surround.
The Apps heading carries text filters with counts and the primary Install app action. The Frame
header holds search, the filtered app count, aggregate CPU/RAM aligned above app resources, and App
actions. Update all is also a contextual shortcut when applicable. Check updates stays in App actions.
The list and loading/empty states occupy the nested FramePanel. The page title remains in the top bar.

Core has no Platform badge. System apps carry a cog role icon and the active Shell a panels icon,
with explanatory tooltips. Runtime app rows and navigation use Core-resolved manifest icon assets;
Core keeps its inline brand mark. No app-ID lookup overrides an app's supplied icon URL.

Core and app rows have four shared columns: flexible identity, 188px status, 144px resources and
136px actions. Identity contains the name, then the release version or only the active workspace
or branch name and the runtime. Dashboard rows omit the Manual start marker; autostart remains
configurable in More and Manage > Launch. This entire second metadata line is
monospaced. Core source text has the same muted `text-xs` treatment as apps. The source name
has a dotted underline and a decorative hammer for a workspace or Git branch icon for source,
without a type prefix, background highlight or extra padding. Development rows omit the workspace/source
pseudo-runtime words and their separator; package versions retain their concrete production runtime
or profile name. Runtime/source
selection is inside More > Runtime / workspace. Internal development recipe names remain hidden. Source details are
available through hover, keyboard focus and a click/touch popover; installed package versions and
observed Git changes remain accessible there. Core and source/workspace apps also show the existing
`SourceChangeSummary` after the workspace or branch name on the same second metadata line,
separated by a dot: available additions/deletions followed by the count labelled `files`, with a `+`
suffix for truncation. Narrow widths wrap naturally without a forced third line. Missing line totals
are omitted, and failed or unavailable inspection never fabricates counts. This visible summary keeps the complete hover/focus/click details intact.
App-owned focus uses one thin, visible 2 px lime (`#A3E635`) outline or ring in both themes,
without an extra halo or ink edge. The theme bridge preserves lime on Harness and Marketplace
controls inside the SDK host. Grouped inputs use only the parent lime outline, or red when invalid;
invalid borders remain red. SDK-owned rail and chooser controls retain their existing styling.

For administrators, clicking noninteractive runtime app-row space opens standalone App Details at
`/apps/<app-id>`, outside Settings, with a `Dashboard / <app name>` breadcrumb linking to
`/dashboard`. This replaces the former More > Manage application destination. The app name is a
native Manage link for keyboard access and opening another tab; the table row gains no extra tab
stop. App rows have no service expander or inline expanded services/network panel, and More omits the duplicate Manage entry. Embedded buttons, menus,
version/source disclosures and resource popovers retain their own behavior. Modified/nonprimary
clicks and text selection do not activate row navigation. Service state, health,
image revisions, resources and endpoint controls remain available in Manage. Core has no expander
or expanded panel; its host facts and address copy buttons remain in Settings > Host > Updates.

Pending Starting, Stopping and Restarting labels appear in the main status column, without repeating
the verb beneath the app name. Separate configuration and Restart required information remains
visible.

App contextual shortcuts retain the existing pending, Configure, Update and Start priority. For a
running app, administrators see Logs only for observed degraded or unhealthy service health when
logs are supported; otherwise they see Stop. Update, manifest, permission and previous-operation
alerts do not affect this choice. Missing, unknown or startup health does not count as a failure.
Ordinary users retain their existing Logs shortcut and never gain Stop. More keeps every supported
action with its current permission/busy guards. Core's Logs shortcut is unchanged.

Below 760px of Dashboard container width, identity/actions and status/resources occupy separate
rows. Below 440px the contextual shortcut moves entirely into More, Install becomes an icon with
an accessible name, and live resources occupy a separate line. Names truncate and source labels
retain their full disclosure. App service and endpoint details use Manage rather than expanding
inside the table. The Sandboxes header wraps its creation and refresh
actions on narrow containers.

Resource cells show separate CPU and RAM values and sparklines over the retained five-minute
history. Stopped apps display a dash and expose no stale resource button; the narrowest layout omits
that empty cell. Manage's stopped services hide resource controls. Clicking a live cell opens the
existing ReUI-framed CPU/RAM history popover. The administrator API and shared SSE supply Core's
bounded history independently of Telemetry; see [Runtime resource usage](../runtime-resource-usage/feature.md).

Core's actions menu offers Runtime / workspace, Restart, Console logs, Source settings, and Update
when available. The runtime submenu lists Release and eligible existing named workspaces rather than
a generic Source/main option. Core-only review excludes all apps. An existing Core workspace Returns
Core first with explicit current-data compatibility acceptance; confirmed Return is followed by a
fresh workspace review or an explicit Release continuation. Return can restore a previous source
build, so it is not labelled Release. Release completion follows a new factual Release launch.
The review/recovery dialog stays mounted outside More and retains original requests across closure,
reconnect and remount. Actor/Core scope changes cancel obsolete queued requests and stale reads.
Source settings and factual source/IDE state remain separate. Existing administrator, busy and
manageable-state guards apply without removing retained recovery controls.

Failed update checks appear on the problem icon after the app name, with the full error in its
hover/keyboard tooltip, and in Manage diagnostics, even when services are healthy and
action shortcuts are hidden. App-version hover contains revision/build information only; its wrapper
has no native update-error title. Fleet-check error
toasts name the affected apps and include the stored error; a single-app failure also supplies
that app's context to the toast's assistant action.

Search matches app names and IDs without case sensitivity and ignores leading/trailing whitespace.
It combines with the selected state filter; the empty-result action clears both. Core remains visible
as host context. Search and filters affect the app list; fleet update actions still apply to the host.

Counts describe all installed apps, including system apps, independently of the selected filter:

Counter buttons show only their icon and number. Their full descriptions remain available as
hover tooltips and accessible names, keeping the toolbar compact without losing the filter labels.

- **Running** selects apps whose runtime state is `running`.
- **In progress** selects `starting` and `stopping` apps.
- **Need attention** selects apps with a last error, a failed operation, an unknown runtime state, a failed update check, or pending runtime configuration.
- **Updates** selects apps with a known update offer, including offers retained after a failed check.
- **Total** restores all apps. Clicking an already selected counter also clears the filter.

The in-progress counter is hidden at zero unless selected. Updates and attention stay available at zero. An active filter remains
reachable when its last app changes state; the empty result offers Show all apps. Stopped apps are
not classified as needing attention solely because they are stopped. Filtering affects only the
installed-app rows; Core and host-wide update controls remain available.

Below the toolbar, in order:

1. A **Core row** — a separate summary table row above the installed-apps table, without an
   expander or inline detail panel. It shows the name, Core's version/source, runtime,
   status, resources and available update. Its columns align with the app rows below. Logs and More
   retain Core's runtime/workspace, restart, update and separate Source settings actions.
   Read-only Core information is in Settings > Host > Updates: listen address and public origin
   retain copy buttons, followed by data root, runtime host and ingress mode. The block reuses the
   existing Shell status without extra requests or polling and does not reset configuration drafts.
   Missing status or fields show Unavailable; a known status without a public origin shows Not
   configured. Core stays outside the app counts: it cannot be installed or removed. It carries
   nothing about Shell, whose own app row already describes it.
2. The **installed-apps table**, with per-row lifecycle controls, runtime switching and update
   affordances. Activating a row opens the existing Manage/App Details view; the app service expander
   and duplicate More > Manage application entry are absent. Service/network details and controls
   remain in Manage, while embedded row controls retain their own actions.

Both tables use the same column widths and visually hidden column headers, retaining native table
semantics for assistive technology. Rows reflow within narrow workspaces without horizontal scrolling.

The Core update action lives here and nowhere else: this is where an administrator is already reading
the host's version, and a fact that cannot be acted on beside itself is an odd place to stop.
Shell re-reads Core's installed status and cached update availability when the event stream connects
or reconnects and when the tab becomes visible. Its delayed post-update probe also refreshes the
installed status. These reads bypass the browser cache, so a restarted Core's version appears without
a page reload; a temporary failed status read retains the last known facts until the next sync.
An update offer for an older installed Core version is hidden as soon as the new version is known,
even if the release-status endpoint is still unavailable.

## Pending runtime configuration

Core records a private settings-and-mounts fingerprint after a successful app start or restart.
`restartRequired` in lifecycle summaries compares it with current setting values and resolved external
mounts while the app is running. Dashboard shows `Restart required` beneath the app name, with an
administrator-only Restart action disabled during lifecycle operations. It never restarts automatically.
The attention filter includes these apps.

The fingerprint survives Core restarts and covers inline bindings, shared assignments, library host
paths, and effective read-only modes. Applied paths are the canonical paths passed to the runtime;
repointing a symlink marks the app for restart. Unresolvable paths do not block listing or repair. Description-only edits, unchanged values, binding reorderings,
and changes reverted to the applied configuration produce no warning. Autostart and update policy
are not process configuration. Stopped apps apply edits at their next start, so they show no warning.
Failed starts preserve the preceding fingerprint. The digest stays private; summaries expose only a
boolean, never setting values or hashes.

Older running records acquire their baseline immediately before a settings/binding edit or a shared
library edit. Changes already made under an older Core cannot be reconstructed; the next successful
start establishes a known applied snapshot. Source and Docker runtimes share the same comparison.

## Apps Overview

`/apps` retains Open and Standalone for the current user's visible UI apps. Administrators also
see Uninstall; ordinary users do not gain removal controls. Uninstall uses the same Core approval
flow as the existing Dashboard and Manage entries, without a preliminary Shell options dialog.
Core owns cleanup choices, impact, runtime-state and active-Shell warnings and source-safety review.
Shell reserves the popup in the click, retains a blocked-popup link and original-request recovery,
and reports success only after Core confirms execution. Denial leaves the app and selection intact;
failures remain visible. See [trusted confirmation](../app-installation-sdk/feature.md#trusted-confirmation).

## Settings

Settings groups live inside the Settings page: My profile, Host, Users & security, Shell and Apps.
The Apps group lists individual apps only when they declare an app-owned `ui.settings` surface;
there is no general App settings entry or duplicate installed-app catalog. Shell's sidebar has one
Settings button. Each destination has a visible title, description and line tabs. App-owned settings
retain full-height iframe embedding, app-owned internal navigation and a link to standalone App
Details. Existing app-settings bookmarks still select that declared settings surface. Former
`/settings?tab=apps` canonicalizes to Dashboard with normal role authorization. The Users section
also omits its repeated User Management title and description. The invitation button sits beside
search inside the Users section, with no separate refresh button. Users and Pending Invitations
have no outer border, shadow, separate background, or former card padding; table row separators remain visible.
With no pending invitations, only `Pending invitations · 0` is shown. A nonempty invitation list renders its table.
Access tokens links to Core's isolated credential-management page.

Security / Policies uses a compact layout: three session categories side by side on desktop,
with access and privileged activity below. General holds update-check maintenance, Users holds
disabled-user retention, and Ingress holds Core connection and public-ingress settings. Units appear beside numeric
fields, with exact duration equivalents such as `168 hours = 7 days` beneath them. Draft edits update
these hints without changing the stored unit; zero and invalid drafts receive no inferred meaning.
The layout is defined in Shell; values, types, descriptions and defaults come from Core.
Unknown keys from newer Core versions remain editable under Additional settings in General;
authentication and OAuth keys belong to Policies, and the Public ingress group belongs to Ingress.
On smaller screens, the groups stack vertically. Each form submits only its visible changed keys;
default resets and errors remain available. Ingress uses one draft for Core connection and provider
settings, including provider-dependent fields and the warning when the public origin changes.
Core settings load fresh when General, Users, Policies or Ingress opens, because another
administrator may have changed their live-applied values. Ordinary users see only Your profile
and Security / Access tokens, enforced by both navigation and route authorization.

One route with addressable host sections and app pages:

- **Your profile** — personal display name and external provider accounts ([profile and connections](../user-profile-connections/feature.md)).
- **General** — update-check maintenance and otherwise unclassified Core settings.
- **Harness** — Agents and Shell tabs; Shell selects the default assistant.
- **Security** — Users (including disabled-user retention), Access tokens, Source connections,
  and Policies (session lifetimes, access settings and privileged activity).
- **Ingress** — Core listen port and public origin, public ingress and the Cloudflare connection.
- **Shared mounts** — host folders apps attach by reference.
- Each app settings entry exposes its manifest-declared `ui.settings`. Internal tabs belong to the app.
  See [App UI Surfaces](../app-ui-surfaces/feature.md) for compatibility and routing.

Host-managed per-app configuration lives in standalone App Details at
`/apps/<app-id>?section=<section>`. Dashboard row/name links and app log/notification links select
this canonical destination. Legacy `/settings?tab=manage:<app-id>&section=<section>` bookmarks
migrate to the same app and section. The administrator's native Dashboard breadcrumb returns to
`/dashboard`; the retained ordinary-user logs-only page links back to `/apps` and exposes no
management controls. These host-managed controls stay separate from app-owned Settings pages.

## Landing

Dashboard is the administrator's home. `/apps` is the landing for everyone else and the redirect
target for an unauthorized management route.

## Outside the Shell

Only two places outside `apps/shell` build a Shell **path**; everything else — `hosty open`, Core's
login, setup, recovery and invitation redirects, CORS, and the marketplace, telemetry and demo app
theme bridges — depends on the Shell **origin** alone.

- `ControlIdentityEndpoints.BuildShellWorkspaceUrl` builds the `--mode shell` link for
  `hosty apps open`. It targets `/workspace?app=<id>&path=/`.
- `UserManagementEndpoints` returns a Shell-relative `redirectPath` after an invitation is accepted:
  `/` for an administrator, `/apps` for a user.

Dashboard update progress follows Core's active app stages. The indicator and stage message sit
beneath the current runtime/health status in the Status column, including for source/workspace apps.
Long messages wrap there, leaving version/runtime metadata together. The primary status uses
Core's runtime state and applicable health, without inferring lifecycle from an operation label;
an absent runtime observation shows Unknown. Pending start/stop/restart verbs appear once in the
main status. Update phases `stopping` and `starting` show only Updating below it, without a service
suffix. Other supported phases retain their specific update label and optional reported service. Terminal outcomes add
no row label or expiry timer. Existing completion, error and readiness toasts remain; problem icons
and Manage retain diagnostics.
Version tooltips contain revision/build details; full update-check errors remain on the after-name
problem icon and in Manage diagnostics. Failed checks retain found updates and are excluded from
bulk apply. Core updates use live status and release checks for completion,
with reconnecting, verifying and unconfirmed states instead of a fixed completion delay.

The client authorization redirect uses the same section-aware policy as rendering: ordinary users
stay on their Profile and Access tokens pages, while host and app administration sections redirect to Apps.
The check also runs when only the settings query parameter changes.

Administrators have an always-visible Permissions tab in each app's settings panel. It displays
accepted and observed declarations and effective grants read-only. **Change permissions** opens
Core's isolated page, where only already granted optional rights start checked. Shell refreshes
the displayed grants when focus returns; it holds no draft selections of its own.
Dashboard's actionable permission problem opens that tab; missing required access contributes to the
attention count without changing the factual runtime badge. Invalid observation is a distinct warning;
disabled optional permissions are not a problem. See [App permission management](../app-permission-management/feature.md).

## Testing Expectations

- Check both lists with a wide workspace, an expanded right panel, and narrow content widths.
  Runtime/version stacking and shortcut visibility follow container width, not viewport width.
  Names, statuses, menus, Manage app details and Settings Core information remain reachable without
  horizontal scrolling.
  The full version/source and runtime metadata line is monospaced. No Dashboard row displays a Manual start marker. Source
  labels show the workspace or branch name after a decorative hammer or Git branch icon, with a
  dotted underline and no type prefix, highlight or extra padding; Core matches app rows' muted text-xs styling.
  The same second line retains factual source-change counts after a dot for Core and source/workspace
  apps, using `files` and a `+` truncation suffix, with natural narrow wrapping and no zero-filled
  missing line totals or invented counts after errors. Development rows omit pseudo-runtime words
  and their separators; production runtime names stay unchanged. Hover, keyboard and click/touch retain source details,
  and app-owned focus has one visible 2 px lime (`#A3E635`) outline or ring in both themes,
  including inside the SDK host, without a halo or ink edge. Retain red invalid/error treatment
  and parent-only grouped focus; check SDK-owned rail and chooser controls separately.
- Apps overview tests retain Open/Standalone and administrator-only Uninstall. Verify direct Core
  removal review, all cleanup choices, popup fallback, denial/errors, source safety and same-request
  recovery without an intermediate Shell popup or premature success.
- Verify revision/build-only app-version hover and the full update-check error on the problem icon,
  without a native error title on the version wrapper; retain Manage diagnostics and error toasts.
- Administrator row clicks and keyboard activation of the native app-name link open standalone
  `/apps/<app-id>` App Details. The link supports opening another tab; the row has no extra tab stop.
  The Dashboard breadcrumb returns to `/dashboard`; legacy Manage bookmarks preserve their app and
  section during migration. Settings Apps lists only declared `ui.settings` surfaces, preserving
  normal identity, access, stopped-app readiness and full-height embedding without a duplicate catalog.
  Embedded buttons, menus,
  source/version disclosures and resource popovers do not also navigate. Runtime app expanders and
  the duplicate Manage menu item are absent. Core also has no expander; its five host facts and
  address copy controls remain in Settings > Host > Updates, with unavailable states, administrator
  access and unsaved drafts preserved. All Manage service/network facts and controls remain reachable.
- Verify Core and app menus retain their actions and permission/busy guards in compact mode.
  Runtime / workspace names both selectors; app source/branch capabilities remain. Core lists
  eligible existing named workspaces and Release, excludes all app participants, and requires a
  confirmed compatibility-bound Core Return before the next target. Verify fresh reviews, retained
  request IDs, scope cancellation, unknown receipts and factual Release readiness.
  App shortcuts cover healthy, degraded/unhealthy, startup and unobserved health, unrelated
  update/manifest/permission/operation diagnostics, logs capability, administrator Stop versus
  ordinary-user Logs, and unchanged pending/Configure/Update/Start priority.
  Core's Logs shortcut remains unchanged.
- Verify both Dashboard log entries, readiness/update-notification actions and direct URLs select
  App Details Logs without a modal. Check capability/visible-app boundaries, ordinary-user logs-only
  navigation without management controls, existing Core refusal, selected-only loading, Refresh,
  service selection, empty/errors, exit/scope aborts and retained drafts. Core logs remain a dialog.


- Route parsing covers each destination, the legacy paths, an unrecognized path, and a missing or
  unrecognized settings tab.
- Canonicalization covers legacy paths and settings destinations, including that
  `/system-apps/<id>?path=/x` keeps `/x`, Manage bookmarks preserve the section on `/apps/<app-id>`,
  and removed `tab=apps` returns to the role-authorized Dashboard/default. Every redirect target is
  itself canonical so the effect cannot loop.
- Builders and the parser are tested against each other, so a change to one cannot silently diverge.
- The `--mode shell` link shape is pinned by a Core test. It was unpinned for a long time, and for all
  of it the command emitted a URL the Shell has never served.
- Visual verification covers the merged Dashboard, host settings tabs, the collapsed sidebar
  reaching `/apps`, and each legacy path landing on its canonical URL.
- Grouped settings verification covers canonical and legacy links, Back and reload, inner-tab
  selection, ordinary-user access and scoped saves for General, Users and Policies.
- Core form verification covers desktop and narrow layouts, units, draft edits, default resets,
  errors and the public-origin warning. Ingress saves Core connection and provider-dependent
  fields together without submitting fields owned by other groups.
- Visual verification covers the two icon tiers — row icons against the page links nested under an
  expanded app row — and that every collapsed rail control is announced by name.
- Visual verification of the collapsed rail covers the multi-page app flyout: opening by click and
  by hover, page navigation and the standalone link from it, and that hovering the rail does not
  steal focus from an embedded workspace.

- Dashboard filter coverage includes running, transitional, stopped, unknown, failed, and missing
  states, plus an error clearing after recovery. Counts and filtering share the same predicate.
- Browser verification covers selected filters, reset to all, zero attention visibility, and the
  empty-filter recovery control when a selected category becomes empty.
- Phone navigation verification covers the default icon rail, overlay expansion, backdrop and Escape
  dismissal, and restoration of the desktop preference after resizing.

- Core status refresh coverage includes old/new versions across a restart, temporary network and
  HTTP failures, browser-cache bypass, and cancellation before a response is applied.

- Dashboard search tests cover name/ID matching, case/whitespace, filter combinations, update-check
  failures, and restart-required attention state. Duration tests cover exact decompositions and invalid drafts.
- Lifecycle tests cover restart-required persistence across Core recreation, no-op configuration, reverts,
  successful/failed starts, legacy baselines, and effective shared mount changes. Pending lifecycle
  verbs appear only in the main status while independent configuration/restart warnings remain.
  Browser checks cover
  compact empty invitations, card alignment, search reset, and duration equivalents.

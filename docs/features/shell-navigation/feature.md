# Shell Navigation

Created: 2026-07-30
Updated: 2026-09-10

The browser Shell has three top-level destinations: **Dashboard**, the host you manage; **Settings**,
the host you configure; and **Apps**, the apps you use. This document owns the route table and the
sidebar; [Core App Shell](../core-app-shell/feature.md) owns what the Shell *is*, and
[Shell Access And System Apps](../shell-access-and-system-apps/feature.md) owns who sees what.

The same information architecture is being applied to the native client — see
[Swift Shell](../swift-shell/feature.md). The two share the shape and no code.

## The line the structure draws

**Facts about the host go to Dashboard; editable configuration goes to Settings.** Core's version,
origins, data root and a waiting update are not the same surface as Core's settings, which is why they
sit on different pages rather than one of them being an oversight.

## Routes

Top-level navigation is route-backed and refresh-safe. One persistent client layout wraps every route
child, so the sidebar, session, Core status, app registry, dialogs, and workspace launch state stay
mounted while the operator moves between routes.

| URL | Renders |
|---|---|
| `/`, `/dashboard` | Dashboard: the Core row, app counts, installed-apps table |
| `/settings?tab=users\|core\|mounts` | Settings, one addressable tab per surface |
| `/apps` | The apps overview — every UI-capable app this session may open |
| `/workspace?app=<id>&path=<app-path>` | An app's UI, embedded |
| `/installed-apps` | Dashboard, then the URL is replaced with `/dashboard` |
| `/users` | Settings, then the URL is replaced with `/settings?tab=users` |
| `/system-apps/<id>?path=<p>` | The workspace, then the URL is replaced with `/workspace?app=<id>&path=<p>` |

The last three still resolve because they were documented and bookmarkable. Their route files exist so
Next.js serves them rather than 404ing before the client can canonicalize; each redirect target is
itself canonical, which is what makes the replacement terminate.

A settings tab travels in the query string for the same reason workspace state does: a top-level
surface has to survive a refresh and a copied link. A missing or unrecognized `tab` resolves to
`users` rather than erroring — every link Shell builds names its tab explicitly, so nothing depends on
that default.

A path the app does not route — no catch-all segment and no `not-found.tsx` — is answered by Next.js
with its own 404; the Shell client never renders it. The route parser still resolves such a path to
Dashboard, because it runs on every render against whatever `usePathname()` reports and must be
total, but that resolution is never a screen anyone sees.

`/workspace` URLs carry only the app id and app path. On load Shell asks Core for a fresh launch code
before loading the iframe; codes are single-use, so a refresh re-mints rather than replaying.

## Sidebar

Two groups:

- **Host** — Dashboard, Settings. Administrator-only.
- **Apps** — every UI-capable app the session can see, ordinary and system alike, a system app marked
  by a badge. The Shell itself is excluded: opening it inside itself resolves back to Dashboard, so a
  row for it could only be a dead end.

There is no System group. The gate it expressed is Core's: `GET /api/apps` filters per user through
`AppAccessPolicy`, which admits a system app only to an administrator, and `AppIdentityService`
refuses a launch code for one with `system_app_admin_required`. A non-administrator never receives a
system app in the list at all, so a client-side split would be a second copy of an authorization
decision — the kind that drifts.

Below 768px the sidebar defaults to a 60px icon rail, independently of the saved desktop width.
The top-bar toggle expands it over the content, up to 280px wide. The toggle, Escape, the backdrop,
or selecting a destination closes it. Crossing the viewport breakpoint closes a temporary mobile
expansion and restores the saved desktop preference on wide screens. Mobile toggles do not rewrite
that preference. The top bar hides the brand wordmark and subtitle on phones so the page title and
navigation controls fit together.

The top-bar brand and sidebar rows share a 20px icon slot starting 20px from the left edge,
with labels starting at 48px. Compact navigation retains the same horizontal padding, including
app flyout triggers, so collapsing or expanding the rail does not move its icons sideways.
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

The footer carries the account block only. Core's version, the shortcut into `/settings?tab=core`,
and the Core update action are not repeated there: the Dashboard's Core row already states the
version and carries the update button, and Settings is a row in the Host group above.

## Dashboard

App and Core console log dialogs use a wide layout, up to 1280px while retaining the dialog's
viewport margins on smaller screens, to fit longer log lines.

The toolbar places app search and clickable app counts beside Refresh, Check updates, Update all (when available),
and Install App. The groups wrap on narrow screens. The visible page title stays in the Shell top
bar; the content keeps a screen-reader heading without repeating the title or introductory description.

Search matches app names and IDs without case sensitivity and ignores leading/trailing whitespace.
It combines with the selected state filter; the empty-result action clears both. Core remains visible
as host context. Search and filters affect the app list; fleet update actions still apply to the host.

Counts describe all installed apps, including system apps, independently of the selected filter:

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

1. A **Core row** — a separate, expandable table row above the installed-apps table. Collapsed it
   shows the name, component id, Core's version, status, and update icon beside the version when an
   update is available. Version and status align with the app columns below; console logs use the
   same icon control as app logs. Logs and a shortcut to the sidebar's Settings destination sit at
   the right edge of the row. Host and app settings controls share the gear icon throughout Shell.
   Expanded it shows two URLs — the address Core
   listens on and its public origin, each copyable and openable — then data root, runtime host, and
   ingress mode. Core stays outside the app counts: it cannot be installed or removed. It carries
   nothing about Shell, whose own app row already describes it.
2. The **installed-apps table**, with per-row lifecycle controls, runtime switching, update
   affordances, the expandable per-service panel, and the install and details dialogs.

Both tables use the same column widths and visually hidden column headers, retaining native table
semantics for assistive technology. Narrow viewports can scroll each table horizontally.

The Core update action lives here and nowhere else: this is where an administrator is already reading
the host's version, and a fact that cannot be acted on beside itself is an odd place to stop.
Shell re-reads Core's installed status and cached update availability when the event stream connects
or reconnects and when the tab becomes visible. Its delayed post-update probe also refreshes the
installed status. These reads bypass the browser cache, so a restarted Core's version appears without
a page reload; a temporary failed status read retains the last known facts until the next sync.

## Pending runtime configuration

Core records a private settings-and-mounts fingerprint after a successful app start or restart.
`restartRequired` in lifecycle summaries compares it with current setting values and resolved external
mounts while the app is running. Dashboard shows `Restart required` beneath the app name, with an
administrator-only Restart action disabled during lifecycle operations. It never restarts automatically.
The attention filter includes these apps.

The fingerprint survives Core restarts and covers inline bindings, shared assignments, library host
paths, and effective read-only modes. Description-only edits, unchanged values, binding reorderings,
and changes reverted to the applied configuration produce no warning. Autostart and update policy
are not process configuration. Stopped apps apply edits at their next start, so they show no warning.
Failed starts preserve the preceding fingerprint. The digest stays private; summaries expose only a
boolean, never setting values or hashes.

Older running records acquire their baseline immediately before a settings/binding edit or a shared
library edit. Changes already made under an older Core cannot be reconstructed; the next successful
start establishes a known applied snapshot. Source and Docker runtimes share the same comparison.

## Settings

The page starts with its tabs. Settings appears in the top strip; the content retains a
screen-reader heading without a duplicate visible title or introductory description. The Users tab
also omits its repeated User Management title and description. The invitation button sits beside
search inside the Users section, with no separate refresh button. Users and Pending Invitations
have no outer border, shadow, separate background, or former card padding; table row separators remain visible.
With no pending invitations, only `Pending invitations · 0` is shown. A nonempty invitation list renders its table.
Access tokens likewise omits its repeated visible
title and introductory description. A Create button at the top opens a dialog for the credential
label and access scope. The same dialog shows the issued token once, with Copy and Done actions;
closing clears the token from local state. Creation errors stay in the dialog, and the active
credential list refreshes after creation.

The Core tab uses a dedicated compact layout: three session categories side by side on desktop,
access and maintenance in two columns, and connection settings below. Units appear beside numeric
fields, with exact duration equivalents such as `168 hours = 7 days` beneath them. Draft edits update
these hints without changing the stored unit; zero and invalid drafts receive no inferred meaning.
The layout is defined in Shell; values, types, descriptions and defaults come from Core.
Unknown keys from newer Core versions remain editable under Additional settings. On smaller screens,
the groups stack vertically. The repeated Core settings title and introduction are visually omitted.
Saving still submits only changed keys; default resets, errors and the public-origin warning remain
available.

One route with host and system-app tabs:

- **Users** — accounts, invitations, roles, per-app assignment.
- **Access tokens** — client credentials and OAuth connections.
- **Core** — sessions, access, maintenance and connection settings. Loaded fresh each time the tab is shown, because the values are
  live-applied and another administrator may have changed them.
- **Ingress** — public ingress and the Cloudflare connection.
- **Shared mounts** — host folders apps attach by reference.
- System-app tabs expose their app-owned settings.

Per-app settings stay in the app details dialog. They describe an app, not the host.

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

Dashboard update feedback follows Core's app stages and expires a success label after 30 seconds.
Version tooltips include the last successful update-check time; failed checks retain found updates
and are excluded from bulk apply. Core updates use live status and release checks for completion,
with reconnecting, verifying and unconfirmed states instead of a fixed completion delay.

## Testing Expectations

- Route parsing covers each destination, the legacy paths, an unrecognized path, and a missing or
  unrecognized settings tab.
- Canonicalization is pinned for all three legacy paths, including that `/system-apps/<id>?path=/x`
  keeps `/x`, and that every redirect target is itself canonical so the effect cannot loop.
- Builders and the parser are tested against each other, so a change to one cannot silently diverge.
- The `--mode shell` link shape is pinned by a Core test. It was unpinned for a long time, and for all
  of it the command emitted a URL the Shell has never served.
- Visual verification covers the merged Dashboard, host settings tabs, the collapsed sidebar
  reaching `/apps`, and each legacy path landing on its canonical URL.
- Core form verification covers desktop and narrow layouts, units, draft edits, default resets,
  errors and the public-origin warning. Ingress retains its provider-dependent form.
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
  successful/failed starts, legacy baselines, and effective shared mount changes. Browser checks cover
  compact empty invitations, card alignment, search reset, and duration equivalents.

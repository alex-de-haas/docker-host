# Shell Navigation

Created: 2026-07-30
Updated: 2026-08-17

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

The **Apps heading is a link to `/apps`**: the heading is the overview, the rows are the shortcuts.
Collapsed, the sidebar renders no headings, so the rail carries an equivalent control with its own
icon — deliberately not the one app rows fall back to, which an icon-less app would be
indistinguishable from.

The footer carries the account block only. Core's version, the shortcut into `/settings?tab=core`,
and the Core update action are not repeated there: the Dashboard's Core row already states the
version and carries the update button, and Settings is a row in the Host group above.

## Dashboard

One page, in order:

1. A **Core row** — shaped like a table row and expandable like one, but deliberately not in the
   table. Collapsed it shows the name, the component id, Core's version, its status, and the update
   action when a newer Core is available. Expanded it shows two URLs in the shape an app endpoint
   uses — the address Core listens on and the origin it is reached at, each copyable and openable —
   then data root, runtime host, and the ingress mode.

   It stays outside the table because the counts below describe the table's rows, and Core is not one:
   it cannot be installed or removed, and it answers almost none of the verbs every other row does.
   It carries nothing about the Shell — no version, no origin — because the Shell is an app and its
   own row already says both.
2. One line of **counts** — running, in progress (only when non-zero), needs attention, total.
3. The **installed-apps table**, with per-row lifecycle controls, runtime switching, update
   affordances, the expandable per-service panel, and the install and details dialogs.

The counts describe the rows in the table, system apps included; a header that disagreed with the list
under it would be worse than either number alone. Apps mid-verb are counted in neither the running nor
the attention bucket — calling them "not running" reads as a shortfall during a boot that is going
fine, and calling them a problem is worse.

The Core update action lives here and nowhere else: this is where an administrator is already reading
the host's version, and a fact that cannot be acted on beside itself is an odd place to stop.

## Settings

One route, three tabs:

- **Users** — accounts, invitations, roles, per-app assignment.
- **Core** — Core's own settings (auth session lifetimes, background update interval) and the
  Cloudflare ingress connection. Loaded fresh each time the tab is shown, because the values are
  live-applied and another administrator may have changed them.
- **Shared mounts** — host folders apps attach by reference.

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

## Testing Expectations

- Route parsing covers each destination, the legacy paths, an unrecognized path, and a missing or
  unrecognized settings tab.
- Canonicalization is pinned for all three legacy paths, including that `/system-apps/<id>?path=/x`
  keeps `/x`, and that every redirect target is itself canonical so the effect cannot loop.
- Builders and the parser are tested against each other, so a change to one cannot silently diverge.
- The `--mode shell` link shape is pinned by a Core test. It was unpinned for a long time, and for all
  of it the command emitted a URL the Shell has never served.
- Visual verification covers the merged Dashboard, all three settings tabs, the collapsed sidebar
  reaching `/apps`, and each legacy path landing on its canonical URL.

# Feature: Shell Access And System Apps

Created: 2026-06-04
Updated: 2026-07-30

## Goal

Hosty Shell should clearly separate administrator-only Host management from ordinary user app access. Administrators should be able to see system apps such as Hosty Shell in the installed-app inventory, while ordinary users should only see and open assigned non-system runtime apps.

## Non-goals

- Do not expose Host management pages to `host.user` accounts.
- Superseded since 2026-07-25: system apps carry the full control set — lifecycle, backups, reviewed updates, and removal — because "system" governs reach, not lifecycle. See [removable-system-apps](removable-system-apps/feature.md).
- Do not show Hosty Shell as a normal app in the sidebar Apps navigation.
- Do not change the app assignment model to include system apps.
- Do not change CLI control behavior in this feature.

## Current Behavior

Core bootstraps Hosty Shell as a system runtime app with app id `hosty.shell`.

`GET /api/apps` returns all apps to `host.admin` accounts and filters system apps out for `host.user` accounts. That filter is the boundary, and since Shell 0.49.0 it is the only one: the sidebar has a single Apps group holding every UI-capable app the session receives, a system app marked by a badge rather than by a separate group. A non-administrator never receives a system app to group. The Host group — Dashboard and Settings — is shown to administrators only.

Administrators can open settings for system apps from Dashboard. This lets first-party apps such as Marketplace use ordinary manifest settings without receiving a privileged Core client.

## Access Rules

Shell should treat Host management views as administrator-only:

- `host.admin` can see Dashboard and Settings.
- `host.user` cannot see or navigate to Dashboard or Settings.
- `host.user` lands on the Apps view and only sees the apps Core returned for them — non-system and allowed by app assignments.
- If a non-admin reaches a management route or stale active view state, Shell redirects the view back to Apps.

The sidebar Apps section holds every app with Shell UI metadata that the session received, system apps included and marked by a badge. Hosty Shell itself is excluded: opening it inside itself resolves back to Dashboard.

Dashboard shows Core's status and version above one table of every installed app, with counts — running, in progress, needs attention, total — describing the rows in that table, system apps included.

System app actions should stay limited in Shell:

- logs are allowed when the app exposes the `logs` capability and the active user is `host.admin`;
- runtime switching is allowed for administrators when the app exposes more than one runtime profile;
- settings, public origins, external mounts, source override, and development-mode configuration are allowed for administrators through the ordinary app settings dialog;
- reviewed updates are allowed for administrators whenever the app does not run a live source runtime — the same eligibility as runtime apps, served by the same check/plan/apply flow. Updating is inherent to Core managing an app and is authorized on the endpoint, never by the manifest `capabilities` list;
- lifecycle controls such as start, stop, restart, autostart, backup, restore, and remove are available for system apps too; removing one opens the same confirmation panel, with the computed impact and a recovery hint.

## User/API Scenarios

- A `host.admin` opens Shell and sees Dashboard, Settings, and every UI-capable app in one Apps group.
- A `host.admin` opens Dashboard and sees normal runtime apps and Hosty Shell in one table, the latter badged `System`.
- A `host.admin` can open logs for Hosty Shell when logs are available.
- A `host.admin` can switch Hosty Shell between available runtime profiles from the Dashboard runtime column.
- A `host.admin` can configure a system app's manifest settings, including Marketplace's catalog source URL.
- A `host.admin` can check for and apply a reviewed update to a system app, including Hosty Shell itself (the page reloads after a successful Shell self-update).
- A `host.admin` cannot stop, restart, back up, or remove Hosty Shell from Shell UI.
- A `host.user` opens Shell and sees only the Apps navigation for assigned or unrestricted non-system runtime apps.
- A `host.user` does not see Dashboard, Settings, or any system app.

## Technical Design

Shell should derive these app groups from the `system` flag already returned by Core:

- `runtimeApps = apps.filter(app => !app.system)`;
- `systemApps = apps.filter(app => app.system)`;
- `uiRuntimeApps = runtimeApps.filter(app => getAppPageLinks(app).length > 0)`.

Shell sidebar rendering should show Host management navigation only when the active session user has role `host.admin`. The Apps section remains based on `uiRuntimeApps`.

Shell main-content routing guards management views with `canManageApps`. A non-administrator reaching `/`, `/dashboard`, or `/settings` — or the legacy `/installed-apps` and `/users` — is routed back to `/apps` and gets the app-navigation experience. See [Shell Navigation](../shell-navigation/feature.md) for the route table.

Dashboard accepts both runtime apps and system apps for administrator rendering, marking the latter with a `System` badge. Every action — settings, reviewed updates, lifecycle, backup, and remove — is gated on administrator permission alone; `app.system` no longer narrows eligibility. The fleet "Check updates" action triggers Core's sweep, which covers system apps on the same terms as runtime apps.

Dashboard renders one table for both, so its counts describe every row rather than a subset.

## Data Model / API Changes

`GET /api/apps` includes available `runtimeProfiles` so Shell can render runtime switching for normal runtime apps and system apps without loading each manifest separately.

No database or registry migration is required. Hosty Shell is already installed with `System: true` during Core bootstrap.

No change is required for User Management assignments because system apps are already filtered out of assignable app summaries.

## Edge Cases

- If Core bootstrap has not installed Hosty Shell, the System Apps section should render an empty or unavailable state without affecting normal app management.
- If a `host.user` has no visible runtime apps, Shell should show an Apps empty state rather than administrator management surfaces.
- If a user's role changes from `host.admin` to `host.user` during a session refresh, Shell should clear inaccessible management views.
- Future system apps inherit the same inspect/configure behavior without app-id-specific handling.
- If a system app does not expose `logs`, it should have no visible Shell actions.
- If a system app has only one runtime profile or Core cannot load its runtime profiles, Shell should render the selected runtime as read-only text.

## Testing Plan

- Unit or component-level checks for app grouping and action eligibility where practical.
- Shell build/lint validation after UI changes.
- Core tests are not expected to change unless API filtering behavior is modified.
- Manual integrated validation through Core-managed Shell:
  - administrator sees management navigation, runtime apps, and system apps;
  - ordinary user sees only runtime app navigation;
  - Hosty Shell does not appear in the sidebar Apps section;
  - system app start/stop/backup/remove actions are hidden while settings, logs, and reviewed updates remain available for administrators;
  - Hosty Shell runtime switching is visible when multiple runtime profiles are available.

## Rollout / Migration Notes

This is a Shell UI behavior change using existing Core data. Existing app registry records remain compatible.

The change tightens ordinary user access to Shell management views. Any workflow that expected `host.user` accounts to inspect Dashboard or Settings must move to administrator accounts.

## Decisions

- System Apps includes all apps with `system: true`, not only Hosty Shell.

- Core enforces the system-app boundary in identity flows, not only in Shell navigation: authorization codes, launch tokens, code exchange, and session revalidation are refused with `system_app_admin_required` when the target app record is `System` and the acting user is not an enabled `host.admin`. A role downgrade therefore revokes system-app access no later than the next revalidation.

- Core also enforces system-app removal server-side: the browser `POST /api/apps/{appId}/remove` endpoint refuses system apps with `system_app_remove_requires_control`, and browser installs cannot mint a system app from a request flag (system-ness comes from the reviewed manifest role). The local control plane (`hosty` CLI) keeps full removal for operator recovery.

- System app logs are available from the Dashboard table when the app exposes the `logs` capability.

- System app runtime switching is available to administrators when Core reports multiple runtime profiles, while other system app lifecycle actions remain hidden.

- Since 2026-07-13 system apps update through the ordinary reviewed update flow (update-status, plan, apply) instead of a boot-time reconcile; Core startup only installs missing distribution apps and migrates a moved http(s) manifest reference without applying content changes. See [On-Demand System App Updates](../ideas/system-app-updates.md).

- System app settings use the generic Core configure endpoint. This lets Marketplace own `HOSTY_MARKETPLACE_SOURCE_URL` as an app setting while Core remains unaware of its meaning.

- `host.user` uses Apps as the effective default view. The Shell also provides a `/apps` route that renders the same non-management app overview and is the fallback for unauthorized management routes.

## Links

- [System App Pages](../ideas/system-app-pages.md) - originating design for administrator navigation.
- [Marketplace System App](runtime-app-marketplace/feature.md) - first catalog UI using generic system-app navigation and settings.

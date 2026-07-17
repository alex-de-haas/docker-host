# Feature: Shell Access And System Apps

Created: 2026-06-04
Updated: 2026-07-13

## Goal

Hosty Shell should clearly separate administrator-only Host management from ordinary user app access. Administrators should be able to see system apps such as Hosty Shell in the installed-app inventory, while ordinary users should only see and open assigned non-system runtime apps.

## Non-goals

- Do not expose Host management pages to `host.user` accounts.
- Do not expose start/stop/restart/remove/backup controls for system apps in Shell. (Reviewed updates are the exception since 2026-07-13: system apps update through the same plan/apply flow as runtime apps — see [On-Demand System App Updates](../ideas/system-app-updates.md).)
- Do not show Hosty Shell as a normal app in the sidebar Apps navigation.
- Do not change the app assignment model to include system apps.
- Do not change CLI control behavior in this feature.

## Current Behavior

Core bootstraps Hosty Shell as a system runtime app with app id `hosty.shell`.

`GET /api/apps` already returns all apps to `host.admin` accounts and filters system apps out for `host.user` accounts. Shell groups non-system runtime apps and system apps separately for administrator views. The sidebar shows Dashboard, Installed Apps, and User Management only to administrators. The Apps navigation group is limited to non-system runtime apps with UI metadata; UI-capable system apps appear in a separate administrator-only System group that opens them through the canonical `/system-apps/<app-id>` route (Shell 0.26.0, see [System App Pages](../ideas/system-app-pages.md)).

Administrators can open settings for system apps through Installed Apps. This lets first-party apps such as Marketplace use ordinary manifest settings without receiving a privileged Core client.

## Access Rules

Shell should treat Host management views as administrator-only:

- `host.admin` can see Dashboard, Installed Apps, and User Management.
- `host.user` cannot see or navigate to Dashboard, Installed Apps, or User Management.
- `host.user` lands on the Apps view and only sees non-system runtime apps returned by Core and allowed by app assignments.
- If a non-admin reaches a management route or stale active view state, Shell redirects the view back to Apps.

Shell should keep the sidebar Apps section limited to non-system runtime apps with Shell UI metadata. Hosty Shell must not appear there as a normal app.

For administrators, Installed Apps should show both non-system runtime apps and system apps, but not as one flat list:

- Runtime Apps: normal installed runtime apps with the existing lifecycle, settings, backup, update, and remove actions.
- System Apps: system apps such as Hosty Shell.

Dashboard should continue to show Core status and runtime app summary metrics. Runtime app metrics should count non-system runtime apps only. System app inventory belongs on Installed Apps to avoid duplicating the same list across management surfaces.

System app actions should stay limited in Shell:

- logs are allowed when the app exposes the `logs` capability and the active user is `host.admin`;
- runtime switching is allowed for administrators when the app exposes more than one runtime profile;
- settings, public origins, external mounts, source override, and development-mode configuration are allowed for administrators through the ordinary app settings dialog;
- reviewed updates are allowed for administrators whenever the app does not run a live source runtime — the same eligibility as runtime apps, served by the same check/plan/apply flow. Updating is inherent to Core managing an app and is authorized on the endpoint, never by the manifest `capabilities` list;
- lifecycle controls such as start, stop, restart, autostart, backup, restore, and remove are hidden for all system apps.

## User/API Scenarios

- A `host.admin` opens Shell and sees Dashboard, Installed Apps, User Management, and normal runtime app navigation.
- A `host.admin` opens Installed Apps and sees normal runtime apps in Runtime Apps plus Hosty Shell in System Apps.
- A `host.admin` can open logs for Hosty Shell when logs are available.
- A `host.admin` can switch Hosty Shell between available runtime profiles from the System Apps runtime column.
- A `host.admin` can configure a system app's manifest settings, including Marketplace's catalog source URL.
- A `host.admin` can check for and apply a reviewed update to a system app, including Hosty Shell itself (the page reloads after a successful Shell self-update).
- A `host.admin` cannot stop, restart, back up, or remove Hosty Shell from Shell UI.
- A `host.user` opens Shell and sees only the Apps navigation for assigned or unrestricted non-system runtime apps.
- A `host.user` does not see Dashboard, Installed Apps, User Management, or any system app.

## Technical Design

Shell should derive these app groups from the `system` flag already returned by Core:

- `runtimeApps = apps.filter(app => !app.system)`;
- `systemApps = apps.filter(app => app.system)`;
- `uiRuntimeApps = runtimeApps.filter(app => getAppPageLinks(app).length > 0)`.

Shell sidebar rendering should show Host management navigation only when the active session user has role `host.admin`. The Apps section remains based on `uiRuntimeApps`.

Shell main-content routing should guard management views with `canManageApps`. If the active user is not an administrator and reaches `/`, `/dashboard`, `/installed-apps`, or `/users`, Shell should route the user back to `/apps` and render the app-navigation experience rather than Dashboard or Installed Apps.

Installed Apps accepts both runtime apps and system apps for administrator rendering. It renders separate sections and passes `app.system` into action eligibility. Settings and reviewed updates use administrator permission for both groups; lifecycle, backup, and remove eligibility additionally require a non-system app. The fleet "Check updates" action triggers Core's sweep, which covers system apps on the same terms as runtime apps.

Dashboard should receive runtime app groups for summary metrics. System app rendering stays inside the Installed Apps System Apps section.

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

The change tightens ordinary user access to Shell management views. Any workflow that expected `host.user` accounts to inspect Dashboard or Installed Apps must move to administrator accounts.

## Decisions

- System Apps includes all apps with `system: true`, not only Hosty Shell.

- Core enforces the system-app boundary in identity flows, not only in Shell navigation: authorization codes, launch tokens, code exchange, and session revalidation are refused with `system_app_admin_required` when the target app record is `System` and the acting user is not an enabled `host.admin`. A role downgrade therefore revokes system-app access no later than the next revalidation.

- Core also enforces system-app removal server-side: the browser `POST /api/apps/{appId}/remove` endpoint refuses system apps with `system_app_remove_requires_control`, and browser installs cannot mint a system app from a request flag (system-ness comes from the reviewed manifest role). The local control plane (`hosty` CLI) keeps full removal for operator recovery.

- System app logs are available from the Installed Apps System Apps section when the app exposes the `logs` capability.

- System app runtime switching is available to administrators when Core reports multiple runtime profiles, while other system app lifecycle actions remain hidden.

- Since 2026-07-13 system apps update through the ordinary reviewed update flow (update-status, plan, apply) instead of a boot-time reconcile; Core startup only installs missing distribution apps and migrates a moved http(s) manifest reference without applying content changes. See [On-Demand System App Updates](../ideas/system-app-updates.md).

- System app settings use the generic Core configure endpoint. This lets Marketplace own `HOSTY_MARKETPLACE_SOURCE_URL` as an app setting while Core remains unaware of its meaning.

- `host.user` uses Apps as the effective default view. The Shell also provides a `/apps` route that renders the same non-management app overview and is the fallback for unauthorized management routes.

## Links

- [System App Pages](../ideas/system-app-pages.md) - originating design for administrator navigation.
- [Marketplace System App](runtime-app-marketplace.md) - first catalog UI using generic system-app navigation and settings.

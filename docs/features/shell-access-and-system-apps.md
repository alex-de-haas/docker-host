# Feature: Shell Access And System Apps

Status: Implemented.

## Goal

Hosty Shell should clearly separate administrator-only Host management from ordinary user app access. Administrators should be able to see system apps such as Hosty Shell in the installed-app inventory, while ordinary users should only see and open assigned non-system runtime apps.

## Non-goals

- Do not expose Host management pages to `host.user` accounts.
- Do not add lifecycle controls for Hosty Shell or other system apps.
- Do not show Hosty Shell as a normal app in the sidebar Apps navigation.
- Do not change the app assignment model to include system apps.
- Do not change CLI control behavior in this feature.

## Current Behavior

Core bootstraps Hosty Shell as a system runtime app with app id `hosty.shell`.

`GET /api/apps` already returns all apps to `host.admin` accounts and filters system apps out for `host.user` accounts. Shell groups non-system runtime apps and system apps separately for administrator views. The sidebar shows Dashboard, Installed Apps, and User Management only to administrators, and app navigation entries are limited to non-system runtime apps with UI metadata.

The Installed Apps row-level action restrictions are currently based on the active Shell app id for some controls rather than the generic `system` flag.

## Proposed Behavior

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
- lifecycle controls such as start, stop, restart, update, configure, autostart, backup, restore, and remove are hidden for all system apps.

## User/API Scenarios

- A `host.admin` opens Shell and sees Dashboard, Installed Apps, User Management, and normal runtime app navigation.
- A `host.admin` opens Installed Apps and sees normal runtime apps in Runtime Apps plus Hosty Shell in System Apps.
- A `host.admin` can open logs for Hosty Shell when logs are available.
- A `host.admin` can switch Hosty Shell between available runtime profiles from the System Apps runtime column.
- A `host.admin` cannot stop, restart, update, configure, back up, or remove Hosty Shell from Shell UI.
- A `host.user` opens Shell and sees only the Apps navigation for assigned or unrestricted non-system runtime apps.
- A `host.user` does not see Dashboard, Installed Apps, User Management, or any system app.

## Technical Design

Shell should derive these app groups from the `system` flag already returned by Core:

- `runtimeApps = apps.filter(app => !app.system)`;
- `systemApps = apps.filter(app => app.system)`;
- `uiRuntimeApps = runtimeApps.filter(app => getAppPageLinks(app).length > 0)`.

Shell sidebar rendering should show Host management navigation only when the active session user has role `host.admin`. The Apps section remains based on `uiRuntimeApps`.

Shell main-content routing should guard management views with `canManageApps`. If the active user is not an administrator and reaches `/`, `/dashboard`, `/installed-apps`, or `/users`, Shell should route the user back to `/apps` and render the app-navigation experience rather than Dashboard or Installed Apps.

Installed Apps should accept both runtime apps and system apps for administrator rendering. It should render separate sections and pass `app.system` into action eligibility. Existing Shell-specific checks can remain for self-navigation, but lifecycle action eligibility should use the system flag.

Dashboard should receive runtime app groups for summary metrics. System app rendering stays inside the Installed Apps System Apps section.

## Data Model / API Changes

`GET /api/apps` includes available `runtimeProfiles` so Shell can render runtime switching for normal runtime apps and system apps without loading each manifest separately.

No database or registry migration is required. Hosty Shell is already installed with `System: true` during Core bootstrap.

No change is required for User Management assignments because system apps are already filtered out of assignable app summaries.

## Edge Cases

- If Core bootstrap has not installed Hosty Shell, the System Apps section should render an empty or unavailable state without affecting normal app management.
- If a `host.user` has no visible runtime apps, Shell should show an Apps empty state rather than administrator management surfaces.
- If a user's role changes from `host.admin` to `host.user` during a session refresh, Shell should clear inaccessible management views.
- If future system apps are added, they should inherit the same inspect-only Shell behavior without app-id-specific handling.
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
  - system app lifecycle actions are hidden and logs remain available for administrators;
  - Hosty Shell runtime switching is visible when multiple runtime profiles are available.

## Rollout / Migration Notes

This is a Shell UI behavior change using existing Core data. Existing app registry records remain compatible.

The change tightens ordinary user access to Shell management views. Any workflow that expected `host.user` accounts to inspect Dashboard or Installed Apps must move to administrator accounts.

## Decisions

- System Apps includes all apps with `system: true`, not only Hosty Shell.

- System app logs are available from the Installed Apps System Apps section when the app exposes the `logs` capability.

- System app runtime switching is available to administrators when Core reports multiple runtime profiles, while other system app lifecycle actions remain hidden.

- `host.user` uses Apps as the effective default view. The Shell also provides a `/apps` route that renders the same non-management app overview and is the fallback for unauthorized management routes.

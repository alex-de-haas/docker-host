# Shell Access And System Apps

Created: 2026-06-04
Updated: 2026-10-01

## Access Model

Core applies the same assignments to system and ordinary apps. Enabled administrators have implicit
access to every installed app; other enabled users need an explicit assignment. System apps appear
in the user-management assignment picker. An unassigned app is unavailable to ordinary users, not
public. Removing an assignment denies new codes and subsequent app-session revalidation.

App access and administrative authority are separate. Core management endpoints check the user's
role as well as the calling app's current grants. A user assigned to Shell does not gain its
administrative powers. Per-user management permission sets are outside the current role model.
Shell's transition to this app-bound transport is tracked in
[local browser origins](../local-browser-origins/plan.md).

Standalone applications use Core login and return to their own registered origin; Shell is not
required. Core checks the redirect against the requested app, not every app on the host.

## Shell Navigation And Management

`GET /api/apps` returns all apps to administrators and only assigned apps to other users. The Apps
group contains the UI-capable apps returned by Core, including assigned system apps, with system
badges. Shell excludes itself from the embedded app navigation. A stopped app remains visible with
its runtime state.

Dashboard and host management actions require an administrator. Ordinary users see their available
apps and personal settings. Core rejects unauthorized administrative requests independently of
whether Shell hides a button. Role changes clear inaccessible management views on refresh.

Administrators manage ordinary and system apps through the same lifecycle, settings, logs, backup,
reviewed-update and removal flows. The system marker gives no lifecycle immunity; operation-specific
preconditions and confirmation still apply. Removing Shell has a Core/CLI recovery path.

## Testing Expectations

- Listings, assets, authorization codes, code exchange and revalidation enforce the same assignments.
- An assigned ordinary user can enter a system app; an unassigned user cannot.
- App grants do not allow an ordinary user to execute administrator-only Core operations.
- Assignment removal and role changes affect subsequent identity and management requests.
- Standalone password login works without Shell access and returns only to the requested app.
- Shell navigation and action visibility follow the resolved user role; Core remains authoritative.

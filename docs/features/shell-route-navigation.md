# Feature: Shell Route Navigation

## Goal

Make Hosty Shell navigation addressable and refresh-safe. Users should be able to switch between Shell sections, refresh the browser, copy URLs, and return to the same Shell section or embedded app workspace.

## Non-goals

- Do not expose administrator views to `host.user` accounts.
- Do not persist one-time app authorization codes in Shell URLs.
- Do not proxy runtime app HTML through Shell.
- Do not add route-backed state for transient modals such as install review, logs, backups, or configuration dialogs in this change.

## Current Behavior

Shell renders a persistent sidebar but stores the selected management view and embedded workspace only in React state. The `/` route defaults to Dashboard, and `/apps` starts on the app overview. Installed Apps, User Management, and embedded app workspaces are not encoded in the browser URL. Refreshing the page clears the in-memory state and returns users to the route default.

## Proposed Behavior

Shell should use route and query state as the source of truth for top-level navigation:

- `/` and `/dashboard` render Dashboard for administrators.
- `/apps` renders the non-management app overview.
- `/installed-apps` renders Installed Apps for administrators.
- `/users` renders User Management for administrators.
- `/workspace?app=<app-id>&path=<app-path>` renders an embedded runtime app workspace.

Sidebar clicks update the browser URL. Browser refresh restores the selected view. Workspace URLs store only the app id and manifest/app path; on load Shell asks Core for a fresh embedded launch code before loading the iframe.

Unauthorized management routes must fall back to `/apps` for non-admin sessions.

## User/API Scenarios

- An administrator opens `/installed-apps`, refreshes, and remains on Installed Apps.
- An administrator opens `/users`, refreshes, and remains on User Management.
- A normal user opens `/users` and is redirected to `/apps`.
- A user opens Demo App from the sidebar and Shell navigates to `/workspace?app=com.haas.demo-app&path=/`.
- A user refreshes a workspace URL and Shell reissues a Core launch code, then reloads the app iframe.
- A standalone app link still uses Core's `/api/apps/{appId}/open?redirectUri=...` redirect endpoint.

## Technical Design

Shell derives top-level route state from `usePathname()` and `useSearchParams()` in the client component. Route state maps to the same Shell views already used by the main content renderer.

Navigation helpers build stable Shell URLs:

- Shell management routes are path-only routes.
- Workspace routes use query parameters so app ids and app paths do not collide with Shell-owned path segments.

Workspace restoration flow:

1. Shell loads Core status, session, and app registry.
2. If the route is `/workspace`, Shell finds the target app and manifest navigation page.
3. For a new app workspace, Shell requests `/api/apps/{appId}/launch-code` with CSRF and the selected app redirect URI.
4. Shell stores the returned redirect URI only in memory and renders the iframe.
5. Page switches inside the same already-open app can reuse the app's direct URL because the app-origin session cookie already exists.

## Data Model / API Changes

No Core API or persistence changes are required. The existing browser endpoints are reused:

- `GET /api/auth/session`
- `GET /api/apps`
- `POST /api/apps/{appId}/launch-code`
- `GET /api/apps/{appId}/open?redirectUri=...`

## Edge Cases

- Missing `app` query value on `/workspace` should fall back to Apps.
- Unknown app id should show a Shell error and avoid loading an iframe.
- Stopped apps should show the existing "App must be running" error.
- Unknown app path may still load when Shell can derive the app URL from the app UI endpoint. If no app UI endpoint is available, Shell should show an error and avoid loading an iframe.
- Non-admin sessions should not stay on administrator-only routes.
- Theme changes should continue to post theme messages to the iframe without requiring URL changes.

## Testing Plan

- Build Shell with `npm run shell:build`.
- Validate local route rendering for `/`, `/dashboard`, `/apps`, `/installed-apps`, `/users`, and `/workspace?...` where a running app is available.
- Validate that sidebar clicks update the URL.
- Validate that refreshing a management route preserves the rendered section.
- Validate that refreshing a workspace route reopens the app through a fresh launch code.
- Regression check that standalone app links still open through Core.

## Rollout / Migration Notes

The root `/` route remains compatible and still renders Dashboard for administrators. `/apps` remains compatible as the ordinary app overview route. Newly added routes are additive and do not require Core migration.

## Decision

Modal-level state such as app logs, backups, install review, and settings is not addressable in this feature. Top-level navigation and workspace deep links fix the refresh and copy-link problem without expanding modal lifecycle complexity.

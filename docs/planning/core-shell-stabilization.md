# Core Shell Stabilization

## Description

Core Shell Stabilization is the active implementation plan for the current architecture branch. The goal is to make the local Core and Shell development loop reliable, restore the Core-owned management workflows in the new Shell, and keep old lifecycle and user-management capabilities available while the final Core/Shell split matures.

Update channels, runtime app channel switching, and Agent Bridge remain valid architecture concepts, but they are deferred for this branch. Current stabilization work should preserve narrow extension points where they already exist, without adding channel generation, pull request channels, or agent-editable app flows.

The active priority order is:

1. Stabilize local Core/Shell development and documentation.
2. Restore Shell lifecycle management UI for system and runtime apps.
3. Simplify install and update review screens.
4. Stabilize Core/Shell authentication and app launch flows.
5. Restore user management in Shell.
6. Add backup management controls after Shell and auth are usable.
7. Defer channels and Agent Bridge to separate future feature branches.

```mermaid
flowchart LR
  A["Local Core/Shell dev loop"] --> B["Shell lifecycle UI"]
  B --> C["Simple install/update review"]
  C --> D["Core/Shell auth"]
  D --> E["User management"]
  E --> F["Backup management"]
  F --> G["Deferred channels and agents"]
```

## Milestones

### Phase 1 - Stabilize local Core and Shell development

**Status**: Completed

- Make `npm run core:dev` start Core in the development environment.
- Allow the default local Shell origin `http://127.0.0.1:3000` in Core CORS during development.
- Keep `HOST_SHELL_PUBLIC_ORIGIN` as the explicit override for non-default Shell origins.
- Document the split-process workflow: Core on `http://127.0.0.1:3001`, Shell on `http://127.0.0.1:3000`.
- Validate `/api/core/status`, `/api/apps`, Shell session loading, and the Core login link in the browser.

Completed browser smoke on 2026-06-03:

- Core dev starts through `npm run core:dev` with `Development` hosting and listens on `http://127.0.0.1:3001`.
- Core status reports the default local Shell origin and honors `HOST_SHELL_PUBLIC_ORIGIN` for an alternate Shell origin.
- Shell loads Core status and unauthenticated session state without calling `/api/apps` before a Core session exists.
- Core exposes a development-only `/login` form that creates a normal Core session cookie for existing enabled local users and redirects back to Shell.
- Authenticated Shell loading calls `/api/apps`, shows the active `host.admin` session, and renders the Core-managed `hosty.shell` system app.
- Shell Next.js development config allows loopback dev resources for `127.0.0.1` and `localhost`, so browser hydration works on the loopback host required by Core cookies.

Notes:

- Browser credentialed auth must keep Core and Shell on the same loopback host in local HTTP development. `localhost` Shell with `127.0.0.1` Core can validate CORS/status, but the Core `SameSite=Lax` session cookie is not sent on cross-site browser fetches.
- The development login helper is local development plumbing only. Production authentication remains Core-owned and belongs to Phase 4.

### Phase 2 - Restore Shell lifecycle management

**Status**: In Progress

- Show system apps and runtime apps with current runtime state, operation status, selected runtime, version, and last error.
- Add Shell actions for start, stop, restart, open, update, logs, backup, restore, configure, and remove where each action is allowed.
- Hide self-stop and remove actions for the active `hosty.shell` app.
- Keep legacy module and app-native runtime app management flows covered by the new Shell UI.
- Test old CLI/control lifecycle flows against the new Shell-visible app state.

Implemented so far:

- Core exposes public browser lifecycle endpoints for Shell under `/api/apps/{appId}/start`, `/api/apps/{appId}/stop`, `/api/apps/{appId}/restart`, `/api/apps/{appId}/logs`, and `/api/apps/{appId}/backups`.
- Core `/api/apps` now requires an active Core session and filters system/runtime app summaries by role and app assignment.
- Public browser lifecycle mutations require an active Core session, `host.admin`, and a matching `X-Hosty-CSRF` token.
- Shell app cards can start, stop, restart, open, and create manual backups for manageable runtime apps.
- Shell hides lifecycle mutation controls for the active `hosty.shell` app while Core control APIs can still manage Shell from CLI/local control.

Remaining:

- Add Shell update, configure, restore, remove, log viewing, and backup list/restore/delete views.
- Add focused browser smoke coverage for Shell lifecycle controls against Core public APIs.

### Phase 3 - Simplify install and update review

**Status**: Not Started

- Replace highly technical install/update plan views with a concise review surface.
- Show the app/package identity, current digest, target digest, selected runtime, version change, and primary action.
- Show a settings form only when the target app declares settings, with defaults pre-filled.
- Hide storage mappings, mount details, dependency internals, and endpoint internals unless the target app declares user-configurable storage or a real conflict needs attention.
- Preserve technical details behind diagnostics or an expandable advanced section for administrators.

### Phase 4 - Stabilize Core/Shell authentication

**Status**: Not Started

- Keep Core-owned auth pages and sessions.
- Ensure split-origin Shell-to-Core requests work with credentials, CSRF expectations, and CORS configuration.
- Make Shell display active session state and redirect to Core login/logout flows cleanly.
- Validate app-scoped identity, Shell launch links, and standalone open links with existing Host users.
- Keep runtime apps from receiving Hosty browser cookies directly.

### Phase 5 - Restore user management in Shell

**Status**: Not Started

- Rebuild the user list, invitations, role changes, disabled-user state, account switching entry points, and app access assignments in Shell.
- Keep Core authoritative for all user mutations and audit records.
- Preserve existing user-management behavior while removing legacy UI coupling to the old combined Host app.
- Test administrator and non-administrator access boundaries.

### Phase 6 - Add backup management controls

**Status**: Not Started

- Add Shell views for backup lists, manual backup creation, restore, and deletion.
- Show retention behavior plainly: manual backups are explicit, pre-update backups are automatic, and scheduled retention remains deferred unless implemented.
- Keep destructive backup actions behind confirmation.
- Add CLI parity only where Core APIs already exist or where local recovery needs it.

### Phase 7 - Keep channels and Agent Bridge deferred

**Status**: Deferred

- Do not implement channel generation, product channel publishing, runtime channel UI, switch-channel UI, pull request channels, or Agent Bridge in this branch.
- Keep existing channel-related Core/CLI code as a narrow compatibility/architecture placeholder.
- Revisit channels only after Core/Shell management, auth, users, and backups are stable.
- Revisit Agent Bridge only after repository-backed source workflows and pull request validation are ready.

## Open Questions And Answers

- Question: Should channels be removed from the architecture?
  Answer: No. They remain useful for future release validation and pull request validation, but they are not part of the current stabilization implementation.
  Recommendation: Keep the existing contracts documented and avoid building UI or generation workflows until the main Core/Shell experience is stable.

- Question: Should Shell expose all technical install/update details by default?
  Answer: No. Most users need package identity, version/digest changes, settings, and a clear install/update action.
  Recommendation: Keep technical details available through diagnostics or an advanced section, not in the primary path.

- Question: What old behavior must be protected while rebuilding Shell?
  Answer: Lifecycle operations, user management, app access assignment, identity/open helpers, legacy module compatibility, runtime apps, and backups.
  Recommendation: Add a smoke checklist for old CLI/control flows before each major Shell UI milestone.

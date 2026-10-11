---
created: 2026-10-02
updated: 2026-10-11
summary: Legacy activity-window compatibility and current continuous authority for privileged app operations and assistant conversations.
components: [apps/core, apps/harness, apps/shell, packages/app-sdk]
---

# App Activity Window

[Continuous App Access](../continuous-app-access/feature.md) governs current browser/native app
sessions. A live authorizing principal and current user/app permissions allow already-approved
operations without a separate hourly deadline. Silent embedded sign-in establishes this authority.
App service credentials and diagnostic grants cannot establish interactive authority by themselves.

## Browser-established activity

`ActiveUntil` and the SDK activity helpers remain for mixed-version compatibility. Legacy grants
retain their recorded deadline; `reauth_required` preserves their identity and requests normal
recovery. Live grants with verified parent provenance migrate to continuity on revalidation,
clearing `ActiveUntil`. Expired identity and grants without provenance cannot gain authority by
migration. Core retains `HOSTY_AUTH_APP_ACTIVITY_HOURS` as legacy configuration and reports its
value in migration diagnostics, without exposing an hourly control in active settings.

The SDK respects actual `activeUntil`/`activityRequired` from older Core versions. Its legacy click
renewal opens the existing Core popup and preserves mounted state. Supported continuous sessions
return `activityRequired: false`; their silent coordinator checks identity and maintains the parent
through a Core-owned browser frame. Actual expiry/revocation still requires normal recovery.

Native Shell negotiates `sessionContinuityVersion`. Current Core accepts its live unscoped device
principal for app launch/renewal. An older Core keeps the fresh same-account confirmation sheet.
Device credentials never enter an app frame.

## Recovery without losing work

`HostyOverlay` keeps protected components mounted but hidden/inert while recovery is required.
Same-user recovery restores them. A changed actor clears old protected state before requests resume.
Network failure does not discard credentials or open a consent loop. Apps may opt into a separate
local/public content slot. Core-review controls remain independent of session maintenance.

Shell's explicit `/api/auth/renew` endpoint updates its HttpOnly cookie after validating request
origin, JSON, private proof and app audience. It never returns the Shell credential to browser
JavaScript. Explicit recovery emits `APP_ACTIVITY_RENEWED` to reconnect/resynchronize consumers;
silent continuity emits its own notification without repeating domain operations.

## Assistant activity authorization

Harness conversations share the app's current authority. Session IDs identify context and ownership;
they create no permission and need no per-chat consent. MCP issuance/introspection and workspace or
publication operations validate current user, installation, authorizing principal and reviewed
assistant-target permissions. Native Normal/Autonomous modes are independent of Core authority.

The Harness session probe and credential-refresh endpoint update every live conversation owned by
the authenticated actor, including an existing run. They preserve messages and drafts and never
start another run. Unrelated actors' conversations are untouched. Explicit background MCP grants
use the separately reviewed scope contract in Continuous App Access; they are not inferred from a chat.

Retired assistant-session review endpoints and lease files confer no authority. Existing execution
workspaces retain their own operation and ownership checks.

## Testing Expectations

- Current sessions survive the former hourly activity deadline but stop at principal revocation/expiry.
- Missing continuity on an old Core retains the actual legacy activity behavior.
- Recovery preserves same-user drafts, clears another actor's state and never replays an ambiguous write.
- Diagnostic/service credentials cannot substitute for interactive or explicit background authority.
- Provider/MCP children validate current source authority, target installation and grants.
- Harness refreshes all live conversations of the authenticated actor without new messages or runs.

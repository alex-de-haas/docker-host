# App Permission Management

Created: 2026-09-30
Updated: 2026-09-30

Administrators manage an installed app's permission declarations and optional choices from the
Permissions tab in its existing settings panel. The tab remains accessible for empty and legacy
installations. It distinguishes effective access from accepted declarations and the currently
observed manifest, with descriptions, technical identifiers, additions, removals and transitions.
Required access is not an optional toggle. Optional switches stage draft choices until Core confirms them;
new optional declarations default off, and unchanged accepted choices retain their granted value.

## Observation

Core observes installed apps sequentially every five seconds, using the local manifest parser's
file-stamp cache. Dashboard reads cached structured `permissionState` rather than parsing manifests
for each list request. A source/installation/permission identity mismatch suppresses old observations.
`GET /api/apps/{id}/permissions` requires an administrator and explicitly refreshes observation.
Changed observations publish `app.changed` events.

Development profiles use the effective local override, materialized source checkout or original
local install source. Locked profiles use the installed manifest; remote newer releases remain an
update-review concern. Missing or invalid sources retain grants and last verified information and
report unknown/stale state. Reads never adopt manifest fields or change grants.

Missing required access produces the actionable red "Required permissions need approval" problem,
which opens Permissions and contributes to Dashboard's attention count. Runtime/health remain
independent: a running process can still lack access for particular operations. Disabled optional
permissions and declaration-only changes do not produce a red problem. Unconfirmed provider roles
are listed separately and require the existing app update review.

## Confirmation

The existing installation transport accepts `permissionsAppId`. A delegated app can target only
itself; the administrator Shell transport can target any installed app. Core loads the candidate and
binds its review to installation time, permission revision, source/runtime identity and manifest digest.
Preparation and application bypass the parser cache when verifying the complete digest.

The submit request optionally carries `optionalPermissions` as draft selections. The isolated Core
page displays required permissions, optional choices, transitions and removals. Only its authenticated
administrator decision with a session-bound single-use nonce authorizes changes. Apply rechecks the
candidate under the app operation lock and rejects stale reviews.

Accepted required/optional declarations, effective grants and a new permission revision are persisted
together. No install, build, restart, unrelated manifest adoption or provider-role approval occurs.
Existing provider token/introspection and queued-update revision checks enforce revocation and stale
update rejection. Legacy null declarations use effective grants as their baseline; observation alone
never grants or revokes access.

Shell polls pending/executing reviews, reports cancellation/failure, preserves drafts on failure and
refreshes permission state and app summaries on success. Closing the confirmation window alone is
not success. Updated grants drive the existing embedded-app iframe policy. Harness uses Core's
`reviewAvailable` capability for accurate dictation guidance, including legacy installations.

## Testing Expectations

- Observe live edits without restart; retain installed-release behavior and recover from invalid sources.
- Cover legacy declarations, additions, removals, required/optional transitions and optional revocation.
- Reject stale installation, source, runtime, revision and full manifest changes, including unchanged
  file stamps; reject replay, foreign callers and non-administrator browser access.
- Assert permission-only application preserves all unrelated app state and does not run lifecycle work.
- Verify Dashboard severity/action/count semantics and Shell drafts, empty/unavailable states,
  cancellation, stale preparation, successful confirmation and refresh.
- Exercise Core-managed browser navigation, isolated confirmation, iframe policy changes and narrow
  layouts; do not infer runtime acceptance from a successful build alone.

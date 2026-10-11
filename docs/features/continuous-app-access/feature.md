---
created: 2026-10-11
updated: 2026-10-11
summary: Silent maintenance of browser and native app sessions, with separately authorized and revocable background delegation.
components: [apps/core, apps/cli, packages/app-sdk, packages/app-sdk-dotnet, apps/shell, apps/shell-swift, apps/harness, apps/plans]
---

# Continuous App Access

Core 0.130.0 and SDK 0.26.0 remove the independent hourly activity deadline from app sessions
with a live authorizing browser or native principal. Opening an app silently under an existing
Core sign-in enables its already-granted operations. User/app permissions, assignments, installation
identity, account authorization revision, logout and the principal's expiry remain authoritative.
Neither being first-party nor the manifest's `system` flag changes this lifetime policy.

## Interactive authority

An opaque app grant records `AuthorityVersion: 1`, installation identity and its authorizing
session. Browser grants expire no later than the parent's absolute deadline. Native grants bind an
unscoped device/manual or primary session; a native principal without an absolute deadline uses
the common app maximum. All continuous grants use the common app idle timeout. Revalidation checks
both the grant and its live principal, without touching the principal.

`GET /api/auth/apps/protocol` advertises `sessionContinuityVersion: 1`. App revalidation includes:

```json
{
  "activityRequired": false,
  "activeUntil": null,
  "continuity": {
    "version": 1,
    "mode": "browser",
    "grantId": "public-reference",
    "expiresAt": "2026-11-10T12:00:00Z",
    "checkAfterSeconds": 300
  }
}
```

`mode` is `browser` or `native`. The grant ID is a public reference, not a credential. Diagnostic
CLI grants remain finite and cannot establish privileged interactive authority. A backend with an
app service credential and user app grant cannot keep the parent browser session alive.

## Browser maintenance

The SDK owns one coordinator per document. It checks on mount, at a five-minute interval with
jitter, on focus/visibility/online return and before a protected request when validation is older
than 30 seconds. Concurrent checks coalesce; a burst of wake events schedules one next timer.
Timers are advisory; the server decides validity.

For browser sessions, a transient Core-owned iframe uses
`GET /api/auth/apps/continuity/frame?grantId=…&origin=…&state=…`. Core validates the installed app
origin, isolated Core cookie host and correlation input. The frame performs a same-origin
`POST /api/auth/apps/continuity/maintain` with Core's primary cookie, exact Origin and CSRF proof.
The request must match the grant's authorizing browser session and actor. Validation precedes a
throttled idle touch; it never changes absolute expiry or revives expired authority.

The frame returns only correlated status. No cookie, token or keepalive proof reaches the app or
Shell. Source/origin/state checks and a four-second timeout bound the exchange. Cookie or framing
restrictions leave the existing grant usable for the parent's remaining lifetime. The app's
same-origin identity probe confirms actual access; unavailable frame transport is not logout.

Network failure retains credentials and mounted state, prevents protected dispatch and retries
with bounded backoff. `HostyOverlay localContent={…}` explicitly exposes app-owned local/public
content during an outage, outside the hidden protected root, including when identity is cached but
required setup cannot be checked. Protected dispatch remains suspended in that case. Local content
must not contain another user's private content. Real expiry/revocation uses ordinary recovery. Same-user recovery preserves
state; a changed actor clears protected state before pending operations can resume.

Silent success emits `APP_CONTINUITY_UPDATED`, not `APP_ACTIVITY_RENEWED`; it does not recreate
conversations, replay handoffs/messages or change panel generations. Harness's session probe and
credential-refresh endpoint update all live conversations owned by that actor. Native Shell uses
its existing device credential when Core advertises continuity, and retains the older confirmation
flow for an older Core. Failed capability discovery remains retryable and does not open the legacy
password sheet; only a successful legacy capability result chooses that path. Native credentials
never enter app JavaScript.

## Explicit background delegation

Core's `/account/tokens` page provides **Background app access**: create, list and revoke grants,
with optional expiry or an explicit until-revoked choice. Creation requires the administrator's
isolated Core browser session, exact Origin and CSRF proof; app credentials cannot create authority.
Ordinary logout ends interactive descendants but preserves deliberately authorized background work.
**Revoke all my authorizations** revokes sessions, OAuth grants and background grants and changes the
account authorization revision. It also closes that user's already-open Core event streams across
browser, device, manual and OAuth sessions. Other users' streams stay open. Disabled/removed accounts
and changed revisions stop dispatch too.

Records in `core/auth/background-grants.json` pin the owner, consuming installation, label,
immutable scopes, creation time, optional expiry and revocation. Changes use revoke-and-create.
Every issuance and dispatch rechecks current permissions, roles and target/consumer installations.
Updates cannot enlarge saved scopes. Background access is currently administrator-owned; it does
not change ordinary-user Harness access.

| Scope kind | Enforced boundary |
| --- | --- |
| `core` | Explicit target app and closed action names: `health`, `update-status`, `update-plan`, `update`, `start`, `stop`, `restart`; exact method/route and current operation permission |
| `provider` | Exact provider kind (`assistant` or `speech-to-text`), interface key and target installation |
| `mcp` | Reviewed assistant-to-target link and exact tool names, without wildcards; Core tools also require the corresponding app permission |

MCP scopes cover each tool's argument domain at that target. They are not a filesystem/workspace
sandbox. Introspection without a tool yields catalog/read scope only; execution checks the raw,
exact tool name. Generic APIs, identity revalidation, fleet discovery and authority-creation routes
refuse background credentials. Existing update permission-review restrictions still apply.

The app backend calls `POST /api/internal/apps/{appId}/background/token` with its service bearer
and `{ grantId, scopeId }`. The ID alone grants nothing. Core issues an opaque five-minute credential,
clamped to the delegation expiry, and persists its source/scope binding. Existing provider/MCP child
credentials reference this source and check it online on use. Revocation stops new dispatch, but
cannot undo completed work or stop an unrestricted OS process.

Grant creation, credential issuance, dispatch and revocation are audited without secrets. Browser
heartbeats are not audit events. Scheduling and job retry policy belong to
[AI Agent Bridge](../ai-agent-bridge/plan.md); no scheduler or automatic updater is part of this feature.

### Control and SDK clients

The local control equivalents are `GET/POST /control/v1/auth/background-grants?user=<owner-id>`
and `DELETE /control/v1/auth/background-grants/{id}?user=<owner-id>`. Creation also resolves an
existing owner's email. CLI commands work without Shell:

```sh
hosty --data-root <instance> auth background create <owner-id> grant.json
hosty --data-root <instance> auth background list <owner-id>
hosty --data-root <instance> auth background revoke <owner-id> <grant-id>
```

Example request file:

```json
{
  "appId": "example.worker",
  "label": "Check selected app health",
  "scopes": [{ "id": "health", "kind": "core", "targetAppId": "example.target", "actions": ["health"] }]
}
```

`BackgroundGrantClient` from `@hosty-sdk/app/background/server` and .NET's
`HostyBackgroundClient` take the public grant/scope references and the app service configuration.
They coalesce short-credential acquisition and refresh before expiry. Core operations are sent
once; clients never replay an ambiguous mutation. For .NET, supply an HttpClient with automatic
redirects disabled. Provider/MCP clients accept the acquired token through their existing user-token
parameter. Credentials stay on the server; Core checks live scope on dispatch even when a client
reuses a cached request credential.

## Migration and compatibility

Deploy Core before the SDK/app releases. New clients retain an older Core's actual activity policy
when continuity metadata is missing. New Core returns `activityRequired: false` and null activity
for migrated grants, which also prevents old consumers from enforcing an obsolete hourly deadline.
The protocol version for app sign-in remains 2; continuity is a separate capability.

Live legacy code grants migrate on revalidation only with verifiable, live parent provenance and
valid original identity, installation and authorization revision. An elapsed activity deadline alone
does not block migration. The durable upgrade clears activity and records the parent deadline under
the grant-store lock; concurrent revocation wins. Expired identity never revives, and legacy grants
without provenance remain legacy/diagnostic rather than gaining authority. No background grant is
inferred or migrated from a browser session.

Core preserves operator lifetime overrides. The hourly activity setting is omitted from active
settings. `authenticationDiagnostics` reports retained activity, system and common app values and
the applied policy; Shell's policy settings and `hosty core settings list` display these messages.
System grant settings remain labeled legacy. Browser-session defaults remain 7 idle / 30 absolute
days; the feature does not make the primary session permanent. Closed tabs cease browser maintenance;
background services need explicit delegation to work independently of interactive sessions.

## Testing Expectations

- Clock-controlled Core tests cross the former hour, separate child use from browser-parent idle
  maintenance, reject absent/wrong cookie/CSRF proof, and enforce parent/device expiry and revocation.
- Test durable legacy migration, elapsed activity versus expired identity, custom retained settings,
  missing provenance, account changes, installations and permissions.
- Test Core/provider/MCP background scope after ordinary logout, exact tool names, catalog-only
  access, permission/installation/revision changes, optional expiry and live revocation.
- SDK tests cover correlated/coalesced maintenance, blocked frames, outage/backoff/network return,
  local-content boundaries, same/different actor recovery and no ambiguous mutation replay.
- Harness tests refresh all live conversations for one actor without starting a run or touching
  another actor. Native capability tests cover new Core and missing capability; compile the app.
- Real browser acceptance uses normal password login and Core-managed apps on an isolated instance,
  in Shell and standalone. Preserve document/draft through maintenance, outage and Core restart;
  check authoritative denial and recovery separately. Time-controlled tests establish long-duration
  behavior; a brief browser run is not evidence of an hour or physical device sleep.
- Run Core/CLI, TS/.NET SDK, affected runtime app and native tests/builds, Core AOT, version validation
  and the documentation index. Do not perform updates or alter grants on the operator's live host.

---
status: Ready
created: 2026-10-11
updated: 2026-10-11
summary: Replace hourly app activity renewal with continuous authorized sessions and separately revocable background delegation.
components: [apps/core, apps/cli, packages/app-sdk, packages/app-sdk-dotnet, apps/shell, apps/shell-swift, apps/harness, apps/plans]
---

# Continuous App Access

## Goal And Approval Boundary

Owner direction, 2026-10-11: a trusted app left open in a browser must not repeatedly require
Renew access. Apps should maintain their authorized access transparently, including in a desktop
shell with many windows. Deliberately authorized background work must also be possible without
an open tab. Preserve enforceable permissions and revocation while removing routine consent churn.

On 2026-10-11 the owner approved finalizing D1, moving this plan to Ready and implementing all
deliverables, including isolated Shell/standalone verification and a reviewed, green PR merged
with a regular merge commit. The technical contract below records the implementation decisions.
[SDK UI composition](../sdk-ui-composition/plan.md) remains deferred; panel layout/API work is
excluded. Verification uses an isolated Core, without changing grants on the operator's live host.

## Verified Baseline And Problem

[App activity](../app-activity-window/feature.md) imposes a one-hour `ActiveUntil` deadline in
addition to app-grant and primary-session expiry. Revalidation cannot extend it. Silent embedded
sign-in establishes identity but no privileged activity, and a trusted click near expiry can open
a renewal popup. HostyOverlay blocks mounted content when activity lapses. The problem is not
limited to especially dangerous apps: having Core permissions triggers this activity requirement.

[Session lifetimes](../auth-session-lifecycle/feature.md) separately default to 7 idle / 30 absolute
days for regular app grants and Core browser sessions, but 3 / 14 days for system-app grants.
Short-lived provider/MCP credentials and the app's service identity are other distinct credentials.
Increasing token TTL alone would leave the independent activity gate and parent-session expiry.

## Target Authorization Model

Separate the durable authorization decision from the credential used for an individual request:

| Source of authority | Lifetime and renewal | End condition |
| --- | --- | --- |
| Browser app session | Follows its live authorizing Core browser session; silent maintenance | Logout/revocation, parent expiry, access loss or installation change |
| Native app session | Follows its explicitly authorized device/session principal; silent maintenance | Device/session revocation or expiry, access loss or installation change |
| Explicit background delegation | Until revoked by default, with optional owner-selected expiry | Delegation revocation/expiry, access loss or installation change |
| Provider/MCP request credential | Bounded expiry; reminted by the authorized app backend | Expiry or loss of any required source authority |

Effective authority remains the intersection of current user rights, app grants, target access
and any narrower delegation/action/resource scope. Trust, the `system` flag, a UI-client role and
being first-party do not add rights or trigger a shorter session policy. A service credential
identifies an app; it cannot invent a user or turn an ordinary session into background delegation.

Remove the independent hourly activity requirement for these explicitly authorized session sources.
Initial silent app sign-in under a live Core session should make already-granted functionality
usable immediately. Permission changes still use existing review; `prompt=none` cannot approve
new permissions, assignments or a background grant. Preserve separate confirmation requirements
for actions whose contracts explicitly require them.

## Browser Continuity And SDK Behavior

Use the existing opaque app-grant model for browser continuity rather than adding a second generic
refresh secret merely to extend `ActiveUntil`. Bind the grant to the authorizing session and app
installation. For new browser grants, the parent session's absolute deadline is the upper bound;
there is no shorter absolute cap chosen by the manifest's `system` flag. Existing Core defaults
remain 7 idle days and 30 absolute days, configurable by the operator. This proposal does not
silently make the primary browser session permanent.

App-bound maintenance may validate and touch the app grant, but must never extend the parent
Core session. The app's backend authenticates this operation with its own service identity and
that user's app grant; Core rechecks the user, installation, assignment and permissions. Retaining
both credentials after a browser request does not give the backend authority to keep the parent
alive. Generic introspection, provider/MCP calls and background revalidation cannot touch it either.

Parent idle maintenance is a separate browser-to-Core operation. A Core-owned browser frame makes
a same-origin POST using the primary session cookie and Core-owned origin/CSRF proof. Bind it to
the app's installed origin and the exact authorizing session/actor, using the existing app-intent
validation pattern. An app/backend-supplied Origin header, launch intent or app grant is insufficient
without that Core browser session proof. Keep the cookie and proof inside the isolated Core origin;
the frame returns only bounded status/deadline information, never a reusable keepalive credential.
The app backend cannot independently replay those results to extend the parent after tabs close.

Both paths validate before touching: an expired/revoked parent or grant cannot revive itself.
A browser heartbeat proves access to the existing browser session, not human presence or permission
for additional operations. This maintenance is silent and requires no periodic confirmation.
Where browser cookie/framing policy prevents the Core-owned path, keep using the app grant within
the parent's actual remaining lifetime; do not substitute backend-only parent maintenance or
report the unavailable maintenance transport as expired identity. Genuine parent expiry still
requires normal recovery. Closing a tab does not revoke an otherwise-live session immediately.

SDK maintenance runs on mount, at a bounded interval (proposed five minutes with jitter), on
focus/visibility return and network recovery, and before a protected request when validation is
stale. Timers improve continuity but are not required for correctness: a sleeping browser can
recover automatically while the actual parent session is still valid. Hidden tabs may maintain
access; closing a tab is not relied upon as a reliable revocation event. Background services that
need independence from that session use the explicit grant below.

Return server-calculated session/credential deadlines and a suggested next check; do not derive
authority from the browser clock. Coalesce maintenance per document and make concurrent calls
from several tabs idempotent. Keep existing credentials in their supported locations: HttpOnly
cookies where available and the existing embedded per-tab mechanism where required. Never pass
Core cookies, app grants or refresh material through Shell/SDK composition messages or URLs.

Short-lived provider/MCP credentials continue to expire. Their server SDK clients reacquire them
from the valid source authority before use. Retry authentication only after a definite pre-dispatch
rejection; never replay an ambiguously completed mutation. Use the operation's existing replay ID
or status query where available. SDK maintenance must not create sessions, resend messages or
repeat Plans handoffs. Harness needs to refresh credentials for all affected live conversations,
not only the currently visible chat.

Classify UI states explicitly: maintaining access, temporarily offline, genuine sign-in required,
access revoked and missing permissions. A successful maintenance cycle is silent. A network/503
failure does not clear identity or show Renew access; retry with bounded backoff. Actual expiry or
revocation prevents protected calls and uses the existing recovery flow without losing drafts.
Same-user recovery preserves mounted state; a different user clears the old actor's protected
state, panel bindings and queued operations before any replay.

Offline-capable apps may explicitly separate local/public content from protected user content.
Losing Core connectivity must not blanket-block the former. Keep protected content gated after
logout/account change; offline support does not mean showing a previous user's private content to
a new actor. Default existing protected roots remain protected until an app declares this boundary.

## Explicit Background Delegation

A user deliberately enables unattended operation for a named app and a bounded set of actions
and resources, such as checking and installing updates for selected apps. Record a Core-owned
grant with owner, consuming installation, allowed actions/targets, creation/revision/audit metadata,
optional expiry and revocation state. Until-revoked is a visible choice, not inferred from opening
an app or clicking an assistant button. Issuing a grant requires authority for the requested actions.

An app backend exchanges its own service identity plus the delegation reference for a short-lived,
audience-bound credential; proposed maximum lifetime is five minutes. A grant ID is not a bearer
secret. The exchange and protected operations check current user/app/target rights and the current
grant revision. Reinstallation cannot inherit a previous installation's delegation. Reuse the
existing provider/MCP credential mechanisms with this additional authority source instead of
creating a parallel general-purpose admin token.

Ordinary browser logout ends its interactive app sessions, but an explicitly authorized background
grant survives; say so where it is enabled. Provide list/revoke controls and an explicit revoke-all
authorizations action through Core-backed settings/control so recovery does not require the app
or Shell to run. Account disable/removal and explicit security revocation cover background grants
as well. Permission/assignment removal prevents further dispatch; updates cannot enlarge the saved
scope. Newly requested actions require changed authorization, while still-authorized work can continue.

Core-enforced writes recheck live authority before dispatch. Existing bounded read-validation caches
must be clamped to credential expiry and their documented revocation bound; test that bound explicitly.
Revocation prevents new calls and is reported to a running consumer. It cannot undo a completed
operation or claim to stop an unrestricted OS process. Verified execution stop and cleanup remain
with the execution backend and workspace lifecycle owners.

Audit grant creation, modification, use for job dispatch and revocation without logging credentials
or flooding the audit with maintenance heartbeats. The scheduler, recurrence, retry budgets and job
notifications remain [AI Agent Bridge D11](../ai-agent-bridge/plan.md), which consumes this authority.
This plan includes a small authorized background-client verification fixture, not a new scheduler
or an app that performs real unattended updates on the operator's host.

## Migration And Compatibility

- Add an advertised session-continuity capability. Update Core and the browser/server SDKs together
  with the first-party consumers; an old Core keeps its actual activity requirement. Never have a
  new SDK locally declare access valid while an old server still refuses it.
- Migrate live browser grants with a verifiable, live authorizing session to the common policy.
  An elapsed `ActiveUntil` alone must not require another click after migration. Do not revive an
  expired/revoked identity or invent provenance for a legacy/diagnostic grant. Normal silent Core
  sign-in may issue a fresh app grant when the parent is valid. No background grants are migrated
  or inferred from existing browser grants.
- Retire `HOSTY_AUTH_APP_ACTIVITY_HOURS` and its settings UI with an explicit migration diagnostic.
  Keep `APP_GRANT_*` / `SYSTEM_GRANT_*` stored values as legacy-policy data during mixed-version
  support; they do not create independent expiry for migrated browser-linked grants. Core-session
  idle/absolute settings remain authoritative. Report old/new policy in upgrade diagnostics,
  including installations with custom values; do not silently delete operator configuration.
- Retain finite diagnostic CLI grants and existing manual/OAuth scopes. Native app continuity must
  validate its own device/session provenance rather than borrow a browser session or force a new
  password sheet every hour. Test explicit native logout and device revocation independently.
- Adapt legacy `activeUntil`, activity events and Overlay/panel suspension so supported consumers
  stop enforcing obsolete deadlines while still suspending on genuine auth failure. Version the
  capability/SDK contract and document supported upgrade order; do not reinterpret a missing field
  from an old server as perpetual access.

## Related Ownership And Limits

This plan receives former [Cross-App Auth D8](../cross-app-auth/plan.md)'s app-session lifetime work;
that ID is retired there, not completed. Cross-App Auth D7 still owns general cross-app delegation
semantics outside the existing provider/MCP interfaces. The durable Core grant portion of Bridge
D11 moves here; its scheduler and retryable-job work stay there. These transfers do not approve
the other Draft plans.

[Execution authorization](../assistant-execution-authorization/plan.md) retains assistant/external
execution credentials scoped to sessions, workspaces and worktrees. A background grant is not a
substitute for those scopes. [User agent sessions](../user-agent-sessions/plan.md) retains its
ordinary-user isolation gate; continuous sign-in does not expose administrator Harness to ordinary
users. [SDK UI composition](../sdk-ui-composition/plan.md) consumes this lifecycle independently
of whether a shell renders navigation or a tool in a dock/window.

Container-first deployment, removal of `localCommand` and advisory source-code review/quarantine
are separate runtime/product decisions. This change does not implement them or describe local
commands as sandboxed. Existing app/user permissions continue to constrain only the operations
where Core or another enforcing service actually checks them.

## D1 Technical Contract (approved implementation direction, 2026-10-11)

### Session authority and maintenance

- Persist an authority version and installation identity on app grants. Version 1 browser grants
  bind the existing authorizing browser session; native grants bind an unscoped device/manual
  credential with no audience, OAuth grant or delegated scopes. Diagnostic grants retain their
  finite diagnostic policy and cannot authorize privileged app operations.
- Existing live code grants migrate only after validating the original identity lifetime, user
  auth revision, installation age and live authorizing principal. Elapsed activity alone is ignored.
  Persist the migration before returning new metadata. Missing provenance requires normal sign-in.
- Version 1 interactive grants use the common app idle policy and the authorizing principal's
  absolute deadline (if the native principal has none, the common app absolute period applies).
  Revalidation checks the parent independently without touching it. Access loss and explicit
  parent/device revocation are terminal. No grant can outlive a revoked authority source.
- Extend revalidation/session envelopes with `continuity: { version: 1, mode, grantId,
  expiresAt, checkAfterSeconds: 300 }`; `mode` is `browser` or `native`. The opaque grant ID is a
  public reference, never a credential. Return `activityRequired: false` and `activeUntil: null`
  for continuous grants so existing clients cease enforcing the obsolete hourly deadline.
  Missing continuity metadata retains the old server's behavior.
- Browser SDK maintenance refreshes the same-origin session probe and, for browser mode, mounts
  a transient Core-owned maintenance frame. `GET /api/auth/apps/continuity/frame` accepts the
  grant reference, validated app origin and random correlation state; it never touches a session.
  The Core document performs `POST /api/auth/apps/continuity/maintain` with its primary cookie,
  Core-origin CSRF/origin proof and the bound grant reference. Validate exact session, actor,
  current installation and safe Core cookie host before a throttled idle touch. App-bound backend
  revalidation remains unable to touch the parent. Native clients maintain their device principal
  through their own authenticated Core calls, never by giving its credential to the app.
- Frame replies contain only status and deadlines. SDK checks exact source/origin/state and a
  bounded timeout. Cookie/framing refusal is `unavailable`, not logout; actual parent failure is
  confirmed through the app probe. Coalesce checks, jitter the five-minute interval, back off on
  outage, and check on focus, visibility and online events. No token, intent or reply allows a
  backend-only parent keepalive. A frame response cannot switch the app's actor.
- Keep `APP_SESSION_ENDED` for actual auth failures and `APP_ACTIVITY_RENEWED` for successful
  explicit recovery. Silent maintenance must not rotate panel generations or replay domain work.
  Add a separate continuity update signal for credential consumers. Harness refreshes every live
  conversation owned by that actor; same-actor opaque app credentials remain stable during normal
  maintenance. Expose an opt-in local-content slot outside Overlay's protected root.

### Background grant and request credentials

- Store versioned records under Core's auth data: grant ID, owner and auth revision, consuming
  installation, label, immutable scopes, optional expiry, created timestamp and revocation. Scope
  entries pin a target installation and identify `core`, `provider` or `mcp` operations. Grant
  changes use revoke-and-create, preserving an audit trail; no implicit broadening on update.
- Core scopes use a closed catalog of named app read/health/update-plan/update/lifecycle operations
  mapped to exact HTTP method/route/required permission and explicit target app IDs. Unmapped routes,
  fleet-wide discovery and arbitrary request-body targets are refused. Updates retain existing
  install-review restrictions; the grant cannot approve newly requested permissions.
- Provider scopes name kind, key and target installation; invocation uses existing provider tokens.
  MCP scopes name the target and exact tool names (no wildcard). They cover that tool's argument
  domain at the selected target, not a claimed filesystem or workspace sandbox. Existing confirmed
  assistant/target grants and Core tool permissions remain prerequisites. Tool introspection checks
  the exact requested name; a catalog credential cannot execute a tool.
- `GET/POST /api/auth/background-grants` lists/creates the current administrator's grants;
  `DELETE /api/auth/background-grants/{id}` revokes an owned grant. Core session + CSRF protects
  mutations; app-bound identity is refused for creating authority. Core's account page provides
  create/list/revoke, including a clearly labeled revoke-all-authorizations action. Matching local
  control routes and CLI commands allow recovery without Shell; creation names an existing owner
  and enforces the same scopes/access. No ordinary-user Harness policy changes.
- `POST /api/internal/apps/{appId}/background/token` requires that app's service credential and
  `{ grantId, scopeId }`. It issues a five-minute app-bound request credential, clamped to the grant
  expiry. Persist its source grant/revision/scope binding with the existing opaque app-grant model.
  It is refused as browser identity, session continuity, grant creation or unrelated internal API
  authority. Explicit Core route authorization or provider/MCP issuance must validate its scope.
- Existing provider/MCP child tokens bind that same source credential and introspect its current
  background grant on use. No parent browser session is required. Core writes and tool dispatch
  validate online; SDK read caches remain at most 30 seconds and clamp to expiry. Background-source
  credentials cannot be exchanged into an unrestricted interactive credential.
- TypeScript and .NET server clients acquire these request credentials from a grant/scope reference
  and their service identity. Refresh before expiry with concurrent-request coalescing; never
  automatically replay an ambiguous write. Audit issue/dispatch and grant lifecycle without secrets.
- Ordinary logout revokes interactive descendants only. Explicit revoke-all-authorizations revokes
  sessions, app grants and background grants owned by the user. Account auth revision, disable,
  assignment removal, scope permission loss and target/consumer reinstall invalidate delegation.

### Inventory and delivery

The existing gates are `AppIdentityService`, `AppManagementAuthorization`, `ProviderAccessService`,
`AssistantSessionAuthority`/`AssistantMcpAccess`, workspace/source/publication authorization and
UI bootstrap. Browser consumers are the SDK identity/activity/Overlay adapters and the session
adapters in Shell, Plans, Workspaces, Marketplace, Demo App, Telemetry UI and Harness. Native
renewal is in Swift's `AppWorkspaceView` and `CoreClient`. Preserve the composition protocol and
layout; only authentication lifecycle consumers change. Core settings retain legacy lifetime
values with deprecation diagnostics, while removing the hourly setting from active configuration.

Deliver the feature on one branch/PR, with no per-phase releases. Required validation includes
clock-controlled authority/migration/scope tests, SDK transport and outage tests, Core AOT,
first-party affected builds/tests, native tests, and real normal-password Shell/standalone flows
on an isolated Core. Background verification uses a scoped fixture, never production auto-updates.

## Deliverables

- [x] D1. Finalize and approve the authority-source, common lifetime, maintenance, background grant, migration and error contracts; inventory every activity check and every first-party renewal consumer.
- [ ] D2. Implement Core continuous browser/native app authorization, browser-proven parent idle maintenance separated from app-bound grant maintenance, and capability negotiation; remove the separate activity gate for supported sources while preserving expiry, revocation and effective permission checks.
- [ ] D3. Implement silent browser/server SDK maintenance and credential reacquisition, migrate first-party consumers including Harness live runs and native Shell, and separate transient outage from authentication recovery and explicitly local content.
- [ ] D4. Implement explicit Core background grants, scope-preserving credential issuance and list/revoke controls through settings and control/CLI, with audited lifecycle and no implicit conversion of browser sessions.
- [ ] D5. Implement and test persisted/settings migration and mixed-version behavior, including custom lifetimes, live legacy activity-expired grants, missing provenance, restart durability and reinstall invalidation.
- [ ] D6. Verify the matrix below with clock-controlled tests and an isolated Core-managed browser/background fixture, update current feature/SDK documentation, remove this plan at completion and regenerate the index.

## Verification

- In an isolated Core with normal password setup/login, open Plans and its assistant in Shell and
  standalone, plus several app tabs. Cross the former one-hour deadline without user interaction:
  existing drafts, navigation, panel identities and authorized requests keep working with no popup.
- Cover hidden tabs, throttled/suspended timers, device sleep, network outage, Core restart and
  reconnection. Distinguish recovery within a valid parent from genuine idle/absolute expiry.
  Use short configured clocks/test clocks instead of pretending a brief browser run proves hours.
- Verify initial silent sign-in, five-minute maintenance, coalescing and server refresh under
  expired request credentials; no duplicate mutation, handoff, conversation or agent message occurs.
- After legitimate browser use, retain only the app service credential and user app grant in a
  backend test client, close all browser contexts and advance the clock. Repeated app maintenance,
  introspection and provider calls must not move the parent's last-use time or prevent its idle
  expiry. Replaying frame status/intent data or forging an Origin header cannot extend it either.
- Verify that the Core-owned browser maintenance path can touch only its matching live parent,
  rejects absent browser proof and actor/session substitution, and never exceeds the absolute cap.
  Block its cookies or framing: preserve still-valid app access without backend substitution,
  confirmation loops or a false logout, then require recovery at actual parent expiry.
- Verify explicit logout, user switch, revoke-all, account disable, role/assignment loss, optional
  permission removal and uninstall/reinstall. Test existing read-cache bounds and write-time checks.
- A small background fixture completes a scoped operation after all tabs close and ordinary browser
  logout, but cannot exceed its scope or continue new dispatch after grant revocation. A normal
  interactive grant gains no such independence. No production scheduled updates are performed.
- Test native device continuity/logout, old Core/new SDK, new Core/old consumer, missing capability,
  live expired activity versus expired identity, custom policy migration and retained diagnostics.
- Run affected Core/CLI/TypeScript SDK/.NET SDK/Shell/Harness/Plans tests and builds, native checks,
  Core AOT validation when contracts require it, version checks and documentation validation.
  Implementation versions all affected release artifacts before publication.

---
created: 2026-10-25
updated: 2026-10-25
summary: Per-user tool activity flows from app servers through Core to Tools, including unopened panels, presence expiry and restart recovery.
components: [apps/core, packages/app-sdk, apps/shell, apps/harness]
---

# Tool Activity

Tools displays Idle, Working, Needs you, Failed and No connection independently of whether a panel
has been opened. Core owns activity; iframe attention remains a legacy SDK presentation signal and
does not contribute to Shell's activity badge.

## Identity And Authorization

A report belongs to one Core user and one `PanelRef`: app id, installation id and declared panel id.
Updates preserve installation identity; reinstalling starts with no reports. App ids and labels
alone never select an existing activity record.

Core injects `HOSTY_APP_INSTALLATION_ID` alongside the app identity in ordinary Docker and local
command launches. An already-running app launched by an older Core needs an app restart to receive
it. The producer keeps this installation id for its lifetime and cannot silently rebind after a
reinstall.

`POST /api/internal/apps/{appId}/ui/activity` requires that app's service credential. The JSON body
contains `userId`, `installationId`, `panelId`, `state` and optional `count`, `label`,
`ttlSeconds`. Core rechecks the current installation, declared panel and enabled user's app access.
The endpoint cannot report for another app or an unassigned user. States are `idle`, `working`,
`needs-you` and `failed`; count is an integer from 0 to 9999, label is plain text up to 120
characters without control characters, and TTL is an integer from 1 to 300 seconds.

`GET /api/internal/apps/{callerAppId}/ui/activity` requires the caller's service credential,
`X-Hosty-User-Token` and UI-host discovery permission (`apps.panels.read` or `apps.read`).
It returns `{ activities: [...] }` for that actor's accessible panel catalogue. Each entry includes
the panel reference, effective state, count, label, `reportedAt` and `expiresAt`. The SDK's fixed
UI server adapter exposes this read through `GET /api/hosty/ui/activity`; it does not expose
the producer endpoint to browsers.

## Presence And Delivery

Core stores reports in memory, with a 10,000-entry bound and maintenance that removes invalid user,
panel and installation references. Working expires after 60 seconds by default; expired working
reads as idle and emits an invalidation within one second. Needs you and failed persist until
replaced or cleared. Idle clears count and label while preserving the last report timestamp.

The existing Core event stream accepts `topics=tool-activity` and acknowledges it with
`stream.ready` containing `toolActivity: 1`. `tool.activity.changed` is an empty refresh hint,
targeted to subscribers for the report's user. App runtime changes also invalidate interested
subscribers without disclosing app identities. Each read revalidates access; stream credentials
retain the existing revocation checks.

No connection replaces the reported state when the providing panel service is unavailable or has
an unhealthy probe. Another service's failure does not hide a healthy panel's activity. Shell also
masks stale state while Core is unreachable and displays the last report time, or No reports yet.
Opening a panel remains governed by the existing UI availability contract, including advisory
health warnings.

## SDK Reporter And Harness

`@hosty-sdk/app/tool-activity/server` exports `ToolActivityReporter`. Construct it with the
Core-managed environment or explicit server options, then call
`set(userId, panelId, { state, count?, label?, ttlSeconds? })`. Credentials stay server-side.

The reporter serializes requests, retains newer updates during in-flight reports, renews working
presence before its deadline and re-reports retained states at least every 20 seconds. Failed
requests retry after five seconds with a ten-second request deadline. Core restart recovery
therefore does not depend on an open frame or a producer SSE connection. An acknowledged idle is
removed from the reporter cache. `dispose()` cancels requests, stops its timer and drops retained
values; it does not clear persistent attention in Core on behalf of an unfinished run.

An optional `onReported(userId, panelId, value)` callback acknowledges the current successful report.
Rejected acknowledgements retry; updates arriving while an acknowledgement runs remain queued.

Harness reports its declared `assistant` panel for each session owner. Its server observes session
transitions and deletion without browser subscribers, aggregates failed sessions before pending
approvals/questions before running sessions, and clears the aggregate when nothing remains.
Before reporting, Harness atomically records owners of non-idle activity in its app data. Startup
reconciles that journal with the session snapshot, retrying idle for deleted owners even after a
failed clear and a process restart. Only an acknowledged idle removes an absent owner from the
journal; a concurrent new active snapshot preserves that owner.
Counts describe failed sessions, pending decisions or running sessions within the winning state.
A running session with outstanding decisions retains Needs you until its final decision is resolved,
including mixed approval and question requests. Automatic abandonment of persisted sessions also
notifies the observer, clearing orphaned attention without opening the conversation.
Native runs orphaned by a Harness restart are not renewed as working presence. Existing worker
recovery supplies the retained worker session state. The helper runs only with a complete managed
service and installation identity.

## Shell Presentation

The Tools menu lists the authorized catalogue and shows activity beside each tool. Pinned tools,
including the selected assistant, carry a compact state indicator without changing the fit rule,
pin preferences or selection behavior.

The Tools badge counts tools in failed or needs-you state, irrespective of provider counts. Failure
takes visual precedence over decisions, which take precedence over background work. Working does
not create an attention count. All tools includes Needs you (failed tools first), Working and
No connection groups, followed by the searchable application groups and pin controls. These
groups also appear in the phone picker.

One Shell provider shares the existing SSE connection, resynchronizes on reconnect and visibility
return, and cancels stale actor reads. Hidden pages release topic interest and suspend retry/expiry
reads. Presence deadlines also trigger reconciliation in case an expiry hint was dropped. Refreshes
do not select, remount or close panels; unsent drafts and pin choices remain intact.

## Testing Expectations

- Exercise service-only producers, authenticated consumers, user/app/panel/installation isolation,
  validation, default and bounded TTL, sticky states, idle clearing and readiness overrides.
- Verify empty user-targeted hints, opt-in subscription, expiry invalidation, and ordinary stream
  session revocation.
- Test reporter retries, renewal, restart re-report, shutdown and an update arriving during an
  in-flight clear.
- Test Harness aggregation and real SessionManager approval, question, failure and deletion events
  without frame subscriptions, plus a failed deletion clear followed by restart and renewal during
  acknowledgement.
- Test Shell's tool counts, severity priority, actor changes, disconnected state, delayed reads,
  visibility recovery and retained drafts.
- In a managed local Core, use normal setup/login and separate test data. Verify unopened panels
  in independent browser clients, provider recovery after a keep-apps Core restart, TTL and
  readiness, and narrow layouts. A narrow browser is not a physical-phone or other-OS result.

The owning deliverable is D15 in the [design system plan](../design-system/plan.md).
The underlying [panel system](../sdk-panel-system/feature.md) and
[event bus](../core-event-bus/feature.md) retain their existing authority boundaries.

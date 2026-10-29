---
created: 2026-10-28
updated: 2026-10-28
summary: Optional connection-level quota and credit observations for Codex and Claude, with bounded diagnostics, retained snapshots and shared Limits controls.
components: [apps/harness]
---

# Harness Provider Usage Limits

Harness exposes optional account usage in Providers settings and beside the provider/context
controls in both conversation surfaces. Context-window tokens remain a separate measurement.
Limits describe provider observations, not a prediction that a message succeeds or a billing ledger.

## Provider Support

The shipped packages are Codex CLI 0.162.1 and Claude Agent SDK 0.3.296.

- Codex uses app-server `account/rateLimits/read` and `account/rateLimits/updated`.
  Multiple `rateLimitsByLimitId` buckets take precedence over the legacy snapshot. Primary and
  secondary windows retain their durations, percentages and Unix reset times. Credits retain
  their provider unit and explicit unlimited flag. Partial notifications replace only their
  reported bucket. A native account-change event invalidates its old observation.
- Claude uses `rate_limit_event`, structured `usage_report` messages when naturally emitted,
  and a feature-detected `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET` control.
  The getter always receives `skipBehaviors: true`; Harness neither injects `/usage` prompts
  nor scans transcripts. Getter percentages are 0–100 and resets are ISO timestamps.
  Event utilization has no documented scale in the pinned type, so event handling reports
  status/reset and retains the earlier amount's observation time. Missing profile scope,
  absent experimental getters and native errors degrade without failing the conversation.
  Model-scoped rows absent from an additive getter response retain their earlier observations.
  Extra-usage amounts remain monetary minor units with the reported currency.
- API-key connections report unsupported account telemetry because these agent transports do
  not expose raw request/token rate-limit headers. This does not imply unlimited API usage.
  Existing Codex host logins require file-backed stable identity for account telemetry;
  keychain-only identity does not create competing diagnostic helpers.
- The provider-neutral contract represents local quota as not applicable and supports USD
  balances, provider credits and percentage windows. Ollama fixtures cover included,
  purchased and legacy session balances. The local Ollama adapter reports not-applicable quota
  without credentials or network requests, so its compact chat control stays hidden. Cloud-backed
  models remain unsupported by that adapter; cloud account collection belongs to
  [Agent And Model Provider Interface](../agent-provider-interface/plan.md).

The optional adapter capability describes snapshot/event support and meter kinds. Observations
distinguish available, unavailable, unsupported and not applicable. Unknown amounts remain
absent; zero and over-limit values retain their meaning. Progress bars clamp only their drawing.

## Connection Ownership And Recovery

The provider worker owns the latest observation. Cache keys bind the connection revision and
account/credential fingerprint; display names do not identify an account. Rename preserves a
snapshot. Credential replacement, revocation, removal and a verified host-account change prevent
old snapshots and late callbacks from being used for the replacement connection.

Latest snapshots live in the worker data directory under `connection-usage/`, outside conversation
events and native session transcripts. They survive worker restart and chat replay expiration.
Recovered observations are stale until refreshed. A failed diagnostic retains earlier values
with their original timestamps; neither an empty response nor a reset deadline restores quota.
Snapshots older than two minutes, or containing an elapsed reset time, are marked stale.

Concurrent refreshes share one request, with a minimum one-minute interval between attempts.
Active conversations reuse their native control channel. Idle diagnostics start a bounded helper
without a model prompt, tools, MCP initialization or persisted conversation. Control reads time out
after three seconds; a timed-out reader disables subsequent requests on that native channel.
Idle diagnostics hold a connection claim, with at most one idle helper in Docker and two in Local.
A new chat waits for bounded cleanup, and a translation claim prevents a competing diagnostic. Codex helpers terminate and await process exit, escalating
to SIGKILL for an unresponsive owned helper. Diagnostic failures never emit a conversation error.

## Delivery And Interface

`GET /api/connections/{id}/usage` returns cached state. `?refresh=true` requests a coalesced
refresh. Both use the normal administrator gate and the authenticated API-to-worker connection
operation. The shared event transport admits `/api/connections/{id}/usage/events` using its
existing actor-bound, expiring one-use tickets. One server subscription samples worker snapshots
every two seconds per observed connection; this sampling does not call vendor APIs.
The browser shares subscriptions, closes hidden-page streams, and reloads on reconnect/visibility.
Sequence ordering and request guards prevent a late HTTP response from replacing newer stream data.

The Limits popover lists quota windows, credits, provider status, localized amounts and absolute
reset/observation times. Unsupported/unavailable states do not render a fabricated percentage.
A provider-selected active row may supply the compact label; otherwise the control says Limits.
Not-applicable quota hides the compact chat control and remains explainable in settings.
Refresh affects only usage state, preserving settings edits and message drafts and leaving Send
independent of diagnostic availability.

See [provider connections](../ai-gateway-providers/feature.md),
[context usage](../harness-context-usage/feature.md), and
[worker execution](../assistant-shared-docker-runtime/feature.md).

## Verification

The 2026-10-28 candidate integrates main `9bcbc1942b0e9efbbc18e829dfd9664df651a1cc`
and versions Harness from 0.77.0 to 0.78.0. Native prompt suggestions and local Ollama remain intact.

- `npm run harness:build-web` passes.
- `npm run harness:test` passes 1,889 tests in 175 files.
- `npm run harness:lint` passes with the existing unrelated tasks.tsx hook warning.
- `npm run test:integration -- worker` passes native no-account usage controls without prompts.
- `npm run test:integration -- harness-local` passes authenticated API-key unsupported and local
  Ollama not-applicable responses, cold/warm startup and missing-output recovery. Parent Finish
  confirms resource removal and removal of temporary test data and credentials.
- Normal password login and the Shell-embedded Limits popover pass in Chrome, including Refresh,
  keyboard opening, Escape/focus return, narrow layout and preservation of the draft/Send state.
- An authorized read against the existing real Codex login reports quota and credit rows.
- An explicitly authorized trial on the existing managed Claude connection returns HTTP 200 with
  `state: unavailable`, `reason: not_reported` and no quota rows in 2.8 seconds. The SDK exposes no
  more specific cause through this observation; this result does not establish whether the account
  lacks profile scope or the upstream report is unavailable. No prompt is sent, no provider
  credential is copied, and the session count and connection revision remain unchanged.
- Core confirms Return from that trial to the installed Harness 0.77.0 Local package with healthy
  API/worker and a ready worker protocol. The original Core process remains unchanged. Workspace
  access is reviewed through normal Core confirmation; its temporary additional permission is
  removed from the running app on Return. Dashboard then reports that the installed manifest also
  requires `skills.manage`, absent from its restored grants; the trial does not grant permanent
  installed-package access. Harness remains running and ready with its Claude connection available.
- The additional `sessions` suite, outside the affected worker/harness-local suites, cannot complete:
  its demo-app fixture reports `skill_package_invalid` for an absent skill directory. Its child is
  Finished, and the exploratory fixture edits are reverted.

## Testing Expectations

- Normalization covers missing/invalid values, zero, exceeded limits, multiple buckets, partial
  updates, scope, currencies/credit units, unknown/unlimited distinction and elapsed resets.
- Adapter tests cover no-prompt snapshots, live events, removed Claude getters, missing profile
  scope, nonfatal errors, timeouts, cleanup and account invalidation.
- Connection tests cover coalescing, exclusive credential claims, rename/replacement/revocation,
  stale persistence and late results; subscriptions stop at the last consumer.
- HTTP/stream tests verify administrator authentication and ticket admission. UI tests cover
  unsupported states, bounded bars, absolute times and HTTP/stream ordering.
- Run Harness lint, web build, tests, version/docs validation, and the worker/harness-local
  integration suites. Use a managed child Core with normal password login for browser acceptance.
  Real account checks require scoped authorization; fixture results never establish live-account
  availability. An unavailable response passes the optional reporting contract when it remains
  nonfatal and does not fabricate a balance; it is not evidence of positive account-limit visibility.

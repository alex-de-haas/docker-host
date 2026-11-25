---
created: 2026-10-28
updated: 2026-11-25
summary: Optional connection-level quota and credit observations for Codex and Claude, with bounded diagnostics, retained snapshots and shared Limits controls.
components: [apps/harness, packages/agent-provider-runtime, apps/codex-provider, apps/claude-code-provider, apps/ollama-provider]
---

# Harness Provider Usage Limits

Provider-owned settings expose optional account usage beside each connection. Harness displays
the same observations beside the provider/context controls in both conversation surfaces, including
before the first message. Context-window tokens remain a separate measurement.
Limits describe provider observations, not a prediction that a message succeeds or a billing ledger.

## Provider Support

The provider applications own their pinned native packages and account diagnostics independently
of Harness.

- Codex uses app-server `account/rateLimits/read` and `account/rateLimits/updated`.
  Multiple `rateLimitsByLimitId` buckets take precedence over the legacy snapshot. Primary and
  secondary windows retain their durations, percentages and Unix reset times. Duration labels use
  whole days or hours when exact (for example, `7 days` and `5 hours`); other durations remain in
  minutes without rounding. Missing durations keep the primary/secondary label. Credits retain
  their provider unit and explicit unlimited flag. Partial notifications replace only their
  reported bucket. A native account-change event invalidates its old observation.
- Claude uses `rate_limit_event`, structured `usage_report` messages when naturally emitted,
  and a feature-detected `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET` control.
  The getter always receives `skipBehaviors: true`; the provider neither injects `/usage` prompts
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
  without credentials or network requests, so its Limits control stays hidden in both settings and
  chat. Cloud-backed models remain unsupported by that adapter; cloud account collection belongs to
  [Agent And Model Provider Interface](../agent-provider-interface/plan.md).

The optional adapter capability describes snapshot/event support and meter kinds. Observations
distinguish available, unavailable, unsupported and not applicable. Unknown amounts remain
absent; zero and over-limit values retain their meaning. Progress bars clamp only their drawing.

## Connection Ownership And Recovery

The owning provider application stores the latest observation. Cache keys bind the connection revision and
account/credential fingerprint; display names do not identify an account. Rename preserves a
snapshot. Credential replacement, revocation, removal and a verified host-account change prevent
old snapshots and late callbacks from being used for the replacement connection.

Latest snapshots live in the provider data directory under `connection-usage/`, outside conversation
events and native session transcripts. They survive provider restart and chat replay expiration.
Recovered observations are stale until refreshed. A failed diagnostic retains earlier values
with their original timestamps; neither an empty response nor a reset deadline restores quota.
Snapshots older than two minutes, or containing an elapsed reset time, are marked stale.

Concurrent refreshes share one request, with a minimum one-minute interval between attempts.
Active conversations reuse their native control channel. Idle diagnostics start a bounded helper
without a model prompt, tools, MCP initialization or persisted conversation. Control reads time out
after three seconds; a timed-out reader disables subsequent requests on that native channel.
Idle diagnostics hold a connection claim, with at most one idle helper in Docker and two in Local.
A new chat waits for bounded cleanup. Codex helpers terminate and await process exit, escalating
to SIGKILL for an unresponsive owned helper. Diagnostic failures never emit a conversation error.

## Delivery And Interface

The public agent operation `GET /api/agent/v2/connections/{id}/usage` requests a bounded fresh
snapshot through the existing account diagnostic, with a fresh exact Core operation credential.
It can initialize a metadata-only native helper without creating a conversation or sending a model
prompt. Concurrent consumers share the provider's cache and minimum one-minute refresh interval;
repeated reads do not bypass this interval.

Provider-owned `GET /api/settings/connections/{id}/usage` returns cached state, while
`?refresh=true` requests the same guarded refresh. Normal app sign-in and current administrator
access protect this settings route. The settings list reads on entry and exposes a Limits control
with all reported windows/credits and a manual refresh. It does not poll the provider, and usage
updates preserve account editor fields.

Harness `GET /api/connections/{id}/usage` reads the public provider operation; its existing
`?refresh=true` remains accepted. The shared event transport admits
`/api/connections/{id}/usage/events` using actor-bound, expiring one-use tickets. One server
subscription samples provider snapshots every two seconds per observed connection. These reads
share the provider's one-minute refresh guard instead of launching a diagnostic every two seconds.
The browser shares subscriptions, closes hidden-page streams, and reloads on reconnect/visibility.
Sequence ordering and request guards prevent a late HTTP response from replacing newer stream data.

The Limits popover lists quota windows, credits, provider status, localized amounts and absolute
reset/observation times. Codex quota headings show time until the reported reset in days/hours or
hours/minutes instead of the window duration. The countdown updates locally while the popover is
open and when the page becomes visible, without requesting provider data. An elapsed deadline says
Reset time reached without implying restored quota; missing reset times retain the window label.
Unsupported and not-applicable observations hide the Limits control in both settings and chat.
Loading, unavailable and stale observations keep the control and its refresh action; a temporary
failure does not imply absent support. Connection revision guards prevent an old account's support
state from hiding the control for its replacement. Unknown amounts never become a fabricated zero.
The control shows an hourglass inside a blue ring with the percentage of allowance remaining.
It shares its shape with the adjacent stacked-pages context ring; context fills as usage rises,
while the limits ring empties. The visible `left` suffix hides below a 640 CSS px composer width,
preserving the percentage and icon. Remaining allowance at 20% or below uses the warning color;
zero uses the destructive color. Hover and keyboard focus expose the selected window and absolute
reset time; clicking opens all reported windows and credits.

A provider-designated headline row is authoritative. Otherwise, the indicator takes the smallest
remaining percentage across windows in a single applicable bucket, or the known generic Claude
five-hour and seven-day windows. Codex model scopes use exact selected-model identifiers; ambiguous
buckets and model/surface display names do not establish applicability. A partial Codex update can
supply the percentage from a single applicable bucket before the full account snapshot arrives.
The tooltip and accessible label identify the partial report, and the popover lists every reported
window and credit balance. Credits and monetary balances are excluded from the ring. Missing
amounts, other partial reports, stale observations, elapsed resets and ambiguous applicability
produce a dashed ring with `?`. Each selected window's amount must be fresh, including retained rows
from partial updates. Detailed last-known values remain in the popover. A local display clock
expires the meter without making provider requests.
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

The 2026-11-02 display refinement passed `npm run harness:test` (2,000 tests),
`npm run harness:build-web`, and `npm run harness:lint` (one existing tasks.tsx warning).
`npm run test:integration -- harness-local` passed with separate managed-child data: unsupported
API-key and local Ollama controls are absent in the password-authenticated Shell settings iframe.
Cold start, warm restart and missing-output recovery took 35.043, 2.018 and 22.397 seconds;
parent Finish confirmed resource removal. The authorized live workspace trial also displayed the
Codex reset countdown and retained its exact timestamp. No model prompt was submitted.
The separate Docker worker suite was not repeated for this web-only change; native webviews and
other operating systems were not tested. Version/documentation checks pass, and changes remain
uncommitted in the existing Harness 0.84.0 candidate.

### Extracted Provider Regression, 2026-11-13

The extracted provider runtime passes 85 targeted settings, usage, cache, authentication and
public HTTP tests. Cold authorized HTTP reads return real fixture quota rows without a native
conversation or model turn; concurrent/repeated reads share one SDK diagnostic. Runtime TypeScript
and all three provider production builds pass. Harness passes 145 affected usage, settings and
conversation tests, its API TypeScript/bundle checks and bounded production Webpack build.

In the existing operator-authorized ordinary-data trial, all three provider apps are updated and
healthy. Codex displays a fresh 65% remaining quota and credits in Shell settings and in an existing
empty Harness chat with zero messages and no provider execution. No model prompt is submitted for
these checks. The settings dialog is verified at normal width and an 800 CSS px viewport, including
Escape/focus return. Claude's current account diagnostic reports unavailable rather than numeric
limits; that observation is shown explicitly and does not establish positive Claude quota coverage.
The new conversation-title scenarios use component event/response regressions without an additional
live model turn. No new child Core is created for this existing authorized live trial.

## Testing Expectations

- Normalization covers missing/invalid values, zero, exceeded limits, multiple buckets, partial
  updates, scope, currencies/credit units, unknown/unlimited distinction and elapsed resets.
- Adapter tests cover no-prompt snapshots, live events, removed Claude getters, missing profile
  scope, nonfatal errors, timeouts, cleanup and account invalidation.
- Connection tests cover coalescing, exclusive credential claims, rename/replacement/revocation,
  stale persistence and late results; subscriptions stop at the last consumer.
- HTTP/stream tests verify administrator authentication and ticket admission. UI tests cover
  unsupported/local control visibility, unavailable recovery, countdown rollover, bounded bars, absolute
  times and HTTP/stream ordering.
- Cold public usage reads return quota rows without a model turn or persisted session. Repeated
  and concurrent consumers reuse diagnostics, and missing authority never starts a native reader.
- Settings usage reads enforce own-app administrator access, current provider kind and account
  revision. Consumer projection never relabels a replacement account's usage as an older revision.
- Provider settings cover initial loading, unsupported/local hiding, error recovery, stale details,
  bounded concurrent reads, account rename/replacement, discarded late replies, Escape/focus return,
  unsaved editor preservation and wide/narrow layouts.
- Summary and ring tests distinguish remaining from used amounts, preserve provider headline picks,
  reject unrelated scopes and currencies, select the limiting eligible window, and expire stale or
  elapsed observations without restoring quota. Verify focus tooltip and popover Refresh behavior.
- Run Harness lint, web build, tests, version/docs validation, and the worker/harness-local
  integration suites. Use a managed child Core with normal password login for browser acceptance.
  Real account checks require scoped authorization; fixture results never establish live-account
  availability. An unavailable response passes the optional reporting contract when it remains
  nonfatal and does not fabricate a balance; it is not evidence of positive account-limit visibility.

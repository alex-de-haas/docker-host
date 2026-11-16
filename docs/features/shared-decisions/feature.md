---
created: 2026-11-03
updated: 2026-11-12
summary: Core-owned private questions with immutable answers, source delivery receipts and a shared Harness Decisions view.
components: [apps/core, apps/harness, packages/agent-provider-runtime, packages/app-sdk, packages/app-sdk-dotnet]
---

# Shared Decisions And Human Response

Core owns addressed questions and immutable human answers. The originating application owns native
execution, private conversation context and continuation. An answer supplies input; it grants no
installation, tool, source, publication or task-result authority.

## Records And Access

A record contains stable question/option IDs, a source correlation key, optional subject/task/material
references, a relative origin route, creation/expiry times and separate resolution, delivery and
continuation receipts. Limits are four questions, eight options per question, 4,000 characters of
answer text per question and 64 KiB of encoded request input. Labels may repeat; IDs disambiguate
choices. Questions and answers are text, not executable option payloads.

The current authenticated user is the respondent. Core derives the source principal, application
installation and user; request bodies cannot appoint another respondent. An administrator has no
implicit access to another user's decisions. Reads, counts, filters and cursors use the same current
visibility checks. App assignment, installation identity and reviewed permissions are revalidated.
An empty Core registry and unrelated application IDs use the same contract.

Question states are `pending`, `answered`, `withdrawn`, `expired` and `stale`. The first response against
the displayed revision wins. Mutations require a request UUID: an identical retry returns its saved
receipt, changed input conflicts, and a second answer cannot replace the first. Source correlation
and replay fences survive completed-content removal. Source withdrawal or invalidation closes the
question and fences continuation without rewriting an accepted answer.

Core atomically persists a response and its outbox entry. A source acknowledges the resolution
revision only after its own inbox and continuation command are durable. Acknowledgement means
received, not executed. Continuation progresses independently through `received`, `admitted`,
`running` and terminal states, with explicit `blocked` reasons and a stable command ID.

## API And SDK

The operator API is `/api/decisions/v1`. Application servers use
`/api/internal/apps/{appId}/decisions/v1` with the installation service token and a current
`X-Hosty-User-Token`. Ordinary app callers have no service-only or generic background-credential
fallback.

An independently installed agent provider uses its own service identity plus
`X-Hosty-Agent-Execution`, naming an exact Core-admitted execution with its retained original actor.
Core binds its question records to that admission, provider installation and current accessible user;
the provider's current Decisions permissions remain required. Creating a question or resolving an
answer requires current relevant authority. Reads, acknowledgements, withdrawals and continuation
progress reports are metadata operations and can settle the provider's exact owned record after
execution expiry. They admit no native operation, MCP call, lease acquisition or new continuation
run. An expired reference cannot become a general user credential or access another admission's
question. See [Agent provider execution](../agent-provider-interface/feature.md).

| Operation | Route | App permission |
| --- | --- | --- |
| Create | `POST /requests` | `decisions.request` |
| Query/get | `GET /requests`, `GET /requests/{id}` | `decisions.read` |
| Answer | `POST /requests/{id}/resolve` | `decisions.respond` |
| Withdraw/invalidate | `POST /requests/{id}/withdraw`, `POST /requests/{id}/invalidate` | `decisions.request` |
| Outstanding source deliveries | `GET /responses` | `decisions.request` |
| Durable source receipt | `POST /responses/{id}/ack` | `decisions.request` |
| Continuation receipt | `POST /requests/{id}/continuation` | `decisions.request` |
| Private change hints | `GET /events` | `decisions.read` |

Normal operator sessions retain same-origin/CSRF checks for mutations. Scoped direct clients and MCP
use the separately reviewed `mcp:decisions` capability together with `mcp:read`. The nine MCP tools
mirror the JSON operations except the event stream. TypeScript exports `@hosty-sdk/app/decisions`
and `@hosty-sdk/app/decisions/server`; .NET exposes `HostyDecisionClient` and shared wire records.
Ordinary clients obtain current user credentials per call and never implicitly retry mutations.
Provider source clients instead carry their exact admitted reference on each operation; persisted
source command UUIDs and bytes recover uncertain delivery without creating another command.

SSE sends only private `decisions.changed` hints and revalidates authority before delivery and on
keep-alive. Entry, reconnect and visibility recovery reload authoritative state. Notifications link
to the originating application's supported open route; they are not the delivery queue.

## Harness Presentation

Decisions is a navigation entry beside Tasks. Its page displays a pending count, an oldest-first
attention queue, history and type/chat/task/search filters. The count is unavailable when a source
cannot be checked. The page header owns the count; the static navigation declaration has no badge.
Chat and Decisions use the same shared question component and Core ID/revision.

No answer is selected automatically. Explicit Submit supports options and free text. Drafts are
scoped by user and decision, survive background refresh and same-tab reload, and retain the original
request UUID while submission outcome is unknown. A changed revision requires explicit review;
removed options cannot silently carry into the reviewed draft. Saved answers display a separate
continuation status. Plain Markdown lists remain ordinary text.

A closed question (answered, withdrawn, expired or stale) collapses to a compact summary: each
question shows only its saved option labels and free text, or "Not answered", with the full option
list behind a disclosure. A repeated label also shows its description. Answer time and continuation
status share one line, and a notice repeated by the originating chat's wait is shown once. Only
views outside the originating chat link back to it. In the chat a closed question folds to one line,
like a tool call: saved answers, the first question and a status badge (Answered, red
Withdrawn/Expired/Failed, amber Blocked when its continuation needs attention). Expanding it shows
the summary above; Decisions keeps that summary open. Long unbroken text, such as a path, wraps
inside the card instead of widening the options.

Both native and Docker assistant instructions direct necessary operator questions and choices
through the provider's available native question tool: Codex `request_user_input` or
`request_user_input_async`, Claude `AskUserQuestion`, and Ollama `ask_user`. Harness turns those
requests into interactive chat cards; the independently installed native provider owns their Core
Decision registration and answer delivery. Agents continue independent work while
a nonblocking question is pending, keep required task input on `task_request_input`, and report
an unavailable or rejected question tool explicitly. Answers remain separate from operation approvals.

Existing native permissions, task-result reviews and execution recovery are projections, not copies
of their owners' authority. Native permissions use the original exact-run approval operation;
[task reviews](../basic-tasks/feature.md) use the current input/result revision. Harness's own missing
Core permissions link to Core's existing review page. The view does not enumerate every installation
request in the platform. Recovery links to the originating conversation and exposes unavailable or
stale actions without issuing replacement grants.

## Durable Native Waiting

The installed agent provider saves native question correlation, public run/generation and decision
revision, Core registration identity, durable answer delivery and continuation receipts in its own
session aggregate and execution journal. Core receives bounded question content and opaque
references, not the SDK's native session identity or private transcript. Harness retains a public
execution projection rather than a second native wait coordinator.

A live callback receives an answer through the provider's exact run response operation. A parked
run has a provider-confirmed stopped segment; unknown native exit retains capacity and workspace
protection. Consumer/API/container shutdown supplies no native-exit proof for the independent Local
provider. Supported SDK stop-and-wait and provider-owned process evidence determine confirmation.
An uncertain response acknowledgement never authorizes duplicate SDK delivery or another run.

The provider durably records the age of each blocking native callback. After five minutes it
parks an execution blocked exclusively on those questions, using the original native frame,
revision and stable control ID. Pending approvals, active/unknown effects, uncertain answer delivery
and independent active child work prevent automatic parking. Public parking controls use the same
confirmed boundary. After confirmed stop, the remaining question receives a new decision revision
and `next_turn` delivery while retaining its Core question link. A saved answer for that stopped
question reserves a public continuation identity and can report
`awaiting_authorization`; a consumer supplies fresh exact authorization for that next attempt.
Connection/account revision, configuration, supported native context, cancellation fences and
current authority are checked again. Missing context fails strict resume instead of reconstructing
history. Continuation reports distinguish blocked admission, running work, completion, failure and
cancellation from the fact that an answer was stored.

Nonblocking questions preserve independent work. Codex asynchronous question messages become
provider-owned next-turn decisions; they have no surviving native callback. Their answer does not
interrupt an active turn. Claude's native question callback is blocking. Capability/coverage metadata
and explicit unsupported-input notices describe the actual adapter rather than promising identical
native behavior for every engine.

The provider creates and observes its own Core questions and renews admitted tool authority while
Harness is unavailable. Original expiry/revocation still fences effects. The generic Decision
metadata settlement exception does not bypass that fence. Harness-owned task/business tools retain
their own availability dependency.

## Required Task Input

Harness `task_request_input` creates a durable mandatory wait through this contract, independent of
native provider question tools. Its reason and trusted task number/title identify the required
intervention. Registration failures remain visible in local recovery; retries preserve the original
request. Acknowledged tool delivery parks the task without the ordinary native-question timeout.
Answers continue the same task attempt and supported native checkpoint after current authority,
source capacity and cancellation checks, then require a fresh prerequisite check and completion report.

`notificationPending` exposes failed attention delivery on a retained question. Replaying its original
creation retries delivery with the same notification identity, without changing the original creation
receipt or duplicating an answered question. Harness retries pending delivery with bounded spacing;
the inbox remains authoritative. Task-specific outcomes and removal are documented in
[Basic Tasks And Execution](../basic-tasks/feature.md).

## Retention And Removal

Pending questions and unresolved delivery/continuation receipts survive ordinary idle cleanup.
Core prunes completed Decision content after 30 days while retaining correlation/replay fences;
unreceived answers and unfinished continuations remain actionable. Explicit source withdrawal or
invalidation closes a question without rewriting its accepted answer. Requested content removal
also clears stored question/answer content and historical Decision replay snapshots.

Harness's task-input coordinator prunes its own completed wait content under its separate 30-day
policy. Provider-native sessions, execution journals and replay have their own storage lifetime;
Core Decision content removal does not erase SDK files or private provider history. Native stop,
workspace cleanup, consumer conversation deletion and native-history cleanup are separate
operations. None is proved by deleting another owner's data.

## Verification Boundary

Core tests cover the generic question contract and the exact agent-source exception. Local
regressions include delayed `cancelled`, `failed` and `completed` continuation reports after execution
expiry, immutable replay, another source/admission/install refusal and denied old native admission,
renewal and MCP authority. These are in-process contract checks, not real provider inference.

The pre-extraction 2026-11-03 acceptance exercised the former embedded native/worker deployment.
Its paid-provider, container-restart and five-minute-wait results do not establish acceptance of the
independent Local provider architecture. Current platform/runtime verification and remaining
extraction acceptance belong to [Agent provider execution](../agent-provider-interface/feature.md).
No new ordinary-host cleanup or paid-provider test is established by this documentation update.

## Testing Expectations

- Core tests cover first-response races, replay after restart, immutable resolution, outbox/ack
  boundaries, current access, cross-user/install denial, source withdrawal, expiry, retention,
  explicit content removal and private SSE revocation.
- Agent source tests cover exact retained actor/install/admission scope, current Decisions grants,
  expired metadata-only settlement, immutable replay and refusal to create/answer/dispatch through
  an expired execution reference.
- SDK tests cover current-user transport, exact request identity, conflicts and missing credentials.
- Provider tests cover the fixed five-minute boundary with a controlled clock, durable wait age,
  confirmed-stop delivery revision changes, fresh continuation authority, active/unknown effect
  guards, correlated native questions, duplicate labels, free text, secret/nonblocking handling, asynchronous answers in a later turn, durable delivery-before-ack, unknown native
  acceptance/stop, cancellation and parking races without consumer-derived exit claims.
- Harness tests cover task-input waits, same-attempt continuation, public provider stop checkpoints,
  shared drafts and uncertain submissions.
- Component tests cover the compact closed-question summary, including repeated labels and
  unanswered questions, the folded chat line, its blocked status and the originating-chat link.
- The optional manual `npm run test:integration -- tasks` follows the
  [explicit selection policy](../ci-feedback-loop/feature.md#local-integration-checks), rather than
  running for every Decisions change or PR. When selected, it uses a disposable parent-managed
  Core, normal test login, the Docker Harness API and independently installed Local providers with
  an explicitly scripted native engine. It exercises independent Core answers, provider parking,
  restart, same task attempt, explicit result and the existing Tasks journey. `HOSTY_TASKS_BROWSER=1` includes Chromium Tasks/Decisions acceptance; the existing
  `HOSTY_TASKS_PLAYWRIGHT_MODULE` override selects an installed Playwright module.
- Real Codex/Claude checks require separately authorized test provider connections. Shell embedding,
  resource cleanup and missing-executor recovery remain explicit acceptance checks, never inferred
  from a successful unit test or build.

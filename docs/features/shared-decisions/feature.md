---
created: 2026-11-03
updated: 2026-11-10
summary: Core-owned private questions with immutable answers, source delivery receipts and a shared Harness Decisions view.
components: [apps/core, apps/harness, packages/app-sdk, packages/app-sdk-dotnet]
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
`X-Hosty-User-Token`. There is no service-only or generic background-credential fallback.

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
Clients obtain current user credentials per call and never implicitly retry mutations.

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

Both native and Docker assistant instructions direct necessary operator questions and choices
through the provider's available native question tool: Codex `request_user_input` or
`request_user_input_async`, Claude `AskUserQuestion`, and Ollama `ask_user`. Harness turns those
requests into shared Decisions and interactive chat cards. Agents continue independent work while
a nonblocking question is pending, keep required task input on `task_request_input`, and report
an unavailable or rejected question tool explicitly. Answers remain separate from operation approvals.

Existing native permissions, task-result reviews and execution recovery are projections, not copies
of their owners' authority. Native permissions use the original exact-run approval operation;
[task reviews](../basic-tasks/feature.md) use the current input/result revision. Harness's own missing
Core permissions link to Core's existing review page. The view does not enumerate every installation
request in the platform. Recovery links to the originating conversation and exposes unavailable or
stale actions without issuing replacement grants.

## Durable Native Waiting

Harness saves a private wait before displaying a question. It contains the source question ID,
provider/account/native context, input and instruction snapshot, task attempt when present,
cancellation generation, registration UUID, durable response inbox and continuation command UUID.
It contains no browser or provider credentials. Core receives only bounded question content and
opaque references, not native thread IDs or private transcripts.

A live blocking question receives its answer through the original Worker control. After five
minutes without an answer, a blocking-only run can park: Worker persists intent, stops the native
process and releases capacity only after confirmed exit. Unknown exit retains capacity and source
protection. A container restart supplies its container-boundary exit proof; a local restart does
not prove that an old native child stopped. Uncertain answer delivery never authorizes a second run.

An answered parked wait resumes the same supported Codex or Claude context with a single stable
message command and strict native resume. Provider/account, reviewed inputs, current authority and
cancellation fences are checked before admission. Unknown admission remains blocked. A task retains
its admitted execution ID and `awaiting_input` state; `nativeStopConfirmed` describes the parked
segment separately from `stopConfirmed`, which remains false until the business execution ends.
A new task result still requires the existing explicit result operation.

Nonblocking questions do not stop independent work. Unsupported secret inputs are refused before
question persistence. A dead nonblocking callback, missing native checkpoint, changed account or
uncertain stop exposes a recovery-needed outcome; automatic reconstruction or provider migration is
not implemented. The pinned Codex 0.162.1 ordinary-mode runtime emits nonblocking questions;
these support live answers but do not automatically park. Claude AskUserQuestion is blocking.
Live acceptance with both actual providers verifies option/free-text delivery and same-conversation
completion. Claude acceptance also verifies five-minute parking, a full child Core/Harness/Worker restart,
and exactly one successful continuation of the same native session. Scripted protocol checks
separately cover duplicate wording, unsupported inputs and worker crash boundaries.

Codex `request_user_input_async` returns at once and publishes its questions on the agent message
that follows. Harness shows them as a nonblocking Decision with positional question/option IDs and
free text, in place of that message's plain-text rendering. A shape beyond the Decision limits stays
visible as text with a notice. No native callback remains, so the Worker keeps no pending frame and
the saved answer starts the next turn of the same native thread with strict resume. That turn starts
only when the conversation has no running or waiting turn; an answer saved during a turn waits for
it to end and never interrupts it.

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
Core and Harness prune completed content after 30 days while retaining replay and cancellation
fences. Explicit source deletion closes the question, confirms relevant native consumers stopped,
and removes retained question/answer content, including historical replay snapshots. This removal
is separate from resolving a question and cannot revive cancelled work.

## Delivery And Verification

The owner approved this bounded first delivery on 2026-11-03. Shared Decisions owns its original
D1-D7 record, adapters, first inbox and question-continuation scope. General routines, application
events, unattended authority, team routing and richer artifact composition retain their separate
plans. The decision-only inbox and session/task waiting behavior are transferred from Harness Work
Orchestration D3 and Durable Agent Jobs D4/D7; those broader deliverables remain unfinished.

The 2026-11-03 managed acceptance uses normal password login, separate test data and explicitly
connected Codex/Claude accounts. Both real providers accept an option and free text and complete
the originating conversation. A real Claude wait survives parking plus Core/API/Worker restart;
Codex cancellation withdraws its outstanding question and confirms native stop. Chromium verifies
same-tab draft reload, independent-client conflict, two-view updates, existing task review, narrow
layout and an actual answer inside Shell without document overflow. The scripted task journey
retains the same admitted attempt across five-minute parking/restart and reports an explicit result.
Both owned test environments are finished through their owners; child directories, containers and
listeners are removed while the registered implementation workspace is retained.

Verification commands for this delivery:

- `dotnet test apps/core/tests/Haas.Hosty.Core.Tests/Haas.Hosty.Core.Tests.csproj --no-build`:
  4,564 tests pass; five opt-in Docker/mixed-runtime/VPN cases are skipped by the normal suite.
  The affected managed Harness/Decisions runtime checks run separately below.
- `npm test --workspace @haas/hosty-harness`: 2,062 tests pass.
- `npm test --workspace @hosty-sdk/app`: 766 tests pass.
- `dotnet test packages/app-sdk-dotnet/HostySdk.App.Tests/HostySdk.App.Tests.csproj`: 74 tests pass.
- `npm run test:integration -- tasks`, with `HOSTY_TASKS_BROWSER=1`: managed API, Worker, task,
  Decisions and Chromium checks pass, including owner-driven Finish and resource removal.
- `scripts/tasks-browser-acceptance.mjs` additionally accepts the test Shell origin and verifies an
  actual response inside its iframe. Test-only passwords are supplied on stdin, never in source.
- Core/CLI, both Harness Docker images, the web bundle and both .NET SDK targets build. Harness
  type checking, web lint, version consistency, document/link validation and `git diff --check` pass.
  Existing SDK XML-documentation and unrelated web lint warnings remain unchanged.

## Testing Expectations

- Core tests cover first-response races, replay after restart, immutable resolution, outbox/ack
  boundaries, current access, cross-user/install denial, source withdrawal, expiry, retention,
  explicit content removal and private SSE revocation.
- SDK tests cover current-user transport, exact request identity, conflicts and missing credentials.
- Harness tests cover stable native IDs, duplicate labels, free text, secret/nonblocking handling,
  asynchronous Codex questions answered during a later turn,
  durable inbox-before-ack, unknown native acceptance, same-attempt continuation, cancellation and
  parking races, local/container exit proofs, shared drafts and uncertain submissions.
- `npm run test:integration -- tasks` uses a disposable parent-managed Core, normal test login,
  local-only Docker images and an explicitly scripted native provider. It exercises independent Core
  answers, five-minute parking, restart, same task attempt, explicit result and the existing Tasks
  journey. `HOSTY_TASKS_BROWSER=1` includes Chromium Tasks/Decisions acceptance; the existing
  `HOSTY_TASKS_PLAYWRIGHT_MODULE` override selects an installed Playwright module.
- Real Codex/Claude checks require separately authorized test provider connections. Shell embedding,
  resource cleanup and missing-executor recovery remain explicit acceptance checks, never inferred
  from a successful unit test or build.

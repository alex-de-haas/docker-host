---
created: 2026-10-27
updated: 2026-11-05
summary: Provider-owned tasks with qualified numbers, human or app assignment, durable execution, Harness profile options, review and a live Tasks UI.
components: [apps/core, apps/harness, packages/app-sdk, packages/app-sdk-dotnet]
---

# Basic Tasks And Execution

## Ownership And Scope

Core defines version-one task wire types and two independent provider categories: `tasks` and
`task-executor`. Core owns discovery, routing and installation/user/app authority; it stores no task
collection. A producer, task provider and executor can be different applications. The registry also
works without any provider installed and gives no special privilege to first-party IDs.

Harness supplies both categories. Its Tasks navigation entry supports standalone Markdown work,
human assignment and execution by an application with an opaque option. A Harness option identifies
an existing profile by ID/name/capabilities. Profile instructions, connections, credentials, models
and skills remain private Harness configuration. There is no separate agent principal or profile ACL.

Harness retains its administrator-only application/session boundary. Task visibility covers the
owner, creator and human assignee within that boundary. Results and resource references do not
expose private transcripts; only the owner receives a linked execution conversation. The destination
checks its own access. Human assignment does not grant operator-chat access to ordinary users.

Question waits and parked continuation use [Shared Decisions](../shared-decisions/feature.md).
Harness root/child delegation and optional source binding are described in
[Profile-Based Task Delegation](../profile-task-delegation/feature.md). Broader coordination and artifact storage remain in
[workspace coordination](../shared-tasks/plan.md), [orchestration](../harness-work-orchestration/plan.md),
[durable jobs](../durable-agent-jobs/plan.md) and [artifacts](../shared-artifacts/plan.md).

## Task Contract

A technical reference is `{appId, installationId, key, id}`; `id` is a UUID. The provider returns the
whole display `number` as an opaque string. Harness allocates `HRN-1`, `HRN-2`, and so on from one
collection counter, regardless of profile/workspace. UUID, counter and creation receipt share one
fsynced atomic write. Concurrent creation cannot reuse numbers. Request replay returns the original
number; provider-local prefixes may collide. Core never parses numbers or reserves prefixes.

Inputs contain `title` (200 characters), `markdown` (32000), `assignee` (human/app/null),
`review` (`none`, `owner` or `delegator`), up to 32 `resources`, optional `parentTaskRef` and `dependsOn`. HTTP requests also have the Harness-wide
64 KiB encoded-body limit; individual field limits do not override it.
Human assignment supplies a current user ID. Application assignment supplies a qualified executor
and optional revisioned `selection` (`option` or executor-scoped `configuration`). Ready resolves an executor default once; it does not silently change
an unavailable selection. Creator/owner attribution comes from authenticated callers.

A resource is `{kind, owner, id, label?, version}`. Kinds are `app`, `workspace` and `external`;
version is `{mode: "live"}` or `{mode: "pinned", revision}`. References are contextual information,
not copied content or grants. The immutable execution snapshot preserves their owner/version. This
adapter forwards references without resolving external content or replacing a pinned revision.
Execution source belongs to the executor and Core broker; a resource reference alone does not select it.

Records include optimistic `revision`, admitted `inputRevision`, timestamps, status, optional blocked
reason, cancellation intent, explicit Markdown result and retained attempts/outcomes. Each app attempt
retains its execution ID, target, immutable input, receipt and result. Human results also survive
rework and reopening in `outcomes`.

| Status | Behavior |
| --- | --- |
| Draft | Editable description, assignment, review policy and references. |
| Ready | App dispatch is durably queued; human work waits for manual Start. |
| InProgress | The selected executor or human has started. |
| Blocked | Input, review, authorization, recovery or execution failure needs attention. |
| Done | Explicit success is accepted under the review policy. |
| Cancelled | Withdrawal is confirmed stopped or fenced from starting. |

Cancellation remains a flag and is displayed as Cancelling until stop confirmation. Failed execution
is attempt evidence and maps to Blocked, not a seventh task status. Ordinary successful model output
is insufficient: an agent must report `task_result`, then its native run must stop. Review-required
success becomes `Blocked/needs_review`; the owner or current direct delegator accepts its exact result reference. Requesting changes
records feedback and arms a fresh attempt on the same task. Reopening Done/Cancelled preserves history and does not launch work.

Inputs cannot change during admitted or uncertain execution. Duplicate Ready never starts another
attempt. At most one attempt is active or has an unconfirmed stop. Late outcomes cannot revive a
cancelled task; older receipt revisions and earlier attempts cannot overwrite current state.

## HTTP And SDK

Providers declare `provides` roles and same-named `interfaces` entries with key, endpoint, path,
version 1 and capabilities. Consumers request `providers.tasks` and/or `providers.task-executor`.
The roles and permissions are independent of `assistant` and model invocation. Harness declares
consumer permissions as optional; cross-application choices need the operator's existing Core
permission review. Same-app profile execution does not require a new consumer grant.

The existing [provider protocol](../provider-consumption/feature.md) supplies installation-bound,
short-lived credentials. Every operation validates current authority before replay. User-attributed
calls check access to both applications. Harness requires an acting administrator; a caller-supplied
user ID is not authority. Provider credentials cannot call ordinary conversations, settings or MCP.

Harness task base: `/api/tasks/v1`. Executor base: `/api/task-executor/v1`.

| Method and relative path | Operation |
| --- | --- |
| `GET /capabilities` | Version, prefix, common statuses, page limit. |
| `GET /tasks?cursor=&limit=&status=&removed=` | Authorized tasks, opaque next cursor, maximum 100 per page. |
| `POST /tasks` | `{requestId, input}` creates Draft. |
| `GET /tasks/{id}` | Current authorized task. |
| `PATCH /tasks/{id}` | `{requestId, expectedRevision, expectedGraphRevision, input}` replaces Draft input. |
| `POST /tasks/{id}/actions` | Replayable lifecycle command. |
| `GET /options` (executor) | Opaque choices and optional default ID. |
| `PUT /executions/{executionId}` | Durable immutable acceptance; returns 202. |
| `GET /executions/{executionId}` | Retained authoritative receipt. |
| `POST /executions/{executionId}/cancel` | Idempotent `{requestId}` stop intent. |

Lifecycle commands are `ready`, `draft`, `start`, `complete`, `cancel`, `accept`, `request_changes`, `retry`, `disposition`, `remove` and `restore`.
Each carries `requestId`, `expectedRevision` and `action`. `complete` includes a Markdown/resources
result. Review includes an exact `resultRef`; request_changes also includes feedback (4000 characters).
The same request ID/input recovers the original response before stale-revision checks; changed input
conflicts. Read current state afterwards to observe subsequent progress.

TypeScript SDK 0.36.0 exports `/tasks` and `/tasks/server` (`TaskClient`, `TaskExecutorClient`). .NET
SDK 0.11.0 exposes `HostyTaskClient`, `HostyTaskExecutorClient` and Core-owned wire records. SDKs obtain
fresh Core bindings per request, check the selected installation and preserve HTTP status/error codes.
They never retry a mutation or choose another provider implicitly. The service token travels only to
Core; the selected endpoint receives only its scoped provider token.

Harness also supplies its UI directory/options endpoints and `/events` SSE. Agent tools are
Core-mediated `task_options`, `task_list`, `task_get`, `task_create`, `task_edit` and `task_action`.
Harness adds the session-owned `task_executor_options`, `task_request_input`, `task_result` and `task_fail`.
Management tools use the current session owner/credential. The result tool binds to its accepted
execution and passes through existing MCP policy; it cannot complete another task by supplying an ID.

## Required Input And Truthful Outcomes

`task_request_input` is the provider-independent Harness operation for mandatory human input,
including missing setup in Autonomous tasks. It accepts a request UUID, bounded questions and a
reason; task, attempt, owner and session identity come from the current execution. Harness persists
its wait and acknowledgement barrier before returning. The Worker parks only after durable tool
acknowledgement. The task remains Blocked with an `awaiting_input` receipt, an open business attempt
and confirmed native-segment exit. No mandatory wait expires into success.

Core registration retries retain the same request identity. A failed registration remains visible
in Decisions recovery even before a Core question exists. Required questions include the task number,
title and reason; Tasks links to the relevant Decisions view. Decision notifications use stable
identities and expose pending delivery. Failed/interrupted task attempts also produce owner-scoped,
deduplicated attention notifications and retained recovery projections. Notifications are pointers;
records and waits remain authoritative if delivery fails.

An accepted answer resumes the original attempt, session and native checkpoint after current
identity, permissions, input snapshot, source capacity and cancellation checks. The continuation
instructs the agent to recheck actual setup. Cancellation is durably fenced before acknowledgement;
a late answer cannot restart the task. Uncertain stops or unavailable checkpoints remain recoverable
and do not create replacement attempts. Optional native nonblocking questions remain independent.

`task_result` requires `completed: true` and explicit successful evidence. `task_fail` retains an
unsuccessful diagnostic outcome and maps it to Blocked, not Done. Both report admission and terminal
reconciliation enforce runtime-owned barriers, including mandatory input and unresolved approvals.
A new mandatory question invalidates an earlier success report; continuation must submit fresh
completion evidence. Historical reports remain retained. The runtime does not infer completion from
Markdown wording or prove arbitrary output quality; configured review remains a separate check.

## Recoverable Removal

Providers can declare the neutral v1 `removal` capability. `remove` and `restore` carry an exact
`removalScope` of qualified task references and revisions, bounded to 100 records. Core validates the
capability and current authority. Harness allows these operations only to the task owner, excluding
workflow-bound agents. Removal requires the entire reviewed descendant subtree; restoration requires
the original batch. Missing or changed scope conflicts, and identical replay recovers the receipt.

Removal is rejected for armed or active work, incomplete cancellation, uncertain native exit and
open external dependencies. It writes a `removed` marker with batch, time and actor. Ordinary lists
exclude removed tasks; `removed=true` and the Tasks Trash filter expose retained entries for
restoration. Restoring does not arm execution. Task numbering, attempts, outcomes, replay fences,
source, workspaces, profiles and conversations are preserved.

The UI confirms the exact subtree before removal and retains uncertain request bodies for replay.
Quarantined pre-tree records have a separate bounded owner-only cleanup view and private
`/api/task-orchestration/v1/legacy-tasks` endpoints. Cleanup marks retained records without rewriting
or executing their original content; restoration is explicit. Permanent purge is not implemented.

## Execution And Recovery

Ready atomically saves dispatch intent, execution ID, selected option and input snapshot. Harness
acceptance records a fingerprint and creates a replayable idle conversation before any native work.
The profile, provider and model selection are locked at acceptance, before dispatch. The snapshot
survives deletion of the original profile. New attempts validate a fresh
selection. Missing profiles/connections fail explicitly without fallback.

Receipts distinguish `accepted`, `running`, `awaiting_input`, `cancelling`, `completed`, `failed`,
`cancelled` and `interrupted`, with revision, timestamps, stop confirmation and optional result/error
or session reference. Cross-app session links use an absolute HTTP(S) UI URL; another app’s
relative route is not opened against Harness. Completion requires both an explicit outcome and verified native exit.
Task conversations reserve first-message admission for the executor even when a client knows the
execution ID, and reject unrelated new messages; the task lifecycle owns new attempts. Existing
question/approval controls can resume the current live attempt.

The provider observes active receipts and retries transport failures with bounded backoff up to
30 seconds. It reuses the same execution ID after uncertainty. A reachable executor clears a
transient availability block even when its receipt revision is unchanged; only identical current
evidence can restore that projection, without duplicating attempts or outcomes. Cancellation tombstones fence a
late PUT, including cancellation before acceptance. A persisted local cancellation continues after
restart without requiring a fresh credential to stop already-authorized work.

User credentials remain in memory. Restart observes existing Worker/session evidence and retains
Core task dispatch references. Mediated background execution revalidates those references against
current grants; older credential-only executions need fresh owner authentication. Recovery never stores an operator
credential or invents a replacement native run. Unknown termination stays visible and prevents
another attempt. A proven rejection before native admission permits explicit retry. Caught Local
startup failures persist non-admission before the rejected receipt; recovery honors this proof even
when the final session status write was interrupted. Failures after send remain uncertain.
Abandonment confirms Local task exit before discarding its run handle; an unconfirmed stop retains
that handle for recovery and does not prevent the sweep from processing other waiting sessions.
A failed lease release preserves durable native-exit proof. Stop can retry that cleanup after Core
recovers, including after Harness restart, without starting another process; successful cleanup clears
the recorded failure.
Graceful Harness shutdown also confirms Local task exit when no workspace is attached, preserving
cancellation recovery after restart. An interrupted receipt still accepts an explicit result from its
existing live run while reconciliation is unavailable; cancellation, confirmed termination and lost
run handles keep the result fence closed.
An explicitly queued Local execution selection reuses confirmed task exit, keeps its reviewed MCP
guard until Core dispatch, then clears the retained policy state. It does not require a second run
handle or release the same task leases a second time.

A selected existing workspace is checked through current Core membership and attached with the
participation revision. Association retries retain their original request/arguments. Existing leases
cover native execution and release only after confirmed stop. Plain tasks allocate no Core workspace;
completion does not Finish workspaces/sandboxes or remove resources.

The Tasks UI exposes manual work, profile/executor selection, live/pinned references, review/rework,
retry/reopen/cancel, results and attempt history. SSE changes trigger authorized state reads; reconnect
and foreground recovery reread state. Unsaved input remains visible when a background transition
closes Draft editing; saving is disabled and Discard edits restores navigation without a reload.
Uncertain mutations retain the
exact request/body and offer Retry original request. A failed list refresh after a confirmed
mutation preserves the confirmed state without locking the editor in an uncertain command.
Shutdown closes task streams and drains dispatch before stopping active native sessions.

## Requirement Transfer

The 2026-10-27 split in [vision decision 64](../../vision.md) preserved these ownership transfers:

| Basic deliverable | Former owner |
| --- | --- |
| D1-D2: neutral model, numbering, lifecycle, execution protocol, Core/SDK | Shared Tasks D1-D2 and D4. |
| D3: Harness store, executor, authority, explicit existing workspace | Shared Tasks D3-D4; Harness Orchestration D1-D2 and privacy portion of D7. |
| D4: basic Tasks UI and review | Harness Orchestration D1-D3 and basic portion of D5. |
| D5-D6: basic acceptance and documentation | Shared Tasks D5; Harness Orchestration D5-D6. |

Automatic workspace coordination, richer artifact/decision UI and hierarchy remain unchecked in
their owning plans. The transfer does not complete those plans.

## Delivery Verification (2026-10-27)

Verified in the registered development worktree on macOS, with Docker Desktop and Chrome for the
managed runtime/browser journey. Changes are not deployed to the operator's live Core or apps.

| Command / scope | Result |
| --- | --- |
| `dotnet build` for Core and CLI | Passed; also rebuilt by the integration launcher. |
| `dotnet test apps/core/tests/Haas.Hosty.Core.Tests/Haas.Hosty.Core.Tests.csproj` with provider/manifest/observability filters | 32 passed after integrating current main. |
| `npm run build --workspace @hosty-sdk/app` and `npm test --workspace @hosty-sdk/app` | Build passed; 712 tests passed. |
| `dotnet build packages/app-sdk-dotnet/HostySdk.App/HostySdk.App.csproj` | net8.0 and net10.0 passed. |
| `npm run sdk:dotnet:test` | 70 passed, including create/edit requests with an explicit null assignee. |
| `npm run harness:lint` | API/web TypeScript and web ESLint passed. |
| `npm test --workspace @haas/hosty-harness` | Full suite passed: 164 files, 1790 tests after lifecycle, availability recovery, draft race and cross-app link fixes. |
| `npm test --workspace @haas/hosty-harness -- src/tasks src/profiles web/src/components/tasks.test.tsx web/src/components/session-model.test.tsx web/src/components/session-profile.test.tsx` | Review-fix suite passed: 9 files, 52 tests, including accepted-task selection/dispatch locks and draft recovery after Ready/Cancelled transitions. |
| `node --test scripts/test-integration.test.mjs` | 14 passed, including task and observability suites. |
| `HOSTY_TASKS_BROWSER=1 HOSTY_TASKS_BROWSER_CHANNEL=chrome npm run test:integration -- tasks` | Core/CLI/API/Worker builds and complete managed API/browser acceptance passed; the installed Playwright module was selected through HOSTY_TASKS_PLAYWRIGHT_MODULE. |
| `node scripts/check-versions.mjs`, `node scripts/docs-index.mjs --check --base 84ae98ce928ef663dc779f64c34374527c4f0b46`, `git diff --check` | Passed. |

The managed run verifies human review/rework, a profile execution with no workspace, explicit MCP
result versus an ordinary turn, cancellation during native work, an existing retained workspace,
an independent SDK producer/executor, a cross-app conversation URL, cancel-before-accept fencing and restart without replacement
attempts. Chrome verifies password login, Core app identity, UI creation/start/review/result, SSE
preservation of unsaved input, recovery after a concurrent Draft-to-Ready transition, and reload.
The complete managed journey passed again after the review fixes. Parent Finish confirmed child
resource removal; test
processes, ports, fixture data and synthetic credentials were removed.

The native provider is a scripted protocol fixture: paid/live-model behavior and quality were not
exercised. Cross-platform runtime suites and the full repository test matrix were not run because
this acceptance targets the affected components on macOS/Docker. Existing Core/compiler and .NET
SDK XML-comment warnings remain; builds completed without errors.

Artifact versions: platform 0.159.0 → 0.160.0; Harness API/web/Worker 0.73.0 → 0.74.7;
TypeScript SDK 0.35.1 → 0.36.0; .NET SDK 0.10.0 → 0.11.1. Other artifacts retain their versions.

Executor selection marks the draft dirty immediately. Delayed option responses preserve subsequent
title/description edits and are ignored after another selection, discard, navigation or submission.
External task providers receive an absolute conversation link built from Core's public Harness
endpoint; same-app links remain relative. An unavailable or invalid public origin omits the link.

## Canonical Core Access

The `/api/tasks/v1` and task MCP entry points mediate discovery, options, listing, read, creation,
replacement and actions across explicitly selected providers. Core and both SDKs share the task wire
contract; optional null fields are omitted while an explicit null assignee remains meaningful.
Provider storage and existing UI remain authoritative. See [Core MCP](../core-mcp/feature.md) for
receipt-bound executor dispatch, current origin revalidation and scoped workspace admission.

## Required-Input And Removal Verification (2026-11-05)

Deliverables D7-D13 of the completed Task Blockers, Outcomes And Removal plan are implemented and verified.
The registered macOS arm64 worktree passes affected task, Decision, Worker, Core and SDK checks.
The managed runtime uses separate users/data, Docker app services and normal Core login.

| Command / scope | Result |
| --- | --- |
| `npm run harness:test` | 2,399 of 2,400 passed; one Gateway HTTP test and its cleanup hook timed out in the full run. |
| `npm test --workspace @haas/hosty-harness -- src/gateway.test.ts` | All 64 passed on an isolated rerun; no source change or timeout relaxation. |
| Affected Harness suites | 668 passed; after the catalog fix, 295 boundary tests and 34 final catalog/continuation tests passed. |
| `npm test --workspace @hosty-sdk/app` | 781 passed; the subsequently expanded task-server file passes all four cases. |
| `dotnet test packages/app-sdk-dotnet/HostySdk.App.Tests/HostySdk.App.Tests.csproj` | 75 passed. |
| Core Decisions and provider mediation selections | 47 passed; the final expanded mediation selection passes 35 cases. |
| `npm run harness:lint` | API/web TypeScript and web ESLint passed. |
| `HOSTY_TASKS_BROWSER=1 HOSTY_TASKS_BROWSER_CHANNEL=chrome npm run test:integration -- tasks` | Final Core/CLI/API/Worker builds, managed task/Decision acceptance and Chromium checks passed. The installed Playwright module was selected with `HOSTY_TASKS_PLAYWRIGHT_MODULE`. |
| `node scripts/check-versions.mjs`, documentation/index validation and `git diff --check` | Passed. |

Real Codex and Claude each observe a missing required profile, create a Decision with a delivered
notification, park with confirmed native exit, accept the operator's answer and reread the actual
profile directory. Both complete the original attempt and session with the exact newly available
profile ID. Decisions exposes both pending tasks without opening either chat. Earlier attempts also
verify truthful failure: a catalog alias collision produced another required Decision or an explicit
unsuccessful outcome, never Done. The dedicated `task_executor_options` operation resolves that
collision; Core's canonical provider directory remains unchanged.

The scripted journey separately verifies five-minute parking and API/Worker restart, unknown-stop
protection, successful-result barriers, removal/restoration/replay, source attribution, independent
providers, retained drafts and narrow-screen Decisions. This is bounded required-input acceptance,
not an end-to-end application-development benchmark. Other operating systems and the full repository
matrix were not run. Existing compiler/package and SDK documentation warnings remain.

Parent Finish confirms removal of both the scripted test child and the real-provider sandbox,
including their processes, Docker services and temporary data. The implementation worktree is
retained. The operator’s live Core, Harness, profiles and demo task were not changed.

Artifact versions: Platform 0.174.1 → 0.175.0; Harness API/web/Worker 0.91.2 → 0.92.0;
TypeScript SDK 0.44.0 → 0.45.0; .NET SDK 0.14.0 → 0.15.0.

## Testing Expectations

- Required-input coverage includes registration failure, notification retry, replay, early answers,
  parking/restart, same-attempt continuation, cancellation, superseded success reports, optional
  questions and unknown stops. Real Codex/Claude acceptance is separate from scripted fixtures.
- Removal coverage includes reviewed descendant/batch scope, stale revisions, replay, active/native
  guards, external dependencies, owner/install boundaries, legacy cleanup and preserved history.

- Core provider contract tests cover empty registries, unrelated app IDs, confirmed roles,
  independent categories, installation binding, current user access and revoked grants.
- Both SDKs cover explicit selection, credential destinations, replay and changed installations.
  The .NET client preserves explicit null assignees when creating or editing an unassigned Draft.
- Harness tests cover concurrent numbering, prefix collisions, replay/current access, six statuses,
  default review policy, review revision/rework, retained outcomes, explicit task completion,
  cancel-before-accept, unknown exit, profile deletion, pre-admission failure, Local startup rejection,
  interrupted rejection persistence, confirmed abandonment, failed-stop recovery, unchanged-receipt
  availability recovery and credential-free
  observation/cancellation recovery. Worker tests keep only declared session MCP bearers across the
  native boundary and exclude app/Worker authority.
- UI tests cover SSE draft preservation, accessible discard/copy recovery after a background status
  change, and identical replay after a lost mutation response. Accepted task sessions lock their
  profile/model before dispatch and admit their first message only through the task executor.
- `npm run test:integration -- tasks` builds Core/CLI and both Harness images, then exercises the
  real API/Worker/MCP journey in a parent-managed child Core with separate password-authenticated
  users and data. A scripted Codex protocol fixture avoids paid providers while using real session
  transport, tool approval, native exit and workspace leases. An independent fixture consumes the
  SDK and executes work without profile concepts. This is not live-model quality evidence.
- Optional `HOSTY_TASKS_BROWSER=1` runs the Chromium journey through normal password login and Core
  app-code exchange, then UI creation/start/review/result, SSE draft preservation and reload.
  Playwright must be available; `HOSTY_TASKS_PLAYWRIGHT_MODULE` can name its installed module.
  Synthetic credentials travel only through stdin/in-memory browser context, never a saved state file.
- Parent Finish verifies child resource removal; native parent/Git processes and ports are checked
  before deleting successful fixture data. Failed diagnostic logs stay outside the repository.

---
created: 2026-10-27
updated: 2026-10-27
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

Automatic workspace allocation, task trees, orchestration, parked waits and artifact storage belong
to the separate [workspace coordination](../shared-tasks/plan.md),
[orchestration](../harness-work-orchestration/plan.md), [durable jobs](../durable-agent-jobs/plan.md),
[decisions](../shared-decisions/plan.md) and [artifacts](../shared-artifacts/plan.md) plans.

## Task Contract

A technical reference is `{appId, installationId, key, id}`; `id` is a UUID. The provider returns the
whole display `number` as an opaque string. Harness allocates `HRN-1`, `HRN-2`, and so on from one
collection counter, regardless of profile/workspace. UUID, counter and creation receipt share one
fsynced atomic write. Concurrent creation cannot reuse numbers. Request replay returns the original
number; provider-local prefixes may collide. Core never parses numbers or reserves prefixes.

Inputs contain `title` (200 characters), `markdown` (32000), `assignee` (human/app/null),
`requiresReview` (false when omitted), up to 32 `resources`, and optional `workspaceId`. HTTP requests also have the Harness-wide
64 KiB encoded-body limit; individual field limits do not override it.
Human assignment supplies a current user ID. Application assignment supplies a qualified executor
and optional opaque `optionId`. Ready resolves an executor default once; it does not silently change
an unavailable selection. Creator/owner attribution comes from authenticated callers.

A resource is `{kind, owner, id, label?, version}`. Kinds are `app`, `workspace` and `external`;
version is `{mode: "live"}` or `{mode: "pinned", revision}`. References are contextual information,
not copied content or grants. The immutable execution snapshot preserves their owner/version. This
adapter forwards references without resolving external content or replacing a pinned revision.
`workspaceId` separately selects an existing execution binding; an attachment alone does not do so.

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
success becomes `Blocked/needs_review`; only the owner can accept it or request changes against its
current input/result revision. Feedback returns stopped work to Draft. Ready again creates a new
attempt. Reopening Done/Cancelled preserves history and does not launch work.

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
| `GET /tasks?cursor=&limit=&status=` | Authorized tasks, opaque next cursor, maximum 100 per page. |
| `POST /tasks` | `{requestId, input}` creates Draft. |
| `GET /tasks/{id}` | Current authorized task. |
| `PATCH /tasks/{id}` | `{requestId, expectedRevision, input}` replaces Draft input. |
| `POST /tasks/{id}/actions` | Replayable lifecycle command. |
| `GET /options` (executor) | Opaque choices and optional default ID. |
| `PUT /executions/{executionId}` | Durable immutable acceptance; returns 202. |
| `GET /executions/{executionId}` | Retained authoritative receipt. |
| `POST /executions/{executionId}/cancel` | Idempotent `{requestId}` stop intent. |

Lifecycle commands are `ready`, `draft`, `start`, `complete`, `cancel`, `accept`, `request_changes`.
Each carries `requestId`, `expectedRevision` and `action`. `complete` includes a Markdown/resources
result. Review includes `resultInputRevision`; request_changes also includes feedback (4000 characters).
The same request ID/input recovers the original response before stale-revision checks; changed input
conflicts. Read current state afterwards to observe subsequent progress.

TypeScript SDK 0.36.0 exports `/tasks` and `/tasks/server` (`TaskClient`, `TaskExecutorClient`). .NET
SDK 0.11.0 exposes `HostyTaskClient`, `HostyTaskExecutorClient` and Core-owned wire records. SDKs obtain
fresh Core bindings per request, check the selected installation and preserve HTTP status/error codes.
They never retry a mutation or choose another provider implicitly. The service token travels only to
Core; the selected endpoint receives only its scoped provider token.

Harness also supplies its UI directory/options endpoints and `/events` SSE. Agent tools are
`task_options`, `task_list`, `task_get`, `task_create`, `task_edit`, `task_action`, `task_result`.
Management tools use the current session owner/credential. The result tool binds to its accepted
execution and passes through existing MCP policy; it cannot complete another task by supplying an ID.

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

User credentials remain in memory. Restart observes existing Worker/session evidence; an accepted
but unsent attempt waits for its owner to authenticate again, then resumes with the original ID.
Remote observation/dispatch similarly needs fresh authority. Recovery never stores an operator
credential or invents a replacement native run. Unknown termination stays visible and prevents
another attempt. A proven rejection before native admission permits explicit retry. Caught Local
startup failures persist non-admission before the rejected receipt; recovery honors this proof even
when the final session status write was interrupted. Failures after send remain uncertain.
Abandonment confirms Local task exit before discarding its run handle; an unconfirmed stop retains
that handle for recovery and does not prevent the sweep from processing other waiting sessions.
A failed lease release preserves durable native-exit proof. Stop can retry that cleanup after Core
recovers, including after Harness restart, without starting another process; successful cleanup clears
the recorded failure.
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
| `dotnet test apps/core/tests/Haas.Hosty.Core.Tests/Haas.Hosty.Core.Tests.csproj` with provider/manifest filters | 22 passed. |
| `npm run build --workspace @hosty-sdk/app` and `npm test --workspace @hosty-sdk/app` | Build passed; 712 tests passed. |
| `dotnet build packages/app-sdk-dotnet/HostySdk.App/HostySdk.App.csproj` | net8.0 and net10.0 passed. |
| `npm run sdk:dotnet:test` | 70 passed, including create/edit requests with an explicit null assignee. |
| `npm run harness:lint` | API/web TypeScript and web ESLint passed. |
| `npm test --workspace @haas/hosty-harness` | Full suite passed: 164 files, 1780 tests after Local, availability recovery, queued activation and lease cleanup fixes. |
| `npm test --workspace @haas/hosty-harness -- src/tasks src/profiles web/src/components/tasks.test.tsx web/src/components/session-model.test.tsx web/src/components/session-profile.test.tsx` | Review-fix suite passed: 9 files, 52 tests, including accepted-task selection/dispatch locks and draft recovery after Ready/Cancelled transitions. |
| `node --test scripts/test-integration.test.mjs` | 13 passed. |
| `HOSTY_TASKS_BROWSER=1 HOSTY_TASKS_BROWSER_CHANNEL=chrome npm run test:integration -- tasks` | Core/CLI/API/Worker builds and complete managed API/browser acceptance passed; the installed Playwright module was selected through HOSTY_TASKS_PLAYWRIGHT_MODULE. |
| `node scripts/check-versions.mjs`, `node scripts/docs-index.mjs --check --base c46f00a3ebe0536a918f5420fad859f41f913920`, `git diff --check` | Passed. |

The managed run verifies human review/rework, a profile execution with no workspace, explicit MCP
result versus an ordinary turn, cancellation during native work, an existing retained workspace,
an independent SDK producer/executor, cancel-before-accept fencing and restart without replacement
attempts. Chrome verifies password login, Core app identity, UI creation/start/review/result, SSE
preservation of unsaved input, recovery after a concurrent Draft-to-Ready transition, and reload.
The complete managed journey passed again after the review fixes. Parent Finish confirmed child
resource removal; test
processes, ports, fixture data and synthetic credentials were removed.

The native provider is a scripted protocol fixture: paid/live-model behavior and quality were not
exercised. Cross-platform runtime suites and the full repository test matrix were not run because
this acceptance targets the affected components on macOS/Docker. Existing Core/compiler and .NET
SDK XML-comment warnings remain; builds completed without errors.

Artifact versions: platform 0.158.1 → 0.159.1; Harness API/web/Worker 0.73.0 → 0.74.5;
TypeScript SDK 0.35.1 → 0.36.0; .NET SDK 0.10.0 → 0.11.1. Other artifacts retain their versions.

## Testing Expectations

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

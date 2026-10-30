---
status: Draft
created: 2026-10-26
updated: 2026-10-29
summary: Durable jobs and recoverable Harness sessions with scheduling, bounded context, same-provider continuation, budgets and decision waits.
components: [apps/harness, apps/core, packages/app-sdk, packages/app-sdk-dotnet]
---

# Durable Agent Jobs And Continuation

## Goal And Transfer

On 2026-10-26 the owner requested closing AI Agent Bridge D11 while splitting composable-work plans.
This Draft receives its entire unimplemented runner scope: durable jobs, scheduling, retry budgets,
notifications and consumption of Core background grants. D11 is retired by transfer, not marked
implemented. [AI Agent Bridge](../ai-agent-bridge/feature.md#ownership-after-rollout) records the
transfer; [Continuous App Access](../continuous-app-access/feature.md) retains grant issuance,
lifetime, revocation and verification. No runtime implementation is authorized by this Draft.

## Baseline And Target Behavior

Background sessions survive a closed tab and issue waiting notifications; worker journals retain
run evidence; PR lifecycle has its own observations. None is a general scheduled/retryable runner.
Reuse them as appropriate without creating another transcript, source registry or business task store.

The runner is an application or authorized client, initially proposed inside Harness. Core owns
common authority/resource and task contracts; task providers own task storage. Core does not own
the scheduling/model loop. A job represents accepted execution work and may link a shared task, session and provider run.
Not every task needs a schedule and not every monitoring job needs a development workspace.

The separately approved [Basic Tasks plan, D1-D3](../basic-tasks/feature.md#requirement-transfer), owns persisted task
dispatch, the three-operation receipt contract and the Harness adapter over existing journals.
The 2026-10-27 split makes that feature independent of this whole runner. This plan consumes that
acceptance/evidence for general jobs, automatic retries, schedules and parked waits rather than adding another task launch
path. Its existing D1-D7 remain unimplemented; current Worker recovery is not completion of them.

Persist acceptance, invoking app and authorizing user/grant, executor and opaque option, provider-qualified
task reference, delegation/resource scope, input/configuration revisions, budget, status, last
observation, next due time and audit correlation. Accept once per request identity;
claim execution durably so competing workers do not own the same attempt. Reconcile lost responses
and uncertain provider results before retrying side effects. Define cancellation and terminal evidence
separately from task acceptance. A receipt proves accepted work, not completed work.

Support explicit, scheduled and event-triggered work with bounded retries/backoff, concurrency,
elapsed time and model/tool cost. Specify missed schedule behavior and avoid duplicate dispatch after
restart. Notify through existing notification APIs on meaningful progress, completion, failure or
needed attention; persist delivery/retry outcome without blocking execution or fabricating delivery.

Consume current background grants and revalidate at dispatch/resume. Pause or stop when delegation
expires, assignment or app/user access is removed, or the action contract changes. Profile roles
are instructional; they do not introduce separate principals, grants or per-profile tool restrictions.
Define removed executor/profile handling without silently changing an accepted configuration.
Existing grant revocation cannot undo completed effects or prove an unrestricted process stopped.
Keep credentials outside model-visible state; resource leases last until native consumers stop.

For a decision, durably register the wait/continuation before presenting the question. A quick reply
can continue the live execution. After the resource-wait period, park and release confirmed stopped
compute while preserving context and input/output references. A saved answer can enqueue continuation
while the executor is offline. Reconcile answer/parking races and restart; consume it once without
starting competing continuations. Cancelled work cannot revive. Unsupported native resume uses the
approved recorded-context path or reports an explicit unsupported outcome.

## Session Recovery Transfer (2026-10-27)

[Vision decision 61](../../vision.md) retires switching providers inside one conversation. D7
receives the still-needed session command, continuation and bounded-context requirements from
former Shared History D2-D4. These extend Harness's existing SessionManager/SessionStore and apply
to ordinary chats as well as runner-backed work; a chat does not acquire a task or schedule merely
to recover. The runner consumes the same services instead of maintaining another transcript.

Persist accepted message/approval/cancel identities and revisions, reconcile uncertain responses
and competing clients, and distinguish accepted, interrupted, unknown and terminal observations.
Keep native execution IDs and consumed-event cursors bound to the exact provider connection and
account. Resume that execution only when supported; otherwise reconstruct for the same provider
from authorized recorded context or report an explicit unsupported result. Never reuse native IDs
under another account, silently change providers or replay prior tool effects or stale approvals.

Bound model input using recent turns, a versioned summary with explicit coverage and retrievable
earlier evidence/attachments, while retaining the visible transcript under the assistant's policy.
Re-read current source/plan revisions after another session changes them and mark stale observations.
Pending waits retain the checkpoint and referenced inputs through ordinary idle expiry; cleanup
and revoked access remain explicit. Context limits, summary policy and attachment retention need
design before Ready. [Shared Artifacts](../shared-artifacts/plan.md) owns selected cross-session
handoffs; it neither imports a whole private transcript nor transfers provider-native hidden state.

## Workspace Maintenance Consumer (Owner Decision, 2026-10-29)

A job with application workspace authority and a valid authorizing user's rights can inspect the
entire workspace collection. Preserve the initiating user in the established background grant;
job/profile/session identity creates no extra resource ACL. Existing authorization covers recurring
operations without new per-workspace consent.

[Workspace Permissions And Deletion](../external-workspace-access-continuity/feature.md#one-delete-operation)
owns collection/deletion semantics. A delete-only-completed-and-merged job checks those requested
predicates. An explicit delete-all command can remove unfinished source too, without per-item
permission or mandatory integration proof. The workspace service owns actual execution/recovery;
this plan owns schedule, claims, retries and reporting. These examples create no live automation
and authorize no deletion during planning.

## Assistant Event Admission (2026-10-29)

[Assistant Events And Session Continuation](../assistant-events-and-continuation/plan.md) owns the
cross-app activity/conversation binding, inbound-event receipt and admission contract. Its assistant
adapter maps an eligible event to D7's common idempotent session command; it does not own a second
recovery engine, transcript or scheduler. Interactive chess uses this path without creating a task
or scheduled job for each turn. Delegated task results can satisfy a registered parent wait.

D7 here retains provider/account-bound recovery and bounded context, while D1-D5 retain job policy
and parked waits. Coordinate source/receipt/command IDs, busy/paused/cancelled behavior and unknown
acceptance with that consumer. Its approval does not approve this plan. Agree delivery boundaries
before Ready if the ordinary-session primitive is needed ahead of general scheduling; no deliverable
is transferred or completed by this coordination note.

## Domain-Neutral Routine Triggers (2026-10-29)

The owner clarifies that PR processing is one possible routine, not the runner's event model.
Configure a compatible source/event type, bounded filter, action/executor choice, budgets and
authority without requiring GitHub, a repository or an existing conversation. The owning source
defines subject/revision semantics; PR/head grouping below is one adapter-specific policy.
Application job results, activity changes and addressed answers must fit the same activation and
recovery contract. This generality belongs to existing D1-D3 and the assistant-event contract.
Neither a new PR inbox nor a decision to implement PR automation first is a prerequisite.

## Event-Triggered Routine Example (2026-10-29)

The owner's Dependabot example extends the existing event-triggered runner scope. Its PR source
derives repository membership from installed applications, deduplicating shared repositories and
reconciling install/uninstall/source changes. It has no favorites or manual repository enrollment.
A routine keeps event/author/update filters, action instructions or skill references, assistant/
executor selection, configuration revision, budgets and action policy. Display filters in the PR
panel do not alter the routine's subscription or the underlying installed-app scope. Reuse app-owned profile choices;
there is no shared Core agent principal. A routine can create new work when no chat exists, whereas
later CI changes and decision answers can continue its already accepted work.

Consume [Assistant Events And Session Continuation](../assistant-events-and-continuation/plan.md#design-consumer-repository-events-and-dependabot-routines)
and Notifications D6. Persist activation identity before creating the job/session, reconcile lost
responses and prevent competing workers or repeated observations from creating duplicate reviews.
Group logical work by routine/configuration, repository, PR and head revision; keep event identity,
retry attempts and deliberate reanalysis separate. Filter and wait for required CI without periodic
model invocations. Define initial/backfill behavior, concurrency and invalidation after a new head.

Policy can report only, request a decision, or perform a bounded action under previously configured
authority. Ask-first uses [Shared Decisions](../shared-decisions/plan.md); its persisted answer resumes
the same work. Automatic mode does not ask again within its authorized scope, but still rechecks
current rights, exact reviewed revision and repository merge conditions. A routine recommendation
is not a grant. Unattended operation consumes existing background grants and survives a closed UI.

D1-D3 here retain routine/job activation and recovery; D4 retains parked decisions. Repository-wide
PR discovery and the aggregate view now belong to the separate
[Harness Pull Request Inbox](../harness-pull-request-inbox/feature.md), developed from I18. Its
read-only view works without this runner. Existing workspace publication APIs must not be assumed to merge arbitrary
external PRs without a supported contract. No live routine, GitHub mutation or implementation is
authorized by this example.

## Dependencies And Ownership

- [Agent Providers](../agent-provider-interface/plan.md) owns invocation, results, cancellation and
  capability declarations for separately provided model/agent execution. The initial Harness task
  path can use its internal runtime; extraction is not a prerequisite. D7 here owns Harness session
  commands, context and continuation cursors;
  [Action Summary D4](../assistant-action-summary/plan.md#deliverables) owns the shared journal/event foundation.
- [Shared Decisions](../shared-decisions/plan.md) owns question/response records;
  [Notifications D6](../notifications/plan.md#deliverables) owns durable subscriptions. The runner
  owns consumption, scheduling, deduplication and reconciliation, not a new event bus.
- [Basic Tasks](../basic-tasks/feature.md) owns task state, explicit resources and the task executor
  adapter; its contract leaves records with a task-provider app. [Task Workspace Coordination](../shared-tasks/plan.md)
  owns automatic source binding/reuse. [Artifacts](../shared-artifacts/plan.md) owns retained content.
  Neither task ownership nor an executor-option label is a new credential.
- [Harness Work Orchestration](../harness-work-orchestration/plan.md) owns hierarchy, child-task
  relationships, decomposition and workflow policy. General scheduled/retryable work uses this
  runner; Basic Tasks direct dispatch does not require it or create a competing scheduler.
- Registered workspaces, publication, Sandbox and [Execution Authorization](../assistant-execution-authorization/plan.md)
  keep their existing APIs and authority. Source jobs reuse collision/lease checks and isolated
  validation; this plan creates no second development task registry or automatic merge permission.
- [Application Resource Policy](../app-resource-policy/plan.md) owns runtime caps; this runner
  tracks job/retry/aggregate budgets. Provider-specific usage limits remain with the invocation owner.

## Deliverables

- [ ] D1. Define durable job/attempt/wait identity, accepted-command ownership, scheduling and cancellation states, persisted observations, audit correlation and boundaries with tasks, sessions and provider runs; include versioned event-triggered routine configuration and recoverable creation of work before a conversation exists.
- [ ] D2. Define current-grant dispatch, revocation/assignment/executor-option/contract-change behavior and recovery from uncertain effects; specify schedule/missed-run policy, concurrency, retry/backoff, time and cost budgets, including event filters, initial/backfill policy, trigger deduplication and input-revision invalidation for configured routines.
- [ ] D3. After explicit Ready approval, implement persistence, claims, scheduling and retry/recovery over provider and resource APIs, including notification delivery bookkeeping and observable stopped/failed outcomes.
- [ ] D4. Implement recoverable live/parked decision waits and response-triggered continuation with Shared Decisions and the D7 session recovery contract, preserving pending inputs, stopped-consumer lease discipline and cancellation.
- [ ] D5. Verify recurring monitoring and one authorized source job, restart/duplicate claims, lost provider responses, expired/revoked grants, budget exhaustion and failed notification delivery; cover overnight and response/parking races without duplicate effects.
- [ ] D6. Document shipped behavior and compatibility in feature.md, reconcile consumers and remove this plan when all deliverables pass; preserve the historical Bridge D11 and session-recovery transfers without claiming they shipped earlier.
- [ ] D7. Define, implement after Ready approval, and verify common idempotent Harness session commands, provider/account-bound continuation cursors and bounded recoverable context over the existing journal; cover ordinary chats and parked jobs, multi-client send/approval races, restart, unsupported resume, summary coverage, changed source and retention/revocation without duplicate tool effects.

## Proposed Sequence

Resolve D1-D2 alongside invocation and event contracts. Build one explicit durable job before adding
schedules and retries; then integrate decision waits. Verify general monitoring and source work
separately. The first Harness manual Ready flow needs durable acceptance, attempt claims and result
reconciliation; schedules, team hierarchy and parked decisions are later consumers, not creation
prerequisites. Basic Tasks and its Harness adapter can deliver direct commands over existing Worker
evidence before this general runner. This plan owns additional job scheduling/attempt policy and
parked continuation; it consumes the same task-execution receipts where work is task-backed.

## Open Questions

- What persistence/claim mechanism fits one host and separately deployed compatible executors?
- Which retry classes are safe, and which uncertain effects require reconciliation or human attention?
- Which provider capabilities support native resume, reconstruction or neither, and what context
  budget, summary coverage and attachment/checkpoint retention fit each supported path?
- What are the resource-wait default, missed-schedule policy, cancellation propagation and aggregate budget rules?

## Verification

For this Draft, validate documents and links. Future tests must interrupt acceptance, dispatch,
response persistence and parking, then recover with no lost accepted work or duplicate side effects.
Exercise authorized success beside denial, revocation while waiting, disconnected observers,
notification failures and a stopped executor. Repeat D7 with Codex and Claude in separate ordinary
chats, with no scheduler and with AHP disabled; preserve native attribution, visible history and
current permissions after restart, and leave unknown effects unresolved rather than retrying them.
Source scenarios use registered workspaces and managed sandboxes; passing a sandbox never authorizes merge, production rollout or unrelated cleanup.

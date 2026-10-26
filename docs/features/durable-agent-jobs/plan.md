---
status: Draft
created: 2026-10-26
updated: 2026-10-26
summary: Durable agent job execution, schedules, retry and resource budgets, notifications and recoverable decision waits using existing authority and resource APIs.
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
common authority/resource contracts and candidate shared tasks, not the scheduling/model loop.
A job represents accepted execution work and may link a shared task, session and provider run.
Not every task needs a schedule and not every monitoring job needs a development workspace.

Persist acceptance, caller/participant, executor, delegation/resource scope, input revisions, budget,
status, last observation, next due time and audit correlation. Accept once per request identity;
claim execution durably so competing workers do not own the same attempt. Reconcile lost responses
and uncertain provider results before retrying side effects. Define cancellation and terminal evidence
separately from task acceptance. A receipt proves accepted work, not completed work.

Support explicit, scheduled and event-triggered work with bounded retries/backoff, concurrency,
elapsed time and model/tool cost. Specify missed schedule behavior and avoid duplicate dispatch after
restart. Notify through existing notification APIs on meaningful progress, completion, failure or
needed attention; persist delivery/retry outcome without blocking execution or fabricating delivery.

Consume current background grants and revalidate at dispatch/resume. Pause or stop when delegation
expires, assignment or participant access is removed, role changes or the action contract changes.
Existing grant revocation cannot undo completed effects or prove an unrestricted process stopped.
Keep credentials outside model-visible state; resource leases last until native consumers stop.

For a decision, durably register the wait/continuation before presenting the question. A quick reply
can continue the live execution. After the resource-wait period, park and release confirmed stopped
compute while preserving context and input/output references. A saved answer can enqueue continuation
while the executor is offline. Reconcile answer/parking races and restart; consume it once without
starting competing continuations. Cancelled work cannot revive. Unsupported native resume uses the
approved recorded-context path or reports an explicit unsupported outcome.

## Dependencies And Ownership

- [Agent Providers](../agent-provider-interface/plan.md) owns invocation, results, cancellation and
  capability declarations; [Shared History](../assistant-shared-history/plan.md) owns context/cursors.
- [Shared Decisions](../shared-decisions/plan.md) owns question/response records;
  [Notifications D6](../notifications/plan.md#deliverables) owns durable subscriptions. The runner
  owns consumption, scheduling, deduplication and reconciliation, not a new event bus.
- [Shared Tasks](../shared-tasks/plan.md) owns task/child state and workspace bindings;
  [Artifacts](../shared-artifacts/plan.md) owns retained results.
- [Harness Work Orchestration](../harness-work-orchestration/plan.md) owns agent hierarchy, business
  decomposition and workflow policy. It submits work to this runner rather than building a scheduler.
- Registered workspaces, publication, Sandbox and [Execution Authorization](../assistant-execution-authorization/plan.md)
  keep their existing APIs and authority. Source jobs reuse collision/lease checks and isolated
  validation; this plan creates no second development task registry or automatic merge permission.
- [Application Resource Policy](../app-resource-policy/plan.md) owns runtime caps; this runner
  tracks job/retry/aggregate budgets. Provider-specific usage limits remain with the invocation owner.

## Deliverables

- [ ] D1. Define durable job/attempt/wait identity, accepted-command ownership, scheduling and cancellation states, persisted observations, audit correlation and boundaries with tasks, sessions and provider runs.
- [ ] D2. Define current-grant dispatch, revocation/assignment/role/contract-change behavior and recovery from uncertain effects; specify schedule/missed-run policy, concurrency, retry/backoff, time and cost budgets.
- [ ] D3. After explicit Ready approval, implement persistence, claims, scheduling and retry/recovery over provider and resource APIs, including notification delivery bookkeeping and observable stopped/failed outcomes.
- [ ] D4. Implement recoverable live/parked decision waits and response-triggered continuation with Shared Decisions and Shared History, preserving pending inputs, stopped-consumer lease discipline and cancellation.
- [ ] D5. Verify recurring monitoring and one authorized source job, restart/duplicate claims, lost provider responses, expired/revoked grants, budget exhaustion and failed notification delivery; cover overnight and response/parking races without duplicate effects.
- [ ] D6. Document shipped behavior and compatibility in feature.md, reconcile consumers and remove this plan when all deliverables pass; preserve the historical Bridge D11 transfer without claiming it shipped earlier.

## Proposed Sequence

Resolve D1-D2 alongside invocation and event contracts. Build one explicit durable job before adding
schedules and retries; then integrate decision waits. Verify general monitoring and source work
separately. The first Harness composition consumes this implementation without requiring a team hierarchy.

## Open Questions

- What persistence/claim mechanism fits one host and separately deployed compatible executors?
- Which retry classes are safe, and which uncertain effects require reconciliation or human attention?
- Which provider capabilities support native resume, reconstruction or neither?
- What are the resource-wait default, missed-schedule policy, cancellation propagation and aggregate budget rules?

## Verification

For this Draft, validate documents and links. Future tests must interrupt acceptance, dispatch,
response persistence and parking, then recover with no lost accepted work or duplicate side effects.
Exercise authorized success beside denial, revocation while waiting, disconnected observers,
notification failures and a stopped executor. Source scenarios use registered workspaces and managed
sandboxes; passing a sandbox never authorizes merge, production rollout or unrelated cleanup.

---
status: Draft
created: 2026-10-26
updated: 2026-11-04
summary: Deferred task-list presentation, artifact and human-review composition and selected material access beyond profile-based task delegation.
components: [apps/harness]
---

# Harness Work Orchestration

## Goal And Deferred Boundary

Compose richer human/agent work over the independently deliverable
[Basic Tasks And Execution](../basic-tasks/feature.md) feature. On 2026-10-27 the owner approved the basic
plan as Ready and deferred automatic workspace coordination, artifacts, waits and hierarchy.
[Vision decision 64](../../vision.md) records this split. This plan remains Draft; it no longer owns
the first manual/API task store, executor adapter, task UI or simple result review.

The basic feature is shipped; its delivery does not approve this broader composition. The owner
selects flat profile-based delegation on 2026-11-04, without an Organization app or saved-team model
for the selected scope. Core stays independent of Harness routes, first-party IDs and business roles.

## Target Behavior

Integrate retained artifacts and addressed decisions with task work, including overnight waiting,
parked continuation and executor restart. Combine task/decision/artifact views over their public
contracts, preserving material versions and respondent access. A document can be an optional
producer/input, never a prerequisite for tasks or the owner of their execution semantics.

[Profile-Based Task Delegation](../profile-task-delegation/feature.md) now owns visible child tasks,
flat routing among profile choices, dependencies, bounded delegation and coordinator review. The
2026-11-04 direction does not select a reporting hierarchy or saved teams. This plan retains richer
artifact/human workflow composition and selected cross-session material access, consuming those
task contracts rather than defining another registry or agent identity.

Human reviewers may perform stages, receive addressed questions and accept materials. Simple
requiresReview task acceptance already belongs to Basic Tasks and does not depend on this inbox.
Here the runner handles durable waits, schedules/retries where selected and response-driven
continuation. Keep workflow policy in Harness and do not build a competing scheduler.

Related source delegation normally passes the selected workspace. The proposed
[workspace-permission foundation](../external-workspace-access-continuity/feature.md) permits the full
collection when both the application and initiating user have the operation right. Preserve that
user through task delegation and provider handoffs without per-workspace or per-agent consent.
Workspace selection is execution context, not an allowlist. Collection operations need no primary
workspace or conversation attachment. The transferred delegation plan owns writer coordination,
not another access gate.

Related task work normally keeps that selected workspace. An unrelated bugfix can receive
an explicitly independent workspace and PR. [Task Workspace Coordination](../shared-tasks/plan.md)
retains general allocation/reuse and reverse references; the selected root/child binding and
writer/integration policy are transferred to Profile-Based Task Delegation. Shared source is not
same-file isolation, and task completion does not implicitly publish changes or remove resources.

Reuse [Shared Agent Profiles](../agent-profiles/feature.md), their editor, the current Core skill
library and existing conversation/workspace/preview views. Profiles remain Harness-internal named
configurations. Existing app/user/MCP authority applies to all profile choices. No memory service,
UI widget framework, cross-app profile sharing or full Paperclip parity is required.

## Separate Sessions And Context Access (2026-10-27)

[Vision decision 61](../../vision.md) selects separate conversations with their own provider/profile,
sharing a workspace when appropriate. Planning, implementation and review pass selected context
through [Shared Artifacts](../shared-artifacts/plan.md); orchestration coordinates those handoffs.
Switching Codex and Claude inside a started conversation is no longer a deliverable.

D7 receives the remaining visibility requirements of former Shared History D6. Keep existing
private conversation ownership as the baseline. Specify explicit access to selected evidence and
destination sessions for artifacts, feedback, external context and client reads. Workspace/task
membership, a profile and administrator status do not automatically share private transcripts,
attachments or credentials. Revalidate current access on reconnect, reads and actions, including
derived summaries; revoked access must not persist through cached results. Sharing an entire
conversation needs its own selected contract rather than being implied by this transfer.
These are material/session boundaries, not a new per-profile permission system.

Owner clarification, 2026-10-30: [Conversation History](../conversation-history/feature.md) now owns
Core's common history schema and API/MCP for explicitly authorized sharing/search. D7 consumes its
history access and source references for orchestration UI/context selection instead of defining a
second history contract. Exact whole-conversation/excerpt and live-reference/snapshot semantics
remain in that plan's D2. Private-by-default access and the exclusion of in-chat provider switching
remain; a common API is not blanket transcript sharing. Qdrant integration is deferred.

## Delegated Results And Parent Continuation (2026-10-29)

[Assistant Events And Session Continuation](../assistant-events-and-continuation/plan.md) owns the
minimal exchange from an authorized task result to a registered parent-session wait. It correlates
task/provider/attempt/result evidence and selected accessible output, including failures and late
completion, without importing the child's private conversation. Existing native subagent completion
must not also enter the parent through an independent duplicate delivery path.

D4's flat task decomposition, relationships, routing, aggregate budgets and cancellation policy
are transferred to [Profile-Based Task Delegation](../profile-task-delegation/feature.md). D7 retains
selected session/material visibility beyond its bounded task/result handoff. The delegated-result
plan also receives the first same-Harness wait consumer; broader cross-application event delivery
stays with its original owner. Reuse common session primitives rather than a second session engine.

## Independent PR Entry Point (2026-10-29)

[Harness Pull Request Inbox](../harness-pull-request-inbox/feature.md) owns the aggregate page/panel for
active PRs from repositories derived from installed applications, including external PRs with no
task/workspace/conversation. Shared repositories appear once with their associated apps.
It can show authorized links to related work and decisions, but it neither owns this plan's joined
decision UI nor depends on it to browse. Event-triggered analysis remains with the common
runner; PRs do not become the universal subject of orchestration. The owner selects the independent
PR browsing page/panel first; its technical plan is Ready without starting implementation. Richer
orchestration and event-triggered automation remain separate and retain this plan's Draft status.

## Dependencies And Ownership

- [Basic Tasks](../basic-tasks/feature.md) owns the common task/provider/executor contract, provider
  numbering/statuses, direct dispatch recovery, profile adapter, base task UI and simple review.
- [Profile-Based Task Delegation](../profile-task-delegation/feature.md) receives D4 and owns the
  selected flat task/workspace flow. [Task Workspace Coordination](../shared-tasks/plan.md) retains
  general allocation/reuse and reverse observations outside that bounded transfer.
- [Shared Artifacts](../shared-artifacts/plan.md) owns retained content and selected handoffs;
  [Shared Decisions](../shared-decisions/feature.md) owns addressed request/response records;
  [Durable Agent Jobs](../durable-agent-jobs/plan.md) owns general scheduling/retries and parked waits.
- [Notifications D6](../notifications/plan.md#deliverables) owns durable domain subscriptions for
  transition-driven integrations; Basic Tasks needs only direct requests and HTTP/SSE recovery.
- [Agent Providers](../agent-provider-interface/plan.md) owns independent public model invocation;
  [Plan Provider](../plan-provider-interface/plan.md) owns optional source-document semantics.
- [Durable Agent Jobs D7](../durable-agent-jobs/plan.md#deliverables) retains broader common session
  recovery/context; [Action Summary D4](../assistant-action-summary/plan.md#deliverables) retains
  correlated journal work. Basic Tasks consumes existing Worker behavior without completing them.

Ordinary-user operator-session prerequisites retain their current status. Human task assignments
and task result visibility do not automatically share private conversations or create new rights.

## Transfer Record (2026-10-27)

| Original deliverable | Current owner |
| --- | --- |
| D1: profile-backed executor selection, snapshots and basic review | [Basic Tasks D3-D4](../basic-tasks/feature.md#requirement-transfer) |
| D2: manual/API create/assign/Ready/result and execution adapter | [Basic Tasks D2-D5](../basic-tasks/feature.md#requirement-transfer) |
| D3: base task UI | [Basic Tasks D4](../basic-tasks/feature.md#requirement-transfer); joined artifact/decision views remain D3 here |
| D5-D6: base task acceptance/documentation | [Basic Tasks D5-D6](../basic-tasks/feature.md#requirement-transfer); richer composition acceptance/documentation remain here |
| D7: current task/session privacy baseline | Preserved by [Basic Tasks D3-D5](../basic-tasks/feature.md#requirement-transfer); cross-session material/client integration remains D7 here |

D1-D2 are retired by transfer and must not be reused. No deliverable is checked merely because its
scope moved. D3-D7 retain their original IDs in this historical transfer; D4 is subsequently
transferred below.
None is required to finish Basic Tasks.

## Decisions-First Delivery Refinement (2026-11-03)

The owner approved the Decisions-first boundary on 2026-11-03. [Shared Decisions](../shared-decisions/feature.md)
implements the decision-only part transferred from D3: one queue, shared chat/inbox responses and
projections of existing permissions, task review and recovery. It does not require artifact storage,
hierarchy or the rest of this composition.

D3 here consumes that page for richer task/artifact presentation and human-review routing. D4-D7
retain their remaining scope. Completing the transferred behavior does not complete these broader
deliverables or authorize implementation of this Draft.

## Flat Delegation Transfer (2026-11-04)

[Profile-Based Task Delegation](../profile-task-delegation/feature.md) receives D4's task relationships,
decomposition, routing, budgets, cancellation and writer/integration scope plus the corresponding
bounded task/result acceptance. D4 is retired by transfer, not implemented, and must not be reused.
The optional static reporting hierarchy is superseded by the selected flat profile pool. Saved
teams and separate named agents are not part of the selected work.

D3 retains richer artifact presentation/human-review routing; D5 retains acceptance of that richer
composition; D7 retains cross-session material integration beyond selected task text/results. The
new plan does not require a shared artifact service or complete these remaining deliverables.

## Deferred Task-List Presentation (2026-11-04)

The owner keeps the existing task-list layout while the first profile-delegation flow is developed.
Its root/parent/dependency data is mandatory regardless of presentation. The root-only default,
expandable children and other task-list grouping proposed in Profile-Based Task Delegation D7 are
deferred here for later design under D3; no UI approach is selected or implemented by this transfer.
That plan's D7 retains execution attribution through existing reads/details and compatibility checks.
The owner's subsequent workspace-details clarification belongs to that same D7: show associated
root tasks and all authorized execution sessions, prioritizing recorded profile names. This scoped
sidebar change is selected for the delegation plan; only the global task-list hierarchy remains
deferred here. A separate responsible-person presentation is not selected by that clarification.

## Deliverables

- [ ] D3. Design and implement the deferred task-list hierarchy presentation, evaluating root-only and expandable-child views, alongside richer joined task/artifact presentation and reviewer routing over Basic Tasks and Shared Decisions; reuse authorized profile/session/workspace views without making this UI a prerequisite of initial profile delegation.
- [ ] D5. Verify richer artifact/overnight-decision, human QA and independent bugfix/PR composition with an independent API consumer, consuming the transferred task-delegation acceptance; cover stale materials and revoked access without private-store coupling or first-party-ID privilege.
- [ ] D6. Record shipped orchestration behavior and limits in feature.md, retain the transfer history, reconcile the umbrella and underlying owners without marking unfinished deliverables complete, and regenerate the index.
- [ ] D7. Define and verify session/material visibility for cross-session work, preserving private conversation ownership and explicit selected-context access; integrate destination-session checks and current authorization for attachments, feedback, external imports and clients, including cross-administrator denial and revocation after reconnect.

## Sequence And Open Questions

Basic Tasks is shipped. The selected flat delegation slice has its own Ready technical plan and
explicit transfer record; the owner has not instructed starting its implementation. Refine this remaining artifact/human composition with its owners before separate Ready
approval, then implement its complete feature on one branch/PR. Do not reopen basic task decisions.

- Which joined views reuse existing navigation and panels?
- Which richer artifact/human workflow semantics extend the transferred task/result contracts?
- Which human-review/escalation policy and parked-continuation behavior compose the shared services?
- When would a separate application justify UI composition/extraction?

## Verification

Documentation checks validate retained ownership and links. Later runtime acceptance uses real Core
identity and managed preview URLs with separate test users/data. Verify overnight continuation once,
answer/parking races, composed delegated outcomes, human QA, stale materials,
revocation and retained outputs after temporary resource cleanup. Existing role instructions are not
represented as an enforced security boundary. Basic manual task acceptance does not close this plan.

---
status: Draft
created: 2026-10-26
updated: 2026-10-29
summary: Deferred Harness task decomposition, hierarchy, artifact and decision integration, parked continuation and selected cross-session context access.
components: [apps/harness]
---

# Harness Work Orchestration

## Goal And Deferred Boundary

Compose richer human/agent work over the independently deliverable
[Basic Tasks And Execution](../basic-tasks/feature.md) feature. On 2026-10-27 the owner approved the basic
plan as Ready and deferred automatic workspace coordination, artifacts, waits and hierarchy.
[Vision decision 64](../../vision.md) records this split. This plan remains Draft; it no longer owns
the first manual/API task store, executor adapter, task UI or simple result review.

The basic feature is shipped; its delivery does not approve this broader composition. A separate Organization app and its name remain open;
Core stays independent of Harness routes, first-party IDs and business roles.

## Target Behavior

Integrate retained artifacts and addressed decisions with task work, including overnight waiting,
parked continuation and executor restart. Combine task/decision/artifact views over their public
contracts, preserving material versions and respondent access. A document can be an optional
producer/input, never a prerequisite for tasks or the owner of their execution semantics.

Add optional decomposition into visible child tasks, routing among app-owned profile choices and
humans, and an application-owned agent hierarchy. Task parentage and reporting relationships are
independent. Define the task relationship API additions with the common task contract rather than
creating another registry. A coordinator uses the existing profile model; do not add a Core agent
principal, shared profile configuration or hard role-based tool restrictions.

Human reviewers may perform stages, receive addressed questions and accept materials. Simple
requiresReview task acceptance already belongs to Basic Tasks and does not depend on this inbox.
Here the runner handles durable waits, schedules/retries where selected and response-driven
continuation. Keep workflow policy in Harness and do not build a competing scheduler.

Related source delegation normally passes the selected workspace. The proposed
[workspace-permission foundation](../external-workspace-access-continuity/feature.md) permits the full
collection when both the application and initiating user have the operation right. Preserve that
user through the agent hierarchy and provider handoffs without per-workspace or per-agent consent.
Workspace selection is execution context, not an allowlist. Collection operations need no primary
workspace or conversation attachment. This plan owns writer coordination, not another access gate.

Related task work normally keeps that selected workspace. An unrelated bugfix can receive
an explicitly independent workspace and PR. [Task Workspace Coordination](../shared-tasks/plan.md)
owns allocation/reuse and reverse references; this plan owns delegation policy, writer coordination
and integration. Shared source is not same-file isolation, and task completion does not implicitly
publish changes or remove resources.

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

## Delegated Results And Parent Continuation (2026-10-29)

[Assistant Events And Session Continuation](../assistant-events-and-continuation/plan.md) owns the
minimal exchange from an authorized task result to a registered parent-session wait. It correlates
task/provider/attempt/result evidence and selected accessible output, including failures and late
completion, without importing the child's private conversation. Existing native subagent completion
must not also enter the parent through an independent duplicate delivery path.

D4 here retains decomposition, child relationships, hierarchy, routing, aggregate budgets and
cancellation policy; D7 retains selected session/material visibility. One explicit child-result
exchange does not deliver this richer orchestration or require an organization tree. Consume the
shared event/continuation contract rather than adding another wakeup channel or session engine.

## Independent PR Entry Point (2026-10-29)

[Harness Pull Request Inbox](../harness-pull-request-inbox/feature.md) owns the aggregate page/panel for
active PRs from repositories derived from installed applications, including external PRs with no
task/workspace/conversation. Shared repositories appear once with their associated apps.
It can show authorized links to related work and decisions, but it neither owns this plan's joined
decision UI/hierarchy nor depends on them to browse. Event-triggered analysis remains with the common
runner; PRs do not become the universal subject of orchestration. The owner selects the independent
PR browsing page/panel first; its technical plan is Ready without starting implementation. Richer
orchestration and event-triggered automation remain separate and retain this plan's Draft status.

## Dependencies And Ownership

- [Basic Tasks](../basic-tasks/feature.md) owns the common task/provider/executor contract, provider
  numbering/statuses, direct dispatch recovery, profile adapter, base task UI and simple review.
- [Task Workspace Coordination](../shared-tasks/plan.md) owns automatic allocation/reuse and reverse
  task observations. This plan D4 consumes those bindings without duplicating their implementation.
- [Shared Artifacts](../shared-artifacts/plan.md) owns retained content and selected handoffs;
  [Shared Decisions](../shared-decisions/plan.md) owns addressed request/response records;
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
scope moved. D3-D7 retain their original IDs; none is required to finish Basic Tasks.

## Deliverables

- [ ] D3. Implement the joined task/decision/artifact presentation and artifact/question/parked-continuation flow over the basic task UI and shared contracts, reusing profile/session/workspace views with accessible materials and current authorization.
- [ ] D4. Implement task relationship extensions, optional decomposition and hierarchy-driven delegation among app-owned profile choices and humans, with visible assignments, explicit handoffs, bounded fan-out, writer/integration policy and workspace coordination through its owning APIs.
- [ ] D5. Verify the richer artifact/overnight-decision, human QA, hierarchy and independent bugfix/PR journeys with an independent API consumer; cover child cancellation/acceptance, stale materials and revoked access without private-store coupling or first-party-ID privilege.
- [ ] D6. Record shipped orchestration behavior and limits in feature.md, retain the transfer history, reconcile the umbrella and underlying owners without marking unfinished deliverables complete, and regenerate the index.
- [ ] D7. Define and verify session/material visibility for cross-session work, preserving private conversation ownership and explicit selected-context access; integrate destination-session checks and current authorization for attachments, feedback, external imports and clients, including cross-administrator denial and revocation after reconnect.

## Sequence And Open Questions

Deliver Basic Tasks independently. Refine this composition with its artifact/decision/runner/workspace
owners before separate Ready approval, then implement this feature on one branch/PR. Do not reopen
basic numbering/status/launch decisions merely to add hierarchy.

- Which joined views reuse existing navigation and panels?
- How do overlapping work, bounded delegation, child cancellation and acceptance aggregation behave?
- Which human-review/escalation policy and parked-continuation behavior compose the shared services?
- When would a separate application justify UI composition/extraction?

## Verification

Documentation checks validate retained ownership and links. Later runtime acceptance uses real Core
identity and managed preview URLs with separate test users/data. Verify overnight continuation once,
answer/parking races, cancelled children and late results, hierarchy with human QA, stale materials,
revocation and retained outputs after temporary resource cleanup. Existing role instructions are not
represented as an enforced security boundary. Basic manual task acceptance does not close this plan.

---
status: Draft
created: 2026-10-26
updated: 2026-10-29
summary: Deferred automatic workspace allocation, reuse and reverse observation across tasks, building on the independent basic task contract.
components: [apps/core, apps/harness, packages/app-sdk, packages/app-sdk-dotnet]
---

# Task Workspace Coordination

## Remaining Scope And Ownership

On 2026-10-27 the owner split the independently shippable
[Basic Tasks And Execution](../basic-tasks/feature.md) feature and explicitly approved its Ready status.
That feature now provides the task schema, provider numbering, six statuses, Core/SDK APIs, task storage,
direct execution, Harness task UI and simple result review. This stable feature folder retains only
automatic task/workspace coordination for later design. [Vision decision 64](../../vision.md)
records the split; this remaining plan is Draft and is not a dependency of basic task delivery.

Basic Tasks supports optional resource references and explicit selection of an existing authorized
workspace. This plan extends that baseline with allocation/reuse across related tasks and reverse
observation. It does not implement another task store, checkout backend, model runner or permissions
system. Task trees and agent hierarchy remain in
[Harness Work Orchestration](../harness-work-orchestration/plan.md).

## Target Behavior

Related source work normally reuses a selected workspace. Define an allocation scope and durable
request identity so concurrent requests and retries resolve one authorized binding without duplicate
worktrees. Allow an explicit independent binding for an unrelated bugfix and PR; task parentage must
not force one workspace per tree. Preserve discovery/related-task context without implying that the
same source resource or branch must serve both pieces of work.

[Workspace Permissions And Deletion](../external-workspace-access-continuity/feature.md) owns
collection-wide app/user operation authority. Agent/session/provider reassignment preserves the
initiating user without per-agent sharing approval. Selected workspace IDs and allocation keys
are execution context, not access allowlists; no resource ACL belongs in this plan.

Task-to-workspace bindings retain the task provider and stable workspace resource identities. Coordinate reverse
task observation without moving task records into Core or requiring all task providers to share
storage. Reassignment and reparenting do not silently move active consumers or reset source. Handle
an unavailable/removed task provider, changed app/user authority and stale references explicitly.

Reuse current Core workspace preparation, association, activity leases, sandbox and publication APIs.
Choose a stable allocation key and reconcile uncertain operations before retrying. A task completion
does not Finish a sandbox, remove a workspace or publish changes. Shared source does not imply private
transcript access, safe concurrent same-file edits or authority beyond current app/user grants.

## Transfer Record (2026-10-27)

| Original deliverable | Current owner |
| --- | --- |
| D1-D2: common schema, provider/executor contracts, lifecycle and launch | [Basic Tasks D1-D2](../basic-tasks/feature.md#requirement-transfer) |
| D4: Core/SDK and Harness task-provider implementation | [Basic Tasks D2-D3](../basic-tasks/feature.md#requirement-transfer) |
| D3: optional references and explicit existing workspace selection | [Basic Tasks D1/D3/D4](../basic-tasks/feature.md#requirement-transfer); automatic allocation/reuse/reverse observation remains D3 here |
| D5: basic task checks/documentation | [Basic Tasks D5-D6](../basic-tasks/feature.md#requirement-transfer); workspace-coordination acceptance remains D5 here |

D1, D2 and D4 are retired by transfer, not marked implemented, and their IDs must not be reused.
D3 and D5 retain their original identifiers for the remaining work. The accepted numbering, lifecycle
and launch contract has one canonical home in Basic Tasks; this plan does not duplicate it.

## Dependencies

- [Basic Tasks](../basic-tasks/feature.md) supplies qualified task/executor identity and explicit resources.
- [Harness Work Orchestration D4](../harness-work-orchestration/plan.md#deliverables) owns delegation,
  writer coordination and when a workflow chooses related versus independent source work.
- [Workspace sessions](../workspace-sessions/feature.md), existing preparation/lease/sandbox APIs and
  their remaining plans retain resource ownership and supported execution modes.
- [Shared Artifacts](../shared-artifacts/plan.md) owns durable selected materials; source association
  does not imply saved result bytes or cross-session visibility.

## Deliverables

- [ ] D3. Define and implement, after Ready approval, automatic task-to-workspace allocation/reuse and reverse task observation through existing resource APIs, including explicit independent work, concurrent allocation, retry recovery, reparenting/reassignment and current application and initiating-user permission checks.
- [ ] D5. Verify the full coordination flow with concurrent related tasks, deliberate independent bugfix/PR bindings, restart/lost responses, provider removal, revoked app/user permissions and active consumers; document shipped behavior in feature.md, reconcile Basic Tasks and orchestration, and regenerate the index.

## Open Questions

- What allocation scope/key distinguishes related work from intentionally independent work?
- Which owner maintains reverse task observations and recovers unavailable provider data?
- How do reparenting/reassignment, cancellation and active consumers affect allocation and cleanup?

## Verification

Documentation checks validate the split and links without claiming implementation. Runtime acceptance
uses registered workspaces and managed sandboxes with normal authority. Prove retries/concurrent
requests recover one intended allocation, independent work stays separate, source/results survive
unrelated cleanup, and task links never grant transcript or filesystem access. Basic task acceptance
does not complete D3/D5; these remain deferred until separately designed and approved.

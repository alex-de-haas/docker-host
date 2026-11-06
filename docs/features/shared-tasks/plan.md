---
status: Draft
created: 2026-10-26
updated: 2026-11-04
summary: Deferred execution-source allocation, reuse and derived task observations across providers, independent of task and workspace lifecycles.
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

Basic Tasks retains generic resource references. Harness provides optional source contexts and
root/child workspace association. This plan extends that baseline with independent-provider
coordination and reverse observation. It does not implement another task store, checkout backend, model runner or permissions
system. Flat task trees and the first root/child binding flow are owned by
[Profile-Based Task Delegation](../profile-task-delegation/feature.md).

## Bounded Root/Child Transfer (2026-11-04)

[Profile-Based Task Delegation](../profile-task-delegation/feature.md) receives D3/D5's first
same-Harness execution-source allocation/reuse, inherited context references, session association
and derived task/source observations, with concurrent allocation and replay acceptance. Its private
execution context is correlated with root attempt lineage and selects the shared logical workspace;
no allocation occurs for every child. A root can run without a workspace, but selecting one for
development associates all root/descendant sessions, including earlier planning, review and QA.
That feature also provides the workspace-details root-task projection and recorded-profile session labels;
these do not move task records or profile knowledge into Core.

D3/D5 here retain general independent-provider, reparenting/reassignment and independent-scope
coordination and their acceptance. They are not completed by the transfer. The selected delegation
feature can ship without implementing this broader policy or moving task records into Core.

## Task/Session/Source Boundary (2026-11-04)

The owner asks to keep task semantics independent of workspaces. The proposed model uses task
attempts as the bridge to executor sessions; sessions optionally associate with Core workspaces.
Task providers retain assignments, results and attempt references. Core retains source, participation
and leases without a task registry or task-provider dependency. General coordination here extends
that model, not a mandatory task-to-workspace foreign key.

Executors retain durable source-context choices for queued/restarted work and record the revision
used by each attempt. Source observations are authorized projections of those links; a changed
session association cannot rewrite historical use. The owner confirms tasks are unused and permits
replacement of their schema without backward compatibility, including moving workspace selection
out of task input. The revised broker must still bind the authorized user/executor, task revision,
attempt, session, source context and lease. The first Harness consumer and its revised-contract
acceptance belong to the transferred plan. Its C1/C7 contracts are Ready under the owner's
documentation-preparation instruction, with implementation withheld; this broader plan remains Draft.

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

Executor source contexts retain stable source identities and their attempt/session correlations.
Derive reverse task observations through authorized executor/task APIs without moving task records
into Core or requiring shared provider storage. Current participation and historical source use
remain distinguishable. Reassignment/reparenting does not silently move active consumers or reset
source. Handle an unavailable task provider, changed authority and stale references explicitly.

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
- [Profile-Based Task Delegation](../profile-task-delegation/feature.md) owns the first delegation flow,
  writer coordination and when a workflow chooses related versus independent source work.
- [Workspace sessions](../workspace-sessions/feature.md), existing preparation/lease/sandbox APIs and
  their remaining plans retain resource ownership and supported execution modes.
- [Shared Artifacts](../shared-artifacts/plan.md) owns durable selected materials; source association
  does not imply saved result bytes or cross-session visibility.

## Deliverables

- [ ] D3. Define and implement, after Ready approval, general executor-owned source-context allocation/reuse and derived task observations beyond the transferred Harness flow, including independent providers, explicit independent scopes, reparenting/reassignment, concurrent recovery, the revised common execution contract and current app/user permission checks without mandatory task/workspace coupling.
- [ ] D5. Verify the remaining general coordination with independent providers, reparenting/reassignment, deliberate independent bugfix/PR scopes, restart/lost responses, provider removal, revoked permissions and active consumers; consume the transferred root/child acceptance, document shipped behavior, reconcile related owners and regenerate the index.

## Open Questions

- Which executor-owned context and allocation key distinguish related execution from intentionally independent source work?
- Which executor projection joins attempts/sessions/source history and reports unavailable task-provider data?
- How do reparenting/reassignment, cancellation and active consumers affect allocation and cleanup?

## Verification

Documentation checks validate the split and links without claiming implementation. Runtime acceptance
uses registered workspaces and managed sandboxes with normal authority. Prove retries/concurrent
requests recover one intended allocation, independent work stays separate, source/results survive
unrelated cleanup, and task links never grant transcript or filesystem access. Basic task acceptance
does not complete D3/D5; these remain deferred until separately designed and approved.

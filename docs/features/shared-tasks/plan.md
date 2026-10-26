---
status: Draft
created: 2026-10-26
updated: 2026-10-26
summary: Shared observable tasks, assignments, child relationships and resource bindings with replaceable executors and app-owned workflow state.
components: [apps/core, apps/documents, apps/harness, packages/app-sdk, packages/app-sdk-dotnet]
---

# Shared Tasks And Executor Bindings

## Goal And Baseline

Let one app create work and another execute it while all authorized consumers observe the same
task and its children. Current plan/deliverable views and session/run records are not a general
Core task contract. Documents denotes the intended evolution of Plans, not shipped behavior.

The preferred candidate is a small Core-owned task record with a replaceable executor. Compare
provider-owned storage against the same create/read/observe use case before settling the contract.
This separate Draft follows [vision decisions 55-56](../../vision.md); it authorizes no implementation.

## Target Behavior

Keep shared fields small: identity/revision, description, creator/owner, assignments, executor
binding, lifecycle view, parent/related-task relationships and input/result/resource references.
An originating app, target app and execution app are distinct relationships. Apps retain their
private decomposition/review state; compare schema-versioned extension data with private storage.

Documents can create one task from an approved document revision. A coordinator may create visible
children, assign participants and attach results. Other consumers see permitted state and assignments
without accessing its private workflow or conversations. A completed run does not itself accept a
task's business result. A task can span runs; ordinary work need not use a repository or workspace.

Define command identity, concurrent updates, cancellation, stale results and unavailable/removed
executors. Default executor selection applies to new work; existing bindings do not silently change.
Only the designated owner can update its execution evidence. State changes produce authorized events
through [Notifications D6](../notifications/plan.md#deliverables), with consistent state/event publication.

Related delegated source work normally inherits a selected workspace binding. Define the allocation
scope so concurrent requests and retries resolve one authorized workspace. Allow an explicit separate
binding for an independent bugfix and PR; task parentage must not enforce one workspace per tree.
Specify reparenting and reassignment behavior without silently moving existing consumers. Source
sharing grants no transcript access or automatic same-file write isolation.

## Dependencies And Ownership

- [Agent Participants](../agent-participants/plan.md) owns persistent identity;
  [Agent Providers](../agent-provider-interface/plan.md) owns execution invocation.
- [Durable Agent Jobs](../durable-agent-jobs/plan.md) owns scheduled/retryable execution, not the task
  registry. [Harness Work Orchestration](../harness-work-orchestration/plan.md) owns decomposition
  and the first Documents-to-Harness business journey.
- [Artifacts](../shared-artifacts/plan.md) owns result references; [Decisions](../shared-decisions/plan.md)
  owns human questions. Neither task metadata nor an event is permission to read linked content.
- [Plan Provider](../plan-provider-interface/plan.md) retains document/progress semantics;
  [Default Applications](../default-applications/plan.md) retains generic selection mechanisms.
- Existing workspace, membership, lease, sandbox and publication features own resource operations.
  This plan adds task bindings and allocation coordination, not another checkout backend.

## Deliverables

- [ ] D1. Compare storage alternatives and define the shared lifecycle, assignment/relationship model, executor binding and bounded extension policy, including behavior after an executor disappears.
- [ ] D2. Define authorized mutations and observation with Notifications D6, request/revision identities, cancellation, stale/late results and default-executor selection; reconcile task/run acceptance boundaries.
- [ ] D3. Define and implement, after Ready approval, task-to-workspace binding and atomic reuse through existing resource APIs, including explicit independent work, concurrent allocation, reparenting and current membership checks.
- [ ] D4. After explicit Ready approval, implement the selected shared store/API/SDK and appropriate agent tools with authorized task/child reads and state events; verify independent producer and executor clients without shared private storage.
- [ ] D5. Verify duplicate submissions, lost responses, concurrent updates, executor removal, revoked access and separate bugfix bindings; document shipped behavior in feature.md and reconcile consuming plans.

## Proposed Sequence

Agree D1-D2 alongside participant identity and provider invocation. Resolve D3 before delegating
source work; implement D4 against the shared event contract. The first consumer can be one task and
one executor, with child tasks added after that path is verified.

## Open Questions

- Which minimal lifecycle and relationship constraints are shared, and which remain workflow-specific?
- What allocation scope prevents duplicate workspaces without obstructing deliberate independent work?
- How are executor compatibility, missing ownership, reassignment and extension schema evolution handled?
- Which content references must be pinned when creating work, and which may be explicitly live?

## Verification

For this Draft, validate documents and links. Future checks cover two independent app clients,
visible children with filtered permissions, restart/reconnect, cancelled work receiving a late result,
intentional independent workspaces versus accidental duplicates, and tasks without source resources.
Use existing managed-workspace/sandbox checks when implementation reaches those APIs.

---
status: Draft
created: 2026-10-09
updated: 2026-10-10
summary: Deferred operator management for closing session development, revoking agent access and safely releasing repository worktrees.
components: [apps/core, apps/harness]
---

# Workspace Lifecycle Controls

## Scope And Deferral

The owner selected a read-only Workspaces app first on 2026-10-09 and described later operator
management. This separate Draft records that later scope; it does not gate the initial viewer.
The [workspace model](../assistant-session-workspaces/feature.md) documents aggregate identity and
read authorization. Stronger execution scope belongs to
[execution authorization](../assistant-execution-authorization/plan.md). D8/D9 from the original
workspace-model draft and retired Workspaces-app D12 are transferred here.

## Closing And Physical Cleanup

Later operator management is a separate delivery phase, not part of the initial viewer. Candidate
states are open, closing and closed, with physical worktree release tracked independently.

A close request revokes new agent development operations immediately, coordinates cancellation
with the owning assistant and reconciles pending operations. A request accepted by Core does not
prove native processes have stopped. Unknown activity or live runtime consumers blocks destructive
cleanup; retain source and visible blockers. Do not automatically release another process's lease.

The owner's desired session behavior is development-finished with history and clarification chat
available; follow-up discussion must not silently recreate worktrees or regain edit authority.
Conversation retention remains assistant-owned. Define reopen versus a new session explicitly
before controls ship. Preserve per-worktree outcomes when only some PRs are merged or abandoned.

Closing work and deleting uncommitted files are different actions. Destructive discard needs
explicit intent and consumer checks. A Core API revocation cannot revoke an unrestricted external
program's OS access to a previously returned path. Operators must be told that the current native
mode uses cooperative directory guidance. Strong containment belongs to the deferred
[agent session containment](../assistant-runtime-containment/plan.md), separately from app Sandbox testing.

Owner clarification, 2026-10-09: the intended isolated mode exposes only the owning workspace's
worktrees to its agent container. Closing must revoke new operations, stop and verify owned
executions, detach their source mounts and only then attempt physical cleanup. Define the backend
acknowledgement for each step; a live unmount is not assumed. Deleting a worktree underneath a
running process is not an access-revocation mechanism. Dirty changes, unresolved publication state,
leases and independent runtime consumers still require the existing preservation/discard checks.
Closure and physical cleanup may therefore have different outcomes and completion times.

Ownership clarification, 2026-10-10: Containment D10 implements execution ownership, verified process
termination and mount-release acknowledgements. D2-D3 here consume that backend contract for the
close workflow and its acceptance; they do not implement a second process supervisor. Approval Rules
owns grant removal and its visible meaning, not evidence that an execution has stopped.

## Deliverables

- [ ] D1. Specify operator management operations, exact permission checks, close versus discard, partial worktree outcomes and reopen versus new-session policy.
- [ ] D2. Implement the approved close/revocation/cancellation coordination and safe release through Core, with explicit operator UI and durable recovery.
- [ ] D3. Verify close/cancel/restart races, execution revocation, context changes, retained discussions and active or unknown native consumers; document guarantees.

## Open Questions

- Is development closure irreversible for this session, or can an operator explicitly reopen it?
- Which management UI owns the controls and which explicit actions authorize discarding unpublished files?
- What acknowledgement proves that each supported assistant stopped its execution, and how are external processes with unknown state presented?

## Verification

Exercise active writes, runtime consumers, partial merges, dirty files, interrupted close, revoked
credentials and repeated operation IDs. Verify no new development operations after closure and no
silent workspace recreation from clarification chat. Preserve source on unknown consumer state.
Test only the guarantees of the selected backend; API denial does not prove native filesystem denial.

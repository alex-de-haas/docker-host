---
status: In Progress
created: 2026-10-09
updated: 2026-10-16
summary: Verified development completion, operator cleanup and recoverable release of workspace resources, with unfinished work protected from expiry.
components: [apps/core, apps/harness]
---

# Workspace Lifecycle Controls

## Implementation Approval (2026-10-16)

The owner approved the proposed completion/resume/delete model and requested implementation of
the Harness page and lifecycle actions. Work is now in progress. Core verifies completion across
all repositories; retained source can explicitly resume, while released source needs a new workspace.
Existing execution leases and consumer checks remain authoritative: unknown or live consumers block
cleanup instead of being silently cancelled. Manual discard remains separately tracked; scheduled retention is implemented in its owning feature,
with independent policy and reviewed cleanup permission; this implementation does not delete unfinished source or enable new expiry defaults.

## Scope And Deferral

The owner selected a read-only Workspaces app first on 2026-10-09 and described later operator
management. This plan records that later scope; it did not gate the initial viewer.
The [workspace model](../assistant-session-workspaces/feature.md) documents aggregate identity and
read authorization. Stronger execution scope belongs to
[execution authorization](../assistant-execution-authorization/plan.md). D8/D9 from the original
workspace-model draft and retired Workspaces-app D12 are transferred here.

## Owner Revision (2026-10-16)

The owner now prioritizes usable completion/removal in the full [Harness UI](../harness-development-ui/feature.md).
The earlier history-retained default below becomes a choice: an operator may remove a finished
workspace and its associated Harness conversation, and configured retention may do the same after
verified completion. [Harness retention](../harness-session-retention/feature.md) owns durations and
scheduling. Existing external workspaces still need authorized management without a Harness session.
Do not delete an external agent's conversation or require importing it into Harness.

Completion is an explicit agent/operator workflow transition verified by Core, not elapsed time.
For every repository, require clean source and current commits merged into the intended target,
using existing ancestry/provider exact-head completion verification. Closed-unmerged PRs, green CI,
one merged repository, unobserved provider state or an empty newly created workspace do not prove
completion. Keep active, paused, blocked and unknown work out of automatic deletion. New edits or
an explicit reopen invalidate completion and any cleanup deadline. Recheck before destructive work.

Use distinct user-visible outcomes for completion and resource cleanup. Finish owned sandboxes,
coordinate active execution and release eligible worktrees before deleting a selected transcript.
Preserve partial outcomes/retry IDs; blockers explain what remains. Manual discard of unmerged work
is a separate explicit choice and never an age-based fallback. Retain only recovery/audit metadata
needed by Core after physical release; do not promise immediate removal of durable operation records.

The supported first execution mode is one shared Docker worker (vision decision 35), not one
container per session. Reuse its verified stop/lease coordination and Core consumer checks; stronger
per-session isolation below remains separately owned work and must not become a prerequisite for
ordinary operator cleanup. Shared worker mounts can still block release; present that fact without
claiming that API closure revokes arbitrary native filesystem access.

## Proposed Status Authority And Actions (2026-10-16)

The owner requested contextual workspace actions and clarification of status ownership. The
following contract was approved for implementation; it is not yet shipped behavior.
Core owns the durable workflow record. An authorized operator or agent requests a transition;
neither an agent message saying "done" nor a client-written flag establishes verified completion.
Record the actor, time and optional reason. Keep three independent facts visible: workspace workflow
state, actual agent activity, and resource cleanup operation state.

| Workflow state | Authority and evidence | Contextual actions |
| --- | --- | --- |
| In progress | Starts with source work or explicit resume; idle chat does not change it. | Complete, Defer. |
| Deferred | Explicit operator or authorized-agent intent, with an optional blocker/reason. Never expires as completed work. | Resume. |
| Completed | Explicit completion request plus fresh Core verification for every repository and no unresolved source operation or active source writer. | Delete workspace, Resume while source is retained. |

Core calculates the supporting facts: dirty files, unpublished/current commits, verified target
integration, PR/CI/review observations and active consumers. A fully merged iteration can produce a
"Changes merged" hint, but cannot establish that the entire intended feature is finished. Conversely,
a completion request with dirty files, an unmerged current head, partial multi-repository completion
or unavailable evidence reports precise blockers rather than setting Completed. CI success alone is
not completion. Reuse the existing ancestry/provider exact-head checks instead of adding another
interpretation of merge state.

Completion stops further source mutations until explicit resume, but does not itself Finish a
sandbox or delete a conversation. A retained preview may remain available for operator inspection;
its source mount is a cleanup blocker, not automatically evidence of unfinished feature work.
Concurrent writers and unknown execution must be reconciled before acknowledging completion. Later
observed source changes invalidate completion and its retention deadline. A resume request does the
same explicitly; it does not automatically start an agent or rebuild a removed environment.

Place the state and an actions menu beside the workspace name. Promote Delete workspace for
completed work. Where an action is blocked, show a reason such as "Current commits not merged",
"Agent still running" or "Provider state unavailable" instead of a misleading completed badge.
Deletion is a separate operation with visible progress, per-resource outcomes and retry on failure.
Before deletion, show which owned worktrees and sandboxes are included and offer associated Harness
conversation removal as an explicit choice. Recheck source and consumers immediately before
release; an older Completed label is insufficient. Published PRs are not deleted. Keep the existing
minimal Core recovery records rather than claiming that all traces disappear.

Keep Discard unfinished work separate from ordinary completion/deletion, with explicit intent
covering the affected source. Retention must never invoke discard. External workspaces use the same
Core checks and authorized management without a Harness conversation; no action deletes or resumes
the external agent's chat. After physical source release, resuming development requires a newly
prepared worktree, not implicit recreation by a follow-up message.

## Closing And Physical Cleanup

Later operator management is a separate delivery phase, not part of the initial viewer. The earlier
open/closing/closed terminology describes operation admission and shutdown, not an additional set
of feature-progress badges. Reconcile it with the proposed workflow states above; physical worktree
release remains independently tracked.

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

- [x] D1. Specify status authority and contextual actions, completion evidence for every worktree, permission checks, close versus discard, partial outcomes, reopen invalidation and minimal retained recovery metadata.
- [ ] D2. Implement verified completion and close/cancellation coordination through Core, with Harness operator controls, optional owned sandbox/conversation cleanup, external-owner handling and durable recovery.
- [ ] D3. Verify completion/reopen/edit, close/cancel/restart and retention races, partial merges, shared-worker leases, retained/deleted discussions and active or unknown consumers; document guarantees.

## Current Implementation And Remaining Acceptance

The [feature](feature.md) describes explicit completion, defer/resume and recoverable manual cleanup.
D2-D3 remain open for the wider close/cancellation contract and its supported execution acknowledgements.
D5 retention acceptance covers deadline/reopen/edit protection, active/pending exclusions and stable
cleanup replay after a failure/restart. External-owner browser acceptance
now verifies lease/dirty/unmerged blockers and recovery of the original deletion request after a
permission denial and Core restart, followed by removal of both source directories and child data. Current controls preserve source and explain
active/unknown-consumer blockers instead of promising to cancel another native process. Manual discard
and separate scheduled retention are not silently included in ordinary Delete workspace.

## Open Questions

- Harness owns the primary management UI. Finalize which explicit action authorizes discarding unpublished files, and how external owners reach equivalent controls.
- What acknowledgement proves that each supported assistant stopped its execution, and how are external processes with unknown state presented?

## Verification

Exercise active writes, runtime consumers, partial merges, dirty files, interrupted close, revoked
credentials and repeated operation IDs. Verify no new development operations after closure and no
silent workspace recreation from clarification chat. Preserve source on unknown consumer state.
Test only the guarantees of the selected backend; API denial does not prove native filesystem denial.

Status/action checks: an idle agent does not complete work; a merged intermediate PR does not
complete an unfinished feature; an agent's completion request cannot override dirty or unmerged
source. Verify that completed work can retain preview data, deletion reports source consumers,
and resume invalidates the retention deadline without automatically starting execution. Check
operator and agent authorization, external-owner controls, and retry after partial cleanup.

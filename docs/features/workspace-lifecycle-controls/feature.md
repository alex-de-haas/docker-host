---
created: 2026-10-16
updated: 2026-10-16
summary: Core verifies explicit workspace completion and coordinates recoverable cleanup of owned sandboxes and merged worktrees.
components: [apps/core, apps/harness]
---

# Workspace Lifecycle Controls

## Status Authority

Core persists a workflow record for each logical owner: `in-progress`, `deferred`, `completed`,
`deleting` or `deleted`. The record includes a revision, transition actor, completion time and exact
per-worktree heads, plus operation receipts. It is separate from worktree allocation state and agent
activity. A new empty or fully merged workspace remains in progress until an explicit request.

An authorized operator or Harness agent requests completion. Core reobserves every owned repository,
refuses dirty/conflicted/unavailable source, active writer leases and unresolved source operations,
and verifies each current head against a freshly fetched target or fresh exact-head provider merge
evidence. It also verifies released historical heads using retained cleanup receipts. One merged
repository, a closed-unmerged PR, CI success or elapsed time cannot establish completion.

Complete preserves worktrees and previews. Managed source mutation and new preparation require an
in-progress workflow. Defer preserves unfinished work. Resume clears completion and its heads/time;
released source requires a new workspace. A newly observed dirty state or changed head invalidates
completion. After explicit resume a merged publication can prepare a corrective PR while retaining
its previous PR history.

## Authorization And API

The inspection surface exposes GET `/{workspaceId}/workflow`, GET `/{workspaceId}/previews` and POST
`/{workspaceId}/workflow/{complete|resume|defer|delete}` beneath
`/api/internal/apps/{appId}/workspace-inspection`. Requests use the existing service bearer and active
administrator app identity. Reads require reviewed workspace inspection permission. Management
uses full source authority, same-user ownership and source authorization for every child;
permission to inspect another owner's public source is not permission to close it.

The owning assistant session has equivalent workflow routes beneath its existing workspace API.
Commands carry a UUID `requestId` and `expectedRevision`. Replaying a completed request returns its
current durable outcome; uncertain requests must retain their original identity and arguments.

## Cleanup And Recovery

Delete requires verified completion and rechecks source before removal. Core records deleting intent,
then finishes owned child Cores and disposes owned app sandboxes using existing lifecycle services.
Resources are matched by same user and logical workspace context or owning assistant session. The
caller also needs the corresponding reviewed resource-management permissions. Context-only resource
creation is serialized with deletion; deleted work cannot gain a new attached preview.

A durable cleanup journal retains each child operation's original UUID/revision. Source cleanup then
uses existing worktree/branch guards, writer leases and consumer checks. A live or unknown external
consumer blocks cleanup; the coordinator does not kill arbitrary processes or release their leases.
Interrupted deletion keeps its pending action and can recover partially removed source using the
same request. Core verifies the remaining branch/registration before acknowledging release.

Deleting a workspace does not delete published PRs or shared repository caches. Minimal workflow,
resource and operation receipts remain for recovery; physical source and owned temporary sandbox
resources are removed. Harness can remove its conversation afterwards as an explicit option. Manual
chat deletion refuses tracked unfinished workspace/resource cleanup and pending resource operations.
Unfinished-work discard is not part of this cleanup operation.

[Harness retention](../harness-session-retention/feature.md) uses this coordinator for separately
configured completed-workspace expiry. Background cleanup requires its reviewed optional permission
in addition to source/resource authority. Unfinished/deferred work, active/waiting sessions and
unresolved resource state remain protected. Retention cannot substitute age for verified completion.

## Testing Expectations

- Verify all-repository clean/merged evidence, dirty/current-unmerged rejection and exact-head merge
  proof, including released historical source and corrective publication after explicit resume.
- Exercise completion, defer/resume, new-edit invalidation and retained preview data.
- Preserve source on leases, unknown consumers, partial merges, failed authorization and interrupted
  cleanup; retry with the original UUID/revision and reject conflicting requests.
- Check resource ownership, allocation/delete serialization and source cleanup after child Finish.
- Do not equate an API state change with termination of native processes or removal of recovery records.

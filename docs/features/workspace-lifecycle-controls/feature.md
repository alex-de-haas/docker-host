---
created: 2026-10-16
updated: 2026-10-17
summary: Core coordinates recoverable workspace closure, verifies completion and cleans up owned sandboxes and merged worktrees without discarding unfinished changes.
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
`/{workspaceId}/workflow/{complete|resume|defer|delete|close|close-confirm}` beneath
`/api/internal/apps/{appId}/workspace-inspection`. Requests use the existing service bearer and active
administrator app identity. Reads require reviewed workspace inspection permission. Management
uses full source authority, same-user ownership and source authorization for every child;
permission to inspect another owner's public source is not permission to close it.

The owning assistant session has equivalent workflow routes beneath its existing workspace API.
Commands carry a UUID `requestId` and `expectedRevision`. Replaying a completed request returns its
current durable outcome; uncertain requests must retain their original identity and arguments.

## Coordinated Close

Close is a non-destructive operation-admission state (`closure: closing | closed`), independent of
feature progress. An unfinished workspace remains `in-progress`; closing does not invent completion,
merge evidence or an expiry deadline. It keeps source, previews, conversation and unsent drafts.

Core persists the close UUID/revision before Harness begins cancellation. Closing or closed source
cannot acquire a new activity/shared-worker lease, prepare a worktree, mutate through managed source
or publication operations, or allocate an attached preview. Recovery/release of already accepted
source operations remains possible. Existing previews remain available; their independent lifecycle
and source-consumer checks still govern physical cleanup.

The operator's Harness `POST /api/development-workspaces/{id}/workflow/close` first calls Core's
`close` admission endpoint. It resolves the workspace owner from Core, checks the local conversation's
user and its current-installation workspace association, then serializes cancellation with new turns.
The existing shared Docker worker verifies container removal before releasing its persistent worker
lease and all recovered worktree leases. Only then does `close-confirm` acknowledge `closed`.
No new process supervisor or per-session Docker container is introduced.

A failed stop or lease release retains the worker generation, source and pending Core operation.
The panel displays Closing and Retry action. Retry uses the original UUID/revision from Core even
when browser storage is unavailable, and survives Core/Harness restarts. Direct Close retries load the persisted worker generation
before checking ownership, without requiring an earlier health or runtime request. Other mutations cannot
replace an unfinished close. Delete controls, including an already-open confirmation dialog,
remain blocked by a pending close and preserve its browser recovery journal.
New publication commands, including PR metadata, merge, completion and policy changes, require
Resume while closure is Closing or Closed. Existing request receipts retain replay/recovery instead
of becoming new publication authority. Publication receipt admission and Close share the source-owner
gate: slow connection or dependency checks cannot admit a new operation after closure starts.
Previously requested publication cleanup cannot start while closure is Closing or Closed. An
already-admitted cleanup retains its recovery path; pending source cleanup prevents Close from
being acknowledged until that earlier operation is resolved. Replaying a successful close after Resume returns its receipt without
cancelling the new run. Terminal session events refresh worker availability in the chat, so recovered
Docker health does not remain stale until a page reload.

External agents, older assistant installations and other sessions are not impersonated or stopped.
Their outstanding source operations and leases block acknowledgement. Since the shared worker can
see the shared source area, another session's active worker lease also blocks confirmation; this
coordinator never releases it. This is a stop/admission lifecycle, not a per-workspace filesystem
boundary: later authorized sessions still receive the shared worktree root, including retained
closed source. Close does not make those files read-only or block unrelated sessions; source
separation belongs to the separately scoped containment work. Native execution without verified stop/lease acknowledgement remains
a blocker. API admission is not revocation of arbitrary native filesystem access or a guarantee that
an external process has stopped. Physical deletion retains its stricter independent consumer checks.

Resume explicitly reopens retained source and clears completion, recorded heads/time and closure.
It starts no agent or preview automatically. A closed conversation retains readable history and its
draft; sending another agent turn requires Resume rather than silently recreating development access.
Read-only model conversation while retaining closed source is not a separate execution mode.

Close and Delete remain distinct. Optional owned sandbox/conversation cleanup uses the existing
verified-completion Delete flow. Dirty/unmerged work cannot be deleted by that action or by scheduled
retention. Interrupted closure is protected from retention even if an earlier iteration was marked
completed. Destructive discard is not provided by this workflow.

## D2-D3 Acceptance

The 2026-10-17 acceptance closes D2-D3 of the completed lifecycle plan. Its
[report](../../reviews/2026-10-17-workspace-close-acceptance.md) records an active Docker writer stopped
through the Harness UI, two retained repositories, interrupted stop across Core/Harness restart,
original-request replay, unchanged file hashes, retained transcript/draft and explicit Resume.
It uses a deterministic provider with real Core, Harness and Docker; it does not claim a paid model
run or a host-wide Docker outage. Existing completion, deletion and retention suites cover merged
and partial outcomes, provider evidence, optional conversation removal and resource cleanup.

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

A corrective publication after a completed cycle requires a successful Resume after the latest
workspace completion. Source observation can invalidate completion, but an older cycle's Resume
does not authorize another corrective publication.

Cleanup refreshes a stale resource revision only when Finish/Dispose has no durable operation
receipt, and saves the replacement request before dispatch. Accepted operations retain their
original request and revision through recovery. External GitHub completion evidence treats
canonical owner/repository URL casing consistently with PR observation.

Close admission and confirmation serialize with workspace resource allocation. An already-admitted
preview finishes attaching its source consumer before closure; new allocations are refused after
closing starts. Resource, source-owner and shared-worker gates retain that acquisition order.

## Testing Expectations

- Verify all-repository clean/merged evidence, dirty/current-unmerged rejection and exact-head merge
  proof, including released historical source and corrective publication after explicit resume.
- Exercise completion, defer/resume, new-edit invalidation and retained preview data.
- Close active Docker work, verify removal before lease release, preserve dirty/untracked bytes,
  recover the same pending request across service/browser restart and require explicit Resume.
- Reject new source/worker admissions after closing intent; preserve other owners and prevent
  interrupted close from racing retention. Refresh worker health after terminal session events.
- Preserve source on leases, unknown consumers, partial merges, failed authorization and interrupted
  cleanup; retry with the original UUID/revision and reject conflicting requests.
- Check resource ownership, allocation/delete serialization and source cleanup after child Finish.
- Do not equate an API state change with termination of native processes or removal of recovery records.

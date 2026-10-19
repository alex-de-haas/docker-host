---
created: 2026-10-16
updated: 2026-10-19
summary: Core coordinates recoverable workspace pause, suspends inactive source observation, verifies completion and deletes merged workspaces without discarding unfinished changes.
components: [apps/core, apps/harness]
---

# Workspace Lifecycle Controls

## Status Authority

Core persists a workflow record for each retained logical owner: `in-progress`, `deferred`,
`completed` or `deleting`. The transitional `deleted` state lasts until final metadata cleanup. The record includes a revision, transition actor, completion time and exact
per-worktree heads, plus operation receipts. It is separate from worktree allocation state and agent
activity. A new empty or fully merged workspace remains in progress until an explicit request.

An authorized operator or Harness agent requests completion. Core reobserves every owned repository,
refuses dirty/conflicted/unavailable source, active writer leases and unresolved source operations,
and verifies each current head against a freshly fetched target or fresh exact-head provider merge
evidence. It also verifies released historical heads using retained cleanup receipts. One merged
repository, a closed-unmerged PR, CI success or elapsed time cannot establish completion.

Complete preserves worktrees and previews. Managed source mutation and new preparation require an
in-progress workflow with no pause fence. Pause preserves unfinished work and any existing
completion evidence. Legacy `deferred` records remain paused until Resume. Resume fetches the current
target and reobserves every retained worktree before clearing completion, heads/time and the pause
fence; dirty/conflicted work can resume for repair, but unavailable/replaced source cannot. Released
source requires a new workspace. Observation never silently reopens completed work. After explicit resume a merged publication can prepare a corrective PR while retaining
its previous PR history.

## Authorization And API

The inspection surface exposes GET `/{workspaceId}/workflow`, GET `/{workspaceId}/previews` and POST
`/{workspaceId}/workflow/{complete|resume|pause|pause-confirm|delete}` beneath
`/api/internal/apps/{appId}/workspace-inspection`. Requests use the existing service bearer and active
administrator app identity. Reads require reviewed workspace inspection permission. Management
uses full source authority, same-user ownership and source authorization for every child;
permission to inspect another owner's public source is not permission to close it.

The owning assistant session has equivalent workflow routes beneath its existing workspace API.
Commands carry a UUID `requestId` and `expectedRevision`. Replaying a completed request returns its
current durable outcome; uncertain requests must retain their original identity and arguments.

## Coordinated Pause

Pause is a non-destructive operation-admission state (`closure: closing | closed`), independent of
feature progress. An unfinished workspace remains `in-progress`; closing does not invent completion,
merge evidence or an expiry deadline. It keeps source, previews, conversation and unsent drafts.

Core persists the pause UUID/revision before Harness begins cancellation. Pausing or closed source
cannot acquire a new activity/shared-worker lease, prepare a worktree, mutate through managed source
or publication operations, or allocate an attached preview. Recovery/release of already accepted
source operations remains possible. Existing previews remain available; their independent lifecycle
and source-consumer checks still govern physical cleanup.

The operator's Harness `POST /api/development-workspaces/{id}/workflow/pause` first calls Core's
`pause` admission endpoint. It resolves the workspace owner from Core, checks the local conversation's
user and its current-installation workspace association, then serializes cancellation with new turns.
The existing shared Docker worker verifies container removal before releasing its persistent worker
lease and all recovered worktree leases. Only then does `pause-confirm` acknowledge `closed`.
No new process supervisor or per-session Docker container is introduced.

A failed stop or lease release retains the worker generation, source and pending Core operation.
The panel displays Pausing and Retry action. Retry uses the original UUID/revision from Core even
when browser storage is unavailable, and survives Core/Harness restarts. Direct Pause retries load the persisted worker generation
before checking ownership, without requiring an earlier health or runtime request. Other mutations cannot
replace an unfinished pause. Delete controls, including an already-open confirmation dialog,
remain blocked by a pending pause and preserve its browser recovery journal.
New publication commands, including PR metadata, merge, completion and policy changes, require
Resume while closure is Pausing or Paused. Existing request receipts retain replay/recovery instead
of becoming new publication authority. Publication receipt admission and Pause share the source-owner
gate: slow connection or dependency checks cannot admit a new operation after closure starts.
Previously requested publication cleanup cannot start while closure is Pausing or Paused. An
already-admitted cleanup retains its recovery path; pending source cleanup prevents Pause from
being acknowledged until that earlier operation is resolved. Replaying a successful pause after Resume returns its receipt without
cancelling the new run. Terminal session events refresh worker availability in the chat, so recovered
Docker health does not remain stale until a page reload.

External agents, older assistant installations and other sessions are not impersonated or stopped.
Their outstanding source operations and leases block acknowledgement. Since the shared worker can
see the shared source area, another session's active worker lease also blocks confirmation; this
coordinator never releases it. This is a stop/admission lifecycle, not a per-workspace filesystem
boundary: later authorized sessions still receive the shared worktree root, including retained
closed source. Pause does not make those files read-only or block unrelated sessions; source
separation belongs to the separately scoped containment work. Native execution without verified stop/lease acknowledgement remains
a blocker. API admission is not revocation of arbitrary native filesystem access or a guarantee that
an external process has stopped. Physical deletion retains its stricter independent consumer checks.

Resume explicitly reopens retained source and clears completion, recorded heads/time and closure.
It starts no agent or preview automatically. A closed conversation retains readable history and its
draft; sending another agent turn requires Resume rather than silently recreating development access.
Read-only model conversation while retaining closed source is not a separate execution mode.
Legacy delegated-token chats use the service-authenticated Core snapshot for this admission check;
ordinary chats remain usable without forwarding that token to the app-credential workspace API.
Deleting/deleted source offers no Resume action or retained-source continuation guidance.

Pause and Delete remain distinct. Optional owned sandbox/conversation cleanup uses the existing
verified-completion Delete flow. Dirty/unmerged work cannot be deleted by that action or by scheduled
retention. Interrupted closure is protected from retention even if an earlier iteration was marked
completed. Destructive discard is not provided by this workflow.

## Inactive Observation

The 20-second Git observer runs only for `in-progress` workspaces without a closure fence.
Completed, legacy deferred, closing, closed and deleting workspaces retain their last observation.
Eligibility is checked under the same owner lock as lifecycle transitions. The publication observer
also skips inactive workspaces, rechecking queued external requests and background cleanup after a
provider response. An already-running provider request can finish; it does not start another Git
scan or cleanup after a pause wins admission.

Explicit inspection, diff and refresh remain available and never clear workflow fences. Complete
and Delete obtain fresh source and target/provider evidence regardless of the background policy.
Dirty files or a changed head after completion therefore block Delete without reopening source.
Resume refreshes target and local state before allowing managed source work again.

Harness exposes Complete, Pause, Resume and Delete. A selected inactive workspace loads details on
entry, lifecycle change or manual refresh, not on recurring inventory refresh. New agent turns
require Resume for both paused and completed workspaces. Paused previews keep their own lifecycle.

The persisted `closure: closing | closed` fields remain compatible. Legacy `close` and `defer`
actions use the same pause fence, with their original receipt kinds and revisions preserved.
`close-confirm` remains supported; legacy `defer` confirms in one call only when execution is idle.
Old deferred records display as paused without a destructive migration. Completion stays independent
of pause, so a completed-and-closed record still displays its verified completion.

## Abandoned External Leases

Activity leases are durable source protections, not heartbeats or proof of a live agent. They do not
expire by age. An external client that exits without releasing its lease leaves a blocker; a later
OAuth principal does not inherit authority to release that owner's lease.

Harness keeps lease identifiers and worktree paths in collapsed **Activity diagnostics**. The
operator first requests Pause, fencing new managed work. If external activity blocks it, **Confirm
work has stopped** asks once whether the external agent and its commands have exited. Harness
recovers the reviewed leases and automatically retries the original action. Known ordinary app
consumers appear separately with their names and application management links when Shell is
available. The confirmation stays disabled while known application or sandbox source consumers
remain. A stopped sandbox still holds its binding; Delete releases it through Finish/Dispose.
Core independently rechecks known consumers; confirmation does not terminate processes.

The POST `/{workspaceId}/worktrees/{id}/recover-lease` inspection route requires the existing full
source grant and active administrator app identity, same-user ownership, source access to every
repository, an external owner and closing/closed admission. It rejects stale/unavailable HEAD,
pending or unknown source operations, active known consumers and unverified native service ownership.
It never uses lease age or revoked OAuth as evidence of process exit. Arbitrary native execution is
not exhaustively discoverable, so operator verification remains necessary.

The request carries its UUID, expected HEAD, exact lease UUID and exit confirmation. One atomic
worktree record write removes only that lease and saves its successful operation receipt. Matching
replay survives restart; conflicting arguments fail. Other leases, source files and the original action
request/revision remain intact. Harness persists the reviewed batch and the original action across
partial success, reload or an uncertain response. Retry replays successful release receipts too;
it never adds a newly observed lease to the confirmed batch. An earlier single-lease recovery
journal retains its request identity during migration. A definite stale-head or missing-lease
refusal requires fresh review. Recovery pauses the workspace without completing or deleting it.
Dirty work can be paused and explicitly resumed, but still cannot be completed or deleted.

The [2026-10-18 acceptance](../../reviews/2026-10-18-workspace-lease-recovery.md) records isolated
browser recovery, restart, merged cleanup and unfinished-source protection. The separate
[legacy draft audit](../../reviews/2026-10-18-recovered-workspaces-draft.md) preserves the previously
uncommitted Workspaces proposal without adopting its historical deliverables as current scope.

A completed pause receipt or a different pending pause retires the browser's previous recovery
batch. Resume followed by Pause requires a new confirmation and new lease-recovery requests;
transiently missing workflow data retains the original batch for same-cycle retry. Legacy Close
and Defer recovery batches retain their action names and request identities.

## Visible Sandbox Controls

The workspace panel shows its named child Core sandboxes and app sandboxes before repository
changes, with runtime state, applications, service/build status and available preview links.
**Start sandbox** and **Stop sandbox** preserve test data. A stopped sandbox still retains its source
binding. **Delete sandbox** explicitly confirms removal of test data and owned runtime resources;
it delegates to child Core Finish or app sandbox Dispose and preserves workspace files, commits
and ordinary application data.

Workspace-scoped POST `/{workspaceId}/environments/{id}/{start|stop|finish}` and
`/{workspaceId}/sandboxes/{id}/{start|stop|dispose}` routes use the existing inspection identity,
same-user workspace/source authorization, matching resource context and the reviewed resource
management permission. Fresh or retryable starts also require the calling app's current
`apps.sources.full` grant; observing a successful receipt and stopping/removing resources remain
available without that grant. They reuse the existing lifecycle engines. Closed workspaces reject fresh
starts while retained-resource Stop/Delete and terminal request replay remain available. New starts
and cleanup serialize with workspace resource admission.

Harness retains each action's UUID and expected revision through an uncertain response or reload.
Retry continues the original request. App-sandbox Start/Stop failures are terminal receipts: after
Core confirms failure, Harness clears that request and offers fresh actions against the current
revision. An uncertain response retains the original identity until its outcome is observed;
Finish/Dispose recovery retains the accepted cleanup request. A definite revision conflict clears that unaccepted action
and requires a new explicit deletion confirmation. Disposed app-sandbox receipts retain their
workspace context so replay remains authorized after the instance directory is gone. Finished and
disposed resources no longer appear as active previews.

The [2026-10-19 acceptance](../../reviews/2026-10-19-workspace-resource-controls.md) records browser
Start/Stop/Delete, retained data, closure across parent restart, revoked-agent-credential recovery,
dirty-source protection, clean-worktree deletion and complete disposable-stand removal.

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

After physical cleanup, Core removes every worktree record and its operation history, the logical
workflow, matching cleanup jobs, ordinary publication records and external PR snapshots. A temporary
deletion journal contains the owner and released worktree snapshots while these files are removed;
it is deleted last. If removal fails partway, that journal preserves enough ownership evidence to
resume after restart, including when all worktree records are already gone. An authenticated repeat
Delete of an absent workspace succeeds without recreating a receipt. Missing/unreadable evidence
never authorizes new source or preview allocation.

Startup recovery also reconciles older workflows already marked `deleted`. It first verifies that
source paths, branches, Git registrations, leases and runtime consumers are absent and that owned
sandbox cleanup finished. Ambiguous or unfinished state remains for diagnosis. This is a startup
pass, not another recurring sweep. Deleting/deleted work is excluded from PR observation; final
publication writes serialize with metadata removal, so a late provider response cannot recreate a
cache file.

Deleting a workspace does not delete published PRs or shared repository caches. Independently owned
child-environment/sandbox lifecycle records, shared-worker generation receipts and audit events keep
their own retention contracts. Harness can remove its conversation afterwards as an explicit option.
Manual chat deletion refuses tracked unfinished workspace/resource cleanup and pending resource
operations. Unfinished-work discard is not part of this cleanup operation.

[Harness retention](../harness-session-retention/feature.md) uses this coordinator for separately
configured completed-workspace expiry. Background cleanup requires its reviewed optional permission
in addition to source/resource authority. Unfinished/deferred work, active/waiting sessions and
unresolved resource state remain protected. Retention cannot substitute age for verified completion.

A corrective publication after a completed cycle requires a successful Resume after the latest
workspace completion. Source observation does not reopen work, and an older cycle's Resume
does not authorize another corrective publication.

Cleanup refreshes a stale resource revision only when Finish/Dispose has no durable operation
receipt, and saves the replacement request before dispatch. Accepted operations retain their
original request and revision through recovery. External GitHub completion evidence treats
canonical owner/repository URL casing consistently with PR observation.

Pause admission and confirmation serialize with workspace resource allocation. An already-admitted
preview finishes attaching its source consumer before closure; new allocations are refused after
closing starts. Resource, source-owner and shared-worker gates retain that acquisition order.

## Testing Expectations

- Verify all-repository clean/merged evidence, dirty/current-unmerged rejection and exact-head merge
  proof, including released historical source and corrective publication after explicit resume.
- Exercise completion, pause/resume, legacy aliases and retained preview data; source edits do not reopen completed work.
- Close active Docker work, verify removal before lease release, preserve dirty/untracked bytes,
  recover the same pending request across service/browser restart and require explicit Resume.
- Reject new source/worker admissions after closing intent; preserve other owners and prevent
  interrupted close from racing retention. Refresh worker health after terminal session events.
- Preserve source on leases, unknown consumers, partial merges, failed authorization and interrupted
  cleanup; retry with the original UUID/revision and reject conflicting requests.
- Check resource ownership, allocation/delete serialization and source cleanup after child Finish.
- Verify full metadata removal, idempotent authenticated Delete, legacy cleanup, multi-repository
  partial removal and restart recovery; a late PR response must not recreate a removed cache.

- Verify external recovery ownership/grants, explicit exit confirmation, closed admission, exact HEAD,
  consumer and unresolved-operation guards; preserve other leases and source, replay atomically across
  restart, and keep the original Close journal independent from recovery.
- Cover single-confirmation multi-lease closure, cancellation, partial release and original-Close
  replay without widening the confirmed batch or losing a legacy journal.
- Verify sandbox Stop/Start data retention, explicit Delete confirmation, resource owner/context and
  permission checks, closed-start refusal, failed Finish recovery and disposed-context replay.
- Check named ordinary app consumers and collapsed lease diagnostics through Harness.
- Do not equate an API state change with termination of native processes or removal of recovery records.

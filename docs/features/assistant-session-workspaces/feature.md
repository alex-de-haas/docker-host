---
created: 2026-09-27
updated: 2026-10-09
summary: Session-owned logical workspaces group repository worktrees with compatible Git operations and a separately authorized inspection API.
components: [apps/core, apps/harness, apps/workspaces]
---

# Assistant Session Workspaces

## Ownership And Allocation

Core owns a shared bare Git repository per canonical source under
`core/development/repositories/<repository-id>.git` and real linked worktrees under
`core/development/trees/<worktree-id>`. These are independent of application source/cache folders
and assistant transcript retention. The bare repository is shared infrastructure, not a separate
clone for every session. Preparing a workspace does not change the installed app's runtime or data.

A logical workspace belongs exclusively to one assistant installation, administrator and opaque
session ID, or to one typed external principal/user/task reference. It contains one worktree per
canonical repository under the existing allocation rule. Apps in the same repository share that
worktree; their installation identities and manifest subpaths remain separate bindings. Another
repository adds a child to the same logical workspace. A conflicting target branch is refused.
Question-only sessions have no workspace until source preparation.

The aggregate ID is `SHA256("workspace\n" + OwnerIdentity(owner))`. It is derived from persisted
owner records and excludes external display labels. The legacy `DevelopmentWorkspace` record
represents a worktree; its existing `id` remains the identifier in mutation, publication, document
and external MCP APIs. Its additional `workspaceId` identifies the logical group. This additive
projection preserves paths, branches, original/integration bases, grants, leases and replay IDs;
no Git migration or new allocation store is needed. Different assistant installations, users,
sessions or external grants remain separate. Public labels never grant authority.

A group reports `released` only when every authorized child is released; otherwise an unavailable,
preparing or partially released group reports `attention`. There is no aggregate HEAD, branch,
PR completion or new close operation. Child failures do not hide other authorized repositories.

## Authorization And APIs

Core uses the reviewed `apps.sources.full` permission for workspace and publication operations.
Harness requests it; Shell discovers apps with this full-source grant and opens their own source UI.
Core accepts the old `apps.sources` manifest alias and migrates persisted grants without another
review. Install Core before updating Harness to the canonical name. `apps.sources.read` does not
authorize workspace operations. The manifest schema version is unchanged.

Assistant requests use `/api/internal/apps/{assistant}/sessions/{session}/workspaces` with the app
service bearer and `X-Hosty-User-Token`: a browser app identity with current app activity and a live
authorizing Core sign-in. The conversation ID scopes ownership; it requires no separate approval.
Delegated and read-only MCP credentials do not authorize preparation.
Core checks the persisted permission and the user's current administrator/access state on every
request. The interface or assistant role alone grants nothing. Bindings enforce installation, user
and session ownership. Existing read-only Core MCP credentials confer no workspace mutation rights.

| Method / suffix | Operation |
| --- | --- |
| GET collection | List this session's bindings, including released records |
| POST collection | Prepare with `requestId`, `sessionId`, `appId`, `sessionPath`, optional `targetBranch` / `leaseId` |
| GET `/{id}` | Observe current source state |
| GET `/{id}/viewer` | Resolve the installed Workspaces app URL with aggregate and worktree selection |
| POST `/{id}/diff` | Preview `{ path, view: "session" or "local" }` |
| POST `/{id}/operations/{kind}` | Run a managed operation with a UUID `requestId` |

Administrators use `/api/development/workspaces` to list active records across assistants and
`/{id}` to inspect one. Browser POST diff and operation routes require the administrator session and
CSRF. Responses use `Cache-Control: no-store`. Managed requests produce Core audit records; observed
external Git activity does not acquire a fabricated managed-operation audit entry.

[Workspaces](../workspaces-app/feature.md) is the ordinary read-only inspector. Shell displays its
manifest navigation entry without reading source; the former dashboard launcher is removed.
Harness resolves the viewer destination through the owning session's existing Core authorization.
The link opens the current installed `hosty.workspaces` browser origin with workspace and worktree
IDs; an unavailable installation produces a reason instead of a fabricated destination.

## Read-Only Inspection Contract

The routes below live under `/api/internal/apps/{appId}/workspace-inspection`:

| Method / suffix | Result |
| --- | --- |
| GET collection | Authorized logical groups, typed owners and all child records, including clean and released worktrees |
| GET `/{workspaceId}/worktrees/{id}` | Local Git observation, original-base file statuses, up to 100 commits, recorded PR evidence and known consumers |
| GET `/{workspaceId}/worktrees/{id}/diff?path=...&view=session\|local` | Existing bounded, contained regular-file diff; local means uncommitted, session means original base to current files |

All routes require the matching app service bearer, the explicitly reviewed `apps.workspaces.read`
permission and that app's active `hostyg_` user credential. The acting user must currently be an
enabled administrator. Core cookies, delegated credentials and MCP-only credentials do not satisfy
this ordinary app contract. Neither `apps.sources.full` nor `apps.sources.read` implicitly grants
inspection; inspection grants no source, Git or lifecycle mutation authority. The retired
`apps.workspaces.manage` name remains unsupported. Existing assistant and external mutation
credentials retain their original checks; task IDs are not execution authorization boundaries.

Every inventory, detail and diff revalidates effective private-source grants, current app bindings
and source ownership. An inaccessible child is omitted entirely from inventory, including counts;
direct reads refuse access. Diff access is checked again before returning bytes. Historical source
records do not revive a revoked or cleared connection. Administrators may inspect public-source
worktrees across owners; private worktree reads remain with the source owner.

Responses use `Cache-Control: no-store`. The projection excludes source credentials, publication
connection IDs, operation command bodies and transcript content. Local observations do not fetch,
merge, commit, publish or change runtime source. Ahead/behind compares HEAD with the last fetched
target ref. Source previews reuse the regular-file, traversal, binary and output limits of the
existing worktree diff service.

PR URLs remain references when no verified observation exists. Provider facts require a matching
worktree owner, repository, current user-owned unexpired connection and published HEAD. The view
shows the observation timestamp, check states and review summary, without review comment bodies.
It does not call the provider to refresh facts. Older PR cycles retain their URLs and known heads,
not an inferred live state. One merged PR does not close the group.

Known consumers include Core-registered running local services and installed source overrides.
Leases are retained activity claims, not proof of a live agent. This read projection does not
inventory all native processes or Docker mounts and introduces no filesystem isolation.

## Git Operations And Recovery

Core serializes its managed operations. It stores intent, argument fingerprints and results in
owner-only atomic JSON records before advancing Git refs. Retries reuse the exact request ID and
arguments. A reused ID with changed arguments is refused. Pending operations block new mutations
until reconciled; the operation API exposes their durable commands for explicit recovery after reload.

- `commit` takes selected repository-relative `paths`, `expectedHead`, `message`, `authorName` and
  `authorEmail`. An isolated index creates one commit with the supplied attribution, preserving
  unrelated staged paths. HEAD advances with compare-and-swap. No automatic message, squash or amend
  is applied. Interrupted commits with a recorded object at HEAD are recognized without replay;
  their index can require inspection. Unproven outcomes are marked `unknown` for explicit recovery.
- `refresh` fetches the target without modifying the session branch.
- `merge` explicitly integrates the latest target into a clean worktree using the supplied author,
  message and expected HEAD. Conflicts remain visible. `abort-merge` aborts a pending integration
  with an expected HEAD check. Original base and integration base remain distinct.
- `lease` / `release-lease` manage durable activity identifiers. They do not expire merely with time.
- `references` retains bounded HTTPS pull request links. Caller-provided links do not prove merge.
- `cleanup` releases eligible source and its owned branch; its expected HEAD is mandatory.

Git runs non-interactively with hooks, fsmonitor, inherited Git overrides and global credential
helpers disabled. Output and execution time are bounded. These controls cover managed operations;
source content and native agents still belong to the trusted local workflow.

## Observation And Interfaces

A Core background observer refreshes every twenty seconds independently of assistant lifetime.
It reports timestamped local file state, HEAD, ahead/behind counts against the last fetched target,
conflicts and observation errors. Missing or unreadable source is unavailable, never clean.
Direct edits and commits are visible without an assistant notification. One corrupt record is logged
and does not block observation of other workspaces.

Both UIs separate uncommitted changes from original-base-to-current changes. A commit does not empty
the session diff. Repository-wide previews include untracked and committed changes; Shell also filters
by known app subpath and uses its existing text/image diff components. Preview paths, file types and
output sizes are checked. A temporary index preserves the before side when a committed deletion is
recreated as an untracked file, without staging the user's files.

Harness offers `hosty-workspaces` through a loopback, session-key-authenticated MCP endpoint. Core
credentials stay inside Harness. Its own app grant is held only in memory, separately from any
cross-app MCP delegation seed, and supplies source operations and activity leases. Core checks the
current app grant, `apps.sources.full` and administrator on each operation. The grant is not exchanged
for other applications' tokens or persisted with the session. Tools bind to the session and its user; workspace preparation requires
an attached app. The normal provider approval policy remains in effect. Every initial/resumed message
instructs the agent to prepare before editing, work only in registered worktrees, avoid original source
checkouts and use Core Git operations. These are cooperation instructions, not filesystem isolation.

Harness persists workspace associations and checks Core before resuming development after a lost
response or restart. It acquires activity leases before execution, adds a lease when an active agent
prepares source, and releases on an idle result. Lease failures prevent resumption. Cancellation,
process failure or shutdown can leave a conservative lease because provider stop does not prove all
native work has ended. Shell administrators can release it after checking that the consumer stopped.
Deleting an assistant session does not delete Core source.

The Harness session panel offers preparation, target fetch, diff views and explicit cleanup. Shell's
administrator Dashboard lists development across assistants, observations, active leases and recovery
controls. It supports inspection even if the assistant is unavailable.

## Cleanup And Boundaries

Cleanup requires clean, available source without a pending merge, no activity lease, no selected
installed-app source override and no known live local process or Docker mount consuming the tree.
Ordinary workspace cleanup freshly fetches the target and requires the session HEAD to be an ancestor.
A reported PR merge or submitted URL is insufficient. The publication service has a separate internal
cleanup path after a durable authorized completion request and provider verification of the exact
published head. It supports submitted contributions and squash merges without bypassing clean-file,
lease or runtime-consumer checks. Unknown consumer state refuses removal.

Cleanup validates the owned path, repository, registered branch and expected HEAD. It uses ordinary
Git worktree removal without force and preserves retryable `releasing` state after partial failure.
Branch deletion is compare-and-swap and repeats target validation; a changed branch is preserved.
Released records retain ownership, bases, operations and PR references, while active lists exclude
them. Shared repository objects are retained; historical worktree directories are not kept for diffs.
Arbitrary external processes and direct Git changes remain outside managed coordination.

Existing source overrides remain available. Selecting a worktree for isolated execution and separate
test data belongs to [sandbox runtimes](../app-sandbox-runtimes/plan.md). Remote publication, provider
merge verification, CI and PR history belong to [PR lifecycle](../assistant-pr-lifecycle/feature.md).

## Selecting A Workspace For Runtime Development

Selecting a worktree as a runtime app's source requires Core confirmation when requested by an app,
including Shell. Registered worktrees have no exception to this rule. Direct CLI/Core operators can
still select them subject to the common source-path restrictions. Harness's workspace API and source
editing keep their existing `apps.sources.full` authorization; Shell does not acquire that permission.

## Testing Expectations

- Aggregate identity survives serialization, restart and external label changes; two repositories
  join one owner while legacy worktree IDs, paths and operations remain unchanged.
- Inspection requires its distinct grant and current app/admin identity, rejects mixed/Core or
  delegated credentials, and does not authorize legacy mutation routes.
- Test private-source removal, reassignment and credential revocation; unrelated authorized groups
  remain visible while inaccessible metadata and bytes are withheld.
- Exercise clean, unavailable, preparing and released children, path traversal, staged/untracked
  changes, commits and a substituted worktree/group pair without mutating Git state.
- Verify current-origin session links and missing installations, multiple PR cycles, expired or
  removed provider connections, repository/head mismatch and absence of private review bodies.

- Exercise duplicate/concurrent preparation, monorepo bindings, distinct owners, reinstall ownership,
  latest target versus existing base, fetch failure and registry restart without baseline mutation.
- Verify service permission, app audience, current administrator role, browser session/CSRF and
  rejection of invalid service bearers across the real HTTP pipeline.
- Preserve an upgraded Harness full-source grant and its discovery in Shell; documentation-reader
  apps are not source tools and cannot invoke workspace operations.
- Test commit attribution/replay, stale HEAD, direct Git observation, full/local diffs, untracked
  recreation, conflict/abort and recovery without repeating unknown mutations.
- Refuse dirty, unmerged, leased, missing and consumed workspaces; exercise partial cleanup recovery.
  Run the ordinary-app scenario through Core lifecycle and verify the actual local process identity.
- Test MCP authentication/notifications, initial and resumed instructions, no allocation for chat,
  failed activity coordination and UI retry identities/diff views. Build Core, Shell and Harness;
  check Native AOT serialization, versions and the documentation index.

- Verify source/mount approval, protected paths and symlinks, stale snapshots and caller revocation;
  require confirmation for app-selected workspaces and preserve operator authority and intentional Docker source mounts.

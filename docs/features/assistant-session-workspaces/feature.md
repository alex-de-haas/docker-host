# Assistant Session Workspaces

Created: 2026-09-27
Updated: 2026-09-27

## Ownership And Allocation

Core owns a shared bare Git repository per canonical source under
`core/development/repositories/<repository-id>.git` and real linked worktrees under
`core/development/trees/<workspace-id>`. These are independent of application source/cache folders
and assistant transcript retention. The bare repository is shared infrastructure, not a separate
clone for every session. Preparing a workspace does not change the installed app's runtime or data.

A workspace belongs to an assistant app installation, administrator user, opaque session ID and
repository. Apps in the same repository share its branch and worktree; their installation identities
and manifest subpaths remain separate bindings. Different sessions get separate branches. Reinstalling
an assistant does not inherit earlier bindings. Released sessions cannot reallocate the same binding.
Core retains a relative assistant session UI path but does not own conversations.

Preparation is explicit. Attaching app context or sending an ordinary message allocates no source.
Core fetches an explicit development branch, otherwise the manifest source branch, otherwise the
repository's default branch. It records the exact fetched commit as the immutable original base.
The installed package version is unrelated. Fetch failure never selects stale cached source.
Repeated preparation reuses the existing binding without moving its base; conflicting target choices
are refused. A local repository supplies its current branch head, without implicitly fetching its
own remote. Source identities support canonical local Git repositories and credential-free HTTP(S)
URLs. Private source can be supplied through an operator-maintained local repository.

## Authorization And APIs

Core/CLI 0.111.0 adds the reviewed `apps.workspaces.manage` permission. Harness 0.36.0 requests it;
Shell 0.86.0 presents the host-wide overview. Update Core before confirming the Harness update.
An older Core rejects the unknown permission. SDK and manifest schema versions are unchanged.

Assistant requests use `/api/internal/apps/{assistant}/sessions/{session}/workspaces` with the app
service bearer and `X-Hosty-User-Token`: an app-audience delegated token or app identity credential.
Core checks the persisted permission and the user's current administrator/access state on every
request. The interface or assistant role alone grants nothing. Bindings enforce installation, user
and session ownership. Existing read-only Core MCP credentials confer no workspace mutation rights.

| Method / suffix | Operation |
| --- | --- |
| GET collection | List this session's bindings, including released records |
| POST collection | Prepare with `requestId`, `sessionId`, `appId`, `sessionPath`, optional `targetBranch` / `leaseId` |
| GET `/{id}` | Observe current source state |
| POST `/{id}/diff` | Preview `{ path, view: "session" or "local" }` |
| POST `/{id}/operations/{kind}` | Run a managed operation with a UUID `requestId` |

Administrators use `/api/development/workspaces` to list active records across assistants and
`/{id}` to inspect one. Browser POST diff and operation routes require the administrator session and
CSRF. Responses use `Cache-Control: no-store`. Managed requests produce Core audit records; observed
external Git activity does not acquire a fabricated managed-operation audit entry.

## Git Operations And Recovery

Core serializes its managed operations. It stores intent, argument fingerprints and results in
owner-only atomic JSON records before advancing Git refs. Retries reuse the exact request ID and
arguments. A reused ID with changed arguments is refused. Pending operations block new mutations
until reconciled; Shell exposes recovery using their durable commands after reload.

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
credentials stay inside Harness. Tools bind to the session and its user; workspace preparation requires
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
Core freshly fetches the target and requires the session HEAD to be an ancestor. A reported PR merge
or submitted URL is insufficient. Unknown consumer state refuses removal.

Cleanup validates the owned path, repository, registered branch and expected HEAD. It uses ordinary
Git worktree removal without force and preserves retryable `releasing` state after partial failure.
Branch deletion is compare-and-swap and repeats target validation; a changed branch is preserved.
Released records retain ownership, bases, operations and PR references, while active lists exclude
them. Shared repository objects are retained; historical worktree directories are not kept for diffs.
Arbitrary external processes and direct Git changes remain outside managed coordination.

Existing source overrides remain available. Selecting a worktree for isolated execution and separate
test data belongs to [sandbox runtimes](../app-sandbox-runtimes/plan.md). Remote publication, provider
merge verification, CI and PR history belong to [PR lifecycle](../assistant-pr-lifecycle/plan.md).

## Testing Expectations

- Exercise duplicate/concurrent preparation, monorepo bindings, distinct owners, reinstall ownership,
  latest target versus existing base, fetch failure and registry restart without baseline mutation.
- Verify service permission, app audience, current administrator role, browser session/CSRF and
  rejection of invalid service bearers across the real HTTP pipeline.
- Test commit attribution/replay, stale HEAD, direct Git observation, full/local diffs, untracked
  recreation, conflict/abort and recovery without repeating unknown mutations.
- Refuse dirty, unmerged, leased, missing and consumed workspaces; exercise partial cleanup recovery.
  Run the ordinary-app scenario through Core lifecycle and verify the actual local process identity.
- Test MCP authentication/notifications, initial and resumed instructions, no allocation for chat,
  failed activity coordination and UI retry identities/diff views. Build Core, Shell and Harness;
  check Native AOT serialization, versions and the documentation index.

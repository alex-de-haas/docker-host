# Assistant Session Workspaces

Status: Draft
Created: 2026-09-26
Updated: 2026-09-27

Part of [shared assistant development sessions](../assistant-development-sessions/plan.md).
The umbrella's common invariants apply; this feature has independent scope and requires its own Ready approval.

## Target Behavior

A development binding has a stable Core identity linked to the assistant installation and that
assistant's opaque session ID; another assistant or a fresh installation must not inherit it. Store structured references, not facts
that only exist in a model's memory: app/install identity, canonical repository identity, base commit,
target branch, workspace id/path, session branch, grant revision, observed source revision, test
evidence, pushed commit and PR ids/URLs, dependency/release observations and active runtime consumers.
Core is authoritative for workspace paths and lifecycle; Gateway holds durable associations to Core
ids. Exact storage and cross-service recovery are open design questions.

Owner decision, 2026-09-27: Core tracks development sessions, which are sessions that requested a
worktree, across every assistant app. Sessions without a worktree are not tracked. On allocation,
Core records the owning session:

- the requesting assistant app, taken from that app's authenticated identity rather than from a
  caller-supplied app id;
- the assistant's own session id, which is opaque to Core;
- a path that opens the session in that assistant's UI.

Core also observes uncommitted and unpushed changes in the worktree it owns. With the PR facts
recorded by the [PR lifecycle](../assistant-pr-lifecycle/plan.md), this gives administrators one list
of unfinished development work across assistants, including work whose assistant is stopped.
Tracking ends when the worktree is released. Core does not store conversations, and no
Hosty-level archive state is defined.

The assistant requests a workspace when user intent requires authorized source edits. Core validates
that request, allocates/registers the workspace and returns its identity and resolved source path.
The agent's development grant applies to that workspace, not the original baseline source; Core
resolves later commit/push/PR requests against the registered identity rather than trusting an
arbitrary caller-supplied path. Returning a path is not itself filesystem isolation: enforce this
boundary through the [approval rules](../assistant-approval-rules/plan.md) and verified adapter
restrictions before claiming that agents cannot reach protected source or Git metadata.

Allocate a workspace lazily when editing is authorized. Repeated preparation returns the existing
binding, including after a timeout/restart. Use one registered branch/workspace per session and repository, not
per app or provider. Merely discussing another app does not create a writable checkout. Changing
the selected agent does not allocate another workspace. Git remains the source-history mechanism.

The existing source diff compares HEAD with working-tree changes. Add a session-base-to-current
view, including committed and uncommitted changes, while retaining that existing local-change view.
Keep the complete session change view distinct from uncommitted changes: committing must not make
the apparent session diff empty. Group files by app where possible, with an explicit repository-wide
view for shared files and changes outside app subdirectories. Owner clarification, 2026-09-27:
after completed merged work is cleaned up, use the associated pull requests to inspect delivered
changes. The assistant retains repository/provider/PR identifiers and links for its session;
Core can retrieve those PRs with current authorization. Do not retain a worktree, extra Git refs or
a separate diff archive solely for this history. If a PR/repository becomes unavailable, report that
history as unavailable rather than preserving every checkout to guarantee it.

### Managed Source And Override Transition

The owner prefers removing the arbitrary local source override from the normal workflow and using
Hosty-managed repositories as the origin of session worktrees. However, "latest version" must be
resolved before approval: installed/reviewed version, latest release and target-branch head differ.

Proposal: preserve the installed/reviewed source baseline, fetch the configured PR target branch and
create new worktrees from a recorded commit without changing the running baseline. Existing session
bases never move silently when the app updates. Fixing an older installed version may need an explicit
base choice. This proposal is not yet an owner-approved default.

Define canonical repository grouping for monorepos, managed repository placement, app-relative source
paths and how multiple installed apps share objects without duplicating worktrees. Do not assume
one clone per app is the final layout. Before removing overrides, replace their current role in
private-repository access and local development; preserve dirty files and unpublished commits in
existing operator folders. Defer override removal to a separately approved late migration after local/private-repository,
external-agent and self-development parity is demonstrated. Keep the current override workflow until
then. Removal is a migration, not deletion of those folders.

### Runtime Selection And Inspection

Keep runtime profile (how to run) separate from source selection (installed baseline or a specific
session workspace). Use one consistent root for cwd, builds, source mounts, manifest inspection and
diffs. Reuse existing inspected source/runtime contracts rather than rewriting an override setting
behind the user's back.

First proposal: one running source per installed app/environment. Several sessions can edit in
parallel, but selecting another for testing replaces that app's current test runtime. Show the
selected session and the actually running source separately until verified. Preflight, apply and
observe through Core; handle stale selections and failed startup honestly. Existing failure behavior
restores the prior selection and may leave the app stopped, not automatically healthy.

Record which source state a test verified. Later edits invalidate that evidence; hot reload or a
successful build alone does not prove the expected code is running. Worktrees isolate files, not
app data, processes, databases or build caches. Reuse app data only with the existing development
controls' compatibility checks. The follow-up
[sandbox runtimes and agent testing Draft](../app-sandbox-runtimes/plan.md) assesses separate test
data, concurrent runtime instances and browser testing; a separate
[evaluation plan](../agent-app-evaluations/plan.md) owns synthetic feedback. Those features own their
deliverables; the single-runtime proposal above does not provide production isolation. Prefer a
sandbox for agent validation once its runtime/auth boundaries are available and verified.
The first session-source selector refuses switching the currently serving Harness, Shell or Core
to its own active session workspace. Preserve existing explicit operator development workflows;
later self-development needs an independently verified sandbox/controller path and the one-Core-per-host rule.

## Cleanup

The assistant or another authorized client requests cleanup, possibly as part of completion; Core
checks and executes it. Merge observation alone does not delete a workspace. A completed merged
worktree can be removed once no active consumer needs it; it is not retained for historical diff viewing.
Cleanup is distinct from Complete. Remove only Hosty-owned worktrees/branches after checking dirty,
untracked and unpublished work, active agents/builds/runtime consumers and retained PR/history
references. Show why a workspace remains. Choose the return-to-baseline runtime behavior before
implementation; never delete a running source folder. Session deletion/retention and Gateway cache
cleanup cannot bypass this policy or erase source ownership records.

## Git Metadata Boundary And Base Updates

Linked Git worktrees share objects, refs, config and hooks. Granting an agent ordinary writable
access to the common Git directory can let it change another session's branch or the baseline.
A branch name and a writable worktree are not a metadata sandbox. Test two alternatives before
choosing the storage backend; the UI still presents a single session workspace:

- Linked worktrees with Git mutations brokered by Hosty: agents edit allowed source paths and
  request scoped commit/fetch/push operations; Hosty validates repository, refs, credentials and
  safe Git configuration/hooks. Agent filesystem/command access cannot write common metadata.
  Editable commit-cadence instructions remain useful: they decide when to call the commit tool,
  while Hosty controls execution. This does not require arbitrary native `git commit` access.
- Separate clones with private metadata: isolated refs/config/hooks per session, optionally using
  a read-only object pool through reference/alternates. Define pool retention and garbage collection
  so borrowed objects cannot disappear; avoid writable shared objects/hardlinks. Ordinary full
  clones or dissociation are alternatives if pool lifecycle is too complex. Private metadata is
  not by itself protection against unsafe hooks, credential helpers or unrestricted host commands.
  Core still provides managed Git/PR operations. Private metadata may support explicitly authorized
  native local commits if verified isolation protects other workspaces and the baseline; choosing
  this backend does not itself grant that permission or any remote publication authority.

Owner clarification, 2026-09-27: retain Core's workspace lifecycle, managed operation API and
independent observation regardless of backend. Distinguish writable working files, writable Git
metadata and repository-provider credentials. A linked worktree's `.git` file points outside the
working directory; access to that directory alone does not grant the metadata writes required for
a normal commit in the managed repository. Conversely, writable common metadata can affect refs
outside the session. Native local commits are an explicit capability decision, independent of push,
PR creation and remote merge. The backend experiment must settle whether to support that capability;
this clarification does not require a second execution mode.

Core must reconcile actual workspace/Git changes, including authorized direct commits or manual
operator edits. Assistant notifications can accelerate refresh but are not the source of truth.
Remote publication and credential isolation belong to the [PR lifecycle](../assistant-pr-lifecycle/plan.md)
and [approval rules](../assistant-approval-rules/plan.md). A cwd setting or workflow instruction does
not prove exclusive Core authority; verify actual process, filesystem and credential boundaries.

The workspace record must distinguish original session base, current integration base and observed
target head. If the target moves or Publish finds a conflict, report it and run an explicitly
selected merge/rebase under repository policy and applicable authorization. Never silently rewrite
published history. Record old/new commits and conflict resolution, preserve attribution, and
invalidate affected review/test evidence. The PR lifecycle consumes this state.

## References

- [Git worktrees](https://git-scm.com/docs/git-worktree): shared repository metadata.
- [Git clone](https://git-scm.com/docs/git-clone): reference/alternates and borrowed-object lifetime.

## Optional AHP Changeset Projection

Keep Hosty's source/diff model authoritative. After the basic AHP client interface is validated,
evaluate an optional changeset projection over these same diffs, pinned to a compatible protocol
revision. Release-candidate changeset support is a later integration and does not gate existing
web diffs, source selection or workspace ownership. Define adoption scope before approving it.

## Deliverables

- [ ] Select and verify the Git metadata isolation backend with assistant approval rules; implement scoped
  Git operations where needed and decide explicitly whether native local commits are supported,
  independently of remote publication rights.
- [ ] Implement durable repository/workspace registration, lazy idempotent preparation and monorepo app
  bindings.
- [ ] Implement session-wide and uncommitted diff views, source selection and actual runtime revision reporting.
- [ ] Implement explicit target-update/conflict handling and durable source/test provenance.
- [ ] Assess an optional AHP changeset mapping over existing diffs and record an adopt/defer decision;
  any implementation needs its own approved scope and does not gate workspace delivery.
- [ ] Implement Core-driven owned-workspace cleanup and active-consumer protection independently of
  transcript retention; retain session-to-PR links for historical inspection without retained worktrees.
- [ ] Demonstrate override-workflow parity and prepare a separately approved removal/migration before
  disabling overrides.

## Open Questions

- Does managed source follow the installed pin or target-branch head? What is the default new-work base,
  shared-repository layout, private-source credential path and non-destructive override migration?
- What exact Core/Gateway contracts make prepare/attach and cleanup recoverable across partial failures,
  and keep ownership durable across transcript retention, app removal and Gateway removal?
- What permissions and sandbox mechanisms protect baseline source and shared Git metadata while allowing
  registered worktree edits/project commands on both harnesses? Reuse the approval owner.
- What happens to active test runtimes on Complete, and how are source-sensitive caches invalidated? What
  source identity and evidence make a test result stale?
- Linked worktrees with brokered Git or private clones; what object-pool lifetime and credential boundary
  are enforceable? Does the selected backend permit native local commits, and under which grant?

## Verification

- Ordinary Q&A creates no worktree. First edit creates exactly one registered workspace; repeat
  preparation after an uncertain response. Two apps in one repo share it; two repos produce two
  bindings/PRs. A context-only app receives no source-write grant.

- Two sessions edit the same app in separate worktrees. The operator selects each from the UI and
  sees the expected running result and complete/uncommitted diffs, without agent assistance.
  Verify failed/stale switching, edits after testing and baseline/private-source migration behavior.

- Complete while a test runtime still uses the worktree: preserve source and report the cleanup
  blocker. Dirty/unpublished or operator-owned folders are never removed by session/cache retention.
- Complete merged work with no active consumers: delete the worktree, retain all session-to-PR links,
  and retrieve delivered diffs through the PR provider. An inaccessible PR is shown as unavailable.

Test attempted writes to another session branch, main, shared hooks/config and pool objects. Verify base movement, merge conflicts, stale test evidence and refusal of active-controller source switching.
Verify the selected local Git capability separately from file editing and remote publication. Reconcile
authorized direct commits and manual file changes without requiring assistant notifications.

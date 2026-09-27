# Assistant Session Workspaces

Status: In Progress
Created: 2026-09-26
Updated: 2026-09-27

## Goal And Approved Scope

User approval, 2026-09-27: implement the complete workspace feature in one PR. Workspaces, local
Git operations, diffs and cleanup ship here. Selecting a worktree for app execution, independent test
data and test environments belong to [sandbox runtimes](../app-sandbox-runtimes/plan.md), separately.
Agent switching, AHP, remote publication/CI and source-override removal do not gate this feature.

## Decisions

- Core owns real linked Git worktrees, one per assistant installation, user, opaque session ID and
  canonical repository. Apps in a monorepo attach to the same workspace. No workspace is created by
  ordinary conversation or by merely adding app context.
- Prepare fetches the latest development target branch and records its exact commit. Use an explicit
  branch when supplied, otherwise the manifest source branch, otherwise the repository default branch.
  Never fall back to an installed version or stale cached head after fetch failure. Repeated prepare
  returns the existing binding without moving its base; conflicting branch choices require a new session.
- Use a shared Core-owned bare repository per canonical source identity under Core's development
  directory, with linked worktrees outside app data/cache. No operator checkout or running baseline
  is mutated. Canonical local Git repositories and credential-free HTTP(S) sources are supported;
  local repositories provide their current branch head, not a promise of an upstream fetch. Private
  source can use an operator-managed local repository. New private remote credential management and
  migration/removal of existing overrides remain separate work.
- Core durably stores ownership (assistant installation timestamp, user and session), app bindings,
  repository, original base, integration base, observed target, branch/path and operation results.
  It records an assistant-relative session UI path. Reinstalling an assistant does not inherit old
  bindings; uninstall/transcript retention never deletes development source.
- Core API authorization remains enforced. An assistant needs a reviewed `apps.workspaces.manage`
  core permission, its service token and a current administrator credential addressed to that app.
  Requests are scoped to that assistant installation/user/session. Browser administrators can inspect
  all workspaces and request cleanup. Existing delegated read-only Core MCP gains no mutation rights.
- Harness exposes session-bound workspace tools to its agents and manual workspace controls in its UI.
  Agents receive instructions naming assigned roots, avoiding original checkouts and using Core Git
  operations. Existing approvals/restrictions remain; no new agent sandbox or filesystem guarantee is
  introduced. Managed commits are the intended path; independent observation discovers direct commits
  and edits without inventing Core audit records for them.
- Prepare and Git mutation requests use durable request IDs. Persist intent before side effects and
  reconcile uncertain outcomes after restart; never blindly replay an uncertain commit/integration.
  Serialize managed mutations per repository. Stale expected HEADs fail instead of changing new work.
- Local operations cover explicit commit of selected paths with provided attribution/message, refresh
  of target state, and explicit merge of the target branch with conflict reporting/abort. No automatic
  rebase or history rewrite. Push/PR/merge on the remote provider belong to the PR lifecycle plan.
- Show both uncommitted changes and original-base-to-current changes including commits; committing
  does not empty the session diff. Include untracked files and repository-wide paths, with app path
  associations when known. Bound Git output and reject unsafe preview paths.
- Observe registered workspaces independently of assistant lifetime, publish observation timestamps
  and errors, and keep dirty, commit and target state separate. Missing source is unavailable, not clean.
- Cleanup is explicitly requested, never triggered by observing a merge alone. Refuse dirty/untracked
  or unmerged/unpublished work, active leases and known running source consumers. Validate ownership
  and Git registration; never force-delete operator folders. A clean branch already contained in the
  freshly fetched target is eligible. Keep retryable cleanup state through partial failure. Released
  workspace records retain identifiers/results but are excluded from the active development list.
- Consumers register activity leases. Harness renews them during active turns and releases on idle;
  unknown or failed lease coordination must not allow execution to race cleanup. Existing Core runtime
  consumers are checked before cleanup; arbitrary external processes are outside the cooperation guarantee.
- PR references, when supplied, remain structured links associated with the session/workspace and are
  returned on cleanup so Harness can retain them. Provider-backed history and remote merge validation
  remain owned by [PR lifecycle](../assistant-pr-lifecycle/plan.md); caller references alone never
  establish merge eligibility. No worktree is retained solely for historical diffs.
- Optional AHP changeset projection is deferred to the AHP feature: existing diff APIs are sufficient.

## Deliverables

- [x] Durable repository/workspace registry, canonical monorepo grouping and idempotent lazy allocation.
- [x] Authorized Core APIs and scoped local Git operations with durable recovery and independent observation.
- [x] Harness tools, instructions, durable session associations, active-use coordination and manual controls.
- [x] Complete/uncommitted diff views and administrator overview across assistants, with app associations.
- [x] Recoverable owned-workspace cleanup with change/merge/consumer checks and retained references.
- [ ] Verify failure/restart/authorization cases, update feature docs and versions, delete this plan and regenerate index.

## Open Questions

None. Runtime/testing scope was explicitly deferred by the owner before Ready; implementation details
follow the decisions above. Any newly discovered product-level conflict must be raised before changing scope.

## Verification

Use disposable local Git origins and isolated Core data roots. Test duplicate/concurrent prepare,
monorepos, target movement/fetch failure, independent sessions and ownership after reinstall; no
baseline changes. Test unauthorized API calls and stale HEADs. Commit, observe a direct commit, show
both diff views and retain untracked files. Exercise conflict/abort, uncertain operation recovery,
Core restart and unavailable repositories. Cleanup must refuse active/dirty/unmerged work, succeed
only for owned eligible worktrees and remain replayable after partial failure. Verify agent instructions
on initial/resumed turns and that ordinary chat allocates nothing. Test Shell/Harness controls and a
Core-managed ordinary-app scenario without switching the app runtime. Run affected suites/builds,
version/doc checks and Native AOT-compatible JSON serialization checks.

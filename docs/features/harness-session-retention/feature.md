---
created: 2026-10-16
updated: 2026-10-19
summary: Harness applies independent chat and completed-workspace retention, preserves unfinished work, and recovers coordinated cleanup with stable operation IDs.
components: [apps/harness, apps/core]
---

# Harness Session Retention

## Settings And Eligibility

Harness Settings → Instructions and retention exposes independent ordinary-chat and
completed-workspace durations. Each accepts whole days from 1 to 3650 or Off. Ordinary chats inherit
`HOSTY_HARNESS_RETENTION_DAYS` until explicitly configured (30 days by default). Completed-workspace
expiry defaults to Off. Upgrading does not enable it. Invalid persisted retention settings disable
expiry; unknown legacy sessions remain until Core can reconcile their resource ownership.

The manager checks retention at startup and daily, and serializes each check with that session's
mutations. Eligibility is visible beneath the conversation header: protected, off, scheduled,
blocked or deleting, with the reason, completion time and eligibility date when available.
Refresh obtains current Core evidence. Retry eligible cleanup retries only that conversation under
the current policy; it is not a force-delete or an alternative completion action.

Ordinary inactive chats use their last activity time. Active turns, pending answers/approvals,
queued completion, unresolved handoffs and resource operations prevent expiry. Sandbox-only chats
with live resources remain protected until explicit Finish; terminal resource ownership is reconciled
before ordinary-chat expiry. A lack of currently displayed worktrees is not proof of an ordinary chat.

Development expiry requires an explicit, Core-verified completion transition. Core checks clean
source and current-head integration for every repository under the
[workspace lifecycle contract](../workspace-lifecycle-controls/feature.md). A closed PR, green CI,
one merged repository or inactivity cannot complete work. In-progress, deferred and unknown work
never expires, even when its source is already merged. The deadline starts at the later of verified
completion and conversation activity. Resume clears completion; newly observed edits remain fenced and fail fresh cleanup checks.
Core checks again immediately before deleting source. Missing evidence or Core failure preserves work.

## Authorization, Cleanup And Recovery

Core exposes POST `/api/internal/apps/{appId}/sessions/{sessionId}/retention` for an installed,
confirmed assistant's service identity. The original session owner must still be an enabled
administrator. Core resolves the workspace and resources from the installation, owner and session;
the caller cannot submit an arbitrary workspace ID. Retained source owned by an earlier installation
blocks classification until reconciled. No browser credential is saved for scheduled execution.

Background source cleanup additionally requires the explicitly reviewed optional
`apps.workspaces.cleanup` permission and existing full source authority. Existing sandbox/environment
management permissions still apply. Turning on a duration does not silently grant these permissions.
A missing grant produces a visible blocked outcome with source and conversation retained.

Harness saves the cleanup UUID and expected workflow revision before requesting deletion. The
existing Core coordinator journals owned sandbox Finish, checks source consumers and releases eligible
worktrees. Harness removes the conversation and session cache only after confirmed resource cleanup.
Errors preserve a retryable record, including the original operation identity. A restart or lost
response does not authorize a replacement request. Native execution must stop successfully before
local removal. Published PRs and other assistants' conversations are not deleted.

Manual conversation removal also reconciles Core ownership; unfinished source, live resources and
pending operations block it. Complete/Delete workspace remains the explicit path for development
work. Retention never invokes unfinished-work discard or cancels unknown external processes. Core
removes workspace records and the temporary deletion journal after successful Delete, while shared
repositories retain their separate ownership. Harness keeps no hidden archive of a deleted conversation.

Core returns an explicit `workspaceAbsent` confirmation after checking stored worktree evidence and
any unfinished deletion journal. Harness combines this with its local workspace history to reconcile
a deleted workspace, including a lost Delete response followed by restart. It still requires finished
resources and applies the completed-workspace policy, including Off. It uses the saved completion
time when available, otherwise conversation activity. Older Core responses without this confirmation
keep ambiguous history blocked; an empty displayed list alone never authorizes deletion.

## Acceptance (2026-10-16)

The D5 acceptance uses the working tree based on `9964fa1814c2cbe2b8a7f3fd495303ef37620e07`,
Core 0.137.0 and Harness 0.55.0. A disposable Core uses normal setup/password authentication and a
Core-managed source Harness. Browser checks save custom workflow instructions, select two-day
ordinary and seven-day completed-workspace policies, and confirm persistence after reload.
These are test settings, not changes to the operator's main installation.

Three disposable conversations exercise the real startup sweep. Only their activity/completion
timestamps are aged to make the policy immediately due; source verification still uses actual Git
worktrees and a successful Core completion transition. The ordinary chat disappears. The dirty,
in-progress worktree and its conversation remain; the browser reports protected retention and the
one-file diff, and the original file content is unchanged. The completed worktree first remains
blocked because the installation lacks the optional cleanup permission. After the owner explicitly
approves that grant in the test Core, retry uses the saved UUID/revision and removes both source and
conversation. The original cleanup journal confirms that identity. Only the unfinished conversation
remains in the Harness inventory.

The test Harness and Core are stopped, the owned stopped Marketplace container is removed, and the
disposable data/build roots are deleted, including temporary account credentials and the test-only
grant. Owned container/network/volume inventories are empty. Existing operator Core, containers,
media and caches are untouched. Screenshots and raw probe output remain outside the repository.

Verification:

- `npm test --workspace @haas/hosty-harness`: 652 tests across 79 files pass.
- `npm run lint --workspace @haas/hosty-harness` and
  `npm run lint --workspace @haas/hosty-harness-web`: pass.
- `npm run build:web --workspace @haas/hosty-harness`: production static build passes.
- `dotnet test apps/core/tests/Haas.Hosty.Core.Tests/Haas.Hosty.Core.Tests.csproj` with the affected
  retention/workflow/authorization selection: 15 tests pass, none skipped. Tests use isolated stores
  and actual disposable Git repositories; endpoint tests exercise service identity and permissions.
- The exact Core project builds with isolated artifacts; four existing compiler/platform warnings
  remain. This is affected-test coverage, not a repeat of the full Core suite.
- Prompt delivery is checked at the adapter boundary. This D5 probe makes no paid provider call and
  does not repeat D4's real-agent sandbox/browser acceptance. UI continuity and recovery acceptance is recorded in
  [Harness UI D6](../harness-development-ui/feature.md#d6-responsive-navigation-and-recovery-acceptance-2026-10-16).

An interrupted workspace pause is protected from expiry, including an older completed iteration.
Pause alone never establishes completion or starts a completed-workspace retention deadline.

## Testing Expectations

- Cover exact timer boundaries, independent Off settings, later conversation activity, default and
  legacy migration, corrupt configuration and unavailable Core classification.
- Preserve unfinished/deferred work regardless of age, including hidden resource history, a
  closed-unmerged PR, partial multi-repository integration, new edits and explicit resume.
- Exclude active execution, pending questions/approvals, handoffs and resource operations; reconcile
  sandbox-only sessions before deleting their conversation.
- Exercise service identity, current installation/session ownership, still-enabled administrator
  ownership, explicit cleanup permission and source/resource grants without saved browser tokens.
- Recheck Core heads/leases/consumers before deletion. Recover lost responses and partial cleanup
  after restart with the original UUID/revision; preserve source/history on unknown outcomes.
- Verify settings persistence and visible eligibility/blockers through normal Core-managed browser
  authentication, and confirm physical worktree/cache removal separately from conversation deletion.

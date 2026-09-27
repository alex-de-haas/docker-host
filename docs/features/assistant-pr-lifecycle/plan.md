# Assistant Pull Request Lifecycle

Status: Draft
Created: 2026-09-26
Updated: 2026-09-27

Part of [shared assistant development sessions](../assistant-development-sessions/plan.md).
The umbrella's common invariants apply; this feature has independent scope and requires its own Ready approval.

## Target Behavior

Owner clarification, 2026-09-27: separate the assistant's workflow decisions from Core's managed
operations and factual development state. This replaces the ambiguous statement that Core "runs the
pipeline": Core is not the decision-maker for commit cadence, PR timing or draft-versus-ready intent.

- **The assistant decides and requests.** It interprets user intent, decides when source changes need
  a worktree, chooses commit boundaries/messages and requests creation of a draft or ready PR. It
  decides when to request subsequent push, readiness, merge, Complete and cleanup operations under
  the applicable user/repository instructions. Harness is one implementation of this behavior.
- **Core validates and executes.** Core provides the managed worktree and Git/provider
  operations. It checks caller/user authority, registered workspace ownership, prerequisite resources,
  expected revisions and operation-specific gates. A commit request without an authorized workspace
  fails; a request referring to the baseline or another session's workspace cannot substitute for it.
  Requests and results have durable identities and recovery after timeout/restart.
  This API remains useful even where an operator or explicitly authorized external agent can act
  directly. Exclusive execution is a separate isolation guarantee, not a consequence of API ownership.
- **Core observes independently.** It records actual workspace state and commit/PR milestones and
  monitors CI/review for every linked PR, including drafts. Monitoring continues when the assistant
  is stopped or the UI is closed. It does not invent the next development command from these facts:
  a commit does not trigger PR creation, a ready PR does not prove finished editing, and successful
  checks do not trigger merge without an authorized request or a separately approved automation.
- Harness presents Core's observations and uses the agent for source edits and review fixes. It
  does not maintain a competing authoritative copy of Git/PR operation state. Another assistant can
  choose a different cadence while calling the same Core operations and obeying the same invariants.

- Preserve session-to-PR references in the assistant's session record before completing cleanup.
  PR identifiers/URLs, repository/provider identity and commit references allow Core to retrieve
  historical changes and status from the provider after the worktree is removed. A session may have
  several repository or corrective PRs. No historical worktree/diff archive is required; unavailable
  provider data is reported as unavailable. Core's existing audit remains independent of chat history.

## Observed Milestones And Independent Status

Core derives the development summary from observed facts rather than from a single irreversible
linear phase or an assistant-supplied claim:

| Dimension | Facts Core tracks |
| --- | --- |
| Workspace | Registered/available/released, dirty and untracked files, active runtime consumers |
| Commits | Base and current commit, commits since the base, pushed head and unpublished changes |
| Pull request | None, draft, ready for review, closed-unmerged or merged, per repository/PR |
| CI and review | Pending/running/passed/failed/unknown results tied to the relevant head revision |
| Completion | Required post-merge evidence and resource-cleanup eligibility |

A summary may describe "workspace prepared", "local changes", "draft PR" or "PR under review",
but the underlying facts remain visible together. Editing can continue while a draft or ready PR
has CI running. New commits invalidate relevant old-head evidence without discarding its history.
If changes are made outside an observed Core command, refresh Git/provider state rather than
assuming the command log alone is the current truth. Record observation freshness and unavailable
results explicitly. With multiple workspaces/PRs, preserve per-resource state and partial completion.

Assistant notifications request refresh and may supply candidate PR references; they do not prove
that an operation succeeded. Validate repository, branch/head and provider identity before linking
a discovered PR to a workspace. Reconcile without notifications, including after Core restart and
after manual operator actions. Filesystem observation alone cannot establish remote PR/merge state;
query the provider with appropriate read authority. An observed external merge records a fact, not
proof that it passed Core's merge gates or authorization checks.

Editable workflow instructions govern commit cadence, messages, PR content and how the agent
responds to review. Repository instructions and allowed merge methods remain applicable. Hosty
executes authorized Git/provider operations with structured results and recoverable identities;
the agent supplies descriptions and fixes. Publish creates or updates PRs for changed repositories
and preserves partial progress without duplicating a PR after an uncertain response.

Merge eligibility checks the latest pushed head, required CI, required approvals, unresolved review
threads/blocking reviews and provider mergeability. Ordinary discussion comments have no universal
resolved flag. Do not auto-resolve a review thread merely to pass a gate. Unknown/pending checks are
not success, and new commits require new evidence. The operator chooses a merge method permitted by
repository policy; this repository currently requires regular merge commits, not squash.

For independent PRs, prefer checking all candidates before starting merge. This is not an atomic
cross-repository transaction: revalidate each merge and preserve partial results. For dependencies,
store an explicit ordered plan such as SDK PR merge -> exact package version available -> update
consumer dependency/lockfile -> new CI/review -> consumer merge. An expected unpublished dependency
is different from an unexplained failing check. Detect unresolved ordering/cycles rather than
letting the agent silently waive eligibility. In this monorepo, Shell uses the workspace SDK, so
their compatible source changes can share one PR without waiting for npm publication.

Merge leaves the session open. Observe the required main-branch checks and publication runs for
the actual merge/corrective commits and exact artifacts, not an unrelated moving latest-main badge.
If a post-merge failure needs code changes, prepare a fresh corrective branch/PR linked to the same
session; a merged PR cannot receive another update. This is an explicit exception to the normal
one-PR-per-repository rule, limited to finishing the same feature. Re-runs without source changes
need not create a PR. Release success and installation/deployment are separate facts.

Core accepts a requested Complete operation only when all required PRs, post-merge checks and
artifact conditions are satisfied and no session changes remain unpublished. The assistant keeps its
conversation and PR references viewable under its own retention policy; subsequent
feature work starts a new session with optional copied context and fresh source bindings. Failed,
closed-unmerged or abandoned work needs an explicit disposition and is not silently called Complete.
PR/CI monitoring belongs to durable Core work with scoped authorization, not an open browser or
an endlessly running model turn.

Core executes requested cleanup through [session workspaces](../assistant-session-workspaces/plan.md);
completion does not override its retention or active-runtime protections. Observed merge alone does
not authorize deletion; an authorized cleanup request can be part of the requested completion flow.

## Credentials And Commit Attribution

Use [app secrets storage](../app-secrets-store/feature.md) and its
[hardening plan](../app-secrets-store/plan.md) for a reviewed per-user/provider credential design.
Specify who may use repository tokens for push, PRs and CI reads, their scopes, revocation and
renewal. Keep tokens outside model context, source, commit metadata and published artifacts;
credential helpers are part of the workspace execution boundary, not arbitrary agent configuration.

Keep Core-managed publication credentials on the Core side of the execution boundary. Source edits,
native local commits, push, PR creation and remote PR merge are distinct capabilities. A local commit
needs writable Git metadata; provider operations need network access and credentials with the
necessary rights and can act on already-published branches without a local checkout. Do not claim
that withholding baseline source prevents remote publication. Verify inherited credentials, stored
CLI authentication, helpers and host-control access with the approval/workspace plans before claiming
that an agent cannot bypass Core. Under broad operator-equivalent process access, the Core API is a
managed convenience and observation path, not an exclusive authority. Selecting native local commit
support does not implicitly grant remote credentials or bypass Core's managed-operation checks.

Resolve commit author/committer explicitly and derive agent Co-Authored-By trailers from recorded
contributions, not the currently selected model alone. Mixed Codex/Claude contributions may need
both trailers under repository policy; do not credit a reviewer merely for being present in chat.
Retain reviewed attribution when squashing or integrating where the repository permits that method.
Commit cadence instructions govern when the agent requests a commit even when Hosty executes it.

Before Publish, consume the workspace's target-head/conflict state and require any necessary
integration and fresh checks. PR state is scoped to a concrete pushed head and repository credential.

## Deliverables

- [ ] Implement Core's managed development operation API and durable request/result recovery; expose
  observed workspace/commit/PR milestones and independent CI/review state to assistant clients.
- [ ] Monitor draft and ready PRs independently of assistant/UI lifetime, with head-bound evidence,
  observation freshness and recovery after Core restart; reconcile external actions without assistant
  notifications and validate candidate PR associations against provider facts.
- [ ] Implement idempotent Publish/update per repository with editable workflow instructions and recorded
  commit attribution.
- [ ] Implement scoped repository-provider credentials, CI/review observation and exact-head merge gates;
  verify the credential boundary with approval rules independently of native local commit permission.
- [ ] Implement dependency-ordered and multi-repository merge recovery, including artifact/version observation.
- [ ] Implement Core-owned post-merge verification, corrective PRs, Complete gates and workspace cleanup;
  persist session-to-PR associations and support provider-backed history after checkout removal.

## Open Questions

- Which repository provider ships first, which CI/review/release conditions are required, and what
  approvals govern ordered merges and dependent follow-up commits? How are cycles and abandoned PRs
  handled?
- Which credentials, commit identities and contribution attribution sources are supported first?
- Which authenticated assistant/user grants permit managed development operations, and how are
  operation results, PR-reference delivery and cleanup reconciled after either service restarts?
- Which transport exposes these operations to agents (for example, a scoped MCP adapter over the
  same Core services)? Transport must preserve the operation API's identity, permissions and gates.

## Verification

- Verify different assistant commit/PR cadences against the same Core API. Refuse commits without a
  registered authorized workspace. Workspace allocation grants only the selected source root;
  verify protected baseline/shared Git metadata and provider credentials against the selected execution
  boundary. If native local commits are supported, test them without granting push/PR/merge authority.
- Make authorized changes outside Core's API and omit or duplicate assistant notifications. Reconcile
  actual commits and remote PR/merge state after restart; reject mismatched candidate PR associations
  and do not label an external merge as having passed Core's gates.
- Creating either a draft or ready PR starts CI/review observation. Stop the assistant and close the
  UI: monitoring continues. A passed check alone neither merges the PR nor releases the worktree.
  Continue editing while CI runs and verify independent dirty/PR/check state and stale-head handling.
- Exercise early Draft PR, repeated Publish, review corrections, multi-repo partial publication,
  failed/unknown CI, unresolved reviews, stale head and concurrent merge changes without duplicate PRs.

- Merge an SDK dependency, wait for its exact artifact, update the consumer and require fresh checks.
  Test failed publication and recovery. Also test the monorepo Shell/SDK single-PR path.

- Fail a required post-merge job: Complete remains unavailable, a corrective PR remains in the same
  session, and successful correction/checks permit completion without unrelated later-main interference.

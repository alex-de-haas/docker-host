# Assistant Pull Request Lifecycle

Status: Draft
Created: 2026-09-26
Updated: 2026-09-26

Part of [shared assistant development sessions](../assistant-development-sessions/plan.md).
The umbrella's common invariants apply; this feature has independent scope and requires its own Ready approval.

## Target Behavior

These are proposed development states, independent of whether an agent turn is idle or running:
editing -> PR review -> partially/fully merged -> post-merge verification -> completed.
Record failures and per-repository state; Publish can recur, and early Draft PRs are supported.

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

Complete finalizes the development session only when all required PRs, post-merge checks and artifact
conditions are satisfied and no session changes remain unpublished. Keep it viewable; subsequent
feature work starts a new session with optional copied context and fresh source bindings. Failed,
closed-unmerged or abandoned work needs an explicit disposition and is not silently called Complete.
PR/CI monitoring belongs to durable server work with scoped authorization, not an open browser or
an endlessly running model turn.

Cleanup is requested through [session workspaces](../assistant-session-workspaces/plan.md);
completion does not override its retention or active-runtime protections.

## Credentials And Commit Attribution

Use [app secrets storage](../app-secrets-store/feature.md) and its
[hardening plan](../app-secrets-store/plan.md) for a reviewed per-user/provider credential design.
Specify who may use repository tokens for push, PRs and CI reads, their scopes, revocation and
renewal. Keep tokens outside model context, source, commit metadata and published artifacts;
credential helpers are part of the workspace execution boundary, not arbitrary agent configuration.

Resolve commit author/committer explicitly and derive agent Co-Authored-By trailers from recorded
contributions, not the currently selected model alone. Mixed Codex/Claude contributions may need
both trailers under repository policy; do not credit a reviewer merely for being present in chat.
Retain reviewed attribution when squashing or integrating where the repository permits that method.
Commit cadence instructions govern when the agent requests a commit even when Hosty executes it.

Before Publish, consume the workspace's target-head/conflict state and require any necessary
integration and fresh checks. PR state is scoped to a concrete pushed head and repository credential.

## Deliverables

- [ ] Implement idempotent Publish/update per repository with editable workflow instructions and recorded
  commit attribution.
- [ ] Implement scoped repository-provider credentials, CI/review observation and exact-head merge gates.
- [ ] Implement dependency-ordered and multi-repository merge recovery, including artifact/version observation.
- [ ] Implement post-merge verification, corrective PRs and Complete gates with workspace-cleanup handoff.

## Open Questions

- Which repository provider ships first, which CI/review/release conditions are required, and what
  approvals govern ordered merges and dependent follow-up commits? How are cycles and abandoned PRs
  handled?
- Which credentials, commit identities and contribution attribution sources are supported first?

## Verification

- Exercise early Draft PR, repeated Publish, review corrections, multi-repo partial publication,
  failed/unknown CI, unresolved reviews, stale head and concurrent merge changes without duplicate PRs.

- Merge an SDK dependency, wait for its exact artifact, update the consumer and require fresh checks.
  Test failed publication and recovery. Also test the monorepo Shell/SDK single-PR path.

- Fail a required post-merge job: Complete remains unavailable, a corrective PR remains in the same
  session, and successful correction/checks permit completion without unrelated later-main interference.

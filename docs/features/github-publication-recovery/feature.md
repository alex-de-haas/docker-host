---
created: 2026-11-09
updated: 2026-11-09
summary: GitHub workflow authorization, actionable push rejection diagnostics and same-account connection renewal preserve existing publication bindings.
components: [apps/core, apps/shell]
---

# GitHub Publication Recovery

Core composes [user connections](../user-profile-connections/feature.md) and the
[assistant PR lifecycle](../assistant-pr-lifecycle/feature.md) so an existing publication can
recover from insufficient GitHub permissions without replacing its connection or worktree.

## Authorization and binding preservation

GitHub OAuth requests workflow access alongside the selected public/private repository scope,
email attribution and supported offline renewal. Core retains bounded granted-scope evidence when
GitHub supplies it. Legacy unknown repository access needs an explicit owner choice; known private
access is retained. Explicit insufficient OAuth grants refuse replacement of the old credential.

Shell's Reconnect action renews the selected connection through Core. OAuth and PAT renewal verify
the same provider/account and preserve the connection ID, owner, label and creation time. Existing
source grants, remote associations, publication records and request IDs retain their references.
Cancellation, provider failure and identity mismatch leave the old credential intact. Revision
checks fence concurrent changes; transient polling failure retains the attempt for Retry or Cancel.

## Push diagnostics and recovery

Core recognizes definite workflow-permission, authentication, repository-access, branch-rule,
non-fast-forward and explicit ref rejections. It returns fixed actionable messages and stores safe
error codes in the acting caller's receipt. Raw provider output and credentials stay excluded.
Timeouts, transport loss and unrecognized outcomes remain uncertain with bounded diagnostic
categories and the original request ID. A retry reconciles remote state and existing PRs without
force-push or a duplicate PR.

## Platform verification

The managed acceptance suite uses a test-only provider, normal password login and separate data.
It verifies PAT and OAuth renewal, retained IDs/private access, cross-user/account denial, cancel,
PR coverage and managed child restart. Shell's browser path uses ordinary Core identity and a
reviewed connection-management permission. Its owner finishes the child and confirms removal.

The 2026-11-09 live verification uses the existing Trading Lab connection. The original Harness
session first receives publication_push_workflow_permission_required, then retries the same push
request after owner-approved OAuth renewal and creates
[Trading Lab PR 1](https://github.com/alex-de-haas/trading-lab/pull/1) at source commit
ee63bbeb81cfaf42bef92c1222cffb13b3bac99f. Its ci-required check succeeds. The grouped
[workspace activation](../workspace-live-activation/feature.md) Return restores the captured Core
release and Shell Docker runtime while retaining the renewed credential and publication.
This verification does not publish a release/feed, merge the PR or submit a catalog entry.

## Testing Expectations

- Cover workflow scope requests, bounded scope metadata, legacy explicit access decisions and
  insufficient grants without replacing the current credential.
- Verify same-ID OAuth/PAT renewal, provider/account and owner isolation, source-grant retention,
  concurrent revision changes, cancellation, failure and transient polling recovery.
- Verify safe push classifications and receipt persistence, genuine uncertainty and recovery using
  the original request ID, excluding secrets and duplicate PRs.
- Run affected Core/HTTP and Shell tests, exact Core and Shell builds, Native AOT, version and
  documentation checks, and the pull-requests managed integration suite.
- Keep live OAuth consent with its owner. Verify actual provider head/PR evidence, then complete
  authorized Return and sandbox Finish independently from source completion.

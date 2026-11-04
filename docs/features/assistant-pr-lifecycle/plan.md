---
status: In Progress
created: 2026-11-04
updated: 2026-11-04
summary: Diagnose post-merge completion blockers and explicitly repair mistaken publication policies without weakening automatic evidence checks.
components: [apps/core, apps/harness]
---

# Publication Completion Recovery

## Goal

Recover a merged publication whose completion policy accidentally requires a PR-only check.
Project Manager PR #138 demonstrates the issue: its Docker check succeeds on the PR head but
never runs on the merge commit, while main CI and ready-release publication both succeed.
The existing configuration lock leaves no supported correction path.

## Target Behavior

Extend [the existing lifecycle](feature.md), preserving its merge-bound evidence contract:

- Report the unmet configured check, workflow or artifact and the exact merge SHA. Distinguish
  missing, pending, failed and unavailable evidence without exposing provider credentials.
- Keep ordinary configuration locked after publication. Add an explicit amendment to the existing
  configure operation for an unfinished, merged publication: require the exact published/worktree
  head, the previous policy and a bounded nonempty correction reason alongside the new policy.
- Revalidate the current caller, selected connection, repository, PR, branch and merge facts.
  Reject stale prior policies, changed heads, open/closed-unmerged PRs and final outcomes.
  Preserve connection, destination, dependencies and cleanup intent; do not create a fork or push.
- Journal old/new policy and reason with the acting user and immutable request ID. Same-request
  recovery stays idempotent. Reobserve evidence under the amended policy; changing requirements
  never marks completion or schedules cleanup. Completion remains a separate verified operation.
- Explain in Core/Harness tool contracts that requiredChecks are merge-commit checks. PR gates
  remain independent. A merge-bound successful ready-release workflow is valid completion evidence
  for a release that reuses an older image digest; do not relax GHCR revision-label verification.
- Repair PR #138 using its verified merge-bound main CI and ready-release workflow requirements,
  then complete the publication with cleanup disabled after the fixed release is installed.

## Deliverables

- [x] D1. Implement actionable completion diagnostics and regression coverage for PR-only checks,
  failed/pending/missing evidence and unrelated commit results.
- [x] D2. Implement guarded policy amendment and Core/Harness contract coverage, including authority,
  stale-policy/head rejection, unchanged bindings/dependencies, replay and separate completion.
- [ ] D3. Verify affected unit/integration tests and builds in the registered worktree and an isolated
  child Core; update current documentation, remove this plan and regenerate the index in one PR.
  Bump the platform and any changed runtime artifact according to repository versioning rules.

## Phases

Diagnostics and recovery contract, tests and isolated acceptance, then one PR and release rollout.
The final PR documents the live acceptance procedure below. Implementation completion and
post-publication operational acceptance are separate facts; source-only tests do not prove rollout.

## Operational Rollout

After green CI and regular merge, verify publication and update the parent Core through its
supported release path while preserving apps. Close the retained PR #138 publication using the
amended-policy and completion operations, with cleanup disabled. Keep dev installations unchanged.
Report the live result separately from implementation verification.

## Open Questions

None. The owner explicitly approved the complete plan and live PR #138 recovery in chat on 2026-11-04, preserving dev installations.

## Verification

Use an unrelated repository/app identity in fixtures and retain exact merge-bound checks. Cover
missing PR-only checks without treating their PR-head success as post-merge evidence; ensure a
failed merge check or release workflow still blocks completion. Verify retry fingerprints remain
compatible when new optional fields are absent. Exercise correction after source-workspace completion
without reopening source, and rejection for paused/deleting workspaces. Use separate child data and
normal setup/login; never copy live provider credentials into tests. Real PR #138 recovery uses the
existing authorized parent connection after release, with no source cleanup or app lifecycle changes.

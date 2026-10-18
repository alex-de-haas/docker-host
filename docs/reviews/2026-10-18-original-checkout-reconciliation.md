# Original checkout planning reconciliation — 2026-10-18

Baseline: original checkout `f146d0ddd810eeaaa1d9cc922bf6c000a6d1d3e2`, reconciled onto
`baf45dce16fff70f5e54cb1e8a0564f5c3ce30c0`. The original was 155 commits behind, with 74 modified
tracked files and 117 untracked files. Product changes were already represented in merged history;
unpublished planning material required preservation. A verified external archive retains all 191
changed/untracked files and binary patches. Raw evidence and logs are not part of this PR.

## Preserved material

- [Agent skills](../features/agent-skills/plan.md): full Draft and dated research, including the
  selected bind-mount direction. Raw JSON stays in the operator's external archive; prose results
  and limitations remain in the plan. Corrected obsolete sandbox/shared-worker baseline statements.
- [Source recovery](../features/runtime-source-workflows/plan.md): full On Hold proposal, with
  historical defect observations explicitly separated from shipped unified dev mode.
- [External development](../features/external-development-workspaces/plan.md): recovered Draft.
  Its unpublished D1-D6 collided with retired IDs from the earlier completed plan; the preserved
  proposal uses D7-D12 respectively, with updated cross-references.
- [Vision](../vision.md): local decisions 41/42 become 46/47 because main already assigned 41-43.
  Local SSE decision 43 is already main's 44. Decision 48 records the new operational migration.
- [Design system](../features/design-system/plan.md): functional parity becomes D20; main's D19
  retains its embedded-app token/font scope. No implementation is approved by this recovery.
- Operator profiles, restricted-user boundaries, external-client composition, source/native-mode
  parity and sandbox usability were reconciled into their existing owning plans. Current checked
  deliverables and shipped architectures are retained instead of overwriting them with old plans.
- [Historical SSE verification](2026-10-16-resource-sse-verification.md) preserves detailed results
  and the explicit unverified Safari/sleep boundary without reverting newer resource behavior.

## Verification

Review compared current and historical file content, three-way residuals and unique document
sections. Documentation/index validation, version consistency and whitespace checks apply to the
recovered patch. No application code or artifact versions change; runtime tests are not repeated
for this documentation-only recovery. Original working files are retained for operator cleanup.

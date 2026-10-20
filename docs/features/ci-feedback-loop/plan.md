---
status: In Progress
created: 2026-10-20
updated: 2026-10-20
summary: Shorten PR feedback with automatic affected checks, bounded risk suites and verified publication.
components: [.github, scripts]
---

# CI Feedback Loop

## Goal And Approval

The operator approved this approach in chat on 2026-10-20. A feature receives one coherent implementation pass, affected verification and a consolidated review. Routine commits must not start every expensive platform scenario. This plan changes CI scheduling and delivery policy; it does not remove supported Core runtimes or workspace infrastructure.

The implementation starts from the last green workspace-live-activation PR revision because that PR adds the native activation checks being reorganized. Its unpublished local follow-up edits are outside this worktree.

## Target Behavior

- Every PR starts a small classification, version and documentation check. A stable `ci-required` result validates all expected checks and rejects failed, cancelled, missing or unexpectedly skipped checks.
- Changed files automatically select component builds, lint, type checks and bounded tests. Root dependency and build configuration changes widen the selection conservatively. Unknown inputs cannot silently omit validation.
- Core tests and NativeAOT compilation run independently. A normal build compiles managed code; NativeAOT remains a separate production compatibility check.
- Native activation/Return/recovery, Windows process/file behavior, Docker worker behavior and Whisper inference run only for their relevant implementation or test inputs on PRs. Manual exact-revision and nightly-main runs provide broader qualification. Feature-specific browser acceptance remains recorded in its owning plan and requires its normal Hosty identity and sandbox authority.
- Required suites are parallel siblings. Superseded PR runs are cancelled; validation and publication of distinct main commits retain their current independent identities.
- Publishing waits for successful CI of the same full main SHA. Existing artifact-specific build and publication guards stay until verified artifacts can be consumed without rebuilding. PR merge artifacts never qualify a different main SHA. Mutable tag freshness, immutable version tags, trusted publishing and complete multi-platform releases remain required.
- Branch protection migrates to the stable aggregate only after the new workflow has passed on GitHub. Until then the existing required contexts remain.
- Workspaces app retirement depends on a code-level parity audit against Harness. The operator explicitly chose to retire its manual sandbox form and standalone diagnostic inventory; Harness agent tools remain the supported creation/setup path. Core workspace records, source worktrees and installed app data are preserved.

## Deliverables

- [x] D1. Implement an inspectable automatic change policy and functional tests for component selection, shared dependencies, unrelated edits, unknown inputs and risky lifecycle changes.
- [x] D2. Restructure PR CI: affected component checks, existing missing Shell/Demo tests, independent Core NativeAOT, targeted expensive suites and a fail-closed `ci-required` aggregate with negative tests.
- [x] D3. Provide manual exact-revision and scheduled main qualification using the same risk policy, with explicit source identity and no publication authority.
- [x] D4. Gate all publication on successful exact-main-SHA CI, reuse verified release artifacts where their complete contents match, and verify publication denial for failed, cancelled, missing and mismatched validation. Preserve existing artifact-specific validation wherever verified artifact reuse is not yet available.
- [x] D5. Audit Workspaces/Harness parity and retire the standalone application, manual form, diagnostic UI and delivery jobs as explicitly approved; preserve Core workspace data/APIs and the Harness agent path.
- [x] D6. Document the everyday development loop, feature readiness and review stopping rules; update existing CI descriptions and run workflow, policy, documentation and affected build/test checks.
- [ ] D7. Publish the reviewed change, verify the full Core suite on its Linux CI runner and successful hosted selected checks, then migrate branch protection from the old contexts to `ci-required` without a protection gap.

## Verification

- Test automatic selection on documentation-only, UI, Core web-shared, Core production, lifecycle, dependency, workflow and unknown-path changes, including deleted/renamed paths.
- Test the aggregate against successful, unaffected-skipped, required-skipped, missing, failed and cancelled jobs, and failed classification.
- Validate GitHub Actions syntax and expressions, check that required jobs are reachable for each selection, and confirm no publishing path can bypass the exact-SHA gate.
- Run affected existing component tests and builds after changes to their scripts or scheduling. Do not claim hosted Windows, Linux or macOS runs from local static validation.
- Run `node scripts/docs-index.mjs --fix`, `node scripts/docs-index.mjs --check` and `node scripts/check-versions.mjs`.
- Initial feedback targets, excluding runner queue time: documentation about one minute; UI about two to three minutes; Core about five minutes. Measure actual hosted runs before promising these as service levels.

## Completion And Review

A feature is ready to merge when its agreed deliverables, current revision's required CI, relevant risk/acceptance checks, documentation and version rules pass, and blocking review findings are resolved. A successful nightly run on main does not qualify an unmerged feature revision. Publication is a separate outcome and requires the same main source identity.

Review the complete change once, collect findings into one correction batch, then verify the affected paths. Start another full review only for a material design change or new evidence. Prioritize correctness, data loss, security and supported-runtime failures; an optional suggestion alone does not restart the feature loop. Never rerun failing checks repeatedly until they happen to pass.

D7 requires explicit repository commit/publication authorization and a successful hosted run; neither local tests nor this plan bypasses that requirement. Keep this plan open until that rollout is verified.

## Recorded Local Verification

- CI selection/aggregate/publication plus documentation-validator suites: 190 tests passed. Actionlint 1.7.12 and ShellCheck 0.10.0 passed for all workflows and composite shell scripts.
- Shell: lint passed with two existing warnings; 192 Node tests and 288 component tests passed; production build passed.
- Harness: lint/type checks, production web build and 877 tests passed.
- Demo App: lint, six tests and production build passed. Plans: lint, 137 tests and production build passed.
- Core: exact project Debug build and five focused owning-session viewer regressions passed. macOS arm64 NativeAOT passed without new trim/AOT warnings; existing compiler/platform warnings remain. The additional full Core suite on this Mac exceeded the 20-minute local verification budget and was cancelled without a completed result; no failure was reported before cancellation. The owned test/testhost processes stopped. This is not a passing full-suite result; D7 requires the hosted Linux Core run.
- CLI: build and 294 tests passed. The initial `--no-restore` test invocation could not start because this fresh test project had no assets; normal restore and the subsequent test command succeeded.
- Documentation/index, version consistency and whitespace checks passed. No runtime/browser sandbox, hosted Windows/Linux/matrix run or actual publication has been claimed from these local checks.
- Main protection still requires its original 15 contexts with strict up-to-date enforcement. PR #623 remains open at `8a493b00af6c5b8e588b55520ce6c2a4c102cc8b`; this workspace is isolated above that green revision. CI supports PRs against intermediate branches so the change can be reviewed while its dependency is pending.

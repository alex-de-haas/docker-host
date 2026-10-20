---
created: 2026-10-20
updated: 2026-10-20
summary: Automatic affected PR validation, selected native qualification and publication of verified main revisions.
components: [.github, scripts]
---

# CI Feedback Loop

## Everyday Development

Implement a coherent feature batch, run the affected local tests and build, and request review of the complete change. A PR push automatically selects its checks; developers do not choose a CI profile for ordinary work. Superseded PR runs are cancelled. Main, scheduled and manual validation have separate concurrency identities, so a qualification run cannot cancel publication's required main validation.

The fast PR path contains classification, version consistency, documentation validation and CI policy tests. Affected components add their lint, type checks, bounded tests and build. Shell and Demo App include their existing unit suites. Component jobs are parallel siblings.

`ci-required` evaluates the actual job results against the classification plan. Every selected job must succeed. Missing, cancelled, failed and unexpectedly skipped jobs fail the aggregate; only unaffected skips are accepted. The policy/wiring tests ensure every workflow job belongs to the aggregate. Main protection requires this GitHub Actions check and keeps strict up-to-date enforcement. The replacement was enabled alongside the original contexts before those contexts were removed, so protection had no gap.

## Automatic Selection

`scripts/ci-policy.mjs` owns the inspectable path policy. `scripts/ci-select.mjs` resolves the full source SHA, reads both sides of renames/deletions and publishes the selected job list in the run summary. PRs compare their base with the tested merge revision; main pushes compare their `before` revision with the pushed commit. An initial push without a baseline classifies the entire tracked tree.

- Component source selects its own checks; the shared app SDK selects its Node consumers.
- `shared/web` selects Shell and Harness. It does not compile Core or CLI.
- Root Node dependencies select Node consumers. Actual .NET build/toolchain changes select .NET consumers and native profiles.
- A strictly validated version-only change in `Directory.Build.props` selects Core, CLI and Core NativeAOT without triggering unrelated speech, SDK or native lifecycle scenarios. Added, deleted, malformed or substantive configuration stays conservative.
- Documentation also selects Plans because its tests exercise the repository document parser contract.
- CI scheduling edits select workflow lint; policy implementation changes and unrecognized inputs conservatively select all checks.

Core's managed build/unit suite and NativeAOT publication are independent jobs. A production Core source/configuration/dependency change selects NativeAOT; isolated unit-test edits do not require it. The AOT script retains its cold Release compile and zero-new-warning check.

## Additional Qualification

The same policy selects expensive PR suites for their implementation and fixture inputs:

| Suite | Relevant behavior |
| --- | --- |
| Workspace activation on Linux, Windows and macOS | Native launch, source preparation, activation, Return, supervisor and recovery |
| Windows process control | Windows handles, jobs, paths and shared receipt replacement |
| Core Docker transport | Listener and container transport contracts |
| Harness Docker worker | Worker image, transports, mounts and session/process lifecycle |
| Whisper native on three operating systems | Real CPU inference and native speech dependencies |

Manual CI dispatch accepts a source revision and an optional qualification scope. The resolved full SHA is recorded and component/qualification jobs check out that SHA. CI policy tests and the aggregate execute the workflow revision, so an older manually selected source does not need to contain the current gate implementation. Full qualification includes component validation and all risk suites. Narrow manual scopes provide focused reproduction; they do not replace an ordinary PR gate.

Nightly qualification compares main with the last successful scheduled run and selects the affected risk suites. Missing baseline/API access widens to all risk suites rather than omitting work. A main nightly result does not qualify an unmerged PR revision.

Feature plans continue to own browser acceptance, Hosty identity and sandbox checks. CI scheduling does not grant provider credential access, authorize live-data trials or replace normal setup/login verification.

## Publication

Image and native-release workflows react to completed main push CI and validate its exact source identity before selecting an affected artifact from that CI run's saved selection manifest. Publication does not recompute a smaller last-commit diff that could omit earlier changes in a multi-commit push. Failed, cancelled, PR and scheduled runs cannot authorize publication. Unrelated completed runs are short no-ops, avoiding idle publication runners during ordinary CI. The two SDK workflows retain their path-filtered push triggers and wait for the exact main result: their trusted-publisher execution and automatic provenance stay tied to the package source revision.

Manual recovery remains restricted to main and requires successful push CI for that exact SHA. Artifact-specific production builds and tests remain where CI output is not a complete reusable artifact. A host Next.js build is not a multi-platform OCI image, and a managed Core build is not a five-RID production release.

Cardputer CI uploads all four firmware/recovery binaries, exact checksums and source metadata. Normal publication downloads from the validated CI run, verifies source, completeness, regular files, checksums and OTA size, then publishes those bytes. Manual recovery builds and verifies the same source when recovering a release. Missing or corrupt normal artifacts fail publication.

Image metadata reads the validated Git checkout. Publishers attach an ephemeral local branch to that exact commit because Docker metadata cannot infer a ref from an unnamed detached SHA checkout. Image revision labels and SHA tags therefore describe the validated source; mutable tags still require the independent main-tip guard.

Signed image/native provenance records the validated code revision separately from the publishing workflow's execution revision. GitHub's automatic provenance uses the [OIDC workflow SHA](https://github.com/actions/toolkit/blob/main/packages/attest/src/provenance.ts), so a completion-triggered build uses an explicit source-bound predicate rather than attributing old source bytes to newer main. SDK trusted publishing keeps its [automatic npm provenance](https://docs.npmjs.com/trusted-publishers/).

### Publication Provenance v1

Image and native publishers use the Hosty custom predicate type and build type `https://github.com/alex-de-haas/docker-host/blob/main/docs/features/ci-feedback-loop/feature.md#publication-provenance-v1`. This repository-owned type describes completed-CI publication and manual recovery. Its payload follows the SLSA build-definition/run-details structure, but is stored as a custom attestation: GitHub rejects custom build types under the standard SLSA predicate type. The custom-predicate mode of `actions/attest` signs and stores the same source-bound claims without declaring unsupported SLSA semantics. The [GitHub workflow build type](https://github.com/actions/buildtypes/blob/main/workflow/v1/README.md) excludes `workflow_run`, so these publishers do not claim that type.

Verify an artifact using the explicit Hosty predicate type; the CLI's default SLSA filter does not select custom attestations:

```bash
# Downloaded release binary
gh attestation verify ./hosty-cardputer.bin --repo alex-de-haas/docker-host \
  --predicate-type https://github.com/alex-de-haas/docker-host/blob/main/docs/features/ci-feedback-loop/feature.md#publication-provenance-v1

# Container image: the oci:// prefix is required.
gh attestation verify oci://ghcr.io/alex-de-haas/hosty-shell:latest --repo alex-de-haas/docker-host \
  --predicate-type https://github.com/alex-de-haas/docker-host/blob/main/docs/features/ci-feedback-loop/feature.md#publication-provenance-v1
```

The required external parameters are `workflow` (repository URL, main ref and workflow path), `source` (repository URL and validated full commit), `validation` (CI workflow path and successful run ID), and `operation` (`build-image`, `build-native-release`, `publish-verified-ci-firmware` or `build-firmware-for-manual-publication`). The operation distinguishes a firmware artifact consumed from CI from a manual rebuild. The actual trigger remains `workflow_run` or `workflow_dispatch`.

The internal GitHub parameters record the actual trigger, stable numeric repository and owner IDs, runner environment and execution SHA. Missing or invalid identities stop publication before signing. Resolved dependencies bind the publishing repository's main ref to the workflow SHA, the separate source commit to the validated code SHA, and the successful CI run to validation or firmware production. The builder is the signing workflow URL; the invocation identifies the publishing run and attempt. Consumers verify the signed workflow identity and source dependency separately rather than assuming the workflow revision is the artifact's code revision.

The [existing release model](../repository-release-model/feature.md) still governs immutable versions, per-artifact concurrency, mutable-tag freshness and SDK trusted publication. A completed old main CI run cannot move a rolling tag over newer main. PR merge artifacts never qualify a different main SHA.

## Feature Readiness And Review

A feature is ready to merge when its agreed scope is implemented, current revision's required CI and relevant feature acceptance pass, documentation/version rules pass, and blocking review findings are resolved. Publication is a separate outcome.

Review the complete change once, collect findings into a consolidated correction batch, then verify the affected paths. A new full review needs a material design change or new evidence. Correctness, data loss, security and supported-runtime failures block completion. Optional suggestions do not automatically restart the loop. A failing check is investigated; repeated reruns are not a fix.

## Testing Expectations

- Policy tests cover affected/shared/unknown inputs, semantic version metadata, deleted/renamed paths and exact source resolution.
- Gate tests cover failed classification, missing/cancelled/failed/required-skipped jobs and workflow coverage.
- Publication tests cover exact main identity, stale source, current run attempts, failed or missing CI, complete verified artifact consumption, and required signing identity/source/workflow fields.
- GitHub Actions syntax and composite shell scripts are linted; docs/index and version checks run on every PR.
- Hosted operating-system and publication results are reported separately from local static/unit validation. Branch protection migrates only after a successful hosted aggregate.

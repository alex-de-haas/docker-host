---
created: 2026-10-20
updated: 2026-10-27
summary: Affected component CI, explicit local integration checks and publication of verified main revisions.
components: [.github, scripts]
---

# CI Feedback Loop

## Everyday Development

Implement a coherent feature batch, run the affected local tests and build, and request review of the complete change. A PR push automatically selects its checks; developers do not choose a CI profile for ordinary work. Superseded PR runs are cancelled. Main and manual validation have separate concurrency identities, so a manual run cannot cancel publication's required main validation.

The fast PR path contains classification, version consistency, documentation validation and CI policy tests. Affected components add their lint, type checks, bounded tests and build. Shell and Demo App include their existing unit suites. Component jobs are parallel siblings.

`ci-required` evaluates the actual job results against the classification plan. Every selected job must succeed. Missing, cancelled, failed and unexpectedly skipped jobs fail the aggregate; only unaffected skips are accepted. The policy/wiring tests ensure every workflow job belongs to the aggregate. Main protection requires this GitHub Actions check and keeps strict up-to-date enforcement. The replacement was enabled alongside the original contexts before those contexts were removed, so protection had no gap.

## .NET SDK Installation

CI and .NET publication use the shared setup action to install the exact SDK version declared in
the checked-out `global.json`. The local CLI roll-forward policy stays unchanged. Passing an explicit
version to `actions/setup-dotnet` avoids resolving that policy through a floating channel download;
a failed SDK installation still fails the job. The action reads the selected checkout, including
source revisions selected by publication, rather than a separate hard-coded toolchain version.

## Automatic Selection

`scripts/ci-policy.mjs` owns the inspectable path policy. `scripts/ci-select.mjs` resolves the full source SHA, reads both sides of renames/deletions and publishes the selected job list in the run summary. PRs compare their base with the tested merge revision; main pushes compare their `before` revision with the pushed commit. An initial push without a baseline classifies the entire tracked tree.

- Component source selects its own checks; the shared app SDK selects its Node consumers.
- `shared/web` selects Shell and Harness. It does not compile Core or CLI.
- Root Node dependencies select Node consumers. Actual .NET build/toolchain changes select .NET consumers and NativeAOT.
- A strictly validated version-only change in `Directory.Build.props` selects Core, CLI and Core NativeAOT without triggering unrelated speech, SDK or native lifecycle scenarios. Added, deleted, malformed or substantive configuration stays conservative.
- Documentation also selects Plans because its tests exercise the repository document parser contract.
- CI scheduling edits select workflow lint; policy implementation changes and unrecognized inputs conservatively select all checks.

The classification log retains full per-path selection reasons. The job output carries only the
bounded gate contract: version, selected components/profiles, required jobs and an empty reasons
object. This keeps both `CI_PLAN` and the copied `needs` environment small for large changesets,
while the aggregate still validates every required result and rejects failed unexpected jobs.

Core's managed build/unit suite and NativeAOT publication are independent jobs. A production Core source/configuration/dependency change selects NativeAOT; isolated unit-test edits do not require it. The AOT script retains its cold Release compile and zero-new-warning check.

## Local Integration Checks

Run affected runtime acceptance locally before creating a pull request. Record commands,
platforms and results in the PR's Verification section, including any checks that could not
run and why. Documentation-only changes need no runtime suite.

GitHub CI has no activation,
Windows process-control, Docker transport/worker or native speech jobs, nightly risk schedule
or integration dispatch scopes. Ordinary component suites remain intact, including their
existing isolated HTTP/component tests. NativeAOT and Docker-based artifact builds remain
build checks.

Use the console entry point from a registered development worktree:

```bash
npm run test:integration -- activation
npm run test:integration -- dependencies
npm run test:integration -- windows
npm run test:integration -- transport
npm run test:integration -- worker
npm run test:integration -- sessions
npm run test:integration -- tasks
npm run test:integration -- harness-local
npm run test:integration -- whisper
npm run test:integration -- opus
npm run test:integration -- desktop
npm run test:integration -- shell
```

The `desktop` suite builds Desktop and exercises normal password login, role-based app access, assignment revocation and lifecycle authorization in the existing parent-managed child Core. `HOSTY_DESKTOP_BROWSER=1` retains that same sandbox for manual UI acceptance until its completion marker is written; the owner then Finishes the environment and verifies removal.

Each command runs only its named suite. No argument prints help and runs nothing; there is
no implicit all-suite mode. Add `--dry-run` to inspect commands without executing them.
The launcher checks prerequisites before building, prints each command, propagates failures
and stops at the first failed step without retrying. It refuses runtime execution under
GitHub Actions. Its small command-construction tests remain in the CI policy job.

| Suite | Preparation and local behavior |
| --- | --- |
| activation | Requires .NET, Git, Python and Docker; builds Core/CLI and runs Return plus detached-helper recovery in parent-owned isolated Core environments. |
| windows | Requires Windows, Git and .NET; runs the focused process/path/document/storage Core tests and CLI shared-receipt tests. Other operating systems receive an explicit refusal. |
| dependencies | Requires .NET, Python and Docker; builds Core/CLI and checks dependency waits, recovery, cancellation and boot in a parent-owned isolated Core. |
| transport | Requires .NET, Python and Docker; builds Core and runs its isolated real-Docker listener/transport fixture. |
| worker | Requires Docker; builds the worker image named by the current manifest and runs its process/mount/control fixtures. |
| shell | Requires .NET, Git, Python and Docker; builds Shell and verifies password identity and workspace inventory in a managed child Core. `HOSTY_SHELL_BROWSER_REVIEW` names a private temporary browser checkpoint; its `.continue` marker resumes Finish cleanup. |
| harness-local | Requires Node/npm, .NET, Git, Python and Docker for the parent-managed child Core; verifies native production cold/warm startup, password/app identity, compiled assets, recovery and Finish cleanup. |
| tasks | Requires .NET, Git, Python and Docker; builds Core/CLI and Harness images, verifies human/profile/independent-provider tasks, explicit MCP results, cancellation, existing workspaces and restart in a managed child Core. `HOSTY_TASKS_BROWSER=1` adds the Playwright browser journey. |
| sessions | Requires .NET, Git, Python and Docker; builds Core/CLI and both Harness images, then runs multi-user workspace acceptance in a parent-managed child Core with separate password-authenticated users and data. |
| opus | Requires Node 24 and uv; builds the app, verifies real OPUS-MT Big inference, cancellation and model-cache reuse/recovery. `HOSTY_OPUS_TEST_CACHE` reuses a dedicated cache. |
| whisper | Requires .NET; explicitly enables only NativeSpeechTests, including pinned-model download and real CPU inference. `HOSTY_WHISPER_TEST_CACHE` can reuse a verified cache. |

The launcher uses `python3` on Unix and `python` on Windows. Existing fixture entry points
remain available for focused scenarios and supported native modes; see
[workspace activation](../workspace-live-activation/feature.md#testing-expectations).
Passing on macOS does not establish Windows or Linux readiness. Failure diagnostics and
cleanup retain each fixture's existing ownership rules; ordinary app data and provider
credentials remain outside these checks.

Manual CI dispatch accepts an exact source revision and runs the remaining normal checks.
The resolved full SHA is recorded and component jobs check out that SHA. CI policy tests
and the aggregate execute the workflow revision, so an older source need not contain the
current gate implementation. Runtime acceptance is invoked locally rather than through
GitHub's manual workflow UI.

Feature plans continue to own browser acceptance, Hosty identity and sandbox checks. Local
integration uses isolated data, normal setup/login and the supported Core-managed lifecycle.

## Publication

Image and native-release workflows react to completed main push CI and validate its exact source identity before selecting an affected artifact from that CI run's saved selection manifest. Retained format-1 manifests from before local integration separation remain readable: only the five known retired profiles are accepted, with consistent required membership and no duplicates; current CI still rejects those profiles. Publication does not recompute a smaller last-commit diff that could omit earlier changes in a multi-commit push. Failed, cancelled and non-push runs cannot authorize automatic publication. Unrelated completed runs are short no-ops, avoiding idle publication runners during ordinary CI. The two SDK workflows retain their path-filtered push triggers and wait for the exact main result: their trusted-publisher execution and automatic provenance stay tied to the package source revision.

Manual recovery remains restricted to main and requires successful push CI for that exact SHA. Artifact-specific production builds and tests remain where CI output is not a complete reusable artifact. A host Next.js build is not a multi-platform OCI image, and a managed Core build is not a five-RID production release.

Cardputer CI uploads all four firmware/recovery binaries, exact checksums and source metadata. Normal publication downloads from the validated CI run, verifies source, completeness, regular files, checksums and OTA size, then publishes those bytes. Manual recovery builds and verifies the same source when recovering a release. Missing or corrupt normal artifacts fail publication.

Image metadata reads the validated Git checkout. Publishers attach an ephemeral local branch to that exact commit because Docker metadata cannot infer a ref from an unnamed detached SHA checkout. Image revision labels and SHA tags therefore describe the validated source; mutable tags still require the independent main-tip guard.

Signed image/native provenance records the validated code revision separately from the publishing workflow's execution revision. GitHub's automatic provenance uses the [OIDC workflow SHA](https://github.com/actions/toolkit/blob/main/packages/attest/src/provenance.ts), so a completion-triggered build uses an explicit source-bound predicate rather than attributing old source bytes to newer main. SDK trusted publishing keeps its [automatic npm provenance](https://docs.npmjs.com/trusted-publishers/).

### Publication Provenance v1

Image and native publishers use the Hosty custom predicate type and build type `https://github.com/alex-de-haas/docker-host/blob/main/docs/features/ci-feedback-loop/feature.md#publication-provenance-v1`. This repository-owned type describes completed-CI publication and manual recovery. Its payload follows the SLSA build-definition/run-details structure, but is stored as a custom attestation: GitHub rejects custom build types under the standard SLSA predicate type. The custom-predicate mode of `actions/attest` signs and stores the same source-bound claims without declaring unsupported SLSA semantics. The [GitHub workflow build type](https://github.com/actions/buildtypes/blob/main/workflow/v1/README.md) excludes `workflow_run`, so these publishers do not claim that type.

The CLI's default verification filter selects SLSA rather than Hosty custom attestations. For a downloaded binary, first download its bundles without a predicate filter, then verify using the bundle path printed by the command. Replace `BUNDLE_PATH` below with that `.jsonl` path (`sha256:<digest>.jsonl` on POSIX or `sha256-<digest>.jsonl` on Windows). This avoids GitHub's lookup API rejecting a custom `predicate_type` query even though attestation storage accepts it.

```bash
gh attestation download ./hosty-cardputer.bin --repo alex-de-haas/docker-host
gh attestation verify ./hosty-cardputer.bin --bundle BUNDLE_PATH \
  --repo alex-de-haas/docker-host \
  --predicate-type https://github.com/alex-de-haas/docker-host/blob/main/docs/features/ci-feedback-loop/feature.md#publication-provenance-v1 \
  --signer-workflow alex-de-haas/docker-host/.github/workflows/cardputer-release.yml
```

For an image, the `oci://` prefix and `--bundle-from-oci` fetch the signature from the registry and apply the custom-type filter locally. The command uses the registry's existing authentication:

```bash
gh attestation verify oci://ghcr.io/alex-de-haas/hosty-telemetry-backend:latest \
  --bundle-from-oci --repo alex-de-haas/docker-host \
  --predicate-type https://github.com/alex-de-haas/docker-host/blob/main/docs/features/ci-feedback-loop/feature.md#publication-provenance-v1 \
  --signer-workflow alex-de-haas/docker-host/.github/workflows/telemetry-backend-image.yml
```

The required external parameters are `workflow` (repository URL, main ref and workflow path), `source` (repository URL and validated full commit), `validation` (CI workflow path and successful run ID), and `operation` (`build-image`, `build-native-release`, `publish-verified-ci-firmware` or `build-firmware-for-manual-publication`). The operation distinguishes a firmware artifact consumed from CI from a manual rebuild. The actual trigger remains `workflow_run` or `workflow_dispatch`.

The internal GitHub parameters record the actual trigger, stable numeric repository and owner IDs, runner environment and execution SHA. Missing or invalid identities stop publication before signing. Resolved dependencies bind the publishing repository's main ref to the workflow SHA, the separate source commit to the validated code SHA, and the successful CI run to validation or firmware production. The builder is the signing workflow URL; the invocation identifies the publishing run and attempt. Consumers verify the signed workflow identity and source dependency separately rather than assuming the workflow revision is the artifact's code revision.

The [existing release model](../repository-release-model/feature.md) still governs immutable versions, per-artifact concurrency, mutable-tag freshness and SDK trusted publication. A completed old main CI run cannot move a rolling tag over newer main. PR merge artifacts never qualify a different main SHA.

## Feature Readiness And Review

A feature is ready to merge when its agreed scope is implemented, current revision's required CI and relevant feature acceptance pass, documentation/version rules pass, and blocking review findings are resolved. Publication is a separate outcome.

Review the complete change once, collect findings into a consolidated correction batch, then verify the affected paths. A new full review needs a material design change or new evidence. Correctness, data loss, security and supported-runtime failures block completion. Optional suggestions do not automatically restart the loop. A failing check is investigated; repeated reruns are not a fix.

## Verified Migration

The 2026-10-21 local migration verification passes 208 CI-policy, publication, launcher and
documentation tests, workflow lint, composite shell lint, documentation validation and version
consistency. The macOS activation command builds Core/CLI and passes managed Return and
interrupted-helper recovery; both child environments confirm Finish and removal of their
processes, ports and scratch data. Docker transport passes health and authorization checks
from both default and per-app networks. The locally built Harness worker passes process,
mount and native control checks without provider credentials or model turns. Native Whisper
CPU inference passes its Russian speech, silence, capacity and cancellation checks on macOS.
Windows acceptance is not run because the local host is macOS; launcher tests cover its
command selection and refusal on unsupported hosts. Local results do not establish Windows
or Linux native readiness. Hosted validation is reported separately in the pull request.

The `sessions` local integration suite builds Core/CLI and Docker Harness, then exercises explicit
workspace sharing, private conversations, independent session deletion and source retention with
three invited/password-authenticated users in a parent-managed child Core. See
[workspace sessions](../workspace-sessions/feature.md#testing-expectations).

## Testing Expectations

- Policy tests cover affected/shared/unknown inputs, semantic version metadata, deleted/renamed paths, exact source resolution and exclusion of local runtime suites from every CI selection.
- Local launcher tests cover explicit selection, prerequisite and command failures, unsupported platforms, shell-free arguments, native inference opt-in and side-effect-free previews.
- Gate tests cover failed classification, missing/cancelled/failed/required-skipped jobs, workflow coverage and bounded process startup for large changesets without weakening required results.
- Publication tests cover exact main identity, stale source, current run attempts, failed or missing CI, complete verified artifact consumption, and required signing identity/source/workflow fields.
- GitHub Actions syntax and composite shell scripts are linted; docs/index and version checks run on every PR.
- Hosted operating-system and publication results are reported separately from local static/unit validation. Branch protection migrates only after a successful hosted aggregate.

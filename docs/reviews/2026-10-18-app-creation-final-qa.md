# App Creation Final Verification — 2026-10-18

## Baseline And Scope

This report closes D17–D18 of [Local App Creation From Harness](../features/app-prototype-workspaces/feature.md).
The implementation is the accumulated, uncommitted feature work on
`hosty/session/a88edf05a44459c3617bc6d40d24d63aa66df63617c6b62c49b41449a000396c`, based on
`34ea0bd2d5bfee6e12ac9d53f151ad61368babe7` (PR #606), plus the corrections below. GitHub `main`
still pointed to that commit when the version baseline was checked on 2026-10-18.
This is local acceptance, not a merged PR, registry publication or post-release verification.

The changed release components are Core/CLI and Harness, including the Harness web UI and worker
metadata. Shell, SDKs and other runtime apps have no implementation changes in this feature.
Their independent suites were not rerun solely for version-only root lockfile changes.

## Corrections From The Final Pass

- The remote-status endpoint previously bound required `sourceAppId` before authenticating, so a
  missing parameter returned HTTP 400 to an anonymous or invalid-token caller. It now authenticates
  first, then validates the local app id. Both repository-wide endpoint authorization tests pass;
  authenticated missing/empty/overlong ids, valid local-only status and foreign-session denial are
  covered by `AppCreationHttpTests`. No authorization allowlist was weakened.
- The opt-in Docker development fixture removed containers and source but left its named caches,
  because ordinary app removal deliberately retains those caches. Its teardown now removes only
  volumes bearing that fixture's exact instance and app labels. The focused rerun verifies normal
  source/cache isolation, reload, restart and cleanup. This does not change runtime cache policy.

The first Core run was stopped after the two endpoint guard failures above, then rebuilt and rerun
in full. The first Harness run reported an empty-JSON response in the existing session-naming test
(718 passed, one failed). The case passed alone, its entire gateway file passed once and in twelve
additional consecutive runs, and the subsequent full suite passed without retry flags. The initial
failure was not reproducible; no speculative product change or test exemption was added for it.

## Builds, Tests And Versions

Commands ran from the registered feature worktree with logs/TRX files kept outside the repository.
The host was macOS arm64 with .NET SDK 10.0.400, Node 24.18.0 and Docker Desktop engine 29.8.2
running Linux arm64 containers.

| Verification | Result |
| --- | --- |
| `dotnet build apps/core/src/Haas.Hosty.Core/Haas.Hosty.Core.csproj --nologo` | Passed after the endpoint correction |
| `dotnet test apps/core/tests/Haas.Hosty.Core.Tests/Haas.Hosty.Core.Tests.csproj --nologo` | 3,505 passed, zero failed, four opt-in fixtures skipped; 10m22s |
| `dotnet build apps/cli/src/Haas.Hosty.Cli/Haas.Hosty.Cli.csproj --nologo` | Passed |
| `dotnet test apps/cli/tests/Haas.Hosty.Cli.Tests/Haas.Hosty.Cli.Tests.csproj --nologo` | 236 passed, zero failed/skipped |
| `npm run harness:lint` | Server TypeScript and web ESLint/TypeScript passed |
| `npm run harness:build-web` | Production web export passed |
| `npm run harness:test` | 84 files, 719 tests passed, zero failed/skipped in the final full run |
| `node scripts/check-core-aot.mjs` | osx-arm64 NativeAOT passed with no trim/AOT warnings |
| `dotnet publish apps/cli/src/Haas.Hosty.Cli/Haas.Hosty.Cli.csproj --configuration Release --runtime osx-arm64 --self-contained true --output <temporary-output> --nologo` | Native executable built; `hosty --version` returned 0.140.0 |
| `docker build -f apps/harness/worker/Dockerfile -t ghcr.io/alex-de-haas/hosty-agent-worker:0.57.0 .` | Passed |
| `node --import tsx scripts/check-harness-worker.mjs` | Codex/Claude binaries, Claude SDK initialization, mount boundaries, recovery and detached-writer cleanup passed |
| `python3 scripts/check-docker-core-transport.py apps/core/src/Haas.Hosty.Core/bin/Debug/net10.0/hosty-core.dll` | Health 200; protected app/control APIs 401 from both default and separate Docker networks |
| `HOSTY_TEST_DOCKER_DEVELOPMENT=1 dotnet test apps/core/tests/Haas.Hosty.Core.Tests/Haas.Hosty.Core.Tests.csproj --filter FullyQualifiedName~DockerDevelopment_CoreManagedMixedLifecycleReloadsSourceWithoutRebuilding` | One passed after the teardown correction; no owned cache volumes remained |
| `node --test scripts/docs-index.test.mjs` | 54 passed |
| `node scripts/check-versions.mjs` | Passed |
| `node scripts/docs-index.mjs --fix` / `--check`, `git diff --check` | Passed after documentation closure |

The clean Release Core compilation reports four existing C# analyzer warnings (two unused constructor
parameters and two Unix-file-mode platform warnings). NativeAOT reports no IL2xxx/IL3xxx warnings;
no warning exemption was added. CLI and Harness checks have no new warnings.

After the full Core run, only the opt-in fixture teardown changed; that fixture was rebuilt and rerun separately.
The full Core suite leaves four opt-in fixtures skipped. The related Docker development fixture
was run separately as shown above. The other three are Telemetry mixed-runtime ingestion and the
two companion Torrent/VPN scenarios, outside this change; no companion checkout/VPN credentials
were supplied for this pass. Windows/native Linux host acceptance and Linux amd64 worker acceptance
were not performed here. Their existing [sandbox](../features/app-sandbox-runtimes/plan.md) and
[mixed-runtime](../features/mixed-development-runtimes/plan.md) work is not closed by this report.

| Artifact | Baseline → feature version | Consistency |
| --- | --- | --- |
| Core + CLI | 0.139.0 → 0.140.0 | Root `Directory.Build.props` and product-channel CLI version |
| Harness | 0.56.0 → 0.57.0 | Manifest, server/web package metadata, root lockfile and worker package/lock/image reference |
| Other runtime apps / SDKs | Unchanged | Independent release lines retained |

## Acceptance Coverage Ledger

The earlier reports are dated evidence, not promises that each browser/model scenario ran again
on 2026-10-18. Their historical statements about then-open work remain intact; only document-link
targets were relocated from the retired plan to the feature. The following ledger records the final
composition of those checks and this regression pass.

| Deliverables | Verified outcome | Evidence |
| --- | --- | --- |
| D1, D10 | Existing remote, fetch/status, reviewed commit/push/draft PR, CI/review and request recovery | [Remote publication QA](2026-10-17-local-remote-publication-qa.md) |
| D2–D4, D7 | Canonical local Git, consented bootstrap, ordinary stopped app, worktree, authority and recovery | [Initial creation QA](2026-10-17-harness-app-creation-local-qa.md), [source preservation](2026-10-17-app-source-preservation-qa.md) |
| D5 | Source-loss review, active consumer refusal, uninstall/reinstall and retained source | [Source preservation QA](2026-10-17-app-source-preservation-qa.md) |
| D6, D9 | Versioned guide through Core MCP/control/CLI/Harness; real agent tools/cwd/instructions | [Guide QA](2026-10-17-app-development-guide-qa.md), [real-provider QA](2026-10-17-real-provider-app-creation-qa.md) |
| D8 | Two repositories/apps, one session/child, cancellation, restart and unfinished-work protection | [Multi-repository QA](2026-10-17-multi-repository-harness-qa.md) |
| D11 | Icon, Git author, commit consent, durable browser draft and uncertain dispatch recovery | [Form QA](2026-10-17-app-creation-form-qa.md) |
| D12, D20 | Accept/Use locally, separate ordinary data, new/existing sessions and source retained after chat cleanup | [Local handoff](2026-10-17-local-app-handoff-qa.md), [continuation](2026-10-17-local-building-continuation-qa.md) |
| D13 | Multi-service topology, obsolete-container cleanup and sandbox/data reuse | [Reuse QA](2026-10-17-multi-service-sandbox-reuse-qa.md), [generated stacks](2026-10-17-real-provider-app-creation-qa.md) |
| D14 | Optional checks, failure diagnostics, stale results and same-sandbox repair | [Preview check QA](2026-10-17-preview-checks-recovery-qa.md) |
| D15 | Crash/replay, authority, writer, Git/runtime failure and source/retention matrices | [Recovery regression](2026-10-17-app-creation-recovery-regression.md), final full suites above |
| D16 | Real Codex .NET/Node and Claude Rust apps, browser auth/data, recovery, resource samples and Finish | [Real-provider acceptance](2026-10-17-real-provider-app-creation-qa.md) |
| D17 | Final component builds/tests, native and worker packaging, version consistency | This report |
| D18 | Current feature reality, owning docs/cross-links, retired completed plan and generated index | [Feature](../features/app-prototype-workspaces/feature.md) and docs validation above |
| D19 | Owner-approved local Git, one bootstrap commit, stopped registration, local acceptance and ordinary use | Owner decisions of 2026-10-17, implemented and described in the feature |

No new model credentials were copied and no fresh paid model/browser acceptance was run in D17–D18.
The retained D16/form/publication reports provide that live evidence. Existing-remote code publication
is complete; hosted repository creation, release/feed/catalog authoring and general upstream
adaptation retain their separate [publication](../features/app-publication/plan.md) and
[authoring](../features/app-authoring/plan.md) plans.

## Temporary Resources

The worker smoke started its locally built image in 852 ms, observed 126,922,752 bytes of working
memory and 126,976,000 peak bytes (about 121 MiB), then recovered and removed it. This was a warm
transport/SDK check, not a model workload or cold-engine benchmark. It verified read-only repository
metadata, no Docker socket and cessation of a detached writer. Prior workload measurements remain
in the real-provider report.

The Docker fixture's temporary containers/network/source and its exact owned cache volumes are
gone. The transport smoke's own Core, network, probe container and data root are gone. Shell,
Workspaces and Marketplace kept their original container IDs; none was stopped, recreated or given
a different memory limit. Shared images/build caches are retained, including the locally built
worker image. Logs, TRX, raw JSON and diagnostic scripts remain under temporary storage and are
not part of the repository changes.

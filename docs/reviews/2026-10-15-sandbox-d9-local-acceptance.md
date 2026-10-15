# D9 Local Released-Core Acceptance And Coverage Ledger

Date: 2026-10-15. Baseline: `70133a4dbcd4d3b91c3d46693c797162238b3d54`, merged
[PR #599](https://github.com/alex-de-haas/docker-host/pull/599). This closes the owner-approved
local portion, **Sandbox D27**, on macOS arm64 with Linux arm64 Docker containers. Broader
host/architecture/recipe acceptance stays in [D9](../features/app-sandbox-runtimes/plan.md).
The acceptance run changed no product code or version and created no commits or publication;
this report is exported separately.

## Releases And Fixture

All ten workflows at the exact merge commit completed successfully, including
[Core/CLI publication](https://github.com/alex-de-haas/docker-host/actions/runs/38784525236),
[Demo publication](https://github.com/alex-de-haas/docker-host/actions/runs/38784525261),
[worker publication](https://github.com/alex-de-haas/docker-host/actions/runs/38784525223) and
[CI](https://github.com/alex-de-haas/docker-host/actions/runs/38784525252).

- Fresh downloaded macOS arm64 **Core/CLI 0.135.1** passed VERSION and SHA256SUMS checks and
  ran from a new data root. The child copied this released native executable; it was not a
  source-Core candidate. Core binary SHA256: `8ec56d2ef75f74f715cb47d5d9b58614447742fded0ce8856a62f01c3386f241`.
  Exact-baseline Core was also compiled by the regression run.
- **Demo 0.17.2** ran from `ghcr.io/alex-de-haas/demo-app:sha-70133a4` in the disposable parent.
  Index digest: `sha256:66ec2a7eccdc1f9f55ab5f9454ad3335b0cd2662d31d66001786d1f53a0a4a8b`;
  Linux arm64 manifest: `sha256:e05b07448cf2c9632c06d2398ca3d1f07bae44f5cf9167056ba66159008eae05`.
  Its revision matches the merge, and the real app browser displays 0.17.2.
- **Harness/worker 0.53.0** used the actual published arm64 worker. Its immutable version still
  identifies release revision `b996226e2c1574d6a34f0c0743147d54a3d98844`; the later publication
  correctly did not overwrite that version. Index digest:
  `sha256:87cbf61946ed6b9c52164170b67300e44d3f7d84e724bf629ccb5cea55c3216f`;
  arm64 manifest: `sha256:9a61a451ff0c73846485372c7f4e48198dd19f1c1cdc9ce0b2145bb156a80a28`.
  Harness itself ran as a Core-managed native app from merge-commit source with its built web UI;
  this does not verify a separately downloaded Harness bundle.
- Docker **29.8.2**, Linux aarch64, 14 CPUs, **16,787,152,896 bytes** VM memory. The VM was already
  running; no global prune, VM resize, daemon restart or unrelated application restart occurred.
- Parent instance `98ab91add13049b6ba46c361b12cf23d` had normal password bootstrap and only a
  temporary selected-account Codex import. No host home or Docker socket was mounted into the worker.
  The primary Core stayed at 0.135.0, PID 83710, with the same process-start identity and zero app errors.

The shared worker had **4 GiB / 2 CPUs / 512 PIDs**. Demo child
`13454e5770c94138aef049fc50052d65` reserved **6 GiB / 3 CPUs / 768 PIDs**, with two app services
limited to **2 GiB / 1 CPU / 256 PIDs each** and a 10 GiB soft owned-data budget. A simultaneous
independent child `4c2d6c2d06874ee6b5f8cef8696001aa` reserved 2 GiB / 1 CPU / 256 PIDs.
Both shared the local Docker engine but had separate native Core processes, data and ports.

## Agent, Browser And Recovery

A real Codex conversation through Harness's supported Docker mode performed the following:

1. Preparation without an attached source app was refused. Attaching Demo in Harness and replaying
   the same preparation UUID produced a clean registered worktree at the exact merged baseline.
2. The agent requested the workspace-linked child, stopped for actual Core operator consent,
   started the child, performed normal password setup and submitted Demo's source installation.
   The coordinator approved the installation in the real child browser with autostart disabled.
3. Core built a temporary source recipe using Node 24 Bookworm Slim pinned to
   `sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20` and a new dependency layer.
   A private empty npm cache was used. The first app start failed because the experimental helper
   copied a directory onto an existing empty cache mount. The agent corrected it to copy entries,
   preserved the failure evidence and retried. This was a fixture-script error, not a shipped fix.
4. Both services became healthy. The application source was mounted read-only; direct writes were
   rejected in both containers. Dependencies, generated files and framework output used six separate
   cache volumes. The agent's writable worktree was independent of app data and the installed Demo.
5. The coordinator used ordinary child password login in a dedicated Playwright browser. The child
   user appeared; the parent's user did not. The agent appended a temporary overview marker; it
   appeared in the held page with the same JavaScript window marker, without reload. People navigation
   retained the account and left no callback code/state in the URL. HMR was observed, not timed with
   a mutation observer in this continuation; the earlier precise latency measurement remains separate.
6. Demo's six unit tests, lint and webpack production build passed in the actual worker. Production
   output was separate from the mounted dev caches. No commits, push or new PR were performed.
7. An active-turn cleanup attempt was refused by Harness. A subsequent idle-session cleanup reached
   Core and returned `409 workspace_in_use`, protecting the worktree's lease/runtime consumers.
8. The agent stopped the child, persisted one Start UUID/revision and issued two identical concurrent
   starts. Both returned the same new PID 82410 and revision 7. Reusing that UUID for Stop and a new
   Stop request with a stale revision were refused. Installation identity, image locks and endpoints
   persisted, and Demo became healthy again. The browser retained the original child account.
9. The released Core created its private Docker config with mode 0600 and no inherited registry auth.
   A harmless synthetic child-owned auth marker was added; after restart it remained intact and mode
   0600 was preserved. The parent Docker configuration/credentials were not copied or printed.
10. A second agent-created child had no workspace ID, no installed apps and exactly its own new
    synthetic user. Ports 31801 and 31044 were distinct. Its context still records the Harness
    session as the caller; absence of a workspace is not absence of ownership.

Harness displayed both running children and Demo's preview link. After both Finishes its panel
reported no sandbox instances. The browser for the old Demo origin failed with connection refused.
The initial Harness visit used its raw 127.0.0.1 endpoint and generated continuity-frame 403s.
Opening Core's advertised local browser origin restored normal behavior; only favicon 404s remained.
This is not a claim that every raw-origin/cookie combination is supported or that the console was
error-free. No product authorization bypass was introduced.

The live third-child request returned `409 environment_capacity`. Unfinished reservations were
8 GiB with both children, 6 GiB after the independent child's Finish and zero after Demo's Finish.
An additional live over-memory create probe after the first Finish was not run: automatic approval
review rejected it because creation could succeed. The current quota regression tests cover the
aggregate-memory refusal; read-only state confirmed actual reservation release. No substitute
create request was used to bypass that rejection.

Actual Docker loss, interrupted Finish and a detached worker surviving Harness death remain the
prior dated live fault evidence linked below. Their current protocol/regression tests passed here;
those faults were not repeated against unrelated running applications.

## Cold Preparation And Timing

Empty private OCI stores received every selected arm64 manifest/config/layer and verified their
sizes and SHA256 digests. These are full fresh client downloads, not `docker pull` on cached layers.
They are reported separately from Docker import/start on the shared engine.

| Phase | Observed duration | Boundary |
| --- | ---: | --- |
| Fresh Core/CLI artifact download job | 1.667 s | Existing network/server caches are not controlled |
| Full worker OCI transfer | 16.382 s; 682,130,568 bytes | Empty private store; all arm64 blobs verified |
| Full Demo OCI transfer | 3.861 s; 94,265,615 bytes | Empty private store; all arm64 blobs verified |
| Harness npm preparation | 11.823 s | Empty checkout dependencies; native process tree sampled |
| Harness web build | 9.544 s | Core-managed runtime prepared from released source |
| Initial child Start request → returned running | 5.957 s | Released native Core, including tool/request handling |
| New image dependency layer | Approximately 12 s | Image history timestamps 19:14:38 → 19:14:50 UTC; not a precision stopwatch |
| Initial Demo Start | 15.603 s, failed | Includes new image build and helper failure; not successful readiness |
| Corrected empty-cache Demo retry | 13.441 s | Core returned both services healthy; dependency image layer reused |
| First Demo request → first saved healthy observation | 55.264 s | Includes fixture repair and orchestration delay |
| Concurrent warm child Start/replay | 1.768 s | Same new process identity from both calls |
| Agent Demo unit-test command | 9.769 s | Includes command/tool overhead; Vitest reported 1.50 s |
| Agent Demo lint / webpack build | 3.027 s / 23.838 s | Actual worker execution, with live child preview retained |
| Demo Finish / identical replay | 7.527 s / 0.012 s | Terminal revision 9, no process/data root |
| Independent Finish / identical replay | 0.250 s / 0.014 s | Terminal revision 5, no process/data root |

The new dependency layer is timestamped during this run; the pinned Node base and Docker engine
were shared. The helper correction reused the just-built dependency layer. These measured stages
close the local preparation gap without advertising an uninterrupted first-attempt success, cold
Docker VM boot, uncached internet infrastructure or a statistical startup distribution.

## Memory And Sampling

**641 samples**, nominal three-second interval, **18:56:19–19:28:22 UTC**, maximum interval
**3.010 s**, no collection errors. Monitoring began before release download, Harness dependency/web
preparation and Core launch. It followed native descendants and all worker/child generations through
teardown. At most one shared worker container was present in any sample. The additional workspace
regression selection below ran after this measurement window; it is not included in the workload.

| Component | Maximum sampled charged memory | Maximum sampled working set | Cgroup lifetime peak |
| --- | ---: | ---: | ---: |
| Shared worker and test/build descendants | 1,262.9 MiB | 1,164.8 MiB | 1,862.3 MiB across observed worker generations |
| Demo child frontend + backend in the same sample | 2,408.4 MiB | 1,201.4 MiB | Frontend 1,658.8 MiB; backend 992.5 MiB separately |
| Published parent Demo, after complete inventory tracking | 156.8 MiB | 156.8 MiB | Not combined across independent service peaks |

Largest simultaneous worker-plus-child sample: **3,417.6 MiB charged / 2,154.3 MiB working set**
at 19:17:06 UTC. At that same sample, native Core RSS was **281.7 MiB**, Harness/runner **128.8 MiB**,
dedicated browser tree **1,679.8 MiB**, native verification/preparation **3,558.5 MiB**, helper
processes **11.2 MiB**, and installed parent Demo charged memory **136.3 MiB**. The native verification
includes Core compilation/tests running concurrently with worker dependency preparation. During the
agent's production build, the largest worker sample was 1,262.9 MiB and worker-plus-child was
2,026.4 MiB at that same instant.

Independent sampled native RSS maxima were Core **511.3 MiB**, Harness/runner **209.2 MiB**,
Playwright/Chromium **1,958.6 MiB**, verification/preparation **4,247.9 MiB**. Do not add these separate
maxima as a simultaneous total. RSS can count shared pages. All observed OOM-kill counters were zero.
Working set is charged memory minus inactive file pages, not an additional allocation.

The parent's artifact frontend lacks a data bind, so its ID was added explicitly at 19:15; its early
samples are incomplete. It is excluded from the selected worker-plus-child benchmark, and the
reported simultaneous peak has the full parent inventory. Docker VM/engine-internal BuildKit memory
and unrelated applications are excluded, so this is not total-machine memory or a hard limit on
native builds. Three-second sampling can miss brief peaks; cgroup lifetime peaks are reported
separately. Native preparation is measured separately; this run launches released Core and does not claim
another source-Core launch.

## Regression Commands And Coverage

Exact-baseline Core build and selected tests passed: **176 cases**, then **34 workspace/source
cases** selected by their actual partial-class method names. There are **209 unique cases** across
210 executions (one overlap), zero failed or skipped. The first filename-based filter omitted most
workspace tests because their declaring class is `CoreLifecycleServiceTests`; the second command
closes that gap. Every exact named test in the ledger below appears in the combined TRX results.
Existing CA1416 platform-analyzer warnings were emitted; no compilation errors occurred.

```sh
dotnet test apps/core/tests/Haas.Hosty.Core.Tests/Haas.Hosty.Core.Tests.csproj \
  --artifacts-path "$D9_OUTPUT" \
  --filter 'FullyQualifiedName~Sandbox|FullyQualifiedName~CoreEnvironment|FullyQualifiedName~DockerSourceRuntime|FullyQualifiedName~DevelopmentWorkspace|FullyQualifiedName~JsonStorage'
dotnet test apps/core/tests/Haas.Hosty.Core.Tests/Haas.Hosty.Core.Tests.csproj \
  --artifacts-path "$D9_OUTPUT" --no-build \
  --filter 'FullyQualifiedName~CoreLifecycleServiceTests.Workspace_|FullyQualifiedName~CoreLifecycleServiceTests.ExternalWorkspaces_|FullyQualifiedName~CoreLifecycleServiceTests.EnvironmentSource_|FullyQualifiedName~CoreLifecycleServiceTests.EnvironmentFromWorkspace_'
npm run test --workspace @haas/hosty-harness -- \
  src/sessions/docker-manager.test.ts src/sessions/development-manager.test.ts src/sessions/development.test.ts
npm run test --workspace @haas/hosty-demo-app
npm run lint --workspace @haas/hosty-demo-app
npm exec --workspace @haas/hosty-demo-app -- next build --webpack
```

The focused Harness selection passed **18 tests in three files**; Demo passed **6 tests in two
files**, lint and production build in the real Docker worker. `D9_OUTPUT` represents the temporary
artifacts directory, not a repository output or a host environment setting. Documentation index,
version validation and whitespace checks also pass. Full monorepo CI/Native AOT publication are
successful at the linked merge commit; they were not all repeated locally for these documentation-only edits.

## Coverage Ledger

`Offline` means `/api/sandbox-instances`; `Child` means trusted `/api/core-environments`.
Current regression results supplement the linked dated live reports rather than relabelling
mocked faults as real Docker events. Named methods refer to the actual test class; source-file
names are identified separately where a partial class is involved. “Runtime acceptance” below
refers to the dated 2026-10-14 results in
[Integrations And Verification Boundary](../features/app-sandbox-runtimes/feature.md#integrations-and-verification-boundary);
the other named reports are linked in [Evidence Retained From Earlier Runs](#evidence-retained-from-earlier-runs).

| ID | Requirement / profile | Existing exact coverage | Verified local outcome / retained boundary |
| --- | --- | --- | --- |
| L01 | Independent artifact client, no workspace; Offline | `SandboxHttpTests.IndependentClient_CompletesLifecycleWithoutWorkspace_AndCannotCrossOwners`, `SandboxServiceTests.ArtifactAllocationDoesNotCreateWorkspaceAndReplaysAcrossServiceRestart`; shipped runtime acceptance and QA fixture | Passed current protocol tests; independent child also created, started, set up and finished without a workspace. |
| L02 | Background grant, caller replacement/revocation and cross-owner denial; Offline/Child | `SandboxHttpTests.ExplicitBackgroundSandboxScopePinsInputsActionsAndOwner_AndRevokesOnline`, `CoreEnvironmentConsentHttpTests.SavedConsent_IsRevocableWithoutAnEnvironment_AndIsPinnedToInstallation`; trusted-Core report | Passed current HTTP/consent tests; prior trusted-Core revocation evidence retained. |
| L03 | Worktree authority, forged context, cleanup protection; both | `CoreLifecycleServiceTests.EnvironmentSource_*` (CoreEnvironmentSourceTests.cs), `CoreLifecycleServiceTests.Workspace_SandboxConsumerSurvivesOrdinaryLeaseReleaseAndCoreRestart`; shared-worker report | Passed source/workspace tests; unattached prepare refused, same UUID succeeded after attachment; live cleanup returned workspace_in_use. |
| L04 | Installed app and sibling data/cache independence; both | Shipped runtime acceptance (installed Demo plus two offline instances); Media/Transcode and trusted database reports | Passed: distinct child roots, users, app data and cache mounts; original parent Demo remained independent; 41 unrelated containers unchanged. |
| L05 | Restart persistence, full Finish, fresh subsequent identity; both | `CoreEnvironmentTests.Lifecycle_StopPreservesData_FinishRemovesOwnedRootAndPreservesBorrowedDirectory`, `SandboxServiceTests.ResetRecreatesSyntheticRealmAndExpandsFixtureReferences`; D9 Git Finish | Passed: new PID after stop/start, retained user and source image, both Finishes replayed; new/reset identity behavior also covered by current tests. |
| L06 | Interrupted disposal, revoked access and retained unknown ownership; both | `CoreEnvironmentTests.Finish_DockerUnavailable_ReplaysOriginalRequestAfterRestartAndRetainsReservation`, `Finish_PartialRootDeletion_ResumesWithoutIdentityButStillRejectsChangedIdentity`, `SandboxServiceTests.PartialStartKeepsResourceJournalAndDisposalFailureRemainsRevokedAndRetryable`; recovery/quotas and offline-daemon reports | Passed current interruption/partial-delete/unknown-owner regressions. Actual daemon loss remains the prior dated evidence; no global Docker restart here. |
| L07 | Source/HMR/browser assertions and reviewed dependency rebuild; both | Fresh-login report and D9 Git; `DockerSourceRuntimeTests.Build_ReusesImmutableImageDespiteSourceEditsAndRejectsUnreviewedRevision` | Passed: released Core Buildx build, held-page HMR, normal browser navigation; immutable-image and unreviewed-revision refusal tests passed. |
| L08 | Root/nested caches, generated files and actual HTTP readiness; both | `DockerSourceRuntimeTests.CacheMountpoints_PrepareFreshCheckoutAndPreserveExistingContents`, `GeneratedFiles_KeepSourceReadOnlyAndIsolateServiceCachesAcrossRestart`; D9 Git | Passed current cache/generated-file tests and empty-cache live setup after correcting the temporary helper; warm image and endpoints retained. |
| L09 | Allowed/denied viewers, stale identities and callback consumption; both | `SandboxHttpTests.PreviewViewerAclDoesNotGrantControl_AndRemovalRevokesTheRealmGrant`, `InstanceServiceAndUserGrants_RejectSiblingGenerationAndUpdatedSubject`; fresh-login and trusted-Core reports | Passed current ACL/generation tests; real child password login, retained user after restart and unavailable old preview after Finish. |
| L10 | Path/symlink escape, dependency fallback and external effects; both | `SandboxInputsTests`, `DockerSourceRuntimeTests.SourceMount_RejectsSymlinkEscapes`, `CoreLifecycleServiceTests.EnvironmentSource_AppCannotSelectUnownedOrEscapingProject`; trusted-Core mount/Redis and Media hash reports | Passed current source/path/symlink tests; live writes to both source mounts denied by read-only mounts. Prior Media/shared-mount evidence retained. |
| L11 | Isolated network/relay bypass probes; Offline only | Shipped runtime acceptance and `scripts/experiments/sandbox-network/probe.py` | Prior offline network probe evidence retained. Trusted-child internet remains an intentional different profile. |
| L12 | Persona roles, collisions and no global directory fallback; Offline only | `SandboxHttpTests.SandboxAdministrator_UsesActualLoginAndPkce_AndCannotBecomeCoreActor`, `DirectoryRequiresUserGrant_AndContainsNoUnrelatedCoreUsers`, `PasswordAndCodeAreSingleUse_ProofAndOriginAreRequired`; runtime acceptance | Passed current persona/login/directory HTTP tests; child real-password setup and independent account isolation also verified live. |
| L13 | Browser job/subject expiry, worker death, redaction and constrained actions; Offline only | `SandboxHttpTests.RecoveryRevokesOrphanBrowserJournalEvenBeforeAContainerWasRecorded`, `DeletingTemporaryUserRevokesExistingGrantsWithoutTouchingRealUsers`, `OperatorPersonaConfirmationIsSessionBoundSingleUseAndInstanceOnly`, `SandboxServiceTests.BrowserActionsCannotRequestArbitraryCodeOrAuthenticationState`, `SandboxDiagnosticsTests`; runtime acceptance | Passed current browser-journal/action/subject/redaction tests; this run used coordinator Playwright, not an agent-owned browser tool. |
| L14 | Admission, memory/PID/tmpfs failures, soft storage and log bounds; both | Runtime acceptance; `CoreEnvironmentResourceTests`, `CoreEnvironmentTests.Limits_AggregateReservationsSurviveStoppedFailedAndNestedCores`, `Limits_SoftDiskStopsWithoutDeletingData_UnknownInventoryRetainsState`; quota report | Passed resource/quota tests; inspected 2 GiB/1 CPU/256 PID service limits, zero OOM kills, two-child ceiling refusal and reservations returning to zero. |
| L15 | Build/start failure, detached work and Core/worker recovery; both | `CoreEnvironmentTests.Restart_BuildFails_DoesNotStopExistingCore`, `CoreEnvironmentRetentionTests`; shared-worker and D9 SIGKILL reports | Passed current build-failure/retention regressions. Real detached-writer/Harness and Docker-loss faults remain their dated evidence. |
| L16 | Lost response, changed input/revision, concurrent allocation/start and ports; both | `SandboxServiceTests.AcceptedLifecycleContinuesAfterObserverDisconnectAndReplaysItsJournal`, `CoreLifecycleServiceTests.Workspace_ConcurrentMonorepoRequestsReuseSourceAndRejectChangedRequest`, `CoreEnvironmentConsentHttpTests.CreateReplay_RenewsConsentAfterConcurrentStartWithoutLosingItsJournal` | Passed current race/replay tests; live concurrent same-ID Start returned one PID, changed-operation/stale-revision requests refused; distinct child ports verified. |
| L17 | Agent/app independence, preview adoption and old generation denial; both | Shared-worker report, D9 Git recovery and offline-daemon report | Passed current generation/grant regressions; previous shared-worker, D9 Git and daemon-recovery runs retain the actual crash/adoption evidence. |
| L18 | Failed setup/cache collisions and Docker mount/label/limit ownership; both | `DockerSourceRuntimeTests.CacheMountpoints_RejectFileCollisionsBeforeCreatingDirectories`, `CacheMountpoints_RejectExistingAndDanglingSymlinks`, `SandboxServiceTests.RuntimeAdoptionChecksConfigurationButIgnoresLiveCountersAndNetworkMembers`; runtime acceptance | Passed cache/collision/adoption tests; verified source mount flags and exact resource IDs/labels; two containers, six cache volumes and network absent after Finish. |
| L19 | Cold image/dependency preparation, warm HTTP readiness and HMR | Earlier measurements explicitly exclude some preparation phases | Measured fresh full OCI transfers, new dependency layer, empty app-cache setup, actual readiness and warm Core replay. VM/base layers were shared; the timing section retains the helper failure. |
| L20 | Simultaneous resources across setup/edit/test/build/browser and OOM accounting | D9 Git has complete selected workload samples but incomplete early source-Core preparation | 641 continuous samples from before preparation through teardown; native descendants included. Docker-engine-internal build memory excluded and the memory section states the parent artifact sampling caveat. |
| L21 | Authorized Git/PR/CI/review, source/export retention and no automatic live-data trial | D9 Git report, PR #599 merge and successful Core/Demo publications | PR #599 merged and all ten workflows succeeded; no new Git publication in this continuation. |
| L22 | Selected support matrix and exact-input guarantees | macOS arm64 plus Linux arm64 containers and earlier native-AOT Linux-in-Docker fixture | Local macOS arm64/Linux arm64 Docker profile verified. Native Linux/Windows and Linux amd64 worker/other recipe guarantees remain in D9. |

## Finish And Fixture Teardown

Independent inspection after the real agent's two Finish operations and exact replays found:

- Both child data roots, native PIDs and ports **31801/31044/30832/32014** absent/closed.
- Both recorded Demo containers, **six cache volumes and one network** absent, including stopped
  inventory and searches by the full `hosty.instance` ownership label.
- All **1,923 captured source-file hashes** unchanged (tracked source plus two temporary recipe
  files). Finish preserved the borrowed worktree before separate coordinator-fixture teardown.
- Temporary child credentials removed, no unfinished child reservation, and no sandbox preview
  left in Harness. User/config/cache/log removal follows the verified complete child-root deletion.
- **41 pre-existing containers** retained their IDs, running states, start times and memory limits.
  The operator's media directory was never mounted or used in this Demo acceptance.

The coordinator then stopped the worker using Harness's supported runtime endpoint, removed its
own installed Demo through Core, stopped its own Harness/Core, closed the dedicated browser and
verified all fixture ports/processes/containers were gone. The entire disposable parent root,
selected-account authorization copy, synthetic accounts and browser profile were deleted. The
separate fixture worktree was deleted only at this coordinator teardown, after source-preservation
proof; the registered documentation workspace remains for review. Two uniquely labelled temporary
image references and the untagged first-attempt image were removed. No image with the fixture
label remains. Shared release/base images and Docker's build cache remain outside
sandbox Finish ownership; no global prune was performed. Raw evidence, credentials and logs are
not added to the repository.

## Evidence Retained From Earlier Runs

- [Shared worker and both providers](2026-10-15-shared-docker-agent-acceptance.md).
- [Fresh direct/embedded login and HMR](2026-10-15-sandbox-login-hmr-acceptance.md).
- [Trusted-Core permissions, mounts, Redis and Linux-in-Docker Finish](2026-10-15-trusted-core-consent-acceptance.md).
- [Actual Docker loss and interrupted offline disposal](2026-10-15-offline-sandbox-daemon-acceptance.md).
- [Recovery and aggregate quotas](2026-10-14-sandbox-recovery-and-quotas.md).
- [Media/Transcode and read-only media preservation](2026-10-14-read-only-media-sandbox-acceptance.md).
- [Agent Git/PR/CI/review and Harness failure](2026-10-15-sandbox-d9-git-acceptance.md).

Those archives retain their original baseline and outcomes. PR #599's later merge/publication is
established here rather than rewriting the earlier pre-merge report. Native Linux/Windows,
Linux amd64 worker and other recipe guarantees remain unverified under D9; remote preview remains
D11. This acceptance does not approve per-session agent containers or expand trusted-Core policy.

# Child Core Docker Recovery and Aggregate Quotas — 2026-10-14

## Baseline and scope

Baseline main is `ee7f2848a0e14e20d81c9a030befcc43adead401` (merged docker-host #593).
The implementation is an uncommitted external-development workspace. Its non-documentation
changed-file fingerprint is `e039ea36975350d223466d2396edfc647e4cd66d874599a321a975800408ba91`: SHA-256 over sorted changed/untracked paths,
a NUL separator, and each file's SHA-256 digest. No raw evidence JSON, logs or experimental patches
are repository deliverables.

Versions: Platform **0.132.5 → 0.133.0**, Harness **0.51.0 → 0.51.1**,
SDK **0.28.0 → 0.29.0**, Shell **0.102.2 → 0.102.3**, Workspaces **0.3.1 → 0.3.2**.
This acceptance completes sandbox **D26**. D5's remaining offline single-app fault matrix and
D16's broader ordinary-user/service permission matrix remain open in the [plan](../features/app-sandbox-runtimes/plan.md).

The macOS arm64 test uses an isolated coordinator, a real Codex CLI 0.160.0 agent through Harness,
a separate Playwright container, ordinary child setup/password login, and the shared local Docker
Desktop engine. The operator's primary Core is not restarted or reconfigured. A deliberate Docker
Desktop stop/start interrupts its running Shell container; that exact previously running container
is restored. Apps that were already stopped are not started by the test.

## Published Media acceptance

The downloaded release artifacts are pinned and checked against their source revisions:

| Component | Version / revision | Registry digest |
| --- | --- | --- |
| Media API | 0.92.0 / `d75073e78276426b56a9c11bd999bf7ee931c9d0` | `sha256:268d83854bf554c3f81693a816ae75c635a44d09c82db239f2030f452ff1de20` |
| Media web | 0.92.0 / same revision | `sha256:d166e6943ec2f0b78f5fc2430d143374c5374a610f500c1a1fb0069a4a098318` |
| Transcode Engine | 0.14.0 / `4bf6f00fae610d320ac38b01aaef49e518f23b04` | `sha256:e24698d343e8006de824f02804c91899c870aaac58eeecbb8a0958f867af4f04` |

The agent creates the child, reviews/confirms the ordinary installations, creates a read-only
catalog, scans 31 files, and uses a normal authenticated manual-match request for one temporary
test identity. No TMDb key or production identity/connection is copied. Automatic metadata enrichment
and the unresolved Torrent dependency are not claimed as tested.

The original 47m38s AVI is used directly from `/Users/haas/dev-media`. Media API and the dedicated
Engine have actual `RW=false` input binds; a unique-file write probe fails with a read-only filesystem
error. Export goes to a separate fixture-owned writable folder. The UI submits H.264/CPU/Small,
original audio and a 480 maximum height; the 400-pixel input is not upscaled. The job completes in
**396.181 seconds**. Independent ffprobe reports H.264/MP3, **720×400**, **2,858.4 seconds**,
**219,576,268 bytes**. Full decode exits zero with no diagnostics.

[Completed export controls](../features/app-sandbox-runtimes/2026-10-14-released-media-export.png).

An otherwise equivalent conversion without an export destination returns HTTP 409 before another
Engine job is created. Library source count remains one. Engine stop/start takes **3.259 / 1.517
seconds**; Media stays running. Core dependency readiness becomes false during the outage and true
afterward. Media's capability `available=true` denotes configuration, not live readiness. The first
export remains downloadable (HTTP 200); a new recovery remux completes, downloads and independently
passes full variable-frame-rate decode. Both exports are deleted through ordinary Media controls
(HTTP 204), without removing the library source.

This first released-artifact pass uses fixture-applied container limits. Its old Core incorrectly
reports Finish success while leaving an unlabelled dependency network. The coordinator removes only
the exact network ID captured before Finish, after proving it has no endpoints. This is a real
baseline defect, not a successful product cleanup claim. The implementation labels new networks and
refuses to call legacy ambiguous cleanup complete; it does not delete networks by prefix alone.

## Product quotas and real daemon failure

A second fresh child runs Core 0.133.0. The agent reserves **6 GiB / 3 CPUs / 768 PIDs** from the
root **8 GiB / 4 CPUs / 1,024 PIDs** pool. A second default 4 GiB request is rejected before root
creation, both while the first child runs and while it is stopped. Nested aggregate admission and
concurrent root reservation are covered by Core tests. A 2 GiB sibling fills the remaining pool.

Core itself applies these limits before Docker run; no `docker update` fixture is used in this pass:

| Service | Memory and swap ceiling | CPU ceiling | PID ceiling |
| --- | --- | --- | --- |
| Media API | 1 GiB | 0.5 | 128 |
| Media web | 1 GiB | 0.5 | 128 |
| Transcode Engine | 2 GiB | 1 | 256 |

Admission includes other containers, retained stopped containers and mixed-profile sibling services;
a partial service start cannot discard its siblings' reservation. Unknown Docker inventory or
unbounded existing containers is an explicit refusal. Named source caches and dependency networks
carry the full instance label. Kernel read-only input mounts remain unchanged after replacement.

Docker Desktop is actually stopped, rather than substituting a mocked response. Resource observation
becomes `unknown`. Finish for the 2 GiB sibling fails visibly with `cleanup-failed`, preserving its
root and capacity. After Docker starts, the agent explicitly starts Engine then Media through Harness
(**1.560 / 3.355 seconds**), verifies healthy dependency resolution, signs in normally and opens the
installed application through Core. The read-only catalog survives. **Automatic app restart is not
observed or claimed**; recovery uses ordinary explicit lifecycle calls. The restarted browser server's
private WebSocket endpoint is refreshed in the fixture before reconnecting.

[Authenticated catalog after Docker recovery](../features/app-sandbox-runtimes/2026-10-14-docker-recovery-catalog.png).

The agent retries the sibling's original Finish UUID and original expected revision. It reaches
`finished`; the independently captured owned network, named volume and root are absent.

## Interrupted physical deletion

Finish for the Media child is sent through Harness with a persisted UUID. The coordinator waits for
Docker cleanup and the external `rootDeletionStarted` checkpoint, then SIGKILLs only the isolated
parent after `core/instance-id` is gone. **30,000 owned fixture files still remain**. The replacement
parent reconciles the operation to `cleanup-failed`. A launch against the closing root is refused
before generating another identity; the final launcher regression check exits cleanly with code 1.

The real agent repeats the exact original Finish request, including its old expected revision.
Deletion completes and the operation succeeds. Repeating the receipt leaves the terminal revision
unchanged. Independent checks confirm child PID identities, Core ports, roots, labelled resources,
instance networks and the exact recorded container/network IDs are gone. The new dependency network
is removed by product Finish without the baseline's manual repair.

A separate real soft-disk probe starts a child with a **32 MiB** limit and adds owned test data.
At **59,658,651 bytes** observed, Core stops its process and reports `quota-exceeded`, retaining data.
Finish subsequently removes the root. Another probe verifies that a pre-0.133 Core is refused,
its spawned process is stopped, and its temporary root can still be finished.

## Resource observations and boundaries

Retained samples cover the capped installation, browser, daemon recovery and cleanup sequence.
They do **not** establish peak encode memory: the earlier baseline sampler output was replaced,
so no full-encode memory figure is inferred from it.

| Component | Maximum sampled container working memory | Maximum retained cgroup peak |
| --- | --- | --- |
| Real agent | 707.0 MiB | 804.5 MiB |
| Playwright | 535.8 MiB | 603.0 MiB |
| Media API | 158.7 MiB | 166.7 MiB |
| Media web | 81.5 MiB | 97.7 MiB |
| Transcode Engine | 120.8 MiB | 129.4 MiB |

The simultaneous sampled container working-set maximum is **1,565.0 MiB**, not a sum of separate
peaks. No sampled cgroup OOM kills occur. Native parent/child Core RSS peaks are **261.3 / 222.5 MiB**,
measured separately. Working-set sampling and cgroup high-water accounting are different metrics.

The pool bounds managed child app containers; it is not a whole-host memory guarantee or a budget
across independently installed primary roots. Native Core, build and local-command processes are not
hard-capped. Owned disk is a monitored soft quota; borrowed external mounts and shared image/BuildKit
layers are outside it. These limitations remain explicit in the feature contract.

## Cleanup and input integrity

All **five** test environments finish: released-artifact baseline, capped Media child, outage sibling,
soft-disk probe and old-Core compatibility probe. The coordinator, its native Harness processes,
agent/browser containers, fixture network, temporary output/data roots, copied provider login and
private sessions are removed. All three fixture image aliases are removed; shared release images and
the implementation worktree are preserved. Docker is left running and the interrupted primary Shell
container is restored.

After the media sandbox is deleted, the full original tree comparison verifies **154 entries,
118 SHA-256 file hashes and 94,222,024,758 bytes**. Relative paths, type/mode, sizes, nanosecond mtimes
and symlink targets also match. The original media folder is unchanged.

## Verification

- `dotnet build apps/core/src/Haas.Hosty.Core/Haas.Hosty.Core.csproj --artifacts-path <isolated output> --nologo`: passes; four existing warnings, no errors.
- `dotnet test apps/core/tests/Haas.Hosty.Core.Tests/Haas.Hosty.Core.Tests.csproj --no-build --artifacts-path apps/core/tests/Haas.Hosty.Core.Tests/bin/recovery-tests --nologo`: **3,268 passed, four skipped**. After the final launcher/mixed-service review refinements, the affected CoreEnvironment/Sandbox/DockerRuntimeAdapter/CoreRootLock suite is rerun: **211 passed**.
- The skipped opt-in cases are Telemetry mixed-profile ingestion, Docker-development HMR, and two Torrent/VPN integration scenarios. They are outside this fault/Media run. An earlier full-suite attempt with artifacts outside the repository was stopped because repository-relative fixtures could not be located; the corrected full run passes.
- `node scripts/check-core-aot.mjs`: final macOS arm64 native publish passes with **no trim/AOT warnings**.
- `npm run harness:test`: **541 passed**; `npm run harness:lint` passes.
- `npm run sdk:test`: **662 passed**; SDK build passes, including failed-Finish replay across UI refresh.
- `npm run shell:test`: **268 passed**; `npm run workspaces:test`: **17 passed**. Both production builds pass.
- `node scripts/check-versions.mjs`, documentation index validation and `git diff --check` pass.

The released pair, normal browser authentication, real daemon failure, interrupted deletion and
independent cleanup checks above are separate runtime evidence; unit tests are not substituted for them.

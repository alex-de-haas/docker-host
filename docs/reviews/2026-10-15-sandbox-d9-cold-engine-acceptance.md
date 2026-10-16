# D9 Isolated Cold-Engine Acceptance

Date: 2026-10-15. Baseline: `9185cd6789c3d0fde397dceacfb68f15e0cdc737`, merged
[PR #600](https://github.com/alex-de-haas/docker-host/pull/600). This records **Sandbox D28**:
the cold-engine gap retained by the [D27 report](2026-10-15-sandbox-d9-local-acceptance.md)
is verified for one Linux arm64 Demo workload inside Docker Desktop on macOS arm64.
[D9](../features/app-sandbox-runtimes/plan.md) retains native Linux/Windows, amd64-worker and
additional recipe acceptance. This run changed no product code/version and created no commit,
push or PR; the earlier [Git acceptance](2026-10-15-sandbox-d9-git-acceptance.md) owns that evidence.

## Inputs And Isolation

The operator authorized an independent engine and prohibited changes to existing containers or
caches. The original Docker engine remained `ff10c7da-e7dd-487c-9770-072b8953055b`, context
`desktop-linux`. The successful test engine was `fc9544ed-f394-4ec5-b096-152dcf73d207`, with a
new named data volume, initially **zero images and zero containers**, and no inherited build cache.
There was no mount of the original Docker socket, host home, application data or media library.

A disposable privileged Linux container hosted its own Docker 29.8.2 daemon, containerd, released
Core, native Harness and Chromium. It reused the existing outer Playwright image by immutable ID;
there was no outer image pull/build/prune. Private cgroup delegation and `cgroupfs` permitted real
nested memory limits. Commands used a temporary key-only SSH endpoint on loopback, not the primary
engine for inner workloads. This is an acceptance fixture for an empty engine, not a new product
runtime or a malicious-code isolation claim.

- Outer ceiling: **12 GiB RAM, 6 CPUs, 4,096 PIDs**; swap ceiling equals RAM, with no additional
  swap allowance. The already-running Docker Desktop VM had 14 CPUs and about 15.63 GiB. Inner
  `docker info` reports that VM capacity, not the outer cgroup ceiling; both boundaries are recorded.
- Harness worker: **4 GiB, 2 CPUs, 512 PIDs**, separate from both Demo service containers.
- Child reservation: 6 GiB / 3 CPUs / 768 PIDs / 10 GiB soft disk. Its application allowance
  was 4 GiB / 2 CPUs / 512 PIDs, split into two services at 2 GiB / 1 CPU / 256 PIDs each.
- Core/CLI **0.135.1** were downloaded as Linux arm64 artifacts from the `cli-dev` release;
  VERSION and SHA256SUMS were checked. Core SHA256:
  `3ecfc1f03e8982ae7c4c2278e494be2f141134487aabafb174f7958eafd47ff0`;
  CLI: `4f6acc00a9b4a46a537e1ff5e589a057a6c180792edf9f3c5eefb47843423e0f`.
- Harness **0.53.0** ran from a tar export of the baseline, with fresh fixture dependencies and
  a built web UI. Worker `ghcr.io/alex-de-haas/hosty-agent-worker:0.53.0` was pulled through
  Harness into the empty engine. Only the selected Codex authorization was copied to temporary
  storage; no host home was mounted. Node in the worker was 22.23.3.
- The agent prepared a Core-owned worktree at the baseline and changed **Demo 0.17.2**. It used
  the source runtime, not the published Demo image. The parent Demo installation stayed stopped.
- The temporary source recipe used Node 24 Bookworm Slim pinned to
  `sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20`.
  Core's normal `build` field built it; the agent did not invoke Docker directly. Source was
  read-only, data was child-owned and initially empty, and six named cache volumes plus generated
  file overlays belonged to the two services. The first build used an empty npm cache and lockfile.

The Linux tools, browser and Harness dependencies were prepared before the successful engine
measurement. Their provisioning is not hidden inside the app startup number. Harness `npm ci`
took 24.66 seconds and its web build 17.50 seconds during fixture preparation; those prepared files
were reused after the preflight correction below. Release transfer, host VM startup and a cold
physical disk are not included. Image layers became shared naturally within the new engine after
its initial empty state; no layers were imported from the original engine.

## Real Agent And Browser Journey

One real Codex conversation in Harness performed the following in the supported Docker execution
mode. The operator's browser coordinator supplied the approvals and observed the UI; browser
claims are not inferred from the agent's text.

1. Prepare the Demo worktree, inspect repository instructions, request a child, receive normal
   permission/consent refusals, then retry the same persisted Create UUID after real browser review.
2. Start child `b4cc27a97ec0416c98c177121b16eb1f` from the released Core. Set up a fresh test
   administrator through ordinary setup, then successfully log in by email/password in Chromium.
   The parent and child had different accounts and data roots.
3. Prepare an uncommitted Demo marker and temporary dependency recipe, request installation with
   `autostart: false`, and await normal child installation review. Start through the child API;
   Core built the dependency image and both services became healthy.
4. Install worker-side dependencies and pass `npm run test --workspace @haas/hosty-demo-app`
   (**2 files, 6 tests**), `npm run lint --workspace @haas/hosty-demo-app`, and
   `NEXT_DIST_DIR=.next-d9-build npm run build --workspace @haas/hosty-demo-app`.
   The production build used a separate output directory from the live development services.
5. Open the Core-managed Demo origin in Playwright. Assert the cold marker, active
   `child-qa@example.test`, absence of `parent-qa@example.test`, and removal of callback parameters.
   Set a page sentinel; have the agent change the marker to `D9 isolated warm Demo — HMR verified`.
   The new marker appeared while the sentinel stayed unchanged: HMR passed without page reload.
   People and Overview navigation also passed.
6. Stop and Start the same child with persisted UUIDs/revisions, then explicitly start Demo because
   autostart was disabled. Independently verify two new container IDs, the same image digest,
   all six retained cache names, healthy services, the warm marker and the original child account
   after a browser reload. No additional pull or build occurred.
7. Have the agent Finish and replay the identical UUID/input. Independently verify deletion before
   removing the remaining disposable parent, browser, engine and data volume.

The source image ID was
`sha256:56d650c60b0c21e88f37ba5437876fcaae6c1faf370ed829401695107db1c76f` for both services and
both starts. The worker remained the separate shared-runtime execution path; the run does not
claim per-session isolation. Normal-mode Codex shell execution hit namespace restrictions in this
nested fixture, so the successful run used the existing **Autonomous** mode. Normal-mode execution
inside this particular DinD topology is not verified.

## Timing

One cold and one warm app run were measured, not a percentile benchmark. Docker CLI observation
passed through the actual Harness/Core commands, exit codes and output. Native processes and
cgroups were sampled from before daemon startup. Human review and model response time are excluded
from the start request timings. The start request ends after Core observes healthy HTTP services;
it does not include the later first authenticated page compilation/navigation.

| Stage | Observed duration | Boundary |
| --- | ---: | --- |
| Independent Docker daemon ready | 1.45 s | Empty-engine process launch to successful info |
| Parent/Harness bootstrap including worker pull | 23.13 s | Prepared native inputs to configured Harness session |
| Cold worker pull/import | 19.38 s | Actual successful Harness-triggered Docker pull |
| Worker layer extraction | 15.85 s summed; 17.61 s first-to-last span | 18 matched daemon tar operations, 1,837,568,239 unpacked bytes |
| First Demo image build | 16.28 s | Missing Node base, dependency setup and image export |
| Node base extraction | 2.68 s summed; 2.72 s span | 5 matched tar operations, 248,658,274 unpacked bytes |
| Dependency install inside image build | 9.3 s | BuildKit step, 431 packages, empty npm cache |
| Second service image tag/build | 0.137 s | Same recipe reused the first service's build cache |
| Cold Demo Start | **28.154 s** | 20:55:30.866–20:55:59.020 UTC, both services healthy |
| Child Stop | 20.561 s | Running revision 3 to stopped revision 5 |
| Warm child Start | 2.962 s | Stopped revision 5 to running revision 7 |
| Warm Demo Start | **6.073 s** | 20:59:57.305–21:00:03.378 UTC, retained image/caches |
| Finish | 16.468 s | Running revision 7 to finished revision 9 |
| Identical Finish replay | 0.017 s | Same UUID and expected revision, same terminal result |

Tar extraction intervals overlap downloading; they are components of the pull/build wall time,
not extra time to add to it. BuildKit reported the Node FROM stage as 3.3 seconds and image export
as 1.7 seconds. The warm app start was about **4.6 times faster** in this one run. Stop includes
shutdown grace; a service was killed after its grace period, with no cgroup OOM event.

## Memory

All values below are MiB. `memory.peak` is the kernel high-water mark including charged file cache;
working set is sampled `memory.current - inactive_file`. RSS is sampled separately and can count
shared pages more than once. Component peaks occurred at different times and must not be summed
as if simultaneous. One-second polling can miss short working-set/RSS peaks; cgroup peaks remain
available while that group exists.

| Scope | Charged cgroup peak | Sampled working-set maximum |
| --- | ---: | ---: |
| Entire bounded fixture, including daemon, engine builds, native Core/Harness/browser, agent and app | **8,458.59** | **3,776.53** |
| Agent turn performing dependency install/tests/production build | 2,068.91 | 1,772.48 |
| Demo frontend, cold lifetime | 1,593.59 | 853.90 |
| Demo backend, cold lifetime | 997.75 | 389.25 |
| BuildKit group | 1,242.35 | 509.65 |
| Demo frontend, warm lifetime | 761.25 | 673.89 |
| Demo backend, warm lifetime | 320.28 | 299.20 |

The whole-fixture sampled maximum was 8,329.39 MiB; its kernel peak was **8.26 GiB** under the
12 GiB cap. Every observed cgroup reported **zero OOM kills**. Whole-fixture sampled charged peaks
were 3,145.92 MiB during worker image import, 6,855.20 MiB during cold app Start and 7,215.69 MiB
during the warm lifecycle. Later phases retain earlier filesystem caches, so these numbers are not
incremental application costs.

Native sampled simultaneous RSS maxima were 129.69 MiB for dockerd, 80.41 MiB for the observed
containerd processes, 239.24 MiB for the parent/child Core processes together, 159.80 MiB for the
Harness launch/server processes, and 1,060.21 MiB for observed Chromium processes. These are
explanatory subsets of the full enclosing cgroup, not additional memory to add to it.

## Corrections And Limits

- An initial disposable preflight had incorrect cgroup delegation: worker startup could not apply
  its memory controller. That fixture and its volume were removed. The successful run recreated
  the engine with a fresh volume and empty inventory; failed-preflight timings are excluded above.
- The source-build API has no Dockerfile target selection. The temporary recipe ended at the
  dependency/development stage, copied cache entries individually into the mounted directories,
  and used the default root user to read the owner-only fixture checkout. It did not exercise the
  unmodified recipe's UID-switching entrypoint or establish general recipe support.
- The first worker test/lint/build attempt preceded `npm ci` and failed with missing tools.
  After dependency installation all three commands exited zero. A diagnostic command used the
  session directory rather than the worktree and was retried with the worktree path.
- Installing a separate `manifest.d9.json` while leaving a different live `manifest.json` caused a
  retained manifest review warning. The agent reconciled only its disposable live manifest with
  the reviewed input. Warm Start then reported `manifestError: null` and retained the image ID.
- Browser console output included a missing favicon and expected HMR connection failures while
  the application was deliberately stopped/finished. This is not a zero-console-error claim.
- No Docker-loss injection, Git publication, embedded Shell repeat or second provider was added to
  this cold-engine run; their existing reports remain the evidence. Native Linux/Windows, amd64,
  other recipes and a cold physical VM/host were not tested.

## Independent Cleanup And Primary Preservation

Finish used `b74fe27e-6097-4712-91b6-63964deee76d` with expected revision 7. The agent observed
finished revision 9, null data root/process and no error, then replayed the identical input.
Independent assertions, before outer teardown, passed:

- Child data root absent, including its users, credentials, app data and generated files.
- Child Core port 31767 and app ports 27370/27308 closed; delegated child API rejected access.
- Zero remaining inner containers and zero named volumes; the owned network was absent.
- Borrowed worktree HEAD, tracked diff hash and five edited/temporary file hashes unchanged by Finish.
- Engine-level worker/source images and build cache remained until the disposable engine was
  removed; Finish is not claimed to prune shared engine caches.

The browser and fixture parent Core were stopped normally, the independent daemon terminated,
and the exact owned outer container and Docker data volume removed. Temporary selected-account
credentials, SSH key, browser profile, roots, downloaded tools, source/dependency/build files and
raw logs/evidence were deleted with the fixture directory. No raw evidence is added to Git.

The final original-engine inventory matched all **41 existing containers, 153 images, 505 build
cache records, 15 volumes and 26 networks**. Container IDs, names, images, runtime state/start
identity, limits and mounts were unchanged (health-check history naturally advances). Image/cache,
volume and network records matched. Docker context and engine ID were unchanged. The primary Core
kept process identity `83710:639276809448569630`, four running apps and zero errors. The fixture's
loopback SSH port was closed. No existing container was stopped and no existing cache was pruned.

## Verification Commands And Scope

The agent's Demo unit/lint/build commands above passed after dependency preparation. Coordinator
checks asserted real browser identity/HMR/navigation, image/cache retention, source preservation,
closed ports, owned-resource deletion and exact primary inventory preservation. Documentation
validation uses `node scripts/docs-index.mjs --fix`, `node scripts/docs-index.mjs --check`,
`node scripts/check-versions.mjs` and `git diff --check` in the registered coordinator worktree.
No product Core/SDK/Harness code changed, so their already-recorded regression suites were not
rerun for this documentation-only result. No version bump is required.

# Fresh Login, HMR And Child Core Cleanup — 2026-10-15

## Baseline And Result

Base: merged PR #594, `c5d37752356b3a2713a9a89435bb21ca060591c3`.
Core/CLI **0.133.0** were downloaded from the published `cli-dev` release; both SHA-256 checks
matched `SHA256SUMS`. All post-merge publishing workflows succeeded. Shell **0.102.3** ran from
image `sha256:cb41dc209dba85fad54cc1fa479143842723d12acf8736b8b7dac1362ba85bde`, whose OCI
revision matches the merge. Harness **0.51.1** used unchanged source from that baseline.

The original bug reproduced: after a fresh normal Core password login and opening Demo inside
Shell, the real Harness agent changed a heading. HMR displayed it in **1,300 ms**, but consumed
`code` and `state` returned to the iframe URL. The app session remained active. Subsequent
navigation/reload cleaned the URL, which does not invalidate the initial failure.

The SDK patch removes consumed parameters immediately, then repeats the final History API
replacement after parent React effects install Next's adapter. The router then retains the clean
canonical URL during HMR. The deferred action skips an intervening navigation or another cleanup.
It changes no code redemption, PKCE, token issuance or authorization checks.

Two new browser contexts with no stored credentials verified the patch:

| Journey | Source edit to visible HMR | Callback parameters after HMR | Navigation and reload |
| --- | ---: | --- | --- |
| Fresh password login → Shell → embedded Demo | 295 ms | Absent | Authenticated, clean URLs |
| Fresh password login → direct Demo | 184 ms | Absent | Authenticated, clean URLs |

These are individual observations, not a controlled latency comparison or p95. The same open page
was observed before/after each edit; no manual URL cleaning, reload or reauthentication established
the HMR result. The [embedded preview](../features/app-sandbox-runtimes/2026-10-15-fresh-login-hmr.png)
shows the actual changed heading.

Unrelated query parameters survive HMR. A query/fragment present on a normal page load, and a
fragment set through `history.replaceState(null, ...)`, also survive. A separate hash-only navigation
using `location.hash`, even after 2.5 seconds, loses its fragment on HMR. This is recorded separately
from callback cleanup: that path does not invoke SDK parameter consumption. Core's `/open` journey
also does not preserve the supplied fragment. Ordinary People/Overview links have fixed hrefs and
do not carry the test query. No general fragment-navigation fix is claimed by this patch.

## Fixture And Authority

macOS ARM64 with Docker Desktop Linux ARM64; Docker reports **16,787,152,896 bytes** of VM memory.
The owner selected macOS plus Linux containers; native Linux-host and Windows acceptance were not
run. Docker Desktop settings and the operator's Core were not changed.

A disposable released coordinator Core ran on port 37831 with an empty distribution catalog.
Its real Harness session `1a5a0b18-bd49-4f8d-a02b-95f48c8c1200` prepared worktree
`afe33a7d3307668a2234d120dae503f33fc197682c03872a6c365b9b05399677`. The Codex worker had only its
private data, that worktree and read-only Git common directory; no Docker socket or primary checkout.
A separate Playwright browser used ordinary password login and the ordinary installation confirmation
pages. Provider login was temporarily copied into worker data and removed during cleanup.

The agent created child Core `8ae47bc5834245cf8f50f008a90aa930`, bound that worktree, performed setup,
approved Shell/Demo installation, selected the source override, started the apps, edited the heading,
ran browser checks and called Finish. The child reserved 6 GiB/3 CPUs/768 PIDs for its app containers.
Each app reserved 3 GiB/1.5 CPUs/384 PIDs; Demo's two services split that reservation. The agent had
4 GiB/2 CPUs/512 PIDs and the browser 1.5 GiB/1 CPU/256 PIDs separately.

Demo **0.17.0** used the baseline Docker development recipe with a fixture-only local image reference.
The prepared image was `sha256:8ac4de9daeea23394009121a05257a47c05ea6e8339694d7ab595c3d0a268a2c`.
Both source mounts were actually read-only, with separate root/nested dependency caches, generated-file
overlays and Next output volumes. Coordinator copying the two candidate SDK source files into the
acceptance worktree is distinct from the agent's heading changes. Dependency manifests were unchanged
there so the prepared image fingerprint stayed valid. The implementation workspace versions the SDK
as **0.29.1**; its production build and tests use the final package metadata.

Two fixture failures preceded acceptance: the transport bridge compared a group workspace ID with
a worktree ID, and the downloaded Core executable retained its release-asset filename instead of
`hosty-core`. The coordinator fixed only those fixture inputs. The existing child and persisted request
IDs were retained; no product source fix was needed for either failure.

## Resource Measurements

There are 254 samples, at a median interval of 5.14 seconds. Measurements span
setup, initial failure, source edits, browser checks and Finish. Sampling can miss brief peaks and
Docker reads within a batch are not atomic. Startup time is not reported because fixture repairs
invalidate a cold-start measurement. The production build below ran separately on the host and is
not part of the agent-container workload.

| Container | Sampled working-set maximum | Cgroup lifetime peak |
| --- | ---: | ---: |
| Agent | 642.5 MiB | 679.2 MiB |
| Browser | 275.2 MiB | 365.6 MiB |
| Demo frontend | 784.4 MiB | 1,536.0 MiB |
| Demo backend | 388.2 MiB | 997.7 MiB |
| Shell | 87.5 MiB | 96.5 MiB |

The maximum combined working set in one sampling batch was **2,080.1 MiB**; combined charged memory
was **3,377.3 MiB**. Individual lifetime peaks are not added. All captured OOM/kill counters were zero.
The frontend reached its 1.5 GiB charged-memory ceiling and recorded **346 `memory.events.max`**
events, so this is evidence of reclaim pressure, not ample headroom or a recommended universal limit.

Sampled native Core RSS maxima were **178.6 MiB** for the coordinator and **108.9 MiB** for the child.
The monitor captured Harness's launcher/tsx processes but initially omitted its actual Node child;
a later idle observation measured that child at **73.2 MiB**. No peak or complete simultaneous
Core/Harness host-memory claim is made. Docker VM overhead and unrelated operator workloads are excluded.

## Finish And Independent Cleanup

Harness persisted and executed Finish, then read terminal `finished` with `dataRoot: null`.
Independent checks confirmed:

- Child PID 38758 and its owned root were absent.
- All three app containers, one app network and six source-cache volumes were absent by recorded IDs.
- Core port 27451 and app ports 26179, 30150 and 26110 were closed.
- Borrowed source and heading edits survived; the sandbox consumer was released.

The coordinator then released its source lease, stopped the disposable parent/Harness, removed the
agent/browser containers and their separate network, and removed its development-image tag. Parent,
Harness, adapter and child PIDs were absent; ports 37831, 37832 and 21239 were closed. Temporary provider
login, browser storage/cookies, bridge key, account copy, and disposable Core/app state were removed.
The test worktree and Git common directory remain outside sandbox cleanup. Raw logs and evidence stay
outside Git; only this report and the sanitized screenshot are repository assets. Shared images and
daemon build cache were not globally pruned.

The operator's primary Core remained PID **24331**, release mode, with start identity
**2026-10-14T19:48:46.9728+00:00**. Unrelated operator containers were untouched. This run did not
mount or access `/Users/haas/dev-media`.

## Verification And Remaining Scope

- `npm test --workspace @hosty-sdk/app -- --maxWorkers=2`: **667 passed**, including three regressions
  for late router installation, intervening navigation, and combined launch-parameter cleanup.
- `npm run build --workspace @hosty-sdk/app`: passed.
- `npm run demo-app:build`: passed with the patched SDK.
- `npm run demo-app:lint`: passed.
- Version consistency, documentation index/link validation and `git diff --check`: passed.

Core source and Harness source are unchanged, so their full build/unit suites were not repeated for
this SDK-only fix; the released Core and real Harness were exercised above. No commit or PR was created.
[Sandbox D9](../features/app-sandbox-runtimes/plan.md) stays open for the broader acceptance matrix,
including remaining host/recipe guarantees and complete native-process resource measurement. D13/D15
consent/mount policy and D14/D16/D17 dependency/authority coverage are not delivered by this report.

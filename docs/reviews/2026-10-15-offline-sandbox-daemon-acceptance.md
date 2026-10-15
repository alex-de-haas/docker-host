# Offline sandbox Docker recovery acceptance

Date: 2026-10-15. Baseline: `c5d37752356b3a2713a9a89435bb21ca060591c3`
plus the uncommitted sandbox-consent work and the recovery fixes below.
This supersedes the earlier prepared-instance recovery checkpoint and supplements the
[trusted-Core acceptance](2026-10-15-trusted-core-consent-acceptance.md).

The live offline single-app Docker-loss and interrupted-disposal cases pass on macOS arm64
with Docker Desktop. D5 remains open for its production agent/worktree monitor integration;
that work depends on the separately approved worker-coordinator plan. This report does not
establish the entire D9 matrix, native Linux-host execution or Windows support.

## Reproductions and fixes

A normal operator plan for the pinned Demo App artifact was created through the real Harness
agent and browser in a separate Core. Core was killed after the prepare allocation journal
reached disk, before temporary data allocation. The replacement supervisor marked the interrupted
operation unknown and the instance stopped. Repeating the original prepare UUID kept the same
instance ID, but returned stopped without allocating data: the old implementation resumed only
from preparing.

Preparation now resumes from the sole unfinished prepare journal, with no runtime resources
and no subsequent lifecycle operations. It re-reads state under the mutation gate before acting.
The same retained UUID recovered the original real instance, allocated its directories and
cleared the stale instance/operation error. Disposed instances still replay their receipt and
are never recreated. Regression tests cover preparing/running, stopped/unknown and unknown/failed,
including actual supervisor reconciliation before replay.

A second fault killed only the disposable Core while a prepared instance was disposing, with
12,000 small fixture files making the deletion interval observable. Access was already revoked.
Replay of the original dispose UUID completed deletion, but initially exposed the preceding
unknown operation state while the accepted cleanup was running. Recovery now persists running
and clears the previous error before resuming cleanup. A blocked-runtime regression test observes
that intermediate journal state. The real interrupted-dispose test was repeated on the final code:
same UUID, revoked access, disposed receipt, no temporary data or instance metadata directory.

## Live Docker-loss fixture

A new disposable coordinator runs the exact source Core project from the registered worktree,
with its own data root, normal operator password login and port 38831. It installs Demo App
0.17.0 using the cached sandbox artifact recipe. Two independent offline instances use separate
synthetic data and users. The installed baseline is stopped with autostart disabled.

The host reports Docker Engine 29.8.2, Linux aarch64 in Docker Desktop and **16,787,152,896 bytes
(15.63 GiB)** of engine memory. This is the observed current budget, not the earlier 20 GiB
configuration. Existing unlimited workloads correctly prevent admission with
`resource_budget_unknown`; idle usage is not treated as a memory reservation.

The owner approved a temporary **8 GiB** primary Shell RAM ceiling and Docker Desktop stop/start,
and stopped the four conflicting Aspire containers. The test preserves the resource guard.
Instance A reserves 2 GiB app RAM, instance B 1 GiB, and each relay 256 MiB. Both retain one CPU
and 256 app PIDs. Each has 512 MiB synthetic-data and 1 GiB cache limits. Private browser work
runs before B starts and after B is disposed. This API/private-browser fault fixture has no agent
container, so its pending agent reservation is zero; the prior real Harness agent acceptance is
recorded separately. No user's media or other shared folder is mounted in this fixture.

## Observed recovery sequence

1. Both offline runtimes reach ready. Core's private browser logs in as the sandbox persona,
   navigates to Demo App, asserts the visible heading and captures a screenshot; the report is
   `passed`. A test-driver assertion initially expected `succeeded`; correcting that assertion
   required no product change. The existing start operation UUID is replayed, without duplicate
   allocation. Its replay timing is not reported as startup latency.
2. `docker desktop stop --timeout 120` makes the real daemon unavailable. Both instances become
   `unknown`, access is revoked, preview URLs disappear and the original resource journal and
   sentinel data remain. No fixture data is deleted on an uncertain observation.
3. Disposing B while Docker is absent returns **409 `sandbox_observation_unknown`**. Its journal
   records a failed dispose, access stays revoked, data remains and no disposed receipt exists.
   This is an observable incomplete Finish, not successful cleanup.
4. Docker Desktop starts again. The pre-existing Shell container resumes with its temporary
   ceiling. Retrying B's original dispose UUID records the operation as running again. With
   12,000 small owned cache files making cleanup observable, only the disposable coordinator is
   SIGKILLed after its persisted state is disposing/running and access is already revoked.
5. The CLI builds/starts the same source project and data root on port 38831. Its new process ID
   differs from the killed process. Replaying the **same dispose UUID** completes B's cleanup:
   disposed receipt, no temporary-data root and no instance-metadata directory.
6. Restarting A creates a new runtime generation while preserving its exact sentinel contents,
   data revision and test-user ID. The private browser repeats its authenticated Demo App
   assertions and returns `passed` again.
7. Final disposal removes A. Independent inventory inspection finds no containers, networks or
   volumes for either instance, including A's replacement generation. Recorded helper resources
   and preview listeners are absent; temporary users/data/caches/evidence and instance metadata
   are gone. Core retains only minimal replay receipts until the disposable coordinator is removed.

## Bounded memory observations

These are cgroup snapshots taken after browser verification, not simultaneous sampling of the
whole system. Peaks belong to each container's current lifetime; they must not be added together
as an aggregate peak. The two columns before/after refer to different runtime generations of A.

| Service | Before outage current / peak, MiB | After restart current / peak, MiB | RAM ceiling, MiB |
| --- | ---: | ---: | ---: |
| Demo backend | 58.45 / 87.62 | 81.96 / 94.38 | 1024 |
| Demo frontend | 83.84 / 114.68 | 96.17 / 103.89 | 1024 |
| Private relay | 27.60 / 33.83 | 68.98 / 69.04 | 256 |

All observed containers report `OOMKilled=false`; their `oom` and `oom_kill` counters are zero.
The browser, second instance and native Core/Harness are not fully sampled in this fault test.
Use the linked trusted-Core acceptance for the preceding workload measurements; this run does
not close D9's full simultaneous measurement requirement or provide a cold/warm startup benchmark.

## Verification and restoration

- Final macOS sandbox suite after the two recovery fixes:
  `dotnet test apps/core/tests/Haas.Hosty.Core.Tests/Haas.Hosty.Core.Tests.csproj --filter FullyQualifiedName~Sandbox`
  — **61 passed**.
- Final Linux-in-Docker CoreEnvironment/Sandbox/DockerRuntimeAdapter/GlobalMount/RuntimeMount
  suite — **264 passed**, with source mounted read-only and no Docker socket or network.
- Final Core native-AOT publication for macOS arm64 — passed. Each live source start also
  built the exact Core project into an isolated CLI-managed generation before launching it.
- The preceding full Core run had **3300 passed and 4 existing opt-in skips**. It preceded these
  two focused changes; affected suites were rerun afterwards. No product-code edits were needed
  during the live daemon test. Other component results are in the trusted-Core acceptance.
- Primary Shell is recreated through its normal Core lifecycle from the unchanged manifest.
  Docker inspection confirms the original **Memory=0, MemorySwap=0**, image content ID and
  restart policy, with Shell running. Its normal authenticated dashboard loads again. The
  primary Core remains the existing 0.133.0 release; it is not rebuilt or restarted.
- This run does not restart Aspire. The final read-only inventory sees four newly running Aspire
  containers after fixture cleanup; those concurrent workloads are left untouched. Cached baseline
  images are preserved; no global Docker prune is used.
- The disposable coordinator is stopped, its process and port are absent, and no Docker mount
  refers to its fixture root. The entire temporary root is then removed, including test accounts,
  credentials, replay receipts, builds, browser state, raw logs and evidence.
- The preceding checkpoint's full **87.75 GiB** media read matched all **118 SHA-256/size/mtime
  records** and **154 inventory entries**. This new Docker fault fixture never mounts or writes
  that media folder; it does not claim another full-library hash pass.

Retained artifacts are implementation, regression tests, sanitized Markdown reports and the
previous inspected UI images. Raw evidence JSON, logs and experimental patches remain outside Git
and the disposable fault-test copies are deleted.

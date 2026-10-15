# D9: Shared Docker Agent, Child Core And Git Acceptance

Date: 2026-10-15. Released baseline: `b996226e2c1574d6a34f0c0743147d54a3d98844`
(PR #598). Runtime correction and Demo exercise: `14fcf11db0a22862acd4d3f8a3af36392418c949`;
review correction: `4eb8e190e83713a3af852d0a04fa9513389d199c`, in
[test PR #599](https://github.com/alex-de-haas/docker-host/pull/599).
This records one composed macOS arm64 / Linux Docker workload. It does not close all
[Sandbox D9](../features/app-sandbox-runtimes/plan.md), authorize merge, or claim a released fix.

## Released Baseline And Fixture

- All ten post-merge workflows for PR #598 succeeded, including Core/CLI release, CI and the
  shared agent image. Published Core/CLI **0.135.0**, Harness/worker **0.53.0**, Demo **0.17.1**
  were checked before the run. Core's downloaded artifact attestation and workflow artifact bytes
  matched. Core SHA256: `493ffb51984d24d09afd8ace93c0d975ade7f5a4231064920af946e666cc91a1`.
- The worker used the actual published Linux arm64 image
  `ghcr.io/alex-de-haas/hosty-agent-worker:0.53.0`, repository digest
  `sha256:87cbf61946ed6b9c52164170b67300e44d3f7d84e724bf629ccb5cea55c3216f`, with the release
  revision label. Harness ran natively from the same release commit using its Core-managed
  local runtime and built web UI; this is not a test of a separately downloaded Harness bundle.
- An installed baseline Demo ran beside the child, pinned to
  `ghcr.io/alex-de-haas/demo-app@sha256:03712348e989bfdc33bf6bdc9a6761c5a05f97c5e3fdb3fb7577412b523014c0`.
  Its image revision matched the baseline. Demo publishes `latest`, not a `0.17.1` image tag;
  the immutable digest, rather than an invented version tag, identified this installation.
- The disposable parent had its own data root, real password-bootstrapped administrator,
  selected-account Codex authorization import and temporary Core GitHub connection. GitHub
  credentials stayed with Core; the agent used publication tools. The original host authorization
  and primary Core were not replaced or upgraded.
- Docker reported **16,787,152,896 bytes** of VM memory in this run. The earlier report's 20 GiB
  setting is not the present measurement. No VM resize or changes to unrelated app limits occurred.
- One shared worker had **4 GiB / 2 CPU / 512 PIDs**. The trusted child budget was **6 GiB /
  3 CPU / 768 PIDs**, with **4 GiB / 2 CPU / 512 PIDs** for its two Demo services together
  (2 GiB / 1 CPU / 256 PIDs each). Its 10 GiB disk budget is monitored, not a hard filesystem quota.
  Native Core, Harness and browser RSS is reported separately, not attributed to those container limits.

## Actual Agent And Browser Journey

A real Codex conversation through Harness's supported Docker mode prepared a Core-owned worktree,
read repository instructions, updated Demo's overview text, bumped Demo 0.17.1 to 0.17.2 and updated
its current feature document. It created child Core `98664e0edf9941fead6eb339fc7097b3`, configured
normal child password authentication and synthetic greeting data, and installed/started Demo's
separate backend/frontend containers through child API transport.

The source mount was read-only in both application services; root/nested dependencies, generated
framework metadata and build outputs used separate child-owned mounts. The worker retained writable
source but read-only repository Git metadata, without the host home or Docker socket. It used Core
for commit/push/PR operations. Child data was a separate path; installed-app data was not mounted.

The coordinator used a dedicated Playwright browser outside the worker. Normal child login showed
only the child test user, the synthetic greeting, directory readiness and Demo 0.17.2. The agent's
follow-up copy edit appeared on the held page in **970.409 ms** after its recorded write. Page identity
was retained, with no navigation/reload and no consumed callback parameters returning. People-page
navigation preserved the same child user and ready directory. This is a real browser result, not
an autonomous browser tool owned by the model. Embedded preview was covered in the linked earlier
fresh-login report and was not repeated in this run.

Harness displayed the running child and its preview link. Its Source workspaces panel displayed
PR #599, the current published head and changing CI results across recovery. The coordinator did not
install Workspaces in this disposable parent, so its separate viewer link correctly remained
unavailable. An ungranted optional offline-sandbox inventory permission produced a 403 warning;
child-Core inventory/preview and publication worked through their separate reviewed permissions.
This is not evidence of an error-free console or a fresh Workspaces-app acceptance.

## Runtime Defect And Review Correction

The released child Core's private HOME hid Docker Desktop's user-installed Buildx plugin. Building
Demo from source fell back to the legacy builder, which rejected `COPY --chmod`. The scoped Core
0.135.1 candidate imports only existing CLI-plugin directory metadata reported by Docker into the
child's own Docker configuration. It neither imports the parent's Docker configuration nor copies
its registry credentials. The corrected source Core successfully built the development image and
ran the browser/HMR/recovery journey.

Codex's GitHub review then identified that ordinary atomic text replacement could broaden a
credential-bearing child config from 0600 to 0644 under umask 022. The same Harness agent changed
this to Core's existing owner-only atomic JSON writer, registered its JSON object for Native AOT,
and added first-creation/replacement permissions regressions. It built and tested the correction,
committed/pushed through Core, then resolved only the addressed review thread. Independent GitHub
inspection confirmed that thread resolved. No parent credentials were used in the child test.
The live preview predates this final permissions-only correction; its Unix behavior was verified
by the new tests, rather than claimed as a second live deployment.

Two setup errors were fixture-specific: a manually downloaded executable needed the normal
`hosty-core` filename for current-mode child copying, and a CLI restart needed the fixture's
explicit port. Both were corrected without changing product defaults or using the primary Core.

## Recovery And Timings

The agent created a controlled detached writer inside its worker. The coordinator SIGKILLed only
the disposable native Harness process. The writer initially continued, proving the fault was real;
Demo still returned HTTP 200. Core restarted Harness in **1.549 s**. Startup stopped the old worker;
a fresh authenticated runtime-stop acknowledgement removed it and released the actual Core leases.
The writer stopped, the provider conversation identity survived and no uncertain model message was
automatically replayed. The same conversation resumed with source intact.

The reverse check stopped only child Demo while the agent still read its worktree. The agent then
restarted Demo from the locked development image. The start response arrived in **6.273 s**;
both HTTP services were independently observed healthy at **16.582 s**. These are different
milestones. Child user and synthetic greeting persisted. Images were cached; initial image/build
failures and operator approval make this run unsuitable for a clean cold-start benchmark.

The Harness crash was exercised here. Actual Docker-daemon loss and interrupted Finish with
same-ID recovery remain evidence from the
[offline daemon acceptance](2026-10-15-offline-sandbox-daemon-acceptance.md), not faults repeated here.

## Memory

**459 samples**, nominal five-second interval plus collection latency, covered **17:06:58–17:46:48
UTC** (2,389.7 seconds), including setup, agent/Core/Demo tests/builds, HMR, browser checks, recovery,
review correction and Finish. No sampling errors were recorded. The monitor was adjusted after the
fixture switched from released Core to a managed source generation; early source-Core preparation
is not a complete native-process measurement. Docker VM/engine memory and unrelated applications
are excluded. Cgroup working set means charged memory minus inactive file pages.

| Workload | Maximum sampled charged memory | Maximum sampled working set | Cgroup lifetime peak |
| --- | ---: | ---: | ---: |
| Shared agent and build/test descendants | 3,049.4 MiB | 2,809.9 MiB | 3,126.1 MiB |
| Child Demo frontend + backend, same samples | 2,425.9 MiB | 1,166.8 MiB | Frontend 1,644.4 MiB; backend 999.2 MiB, separate lifetimes |
| Installed baseline Demo, two services | 129.9 MiB | 129.8 MiB | Not combined across service lifetimes |

The largest simultaneous agent-plus-child sample was **5,473.4 MiB charged / 3,942.2 MiB working
set**, during agent Core/Demo validation. At that same sample native parent+child Core RSS was
326.8 MiB, Harness/runner 105.4 MiB and the dedicated Playwright/Chromium tree 1,099.0 MiB.
Their separate sampled RSS maxima were **552.4 / 166.8 / 1,378.0 MiB** respectively. Do not sum
independent lifetime maxima as a simultaneous result, or add Docker VM memory again. RSS also
counts shared pages, so this is not an exact physical-memory total. All observed container OOM-kill
counters were zero. Five-second sampling can miss brief peaks; these are bounded workload numbers,
not a general capacity guarantee or 30-run startup distribution.

## Publication, CI And Review

The real agent used Core `pr_commit` and `pr_publish` to create ready
[PR #599](https://github.com/alex-de-haas/docker-host/pull/599), then repeated that path for the
review correction. Conventional commits include the Codex co-author trailer. No raw Git/gh
publication from the worker, force push, merge or PR closure occurred. Temporary preview recipes
were removed before the first commit; raw evidence, credentials and logs are not in the PR.

- Initial candidate: exact Core build and **88 CoreEnvironment tests** passed locally and in the
  actual worker; Demo's **6 existing tests**, lint and webpack production build passed.
- Review correction: exact Core build plus **94 selected CoreEnvironment/JsonStorage tests** passed
  under Linux worker umask 022. Tests cover owner-only creation/replacement and child JSON retention.
- `node scripts/docs-index.mjs --check`, `node scripts/check-versions.mjs`, `git diff --check`: passed.
- [Initial PR CI](https://github.com/alex-de-haas/docker-host/actions/runs/38778432163): successful,
  including full Core tests and Linux Native AOT publication; irrelevant jobs skipped by path rules.
- [Review-fix CI](https://github.com/alex-de-haas/docker-host/actions/runs/38779624686): successful,
  including the full Core suite, Windows process-control suite and Linux Native AOT publication.
- Claude's automatic initial review reported no issues. Codex's one finding was fixed and resolved.
  Copilot could not review because the requesting account's quota was exhausted; this is not a pass.
  Live PR checks/review identify later documentation commits separately from these tested baselines.

Version outcome: Core/CLI **0.135.0 → 0.135.1**, Demo **0.17.1 → 0.17.2**, Harness unchanged.
The fix is a candidate in an open test PR, not a published release.

## Finish And Independent Cleanup

The same real agent persisted a Finish UUID/revision, called `environment_finish`, observed
`finished` revision 11 and replayed the identical request. The replay returned the same finished
revision. Request-to-terminal handling took **19.375 s**, including orchestration overhead.
It removed its exported child-password file and confirmed no source consumer remained.

Independent checks after Finish verified:

- Both recorded containers, **six cache volumes** and the one child network were absent, by both
  ownership-label inventory and their recorded IDs/names; stopped containers were included.
- Child process, data root, users/credentials, app data/cache/log folders and generated Docker
  configuration were gone. Core port 29397 and app ports 21440/26713 were closed; the stale browser
  preview became unavailable and disappeared from Harness's running-child list.
- All **1,920 tracked source files** retained their hashes and the clean head `4eb8e190`; Finish
  did not remove the worktree or published PR. The separate exported report survives instance cleanup.
- All **43 other container identities/start times/states** stayed unchanged during Finish, including
  the installed baseline Demo. Its only changed data files were the two normal `.demo-app-health`
  timestamp probes; no business records were changed by the child. The operator's media folder was
  not mounted or used in this Demo test.

Shared downloaded images/build cache are outside per-instance Finish ownership. Minimal operation
receipts and the exported Markdown report are intentional retained records, not leftover running
sandboxes. The disposable coordinator remains only long enough to publish the final report; its
teardown is distinct from the child Finish acceptance above.

## Remaining D9 Scope

This run closes the previously missing composed Git/PR/CI/review checkpoint and captures simultaneous
Core/Harness/agent/app/browser memory for one selected journey. D9 stays open for reconciliation of
the entire inherited negative/race matrix against the supported profiles, complete cold preparation
measurements and any additional host/recipe guarantees. Native Linux hosts, native Windows Docker
and the amd64 worker were not exercised locally. Linux containers on this Mac are not those hosts.
Both-provider acceptance, embedded login/HMR, dedicated Media/Transcode dependencies and actual
Docker-loss recovery retain their separate dated evidence; they were not all repeated by this run.

See [shared-worker acceptance](2026-10-15-shared-docker-agent-acceptance.md),
[fresh login/HMR](2026-10-15-sandbox-login-hmr-acceptance.md),
[trusted child Core](2026-10-15-trusted-core-consent-acceptance.md) and
[offline daemon recovery](2026-10-15-offline-sandbox-daemon-acceptance.md).

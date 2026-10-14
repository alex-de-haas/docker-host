# Harness And Real-App Container Experiment — 2026-10-13

Coordinator source baseline: `f146d0ddd810eeaaa1d9cc922bf6c000a6d1d3e2`, plus the experimental launch/measurement scripts. Core prepared Demo App source from the declared remote `main` at `dedf9f37f5fe9d0a38f79c9cc5f594cbb12ae859`; these are distinct baselines. Existing planning edits in the operator checkout were not copied into the application workspace.

## Result

A real Harness session drove containerized Codex through Core workspace discovery/preparation, a source change in Demo App, dependency installation, regression tests, lint and a production build. An independent driver repeated all 21 tests and the production build, then ran the webpack build required by Demo App's feature documentation. All verification commands passed. Core observed the three uncommitted changed files and released all activity leases.

The largest observed `docker stats` working-set sample was **2.14 GiB** during the first Turbopack build. The kernel cgroup counter recorded **2.36 GiB** over the container's lifetime. Idle memory was about **486 MiB before work** and **599–609 MiB after work**. No OOM or memory-limit event occurred with the tested **4 GiB / 2 CPU** limits.

This validates the bounded integration experiment. It does not ship a production container backend or validate a running application sandbox, browser session, hot reload or Docker image build. [Containment D9 and D11-D13](../features/assistant-runtime-containment/plan.md) retain that work.

## Evidence And Environment

This report summarizes configuration, 993 container samples, 479 host RSS samples, Core workspace observations, verification and cleanup. Raw measurements, logs and the experimental patch are local run outputs, not repository assets.

| Component | Value |
| --- | --- |
| Host | Apple M4 Pro, 14 CPUs, 48 GiB physical RAM |
| Docker | Existing local Docker Desktop engine; VM capacity about 7.65 GiB |
| Core / Harness / Demo App | 0.131.0 / 0.50.0 / 0.16.0 |
| Agent | Codex 0.160.0, `gpt-6.1-sol`, existing ChatGPT login |
| Container runtime | Node 22.23.3, existing image from the [first experiment](2026-10-13-agent-container-experiment.md) |
| Application tooling | Next.js 16.3.8, Vitest 5.0.3 |
| Worker limits | 4 GiB RAM, no additional swap allowance, 2 CPUs, 512 PIDs |
| Test root | `/private/tmp/hosty-harness-container-20261013` |

The application source was real Demo App code, not the small synthetic cart fixture from the first experiment. The worker reused that experiment's Node 22 image. Demo App's production Dockerfile uses Node 24; building that image and validating its runtime were outside this run.

## Harness, Identity And Workspace Path

An isolated Core instance used a separate data root, an empty automatic-install catalog and loopback port 37071. It ran the copied installed Core release. Only an experimental Harness installation was started; Demo App was installed as the source target and remained stopped. The existing host Core was not restarted or reconfigured.

Authentication used the ordinary first-administrator setup-token endpoint, a generated password, password login, CSRF, PKCE app authorization and Harness's app-code exchange. No seeded administrator, user-selector, direct session insertion or CLI diagnostic identity token was used. These were real HTTP authentication flows; this report does not claim visual browser/Shell QA.

The session was created through Harness's HTTP API with Demo App attached and autonomous mode explicitly selected for the bounded task. Harness prepared a Core-owned worktree. The agent subsequently called the real `hosty-workspaces` MCP `list`, `prepare` and `status` tools. Core associated the workspace with this Harness installation, administrator and conversation, and held its activity lease during the agent's task. The verification driver acquired and released separate explicit Core leases for its builds. The final lease list was empty.

The experiment used the existing `HOSTY_HARNESS_CODEX_COMMAND` override. The [launcher](../../scripts/experiments/harness-container/launch.mjs) started the unchanged Harness source; the [command wrapper](../../scripts/experiments/harness-container/codex-wrapper.py) transported its Codex app-server through `docker exec`. Provider availability probes also ran inside Docker. No production Harness or Core source was patched.

Two integration adaptations were necessary:

1. **Paths and Git metadata.** Host paths returned by Core were mounted at the same absolute paths inside the worker. The session cache lived within dedicated agent data. The worktree's specific Git common directory was additionally mounted read-only, so `.git` links remained valid without exposing the rest of Core's data root. This is a prototype path contract, not a portable production mapping design.
2. **Loopback workspace MCP.** Harness's internal workspace endpoint rejects non-loopback connections. A host-side experimental bridge forwarded only the selected session's authenticated MCP route to Harness over loopback. The wrapper changed the workspace MCP URL to `host.docker.internal:37072`. The bridge exposed only `list`, `prepare`, `status` and `diff`, restricted the app/workspace, and passed the existing session key. A wrong key and a publication command both received HTTP 403. Core service/admin credentials never entered the worker.

The bridge is experiment-only: it binds a host port and is protected by the session key. It is not a general HTTP proxy, a network firewall, or production transport acceptance. Commit/push/PR capabilities were intentionally excluded from this test.

## Host Filesystem Boundary

The worker ran as UID/GID 1000 with a read-only image filesystem, all capabilities dropped, `no-new-privileges`, an init process and a 256 MiB temporary filesystem. It had three host binds:

- Dedicated agent data, including provider state and the Harness session cache, read/write.
- The one Core-owned application worktree, read/write.
- Only that repository's Git common directory, read-only.

The original operator checkout, test coordinator files, an outside canary and the Docker socket were inaccessible from the worker. The canary remained unchanged. There were no published worker ports or host/Core/app data-root mounts. Docker bridge networking remained available for provider/npm traffic; network isolation was not asserted. Provider login state was readable within its own agent data boundary, so this experiment does not claim credential separation from the code the agent executes.

## Application Change And Verification

The agent changed Demo App's refresh configuration to accept positive finite integers, preserve surrounding whitespace around valid numbers and default invalid values to 30 seconds. It added 17 cases through `getDemoConfig`, restored environment overrides after each test, and updated the feature documentation.

Core reported these three uncommitted paths:

- `apps/demo-app/src/lib/demo-config.ts`
- `apps/demo-app/test/demo-config.test.ts`
- `docs/features/demo-app/feature.md`

The agent added the regression tests before the source fix. Five cases failed against the original behavior, then all 21 application tests passed after the fix. Neither dependency versions nor the lockfile changed. The patch remains in the retained experimental workspace; it was not merged into the operator checkout or released. No commits, pushes, PRs or version bumps were made.

| Verification | Result |
| --- | --- |
| `npm ci --workspace @haas/hosty-demo-app --workspace @hosty-sdk/app --include=dev --no-audit --no-fund` | Exit 0 |
| New regression tests before the fix | Exit 1, five expected failures |
| `npm test --workspace @haas/hosty-demo-app -- --maxWorkers=2` | Agent and independent driver: exit 0, 21 tests |
| `npm run lint --workspace @haas/hosty-demo-app` | Exit 0 |
| `npm run build --workspace @haas/hosty-demo-app` | Agent and independent driver: exit 0, production Turbopack build |
| `npm run build --workspace @haas/hosty-demo-app -- --webpack` | Independent driver: exit 0, required webpack build |
| Core workspace status and local diff | Correct source change observed, no commits, no remaining leases |
| Workspace docs index, version consistency and whitespace checks | Passed |

The main agent task took **128.83 seconds**, including tool/model waits, dependency installation, red/green testing, editing, lint and build. Independent tests took **1.50 seconds**; the subsequent cached Turbopack build took **7.91 seconds**; webpack took **20.63 seconds**. These are single observations, not latency distributions. The builds ran sequentially with different cache state, so the webpack/Turbopack values are not a controlled compiler comparison.

## Memory Under Load

| Phase | Observed container memory |
| --- | ---: |
| Idle before the task, 30-second window | 485.5 MiB median |
| Installing dependencies | 924.5 MiB sampled maximum |
| Application tests | 832.2 MiB sampled maximum; independent repeat 848.3 MiB |
| Lint | 983.4 MiB sampled maximum |
| First production build, Turbopack | **2.14 GiB sampled maximum** |
| Independent cached Turbopack build | 1.81 GiB sampled maximum |
| Required webpack build | 1.57 GiB sampled maximum |
| Idle after the task | 599.2 MiB median |
| Idle after all verification | 609.0 MiB median |
| Cgroup lifetime peak, including its cache accounting | **2.36 GiB** |

`docker stats` sampled approximately every half second. Agent-written stage markers were copied to the sampler by the driver every second; stage assignment can lag at transitions, and sampling can miss brief peaks. The 2.36 GiB cgroup counter spans the worker's entire lifetime with no restart and includes kernel/cache accounting. The same peak remained after independent and webpack builds. All `memory.events` OOM/max counters were zero.

Docker CLI working-set display and cgroup memory accounting differ; see [Docker stats](https://docs.docker.com/reference/cli/docker/container/stats/). The values include the agent and its npm/test/build descendants. They do not isolate the compiler's incremental RSS and exclude Docker VM/engine overhead.

Harness, the experiment launcher/bridge and their host descendants were sampled separately with `ps`: idle median about **274 MiB**, and workload medians about **266–269 MiB**, with brief samples up to **303.5 MiB**. These are summed process RSS values, can double-count shared pages, and exclude Core and Docker's VM. They must not be presented as an exact physical-memory increment or simply added to the container peak as a precise host total.

CPU was nearly idle between tasks and reached roughly the two-CPU quota during compilation. Both build logs reported **13 page-data workers despite the 2-CPU quota**. Worker-count tuning is therefore a concrete variable for the next resource comparison, already within Containment D9. This test did not change Next's worker settings.

## Interpretation And Remaining Work

The half-GiB agent estimate from the first experiment remains representative of the initial idle process. It is insufficient as a whole-workspace budget once that process launches a real build. The measured load exceeded 2 GiB, so the original 2 GiB cap has no demonstrated margin for this workload; this run did not deliberately repeat it at that lower cap to force an OOM.

Keep **4 GiB per actively building worker** as the next experimental ceiling, not a general minimum or production guarantee. Concurrent builds need a separate budget even if agent processes share one container. The current evidence does not choose shared versus per-session execution, prove a long-term memory plateau, or account for Playwright/browser/runtime-app costs. Those comparisons remain in [Containment D9](../features/assistant-runtime-containment/plan.md); production transport/mount/lifecycle work stays under D11-D13 and application sandbox work under [App Sandbox Runtimes](../features/app-sandbox-runtimes/plan.md).

## Reproduction And Cleanup

The scripts in [scripts/experiments/harness-container](../../scripts/experiments/harness-container/launch.mjs) are a dated experimental fixture. `api.py` deliberately targets the isolated root and port recorded above; changing the root requires updating that fixture configuration. They are not a supported runtime backend or a one-command installer.

To reproduce with fresh test data:

1. Build the image using the [first experiment's Dockerfile](../../scripts/experiments/agent-container/Dockerfile). Prepare a new isolated Core data root, copy the installed Core binary, and supply an empty distribution catalog. Start it in a managed foreground session on an unused loopback port.
2. Copy the Harness manifest into an experiment-only directory as `manifest.json`, remove its source declaration/setup commands, and point its command to `launch.mjs <experiment-root> <repository>`. Install/start it through this Core. Install the real Demo App manifest as the stopped source target.
3. Use normal administrator setup/password login and CSRF/PKCE app-code exchange. Create a host-login Codex connection referring only to a temporary credential copy, create a Harness session with Demo App attached, choose autonomous mode for this bounded task, and prepare its workspace through Harness. Retain request IDs for uncertain operations.
4. Save the returned worktree ID/path, Git common directory and worker name in `coordinator/runtime.json`; save the Harness origin/session in `coordinator/session.json`. The command override points to `codex-wrapper.py <experiment-root>`. Mount only agent data, worktree and read-only Git metadata at matching absolute paths. Use the limits and hardening flags recorded in the evidence. Keep Core credentials outside those mounts.
5. Run `measure.py`, send the read-only connectivity turn, then run `workload.py`. After it finishes, run `verify.py`. Stop the first sampler with `evidence/stop-sampling`; run `measure.py --webpack` and `verify.py --webpack-only`, then stop that sampler with `evidence/stop-sampling-webpack`. Never overwrite existing evidence or reuse a pending verification lease without recovery.
6. Inspect results and Core diffs, confirm every lease is released and every process has stopped, then stop the test Harness/Core through their own lifecycle. Remove only the labelled experiment worker and temporary credential/cookie/bridge-key files. Preserve the dirty Core workspace for review; do not force its cleanup.

For this run, the worker and temporary ChatGPT login copy, HTTP cookie jar and MCP bridge key were removed. The isolated Harness/Core were stopped. Core emitted a late process-group reclaim warning; an independent PID/listener check confirmed both launcher/Harness processes were absent and ports 37071, 37072 and 29332 were closed. The dirty workspace, isolated Core state, image and evidence were retained.

The original Core still had PID **72204**, the same start identity from 2026-10-12, **seven running apps** and no app errors after cleanup. No live deployment was altered.

## Repository Verification

The real application test/lint/build checks above passed. The experimental JavaScript/Python syntax checks, documentation index validation, version consistency and repository whitespace checks passed. Full Core/Harness product builds and unit suites were not rerun because their production source was unchanged; their actual integration was exercised through the authenticated experimental instance. No commits or PRs were created.

# Separate Agent And Application Containers — 2026-10-13

Coordinator baseline: `f146d0ddd810eeaaa1d9cc922bf6c000a6d1d3e2`, with existing uncommitted planning/experiment files. Core fetched the declared application source at `31b95f6a410a23d43be1186ff900eb919215da00`. These are different baselines; neither the earlier synthetic fixture nor the previous Demo App bug-fix workspace was reused.

## Result

A real Harness session changed Demo App source from one Docker container while the application ran in a separate Core-managed Docker development container. The open browser updated without manual navigation/reload, and displayed the synthetic data file created by the agent. Ordinary Core password login and the app's existing authorization flow produced an active app session and a working user directory. Four existing tests and lint passed inside the agent worker.

After correcting development-recipe issues, a second Harness edit also hot-reloaded. Independent lifecycle checks passed: stopping/restarting the app left the agent container running and able to read its workspace; stopping the agent left the app serving HTTP. Synthetic data survived restart. The corrected app restart reached HTTP readiness in **9.53 seconds**, including dependency setup.

This is a successful bounded experiment, not delivery of concurrent sandbox instances in the operator's Core. A disposable Core installation supplied an isolated installed-app data root, normal app identity and source override. There is still no shipped workspace-instance registry, sandbox credential audience or instance-specific authorization contract.

[Sanitized evidence](../features/app-sandbox-runtimes/2026-10-13-two-container-evidence.json) contains both measurement intervals, browser observations/logs, mounts, process identities, cgroup counters, workspace patch, commands/results, lifecycle checks, failures and cleanup. The [preview screenshot](../features/app-sandbox-runtimes/2026-10-13-two-container-preview.jpg) shows the final visible change. Experimental recipes are under [scripts/experiments/two-container](../../scripts/experiments/two-container/prepare-runtime.py).

## Configuration And Separation

- Apple M4 Pro, Docker Desktop Linux ARM64; same host/engine as the [first](2026-10-13-agent-container-experiment.md) and [Harness](2026-10-13-harness-container-experiment.md) experiments. The Docker VM has about 7.65 GiB available; host physical RAM is 48 GiB.
- Core 0.131.0 and unchanged Harness 0.50.0 source. Codex 0.160.0, `gpt-6.1-sol`, existing ChatGPT authentication copied temporarily into dedicated worker data. No API key was created.
- Demo App 0.16.0, Next.js 16.3.8, Node 22.23.3. This reuses the experimental agent base image; the app image contains the Codex binary but starts no agent. Demo App's production Dockerfile uses Node 24, which was not tested here.
- Test root: `/private/tmp/hosty-two-container-20261013`. Core listens on 37071; Harness on 32677; the narrow workspace bridge uses 37072. The final app port is 25292. All are test resources.
- Worker `hosty-two-container-agent-20261013`: four binds, for dedicated agent data, one Core-owned worktree, that repository's read-only Git metadata, and this app's synthetic data at `/sandbox-data`. It has no Docker socket, original checkout, coordinator directory or whole Core root. UID 1000, read-only root filesystem, dropped capabilities, no-new-privileges, init and temporary filesystem match the earlier worker approach.
- App `hosty-2dfe72fb1da3-com-haas-demo-app-backend`: worktree read-only at `/workspace`, its own data/cache, and named Docker volumes for root `node_modules`, nested Demo App `node_modules`, and `.next-experiment`. No provider home, Git common store, Docker socket or other app data is mounted. The entrypoint initializes ownership on those specific caches/data, then drops to UID 1000 with no-new-privileges before dependency installation and Next execution.
- Both measured containers use **4 GiB RAM, 2 CPUs and 512 PIDs**, without additional swap allowance. The worker has limits from creation. The existing Core profile does not declare these limits; the coordinator applied them to each app container shortly after creation. This is not proof of limits from the first instruction of app startup. App image root filesystem/capability defaults also differ from the hardened agent configuration; do not infer the worker's complete hardening contract for the app.
- Harness/trusted coordination remains on the host and uses the previous experimental command wrapper/allowlisted session MCP bridge. Core service credentials stay outside the agent worker. The app receives its normal scoped service credential for the disposable Core. Network access is not confined by this fixture.

For this one-container app test, the experiment manifest runs one Next process serving both existing UI/API endpoint declarations. The normal Demo App manifest has separate backend/frontend services. This proves the development loop for the combined test profile, not acceptance of its full production service graph.

## Workspace, Data And Browser Evidence

Harness session `5522d1f4-e1d4-411e-b9ba-3a3490b6f358` owns worktree `590433e73717292f848a7d4fbc4c736613ec9c6570215951679549d08db68f43`. The Core workspace API supplied preparation/status and held normal agent activity leases. The coordinator held a separate explicit lease while app processes consumed the source. No commit, push or PR was created; the source and experimental recipe changes remain uncommitted.

The agent changed only the requested overview text, first to `Sandbox hot reload verified`, then to `Sandbox hot reload verified — isolated caches` for the post-fix repeat. It wrote `/sandbox-data/agent-seed.json` with two synthetic task records. The coordinator's `experiment-fixture.json` was already present. Both appeared in the real application's Storage probes, and host/app reads of the seed matched exactly. This is file-fixture visibility, not a database seeding/migration test.

The coordinator separately changed the disposable manifest, TypeScript include paths and an untracked Docker recipe, and prepared ignored `next-env.d.ts`. Those are fixture adaptations, not agent-authored product improvements. Dependency manifests and the lockfile were preserved.

The in-app browser used normal password login to the disposable Core, followed the existing app authorization flow, and displayed **Session Active**, **Directory Ready**, the test administrator and `/app/data` with the two fixture files. The agent had no browser profile/Core administrator cookie. The actual UI was inspected through browser automation and screenshots; this does not implement an agent-owned Playwright runner or validate Shell embedding, multiple viewers or instance-scoped grants.

| Observation | Result |
| --- | --- |
| Initial Harness source edit → browser Fast Refresh | Browser reported **566 ms**; first completion log about **0.83 s** after the source file mtime |
| Post-cache-fix Harness edit → browser Fast Refresh | Browser reported **38 ms**; first completion log about **0.20 s** after source mtime |
| Visible UI | Both changes appeared in the already open page without manual reload during each edit |
| App process during initial HMR | Same container ID and start identity before/after; no container restart |
| Corrected app restart | **9.53 s** to HTTP 200, including setup; seed hash preserved |

These are single observations with different compilation/auth/cache state, not a p95 or a controlled performance comparison. The file-mtime/log intervals cross host/browser clocks and are approximate; the later DOM inspection confirms visibility but does not precisely timestamp first paint. Fast Refresh emitted duplicate completion messages; the first matching completion is used. The initial Core-driven startup needed recipe corrections and has no valid cold-start performance claim.

## Memory And CPU

The main interval has **1,208 container samples** and the corrected-recipe interval **724**, at approximately half-second intervals per container. `docker stats` tracks a resolved container lifetime: samples for a replaced container became unavailable during setup. That earlier interval is excluded rather than interpreted as zero memory. Each accepted interval starts a fresh sampler against the current container IDs.

| Main workload | Agent | App dev server |
| --- | ---: | ---: |
| Idle before edit, median | 476.4 MiB | 771.6 MiB |
| Source edit / HMR, sampled maximum | 755.7 MiB | 876.2 MiB |
| Agent dependency installation, sampled maximum | 927.2 MiB | 845.3 MiB |
| Agent tests, sampled maximum | 801.7 MiB | 847.6 MiB |
| Agent lint, sampled maximum | 850.4 MiB | 848.8 MiB |
| Idle after work, median | 560.7 MiB | 844.4 MiB |

After the corrected app recipe started and a second lightweight agent edit completed, idle medians were **593.5 MiB for the agent** and **593.6 MiB for the app**. The corrected app's startup sampled maximum was **900.2 MiB**. Different lifetimes, browser/auth activity, dependency setup and warmed caches mean the lower later app idle is not evidence of a cache-volume optimization or a settled long-run plateau.

Kernel `memory.peak` counters were **1.05 GiB for the agent** and **1.75 GiB for the initial successful app lifetime**; the corrected app lifetime reached **1.63 GiB**. These include cache/kernel accounting that differs from Docker CLI's working-set display. All captured `memory.events` max/OOM counters were zero. The peaks belong to different lifetimes/instants and must not be added as a measured simultaneous host peak.

The agent reached roughly 1.67 CPUs in a sampled lint interval; the corrected app setup reached roughly 1.90 CPUs. The browser, host Harness/bridge, Core and Docker VM/engine are outside these per-container numbers. This run did not measure their aggregate physical-memory cost. Brief peaks may be missed, and test stages have few samples. Neither these observations nor the earlier **2.36 GiB production-build** peak establishes a universal minimum memory limit. Keep build, dev server and browser workloads distinct.

## Failures Found And Fixture Corrections

1. The update planner tried to resolve a local-only environment image through the registry. The fixture switched to the supported source `build` recipe using that local image as its base. No registry publication was required. The authenticated browser update endpoint required its review flow; the already-authorized operator fixture applied the exact reviewed digest through local CLI control.
2. The Next launch script used fallback port 3100, while the Docker profile published 3000. The fixture explicitly sets `PORT=3000`. Core reported a running lifecycle result after its 30-second readiness budget despite the port mismatch, so actual HTTP/browser readiness is required evidence.
3. A new custom Next output directory prompted writes to read-only `tsconfig.json` and generated `next-env.d.ts`. The coordinator prepared the matching type paths before startup; app source remained read-only.
4. Agent tests created `apps/demo-app/node_modules/.vite` in the worktree. On the first app restart, `npm ci` tried to remove that nested directory through its read-only source mount and failed with EROFS. The corrected recipe adds a separate nested dependency volume and initializes its ownership, then bumps the reviewed environment recipe revision. Restart and HMR were repeated successfully afterward.
5. The first browser HMR observation showed already-consumed authorization callback query parameters resurfacing in the URL. The retained evidence redacts them. A fresh page using the established app session worked, and the repeated edit retained its clean URL. Login → HMR → URL cleanup remains a specific acceptance case under Sandbox D10; this experiment does not claim that regression is fixed.
6. Stopping through Core retained an exited app container. Cleanup detected it, verified exact Core/app labels and PID 0, and removed it without force. Data and cache volumes were retained. An exited container is not a running process, but its ownership and retention need explicit handling.

## Reproduction And Verification

The scripts are a dated fixture, not a general installer. `api.py`, the reused bridge, and lifecycle probe contain the recorded root/ports. Choose a fresh root and update those fixture settings together before a new run; never overwrite existing evidence or a pending lease.

1. Reuse/build the [agent image](../../scripts/experiments/agent-container/Dockerfile), then build this experiment's [development image](../../scripts/experiments/two-container/Dockerfile). Prepare a fresh isolated Core root with the installed Core binary and an empty distribution catalog. Start it in a managed foreground session on an unused local port.
2. Install an experiment-only Harness launcher manifest, as in the [previous report](2026-10-13-harness-container-experiment.md), with the new root. Install the real Demo App as a stopped source target. Temporarily copy the existing Codex login into agent data. `setup.py` uses normal Core setup/password login, PKCE app authorization, a host-login connection, a Harness session and a Core worktree.
3. `prepare-runtime.py` acquires a recorded runtime lease, prepares the corrected manifest/type metadata/seed and starts only the agent worker. Bind the disposable Demo App to the returned worktree using `apps source-override`. Review/apply its exact manifest digest through the isolated local CLI, then start the app through Core. Apply the experiment limits, confirm actual HTTP readiness, and use the fresh `apps open` origin.
4. Start `measure.py <interval>` only after resolving current container IDs. Use `turn.py <name>` with the retained operator prompts to initialize the worker and run the visible edit/task. Record browser state before/after without manually reloading during the HMR check. Capture source mtimes and stage markers separately; set explicit idle windows.
5. `verify-boundaries.py` checks the real mounts, denied paths, source read-only behavior, matching synthetic seed and Core status. `lifecycle.py` tests independent stop/restart and stops the worker. `cleanup.py` stops only owned resources, releases the recorded lease and removes temporary credential copies. `collect.py` exports sanitized evidence and the preview image after cleanup. Scripts refuse or require inspection of preexisting fixture/lease/output files rather than providing blind replay recovery.

The Harness agent executed:

- `npm ci --workspace @haas/hosty-demo-app --workspace @hosty-sdk/app --include=dev --no-audit --no-fund`: exit 0, 437 packages.
- `npm test --workspace @haas/hosty-demo-app -- --maxWorkers=2`: exit 0, **4 tests / 2 files**. The earlier experiment's additional 17 regression cases were in another uncommitted workspace and are not part of this source baseline.
- `npm run lint --workspace @haas/hosty-demo-app`: exit 0.

Next's development compilation and two real browser updates passed. No production app build was run in this experiment; that was the previous workload. The final repeat changed only a displayed string, so the suite was not repeated after that second text edit. Core/Harness production code was unchanged; their full builds/unit suites were not rerun. Experimental Python/shell syntax, documentation index, version consistency and whitespace checks are the repository validation for this fixture.

## Cleanup And Remaining Acceptance

The two containers were stopped and removed, the isolated Core/Harness processes were absent, all four test ports were closed, and the Core workspace had no activity leases. Temporary provider login, cookie jar, bridge key and test-password copy were removed. The original Core remained PID **72204**, release mode, with the same 2026-10-12 process-start identity. The dirty test worktree, synthetic app data, isolated Core state, images, cache volumes and evidence remain available for review. No product version changed, and no commit or PR was created.

[Sandbox D2-D6/D8/D10](../features/app-sandbox-runtimes/plan.md) retain instance identity/permissions, generalized recipe/cache handling, lifecycle, source-aware UI, agent-owned browser testing and preview/auth acceptance. [Containment D9/D11-D13](../features/assistant-runtime-containment/plan.md) retain representative budgets, supported transport/mount policy, recovery and product backend delivery. Multiple application instances beside the installed app in one Core, network confinement, Shell embedding, real database fixtures, long-run memory, concurrent agents and production image/runtime compatibility remain unverified.

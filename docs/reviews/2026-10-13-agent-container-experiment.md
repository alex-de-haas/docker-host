# Single-Agent Docker Experiment — 2026-10-13

Baseline: `f146d0ddd810eeaaa1d9cc922bf6c000a6d1d3e2`, with uncommitted planning documents and the experimental scripts described below. This is a point-in-time research report, not a claim that Hosty ships a container execution backend.

## Result

One standalone Codex agent successfully edited a synthetic worktree, passed three tests, wrote persistent agent data, and resumed the same conversation after its container restarted. Host filesystem refusal probes and container-wide shutdown passed. Startup was fast on this machine; the observed memory cost was roughly half a GiB, with a higher transient peak. This supports continuing with the shared-container prototype, but does not decide the cost of per-session containers.

This report summarizes 30 startup timings, 343 resource samples, configuration, checks and test results. Raw measurements and logs are local experiment outputs, not repository assets. [Containment D9](../features/assistant-runtime-containment/plan.md) still owns the unmeasured comparison and integration work.

## Configuration And Boundary

- Apple M4 Pro, 14 CPUs, 48 GiB physical RAM. Docker Desktop 4.95.0, Engine 29.8.2, Linux ARM64; Docker VM capacity 14 CPUs and about 7.65 GiB RAM. No other Docker containers were running at the measured run's start.
- Codex 0.160.0, matching the Harness dependency pin; Node 22.23.3 and Git 2.39.5. The app-server selected `gpt-6.1-sol` using an existing ChatGPT login. No API key was created.
- Container limits: 2 CPUs, 2 GiB RAM with no additional swap allowance, and 256 PIDs. UID/GID 1000, read-only image filesystem, all capabilities dropped, `no-new-privileges`, an init process, and a 128 MiB non-executable temporary filesystem.
- Exactly two host binds: a dedicated `/data` directory and a dedicated `/workspace`. The Git common directory lives inside `/data/repository.git`, so a linked worktree does not require mounting the original host repository. The fixture uses a shallow copy of the existing baseline; no commits were created.
- No host home, original repository, Core data, app data, Docker socket or published ports. The agent can read its container image's system files and write its two binds and temporary filesystem. These restrictions concern host access, not a ban on reading the container's own operating system.
- Codex's inner policy was `danger-full-access` with approvals disabled for the controlled fixture. Filesystem restrictions therefore came from the Docker configuration rather than prompt compliance or Codex's inner sandbox. The image logged a missing system `bubblewrap` diagnostic and offered its bundled fallback; inner bubblewrap isolation was not under test.
- The normal Docker bridge remained enabled for provider communication. Network access to host/other services was not confined or validated. The prompt prohibited extra task network use; that instruction is not a network security boundary.
- A temporary copy of the existing login was placed in dedicated agent data, excluded from the image/evidence, and removed afterward. This experiment does not separate provider credentials from agent-side code inside the same container.

## Timing Results

| Measurement | Observed result |
| --- | ---: |
| Image preparation, including available pull/build steps, one sample | 13.272 s |
| Image size reported by Docker | 754,765,430 bytes / 719.8 MiB |
| Container creation, separate from start | 0.031 s |
| First start to local thread readiness in the measured run | 0.636 s |
| Repeat starts, median, 29 samples | 0.135 s |
| Repeat starts, nearest-rank p95, 29 samples | 0.140 s |
| All starts, median / nearest-rank p95, 30 samples | 0.135 / 0.141 s |
| First real turn to first tool action | 6.933 s |
| First real turn, edit and tests, total | 20.423 s |
| Restart and resume the same thread | 0.188 s |
| Resumed real turn, tests and persistent note, total | 11.343 s |

Start timing begins immediately before `docker start -ai` and ends after app-server initialization and `thread/start`. The image and Docker engine are already available. The first measured start follows an earlier pilot, so it is not an uncached machine/VM boot measurement. These timings do not include a model response. Model/tool latency is measured separately and has only two real-turn samples. p95 is indicative for this small local sample, not a service-level guarantee.

## Resource Results

| Phase | Memory median | Sampled memory maximum | CPU median / sampled maximum |
| --- | ---: | ---: | ---: |
| Settled idle before work, final 30 seconds of a 60-second window | 475.4 MiB | 475.4 MiB | 0.01% / 0.08% |
| First edit/test turn | 484.6 MiB | 486.5 MiB | 0.59% / 18.60% |
| Settled idle after work, final 30 seconds of a 60-second window | 467.2 MiB | 467.8 MiB | 0.01% / 0.44% |
| Resumed turn | 536.6 MiB | 553.1 MiB | 2.19% / 18.68% |
| Entire sampled interval | 475.4 MiB | 577.5 MiB | 0.02% / 24.22% |

Samples came from `docker stats` at roughly half-second intervals. They can miss short peaks and contain startup/background activity. The short final idle interval after resume had a 562.0 MiB median; it is not evidence of a settled long-term baseline. CPU percentages are the values reported by Docker.

The cgroup `memory.peak` counter after resume recorded **697.83 MiB**. This includes memory accounted differently from Docker's CLI working-set display and covers only the final container lifetime after restart. It is not an all-run peak. The same snapshot reported no OOM events and no CPU throttling. Docker CLI memory subtracts an inactive cache category on Linux; see the [Docker stats documentation](https://docs.docker.com/reference/cli/docker/container/stats/). Docker VM/engine overhead is not included in these per-container numbers.

For the next prototype, a provisional budget of about 1 GiB per agent process is a reasonable inference from this small task, not a verified requirement or sufficient budget for an application build/browser. Keep the tested 2 GiB ceiling until representative workloads establish a safe limit. Putting several agent processes inside one container does not establish that they share this entire memory cost.

## Functional And Boundary Evidence

1. The baseline quantity calculation failed its expected test. The agent corrected multiplication, preserved empty-cart behavior, added an input-immutability regression test and passed all three tests. An independent `node --test cart.test.cjs` execution confirmed the result.
2. The agent wrote `/data/agent-note.txt`. After stopping and restarting its container, `thread/resume` returned the same thread ID. A second real turn read the note, reran the tests and appended the expected line. Source and agent state persisted.
3. Direct reads of a synthetic host canary and the original host repository were refused. Absolute symlinks from the mounted worktree to those outside locations also failed. Writes to the synthetic outside canary failed; its host-side contents remained unchanged.
4. The Docker socket was absent. Writes to container root/system locations were refused; writes to `/data` and the fixture succeeded. Probe identity confirmed UID 1000, zero effective capabilities and `NoNewPrivs=1`.
5. A detached writer intentionally outlived a tool command. Stopping the container stopped file growth; Docker reported an exited container with PID 0 and no OOM kill. This validates container-wide stop, not conversation cancellation while a shared agent remains running.
6. All 11 runner checks passed. Experiment containers and temporary login copies were removed. The image, synthetic source/data and sanitized local logs were retained for inspection. Existing Core/apps were not restarted.

## Instrumentation Corrections

An initial pilot passed functional checks but its resource collector rejected Docker's ANSI-decorated JSON lines. Its memory results were discarded. The measured run repeated the full experiment after stripping ANSI sequences and requiring samples in every work phase.

The synthetic sparse worktree initially had an uninitialized Git index: inherited tracked paths appeared deleted despite no source modifications to those paths. After timing finished, `git read-tree -mu HEAD` initialized the index. A supplemental check showed only the untracked fixture, an empty staged diff, the Git common directory at `/data/repository.git`, and three passing tests. The saved preparation recipe now initializes the index. A fresh preparation-only run independently passed the clean-index and filesystem-boundary checks without credentials or model calls. Startup/resource timings were not rerun after this fixture-only correction. Production worktree/Git publication behavior is not established by this test.

## Reproduction

The isolated fixture builder and measurement driver are [prepare.py](../../scripts/experiments/agent-container/prepare.py) and [run.py](../../scripts/experiments/agent-container/run.py). The [Dockerfile](../../scripts/experiments/agent-container/Dockerfile) pins the resolved base digest and Codex version. Run from the repository root with Docker available, Python 3, and an existing file-backed ChatGPT login:

```bash
docker build -t hosty-agent-container-experiment:20261013 scripts/experiments/agent-container
python3 scripts/experiments/agent-container/prepare.py \
  --root /private/tmp/hosty-agent-container-repeat \
  --source "$PWD"
python3 scripts/experiments/agent-container/run.py \
  --root /private/tmp/hosty-agent-container-repeat \
  --auth-file "$HOME/.codex/auth.json" \
  --starts 30 --idle-seconds 60
```

Choose a fresh root each time; preparation refuses an existing directory. The driver uses a randomly named container, removes only its own labelled container, removes its temporary login copy, and preserves evidence and synthetic data. An external kill or machine failure can interrupt cleanup; inspect the chosen experiment directory/container in that case. The driver saves the measured image ID and detailed observations in the experiment directory. Package repository contents can change on a future rebuild despite pinned base/Codex versions.

The existing-login and app-server mechanisms follow the official [Codex authentication](https://learn.chatgpt.com/docs/auth) and [app-server](https://learn.chatgpt.com/docs/app-server) documentation. No credentials are included in this report or its example commands.

## Scope Limits And Remaining Acceptance

This test covers one standalone Codex process with a small synthetic Node task. It does not validate Harness routing, Hosty identity/Core grants, Shell embedding, Docker application builds, hot reload, application sandbox instances, browser automation, real repository builds, Git publication, native-versus-container overhead, other adapters/OSes, concurrent sessions, network restrictions, or long-running memory growth. Filesystem refusal probes are evidence for the configured mounts and permissions; they are not a container-escape audit.

These remaining acceptance requirements stay in [Containment D9 and D11-D13](../features/assistant-runtime-containment/plan.md), [App Sandbox Runtimes](../features/app-sandbox-runtimes/plan.md), and their linked owners. No production backend deliverable was checked off and no product version changed: only experimental tooling and documentation were added.

## Repository Verification

- Docker image build and the measured experiment exited successfully; all 11 experiment checks passed.
- The saved preparation recipe passed a fresh fixture/index/boundary check; the corrected source passed three independent Node tests.
- Python syntax compilation passed for both experimental scripts. Evidence consistency checks confirmed 30 startup timings, 343 resource samples and credential-copy cleanup.
- `node scripts/docs-index.mjs --fix` and `--check`, `node scripts/check-versions.mjs`, and `git diff --check` passed.
- Full Hosty product builds and suites were not run: no product code changed, and this experiment deliberately did not exercise Core/Harness integration. No commits or pull requests were created.

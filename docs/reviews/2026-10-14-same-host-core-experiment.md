# Same-Host Core Experiment — 2026-10-14

This is a point-in-time experiment on macOS with Docker Desktop and the owner's accepted shared
daemon trust model. Baseline commit: `608739739dbf31a7476c9150a4ce1cdf30c2bb0f`, plus the uncommitted sandbox
implementation in the registered development workspace. Tested Core source SHA-256:
`8aa36654c6115c5951c3f72433ac098f96b233519d08ed6bce24915a2a2e17b8` (sorted relative `.cs`/`.csproj` paths and contents, excluding bin/obj).
No product source code changed during this experiment. No commit or PR was created.

## Result And Boundary

Two Core processes, each with a fresh data root and normal administrator account, ran the same
Demo App ID concurrently on the same Docker daemon. Each app had backend/frontend containers,
instance-specific names/networks, its own data mount and its own local browser origin. Both apps
worked through normal browser password login and app authentication. This supports the selected
same-host architecture without a VM; it does not implement a parent Core sandbox API or a security
boundary against trusted Core code using the shared Docker daemon.

[Machine-readable evidence](../features/app-sandbox-runtimes/2026-10-14-same-host-core-evidence.json),
[Core A preview](../features/app-sandbox-runtimes/2026-10-14-same-host-core-a.png),
[Core B preview](../features/app-sandbox-runtimes/2026-10-14-same-host-core-b.png).

## Topology And Identity

- Core A: port 37201, instance `f7a7e04ecd774438b0c3ff6d9d88616d`.
- Core B: port 37202, instance `915eff070ead4734b62ccb86deacaed7`.
- Both installed `com.haas.demo-app` version 0.17.0, profile `sandbox-artifact`, from the same
  locally cached image. App IDs were not rewritten.
- Existing Core behavior generated `hosty-<12-character-instance>-com-haas-demo-app-<service>`
  and stamped the full `hosty.instance` label. Each app had a separate instance-scoped network.
- All app bind mounts in the inspected containers were under their own experiment data root.
  Writing `instance-proof.json` from each backend produced the corresponding instance ID only
  in that root. No production app data, users or connection stores were copied.
- Each fresh Core used the normal one-time setup-token flow, then email/password login. Sending
  Core A's session cookie to Core B did not authenticate. In one Playwright browser, each app
  showed its own administrator; returning to A after signing in to B retained A's user.
- HTTPS requests to `https://example.com` from both backend containers returned 200. These were
  ordinary Docker runtimes with internet access, not the earlier offline sandbox adapter. This
  does not implement or verify the planned reusable permission-review UI.

## Timing And Memory

| Observation | Core A | Core B |
| --- | ---: | ---: |
| Prepared executable start to Core health/control readiness | 0.795 s | 0.574 s |
| Demo App start, two cached artifact containers | 4.178 s | 4.272 s |
| Core RSS after bootstrap apps were removed, five samples | 179.6–179.8 MiB | 162.3–163.2 MiB |
| Core RSS with Demo App idle, eight samples | 128.8–142.8 MiB | 125.6–138.2 MiB |
| Core RSS during API request load, eight samples | 101.4–117.9 MiB | 114.7–125.2 MiB |
| Two app containers combined during request load, Docker stats | 120.08–151.18 MiB | 130.41–162.51 MiB |

Four workers (two per Core environment) alternated authenticated app config/identity probes for
25 seconds: 856 requests, all HTTP 200. Samples were taken roughly every few seconds because Docker
stats acquisition adds time. This was a modest API workload on a prebuilt app, not an agent/build,
media-processing, capacity-limit or leak test. The lower later RSS values include normal runtime
reclamation; they do not mean load reduces memory requirements. Docker stats and host-process RSS
measure different things. Docker VM overhead, browser/agent memory and build peaks are excluded.

Core readiness timings exclude compilation and do not wait for asynchronous first-party bootstrap.
The later source launch verified factual `dev` mode, the exact worktree project, a new PID, preserved
app data and a working signed config request. Source restart latency is not reported: initial probes
raced container replacement, then found the separate diagnostic health condition described below.

## Shutdown And Recovery

1. A small external helper actually spawned Core B. Killing that helper left B running with PPID 1,
   and both B containers continued running. Process parentage does not provide automatic teardown.
2. `hosty --data-root <A> core stop` completed in 0.701 seconds. A exited and its containers stopped;
   the exact B container IDs/start times were unchanged. A's data remained for restart.
3. Killing A with SIGKILL left its Docker containers running. A was restarted and its own data
   remained available; B was unaffected. Docker resources need explicit reconciliation.
4. A source launch/restart via `--project` selected the tested project and a new Core process.
   The tag-only local Demo image was recreated rather than adopted. This is an observed limitation,
   not evidence of seamless restart. B's exact containers remained unchanged.
5. An external test coordinator sent normal CLI stops to both Cores concurrently. Both processes
   exited and all four app containers stopped in 0.635 seconds. This proves the stop primitive;
   it is not a shipped parent Core shutdown implementation.

For the product manager, use a durable child registry, graceful concurrent stops with a timeout,
ownership-checked fallback cleanup, and reconciliation after parent restart. Keep technical stop
separate from Finish; deleting data on every Core restart would contradict the accepted lifetime.
Immediate cleanup after parent SIGKILL needs an independently surviving supervisor; startup
reconciliation is the simpler initial contract. Remaining work is tracked in sandbox D18/D19/D21.

## Findings That Prevent Calling This A Finished Product

- **First boot and Shell port.** Fresh roots seeded Shell and Marketplace automatically. Shell
  attempted fixed port 7171, occupied by the operator's existing Shell. The experiment removed only
  these newly seeded installations through normal lifecycle APIs before measuring the bounded app
  configuration. The manager needs an explicit seed profile and independent Shell ports.
- **Local artifact adoption.** The ordinary Docker adapter requires a digest lock before adopting
  an existing container. This locally built artifact has no registry digest, so Core recreates it,
  including after `--keep-apps`. The sandbox adapter's earlier immutable-image acceptance does not
  prove equivalent behavior in this different ordinary runtime path. Define/verify the required
  local-image retention behavior before claiming seamless Core development restarts.
- **Diagnostic health.** Demo App's artifact profile does not provision `/app/logs`. Its
  `/api/health` endpoint returns 503 for that missing directory, although browser and signed API
  checks pass. The profile has no manifest healthcheck, so lifecycle reports started. Fix the recipe
  to provision isolated logs and verify meaningful readiness; do not hide the failed diagnostic.
- **Supervisor ownership.** No parent-managed environment registry/API, cascading shutdown or
  cleanup reconciliation is implemented by this experiment.

These findings are tracked in the owning sandbox plan, not in this immutable report.

## Cleanup And Host Observation

Both test Core processes are stopped. Their four Demo containers and their app networks were
removed by verified instance ownership. Both experiment data roots, test users, keys and temporary
credential files were deleted after process exit. Borrowed source, exported evidence and shared
Docker image caches remain. The experiment's Playwright browser was closed.

The primary Core kept PID 72204. The initial Workspaces container still exists but had already
stopped at 09:40:03 UTC, before the test Cores launched at 09:43 UTC (exit 143, no OOM). Four unrelated
containers (Elasticsearch, Redis, RedisInsight and RabbitMQ with Aspire-style names) disappeared
during the observation window. Docker events confirm their removal; no experiment command targeted
them, but the remover was not established. Consequently the report does not claim that the entire
host was unchanged. Four new running container IDs appeared in a later observation. The directly
tested A/B lifecycle isolation checks passed independently.

## Verification Commands

```sh
dotnet build apps/core/src/Haas.Hosty.Core/Haas.Hosty.Core.csproj \
  --artifacts-path /private/tmp/hosty-shared-core-build
dotnet test apps/core/tests/Haas.Hosty.Core.Tests/Haas.Hosty.Core.Tests.csproj \
  --artifacts-path /private/tmp/hosty-shared-core-build \
  --filter 'FullyQualifiedName~CoreInstanceIdTests|FullyQualifiedName~DockerRuntimeAdapterTests|FullyQualifiedName~DockerStatsExpositionTests|FullyQualifiedName~LocalBrowserOriginsTests|FullyQualifiedName~CoreRootLockTests|FullyQualifiedName~PasswordLoginHttpTests' \
  --logger 'trx;LogFileName=shared-core.trx' \
  --results-directory /private/tmp/hosty-shared-core-results
```

Build passed: zero errors, four existing warnings. An initial `--no-restore` invocation against the
new artifacts directory failed because its assets file did not exist; the restore/build above
passed. Focused tests: 161 passed, zero failed/skipped. The real runtime/browser probes and negative
findings are recorded above. The full suite/AOT/frontend builds were not repeated: this experiment
changed documentation only, and the earlier implementation verification remains separately recorded.

The coordinator scripts and raw logs remain under `/private/tmp/hosty-shared-core-experiment` for
local inspection; they are experimental drivers, not a supported Core manager. Initial driver
assertions incorrectly expected only Demo containers before default bootstrap was removed and
expected adoption for a tag-only image. HTTP readiness probing was corrected to distinguish actual
app API operation from its failing log-directory diagnostic. None of those failures are represented
as passing product guarantees.

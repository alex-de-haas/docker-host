# Real Harness Agent Core and Demo Source Acceptance — 2026-10-14

Baseline: `608739739dbf31a7476c9150a4ce1cdf30c2bb0f` plus the uncommitted sandbox implementation in its registered Core development worktree. Implementation Core source SHA-256: `ece9d628494c27bbf43d19a908774dceea07b307c7971e07a180342f32595de7`. Agent-modified test Core: `3394e34552a6dfe5df9231cdef092a83d70e6e2dc012a860238e305553c6fe2e`. Hashes cover sorted repository-relative `.cs`/`.csproj` paths under `apps/core/src`, NUL-separated paths/contents, excluding bin/obj. No commits, pushes or pull requests were created.

## Outcome

D23 passes in one complete model-driven cycle on macOS with Docker Desktop. Codex 0.160.0 using the connection's default `gpt-6.1-sol` runs through actual Harness 0.51.0 session `ce4dfc9e-5a24-45d5-afd5-992a019a2c3d`. The agent edits both Core and Demo, starts a child using its changed Core project, verifies the new API through Demo in a real browser, and finishes the environment. This extends the [prior real-agent run](2026-10-14-child-core-agent-acceptance.md), which changed Demo with the current prepared Core.

[Structured evidence](../features/app-sandbox-runtimes/2026-10-14-core-source-agent-evidence.json), [browser screenshot](../features/app-sandbox-runtimes/2026-10-14-core-source-agent-preview.png), [agent-authored patch](../features/app-sandbox-runtimes/2026-10-14-core-source-agent-source.patch), [sanitized test/build/browser/resource logs](../features/app-sandbox-runtimes/2026-10-14-core-source-agent-logs.zip).

## Actual Flow

The coordinator supplies an isolated parent Core, normal administrator/password setup, reviewed Harness permissions, and a session-owned worktree containing the reviewed Core/Demo/SDK/shared source fixture. A separate 4 GiB/2 CPU agent container has Node 22.23.3, Codex 0.160.0 and .NET SDK 10.0.401, private data/worktree mounts and no Docker socket. Playwright runs in another container. Existing provider login is copied privately for the run and removed afterwards. A transport-only bridge forwards actual Harness workspace tools unchanged; it does not perform the child's lifecycle for the model.

The agent invokes 14 environment tool calls itself. It creates child `958522fe8995475894ef5be9c4e8dd1f` with `mode: source` and its session worktree's absolute Core project path. The manager builds on the host before launch. Independent inspection confirms the executable under the child's own `core/environment-builds`, PID 46083 and port 24474. The source build takes 21.32 seconds with zero errors and four existing unrelated platform warnings.

The agent adds a temporary `coreBuildMarker` field to the normal service-authenticated Core user-directory response. Demo reads the field and displays it as **Core build**, with an unavailable fallback. The value `core-source-20261014` is emitted by the changed Core, not hardcoded in Demo or supplied through configuration. A new HTTP test checks the serialized response and confirms missing, forged and wrong-app service tokens still fail.

The agent sets up a fresh synthetic user, submits a `sandbox-dev` installation, signs in normally in Playwright, and approves Core's installation page with autostart off. It selects its worktree, starts Demo through the child API and observes both source services healthy. Through the Core-provided app URL, it verifies its changed heading, the new Core marker and an active child administrator. `/api/people` and `/api/auth/identity` return 200. It navigates to People and back, changes the heading on the same open page and verifies hot reload with the marker and identity preserved. Browser page errors are empty. Both app container IDs remain unchanged during observed execution.

Independent mounts show read-only worktree sources, data and writable file overlays inside the child root, and distinct backend/frontend cache volumes. The last raw container snapshot is during Finish: the backend is already exited while the frontend is stopping; it is not the browser readiness observation.

The four-file patch changes the Core endpoint, its HTTP test, Demo's response reader and DemoOverview. These acceptance changes are exported only, not applied to the implementation checkout. No product fix is required. The agent corrects its own browser runner setup (interactive stdin and separate Playwright connection contexts) within this cycle. Private fixture/tool output contains setup credentials; raw agent/Harness transcripts are removed instead of exported.

## Verification

All agent commands return exit code zero. Exact arguments, durations and logs are retained in evidence.

- `dotnet test apps/core/tests/Haas.Hosty.Core.Tests/Haas.Hosty.Core.Tests.csproj --artifacts-path <worktree>/.artifacts/source-agent-tests --filter FullyQualifiedName~AppDirectory -m:1 -p:UseSharedCompilation=false`: **11 passed, 0 failed, 0 skipped**, including the new HTTP test; 59.3 seconds including Linux compilation/restore.
- `npm test --workspace @haas/hosty-demo-app`: **6 passed**, repeated after the final edit.
- `npm run lint --workspace @haas/hosty-demo-app`: **passed**, repeated after the final edit.
- `npm run build --workspace @haas/hosty-demo-app`: **passed** before launch and after the final edit (13.5 and 9.1 seconds).
- The manager separately builds the changed Core project for macOS: **passed**, followed by process readiness and changed API behavior.

The full Core suite and Native AOT publish are not repeated: this acceptance adds no production implementation change and uses the ordinary source Debug workflow. The preceding implementation verification remains in the prior review. Repository changes for this run are documentation/evidence only; no additional version bump.

## Resource Observation

The observer records 130 samples approximately four seconds apart over the roughly nine-minute run. These are sampled peaks, not capacity guarantees, and the rows do not necessarily peak simultaneously.

| Component | Sampled peak | Measurement |
| --- | ---: | --- |
| Agent, including .NET and Demo checks | 1637.4 MiB | Docker working set |
| Demo frontend | 863.9 MiB | Docker working set |
| Demo backend | 399.0 MiB | Docker working set |
| Separate Playwright browser | 334.0 MiB | Docker working set |
| Child Core | 131.2 MiB | Host process RSS |

Maximum simultaneous Demo usage is 1211.1 MiB. The worker cgroup lifetime peak is 2141270016 bytes (about 2.0 GiB), including accounted cache; this differs from Docker's working-set metric. Worker OOM counters are zero. Docker VM overhead and separate host build/compiler processes are excluded. This is one small app and one agent, not a concurrency or production sizing benchmark.

## Finish and Fixture Cleanup

The agent invokes Finish and confirms `finished` through status and list. Independent checks confirm the recorded child process is gone, its complete data/build/cache root is absent, and no container, network or volume remains with its full instance label. The source tree and both agent-authored edits survive Finish. All 20 other baseline containers remain running at that check.

After export, the coordinator restores only the disposable fixture and releases its clean worktree through Harness. It removes the isolated parent, agent/browser containers, experiment network, temporary combined worker image and copied provider login/private sessions. Shared images, the implementation worktree and exported evidence remain. The primary Core is not restarted.

This closes D23 only. Other explicitly unchecked sandbox consent, dependency, budget, preview and integration deliverables remain open.

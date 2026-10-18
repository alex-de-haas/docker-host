# Unified Ordinary-App Dev Mode — Acceptance, 2026-10-18

Baseline: `ddabb4440768f07f54d8f0c74cac90d3b62c512e` (PR #607), plus the uncommitted
unified-dev implementation on the registered external worktree. This report describes that working
copy, not a published release. No commit, push or pull request was created by this implementation
request. It covers D2–D9 of [the plan](../features/app-development-controls/plan.md).

## Result And Scope

One ordinary installed app used the same Core, installation, authenticated user and data throughout
manual and real-agent runtime switches. The real Codex provider ran in Harness's shared Docker
worker. Shell, Harness, direct MCP and the local CLI exercised the common Core contract. The
ordinary Docker image was restored after live worktree edits, without discarding the edits or newer
data. The fixture was completely removed after verification.

The fixture used normal setup and password login at a separate Core data root. The approved
temporary Codex authorization, Harness grants (`apps.lifecycle`, `apps.sources.full`) and direct
MCP token (`mcp:read`, `mcp:lifecycle`, `mcp:workspaces`) were scoped to that fixture. The primary
Core, its apps and Docker memory settings were not changed. No production data was used.

## Observed Journey

| Check | Observation |
| --- | --- |
| Ask: deny | Real agent prepared entry and submitted `app_dev_apply`; denial prevented Core mutation. Ordinary runtime continued. |
| Ask: allow | A new reviewed request entered the Docker development profile, recorded a managed-data backup and reached active/running/healthy. |
| Live edits | Codex changed only the visible heading in the registered worktree. Browser reload displayed the new heading without rebuilding the container or another runtime approval. This recipe recompiles on request; this does not claim browser push-HMR. |
| Ordinary data | One note created before entry and another during dev remained visible after Return. Same Core login and signing domain were retained; the fixture's note records themselves do not contain user IDs. |
| Run unprompted | Return, then another Return/Enter sequence, completed through the real Harness agent without an approval card. No privileged fallback or agent policy change was used. |
| Disabled | In Autonomous mode, the real agent observed that `app_dev_apply` was absent. Transport/policy tests separately cover refusal before dispatch. |
| Cancel before dispatch | Stopping a session at the Ask card left the active runtime unchanged and created no Core receipt for that pending request. |
| Manual Shell | Reviewed entry and Return worked without a conversation, using configured Git source. |
| External MCP | The temporary direct credential entered dev mode without Harness and replayed the same request after Core restart without creating another operation/backup. |
| Recovery | After fixing autostart handling, `core restart --keep-apps --port 28140 --project ...` retained the active dev container ID, StartedAt, running state and data hashes. The app's autostart preference stayed false. |
| Manual Harness | Return from the right-hand workspace panel restored the original ordinary Docker image and showed returned/docker/running/healthy. |
| Data/source preservation | SHA-256 hashes of every managed-data file and the edited source file, and Git HEAD, were identical immediately before and after the final Return. The original source override and exact image ID were restored. |
| Logs authority | The Logs button displayed the missing `apps.logs` permission; no extra permission was granted. Open app used the authenticated app browser origin rather than a raw loopback endpoint. |
| Audit | Final live Return persisted actor, installation, worktree, HEAD, manifest/review digests, request/operation IDs and outcome. The policy discards unrecognized detail fields. |
| CLI | The newly built `apps dev-status` reported returned/docker/running against the fixture. |

A Harness source-watch restart interrupted one native command approval during the run. The session
was stopped and a subsequent turn continued with the already-applied edit intact; no runtime/data
change was attributed to the interrupted approval.

## Regression And Failure Coverage

Core tests cover running/stopped entry, wrong owner, stale review, source/configuration conflict,
failed backup before dev starts, failed startup recovery, manifest damage before Return, explicit
data-compatibility acceptance, interrupted Return with exact replay, retired request IDs, canonical
local path aliases, missing/corrupt journals, independent preview consumers, cleanup guards and
separate explicit backup restore. HTTP tests cover direct MCP authority and primitive-argument
serialization. Audit tests cover allowed references and excluded secret/unrecognized details.

Harness tests cover tool schemas, session routing, Ask/unprompted/Disabled policy, an uncertain
apply response retained across component remount, and replacing a definitively stale review.
Existing Shell and application-creation regression suites remained green.

| Command/check | Result |
| --- | --- |
| `dotnet test apps/core/tests/Haas.Hosty.Core.Tests/Haas.Hosty.Core.Tests.csproj` | 3,517 passed, 4 opt-in tests skipped; full run preceded the final focused fixes. |
| Affected Core filters: `AppDevMode`, `HostPath`, MCP lifecycle, backups and source | 104 passed; subsequent focused recovery/authority run: 62 passed. These counts overlap. |
| Final Core audit/dev-mode focused run after the last Core edit | 60 passed. |
| `dotnet test apps/cli/tests/Haas.Hosty.Cli.Tests/Haas.Hosty.Cli.Tests.csproj` | 236 passed on the final CLI. |
| `npm run test --workspace @haas/hosty-harness` | 723 passed, 85 files. Earlier path-based workspace selection also selected the web package without a test script; the final exact-name run passed. |
| `npm run test --workspace @haas/hosty-shell` | 192 Node tests and 286 component tests passed. |
| Harness and Harness web TypeScript lint | Passed. |
| Shell lint | Passed with two existing warnings, no errors. |
| Harness web and Shell production builds | Passed. |
| `dotnet publish apps/core/src/Haas.Hosty.Core/Haas.Hosty.Core.csproj -c Release -r osx-arm64 --self-contained true -p:PublishAot=true -o <temporary-output>` | Passed after the final audit edit; existing compiler/platform warnings remain. |
| Official worker Dockerfile, local `0.58.0` image | Built successfully and used by the real Codex run. |
| Version consistency, documentation index and `git diff --check` | Passed. |

The full Core run's skipped cases require opt-in Docker/mixed telemetry/torrent fixtures. Real
ordinary-app Docker acceptance above was separate. Native Linux/Windows hosts and a Claude run
were not exercised here. The real browser app had one service; multi-service lifecycle behavior
uses the existing stop/start implementation and regression suite. Concurrent child-preview
consumer independence was verified in-process; no new live child-Core preview was created in this
run. Monorepo, alternate native profiles and system self-development were not acceptance targets
of this selected macOS/Linux-container fixture. The deferred broader parity assessment remains D1.

## Resource Observations

| Container | Three observed samples | cgroup memory peak |
| --- | --- | --- |
| Shared agent worker | 544.8–545.1 MiB, 0–1.44% CPU, 4 GiB limit | 712.2 MiB |
| App development runtime | 86.86–87.05 MiB, 0.06–7.21% CPU | 274.2 MiB |

These are snapshots and per-generation peaks including startup, not a continuous benchmark or
release sizing guarantee. Core and the host-side UIs were source/Debug development processes.
No unrelated container limits were changed to make the test pass.

## Fixes Found During Verification

- Register primitive MCP arguments and source-generated JSON metadata so Core can start and expose
  the operation with Native AOT-compatible serialization.
- Normalize macOS temporary-directory aliases when validating the configured Git source.
- Preserve active dev trials during keep-apps Core restart even with autostart disabled.
- Admit the new operation fields through the existing audit-details allowlist; previously the
  record survived but its useful references were filtered out.
- Distinguish Harness transport action from `devAction`, retain uncertain requests across reload,
  and allow a new review after a definitive pre-admission stale-plan refusal.
- Use the app's browser origin for Open app and show missing log authority without implicit grants.

## Cleanup And Version Outcome

The temporary provider connection was removed. The direct MCP token was revoked and then returned
HTTP 401. Fixture app and Core processes were stopped; all four fixture listeners were confirmed
closed. The fixture container, its labeled development cache volume, and both fixture-built image
tags were removed. No fixture-owned container, network or volume remained. The entire fixture
root, including the temporary Codex auth copy, caches, data and native output, was deleted.
Unrelated container IDs, states, StartedAt values and memory limits matched the cleanup baseline.
Only two browser proof screenshots were retained outside the repository. No raw evidence JSON,
credential, log archive or experimental patch was added to the repository.

Version changes: Core/CLI **0.140.0 → 0.141.0**, Harness/worker **0.57.0 → 0.58.0**,
Shell **0.104.2 → 0.105.0**. Publication and primary-host deployment were not requested.

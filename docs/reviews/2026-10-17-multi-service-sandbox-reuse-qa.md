# Multi-Service Sandbox Reuse QA — 2026-10-17

## Baseline And Scope

Baseline: `34ea0bd2d5bfee6e12ac9d53f151ad61368babe7` (PR #606), plus the uncommitted
app-creation, local-handoff, continuation and D13 changes in the registered feature worktree.
Versions remain Core **0.140.0** and Harness **0.57.0** for this feature.
This report closes [D13](../features/app-prototype-workspaces/feature.md); the overall plan remains open.

The run used macOS, the local Docker engine, an isolated source Core on port 29291 and
Core-managed source Harness. The owner approved four optional test Harness permissions:
`apps.install`, `apps.workspaces.cleanup`, `core.environments.read` and
`core.environments.manage`, plus one trusted child Core launch. Normal password setup/login
and app PKCE supplied identity. No provider credentials were copied and no model turn ran.
The operator drove authenticated Harness session/environment APIs and verified both Harness
and application pages in the browser. Real-provider generated-stack acceptance remains D16.

## Verified Journey

| Step | Observation |
| --- | --- |
| Create | Harness created `local.d13-services`, a canonical local Git source with the consented bootstrap commit, no remote and a registered worktree. The parent app stayed stopped. |
| Initial preview | Harness created, approved, started and configured child `c491a1a6875e4ceeb12fe529215df4b5`. Ordinary child installation review installed the worktree's Docker profile. Browser password login opened the bootstrap and saved a notebook record. Anonymous `/api/notes` returned 401. |
| Replace topology | The worktree replaced `web` with public `frontend` and private `backend`, using `dependsOn` service discovery and moving the data target to backend. Harness displayed Restart required before the normal `updateAppId` review. |
| Apply update | Core built the backend image, removed the obsolete `web` container and started exactly two services. Installation identity, preview link, child root and initial data hash stayed unchanged. The panel displayed both observed service states and Environment build: Built. |
| Iterate source | A fixture forwarding error initially used an unsupported identity header. Correcting it to the normal bearer credential reloaded source in the existing containers. Their IDs did not change. The browser read the initial record and wrote a second through the private backend. |
| Observe failure | Stopping only the test backend left the frontend running. After Core supervision, the panel displayed frontend running/healthy and backend stopped/unhealthy; the aggregate was unknown/unhealthy. No false healthy result was inferred from the frontend. |
| Rebuild and restart | A reviewed build revision change from 1 to 2 produced a different immutable backend image with the expected revision label. An explicit Harness child API restart reused that image and restored both healthy services. Both records retained the same hash. |
| Reuse the environment | Harness Stop/Start retained the same child id, root, installed app and test users. Explicitly starting the non-autostart app restored its two services. Browser reload displayed revision 2 and both records with the existing identity; the panel displayed Environment build: Reused. |
| Finish | Harness Finish removed the child process/root, two containers, one network and three source-cache volumes. The child port closed and the preview section disappeared. Canonical and uncommitted worktree source hashes remained unchanged. |

The initial notebook SHA-256 was
`fa9c6b81f6a128580439fcb9acadb4204d7b1fe06e5f250d0f36e97c4e6a5dcd`.
After the second browser write it was
`1ed7b6101d10eb1d5ebcfb8db24a1d0cd411474af82fa4080e299604b3b0a8a2`,
unchanged through the environment rebuild, app restart and child Stop/Start.

## Resources And Cleanup Boundary

A `docker stats --no-stream` sample after the two-service preview reported **135.3 MiB** for
frontend and **70.46 MiB** for backend, each limited to **1 GiB**. This is one steady-state
sample, not a peak-memory or cold-start benchmark. The app used the existing 2 GiB application
share inside a 4 GiB child reservation.

Finish owns child processes, data, users, containers, networks and labelled cache volumes.
It does not prune Docker development images or the shared builder cache. The two test-created
backend image tags remained after Finish and were removed separately by their recorded exact
tags. Shared base images and builder cache were retained; no broad Docker prune ran. The
automatic resource-removal claim above does not include image/build-cache garbage collection.

The owner-approved temporary 2 GiB limits on main Shell, Workspaces and Marketplace were
restored through Core-managed container recreation. All three returned running with their
original `Memory=0` and `MemorySwap=0`; Core health reported the Shell healthy and Docker
reported Workspaces/Marketplace healthy. The main Core stayed in release mode on port 7070.

After source-preservation checks, the disposable Harness and parent Core were stopped normally.
All three test ports closed. The entire test root was deleted, including test credentials,
session/consent grants, permission assignments, fixture repositories and raw evidence.
No raw JSON or logs are included in the repository.

## Implementation And Checks

- Docker start reconciles obsolete containers by immutable ID and exact app/instance labels,
  against the full selected Docker graph. It retains current siblings, unrelated owners,
  data and cache volumes. Inventory, ownership-observation and removal failures fail the start.
- The child application projection includes observed per-service health; Harness replaces
  obsolete rows and reports missing observations as unobserved.
- The packaged development guide documents reviewed updates with `updateAppId`, stable data
  targets, private service discovery and reuse of the existing child.
- `dotnet build apps/core/src/Haas.Hosty.Core/Haas.Hosty.Core.csproj --no-restore --nologo -v quiet`
  passed before launch. The launch also prepared and ran the exact source project. The final
  rebuild after comment cleanup passed; four existing compiler/platform warnings remain.
- `dotnet test apps/core/tests/Haas.Hosty.Core.Tests --no-restore --filter 'FullyQualifiedName~DockerRuntimeAdapterTests|FullyQualifiedName~CoreEnvironmentTests|FullyQualifiedName~DockerSourceRuntimeTests|FullyQualifiedName~MixedRuntime|FullyQualifiedName~CoreLifecycleServiceTests'`
  — **918 passed, 4 skipped**. The skips are opt-in Docker development and companion Torrent/VPN
  fixtures without their required inputs; this report supplies a separate live D13 Docker run.
- Final focused Core regression run with filter
  `FullyQualifiedName~DockerRuntimeAdapterTests|FullyQualifiedName~CoreEnvironmentTests|FullyQualifiedName~AppCreation`
  — **182 passed**, no skips. This includes corrected valid-ID fixtures for full-graph sibling retention.
- `npm test --workspace @haas/hosty-harness` — **81 files, 692 tests passed**.
- Harness and web lint/type checks, web production build, documentation-index validation,
  version consistency and whitespace checks passed.

No new Windows, production deployment, hosted Git publication or real-provider generation is
claimed. The remaining guide/stack, failure-repair and provider acceptance work stays unchecked
in the owning plan. No commit or pull request was created in this step.

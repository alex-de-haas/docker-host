# Optional Preview Checks And Recovery QA — 2026-10-17

## Baseline And Scope

Baseline: `34ea0bd2d5bfee6e12ac9d53f151ad61368babe7` (PR #606), plus the uncommitted
app-creation, local-handoff, continuation, multi-service and D14 changes in the registered
feature worktree. Versions remain Core **0.140.0** and Harness **0.57.0** for this feature.
This report closes [D14](../features/app-prototype-workspaces/feature.md); the overall plan remains open.

The run used macOS, Linux Docker containers, an isolated source Core on port 29301 and
Core-managed source Harness. The owner approved only the disposable Harness permissions
`apps.install`, `apps.workspaces.cleanup`, `core.environments.read` and
`core.environments.manage`, plus a trusted child Core. Normal password setup/login and app
PKCE supplied identity. No provider credentials were copied and no model turn ran. The operator
drove authenticated Harness APIs and the browser UI. Real Codex/Claude stack acceptance remains D16.

## Verified Journey

Harness created `local.d14-checks` with canonical local Git source, no remote, the consented
bootstrap commit and a registered worktree. Its parent installation stayed stopped. Child
`8c8bf079f8d84ecaaa7aaeab2b41c133` used Core port 23824 and application port 24054.
Normal child installation review selected the worktree Docker profile. Browser password login
opened the application and saved a note in its separate test data.

| Case | Observation |
| --- | --- |
| No recipe | Check preview displayed not checked; it did not install tools or run an inferred test. Preview and restart remained available. |
| Real success | A reviewed `.hosty/preview-checks.json` recipe ran `node --test checks.test.mjs` inside the existing `web` service container. Harness displayed passed, exit 0 and actual Node output. |
| Stale source | Changing the tested value invalidated the displayed success. Submitting the old digest returned HTTP 400 with `preview_check_stale`, without executing the obsolete request. |
| Real failure | Running the current recipe displayed failed, exit 1 and the assertion `41 !== 42`. A healthy application did not imply passing tests. |
| Request replay | Replaying the completed request UUID returned the same receipt timestamp without another execution. |
| Timeout | A two-second check spawned a detached descendant that wrote a heartbeat. Timeout stopped the exact immutable service container; the heartbeat did not advance during a subsequent three-second observation. The original note was unchanged. Explicit Restart app restored the service. |
| Build failure | A reviewed Docker build deliberately failed at a step with exit 31. Harness displayed the failed build, service/exit diagnostics and guidance to repair the worktree and restart in the same sandbox. |
| Build repair | Fixing the Dockerfile and restarting built the corrected environment. The child, installation identity and note hash were unchanged. |
| Start failure | A reviewed command targeting `missing-entry.mjs` failed with `app_start_service_exited`. Harness displayed Application start failed; Show service logs exposed the actual missing-module error. |
| Start repair | Restoring the command and using Restart app recovered a healthy preview. Browser reload displayed the original note. The final optional check passed with exit 0. |
| Parent/Harness recovery | Explicit source Core and Harness restarts preserved the session, workspace association and existing child data. A lost restart response was reconciled from its durable successful operation without creating another child. |
| Finish | Harness removed the child root/process, one application container and one cache volume. Child-labelled Docker inventory was empty, both child ports closed and the sandbox panel disappeared. Canonical source remained; all 11 recorded worktree source hashes were unchanged. |

The application installation identity remained `2026-10-17T17:05:13.1835230+00:00`.
The saved note retained SHA-256
`950ae807b4fcaea13d5f17843ca790c711851122d267d3fb0ac85ce93a7b10f8`
through timeout, build failure, launch failure and recovery.

The source Core was launched with its explicit test port and exact project; a launch attempt
without the port conflicted with the main Core's port and was not counted as a successful restart.
A detached launch did not remain available, so subsequent checks used a managed foreground
process. This report does not claim a fix to detached CLI launch behavior.

## Execution Contract

Optional recipes belong to each service's source root. Core validates bounded argv, relative
working directory and timeout, verifies container ownership and uses the immutable container ID.
Execution uses the existing quota-limited service container and its read-only source mount;
there is no host shell or additional check container. Timeout/cancellation stops the service
and all its check descendants, then requires an explicit restart. The UI states this behavior
before execution. Unconfirmed termination remains unknown.

The digest binds source, recipe, manifest and container/image identity. Declared caches and
generated files are excluded from source hashing. Source changes invalidate old success.
Workspace writer locking serializes checks with managed edits. Durable request receipts prevent
blind retries; interrupted/unknown checks require service replacement before another execution.
Readiness is observed separately from test results. Service logs are explicit bounded snapshots;
failed reads and restarts clear obsolete snapshots.

## Resources And Cleanup Boundary

A recovered application `docker stats --no-stream` snapshot reported **83.87 MiB / 2 GiB**
and **0.12% CPU**. This is a point-in-time sample, not a peak-memory or cold-start benchmark.
The single-service fixture used the existing bridge network and had no dedicated network.

Finish removed the child process, data, users, application container and labelled cache volume.
It does not prune Docker development images or the shared builder cache. The exact test-created
image tag was removed separately after Finish. Shared base images and builder cache were retained;
no broad Docker prune ran. Automatic Finish cleanup does not include image/build-cache collection.

The owner-approved temporary 2 GiB limits on main Shell, Workspaces and Marketplace were restored
through ordinary Core-managed recreation. All three returned running with their original
`Memory=0` and `MemorySwap=0`. The main Core remained in release mode on port 7070.

After source-preservation verification, the disposable Harness and parent Core were stopped.
Ports 29301, 28870, 23824 and 24054 closed. The entire `/private/tmp/hosty-d14-20261017` root was
removed, including test credentials, grants, fixture sources and transient data. Browser test tabs
were closed. No raw evidence JSON, log archives or experimental patches are added to the repository.

## Verification

- The exact Core source project built successfully before launch; final affected tests compiled
  it again after the last Core edit. Four pre-existing compiler/platform warnings remain.
- `dotnet test apps/core/tests/Haas.Hosty.Core.Tests/Haas.Hosty.Core.Tests.csproj --filter 'FullyQualifiedName~PreviewChecks|FullyQualifiedName~DockerSourceRuntimeTests|FullyQualifiedName~CoreEnvironmentTests|FullyQualifiedName~AppManagementHttpTests|FullyQualifiedName~WorkspaceInspection|FullyQualifiedName~WorkspaceWorkflow_' --nologo --logger 'console;verbosity=minimal'`
  — **141 passed, 0 failed, 0 skipped**. Coverage includes recipe/source validation, immutable
  container ownership, bounded output, exits/timeouts, writer serialization and HTTP authorization.
- `npm test --workspace @haas/hosty-harness` — **82 files, 696 tests passed**.
- After the final immediate-refresh and log-clearing UI adjustments,
  `npm exec --workspace @haas/hosty-harness -- vitest run web/src/components/preview-checks.test.tsx web/src/components/workspace-previews.test.tsx`
  — **2 files, 8 tests passed**.
- Harness/backend and web lint/type checks passed. Final
  `npm run build:web --workspace @haas/hosty-harness` passed.
- Documentation index, version consistency and whitespace validation passed.

This scope does not repeat the entire Core suite, Windows acceptance, hosted Git publication or
real-provider generation. Broader recovery/security coverage and the real-provider matrix remain
unchecked as D15 and D16 in the owning plan. No commit or pull request was created in this step.

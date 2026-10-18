# Real Harness Agent Child Core Acceptance — 2026-10-14

Baseline: `608739739dbf31a7476c9150a4ce1cdf30c2bb0f` plus the uncommitted sandbox feature in the registered development worktree. Final Core source SHA-256: `ece9d628494c27bbf43d19a908774dceea07b307c7971e07a180342f32595de7` (sorted repository-relative `.cs`/`.csproj` paths under `apps/core/src`, NUL-separated paths/contents, excluding bin/obj). No commits or pull requests were created.

## Outcome

D22 passes on macOS with Docker Desktop. A real Codex 0.160.0 agent using `gpt-6.1-sol` runs through Harness 0.51.0 session `bc73d51c-8084-4ce1-b503-f9a596f3e425`. It chooses and invokes the production environment tools itself. This complements the [manager acceptance](2026-10-14-child-core-manager.md), whose orchestration used a fake agent adapter.

[Authenticated hot-reload screenshot](../features/app-sandbox-runtimes/2026-10-14-child-core-agent-preview.png). The agent changes, measurements and cleanup results are summarized below; raw run outputs and the experimental patch are not versioned.

## Actual Agent Flow

The coordinator supplies a separate parent Core and normal password account, explicit Harness permissions, a session-owned worktree containing the reviewed uncommitted Demo/SDK fixture, cached Linux dependencies, a bounded agent container and a separate Playwright browser. The agent has its own data/worktree mounts and no Docker socket. Its existing Codex login is copied privately for the test and removed afterwards. The coordinator does not create or install applications into the test children on the agent's behalf.

The real agent creates and starts a fresh child, supplies a synthetic account through normal setup, changes the Demo heading, and runs tests, lint and build. It prepares installation through the ordinary child API, signs in with the test password in Playwright, confirms the installation in Core's browser review, selects its worktree and starts the Docker source profile. Parent identities and provider connections are not inherited.

The successful child is `a40b104937884672952966bdf64c4d18`. Both Demo services become healthy. The browser opens the app through its Core launch metadata, observes HTTP 200 identity for the child test user, navigates to People and back, then sees a second heading edit on the same held-open page. No container restart is requested; independent Docker samples retain the same two container IDs. Browser page errors are empty. Final tests, lint and build pass before the agent invokes Finish and verifies the finished receipt through status/list.

Independent inspection confirms separate child data, Docker volumes and generated-file cache binds, a read-only source bind, and UID 1000 with no-new-privileges for both app main processes. The development image's initial cache ownership setup runs as root before dropping privileges; this does not claim that arbitrary `docker exec` commands default to UID 1000. Whole child Core environments retain their documented trusted-Core/shared-Docker model.

## Failures Exposed And Fixed

The first attempt fails with EACCES on empty dependency volumes. The second starts containers but exposes a read-only `next-env.d.ts` write and fallback ports 3100/3101 instead of container port 3000. The agent records both failures honestly and finishes both children. The coordinator fixes the implementation between attempts; those fixes are distinct from the agent's visible source edit.

- Demo dependency preparation accepts ordinary Core execution without requiring the legacy sandbox generation.
- The reviewed development image initializes only declared cache roots, then executes setup and Next as UID/GID 1000 with no-new-privileges. The existing offline sandbox non-root override skips this initialization.
- `sourceMount.generatedFiles` overlays up to 16 declared generated files with separate service-owned caches. Source stays read-only. Tests cover source preservation, cache reuse, service isolation, non-root writability, traversal/overlap and symlink rejection.
- The Demo source profile explicitly sets `PORT=3000` for both services and declares its generated file.

The third full model-driven cycle passes. The coordinator's restart driver initially read the process ID from the wrong status shape; the actual replacement executable/PID were verified through control discovery before the new installation. No primary Core restart occurred.

## Resource Observation

Docker stats were sampled approximately every four seconds during the successful cycle (44 samples). These are observed peaks, not capacity guarantees; host Core RSS and Docker VM overhead are excluded.

| Container | Sampled peak |
| --- | ---: |
| Agent, including its source build | 760.5 MiB |
| Demo frontend | 852.6 MiB |
| Demo backend | 391.6 MiB |
| Separate Playwright browser | 220.4 MiB |

The maximum simultaneous combined Demo service sample is 1243.2 MiB. The agent limit is 4 GiB; this single small-app run does not establish a multi-agent or production sizing recommendation.

## Verification And Cleanup

- `dotnet test apps/core/tests/Haas.Hosty.Core.Tests/Haas.Hosty.Core.Tests.csproj --artifacts-path .artifacts/child-agent-tests`: **3224 passed, 4 existing opt-in integration tests skipped**.
- Affected Core filter covering Docker source, child environments, mixed runtimes and Docker development: **48 passed, 1 opt-in skip**. The exact Core project also builds successfully before the test parent replacement.
- `dotnet publish apps/core/src/Haas.Hosty.Core/Haas.Hosty.Core.csproj -c Release -r osx-arm64 -p:PublishAot=true` with isolated outputs: **passed**. Existing unrelated compiler/platform warnings remain.
- Real agent: `npm test --workspace @haas/hosty-demo-app` (**6 tests passed**), `npm run lint --workspace @haas/hosty-demo-app`, and `npm run build --workspace @haas/hosty-demo-app`: **passed**, including the final hot-reload edit.
- Implementation worktree: Demo tests/lint and the documented `npm run build --workspace @haas/hosty-demo-app -- --webpack`: **passed**. The reviewed Docker development image builds successfully.
- The first full Core test invocation used outputs outside the repository and failed six repository-fixture discovery tests. The complete suite was rerun inside the worktree with the successful result above; this failure is not hidden as a pass.

Finish removes each of the three agent-created Core roots, processes, labeled app containers, networks and volumes. Independent checks confirm no owned leftovers and that the source worktree and agent edit survive Finish. Other containers present at the successful-run baseline remain running at that check. After exporting the patch, screenshot and reports, the coordinator restores only its disposable fixture, releases the clean test worktree through Harness, and removes the temporary parent, agent/browser containers, experiment network and copied provider authentication. The implementation worktree and exported evidence remain.

This run verifies one agent and one app on the selected local host. It does not close the broader plan's outstanding network/mount-consent, dependency grouping, recursive budgets, remote preview or other explicitly unchecked deliverables.

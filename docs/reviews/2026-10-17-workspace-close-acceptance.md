# Workspace Close and Recovery Acceptance — 2026-10-17

Baseline: docker-host `39057d9164ff6b1f9a367a5be169e2413d7790bf` (PR #605), plus the
D2-D3 implementation in the registered `workspace-close-coordination-20261017` worktree.
Versions: Core/CLI 0.138.0 → 0.139.0; Harness/web/worker 0.55.0 → 0.56.0.

## Outcome and Scope

D2 and D3 of [Workspace lifecycle controls](../features/workspace-lifecycle-controls/feature.md)
are verified for the approved shared Docker execution mode. Close durably fences new work before
stopping the owned execution, preserves unfinished source and permits retry after service restart.
It does not establish feature completion or authorize deletion. The completed plan is retired;
current guarantees and required regression coverage live in the feature document.

Native/external activity without verified lease release remains blocked. This delivery does not
claim native filesystem containment, kill unrelated agents or introduce destructive discard.
The browser run uses a deterministic provider fixture, not a paid Codex/Claude model invocation.
Core authentication, installed Harness, session manager, shared Docker worker, actual source writes,
stop verification, API authorization and browser controls use the implemented production paths.
The fixture and all synthetic provider credentials are confined to the disposable test stand.

## Browser and Runtime Acceptance

An isolated macOS Core with a separate data root and port 38017 manages Harness 0.56.0. Normal
setup/password login and the Core app-code flow authenticate the browser; no seeded browser session
or standalone Harness identity substitutes are used. Two local Git repositories provide tracked
README changes and untracked binary files. No production application data is mounted.

1. Start a Harness chat using Shared Docker. The deterministic provider starts an actual Docker
   process that appends to a file in the first worktree. Both repositories remain dirty.
2. Click **Close workspace** while the session is running. Core records closing intent first;
   Harness removes its owned worker and releases its worker/source leases. The panel shows
   `in progress · closed`, the transcript remains visible and retention remains protected.
3. Compare four original text/binary files against their pre-run SHA-256 hashes: all match.
   The writer's output remains present and no longer changes after stop. Docker inspection confirms
   the original container is absent. A follow-up message is refused before agent execution and its
   unsent draft stays in the composer. Explicit **Resume workspace** reopens the retained source.
4. Start another writer and inject a stop failure in the disposable Harness only. Close fails with
   `workspace_stop_unconfirmed`, retains `closing`, keeps the original UUID/revision and exposes
   **Retry action**. New delete/resume requests cannot replace the pending close. The host Docker
   daemon and unrelated containers are not restarted.
5. Restart both test Core and Harness while the stop fault remains enabled. The exact pending close
   receipt survives; the still-running container is not falsely reported as stopped. History and
   draft survive browser reload. Remove the fault and click Retry: the same close operation succeeds,
   all original file hashes still match, previously written output remains a prefix of the final
   file, the worker is absent and no active worker/source leases remain.
6. A final Harness restart/recovery cycle verifies the UI fix: terminal session events refresh
   worker availability without a page reload. The stale recovery warning disappears and the draft
   remains. The final writer file retains 2,200 bytes. Dirty completion and unfinished deletion are
   both refused; source and conversation remain intact until disposable stand teardown.

The failure injection is a reproducible stop-boundary failure, not evidence of a new whole-daemon
outage test. Existing Docker outage coverage remains in the previously accepted worker/sandbox
suites. Browser storage-loss recovery is covered independently by the component regression test;
the browser restart acceptance above retains normal browser storage.

## Regression Coverage

| Contract | Evidence |
| --- | --- |
| Closing admission, dirty/untracked preservation, exact UUID replay and explicit Resume | New `WorkspaceClosureTests`; live Core/Harness/browser run |
| Other owner's shared-worker lease, retired generation and retention/close race | New Core closure cases and existing worker/retention suites |
| Stop before lease release, lost prepare association recovery, external reference collision and completed-receipt replay | Harness Docker/session manager tests |
| Pending close restored without local browser storage; conversation retained | Workspace details component test |
| Stale worker health cleared on terminal events without losing draft | Assistant page component test and final browser recovery cycle |
| All-repository completion, partial merges, dirty/head invalidation, exact provider evidence, released source and optional conversation deletion | Existing full Core/Harness workflow, cleanup and retention suites |
| Unknown/native consumers and authorization denial | Existing consumer/cleanup/HTTP suites; retained leases continue to block close |

## Commands and Results

Run from the registered worktree:

- `dotnet test apps/core/tests/Haas.Hosty.Core.Tests/Haas.Hosty.Core.Tests.csproj --artifacts-path build/d23 --filter 'FullyQualifiedName~WorkspaceClosure_|FullyQualifiedName~WorkspaceWorkflow_|FullyQualifiedName~Workspace_Shared|FullyQualifiedName~SessionRetention'`
  — Core/test build succeeded; 10 passed.
- `dotnet test apps/core/tests/Haas.Hosty.Core.Tests/Haas.Hosty.Core.Tests.csproj --no-build --artifacts-path build/d23`
  — 3,389 passed, 4 skipped. The skips are opt-in Telemetry, Docker development and two Torrent/VPN
  integration cases; they are not claimed as executed by this task.
- `npm run harness:test` — 79 files, 662 tests passed after the final fix.
- `npm run harness:lint` — backend type-check, web ESLint and web type-check passed.
- `npm run build:web --workspace @haas/hosty-harness` — production static UI build passed.
- `docker build -f apps/harness/worker/Dockerfile -t ghcr.io/alex-de-haas/hosty-agent-worker:0.56.0 .`
  — local worker build passed; used only for this disposable acceptance run.

The first full Harness run preceded its static UI build and failed the settings-page asset check.
After building the required bundle, the full run passed. Browser testing also found and fixed a
masked stop error and stale worker health after recovery; the final suite and browser cycle include
both fixes. Existing Core compiler warnings are unchanged.

## Teardown

Verified teardown: test Core and Harness exited; ports 38017 and 28373 have no listeners. All
owned worker containers are absent, the stopped test Marketplace container was removed, and no
instance-owned Docker networks or volumes remain. The newly built unpublished worker image tag
was removed. The complete disposable data root, app caches, binary copy and synthetic credentials
were deleted only after the preservation checks. Existing containers and shared Docker caches were
not removed.

`node scripts/docs-index.mjs --check`, `node scripts/check-versions.mjs` and `git diff --check` pass.
Only implementation, regression tests and Markdown documentation are included; raw evidence JSON,
logs, credentials and fault-injection scripts remain outside the repository.

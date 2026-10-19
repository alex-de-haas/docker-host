# Workspace Resource Controls Acceptance — 2026-10-19

## Baseline And Scope

Verified the uncommitted workspace resource controls on repository baseline
`a7f215dd279a199f2f452853ac5b726534fd6921`, in the registered lease-recovery worktree.
The combined change carries Core/CLI 0.141.4 and Harness/worker 0.58.2. No commit,
publication or main-instance deployment was performed for this acceptance.

The operator authorized one disposable Core at
`/private/tmp/hosty-workspace-controls-20261019/parent`, its Harness workspace/source/resource
permissions, one external read/workspaces MCP credential and one trusted child Core. Normal
bootstrap and password login established the separate administrator; the browser used the
Core-managed Harness origin. No model-provider credential was copied.

This is a native macOS child-Core lifecycle check with synthetic test data. No application
Docker workload was started inside the child. App-sandbox commands and their disposal replay,
permission/owner/context boundaries and failure recovery have automated coverage. This report
does not claim a new multi-service Docker, real-agent or live-data dev-mode acceptance.

## Browser And Recovery Results

| Scenario | Observed result |
| --- | --- |
| Named sandbox | Harness displays its name, runtime state, preview URL and lifecycle controls before repository changes. Lease identifiers are collapsed under Activity diagnostics. |
| Start / Stop / Start | A real child process starts, exits on Stop, and starts with a new PID. The same child root, administrator and synthetic data survive. |
| Pending Close | Close fences new work and persists its original request. The existing child remains available. Start is disabled after Stop while the workspace is closing. |
| Parent restart | The test Core is rebuilt and restarted with its exact source project and `--keep-apps`. The child process remains running; its data and workspace source hashes are unchanged. The original Close request survives. |
| Known sandbox protection | Recovery confirmation is disabled while the sandbox retains its source binding. The message explains that Stop preserves data and Delete releases the binding. |
| Cancel sandbox deletion | Cancelling the dialog leaves the sandbox and source intact. |
| Delete sandbox | Harness calls Finish. The child reaches finished, its directory disappears, both observed child PIDs exit, and its port closes. Workspace source remains unchanged. |
| Revoked external credential | The temporary external MCP credential is revoked before operator recovery; a subsequent request returns HTTP 401. |
| Cancel closure confirmation | Cancelling leaves both reviewed leases intact and removes no source. |
| One-confirmation recovery | One browser confirmation recovers both reviewed leases and automatically completes the original Close request, without reconnecting the external agent. |
| Unfinished source | Closed remains in progress. Complete refuses the untracked change and Delete remains disabled. Resume succeeds with the file unchanged. |
| Completed source | A second clean worktree whose HEAD is already contained in local main closes, completes and deletes normally through Harness. Its worktree directory and branch are removed; the unfinished workspace remains visible. No GitHub PR merge is claimed by this local fixture. |

The browser run found an initially misleading enabled recovery button while a sandbox still
held source. Core already rejected that operation. The final implementation projects sandbox
consumer presence, explains the retained binding and disables confirmation; a Core projection
test and Harness regression test cover the fix. The corrected production UI was rebuilt and
verified in the same test environment.

The unfinished file retained SHA-256
`0983fb2b97a7e5890eca2e53d65a7936ac8cf61ebff918d049028ae460814281`
through sandbox lifecycle, parent restart, Close, refused Complete, Resume and clean-workspace
cleanup. The child data sentinel retained SHA-256
`c95f9c97fed71436ff225e16592ee25b6e8d8ec6a5ab62ab62859f423dcb2f6d`
through Stop/Start and parent restart, then was removed by confirmed Finish.

## Resources And Cleanup

The running native child had sampled RSS of 141.7 MiB on the first start and 145.0 MiB after
restart. These are point samples, not peak measurements or a Docker application benchmark.

After Finish, neither child PID remained and port 31256 was closed. Docker inventories filtered
by the exact parent and child instance labels contained no containers, volumes or networks after
scoped removal of the test applications. The test Core's bootstrap-installed Marketplace container
was removed through that Core; unrelated containers and caches were not pruned.

Harness, Shell and Marketplace were removed only from the test Core through its normal lifecycle.
The parent then stopped normally. No test process or listener remained on 38119, 24308, 31256 or
29970. The entire disposable root, including synthetic repositories, temporary credential files,
permissions, logs and isolated build snapshot, was removed after source-preservation verification.
Screenshots remained outside the repository for the operator; raw evidence was not added here.

The main Core retained PID 79494 and its original process-start identity and generation. Main
Shell and Workspaces retained their original container IDs, start times and unlimited memory
settings. Main Harness's static export was not rebuilt. Movie Studio was not touched. The
implementation worktree and its required activity lease remain because live main services still
consume it; unrelated unfinished work was preserved.

## Automated Verification

All commands ran against the implementation worktree unless stated otherwise:

- `dotnet test apps/core/tests/Haas.Hosty.Core.Tests --filter 'FullyQualifiedName~ResourceControls|FullyQualifiedName~LeaseRecovery|FullyQualifiedName~WorkspaceInspection|FullyQualifiedName~SandboxServiceTests' --no-restore` — 67 passed, zero failed or skipped. This includes the HTTP inspection authority checks and the exact consumer/owner/permission/revision refusals.
- `npm run harness:test -- web/src/components/workspace-lease-recovery.test.tsx web/src/components/workspace-resource-actions.test.tsx web/src/components/workspace-details.test.tsx web/src/components/workspace-previews.test.tsx` — 25 passed across four files. Coverage includes partial recovery, response-loss replay, legacy request migration, new unreviewed leases, stale HEAD, sandbox protection, resource retry and explicit delete confirmation.
- `npm run harness:lint` — passed TypeScript and ESLint checks.
- `npm run harness:build-web` — passed in a disposable source snapshot so the live static export stayed unchanged.
- Scoped `hosty core restart --keep-apps --port 38119 --project <worktree Core csproj>` — successfully built the exact Core project after its last source edit and launched the new test process. Four existing compiler/analyzer warnings remained.
- `node scripts/check-versions.mjs`, `node scripts/docs-index.mjs --check` and `git diff --check` — passed after the documentation update.

Known ordinary-runtime consumers retain backend and component-test protection. The native-only
fixture correctly refused unified dev-plan selection, so no ordinary-app runtime switch or
management-link browser acceptance is claimed. No main application was switched to construct one.

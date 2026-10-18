# App Creation Recovery Regression — 2026-10-17

## Baseline And Scope

Baseline: `34ea0bd2d5bfee6e12ac9d53f151ad61368babe7` (PR #606), plus the uncommitted
app-creation feature through D14 and the D15 fixes described here. The feature continues to reserve
Core **0.140.0** and Harness **0.57.0**. This report records the automated regression portion of
[D15](../features/app-prototype-workspaces/feature.md).

The tests use temporary repositories, actual local Git commands, Core's in-process HTTP pipeline,
recreated services reading durable records, Harness session stores and injected runtime/provider
failures. Durable boundary tests reconstruct the persisted state immediately before/after a mutation;
they do not claim a real operating-system crash or power-loss durability experiment. Browser login,
actual Docker build/start repair and Finish were checked separately in
[D14 QA](2026-10-17-preview-checks-recovery-qa.md).

No main Core restart, running-container reconfiguration, provider credential copy or real remote
publication was needed. In-process authorization fixtures are not evidence of browser login.

## Findings Fixed

1. **Accept locally admitted unknown writer state.** Its activity check used an advisory workspace
   listing that omits unreadable records, and blocked pending operations but not unknown outcomes.
   Reproductions advanced canonical main despite either condition in another same-repository tree.
   Acceptance now reads activity records strictly, reports unavailable records, and blocks pending
   or unknown Git outcomes. Restoring the record permits recovery with the original acceptance
   request; refusal leaves canonical main and the unaccepted worktree unchanged.
2. **Preview actions admitted unreconciled Git operations after restart.** The writer lock checked
   active leases only. Pending/unknown durable Git operations now also block check execution and
   restart until their outcome is recovered. Read-only status remains available.
3. **A retry could erase uncertain creation history in Harness.** A permission refusal after a lost
   response changed pending creation into rejected, despite a possible earlier allocation. Also,
   retrying a previously rejected request did not persist new pending intent. Both paths now retain
   the correct journal state. Manual deletion and automatic retention continue to protect uncertain
   creation; the same request can resume when authority is restored.
4. **Docker loss was labelled as a check timeout.** When service termination can be confirmed,
   transport loss is now interrupted rather than timed out. Failure to confirm termination remains
   unknown, with no invented exit code or successful check result.

The failing reproductions were observed before their fixes. A separate dangling-bootstrap-symlink
probe already passed: no file outside the canonical source was created.

## Coverage Matrix

| D15 area | Evidence |
| --- | --- |
| Source recognition and identity | `AppCreationTests`, `LocalBuildingTests`, `SourceWorktreeTests` and existing lifecycle/source tests cover canonical local Git, separate worktree identity, file-URL/absolute aliases, no-Git/unborn/missing states, source override/clear and private-source ownership. |
| Creation crash boundaries | `AppCreation_RestartRecoversEachBootstrapBoundaryWithoutDuplicates` reconstructs reserved/partial files, written files, Git initialized, persisted commit and updated main ref, then recreates Core services. Each replay installs the same source, leaves exactly one bootstrap commit, creates no remote and starts no runtime. Existing installed-before-receipt recovery also passes. |
| Collisions and replay | Creation tests refuse changed arguments and foreign owners, preserve the chosen author across restart and allocate only one app for concurrent conflicting requests. Harness tests preserve preparation IDs and refuse a second generation turn after ambiguous dispatch. |
| Current HTTP authority | `CreationReplay_RevalidatesCurrentAuthorityWithoutChangingSource` covers install/source permission revocation, member role, disabled account, sign-out, assistant reinstall, another administrator and another session. Replays/readback are denied as appropriate while uncommitted source and canonical HEAD remain unchanged. Existing workspace/app HTTP and external MCP tests cover their separate grants. |
| Paths and source bytes | Existing traversal, symlink, special-file, stale-index/head and scoped-discard tests run alongside the new dangling-bootstrap-link case. Canonical local source cannot enter a managed clone/reset path. |
| Writer recovery | New local-acceptance and preview tests cover unreadable records and pending/unknown Git outcomes. Existing lease, shared-worker, multi-repository closure, interruption/restart and consumer tests preserve ownership until verified release. |
| Local integration failure | `LocalHandoff_FailedGitUpdateAndRuntimeStartRecoverWithOriginalRequests` injects an index lock, confirms main did not advance, then retries the original acceptance after removing the lock. A subsequent failed runtime start stays pending, recovers after service recreation and does not start again on successful replay. Dirty, divergent, stale and leased acceptance refusals remain covered. |
| Publication failure | `Publication_FailedPushPreservesLocalHistoryAndReplaysBeforeCreatingPr` injects a definite rejection and a lost push response. Local commits/files survive; no PR is created before successful push recovery. Successful replay adds no push or PR. Existing tests cover lost PR-create responses, revoked connections, changed requests and merge evidence. The provider is injected; no hosted PR was opened. |
| Retention and source loss | Harness retention covers unfinished/deferred work, unknown resources, pending creation, interrupted close and cleanup replay. `LocalBuilding_UninstallKeepingSourcePreservesDirtyCanonicalAndUnacceptedWork` checks both data-retention choices: dirty canonical files, uncommitted worktree files and unaccepted commits survive uninstall with source kept, and unfinished workspace deletion is refused. Completed-worktree deletion retains canonical source. Existing explicit source-deletion/no-Git behavior remains separately covered. |
| Docker and Finish failures | Runtime tests cover failed image acquisition, partial service start and exact-owner cleanup; child-Core tests cover failed build, Docker loss during Finish, interrupted/partial root deletion, changed identity, reservation retention and replay. Preview checks distinguish exit failure, deadline, interruption and unconfirmed termination. |

## Verification And Boundaries

- Expanded Core regression: **1,111 passed, 0 failed, 4 skipped**, 7m13s. Command:

  ```sh
  dotnet test apps/core/tests/Haas.Hosty.Core.Tests/Haas.Hosty.Core.Tests.csproj --no-restore \
    --filter 'FullyQualifiedName~CoreLifecycleServiceTests|FullyQualifiedName~PreviewChecksTests|FullyQualifiedName~DockerRuntimeAdapterTests|FullyQualifiedName~DockerSourceRuntimeTests|FullyQualifiedName~CoreEnvironment|FullyQualifiedName~SourceWorktreeTests|FullyQualifiedName~AppSourceServiceTests|FullyQualifiedName~Http.AppCreationHttpTests|FullyQualifiedName~Http.DevelopmentWorkspaceHttpTests|FullyQualifiedName~Http.WorkspaceInspectionHttpTests|FullyQualifiedName~Http.AppManagementHttpTests|FullyQualifiedName~Http.ExternalWorkspaceMcpHttpTests|FullyQualifiedName~ExternalDevelopmentWorkspaceTests' \
    --nologo --logger 'console;verbosity=minimal'
  ```

  The four skipped opt-in scenarios are Telemetry mixed-runtime ingestion, Docker development
  reload and the two companion Torrent/VPN scenarios. Their required fixture inputs were not
  supplied. The run includes actual local Git/HTTP tests and injected Docker/provider failures;
  it is not a new live Docker acceptance run.
- Final HTTP authority rerun after ensuring the member fixture retains ordinary Harness assignment:
  `dotnet test apps/core/tests/Haas.Hosty.Core.Tests/Haas.Hosty.Core.Tests.csproj --no-restore --filter 'FullyQualifiedName~CreationReplay_RevalidatesCurrentAuthorityWithoutChangingSource'`
  — **8 passed**, no failures/skips.
- `npm test --workspace @haas/hosty-harness` — **82 files, 697 tests passed**.
- `npm run lint --workspace @haas/hosty-harness` — passed (TypeScript).
- The test command built the exact Core project after the final runtime changes. Four existing
  compiler/platform warnings remain; the new tests add no analyzer warnings. Web UI source did
  not change in D15, so its production rebuild was not repeated.
- Documentation index validation, version consistency and `git diff --check` passed.

The expanded final runs used a dedicated temporary root, removed after confirming its test consumers
had stopped. Raw logs remained outside the repository.

The regression covers existing source lifecycle and publication mechanisms. The new source-loss
review/active-consumer policy remains D5, and attaching local history to an existing remote remains
D10; this report does not claim either feature implemented. Generated multi-stack/live-provider
acceptance remains D16, and final whole-feature delivery checks remain D17. Windows and a new live
Docker outage/browser scenario were not repeated in this step. Existing D14 live evidence is linked
above rather than described as a new run.

Only code, tests and Markdown documentation belong to this change. Raw evidence JSON, logs and
experimental scripts remain outside the repository. No repository commit or PR was created.

# Multi-Repository Harness QA — D8

Date: 2026-10-17. Baseline: feature worktree based on
`34ea0bd2d5bfee6e12ac9d53f151ad61368babe7` (PR #606), including the uncommitted app-creation
implementation and D8 changes verified here. Core `0.140.0` and Harness `0.57.0` are the versions
already reserved for this feature branch; this report does not claim a published release.

## Scope And Authority

The operator authorized `/private/tmp/hosty-d8-20261017/parent` as a disposable test Core, its Harness
permissions (`apps.install`, `apps.lifecycle`, `apps.workspaces.cleanup`, `core.environments.read`,
`core.environments.manage`) and one trusted child Core. Permissions and child launch were reviewed
through the normal Core UI. Separate normal password administrators authenticated the parent and
child. Harness mutation probes used the normal app authorization-code exchange, not a seeded user or
a diagnostic identity token. No Codex/Claude credentials were copied.

The built-in `FakeHarnessAdapter` drove deterministic question, cancellation and continuation
checkpoints in native mode. The Core processes, worktrees, Docker runtimes, data writes, authentication
and browser flow were real. Source fixture edits used registered writer leases. This is not another
real-model generation run; [D16](2026-10-17-real-provider-app-creation-qa.md) owns that acceptance.

The operator separately authorized temporarily limiting main Shell, Workspaces and Marketplace to
2 GiB each and restoring their original settings through Core recreation. Main Core was not restarted
or upgraded. No shared Docker images or build caches were pruned.

## Changes And Regression Coverage

The live browser replay exposed a pending-question card that remained actionable after Stop. Harness
now derives cancellation from ordered session events: old pending questions show Cancelled without
answer controls, answered questions retain their values, and questions from later turns stay usable.
No additional persisted state or backend permission mechanism was introduced.

Added or extended focused tests cover:

- Both source bindings survive app-context removal, native cancellation and manager reconstruction;
  successful continuation releases both, while message attachments stay in separate session storage.
- A lease refusal in the second repository prevents adapter startup without discarding either binding.
- Docker close persists a verified stopped worker when release of the second repository lease fails;
  retry releases the remaining lease before Core close confirmation and Finish.
- Dirty, unmerged or leased work in either repository prevents completion/deletion, including after
  workspace-service reconstruction. Refusal preserves both directories and unfinished file contents.
- Question cancellation before and after answer acknowledgement, replay and later-turn controls.

## Live Results

One Harness session created `test.d8-notes` and `test.d8-counter` through `app-create`. They had
independent canonical local Git repositories and distinct worktrees in one aggregate workspace.
Only the explicitly consented fixed bootstrap commits were created. Both ordinary parent entries
remained stopped with autostart disabled; no remote, publication or PR was created.

The common child Core `5495b9f209b543348488b61197f0bb2f` installed both worktree manifests through
normal installation review and ran two Node Docker preview containers. The browser saved
`notes-preserved-D8` and `counter-preserved-D8` into separate app-data files.

| Checkpoint | Observed result |
| --- | --- |
| Shared preview | Harness showed both repository change summaries (`+11 −2`, three files each), both healthy apps and one child Core. Both previews opened through normal child authentication. |
| Stop at question | Session became cancelled; both source bindings, native leases and child consumers remained. SHA-256 of every regular non-Git file in both canonical repositories/worktrees and both data fixtures matched the baseline. |
| Harness/Core recovery | Restarted Harness and the source-mode test parent with the explicit project/data root. The replacement parent became unavailable after its command executor exited; an explicit source-mode recovery with a live command session restored readiness. The child stayed available and the browser recovered the same session and bindings. No cause beyond the observed launch context is asserted. |
| Transcript repair | After rebuilding and restarting Harness, replay showed Question cancelled without answer controls. A new turn still presented an actionable question; answering completed the turn and released both leases. |
| Close and Resume | Browser Close recorded a closed, in-progress workspace with retained previews. Resume restored the same workspace; both preview values and all source/data hashes remained unchanged. |
| Completion/deletion refusal | Browser Complete reported unresolved repository changes and Delete stayed disabled. Direct Harness deletion returned `workspace_not_completed` (409); conversation deletion returned `workspace_retained` (409). The same workspace deletion refusal held after Finish. |
| Finish and replay | Harness Finish and replay of its original UUID both returned `finished`. Child process and data root disappeared; no child containers, named volumes or networks remained. Both source consumers and leases were empty while all canonical/worktree file hashes remained unchanged. |

Native cancellation retaining leases is deliberate: adapter Stop alone is not evidence that detached
native writers exited. This run does not claim forced native process-tree containment. Docker stop
and interrupted multi-lease release are covered by the focused worker regression, not by killing the
main Docker daemon during this run.

## Resource Observations

Idle/browser verification samples from `docker stats` ranged approximately 140–176 MiB per preview
container with a 2 GiB limit each. One Core observation reported 220,430,336 bytes (210.2 MiB) for the
child process and 302,304,462 bytes (288.3 MiB) across its containers. These are point samples, not
measured peaks or cold-start benchmarks. There was no provider agent container in this native test
adapter run; no inference about Codex/Claude model-run memory is made.

## Automated Verification

- `dotnet build apps/core/src/Haas.Hosty.Core/Haas.Hosty.Core.csproj --no-restore --nologo` — passed;
  the final incremental build had 0 warnings and 0 errors. Isolated CLI source generations reported
  four existing compiler/platform warnings and no errors.
- `dotnet test apps/core/tests/Haas.Hosty.Core.Tests/Haas.Hosty.Core.Tests.csproj --no-restore --filter 'FullyQualifiedName~WorkspaceWorkflow|FullyQualifiedName~WorkspaceClosure|FullyQualifiedName~CoreEnvironment|FullyQualifiedName~AppCreation|FullyQualifiedName~AppSourceSafety' --nologo`
  — 143 passed, 0 skipped, 0 failed.
- `npm test --workspace @haas/hosty-harness` — 82 files, 706 tests passed after the final UI fix.
- `npm run lint --workspace @haas/hosty-harness` — passed.
- `npm run build:web --workspace @haas/hosty-harness` — passed, including static page generation.
- `npm run lint --workspace @haas/hosty-harness-web` — ESLint and TypeScript passed.
- `node scripts/docs-index.mjs --check`, `node scripts/check-versions.mjs` and `git diff --check` — passed.

This coverage is macOS Core with Linux Docker apps. Native Windows, remote production and a new
real-provider run were not performed. Core coverage is the affected filtered suite, not the entire
solution suite. Focused test totals are included in the full Harness total, not added to it.

## Cleanup And Repository Hygiene

After Finish preservation assertions, the test Harness and parent Core were stopped through scoped
CLI lifecycle commands. The parent's disposable Marketplace/Shell installations were removed; no
Docker containers, volumes or networks remained for either test instance. The parent root, test
users, scoped grants, local authorization tokens, fixture repositories and raw evidence were deleted.
Only a browser screenshot was retained outside the repository; agent-created test tabs were closed.

The three main app containers were recreated through normal Core restart. All were running with
`Memory=0` and `MemorySwap=0`, original image IDs and identical mounts. Shell and Workspaces retained
autostart enabled; Marketplace retained it disabled. Main Core remained in release mode.

No raw evidence JSON, logs, credentials or experimental scripts are added to the repository. No
feature commit, PR or publication was requested or created for this D8 turn.

# Local Building Continuation QA — 2026-10-17

## Baseline And Scope

Baseline: `34ea0bd2d5bfee6e12ac9d53f151ad61368babe7` (PR #606), plus the
uncommitted app-creation, local-handoff and D12 continuation changes in the registered
Core worktree. Versions remain Core **0.140.0** and Harness **0.57.0** for this feature.
This report closes [D12](../features/app-prototype-workspaces/feature.md), not the remaining
app-creation deliverables.

The live run used a disposable macOS Core at port 29281, normal password setup/login,
Core-managed Harness in its source runtime and authenticated Harness workspace APIs.
The owner authorized `apps.install` and `apps.workspaces.cleanup` for this test
Harness only. No provider authorization was copied and no model turn was started.
This is an operator/session-lifecycle check; the earlier
[local handoff report](2026-10-17-local-app-handoff-qa.md) covers the real Codex,
Docker preview and ordinary-data portion of D12. It is not a new Docker or memory benchmark.

## Verified Journey

| Step | Observed result |
| --- | --- |
| Create the fixture | The Harness form created `test.d12-notes` with explicit bootstrap consent, canonical local Git, no remote and a registered worktree. The app remained stopped. Missing provider selection was reported without starting a turn. |
| Accept the first change | A fixture file was committed through the Harness workspace API and accepted through the browser's reviewed-head confirmation. Main advanced to `39f956e255de29b38313d974819a06668ddf799b`. |
| Preserve unfinished work | An additional untracked file remained in the original worktree. Chat deletion returned `409 workspace_retained`. Continue building showed Outstanding work and reopened that exact session/worktree. |
| New building session | The browser created a separate worktree from accepted main. It contained the accepted file, excluded the old untracked file and did not alter the original worktree. No agent started automatically. |
| Select another source | An operator-owned alternate directory became the source override. Continue building displayed the reason and disabled new-session creation; existing sessions remained available. Canonical and worktree files were unchanged. |
| Clear the override | The normal Core source-clear action restored the canonical local-Git binding instead of removing it. The alternate directory and its file remained intact. |
| Restart Harness | Core-managed restart produced a healthy replacement process. Reopening the retained session restored the same session ID, worktree and accepted-main observation. A browser tab opened during the outage showed connection refused; a fresh tab after readiness restored the session. |
| Delete completed work | The browser completed and deleted the clean second workspace with its conversation. Its directory disappeared and the session returned 404. Canonical source and the original unfinished file remained intact. |
| Preserve and finish the old work | The outstanding fixture file was explicitly committed and accepted, advancing main to `47731a39d9accc2aa048d62f80c398af24eccc44`. Browser completion/deletion then removed the original workspace/chat. No unfinished work was discarded. |
| Continue after chat deletion | With both app conversations gone, Continue building still listed the installed app. A new browser-created session/worktree contained both accepted files, with unchanged SHA-256 values. |
| Reject stale main | A request using the previous accepted head returned `409 workspace_local_head_changed`. No worktree was allocated. The refused request's empty chat could be deleted normally after reconciliation. |
| Final workspace cleanup | Completing/deleting the third workspace and chat through Harness left the installed app with an empty work list. The browser still offered New building session. Canonical source remained present, clean and without a remote. |

The accepted-file SHA-256 was
`cbaf4cf76f3c52c64324ba7a82bcb90dd39c65d0fc6eba333d7c2fa25620b137`.
The initially unfinished file retained
`257318fa18cd077ed5856e35292172b1645a03b0c6d551e5f4686c19e4692049`
through source changes, subsequent acceptance, chat deletion and continuation.
The alternate file retained
`a3e4c054bdb43a4a0f7a5264c19d1a2c1ee043dbacf34a8fcdaf03d76ef1c97f`.

## Implementation And Regression Coverage

- Core's local-app inventory is independent of chat records and exposes only the current
  user's retained work. It distinguishes accepted commits from dirty/outstanding work.
- New local preparation validates the canonical source, selected main and reviewed commit
  under the same app/repository lock order as source selection and local acceptance.
  Existing preparation replay preserves its original worktree.
- Harness persists session allocation before preparation, reuses request IDs after uncertain
  responses and does not start an agent. A definitive pre-allocation refusal clears its
  retention marker only after Core confirms no worktree exists.
- App-local status/accept/use responses no longer enter the session's worktree list as
  malformed records. Clearing a local-Git override restores its canonical path.
- Automated checks cover original-tree reuse, new accepted-main work, foreign-owner
  filtering, stale heads, alternate-source refusal, source preservation, lost responses,
  Harness restart, persisted browser retries and app discovery without chats.

## Commands And Results

- Exact Core source generation built successfully before launch: **0 errors**, four
  existing warnings. The disposable Core ran that source project.
- `dotnet test apps/core/tests/Haas.Hosty.Core.Tests/Haas.Hosty.Core.Tests.csproj --no-restore --filter 'FullyQualifiedName~LocalBuilding|FullyQualifiedName~LocalHandoff|FullyQualifiedName~AppCreation|FullyQualifiedName~WorkspaceWorkflow|FullyQualifiedName~AppSourceServiceTests'`
  — **39 passed**.
- `dotnet test apps/core/tests/Haas.Hosty.Core.Tests/Haas.Hosty.Core.Tests.csproj --no-build --no-restore --filter 'FullyQualifiedName~Workspace|FullyQualifiedName~LocalBuilding|FullyQualifiedName~LocalHandoff|FullyQualifiedName~AppCreation|FullyQualifiedName~EndpointAuthorization|FullyQualifiedName~AppSourceService'`
  — **164 passed**, no failures or skips. The full Core suite was not repeated for this
  focused continuation change; the earlier report retains its full-suite result and limits.
- `npm test --workspace @haas/hosty-harness` — **81 files, 691 tests passed** after
  the last manager change, including continuation UI and retention regression tests.
- Harness TypeScript checks and web ESLint/TypeScript checks passed.
- `npm run build:web --workspace @haas/hosty-harness` — passed.
- Documentation index, version consistency and whitespace checks passed.

## Cleanup And Limits

The disposable Harness and Core were stopped through their normal lifecycle. The test root,
password/session grants, permission assignments, local repositories and temporary app data
were removed after preservation checks. No D12 Docker container or cache was created, and
the main Core, running applications, provider credentials and Docker limits were untouched.
Only readable Markdown belongs to this report; raw API evidence and logs are not committed.

There was no new provider generation, Docker preview, automatic-retention clock advance,
Windows run or hosted Git publication in this check. Existing retention regression tests
cover the shared cleanup path; manual browser deletion supplied the live source-preservation
evidence. Broader creation/multi-service/provider acceptance remains in the plan.

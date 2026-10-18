# Local App Handoff QA — 2026-10-17

## Baseline And Scope

Repository baseline: `34ea0bd2d5bfee6e12ac9d53f151ad61368babe7` (PR #606), plus the
uncommitted app-creation/local-handoff implementation in its registered Core worktree.
The branch reserves Core **0.140.0** and Harness **0.57.0**. This report verifies
[local-target integration D20 and the local-use portion of D12](../features/app-prototype-workspaces/feature.md).
It does not mark the broader app-creation plan complete.

The test used macOS and Linux Docker containers, one real Codex provider in Harness's
shared Docker worker, Normal approval mode, normal Core password login and authenticated
browser launches. The disposable parent Core used a separate data root and port 29271;
the main Core remained on its installed release at port 7070. No hosted repository,
push, publication or pull request was created. Commits below belong only to the disposable
application; this repository was not committed.

The owner authorized the selected Codex credential copy, the test Harness permission grants
and temporary 2 GiB limits for the main Shell, Workspaces and Marketplace, including the
container recreation required to restore their original unlimited settings. These grants
were applied only to the disposable Core. The credential copy and test root were removed.

## Verified User Journey

| Step | Observed result |
| --- | --- |
| Create app through Harness | `local.handoff-notes` was registered stopped with autostart disabled, canonical local `main`, no remote and a separate managed worktree. |
| Real agent implementation | Codex added persistent notes, protected GET/POST APIs, validation, serialized atomic writes, type checking, build scripts and a concurrent-save persistence test. |
| Agent preview | The agent created a child Core, completed its normal setup and installed/started the Docker app through reviewed APIs. The operator opened it through Core and normal password login. |
| Browser write and restart | A sandbox-only note survived page reload and an agent-requested app restart. The anonymous/invalid-token API probes returned 401; a wrong-origin write returned 403. |
| Source commit | The agent committed seven selected files as `37d0217ad408ba32f86b2370b960d1a3964e162b`. Its first command used the aggregate workspace ID and was refused; the retry used the actual worktree ID without creating a duplicate commit. The worktree was clean. |
| Accept locally | The operator confirmed the displayed source and target commits in Harness. Canonical main fast-forwarded from `a8f82e0ff72bfd6ffcd2c2c010e23a582d660bbf` to `37d0217ad408ba32f86b2370b960d1a3964e162b`. It stayed clean, stopped and without a remote. |
| Use locally | A separate confirmation started the ordinary installation through Core. The panel showed accepted/running and linked to the authenticated app-open route. Autostart stayed disabled. |
| Separate ordinary data | The ordinary app opened with no notes. A new ordinary-only note survived reload and ordinary app restart; the sandbox still contained only its own note. Docker inspection confirmed distinct source/data/cache mounts and read-only source mounts. |
| Harness recovery | A normal Harness restart and browser reload restored the same conversation, accepted commit and running ordinary-app observation. |
| Agent Finish | The real agent observed the child's fresh revision and called Finish with a stable request ID. A subsequent observation reported finished at revision 5. The child process, root directory, container and cache volume were absent. |
| Preserve accepted work | After Finish, canonical source and worktree remained clean at the accepted commit. The ordinary notes file's SHA-256 was unchanged, and the browser still displayed the ordinary-only note. |
| Complete and delete workspace | Complete succeeded using actual local target ancestry without a PR. Delete removed the completed worktree. Canonical main, no-remote Git configuration, ordinary data hash and running browser app were retained. |

Browser interaction covered creating notes, observing empty ordinary data, reloads and the
actual Harness confirmation dialogs. HTTP health or the agent's final message alone was not
used as proof of application UI behavior.

## Fixes And Regression Coverage

- Core authorizes the current owner/session and exact registered canonical local source.
  The internal-source exception does not authorize arbitrary app-state directories or mounts.
- Acceptance requires reviewed heads, clean source/target, fast-forward ancestry, no active
  managed writers and a stopped ordinary runtime before main advances. Preview consumers
  can remain attached to their separate worktree.
- Admission locks are scoped to the repository and shared with prepare/lease/Git operations.
  A concurrency test verifies that another repository remains usable while same-repository
  writer admission waits.
- Owner/installation-bound journals preserve exact request arguments. Tests cover replay after
  target movement before the success receipt, repeated ordinary start, foreign/stale replay,
  divergence, dirty trees and permission refusal. Browser reload restored the completed local
  start; the uncertain-response retry path was covered by automated tests, not a live fault injection.
- The local-status route performs authentication before handling an absent workspace query,
  preserving the existing endpoint authorization sweep.
- A live stopped turn exposed a stale native approval card with Allow/Deny buttons. The UI now
  retains recorded cancellation boundaries and closes earlier unresolved cards on replay,
  without cancelling later requests or replacing explicit decisions. Browser reload verified
  the old card as Cancelled with no action buttons. Focused tests cover these cases.

## Resource Observations

Docker statistics were sampled approximately every five seconds while the generated app and
agent were running. Values are sampled container memory, not guaranteed instantaneous peaks,
not a cold-start benchmark and not the whole Docker VM footprint.

| Component | Samples | Highest sampled memory | Last observed memory |
| --- | ---: | ---: | ---: |
| Shared Codex worker | 169 | 707.4 MiB | 539.4 MiB |
| Child sandbox app | 159 | 161.4 MiB | 128.8 MiB |
| Ordinary app | 37 | 179.3 MiB | 138.2 MiB |

The worker had a 4 GiB ceiling; the child app had a 2 GiB ceiling. The ordinary app used the
normal installation's default resource settings. A separate process snapshot observed about
263 MiB RSS for the disposable parent Core and 134 MiB for the child Core; these are snapshots,
not peak measurements. Interactive approval wait time is not reported as launch latency.

## Commands And Results

Commands below were run from the feature worktree; raw outputs remain outside the repository.

- `dotnet build apps/core/src/Haas.Hosty.Core/Haas.Hosty.Core.csproj --no-restore` — passed,
  zero errors and four existing warnings. This exact source target was used by the test Core.
- `dotnet test apps/core/tests/Haas.Hosty.Core.Tests/Haas.Hosty.Core.Tests.csproj` — the selected
  LocalHandoff, AppCreation, workspace workflow and endpoint-authorization regression run passed
  **31 tests**. The full run finished with **3,425 passed, 1 failed, 4 skipped** in 10m13s.
- The full-run failure was the unchanged
  `LocalCommandRuntimeAdapterTests.StopAsync_PosixPortReleaseLagsRootExit_WaitsUntilPortCanBeRebound`
  case `rootAlreadyExited=false, pidFileOnly=true`, which timed out waiting for a port to be reusable.
  A focused rerun of all four variants passed. This suggests a timing-dependent failure; it does
  not turn the full run into a pass, and no unrelated runtime/test change was made.
- The four skipped opt-in integration cases cover telemetry, mixed Docker development and two
  torrent/VPN flows. Those separate integrations were not enabled for this local handoff run.
- `npm test --workspace @haas/hosty-harness` — **80 files, 684 tests passed** after the approval-card
  change. After retaining cancellation events in the UI stream, the affected chat-controls and
  local-handoff suites were rerun: **2 files, 8 tests passed**; the live browser check also passed.
- `npm run lint --workspace @haas/hosty-harness` — passed.
- `npm run lint --workspace @haas/hosty-harness-web` — passed after the final UI change.
- `npm run build:web --workspace @haas/hosty-harness` — passed after the final UI change.
- The generated application ran `npm run typecheck`, `npm run build`, `npm test` and
  `git diff --check` through the real agent — passed.
- `node scripts/docs-index.mjs --fix`, `node scripts/docs-index.mjs --check`,
  `node scripts/check-versions.mjs` and `git diff --check` validate the final documentation/version set.

## Cleanup And Limits

After proving that Finish and completed-worktree deletion preserve ordinary data, the disposable
ordinary app itself was explicitly removed as part of stand cleanup. The test Harness and parent
Core were stopped. Its stopped Marketplace container, remaining ordinary-app cache volume and
newly built worker image tag were removed using exact identities, without a global prune.

No containers or volumes belonging to the test parent, child or worker remained. The entire
`/private/tmp/hosty-local-handoff-20261017` root was deleted, including the temporary Codex copy,
test users, granted permissions, cookies, source/data and raw stand evidence. Main Shell,
Workspaces and Marketplace were recreated through their normal Core lifecycle; all three were
running with `Memory=0` and `MemorySwap=0`, matching their pre-test settings. Marketplace and
Workspaces were healthy; Shell has no Docker healthcheck. The main Core remained running in
release mode.

This run covers the requested local handoff with Codex. It does not repeat Claude handoff,
Windows, remote publication, multi-service generation, continuation selection or all
retention/source-replacement cases. Their owning deliverables remain unchecked in the plan.
The prior [creation QA archive](2026-10-17-harness-app-creation-local-qa.md) retains the separate
Codex/Claude creation evidence. No raw evidence JSON, credentials or log archives were added here.

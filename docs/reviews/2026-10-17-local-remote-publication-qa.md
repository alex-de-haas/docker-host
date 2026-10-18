# Local Remote Publication QA — D1/D10

Date: 2026-10-17. Baseline: feature worktree based on
`34ea0bd2d5bfee6e12ac9d53f151ad61368babe7` (PR #606), including the uncommitted app-creation
implementation and D1/D10 changes verified here. Core `0.140.0` and Harness `0.57.0` remain the
versions reserved for the whole feature. This report does not claim a release or a feature commit.

## Scope And Authority

The operator selected `https://github.com/alex-de-haas/test.git` for test push/PR and authorized a
copy of the installed `gh` account's authorization only in disposable Core
`/private/tmp/hosty-d110-20261017/parent`. Only that Harness received optional `apps.install` and
`apps.workspaces.cleanup` permissions. Normal setup/password login, app-code exchange, reviewed
permissions and Core-managed Harness lifecycle were used. No production app was restarted, capped
or stopped; Docker containers, images and caches were untouched.

The session used Harness's deterministic in-process adapter to exercise the operator/Git workflow.
No Codex/Claude credential was copied and this run is not evidence of real-provider generation or
Docker preview execution; those scenarios have separate D16 evidence. Git, GitHub push/PR/Actions,
source connection authority and browser interactions were real. Review feedback below is an
explicitly labeled test fixture from the same account, not independent approval.

## Implementation And Findings

The optional remote binding is separate from canonical local source identity. Explicit fetch records
upstream evidence without pulling. A missing branch can be initialized from reviewed accepted main
using a create-only reference lease; unrelated history requires explicit integration in the worktree.
Commits, branch push and PR creation are separate actions. Existing Core publication journaling,
identity, CI and review mechanisms are reused, and pending browser requests keep their original IDs.

The first live push exposed a nested source-connection lock: publication held the connection while
upstream validation attempted to acquire it again. Authenticated Git now borrows the validated
connection and all remote mutation paths acquire connection authority before workspace admission.
Real-Git regression coverage runs push, fetch and status concurrently with actual connection locks.

A second defect hid CI/review facts for a local repository because inspection compared its `.git`
path with a provider repository URL. Inspection now verifies the selected remote, branch and
connection, retaining revocation and published-head checks. The panel labels PRs with their remote
repository name. A recovered detail fetch clears its own transient error without clearing workflow
errors. The creation card says Created locally, avoiding a false not-published claim after a push.

## Live Results

App `test.d110.publication` kept canonical main at
`23b6fb83c01eedcb698c1f1bd7a0382298022035`. Its registered worktree ID remained
`2b3f1504fc1ca36b376ee1bbc83f8e495760a27a97dd9925363445b10a8f3f66` throughout.
The selected repository was empty. The operator-reviewed accepted base was explicitly sent to
`qa/d110-base-20261017`; no `main` branch was created or changed. No automatic pull or source switch
was used. The two test branches remain in the approved test repository as review evidence.

| Check | Observed result |
| --- | --- |
| Connect and fetch | Same app, canonical source, worktree and local target `main`; separate publication target `qa/d110-base-20261017`. UI showed upstream counts and observation time. |
| Reviewed local commit | Browser selected four fixture paths and explicit author/message. Commit `e93ad630175c83e73e47028c3836e6aabfff4825`; canonical main unchanged. |
| Interrupted push | Initial request `dc58d663-5d32-4c8a-86e0-d70e8fc15a1e` timed out during the discovered lock defect. After the fix, test Core restart, normal access renewal and browser Retry, the same receipt succeeded and published that head without a PR. |
| Replay and stale input | Identical commit replay created no new commit; changed arguments with the same ID and stale expected push head were rejected. A later successful push replay retained the same PR and head. |
| PR and initial CI | Harness created draft [test#1](https://github.com/alex-de-haas/test/pull/1). Both [push CI](https://github.com/alex-de-haas/test/actions/runs/39067640494) and [PR CI](https://github.com/alex-de-haas/test/actions/runs/39067667018) failed the intentionally missing Ready prefix. Browser showed CI 0/2 and one unresolved test thread. |
| Fix and CI | A leased worktree edit passed its Node test; browser committed `f1e6e61d71534fbd7b904d5a340800b8f2005cde` and pushed separately. Both [push CI](https://github.com/alex-de-haas/test/actions/runs/39068085306) and [PR CI](https://github.com/alex-de-haas/test/actions/runs/39068088138) passed the test and client build. |
| Review | Core observed the [test review](https://github.com/alex-de-haas/test/pull/1#pullrequestreview-5559977149); Harness resolved its thread only after the fix and green CI. Browser showed CI 2/2 and no unresolved threads. |
| Close recovery | Close retained the native lease and source while stop was unconfirmed. The fixture adapter is in-process and creates no child processes; after verifying its stopped state, its lease was released through Core. Retrying the same close completed, and browser Resume retained the worktree. |
| Completion/deletion refusal | Browser Complete refused unmerged commits; Delete remained disabled. Harness deletion returned `workspace_not_completed` (409). Closing a PR without merge did not turn it into completed work. |
| Source preservation | SHA-256 of every regular non-Git canonical file matched the original baseline; canonical HEAD, worktree identity/path and both review commits remained intact through restarts and refusals. |
| Credential removal | Deleting only the test connection caused repeated fetch to return `source_access_required` (409); source hashes and worktree head were unchanged. |

The PR is closed, not merged, with both checks successful. Its published head matches the second
commit above. Core's complete flag remained false. No remote branch was force-updated or deleted.

A CLI restart without repeating the one-shot port tried its default port and failed to bind; recovery
repeated the explicit `--port 29260` and source `--project`. The final replacement was verified in
source mode with process ID 17734 and start time `2026-10-17T20:43:52.512971+00:00`. This was test-root
recovery, not a restart of the main Core. Native cancellation retaining an unverified lease is the
existing conservative contract, not evidence of detached-process containment.

## Automated Verification

Commands ran from the feature worktree (Harness commands from `apps/harness`):

- `dotnet test apps/core/tests/Haas.Hosty.Core.Tests/Haas.Hosty.Core.Tests.csproj --filter
  'FullyQualifiedName~LocalRemote|FullyQualifiedName~WorkspaceInspection|FullyQualifiedName~Publication'`
  — 135 passed after the final Core change; exact Core project rebuilt successfully. Four existing
  CS9113/CA1416 warnings remain.
- `dotnet test ... --no-build --no-restore --filter
  'FullyQualifiedName~PrivateSource|FullyQualifiedName~SourceProviderTests|FullyQualifiedName~UserConnectionTests'`
  — 86 passed for the authenticated transport/connection changes.
- `npx vitest run` — 83 files, 710 tests passed before the final panel fixes.
- `npx vitest run web/src/components/workspace-details.test.tsx
  web/src/components/local-repository-actions.test.tsx src/sessions/development.test.ts`
  — 26 passed after the panel fixes. The MCP file was rerun with the added mutation/read-only
  classification assertions: 11 passed.
- `npm run lint` — passed. `npm --prefix web run build` — passed after the final label change.
- Test-app `node --test test/publication-label.test.mjs` — passed after the deliberate fix;
  GitHub Actions also installed dependencies, bundled the React client and checked whitespace.

Coverage includes real local Git identity and dirty-file preservation; missing and unrelated remote
history; explicit integration; lost base-push response with one effective remote creation; lost PR
response recovery; stale/mismatched requests; changed source and revoked authority; concurrent
connection use; authorized local-repository CI projection; cancelled UI confirmation; persisted retry
arguments; mutation classification; and transient detail-read recovery.

## Cleanup

The temporary source connection was deleted through Core before shutdown. The test Core and its
Core-managed Harness stopped, and neither port 29260 nor 32707 retained a listener. The full
approved test root was removed, including copied authorization, cookies, users, app source,
worktree, compiled generations and logs. Four test-owned command keepalive processes were stopped
and the owned browser tab was closed. Sanitized screenshots remain outside the repository for the
chat. No evidence JSON, logs, credentials or experimental patches are added to the repository.

This closes D1 and D10 acceptance only. D6, D11, D17 and D18 remain tracked in the feature plan;
whole-feature verification/release and final documentation completion are not claimed here.

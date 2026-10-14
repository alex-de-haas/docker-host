# External Workspace Pull Request Observation Acceptance

Date: 2026-10-14. Implementation baseline: `42344fa20ee129c97edea6f3c00f071b8e2762d7`.
Repository: `alex-de-haas/docker-host`, PR [#590](https://github.com/alex-de-haas/docker-host/pull/590).

## Scope And Result

External workspace references now use the existing Core publication observer and GitHub provider
without creating publication commands. Workspaces displays real provider state, CI results, review
decision, unresolved threads, observation time and remote/local head differences. The external
workspace plan's D1, D2 and D3 are complete; its current behavior is documented in the
[feature](../features/external-development-workspaces/feature.md).

The live request exposed an existing malformed GraphQL selection set. GitHub rejected the old
query with `Expected NAME, actual: (none)`. The query is now a complete multiline selection;
a regression test checks its structure, and the real provider call succeeds.

## Real Provider And Browser Acceptance

A separate local Core data root ran the built feature source with Core-managed Shell and Workspaces.
The fixture imported the existing workspace's repository, branch and PR reference metadata into
its own Git store, assigned to a test administrator created through normal setup. It did not copy
primary users or connections. The existing operator GitHub credential was temporarily connected
through Core's ordinary source-connection API; no new GitHub token was created. Chromium signed in
with the test account's password and opened Workspaces embedded in Shell.

- PR #590 displayed `open`, `Recently observed`, the actual CI check names/results, and
  `No review decision` with **3 unresolved threads**. The absent aggregate review decision did not
  hide the existing review discussions.
- Disconnecting the fixture's GitHub connection removed previously observed CI/review facts and
  displayed the source-connection explanation. Reconnecting restored observations.
- After pushing the implementation commit, the background observer advanced from `5469915e9e`
  to `42344fa20e` without relinking the PR. The browser displayed the new in-progress CI checks and
  `differs from this worktree`, since the fixture intentionally retained its older local checkout.
  Refreshing the view consumed Core's already refreshed observation.
- The feature remains read-only: it does not push source, merge a PR, resolve discussions or release
  worktree ownership. Connection/source authorization is revalidated before cached facts are exposed.

## Automated Verification

Commands below ran from the feature worktree after the final implementation edit.

| Command | Result |
| --- | --- |
| `dotnet build apps/core/src/Haas.Hosty.Core/Haas.Hosty.Core.csproj --artifacts-path .artifacts/external-pr-final` | Passed; four existing warnings |
| `dotnet test apps/core/tests/Haas.Hosty.Core.Tests/Haas.Hosty.Core.Tests.csproj --artifacts-path .artifacts/external-pr-final --filter 'FullyQualifiedName~Publication\|FullyQualifiedName~WorkspaceInspection\|FullyQualifiedName~ExternalWorkspaceMcp'` | 130 passed, zero failed/skipped |
| `dotnet publish apps/core/src/Haas.Hosty.Core/Haas.Hosty.Core.csproj -c Release -r osx-arm64 --artifacts-path .artifacts/external-pr-aot-final` | Native AOT publish passed; four existing warnings |
| `npm test -w @haas/hosty-workspaces` | 17 passed |
| `npm run lint -w @haas/hosty-workspaces` | Passed |
| `npm run build -w @haas/hosty-workspaces` | Passed |
| `node scripts/docs-index.mjs --check` | Passed |
| `node scripts/check-versions.mjs` | Passed |
| `git diff --check` | Passed |

Regression coverage includes persistence, independent references, remote head changes, provider
failure, unrelated URLs, private review-body omission, disabled/expired/disconnected/ambiguous
connections, current source authority, and absence of publication mutations. UI tests distinguish
unobserved from stale facts and verify that disconnected observations do not remain visible.
The full Core suite was not rerun for this focused update; preceding sandbox-suite results remain
in their original acceptance reports. The final documentation-only commit does not change runtime code.

## Cleanup And Limits

The temporary source connection was deleted through Core, the test browser was closed, and the
fixture Core stopped its managed apps. PID 92825 exited, ports 37461/37471/37472 closed and no fixture
runners remained. The fixture data root, test password and session cookies were removed. Raw JSON,
logs and browser artifacts remain outside the repository. The original Core process, PID 91086,
remained running its existing release; this acceptance does not claim it was upgraded.

Tracking requires the workspace owner's reviewed source connection or sole connected matching
provider account. PR repository, head repository, working branch and target branch must match the
workspace; implicit fork or branch reassignment is unsupported. Existing provider pagination limits
remain in force. The observer runs on its existing 30-second cycle; UI observations are snapshots,
not a push subscription. This report verifies CI visibility, not completion of GitHub checks for
commits pushed after the browser run.

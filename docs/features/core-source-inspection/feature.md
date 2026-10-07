---
created: 2026-09-22
updated: 2026-10-07
summary: The development-mode Core row shows branch and changed-file statistics through a read-only Core API.
components: [apps/core, apps/shell]
---

# Core Source Inspection

## Dashboard

The development-mode Hosty Core row shows branch and aggregate changed-file statistics.
Shell does not request source files or diffs: source inspection requires `apps.sources.full`,
which Shell does not declare. The Core inspection API remains read-only and has no discard controls. The Core branch label uses the same monospace size, line height and
dotted underline as app source labels. Release-mode version presentation is unchanged.
The Dashboard polls Core development state every 15 seconds while idle and every
3 seconds during a pending restart. Polling pauses while the tab is hidden and
resumes immediately on visibility; scheduled polls do not overlap. Restart submission
wakes reconciliation without waiting for the idle interval.

## Scope and API

`GET /api/core/source/status` and `POST /api/core/source/diff` require an administrator; app callers also need `apps.sources.full` and return `Cache-Control: no-store`. Diff requests use the
existing `{ path }` body and require browser CSRF validation. These routes reuse
the app source status and diff contracts and bounded Git implementation; Core does
not need an installed runtime app record. Core status marks every file as unavailable
for discard, and there are no Core discard endpoints.

In dev mode the scope is the repository root containing the factual running Core
project. Pending Source settings do not redirect inspection to the selected checkout.
Repository roots and changed-file paths share the same canonical base, including
checkouts reached through a symlinked ancestor. A missing running source remains unavailable rather than falling back to another
checkout. Outside dev mode the API inspects the selected source checkout, while the
Dashboard keeps its release version display.

The Core development summary and file list use the same statistics implementation,
including individual untracked files. Unknown line totals are omitted and incomplete
file counts carry a `+` marker. Paths outside the changed-file list, traversal and
symlink previews are rejected. Missing Git/source, empty repositories, binary files,
images and oversized diffs use the shared viewer's diagnostic and preview behavior.
Source reads do not stage, discard, build or restart anything.

See [Core development mode](../core-dev-target/feature.md) for launch and Source
selection, and [runtime source workflows](../runtime-source-workflows/feature.md)
for app inspection and discard behavior.

## Verification Recorded On 2026-09-22

- `dotnet build apps/core/src/Haas.Hosty.Core/Haas.Hosty.Core.csproj --artifacts-path /tmp/hosty-core-inspection-artifacts`
  passed; five existing compiler/platform warnings remain.
- `dotnet test apps/core/tests/Haas.Hosty.Core.Tests/Haas.Hosty.Core.Tests.csproj --artifacts-path /tmp/hosty-core-inspection-artifacts --filter 'FullyQualifiedName~CoreSourceInspectionTests|FullyQualifiedName~CoreDevelopmentTests|FullyQualifiedName~SourceWorktreeHttpTests|FullyQualifiedName~Worktree_|FullyQualifiedName~SourceStatistics|FullyQualifiedName~SourceImage|FullyQualifiedName~CoreManageability'`
  passed 61 tests. A second run with `--no-build` and filter
  `'FullyQualifiedName~SourceStats_|FullyQualifiedName~ImagePreview_|FullyQualifiedName~BinaryPreview_'`
  passed 33 shared statistics/image tests (these methods belong to the lifecycle fixture).
  The test runner required local socket access outside the command sandbox.
- `npm run shell:test` passed 162 tests; `npm run shell:lint` passed with two existing
  navigation warnings; `npm run build --workspace @haas/hosty-shell -- --webpack`
  passed. The initial default Turbopack build could not bind its worker port in the sandbox.
- `node scripts/check-versions.mjs`, `node scripts/docs-index.mjs --check` and
  `git diff --check` passed. Platform is 0.106.0 and Shell is 0.80.0.
- The Core-managed local Shell verified keyboard opening, file expansion, real diff
  content, split layout and absence of Core discard controls. A Media Server viewer
  retained file selection and its review button. No discard was executed.
- Local Core was rebuilt and restarted with the explicit source project and
  `--keep-apps`. The first replacement exited after its command session; a detached
  source start restored the instance. The replacement has a new process identity,
  the same dev project and all 11 apps running in Dashboard.

PR review verification reran the affected Core suite with the additional symlinked
repository-ancestor case: 95 tests passed. The canonical-root fix, visibility-aware
polling and minor release versions were rebuilt; all 162 Shell tests, lint and the
production webpack build passed. CI on the initial PR revision also passed Core,
CLI and Windows process-control checks.

The full unrelated Core/CLI suites, Native AOT publication and Windows/Linux UI
runs were not repeated for this change; verification targeted the shared source
implementation, Core development behavior, authorization and local Shell flow.

## Testing Expectations

- Verify running versus pending checkout selection, repository-wide file scope,
  summary/list agreement and tracked, staged, untracked and deleted previews.
- Verify missing source and repositories without commits, path traversal rejection,
  symlink rejection, administrator authorization, CSRF and no-store responses.
- Run shared source statistics, diff, image and app discard regression coverage.
- In a Core-managed Shell, open the Core viewer with the keyboard, expand a file,
  switch diff layout, and confirm no discard controls appear. Open an app viewer
  and confirm its selection and review controls remain available.

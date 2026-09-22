# Core Source Inspection

Created: 2026-09-22
Updated: 2026-09-22

## Dashboard

The changed-file summary in the development-mode Hosty Core row opens the shared
source changes dialog. The button supports mouse and keyboard activation. The
viewer lists changed files with line counts and expands individual files on demand.
It uses the same unified/split diff settings, staged-change view and image previews
as runtime apps. Core inspection is read-only; it has no file-selection or discard
controls. The Core branch label uses the same monospace size, line height and
dotted underline as app source labels. Release-mode version presentation is unchanged.

## Scope and API

`GET /api/core/source/status` and `POST /api/core/source/diff` use administrator
session authorization and return `Cache-Control: no-store`. Diff requests use the
existing `{ path }` body and require browser CSRF validation. These routes reuse
the app source status and diff contracts and bounded Git implementation; Core does
not need an installed runtime app record. Core status marks every file as unavailable
for discard, and there are no Core discard endpoints.

In dev mode the scope is the repository root containing the factual running Core
project. Pending Source settings do not redirect inspection to the selected checkout.
A missing running source remains unavailable rather than falling back to another
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
  `git diff --check` passed. Platform is 0.105.2 and Shell is 0.79.2.
- The Core-managed local Shell verified keyboard opening, file expansion, real diff
  content, split layout and absence of Core discard controls. A Media Server viewer
  retained file selection and its review button. No discard was executed.
- Local Core was rebuilt and restarted with the explicit source project and
  `--keep-apps`. The first replacement exited after its command session; a detached
  source start restored the instance. The replacement has a new process identity,
  the same dev project and all 11 apps running in Dashboard.

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

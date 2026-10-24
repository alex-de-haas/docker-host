# Design Adoption Verification Evidence — 2026-10-22

This archive preserves the prior verification notes removed from the design plan during its
2026-10-22 documentation cleanup. The source is the uncommitted Hosty redesign workspace on
baseline commit `20841bebea7eb0e5ac80ee8c0c69abb5e8391d1a`; the notes describe the individual
batches and limitations recorded there, rather than a fresh run against one immutable candidate.
No test, build, provider mutation or runtime acceptance is performed by this documentation edit.

These chronological excerpts are historical evidence, not current deliverables or proof that all
acceptance gates passed. Current behavior belongs to the
[design-system feature](../features/design-system/feature.md), and remaining work belongs to the
[design-system plan](../features/design-system/plan.md). The earlier missing-provider-connection
observation is not a current blocker: the reviewed session subsequently records real command and
MCP output. That observation does not establish PR publication or isolated acceptance.

### Verified Adoption And Remaining Boundaries

The top-strip tools replacement (D11) passes Shell frame-retention, focus, drawer and access-recovery
tests and is exercised through the current Core. Settings navigation and app-management composition
are implemented in part (D29/D30): field/row styling and service/dependency/resource
composition are implemented; full responsive/permission acceptance remains unchecked. Harness's navigation,
column sizes, pinned decisions and workspace cards are implemented in part (D17/D21). Grouped read
and edit activity and bounded command-result persistence are implemented; complete layout and
provider/embedded acceptance remain in D21. The workspace review page
replaces the diff dialog for the existing original-base and uncommitted scopes (partial D23/D24),
retains the conversation, offers per-file Viewed, Unified/Split, wrapping, refresh/retry, keyboard
return and structured selected-line Ask Harness references. Target-branch and immutable published PR scopes, Review changes entries, file thread counts,
side-specific threads, author metadata, replies and resolution are implemented. An earlier batch
adds exact transcript edit bindings, unpublished RIGHT-side working-line evidence against an
explicitly selected PR, and new individual PR comments with durable head/range/request recovery.
D23/D24/D25 remain unchecked for their full provider, embedded and isolated acceptance; implementation
alone does not claim that a real GitHub comment landed. Local overlap remains Changed locally and
never resolves feedback. The owner separately authorized the Core workspace trial on 2026-10-21;
its supported CLI target preserves existing app processes. No real comment, resolution, commit or
PR publication is performed by these checks.

Shell has phone tabs and a retained last-tool sheet, All tools search, page-specific dock minimums,
and visual-viewport sizing (partial D12/D13). Harness has a phone sessions view, a retained accessible
workspace sheet, file-list/file review pages and inline CI checks (partial D26). Core-backed tool
activity/grouping, real software-keyboard testing and full responsive acceptance remain unchecked.

Marketplace's Installed view uses the existing app/user-authorized Core apps API. Its server projects
names, installed versions, source/feed labels, runtime and last update verdict for every installed app;
it omits settings, mounts and local source paths. Open uses Core's installation-bound destinations;
Manage uses the installed Shell's browser endpoint. Read failures are visible with retry. Discover
and detail composition use a desktop in-page pane and narrow detail page (D28); full responsive,
permission and install-handoff acceptance remains unchecked.

The preceding PR-review batch passed the full Harness suite (1053 tests in 115 files), 244 affected Core
tests, Harness production export, lint and type checks, and `npm run core:aot` on osx-arm64 without
trim/AOT warnings. A cold Core build retains four existing compiler/platform warnings. The supported
CLI source restart confirms a new Core process from this registered workspace; all four existing app
process trees are adopted. Shell, Harness and Marketplace retain their active workspace and report
healthy. Normal Hosty renewal restores the retained review. Target-branch review reads the actual
working files through the new endpoints; Unified/Split remain available. Shell renders the normally
authenticated embedded Harness, but the browser tool cannot interact with controls in its iframe, so
this pass does not claim full embedded interaction acceptance. The workspace has no bound PR; actual
GitHub comparison, reply and new-comment acceptance remain open in D23/D24/D25. No real review comment
or resolution is sent.

The transcript activity batch passes the full Harness suite (1118 tests in 122 files), production
web export, API/worker/web type checks and lint. Its regression coverage includes adapter result
correlation, strict bounded metadata, malformed worker envelopes, append-before-cursor recovery,
restored legacy logs, grouped exact-source edits and retained input/Review actions. A temporary
fixture rendered from the actual components verifies desktop and 390 px composition in light and
dark themes; it uses synthetic data and does not establish Hosty identity or provider execution.
No real conversation or provider configuration is changed to create that fixture. Complete live
provider/embedded acceptance remains in D21. That earlier batch changed Harness only; its Core generation remains the baseline for the
subsequent PR-history change.

The next adoption batch adds collapsible PR cards, cached historical summaries, one-time approval
styling, the responsive in-page Marketplace detail pane, Settings row patterns, Manage service,
network and folder composition, parent setup stages and shared loading/empty marks. It passes:

- Harness: `npm run harness:test` (1121 tests in 124 files), `npm run harness:lint` and
  `npm run harness:build-web`.
- Marketplace: `npm run marketplace:test` (141 tests in 17 files), `npm run marketplace:lint` and
  `NEXT_DIST_DIR=.next/d28-check npm run marketplace:build`.
- Shell: `npm run shell:test` (194 Node tests and 390 component tests in 44 component files),
  `npm run shell:lint` (zero errors; three existing warnings), and
  `NEXT_DIST_DIR=.next/redesign-shell-check npm run build --workspace @haas/hosty-shell`.
- Core: affected publication/provider/inspection checks had 93 passes and one test-only array
  equality failure; after correcting the assertion, all 10 history regressions pass. The exact
  Core project build and `npm run core:aot` pass on osx-arm64 with no trim/AOT warnings. Cold builds
  retain the four existing compiler/platform warnings. Independent history review found no blocker.

The authorized keep-apps restart launches a new Core process from this workspace and adopts all
four existing local app process trees. Shell, Harness and Marketplace remain active in the same
workspace. Live Marketplace shows its populated catalog, detail and Installed actions; narrow
Installed/detail keeps its Back route. Live Shell Manage retains Launch/resource observations,
Network and Folders at desktop and 390 px widths. Live Harness review reads the current workspace
file inventory and original-base diff through the new Core generation. PR cards are visually
checked in light/dark and narrow fixtures made from the actual components with synthetic data;
those fixtures do not establish provider or embedded acceptance. These reads change no app configuration, provider account or installation.
Approval repository/branch labels lack factual event bindings and remain omitted. Primary-data size,
resource policy, unsupported folder controls and new update controls are not invented. Full provider,
embedded, mobile-device and isolated acceptance remains in the unchecked deliverables.

The Manage completion and workspace-card batch implements Updates/Permissions, preserves feed,
source and account drafts, guards all source reads by cancellation/generation, freezes stale-read
actions and keeps a selected tab visible on narrow widths. Independent review found these edge
cases and verified the fixes. The duplicate sibling-key warning is corrected. Harness now composes
repository/PR, preview and Used by cards with retained ReUI action menus. Shared changes fix the
brand-soft alias, lime input selection, the then-current focus treatment, readable semantic message colors,
notification severity shapes/labels and additional initial loading/empty states.

- `npm run shell:test`: 194 Node and 413 component tests (607 total) pass, including concurrent
  feed changes, revoked source/feed reads, out-of-order terminal refresh, mounted drafts and
  horizontal-tab reveal. `npm run shell:lint` has zero errors and three existing warnings. The
  exact final narrow field styling passes lint and
  `NEXT_DIST_DIR=.next/manage-final-style npm run shell:build` with TypeScript and route generation.
- `npm run harness:test`: 1125 tests in 124 files pass after updating one stale delimiter assertion
  to check the retained individual application rows. `npm run harness:lint` and
  `npm run harness:build-web` pass. Menu, confirmation, recipe/log/restart and retained-operation
  coverage stays green.
- `npm run marketplace:test`: 141 tests in 17 files pass; `npm run marketplace:lint` and
  `NEXT_DIST_DIR=.next/manage-batch-check npm run marketplace:build` pass. All isolated Next build
  additions are removed from tracked configuration and active development type imports restored.
- Documentation-index, artifact-version and whitespace checks pass. This batch changes no Core
  source and requires no Core restart or additional .NET verification.

Live Shell checks exercise desktop/390 px Permissions disclosure and Updates, including a real
Check now for the stopped Demo App that updates its check time and reports no available update
without starting or updating it. No permission grant or source/feed selection is saved. Harness
loads the current Hosty redesign workspace from the new static output. Full mutation/provider,
light-theme, mobile-device and sandbox acceptance remains in the relevant unchecked deliverables.
The available direct external Core tools expose no sandbox creation adapter; this pass does not
substitute a new source override or invent a lifecycle grant to claim isolated acceptance.

The light/mobile state batch (2026-10-22) extends semantic foreground/soft colors, visible loading,
retry and empty states, long-value wrapping and visible-viewport composition. Shared SDK workspace
frames consume the existing public Hosty theme overrides; no SDK API or package change is needed.
Shell groups the tool picker by app and retains its draft/frame through the 599/600 px transition.
Marketplace preserves labelled cached Installed actions on transient failure, clears protected data
on authorization failure, restores detail/search focus and retains rejected settings drafts.
Harness model-catalog recovery is bound to the exact session/connection/revision. Independent review
found and corrected saturated status backgrounds; 320 px component inspection found and corrected
the thread path shrinking between its badges. Location and badges now occupy separate rows.

- `npm run shell:test`: 194 Node and 416 component tests (610 total) pass.
  `npm run shell:lint` passes with the same three existing warnings;
  `NEXT_DIST_DIR=.next/light-mobile-shell-check npm run shell:build` passes.
- `npm run marketplace:test`: 150 tests in 18 files pass; `npm run marketplace:lint` and
  `NEXT_DIST_DIR=.next/d28-light-mobile npm run marketplace:build` pass.
- `npm run harness:test`: 1128 tests in 124 files pass after the model-catalog binding fix.
  After the final presentation-only corrections, 39 affected tests and then all seven thread
  regressions pass. `npm run harness:lint` and the final `npm run harness:build-web` pass.
  Generated route/type configuration is preserved. Each app build bundles all six local fonts.

Live light-theme checks cover Shell Dashboard/Manage at 390 px and the 599/600 px boundary,
Marketplace catalog/detail/Installed/filter recovery, and authenticated Marketplace and Harness
rendering inside Shell at 390 px. Normal Core APIs supply the observed live app/workspace data;
no installation, grant, provider message or review comment is submitted. The browser tool cannot
activate controls inside these cross-origin iframes, so standalone interactions and component tests
do not establish complete embedded interaction acceptance. Light/dark synthetic fixtures rendered
from the actual components additionally exercise 320 px long references, review/comment recovery,
installed-read failure and feed disclosure with no horizontal overflow. These fixtures establish
styling only. Shell's original System theme preference is restored; temporary QA tabs and preview
processes are cleaned up. Real software-keyboard, provider-mutation, protected-flow and isolated
sandbox acceptance remain in the unchecked deliverables. No Core source or lifecycle changes are
needed for this frontend batch.

## Manifest Icon Batch Evidence

The icon correction passes 24 affected Shell component checks, all 152 Marketplace tests,
40 affected Harness tests, all three app lints and production builds. The Core source reader passes
99 affected tests, including 18 HTTP cases, and the exact Core project build. Independent review
finds and fixes immutable caching of a temporary package fallback; restoration at the same URL is
covered. No manifest schema or metadata format changes. The current Core generation is not
restarted by the build/test checks. The owner subsequently authorizes applying this candidate with
`--keep-apps`. The background launch confirms readiness but exits; supported foreground recovery
starts a new dev Core instance from the same registered project and adopts all four local app
process trees. Shell, Harness and Marketplace report running without errors in Hosty redesign.
A normally authenticated Shell Permissions page loads all three new SVG icons through Core's asset
route with their manifest-relative paths. The source remains uncommitted and the required workspace
lease stays active for the Core/app consumers. This live check verifies the implemented three-app
icon correction; remaining first-party assets and accents keep D4 unchecked. Published catalog
snapshots keep their own vendored assets until normal catalog publication.

The owner extends the same asset-only correction to Plans, Telemetry, Whisper and Demo App.
All seven first-party runtime apps now have their specified cell SVG at `assets/icon.svg`;
Whisper adds `catalogMetadata.icon`, and the other existing references stay unchanged. Runtime
profiles, settings, permissions and `app.0.1` remain unchanged. Required patch releases and copies
are synchronized: Plans 0.7.1 → 0.7.2, Telemetry 0.15.1 → 0.15.2, Whisper 0.1.0 → 0.1.1 and
Demo App 0.17.2 → 0.17.3. The upstream collector and Demo's production `latest` image tags retain
their existing policy. There are no new UI substitutions or source/runtime switches.

The actual four SVGs pass contained-path, XML, size and active-content checks and rasterize correctly.
Their manifest diff contains only release versions/tags and Whisper's optional icon declaration.
Plans passes 137 tests, Demo App 6 and Telemetry UI 15; all three pass lint and isolated production
builds. Whisper's isolated build passes with the existing SDK XML-documentation warnings; its suite
passes 9 tests with one native-inference test intentionally skipped because speech execution is
outside an icon/version change. Version, documentation and whitespace checks pass. Native test
outputs and generated Next configuration stay outside the patch. No installed app, catalog or Core
lifecycle is changed by this four-app batch. Remaining accent/layout adoption keeps D4 unchecked.

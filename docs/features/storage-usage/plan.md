---
status: In Progress
created: 2026-11-06
updated: 2026-11-07
summary: Measure disk usage inside the Core data root and present shared storage snapshots in Shell.
components: [apps/core, apps/shell]
---

# Managed storage usage

The operator approved this scope in conversation on 2026-11-06 and explicitly authorized implementation.
The operator then requested moving the overview into Settings, removing its separate sidebar item.

Measure only the configured Core data root, excluding nested mounts and symbolic-link targets.
Present applications, sources/worktrees, test environments, backups, Core files and unclassified
storage without counting shared resources twice. Use a retained measurement snapshot, an explicit
background refresh and honest partial/unavailable states. Shell uses stacked bars and legends in
its own visual style, with the full overview bar representing measured Hosty storage. Filesystem
free capacity is separate context. App details reuse the snapshot and distinguish owned storage
from related shared resources. History and cleanup actions are outside this approved first version.

## Deliverables

- [x] D1. Implement authorized Core snapshot/refresh APIs, bounded background acquisition, resource classification and safe filesystem accounting.
- [x] D2. Implement Shell storage navigation, category/resource bars and application storage details using the shared measurement.
- [ ] D3. Verify accounting boundaries, access control, refresh behavior and UI states with affected builds/tests and a Core-managed child preview.
- [x] D4. Document the implemented contract, measurement limits and validation; update independent Core and Shell versions.
- [x] D5. Move the overview to Settings under Host, preserve application details, redirect existing overview links and verify navigation.

## Verification

Use isolated fixtures for empty/third-party app registries, hard links, symbolic links, excluded
mount boundaries, unreadable/disappearing files, category totals and snapshot concurrency.
Check anonymous/non-admin denial and reviewed delegated authority. Verify Shell interactions,
loading/partial/error states and same-snapshot application details. Build Core and Shell, run
affected tests and documentation/version validation. Use a managed child Core with synthetic
data and normal password login for runtime acceptance; retain source and export useful results
before finishing the owned preview. Do not change the live runtime. On 2026-11-07 the operator
authorized one PR, CI and code review, required corrections, review resolution and regular merge.

## Current verification

Core's affected 117-test suite passes, followed by 28 storage-specific tests and the final
34-test storage/authorization/generated-JSON batch after the no-store fix. The exact Core
project builds without errors. Shell's full suite passes 208 Node tests and 850 component tests;
the final review batch passes 12 storage tests, scoped lint, TypeScript and a production build.
The Docker production image also builds successfully from the registered worktree.
The final source also publishes Native AOT for osx-arm64 without trim/AOT warnings. Core/CLI
version metadata is 0.177.0 and Shell is 0.122.0; documentation and version checks pass.

A managed source child ran Core 0.177.0 with separate users and synthetic data. Normal browser
password login, anonymous and CSRF denial, explicit refresh, cached replay, additive totals,
hardlink de-duplication, unclassified files and excluded external symlinks pass on macOS.
The earlier child is now finished; its pending Shell approval is no longer a current review link.
Browser UI acceptance remains unchecked under D3. Ordinary-data runtime changes remain outside
the authorized scope. Windows and Linux native execution are not established by the macOS checks;
portable Windows directory-record and 128-bit identity tests pass.

The Settings navigation refinement passes 29 route tests and 72 focused component tests,
including grouped settings, sidebar/mobile navigation, role guards, application details and
legacy links with assistant continuation. Scoped lint has no new warnings; the production Shell
build and subsequent standalone TypeScript check pass. The existing feature versions remain
unchanged within this unpublished working-copy feature.

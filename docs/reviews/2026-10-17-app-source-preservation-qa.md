# App Source Preservation QA — D3/D5

Date: 2026-10-17. Baseline: feature worktree based on
`34ea0bd2d5bfee6e12ac9d53f151ad61368babe7` (PR #606), including the uncommitted app-creation
implementation and D3/D5 changes verified here. Core is `0.140.0`; Harness is `0.57.0`, the versions
already reserved for this feature branch. This report does not claim that those changes are released.

## Scope And Authority

The operator authorized the disposable Core at `/private/tmp/hosty-d35-20261017/parent`, five
optional Harness grants (`apps.install`, `apps.lifecycle`, `apps.workspaces.cleanup`,
`core.environments.read`, `core.environments.manage`) and a trusted child Core. No Codex or Claude
credentials were copied. This is an operator-driven Harness/API/browser check, not another model run.
The real-provider acceptance remains in the [D16 report](2026-10-17-real-provider-app-creation-qa.md).

The later operator reply authorized temporarily limiting the existing Shell, Workspaces and
Marketplace containers to 2 GiB each and restoring them through normal Core recreation. No main Core
restart, upgrade, cache pruning or app-data deletion was performed.

## Changes Verified

- Fresh source/workspace loss facts appear in Core removal and source-selection confirmation.
- Strict durable activity inspection and repository admission fence source mutation against leases,
  sandbox consumers, pending operations and unreadable records. Independent repositories stay usable.
- Explicit source deletion binds file contents to the review, rechecks after runtime removal and
  refuses unknown state, stale consent or an attempt to ignore runtime errors.
- Failed source deletion keeps the installation record; failed source-provenance persistence stops
  removal before the record disappears. Files already removed by an interrupted filesystem delete
  are not rolled back; recovery inspects the remaining state and requests a fresh review.
- Ordinary uninstall preserves canonical local Git and its accepted commit even when app data is
  deleted. A repeat cleanup of an absent installation also retains that source binding.
- Explicit reinstall of the canonical manifest restores local Git provenance without accepting
  edits or silently reassigning the old worktree to the new installation.

The first regression run exposed an overly broad activity gate: an operation in one repository
blocked an unrelated repository. Per-repository gates fixed it; the previously failing concurrency
case passed. Path comparison also normalizes macOS `/var` and `/private/var` aliases. Repeated
keep-source cleanup received its own retention regression coverage.

## Live Harness And Browser Results

| Scenario | Observed result |
| --- | --- |
| Normal login | Separate password administrator setup; Core login and Harness app-origin sign-in succeeded. Diagnostic identity alone was correctly insufficient for a workspace mutation. |
| Create and replay | Harness created `test.d35-source`, a canonical local Git repository and a session worktree. Reusing the original creation request returned the installed allocation. Parent app remained stopped with autostart off. |
| Active workspace | An uncommitted `unfinished.txt` remained visible as `+1 −0` in the protected, in-progress Harness workspace. |
| Sandbox | Harness created a trusted child Core, installed the worktree manifest after normal child-Core confirmation and started the Node Docker preview. The preview required and accepted the child's separate password user. |
| Active-consumer protection | Removal, source override and override clearing each refused with `source_in_use`. A browser-confirmed removal request failed with the same reason; canonical source and worktree survived. |
| Finish and replay | Harness Finish removed the child runtime and data root; the same request UUID returned `finished`. Finished state remained observable after parent restart. No child containers, named volumes or networks remained. |
| Source selection | A reviewed alternate folder was selected; clearing restored canonical source. Canonical, alternate and worktree files were retained. |
| Stale destructive review | Editing an already-untracked canonical file without changing its Git status invalidated deletion consent. The request failed with `removal_source_changed`; the file survived. |
| Keep-source uninstall | Browser confirmation removed the installation and ordinary data while preserving source, accepted commit and unfinished worktree. |
| Restart | Source-mode Core restarted with a new process identity and the same explicit project/data root. Unconfirmed review returned `approval_expired` (409), requiring a fresh review. Retained source was reinstalled explicitly with its original accepted commit. |
| Repeated cleanup | On the final Core build, two keep-source removals, the second with the installation already absent, retained provenance. SHA-256 of every non-Git file in canonical source and worktree stayed identical. Reinstall restored `local-git` and the accepted commit without a new commit. |
| Explicit source deletion | A fresh browser confirmation deliberately deleted canonical source. Every retained worktree non-Git file still matched its SHA-256; the separately selected external folder survived. Harness continued showing the unfinished workspace as protected/in progress. |

No source file was accepted, committed or published by these lifecycle checks beyond the explicitly
consented fixed creation bootstrap. Worktree data was discarded only when the entire named disposable
stand was removed after preservation assertions.

## Automated Verification

- Exact Core build: `dotnet build apps/core/src/Haas.Hosty.Core/Haas.Hosty.Core.csproj --no-restore --nologo` — passed after the final source edit (0 errors; the final incremental invocation had 0 warnings).
- Broad affected regression after the repository-gate fix: `dotnet test apps/core/tests/Haas.Hosty.Core.Tests/Haas.Hosty.Core.Tests.csproj --no-restore --filter 'FullyQualifiedName~CoreLifecycleServiceTests|FullyQualifiedName~Workspace|FullyQualifiedName~CoreEnvironment|FullyQualifiedName~HostPath|FullyQualifiedName~RemovalApproval|FullyQualifiedName~AppCreationHttp' --nologo` — 920 passed, 4 skipped, 0 failed, 7m45s.
- After the final repeated-cleanup correction: `dotnet test apps/core/tests/Haas.Hosty.Core.Tests/Haas.Hosty.Core.Tests.csproj --no-restore --filter 'FullyQualifiedName~SourceSafety|FullyQualifiedName~RemovalApprovalHttp|FullyQualifiedName~LocalHandoff_Admission' --nologo` — 26 passed, 0 skipped, 0 failed, 40s. This set is not additive to the broader total.
- `git diff --check`, `node scripts/docs-index.mjs --check` and `node scripts/check-versions.mjs` — passed.

Four pre-existing opt-in integration tests were skipped by their environment gates: Docker mixed
runtime, telemetry mixed runtime and two Torrent/VPN scenarios. Their companion checkout/VPN fixture
settings were not provided for this source-lifecycle task. The actual D3/D5 Docker preview and browser
flow were exercised separately above. This run does not claim native Windows or remote production
coverage. Runtime-removal failure and a source edit during runtime removal are injected in focused
Core tests; the main Docker daemon was not deliberately failed.

## Review And Recovery Limits

Destructive content review covers at most 20,000 entries and 256 MiB of regular non-Git content,
including ignored files; it does not follow symlinks. Git HEAD/refs represent Git storage. Over-limit
or unreadable source is unknown and deletion is refused; keeping source remains possible when its
activity is known idle. No remote backup is inferred from a remote URL or a clean Git status. Native
filesystem writers remain cooperative and must use registered leases; this is not OS containment.

Removal confirmation uses the existing short-lived review store, not a new durable destructive
operation journal. A failed, expired or interrupted review requires observation and a new confirmation.
Durable creation and sandbox commands retain their existing original-UUID recovery contract.

## Cleanup And Repository Hygiene

Harness and the parent test Core were stopped through their own scoped CLI lifecycle. The child was
already finished, with its data root absent and no matching Docker containers, volumes or networks.
The disposable parent root, test users, authorizations, retained test worktree and alternate source
were then deleted. No provider credential copies were involved.

The three main app containers were recreated through normal Core restart commands and verified
running with `Memory=0` and `MemorySwap=0`. Their image IDs and bind mounts matched the original
snapshots. Shell and Workspaces retained autostart enabled; Marketplace retained autostart disabled.
The main Core stayed on its installed release. Browser tabs opened for this test were closed.

Only implementation, Markdown documentation and tests belong to this feature. Raw JSON, logs,
credentials, temporary scripts and Docker inspection dumps are not added to the repository. No
commit, publication, PR or merge was requested or performed for this deliverable.

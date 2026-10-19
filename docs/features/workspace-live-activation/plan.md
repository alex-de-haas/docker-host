---
status: In Progress
created: 2026-10-19
updated: 2026-10-19
summary: Configure Core development by repository URL and activate selected workspace apps and matching Core source on the current host with recoverable Return.
components: [apps/core, apps/cli, apps/shell, apps/harness, shared]
---

# Core Source And Workspace Activation

## Goal And Approval

The owner approved this direction on 2026-10-19: configure Core's development repository by its full
URL, and provide a reviewed action to use a workspace on the current Core. Select applications from
their explicit workspace bindings. Select Core by repository identity, with a checkbox the operator
can clear. This is a separate feature. The owner requested implementation of D1-D3 on 2026-10-19;
the owner subsequently requested D4 local lifecycle composition and isolated failure verification.
On 2026-10-19 the owner requested synchronizing PR #623 with main, continuing D5 and, where possible, the remaining deliverables in this same PR. D5 implementation and verification are complete, including candidate failure during final readiness; later deliverables retain their verification gates.

The result uses the current host's users, application installations and ordinary data. It creates
no child Core and transfers no sandbox data. Testing the workspace in a
[sandbox](../app-sandbox-runtimes/feature.md) remains an independent action and does not authorize
activation on ordinary data.

## Existing Foundation And Required Difference

At baseline `0135cce554c1ee321aafb553c315938040ab22d2`:

- [Core development](../core-dev-target/feature.md) provides isolated build generations, prebuild
  before Stop, durable restart requests and retained app processes. Source settings contain a local
  override and revision; standard preparation defaults to the official repository and a fixed
  project-relative path. They do not provide a configurable repository identity for workspace matching.
- [Ordinary-app dev mode](../app-development-controls/feature.md) provides plan/apply/status/Return,
  live source, ordinary data, backup and MCP policy. Its managed path supports ordinary Docker
  development profiles. System apps and other profiles retain separate manual behavior.
- [Workspaces](../external-development-workspaces/feature.md) group repository worktrees and record
  explicit app ID, installation and source subpath bindings. Core is not an installed runtime app.
  An app binding does not imply that every component in its repository participates.
- Core and CLI release download origins are separately defined in update code. A source folder's
  current remote or HEAD does not establish which repository produced a running release binary.

Compose these mechanisms into one operation. Do not replace workspace storage, sandbox orchestration,
provider connections or app dev-mode journals with parallel implementations.

## Settled Product Rules

### Core Source Identity

Expose a Core development source with a complete repository URL, tracked branch/ref, project path
relative to the repository root, and the existing configuration revision. The standard project path
can default to `apps/core/src/Haas.Hosty.Core/Haas.Hosty.Core.csproj`, but it is configurable.
An omitted ref resolves the repository's default branch when source is explicitly prepared;
subsequent restarts reuse the selected checkout without an implicit pull/reset.

Use the existing source-provider and Git URL validation/normalization contracts. Match the canonical
repository identity, including host and repository path, rather than a folder name, app name,
hardcoded upstream, branch name, fork ancestry or changed-file list. Equivalent supported clone URLs
can identify one repository; a fork remains a distinct repository. Unsupported or ambiguous identities
produce an explicit diagnostic and cannot auto-select Core.

Public Git URLs need no GitHub account merely to name a source. Private repositories use an explicit,
authorized existing source connection with owner/revocation checks. Do not put tokens in URLs,
configuration, operation receipts or build metadata; do not silently substitute an upstream when
the configured source cannot be read. A complete URL does not promise support for every provider,
authentication method or Git transport.

Keep these facts separate in API, storage and presentation:

| Fact | Purpose |
| --- | --- |
| Configured Core development repository/ref/project | Determines source preparation and Core's participation in workspace activation. |
| Recorded build and launch provenance | Identifies the actual prepared/running build: repository when known, commit, dirty-source indication, project and generation/process identity. |
| Binary update distribution source/channel | Determines release downloads; changing a development URL or entering/returning a workspace does not retarget it. |

Record provenance at build time for release artifacts and managed source generations, including fork
builds. Old/external builds without metadata report unknown; a mutable checkout must not retroactively
change their provenance. Provenance is diagnostic identity, not proof of trust or permission to execute.

For fresh installs, offer the repository supplied by build/distribution metadata as the editable
development default. Where none exists, ask for a source when development is first configured.
Migrate existing official standard-source settings compatibly. Preserve local overrides, dirty
checkouts, current launch identity and prior release selection; do not label an unknown legacy fork
as official. Require explicit source selection before ambiguous matching. Save does not restart Core.
Preparing a different repository uses a distinct managed checkout and never overwrites retained work.

This feature does not redesign release hosting or add a new update-feed protocol. Show the configured
development URL and the existing update origin distinctly, including a fork/upstream mismatch.
The new development setting must never silently change where release updates are obtained.

### Participant Selection

Harness offers **Use workspace on this Core** for an authorized retained workspace, including an
external workspace without a Harness conversation. It opens a review, not an immediate mutation.

| Workspace content | Default selection |
| --- | --- |
| App explicitly bound to the workspace, current installation and usable development profile | Select that app and its bound worktree/subpath. |
| Bound Shell or Harness | Include that app under the same rule; identify its UI/agent interruption consequences. |
| Worktree whose canonical repository matches the configured Core development repository | Select Core using that worktree and the configured relative project path; the operator can uncheck Core. |
| Other app in the same repository but without an explicit binding | Do not add it. |
| Core repository absent, ambiguous or unconfigured | Do not select Core; explain the missing/mismatched identity when relevant. |
| Missing installation, inaccessible source, unavailable project or unsupported development profile | Show the affected bound participant as unavailable with a reason; never silently substitute another source/runtime. |

App selection is independent of Core selection. If only Shell is bound in the Core repository,
the initial review selects Shell and Core, but not Harness or every first-party app. If Core is
unchecked, only Shell changes. If two ordinary apps are bound in separate repositories and neither
matches Core, select those apps without restarting Core.

No changed-path inference is required: a Shell-only or documentation-only change in the configured
Core repository still makes Core a default participant. This deliberately predictable rule trades
an optional extra build for explicit selection. No repository-wide implicit app inclusion follows
from Core's participation.

Use a workspace's existing branch and live edits, not a fresh main checkout. Its branch need not
equal the configured Core tracking branch. Multiple candidate worktrees for the same participant
require an explicit choice; no arbitrary first match. A Core-only workspace can be prepared and
registered against the configured Core source under explicit Core-source authority without inventing
a dummy installed app or binding an unrelated app.

Each supported app can also select an eligible workspace from Shell's runtime controls, with the
same review and backend. Returning one app does not return the rest of a workspace. An empty
selection cannot be applied. Unsupported rows remain visible and can be excluded explicitly.

### Review And Runtime Ownership

The review identifies the target Core/data root and each selected participant's current runtime,
source/workspace, candidate runtime, branch/commit and dirty state, selection reason, build/restart
requirements, permissions, backup coverage and ordinary-data consequences. Show expected UI/agent
interruption when Shell, Harness or Core participates. Preserve checkbox choices while refreshing
facts; changed authoritative inputs invalidate the review before admission.

Keep runtime ownership per app installation, plus one independent Core binding. Different apps may
use different workspaces concurrently. A conflicting activation for the same app/Core must be
explicitly returned or resolved; there is no silent takeover or nested unbounded Return stack.
Existing compatible active trials can be recognized and reused without resetting their original
Return target. Source settings saved during an active activation must not rewrite its captured
previous target or be overwritten by a stale Return.

Live source edits and profile-defined hot reload remain available after activation. Core continues
to use explicit build/restart, not watch. Runtime recipes, permission changes and new services retain
their review/install requirements; a live manifest edit does not expand execution authority.
The operation does not automatically add or restart dependency apps outside the reviewed selection.
Explain incompatible dependency contracts and require the user to adjust the reviewed set.

## Operation, Recovery And Return

Core owns one group plan/apply/status/Return contract. Compose ordinary app dev-mode operations,
native/system lifecycle adapters and the existing Core CLI restart mechanism. Support the actual
Shell/Harness development recipes, including native services; do not impose Docker on Core/system
workloads or remove existing native/mixed runtime capabilities.

1. Validate authority, installations, source identity, paths, recipes, dependencies and conflicts.
   Prepare build outputs/environments and validate backup prerequisites for all selected participants
   before stopping any of them. A preparation/compile failure leaves running services untouched.
2. Persist the group request and per-participant child request IDs, prior runtime/source/artifact
   selections, running states, prepared generations and phase receipts before side effects.
3. Stop only selected writers when a consistent backup or switch requires it. Verify managed-data
   backups before starting candidate code. Quiesce Core-owned state for its consistent snapshot;
   unrelated app processes and data are outside that snapshot and remain retained where supported.
4. Apply the reviewed sequence with dependency-aware stop/start and Core handover. The durable helper
   survives Core replacement and does not depend on the initiating Shell/Harness process staying up.
   Preserve eligible unrelated services through the existing keep-apps/adoption mechanism.
5. Verify each participant's actual launch target and readiness. Reconnect the clients and recover
   status from durable records. An accepted request or HTTP response alone is not successful activation.

Do not claim an atomic multi-process or data transaction. A failure after teardown records exactly
which participants changed, which remain running and what can be retried or returned. Stop admitting
new changes at a failed boundary; retain prepared/prior outputs and source. A failed candidate does
not silently fall back to a different runtime. Cancellation before admission changes nothing;
cancellation after admission stops at a recoverable boundary, not by erasing the operation.

Use stable caller request IDs and deterministic/persisted child request IDs. Lost responses, client
reload, helper failure and Core/Harness restart resume or observe the same accepted operation.
Replaying an old operation must not overwrite a newer activation or recreate resources after Return.
Recovery must also be possible through the authenticated local CLI when Core/Shell cannot start.

**Return to previous runtime** is available per participant and for the selected group. Restore each
captured source/runtime/artifact target and initial running/stopped state. If the prior Core was a
development build, return to its retained target/generation; do not assume the installed release.
Retain the current app/Core data, all source edits and separate sandbox instances. Return performs no
Git reset, commit, merge, publication, automatic data restore or workspace deletion.

Reuse ordinary-app data compatibility acknowledgement. Core state/schema compatibility needs the
same explicit treatment: changed persistent state is not evidence that the previous executable can
read it. Do not start an older Core against changed state without reviewed compatibility acceptance;
retain stopped-state diagnostics and a local recovery path. Restoring a snapshot remains a separate
explicitly authorized operation because it can discard newer data. A group Return can report partial
success; keep unresolved participants and their recovery records visible.

## Authority And Workspace Lifetime

Manual admin controls and MCP call the same orchestrator. Agent tools use the existing **Ask /
Run unprompted / Disabled** policy. Ask reviews the concrete participant selection and consequences;
Run unprompted skips an additional confirmation only where the operator has granted the required
authority. Changing the selection after review needs a new plan. Denial/cancellation before dispatch
must leave the host unchanged.

Recheck source visibility/ownership and private connections, app lifecycle authority and a separately
reviewed Core-management capability whenever Core participates. Existing app lifecycle or workspace
permissions must not acquire Core restart or source-configuration authority implicitly. Harness needs
an explicit Core capability for this new path; ordinary delegated/facade credentials stay insufficient.
Direct MCP retains dedicated Core authority. Do not copy an admin token into Harness to bridge the gap.
Return/recovery may release existing consumers after source revocation but cannot grant access to
new source or start a private prior runtime without its required authority.

Every active app/Core binding is a persistent worktree consumer, distinct from an agent activity
lease and sandbox consumer. Prevent destructive Git/cleanup while used. Coordinate transitions with
existing writers/leases; no implicit lease recovery or cancellation of unrelated agent work.
Workspace Close does not silently stop live apps. Display active ordinary runtimes and an actionable
Return path; completion/deletion retains the existing dirty/unmerged/consumer checks. Releasing an
agent lease, finishing a sandbox or merging a PR cannot release a live runtime binding. Core-only
activation must protect its worktree and retained build inputs across its own restart.

Audit the actor, authorization/review reference, target Core instance, participants, source/build
identity, phase and result without copying secrets or data. Harness and Shell show the same durable
facts and distinguish ordinary-runtime activation from sandbox preview. Reuse event infrastructure
for meaningful progress and recover after missed events/reconnect; do not make a browser tab the
operation owner.

## Deliverables

- [x] D1. Add revisioned Core repository URL/ref/project configuration, canonical matching, public/private source validation and non-destructive migration/preparation; preserve active launches and legacy overrides.
- [x] D2. Record and expose Core release/generation provenance, including forks and unknown legacy builds; distinguish development selection from update origin and verify that source changes never retarget release downloads.
- [x] D3. Add Core-only workspace preparation/registration under explicit authority and a read-only participant planner using app installation bindings and optional repository-matched Core, with deterministic ambiguity and unsupported-profile diagnostics.
- [x] D4. Compose supported ordinary, native/system Shell/Harness and Core participants through existing lifecycle mechanisms; implement preflight/build-before-stop, dependency constraints, consistent managed backups and durable per-participant runtime ownership.
- [x] D5. Implement persistent group/child operation receipts, supervised Core handover, readiness reconciliation, cancellation boundaries and original-request recovery across Core, Harness, Shell and helper failures.
- [x] D6. Implement individual/group Return to captured prior targets and running states, current-data compatibility acknowledgement, Core snapshot/recovery handling and explicit partial outcomes without discarding source/data or unrelated bindings.
- [x] D7. Enforce per-participant source/lifecycle/Core authority through HTTP, CLI, Harness and direct MCP; add the explicitly reviewed Harness Core capability and verify Ask, Run unprompted, Disabled, denial, revocation and replay.
- [x] D8. Add Harness workspace review/activation/progress/Return and Shell per-app workspace runtime selection plus configurable Core Source controls; show actual source, matching reason, Core checkbox, conflicts, interruption and recovery.
- [x] D9. Integrate persistent app/Core consumers with workspace admission, source edits and cleanup; show live runtime users and Return actions without auto-stopping them during workspace Close or sandbox Finish.
- [x] D10. Cover repository/fork matching, source migration, multi-repository selection, multiple workspaces, permissions, drift, backup/build/start failure, replay and Return in the affected Core/CLI/Harness/Shell automated suites.
- [ ] D11. Run isolated Core-managed browser and real-agent acceptance for ordinary apps, Shell, Harness and Core, including Core deselection, live changes, restart/interruption recovery, preserved ordinary data/source and full test-resource cleanup.
- [ ] D12. Complete affected builds, Native AOT, host-specific process-control checks, version consistency and user/agent documentation; publish current behavior in feature.md, update owning feature references, remove this plan and regenerate the index once all deliverables pass.

## D1-D3 Verification — 2026-10-19

The API foundation is described in [current behavior](feature.md). Targeted Core verification passes
47 tests, including source migration/refusal, private access, Core-only HTTP preparation/replay,
participant selection and existing Core-development regressions. The CLI suite passes 240 tests;
its four real-build provenance cases also pass after the final rebuild checks. These tests use
isolated temporary Git repositories/data roots and do not restart the operator's Core or apps.

Verification commands and outcomes:

| Command | Outcome |
| --- | --- |
| `dotnet test apps/core/tests/Haas.Hosty.Core.Tests/Haas.Hosty.Core.Tests.csproj --nologo` | 3,621 passed, 4 skipped, 0 failed; the existing Docker/Torrent integration tests require explicit opt-in environment variables. |
| Core test project with the D1-D3/Core-development filters and separate temporary artifacts | 47 passed after the final source-default persistence fix, including HTTP preparation/replay and worktree/profile ambiguity. |
| `dotnet test apps/cli/tests/Haas.Hosty.Cli.Tests/Haas.Hosty.Cli.Tests.csproj --nologo` | 240 passed; the 4 provenance integration cases also passed again after the final rebuild assertions. |
| `node scripts/check-core-aot.mjs` | Final macOS arm64 Native AOT publish passed with no trim/AOT warnings. |
| `node scripts/docs-index.mjs --check` | Passed after index regeneration. |
| `node scripts/check-versions.mjs` | Passed: platform and channel mirror are 0.142.0. |
| `git diff --check` | Passed. |

The test commands build Core and CLI successfully. Four existing C# / platform analyzer warnings
remain in the Cloudflare, Core application and file-permission code; this batch adds none. The full
Core run preceded the last source-default guard fix, which was covered by the final 47-test group
and Native AOT rebuild. No live host lifecycle operation was performed; its process/generation/project
identity stayed unchanged. Temporary build outputs were removed after the test processes exited.

Browser and real-agent activation acceptance remains D11; no activation UI or group runtime switch
is claimed by D1-D3. Native Windows/Linux handover acceptance remains in D12.

## D4 Verification — 2026-10-19

D4 adds the local composition primitive described in [current behavior](feature.md#local-runtime-composition).
Selected native/system, Docker and mixed profiles share adapter preparation and existing app dev-mode
journals. Core is prebuilt through the CLI before any selected app stops. App managed-data backups
precede candidate startup; Core-owned state is snapshotted only after verified Core exit. Source, prior
runtime references and failed operation phases remain retained.

The disposable Core at `/private/tmp/hosty-workspace-activation-d4-20261019/parent` used normal first-admin
setup and a temporarily authorized `mcp:read` / `mcp:workspaces` token. A local HTTP Git fixture supplied
two explicitly bound native apps (one system installation), an unrelated native control app and the
matching Core project. No provider credentials or operator applications were used.

- Deliberate native setup failure left the original Core and all three HTTP app process identities,
  ordinary-data sentinels and source unchanged. Pre-Stop release allowed source repair under a new
  external lease. A stale review from a replaced fixture Core was retired explicitly.
- Deliberate C# compilation failure left the Core and all three app PIDs/data unchanged. The repaired
  source was prepared and activated using the same request ID after the failure.
- Successful activation changed both selected app PIDs to the registered worktree and replaced Core
  with the prepared project/generation, retaining port 29331. The unrelated app kept its PID, source
  and data. The authenticated administrator session survived. Both per-app journals retained verified
  backup IDs; the Core snapshot archive matched its retained SHA-256. Uncommitted source sentinels and
  the original product worktree were preserved.
- Replaying the active request changed no participant process/source/data and created no new backup.
  Tool-terminal lifetime initially terminated a fixture Core after the test command exited; the
  acceptance was repeated with its terminal held open. This is not supervised-helper acceptance.
- The temporary token was revoked and its workspace authority was refused. All three test apps and
  Core stopped through the owner lifecycle. Their PIDs, five fixture ports and local Git HTTP server
  were verified released before deleting the complete fixture root, credentials, snapshots and sources.
  The operator Core retained PID 10078 and start identity `639280198514215570` throughout.

Automated coverage passes 191 adapter/activation tests and a final 53-test workspace/source/HTTP group,
including preparation isolation, mixed service order, dependency refusal, unsafe backup links,
source/lease drift, release boundaries, startup failure and same-request recovery. CLI passes 242 tests;
the final three snapshot tests also pass after isolating Core snapshot storage from app backup retention
and refusing linked destinations or unreceipted archives without overwriting them.
`dotnet test apps/core/tests/Haas.Hosty.Core.Tests --nologo` passes 3,631 tests with 4 opt-in
integration skips and no failures (16m37s). That broad run preceded the final pre-Stop release and
snapshot guards; the focused final groups above cover those changes. `dotnet test
apps/cli/tests/Haas.Hosty.Cli.Tests --nologo` passes 242 tests; the added third snapshot guard passes in
the final targeted run. Documentation index, version consistency (platform 0.142.0) and whitespace
validation pass. Final `dotnet publish apps/core/src/Haas.Hosty.Core -c Release -r osx-arm64 -p:PublishAot=true`
succeeds after the last snapshot guard change, without trim/AOT warnings. Four pre-existing C# / OS
analyzer warnings remain. Its temporary output was removed after compilation exited. The verification itself created no commit or PR.

This is macOS arm64 local-operator acceptance with native fixture services, not Shell/Harness UI or
real-agent acceptance. Docker/mixed preparation is covered by automated adapters; opt-in Docker/Torrent
integration and actual Shell/Harness handover remain D11/D12. D5 owns detached supervision and recovery
after Core Stop; D6 owns group/Core Return. D7-D9 still own client grants/UI and persistent Core consumer
integration. The synchronous local primitive does not close those deliverables.

## D5 Verification — 2026-10-19

PR #623 incorporates main through `764a92847a8267d171864e2d2a4c667fe5a8ece7` with regular merge
`2d5bea47`, preserving the original feature history. The merge resolves platform and channel metadata
from main's 0.143.0 to 0.144.0 and regenerates the documentation index. Shell and Harness remain unchanged
by this feature's implementation; their later UI/authority deliverables remain unchecked.

D5 introduces detached helper admission, attempt/process identities, independent group/helper/child
receipts, cancellation boundaries, local status/recovery, automatic redrive of abandoned attempts,
exact-target Core handover and actual child readiness checks. It preserves the existing build, app
lifecycle, backup, source and snapshot mechanisms. Helper failures cannot overwrite a later Core
receipt. Completed requests and verified child starts do not repeat runtime effects.

Verification commands and outcomes:

| Command / scenario | Outcome |
| --- | --- |
| `dotnet test apps/core/tests/Haas.Hosty.Core.Tests --no-build --nologo` | 3,694 passed, 4 opt-in Docker/Torrent integration skips, 0 failed (18m26s). |
| Core tests filtered to activation, source/workspace HTTP and CLI launcher regressions | 56 passed before the final narrow child-receipt recovery change. |
| Final Core `ActivationExecution` and `WorkspaceActivationControlHttpTests` filters | 19 passed, including the final lost-child-start receipt regression. |
| `dotnet test apps/cli/tests/Haas.Hosty.Cli.Tests --nologo` | 263 passed after final recovery, terminal-receipt and cancellation-retention changes. |
| `dotnet build apps/core/src/Haas.Hosty.Core --nologo` and CLI build | Passed. |
| Core and CLI `dotnet publish -c Release -r osx-arm64` with separate temporary artifacts | Native AOT passed after the final production edits; no trim/AOT warnings. Four existing Core C#/platform analyzer warnings remain. |
| Documentation index, version consistency and whitespace validation | Passed. |

The broad Core run preceded the final narrow child-start and helper-recovery refinements. The final
19-test Core group, 263-test CLI suite and Native AOT builds cover the final changes.

Three disposable macOS arm64 native Core fixtures used their own source repository, registered
Core-only worktree, normal administrator setup/password login, data root and ports. In each fixture
the initiating CLI exited before the detached helper finished. Acceptance verifies:

- Killing the helper at `core-stopping` and resuming the original group ID reaches the exact candidate
  project/generation and a new factual Core PID, with one verified snapshot.
- Killing the helper during preparation is automatically recovered by the still-running Core using
  the original group ID and a new attempt; no manual retry is needed.
- Cancelling during compilation retires the request before Stop, releases preparation, preserves
  the original Core PID and creates no snapshot.
- Dirty source, the normal user and authenticated session survive; completed replay does not create
  another process or snapshot.
- All test Core/helper processes and Git servers exit, ports are released, and fixture roots,
  credentials, source, outputs and snapshots are removed. An initial fixture run retained a zombie
  child because its Python owner did not reap it; the fixture was corrected, repeated successfully,
  and its earlier diagnostics/root were removed after process-exit checks.

Verification uses disposable roots and issues no lifecycle actions against the operator's Core or apps. These are native local-control acceptance checks,
not Shell/Harness browser or real-agent acceptance. D11 retains those scenarios and D12 retains native
Windows/Linux checks. D6-D9 retain Return, all-client authority/UI and persistent Core consumers.

## D6-D10 Verification — 2026-10-19

Individual Return through Shell restored the Demo app source and running state while Core and Shell remained active in their selected workspace. A subsequent Return from the same panel excludes completed participants; five shared UI regressions and both production UI builds pass. Browser checks cover Core deselection, retained operation progress, reconnect after Core/Shell replacement, workspace selection and current-data acknowledgement. Harness Ask denial, approved deferred dispatch, Run unprompted review and Disabled tool omission were exercised with a real native Codex agent.

Main through `039523e5` is integrated with a regular merge, retaining workspace SSE observation. The merged Core activation/observer group passes 50 tests and the workspace/HTTP group passes 29; Harness passes 857 tests, server typecheck and its production build. CLI passes 271 tests. Core and CLI macOS arm64 Native AOT pass. Final three-host handover CI and the remaining D11 Return/cleanup scenarios retain their gates.

## Continuation

D1-D5 are complete on draft PR #623. The owner requested continuous implementation of D6-D12 on 2026-10-19, followed by verification; this batch is in progress on the same feature branch. Deliverables remain unchecked until their verification passes. Continue with
D6 individual/group Return, preserving the captured previous Core executable/project/generation,
per-app journals, current data and source. D5 recovery does not authorize snapshot restoration or
activation on the operator's ordinary data.

The registered task context remains `core-workspace-activation-plan-20261019`, with worktree ID
`0419fa6872f8313c4248521651b07e8bc89be50cb63f50f7e34358e25212e580`. Acquire an activity lease before
editing. The disposable D4/D5 test instances and credentials have been removed. Keep the PR draft
until all deliverables and their required verification pass; unavailable Windows/Linux acceptance
must remain explicit in D12.

## Delivery Sequence And Scope Boundaries

Implement D1-D3 first, then the operation/Return/authority contracts, then surfaces and consumer
integration. Keep one feature branch/PR for the complete feature. D1-D3 change the platform from
0.141.4 to 0.142.0. Shell and Harness versions are unchanged because their activation UI and tools are
not implemented in this batch. Later implementation follows the repository's per-artifact policy for
components actually changed.

This plan owns configurable Core source and coordinated workspace activation, including system-app
and Core participation. It does not retire source overrides or native runtimes.
[Development Controls D1](../app-development-controls/plan.md#deliverables) retains that separate
migration assessment. The held [source recovery proposal](../runtime-source-workflows/plan.md) is
not reactivated. Existing [Core platform acceptance](../core-dev-target/plan.md) and
[mixed-runtime acceptance](../mixed-development-runtimes/plan.md) retain their broader coverage;
new-operation tests here do not automatically close them.

[Workspace lifecycle](../workspace-lifecycle-controls/feature.md) owns completion, Close and deletion;
this feature adds live-activation consumers and their Return integration.
[Source providers](../source-providers/feature.md) own connections and repository transport.
[Release model](../repository-release-model/feature.md) owns packaging, while
[Core update review](../core-update-review/feature.md) owns release update behavior.
Sandbox creation/testing, app creation/Accept locally/Use locally, remote publication, component
change inference and a replacement UI design system are outside this feature.

The product choices above are settled by the owner's approval. Exact route names and internal data
types are implementation details; they must preserve these contracts and the existing permission
boundaries.

## Verification

Use a disposable Core with its own data root, normal setup/password login, test users, repositories
and app data. That instance represents the current host for activation tests; a child sandbox supplies
independent preview where needed. Do not test by changing the operator's current Core/apps or borrowing
provider credentials without scoped authorization.

- Configure an official URL and a distinct fork; verify supported equivalent URLs, non-matches,
  default/named branch, custom project path, missing project, unavailable private connection and
  revocation. Preserve a dirty legacy checkout and running legacy override through migration.
- Prepare one app, two apps in one repo, two apps in different repos and a Core-only workspace.
  Include Shell without Harness and vice versa. Verify Core's default inclusion by repository alone,
  explicit deselection, no implicit unrelated apps, ambiguous worktrees and missing profiles.
- Start apps A and B from different workspaces; Return A while B remains active. Refuse a competing
  binding for A/Core, stale installation/review and intervening source changes without overwriting
  the newer state. Confirm prior dev targets and initially stopped apps return correctly.
- Exercise ordinary Docker dev, current native/system recipes and Core's prepared generations.
  Keep stable user IDs and data sentinels; edit live code without committing, observe hot reload
  where supported and explicit Core rebuild where required. Keep sandbox users/data separate.
- Test Ask denial/cancellation/approval, Run unprompted and Disabled with a real Harness agent.
  Test app-only permission against a group containing Core and verify refusal before any side effect;
  repeat with explicitly reviewed Core authority. Run manual Shell and direct MCP without a chat.
- Inject compilation, preparation, backup, stop, startup, persistence and helper failures. Drop the
  response after admission; restart Core/Harness and reload Shell during transitions. Retry with the
  original IDs and verify no repeated mutation, false success, hidden fallback or premature cleanup.
- Switch Harness while it initiates the action and Core while Shell remains open. Verify factual
  replacement process/generation identity, unchanged unrelated app processes/ports, session recovery,
  readable progress and CLI recovery when the candidate cannot serve HTTP.
- Modify managed app/Core state, verify compatibility acknowledgement and independent explicit
  restore behavior. Return must retain new source/data; refusal or partial Return must retain useful
  diagnostics and recovery. Never test snapshot restore against operator data.
- Attempt workspace Close/delete, source changes and sandbox Finish while live bindings remain.
  Show the actual blocker and Return action; remove guards only after verified release of the
  corresponding consumers. Finish disposable previews, return test activations, stop the test Core
  and verify owned containers/processes/ports/volumes/generations and credentials are removed while
  borrowed source and unrelated resources remain unchanged.
- Run affected .NET and web tests/builds, Core Native AOT, version/index validation and native
  process-control tests on supported hosts. Report macOS, Windows and Linux results separately;
  Docker Linux app coverage is not native Windows/Linux Core handover coverage. D12 remains open
  for unavailable required host checks rather than claiming static review as acceptance.


## Continued Implementation And Verification — 2026-10-19

The owner authorized continuous D6-and-later work in PR #623, with implementation followed by
verification. D6 now passes the focused Core/CLI Return cases and a real parent-managed child-Core
HTTP activation/Return/replay run. The prior executable, current test user/session, dirty source and
single snapshot were verified. Parent Finish removed the child resources; fixture processes and
ports were verified stopped. Snapshot restore is not performed by Return.

The batch implements D7-D9 and their automated coverage. Harness and Shell production builds pass;
Harness passes 828 tests, Shell 288 and CLI 271. Initial full-suite failures in strict HTTP/MCP
inventories were corrected. Final Core, AOT and live browser/agent acceptance remain in progress;
unverified deliverables above stay unchecked. Browser execution found a shared-checkout dependency
conflict in Harness's scoped npm setup; its recipe now preserves the monorepo dependency set.

Persistent runtime-consumer verification passes the final 24-test Core group. A factual running Core project remains a consumer even after Return; destructive workspace operations are refused while source-edit leases remain allowed. Core Native AOT passes after this change with no new trim/AOT warnings.

The final full Core run passes 3,706 tests with four existing opt-in Docker/Torrent skips and no failures (19m49s). The later 24-test focused run covers the final typed MCP and factual Core-consumer changes. Browser/real-agent execution exposed a stale-review status race and a provider wrapper that omitted confirmed native shutdown; the UI regression passes four tests and the final connection/adapter/manager group passes 81 tests. Shell and Harness web builds pass after the UI change. D11 remains in progress while the same child environment is repaired and exercised again.

Native Windows acceptance exposed the managed Git checkout long-path boundary before activation. Workspace Git now explicitly enables long paths without reading global/system Git settings; a real checkout/edit/inspection/removal regression covers paths beyond 260 characters. The Windows acceptance rerun remains required.

The first Windows correction advances real acceptance past checkout. The follow-up enables long paths in source inspection too and keeps the fixture administrative root short, matching the existing Windows linked-worktree metadata constraint. The regression exercises long tracked files through checkout, source inspection and cleanup. Linux/macOS native activation, Return and helper recovery pass CI; Windows remains pending.

D11 Docker preparation exposed an app-cache boundary failure for generated-file overlays. Candidate Docker source caches now have an activation-specific identity within the owned app cache, separate from the previous runtime and retained across candidate starts/restarts. Return reuses the previous cache. The platform correction is 0.144.1; focused cache isolation tests and repeated live acceptance are required before D11 closes.

D7 verification passes the HTTP/direct MCP/CLI/Harness authority suites and real native-agent policy acceptance: Ask denial admits no operation, Ask approval dispatches the exact reviewed participants after confirmed exit, activation_plan runs unprompted under its explicit read policy, and Disabled activation_list is absent from the actual agent tool inventory without a fallback call. No provider credentials are copied into the child environment.

Windows managed checkout and long-file inspection now pass their native regression. Its full acceptance advances to Core compilation; the fixture now retains the standard Windows SDK directory environment required by NuGet without inheriting provider credentials. The long-file test also exceeds 260 characters under Linux short /tmp roots. The prior full Core CI run passes all other 3,709 tests (four opt-in skips).

Full Core/Shell/Docker Demo Return exposed the previous Core's autostart reconciliation stopping an already-returned manual Docker app. The CLI now captures returned installation/target/running state before Core Stop, records the observed boot boundary durably, and restores only matching targets before confirming health. Repeated browser group Return succeeds with all three apps healthy and the exact captured previous Core generation. CLI passes 278 tests, the affected Core group passes 37 tests, and final Core/CLI macOS arm64 Native AOT succeeds. Platform advances to 0.145.1.

Windows activation, Return and completed replay pass; its last failure is cleanup of read-only Git objects. The fixture now clears read-only attributes only within its owned disposable root after process/port checks. The final Windows return/recovery rerun remains required.

---
status: On Hold
created: 2026-10-16
updated: 2026-10-18
summary: Deferred source-recovery proposal pending workspace and sandbox validation and the decision on legacy overrides and native runtimes.
components: [apps/core, apps/cli, apps/shell]
---

# Reliable Source Selection And Recovery

## Reconciliation With Shipped Development (2026-10-18)

This recovered proposal remains On Hold. The observations below are historical evidence from the
stated old checkout, not a re-verification of defects in current main. Unified ordinary-app dev mode
has since shipped with live changes, backup, recovery and Return; see
[Development Controls](../app-development-controls/feature.md). Sandbox preview uses a separate
child Core and synthetic data; an explicitly authorized live-data trial uses the existing Core.
The owner now requests managed workspaces/sandbox as the default development workflow and removal
of obsolete local override settings. That operational cleanup does not remove override support,
native runtimes or the unified live-data dev mode from the product. D1-D6 require reassessment
against current code before any implementation is approved.

## Owner Direction And Hold (2026-10-16)

The owner paused this proposal before implementation to align it with the workspace/sandbox
development model in [vision decision 46](../../vision.md). Hosty owns source preparation and
repository worktrees for internal and external agents. Test runs use separate sandbox instances;
ordinary development does not substitute a worktree for an installed app's source.

Source-based execution remains part of the target. Restricting or removing host-native
`localCommand`, retiring arbitrary overrides and replacing the current installed-app dev workflow
are conditional migration options, not approved removals. Validate the new journey and obtain the
owner's acceptance first. [Development Controls D1](../app-development-controls/plan.md#deliverables)
owns that migration decision; [external development](../external-development-workspaces/plan.md)
tracks the missing direct-client workflow, and [Sandbox](../app-sandbox-runtimes/plan.md) owns test
execution.

The target design and D1-D6 below retain the earlier recovery proposal for evaluation. They are
not approved contracts: in particular, do not introduce a permanent Standard/Custom selection model
or invest in the old dev-mode UI before deciding which compatibility behavior survives. Re-scope
or retire deliverables explicitly after that decision, preserving their IDs. The observed defects
remain useful regression cases. The current Plans/Harness configuration recovery is complete and
does not approve implementation of this proposal or further live-runtime changes.

## Goal

Selecting Standard Hosty source and starting a source runtime prepares the repository declared by
the installed manifest, regardless of whether that manifest originally came from a URL or a local
folder. An unavailable custom folder has a precise diagnosis and an explicit recovery action.
Source selection, update discovery and workspace lifetime remain separate responsibilities.

This extends [source workflows](feature.md). It does not remove local overrides or implement the
assistant lifecycle authority planned in [app development controls](../app-development-controls/plan.md).

## Evidence And Current Behavior

On 2026-10-16, an installed Harness used the `local` source runtime with a repository URL, branch,
managed checkout and recorded commit. Its temporary install folder had been removed and its
`ManifestUrl` was null. Clearing the override still left Start failing with
`local_command_source_root_required`, even though its managed checkout existed.

At repository baseline `f146d0ddd810eeaaa1d9cc922bf6c000a6d1d3e2`:

- `EnsureLocalCommandSourceReadyAsync` refuses standard source preparation when `ManifestUrl` is
  empty. `UsesPinnedSourceCheckout`, `ResolveLockedSourceRoot` and `UpdateMovesSourcePin` also use
  installation provenance to decide runtime source behavior.
- `ResolveLiveSourcePath` can fall through from a missing override to another folder while later
  startup validation rejects that same override. Display, manifest loading and execution can disagree.
- `HostPathAuthority.OverrideAsync` reports only that a folder does not exist. A saved, missing
  override can also block an image-only runtime which does not execute from it.
- `BuildAppRecord` retains the first `InstallManifestPath`. A later explicit local-manifest update
  therefore cannot reliably replace a stale update pointer. A local preview can clear `ManifestUrl`
  while preserving a feed and an older managed source pin.
- The Shell Standard source card does not explain automatic materialization, effective source
  selection, missing-source recovery or the distinction between a saved override and an active one.
- Core workspace cleanup already rejects selected installed-app overrides and known runtime
  consumers. External filesystem deletion or Codex worktree archival does not pass through that gate.

The live recovery restored the official Harness manifest URL through a reviewed update. A subsequent
check exposed an older source pin: the installed manifest was 0.54.0 while that pin contained 0.53.0.
This is a regression case for the local-preview-to-standard transition, not grounds to advance pins
silently during ordinary startup.

## Earlier Proposed Behavior Pending Reassessment

### Explicit Selection And One Effective Source

Record an explicit Standard or Custom choice independently of manifest/update provenance. Keep
existing override fields and migrate legacy records without changing the source they execute from.
An explicit Standard save supersedes both a saved override and the original local-install fallback;
a subsequent manifest rebuild must not recreate the cleared selection from an old install path.

Resolve effective source once for source readiness, manifest loading, runtime context, source
inspection, update planning and path-consumer reporting. Report the selected and effective modes,
absolute path, repository/ref or pin, availability and any reason that a saved custom folder is
inactive under the selected profile.

Preserve the existing reviewed-profile contract: a remote reviewed source runtime uses its managed
pin; development profiles can execute editable source. Do not make saving a custom folder bypass
the development marker or silently change legacy folder-runtime behavior. Show an inactive saved
override as inactive and name the required runtime choice.

| Effective choice | Start behavior |
| --- | --- |
| Standard, declared repository, checkout absent | Prepare the managed checkout from the installed source declaration and existing private-source authority. |
| Standard, reviewed source profile | Materialize the recorded pin; resolve the declared ref under existing rules when no pin exists. Preserve dirty-checkout refusal. |
| Standard, development profile | Materialize on first use; retain existing local edits and current checkout on subsequent starts, without implicit pull or reset. |
| Custom, folder present and applicable to runtime | Execute from that folder under existing path and manifest-review rules. |
| Custom, folder missing | Refuse before teardown, naming the path and offering explicit Standard or another Custom folder. Never silently execute different code. |
| Standard, no usable repository declaration | Explain that automatic download is unavailable and offer a custom folder or a reviewed manifest/source correction. |
| Image/prebuilt runtime without a source-folder dependency | Do not require an unused saved override to exist; retain validation for actual source mounts and relative prebuilt artifacts. |

The startup path uses the installed manifest, not an unreviewed latest remote manifest. An ordinary
Start does not advance a valid pin, conceal a source/manifest mismatch or perform an implicit update.
Existing legacy missing-pin recovery remains explicit in diagnostics and covered by its tests.

### Recovery And Errors

Use structured reasons for missing custom folder, absent standard checkout, missing repository,
Git/network/authentication failure, unavailable revision, nonempty invalid checkout and local edits.
Keep the useful underlying diagnostic. Distinguish preparation progress from a stopped app error.

The Shell Source dialog and lifecycle error expose the same effective source and recovery action.
For a missing custom folder, show its absolute path and actions to choose another folder or select
Standard. Explain the runtime consequence before saving; retain existing administrator/confirmation
requirements. Standard selection itself does not restart a running app. Start/Restart prepares the
checkout and reports cloning, fetching, dependency setup, build and readiness as applicable.

Read-only source status never downloads files. Predictable source failures are checked before
stopping a running app, then rechecked during startup to handle concurrent filesystem changes.
Network/setup failure preserves the selected source and reports a retryable outcome without
claiming readiness or silently changing runtime.

### Update Discovery And Reviewed Transitions

Keep a known feed or manifest update reference when temporarily selecting development source.
Do not invent a manifest URL from an arbitrary Git repository. Replacing an update source requires
an explicit reviewed choice; ordinary Start does not repair it by reinstalling the app.

An update from a local preview to a standard source target resolves and reviews the target commit
from the candidate selection even if the current record has no `ManifestUrl`. Applying it records
the reviewed commit before starting, so the displayed target version and launched checkout agree.
An explicit update from a replacement local manifest adopts that path for subsequent checks rather
than retaining an obsolete first-install path.

### Workspace Lifetime

Reuse Core's existing consumer and cleanup checks. Account for selected source, active execution
paths and still-used local update references, including stopped apps that need the folder on next
start. A merged PR is not evidence that no application still uses its worktree.

For external agents, document a pre-cleanup check of app and Core source bindings and active
consumers. If a temporary runtime selection was authorized, restore the prior durable selection
through supported APIs and verify it before removing the workspace; otherwise leave the workspace
and report the dependency. Core cannot prevent arbitrary external deletion, so runtime recovery
must work even when this discipline was bypassed. Do not automatically switch a live app as a
side effect of cleanup or expand workspace grants into lifecycle authority.

## Deliverables

- [ ] D1. Add explicit source selection with conservative legacy migration and one effective-source resolver shared by runtime preparation, live-manifest loading, inspection and source-pin planning.
- [ ] D2. Prepare Standard source from the installed repository declaration without requiring a manifest URL; preserve pins, local edits, private-source checks and runtime-specific source dependencies, with source preflight before teardown.
- [ ] D3. Add structured source readiness and recovery diagnostics to Core/CLI and the Shell Source dialog, including missing-folder paths, applicable actions, inactive overrides and preparation progress.
- [ ] D4. Preserve durable update references across temporary source selection, adopt explicitly reviewed replacement manifest paths and review/materialize the correct target pin during local-to-standard updates.
- [ ] D5. Reuse and test workspace consumer protection for selected/active source and local update references, and document external-agent restoration and verification before worktree cleanup in repository guidance.
- [ ] D6. Complete automated and Core-managed recovery verification, update current feature documentation, bump affected implementation artifacts, remove this plan and regenerate the documentation index.

## Delivery And Verification

Resume only after the workspace/sandbox acceptance and retained-compatibility decision above,
followed by explicit approval of a revised plan. The earlier sequence was D1-D2, D3-D4, then D5-D6
in one feature branch and PR; it is not an instruction to start work while this plan is On Hold.
This plan change is documentation-only with no version bump. The earlier proposal changes Core/CLI and
Shell and requires their version bumps under the repository policy; it does not require a Harness
artifact change merely to recover its installation.

Test URL, feed, local-file and local-folder installation origins across reviewed source,
development, image, prebuilt and mixed profiles. Include absent checkout, linked checkout,
missing custom folder, no repository, relative/local repositories, private grants, offline Git,
missing revision and staged/unstaged/untracked edits. Test clear-selection followed by update,
restart and runtime switch so legacy install paths cannot resurrect an override.

Verify initial source failure preserves a running process, a concurrent deletion remains explicit,
and a source update from a null-URL installation binds the candidate commit in its digest and
executes that commit. Check persistence across Core restart and ordinary no-argument update checks.
Extend cleanup tests to selected but stopped apps and retained execution paths; retain unrelated
workspace contents and existing authorization boundaries.

In an isolated Core-managed instance with normal administrator login, install from a temporary
worktree, reproduce its removal, recover through Shell to Standard and verify actual process
identity, working directory, checkout HEAD and readiness. Also exercise first start with no
managed checkout and a meaningful network failure. Do not use standalone app launch as evidence.
Run affected Core/CLI/Shell tests and builds, version consistency, documentation validation and
diff checks. Record unavailable platform checks explicitly.

## Approval

On Hold by owner direction on 2026-10-16. Implementation has not started. The owner has not approved
the earlier source-selection contract or removal of any runtime/override. Revisit after the new
development journey has been exercised and accepted.

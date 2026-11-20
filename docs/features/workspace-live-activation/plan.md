---
status: Blocked
created: 2026-11-20
updated: 2026-11-20
summary: Switch a live app by stopping it, backing up its data, selecting a workspace and using normal startup, with manual package return and data restore.
components: [apps/core, apps/harness, apps/shell]
---

# Switch a live app and fix it in its workspace

## Goal

An operator can run unpublished code against an installed app's ordinary data, fix a build
or startup failure in that same worktree and start the app again. This also covers switching
Harness itself. An operator with a working Shell can recover Harness from Dashboard.

The owner approved this change on 2026-11-20. The [execution selector](feature.md) delegates
builds to runtime startup after selecting an ordinary app workspace. The supervised handover
of the Core process keeps its existing contract.

## Target behavior

1. Confirm the manual selection with the app, workspace and live-data warning. Core checks
   the installation, source binding, manifest, permissions and applicable settings. Any
   additional authority goes through the existing access review. These checks run before Stop.
2. Stop the current runtime and verify it has stopped. Take a verified backup of the app's
   primary `data/` directory before changing the selected source. A failed Stop or backup
   ends the switch. The UI shows the stage, the previous selection and actual runtime state.
   The operator can start the previous version if the backup failed after Stop.
3. Record the selected workspace and development profile, then use normal app Start. The
   runtime runs its declared setup and build as required. Local, Docker and mixed recipes
   receive their own source and artifacts. The switch has no separate preparation build.
4. Once selected, the workspace stays selected through build, startup and readiness failures.
   Report the build or service error with logs and actual service state. The operator or agent
   can edit the worktree and use ordinary Start or Restart on the same target, without
   reselecting it or taking a second switch backup.
5. Return to the installed package is an explicit operator selection, available from Shell
   independently of the app being switched. Return retains the current data. To undo data
   changes, the operator stops the app, selects the identified pre-switch backup in Backups,
   confirms Restore and starts the package. The archive covers the primary app data
   directory. Cache, external folders and additional storage mappings stay outside its scope.

## Deliverables

D1 and D2 from the earlier draft are retired. They described automatic runtime recovery.
D3 and D4 retain their UI and verification scope.

- [x] D5. Change ordinary package-to-workspace and workspace-to-workspace entry to the verified Stop, backup, bind and normal Start sequence. Reuse the app operation lock and lifecycle journal. Keep exact-request recovery across interruption, protect source while consumed and prevent use of outgoing build artifacts for the new target. Resume older in-flight operations according to their recorded phase.
- [x] D6. Make a failed launch a settled outcome with the selected workspace still bound. Support authorized worktree edits and ordinary Start or Restart after repair, including partial multi-service failures. Preserve permissions, diagnostics and factual service health without an automatic package start or data restore.
- [x] D3. Show the selected workspace and observed startup outcome separately in Harness and Shell. Keep logs and package Return reachable when Harness itself is down. In Dashboard, make the Core-created backup discoverable and restorable by an authorized operator even for an app that declares only logs.
- [x] D7. Identify the backup taken on leaving the installed package across subsequent workspace switches and after manual Return. Keep it available through that recovery window under automatic cleanup, while honoring explicit deletion. Reuse the existing backup list, stopped-app restore and confirmation.
- [ ] D4. Verify the normal selector through Core, Shell and Harness and document the shipped behavior. Cover a self-switch of Harness, and package → A → B → package with a manual restore of the original package data.

## Verification

- Verify a denied selection leaves the running app untouched. Fail Stop and backup independently.
  Confirm the selected target and actual service state and that no candidate code started.
- Break a native build and a container startup after binding. Verify the workspace stays selected,
  the build error is accessible and an agent can edit. Repair and start from the same selection.
  Check fresh artifacts, no duplicate switch backup and truthful state for a partially started app.
- Recover retained requests after a disconnect or Core restart around Stop, backup, binding and
  startup. Verify each app's result in a group and protection from a superseding request.
- With Harness unavailable, return it to its installed package from Shell. Verify current data on
  Return and original data only after explicit Restore. Exercise successive workspace backups and
  automatic cleanup, explicit deletion, an external-data sentinel and an app without a backup
  capability. Run affected unit and component tests plus the managed `activation` and
  `harness-local` suites. See [app data backups](../app-data-backup-retention/feature.md).

## Local verification on 2026-11-20

Core, CLI, Harness API, Harness web and Shell built on macOS. All 452 selected Core tests
that could run locally passed with the in-process xUnit runner. These covered native setup
and container adapter failures, HTTP selection and replay, editable workspace bindings,
package Return, backup retention and explicit restore. The six affected Harness
suites passed 150 tests. Shell passed 209 Node and 935 component tests.

D4 remains open for a managed run. The activation fixture exercises a native compilation
failure, in-place repair, package → A → B → package and a manual restore of the original data.
The harness-local fixture switches Harness itself and checks its independent recovery.
The activation, harness-local and shell commands stopped at their Docker prerequisite because
this session could not access the local Docker socket. Ten native port checks also require
a host that permits opening a local listening socket.

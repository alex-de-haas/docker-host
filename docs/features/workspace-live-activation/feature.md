---
created: 2026-10-19
updated: 2026-10-20
summary: Select named app workspaces or installed package runtimes with scoped access review, retained package choices and recoverable Core-owned transitions.
components: [apps/core, apps/cli, apps/shell, apps/harness, shared]
---

# Core Source And Workspace Activation

Core exposes configurable development source, immutable build provenance and one package/workspace execution selector for apps. Shell, Harness, direct MCP and local CLI use retained Core-owned selection requests. Execution uses ordinary data in the selected Core; sandbox preview is separate. Explicit Core handover retains its supervised group operations.

## Package And Workspace Selection

Dashboard uses one execution selector for each app. Package entries are the installed manifest's
release profiles. Workspace entries are named, explicitly app-bound worktrees with a supported
development recipe. Raw development profiles are internal recipes and do not appear as independent
choices. Selectable workspace entries belong to the current user and, for direct credentials, the
current principal. Public source inspection remains broader; another user's already active workspace
keeps its current name without becoming a selectable target. A recipe uses its declared development default, the conventional `dev` profile when
present, or the sole development profile; an explicit workspace selection can configure another
recipe with `runtime`, which Core retains for that binding. An unresolved ambiguity has a concrete
setup reason rather than guessing another worktree.
`configure_workspace_runtime` or `POST /api/development/workspaces/{workspaceId}/execution-recipe`
sets `{requestId, appId, worktreeId, runtime}` with source management authority. Core retains the
chosen worktree and runtime for the logical workspace/app installation in one atomic selection
record with replay receipts. Inventory and workspace-wide execution use the same choice even when
reviewed repository changes leave multiple eligible app-bound worktrees. Explicit worktree choices
remain supported. Old configuration retries do not replace a newer selection; a stale or ambiguous
binding reports an actionable setup error before lifecycle work. Configuration changes metadata
without starting the app and publishes a workspace refresh event.

Core retains the selected package release runtime independently of workspace execution. Entering
workspace A and then B preserves that package choice. Selecting a package entry directly runs the
current installed package with the selected release runtime. It never restores an old workspace,
package manifest or data backup. A missing release profile is reported as unavailable.
Source edits and current ordinary data remain intact.

`GET /api/apps/execution-targets` returns one shared inventory; the app-specific variant is
`GET /api/apps/{appId}/execution-targets`. Expected app metadata read failures, including missing or corrupt development journals and workspace
recipes, are isolated to their owning app in shared inventory. The app-specific endpoint retains the
error for diagnosis; healthy apps keep their available choices. An explicit choice is:

```json
{ "requestId": "UUID", "kind": "workspace", "workspaceId": "aggregate-id", "worktreeId": "tree-id" }
```

`POST /api/apps/{appId}/execution-target` accepts that choice or
`{ "requestId": "UUID", "kind": "package", "runtime": "docker" }`. Omitting the package runtime
uses Core's retained package selection. The response has `state` `running`, `completed`, `failed`
or `review-required`. `GET /api/apps/{appId}/execution-target/{requestId}` recovers the same request.
Core owns the accepted operation independently of Shell/Harness connections and resumes running
requests on startup. Execution holds the app's shared operation mutex through preparation and
replacement. Submission queues an intent; it does not acquire execution ownership. A newer selection
that acquires that ownership retires an older request's authority to change the app. A queued intent
whose captured owner changed fails with `dev_selection_changed` before lifecycle effects; its caller
can make a fresh explicit selection. Completed requests do not repeat effects.

Preparation validates settings, mounts, source authority and the candidate execution contract before
replacing the current runtime. A failed build keeps the current app running. Package/workspace
transitions reuse verified stop/start, managed-data backups and durable development journals.
There is no routine compatibility acknowledgement or separate per-app Return dialog.

Workspace detail exposes **Use this workspace** and **Return to package** for its bound apps.
Group requests use `POST /api/development/workspaces/{workspaceId}/execution-target` and retained
`GET .../execution-target/{requestId}`; Harness uses the authorized workspace-inspection equivalents.
The response names each app and its result. Initial admission includes only currently installed apps
whose installation identity matches the retained binding; removed or reinstalled app bindings do not
create child requests. Retrying preserves the original participants and group ID and skips completed
children. Group return only affects apps still using that workspace; it leaves an app moved to B or
a package untouched. Package return authorizes the retained workspace owner and current app bindings
without requiring workspace source to remain readable; revoked private-source access or a missing
worktree cannot block return to the installed package. Workspace use still requires source admission.
Core itself is not implicitly included. Sandbox links remain separate and
open a Core instance with its own users, data and dependencies.

### Workspace Manifests And Access Review

The admitted workspace manifest is a private execution snapshot, separate from the installed
package. Valid version and display metadata edits and execution changes within existing authority
need no extra permission prompt. Additional rights, provider roles, host access, network exposure
and runtime privileges require a concrete review. Optional declarations are not automatic grants.
The candidate, source/runtime, installation, actor and current authority bind the consent; source
or grant changes require revalidation before setup or replacement. Scoped workspace rights do not
become package rights, and later revocations remain effective.

A `review-required` result carries `review`, an `InstallationPrepare` with `workspaceManifest`.
Shell/Harness prepare and submit it through the existing Core confirmation API and display the
resulting approval request. They then retry the original execution choice. A local CLI selection
requiring additional rights directs the operator to select the workspace in Dashboard under their
signed-in identity. It cannot manufacture approval for a synthetic operator.

Restart refreshes an admitted candidate and checks current access again. Stop uses the last
launched snapshot, so invalid live JSON does not trap an app. Package return uses the current
installed contract and strips temporary workspace authority. Native, system, Docker and mixed
recipes retain their supported execution paths.

### Names And Automation

Workspace names describe the work and are separate from owner labels, session titles, Git branches
and stable IDs. Agents supply a concise purpose name when creating a workspace and rename it when
the task scope changes. Authorized renaming updates shared display metadata only and publishes
workspace observation events; it does not restart apps or change execution approval, source stamps,
branches or ownership. Legacy meaningful labels remain readable. Naming APIs are described in
[external workspaces](../external-development-workspaces/feature.md).

The runtime column shows the actual execution type; **Version / source** displays the active
workspace's icon and name. Hover/focus preserves branch, commit and source details. The inventory
refreshes on app/workspace events and visibility recovery, including renames with unchanged source.

Direct MCP exposes `get_app_execution_targets`, `select_app_execution_target`,
`get_app_execution_selection`, `select_workspace_execution` and
`get_workspace_execution_selection`. Direct workspace/lifecycle authority and current ownership
remain required for mutations. Harness agents use `execution_select` and `execution_status`
through their existing tool policy and session ownership. CLI equivalents are
`hosty apps execution-targets <app>`, `hosty apps select-target <app> --request-id <uuid>
--package|--workspace <id>` and `hosty apps execution-selection <app> --request-id <uuid>`.
These paths do not create sandboxes or publish source.


## Development Source

`GET /api/core/development` returns three separate facts:

- `source`: revisioned development configuration, including repository URL, optional ref, relative
  project path, legacy override and optional private-source connection reference.
- `build` and `launch`: embedded build identity and the factual process/project/generation identity.
- `updateRepository`: the existing binary distribution repository. Development source edits do not
  retarget CLI/Core release downloads.

An administrator saves source through `PUT /api/core/source`:

```json
{
  "overridePath": null,
  "revision": "the-current-source-revision",
  "repository": {
    "repositoryUrl": "https://github.com/example/hosty-fork.git",
    "ref": "main",
    "projectPath": "apps/core/src/Haas.Hosty.Core/Haas.Hosty.Core.csproj",
    "connectionId": null
  }
}
```

`repository` is optional for compatibility with existing override-only callers. Omitting it preserves
the configured repository/ref/project/connection. A supplied selection replaces that configuration;
`connectionId: null` explicitly selects anonymous access. Private access binds a reviewed source
connection to its owner and repository, and revalidates it before preparation and development restart.
No credentials are stored in a URL or source settings.

URLs must be complete HTTP/HTTPS clone URLs without credentials, query strings or fragments. Existing
provider normalization makes supported GitHub spelling and `.git` variants equivalent. Other valid
public HTTP/HTTPS Git hosts retain their canonical URL; this does not imply private-provider support.
A fork has a different repository identity from its upstream. Ref syntax is checked locally; Git checks
remote availability during preparation. Project paths must be contained relative `.csproj` paths,
including symlink containment resolved against the actual repository path. The helper rechecks Core
source authority, workspace writers and project containment immediately before an unprepared build,
so a path substituted after admission is refused before compilation. Saving configuration performs
no clone, reset or restart.

`POST /api/core/source/prepare` with `{ "sourceRevision": "..." }` prepares the selected source and
returns its project path and revision. It shares Core's launch lock and refuses stale revisions or
pending lifecycle operations. An absent ref clones the remote default branch; a named branch/tag is
passed to Git. Repeated preparation reuses existing source without pull/reset, including dirty files.
A new repository/ref uses a distinct `<root>/core/sources/<identity>` checkout. Failed validation of a
new clone removes only that temporary clone. An unexpected origin in a new managed checkout is refused.

Legacy `<root>/core/source` and local overrides remain in place. A readable legacy origin supplies
repository identity. Existing standard-source settings without a checkout retain the official legacy
default; an unknown existing folder is not relabeled as official. Fresh configuration uses a supported
embedded build repository when available and otherwise remains unconfigured. Migration is projected
on read and persisted on save. Existing pending-source and exact-live-target restart behavior remains
as described in [Core development mode](../core-dev-target/feature.md).

## Build Provenance

Core and CLI embed repository, commit, dirty-source indication and relative project path during
compilation. Release CI supplies the actual workflow repository, including forks. CLI preparation
resolves an ordinary checkout's origin or the registered Core worktree's repository record. The build
captures commit and dirty state before producing its output; release staging folders are ignored by
Git so one artifact does not mark the following build dirty.

Runtime reads assembly metadata, not the mutable checkout. Editing source after compilation leaves the
running binary's identity unchanged. Rebuilding captures the new dirty state. Missing Git, missing
metadata or an unsupported/credential-bearing repository produces unknown fields. Direct builds of a
worktree without an origin can supply `HostyBuildRepository`; the CLI supplies it for managed generations.
Build provenance is diagnostic information, not a signature or permission to execute code.

## Core-Only Workspaces

`POST /api/core/source/workspaces` accepts `requestId`, `taskId`, `leaseId`, `sourceRevision`, optional
`targetBranch` and optional `label`. The administrator owns an external workspace under a stable
operator principal. Request and lease IDs are UUIDs. The configured source, private connection and
project are validated before materialization. A Core binding uses the existing repository worktree
store without inventing an application installation.

Preparation retains the existing request fingerprint, same-owner/repository reuse, activity lease and
source-preservation rules. Retrying the same request reuses its allocation; changing arguments under
that ID is refused. A configured branch supplies the default target; a source tag requires an explicit
development target branch. Source configuration can change without deleting a retained worktree.
Private access is checked against the current binding, including a changed or revoked connection.
Existing workspace operations retain their source, dirty/unmerged and consumer safeguards.

## Participant Projection

`POST /api/development/workspaces/{workspaceId}/activation-plan` accepts an optional selection:

```json
{
  "coreSelected": false,
  "coreWorktreeId": null,
  "apps": [{ "appId": "example.notes", "selected": true, "worktreeId": null, "runtime": "dev" }]
}
```

The response has `stage: "selection-only"`, the current Core instance/source revision and candidate
rows containing source, branch, observed commit/change count, current/target runtime, selection reason,
available development profiles and any unavailability diagnostic.

Applications come only from explicit workspace bindings to current installations. Merely sharing a
repository adds no other app. Installed Docker, local-command and mixed development profiles are
candidates; unsupported or ambiguous profiles require correction or an explicit choice. Multiple
worktree bindings require a choice. Reinstalled apps, changed source/subpath and unavailable source
remain visible as unavailable candidates when their metadata is authorized. A failed private-source
ownership/access check refuses the projection rather than disclosing retained source. Choices outside
the workspace binding are rejected.

Core is selected by default only when exactly one worktree matches its configured repository and has
the configured project with current source access. The operator can clear `coreSelected` independently
of app choices. Multiple matching worktrees require an explicit choice. The planner uses repository
identity rather than changed-file inference: a Shell-only change in the Core repository still offers
Core, but never implicitly includes Harness or other unbound apps.

The projection inspects authorized workspace source and updates observations. It does not build,
reserve runtimes, grant lifecycle authority or establish readiness. It cannot be used as an executable
apply receipt. App data, source files, selected runtimes and process state remain unchanged.

## Authority

Source configuration and Core-only workspace preparation require administrator authority and browser
CSRF protection; app-mediated configuration additionally requires `core.configure`. The activation
surface checks workspace ownership, current administrator status, source access and lifecycle authority
for its selected participants. App callers require `apps.sources.full` and `apps.lifecycle`; selecting
Core additionally requires the separately reviewed optional `core.workspace.activate` permission.
Harness and Shell declare this permission but do not grant it automatically to existing installations.

Direct MCP `workspace_activation` requires a current direct Core grant with `mcp:read`,
`mcp:workspaces` and `mcp:lifecycle`, plus `mcp:core-restart` when Core participates. It cannot use a
delegated assistant credential or caller-supplied ownership. App grants, installation identity,
permissions, browser sessions and direct grants are rechecked at runtime boundaries, including before
Core Stop. Durable authority stores references/hashes, not bearer credentials. Local control and CLI
retain their existing explicit local-operator authority. Owning a worktree alone does not grant any
of these lifecycle capabilities.

Harness exposes typed `activation_plan`, `activation_apply`, `activation_status`, `activation_list`,
`activation_cancel`, `activation_resume` and `activation_return` workspace tools. Existing Ask, Run
unprompted and Disabled policy applies. An agent's mutation is queued until its successful turn ends,
native process exit (or Docker worker termination) is confirmed and source leases are released. The
original reviewed payload and IDs are retained; policy and Core authority are rechecked at dispatch.
A completed Docker turn revokes worker transport access while preserving that reviewed policy guard
through worker shutdown and lease release. Cancellation, permission changes and revocation still
invalidate the queued request.
A restarted Harness cannot reconstruct an in-memory approval: it marks the queue blocked for explicit
review/retry. The detached helper owns an accepted transition even when Harness replaces itself.

## Local Runtime Composition

The local control API prepares a concrete selection with
`POST /control/v1/workspaces/{workspaceId}/activation/prepare` and
`{ "requestId": "UUID", "userId": "workspace-owner", "selection": { "coreSelected": true } }`.
The local operator owns this surface through the existing control secret. It does not grant ordinary
app lifecycle callers Core-management authority. The planner response itself remains read-only.

Preparation validates current installations, source grants, unchanged installed recipes, workspace
admission, required settings/mounts, selected dependency order and backup prerequisites. It refuses
active source overlap with any running app. Required dependencies outside the selection must already
be available; it never starts an unrelated provider implicitly. Required missing endpoints and selected
cycles are refused. Current native/system, Docker and mixed profiles use their existing adapters.
Native recipes, including those used by Shell/Harness, retain native execution; they are not converted
to Docker. A valid top-level manifest version change or JSON reformatting is accepted without a
separate update. Workspace execution changes use a transient admitted manifest. Additional authority requires the
scoped Core review described above before activation. The installed package and retained Return contract keep their original version.
Existing source-stamp and stale-review checks still apply: edits after preparation require a fresh
preparation/review before execution.

Each selected app receives a deterministic child ID in its existing development-mode journal, with
its prior runtime, source, artifacts, initial running state and installation identity. Preparation
resolves Docker image/build artifacts and native prebuilt artifacts, and executes declared setup in
scratch data/cache context. Docker setup mounts only the selected service's declared data/cache
targets from that scratch context and injects their container path variables after static environment
values. It does not mount another service's targets or use ordinary app cache as a fallback.
Docker source cache volumes and generated-file overlays use a separate
activation identity inside the owned app cache. Preparation, candidate start and active restarts reuse
that cache; Return selects the untouched previous runtime cache. No ordinary app data, identity token, configured settings or dependency
credentials are injected into preparation. A build recipe is trusted code with its existing host/source
access; this is not a sandbox. The manifest's declared setup/build is the preflight boundary: it does
not promise to catch every later hot-reload or startup error. Successful setup is not repeated after
Stop. Source observations are checked again before apply.

`hosty --data-root <root> core activate-workspace <prepared-id>` admits a detached helper and returns
its request ID and log path. The helper composes the local transition. It
builds the exact selected Core project into an isolated generation before stopping any participant.
Then the control API stops selected apps in reverse dependency order, verifies every selected app's
managed-data backup before starting any candidate, and starts in dependency order. Unselected apps
are retained. The command stops Core with keep-apps only after the app stage succeeds, takes a verified
Core snapshot while the lifetime lock proves Core has exited, and launches the exact prepared output
at the previous listen address. Readiness checks use the expected project/generation/process identity.
It never substitutes the installed release after candidate failure.

A Core snapshot under `<root>/core/workspace-snapshots/` contains Core-owned state (including workspace and app development journals) and
installed app manifests, state and Core-managed secrets. It excludes runtime/build outputs, logs,
source checkouts, activation scratch/journals, retained Core snapshots and ordinary app data. Selected apps have independent
managed-data backups; external mounts and unrelated app data are outside this coverage. The archive
is owner-private and verified entry-by-entry and by SHA-256. Snapshot creation refuses linked state
and a live Core lifetime lock. Retrying the same snapshot ID verifies the retained archive instead of
silently replacing it. Snapshot creation does not restore data or modify source.

Local activation records retain selected participants, prior Core launch, prepared output, snapshot,
source observations and phase. Build retention preserves candidate and prior generations referenced
by an unreturned activation. An app startup failure retains its development journal and backup;
repeating apply continues that participant's existing phases without duplicating the backup.
A preparation failure releases only this activation's pre-Stop app reservations; unrelated completed
Return journals remain unchanged. Active foreign operations and participants that crossed Stop still
refuse cleanup. This allows a new source-edit lease and
re-preparation with the original request. Core compile failure uses the same release path.
After source repair, an explicit fresh review can update the digest of that same request only while
preparation is released and no runtime transition has started. Participant selection, workspace,
user and originating authority remain fixed; a stale digest or changed selection leaves the retained
receipt unchanged. Older receipts without this recovery identity accept exact replay or Return.
`POST /control/v1/workspace-activations/{id}/release-preparation` explicitly releases only such
pre-Stop reservations; it refuses an already-started transition. A review tied to a replaced Core or
changed Core source is retired on release and requires a fresh review. Nothing resets files or data.

## Supervision And Recovery

The initiating client or terminal does not own an admitted transition. The detached CLI
helper holds the existing Core launch lock through build, app application, stopped-Core snapshot,
replacement and readiness verification. Ordinary Core start/restart and source changes refuse a
pending group. Helper receipts live separately from group and app receipts; a lost HTTP response
cannot overwrite a later Core-owned phase. Each dispatch retains its own log and process/start identity.
Shared receipt readers allow atomic replacement on Windows while retaining their original snapshot. Core JSON storage uses the same
replacement path for workspace metadata, so concurrent catalog reads do not block lease writes.
A bounded lock table serializes same-path publication within each process, including concurrent first
writes, while readers continue to observe complete snapshots.
Windows replaces existing receipts with `File.Replace`; initial creation and Unix replacement use rename.
Writers retry only Windows sharing/lock conflicts for up to two seconds; access denial and other I/O
failures retain their original error. A partial Windows replacement restores the previous receipt only
when its destination remains absent; otherwise it retains recovery files and refuses to overwrite a
newer receipt.

`POST /control/v1/workspace-activations/{id}/start` admits the same helper through the local control
secret. `GET /control/v1/workspace-activations/{id}` returns group, helper and current child journals;
`POST .../{id}/verify-apps` checks the selected installation/runtime/source binding and actual readiness.
These local endpoints retain their control-secret boundary. Harness and direct MCP use the separately authorized activation surface described above.

The CLI also reads status without a running Core:

```bash
hosty --data-root <root> core workspace-activation <id>
hosty --data-root <root> core workspace-activation <id> --cancel
hosty --data-root <root> core activate-workspace <id> --resume
```

Cancellation writes a durable request and is observed between participant and Core boundaries.
It does not kill a writer or restore data. A helper cancelled before app Stop releases preparation
and retires that request. Once application changes have begun, it pauses with each child's achieved
phase intact. Explicit `--resume` clears the cancellation and reconciles the original selection.
Cancellation after a terminal result changes nothing. Preparing source before admission and asking
for cancellation do not start a helper on their own.

A replacement Core periodically redrives abandoned accepted/running helper attempts with the same
group ID. A fresh attempt token prevents delayed helpers from taking over a newer attempt. Deterministic
failures and cancellation remain visible for explicit recovery rather than automatic restart loops.
When Core is unavailable, the local CLI can resume the original request. During a partial app apply,
it can restart the captured previous executable/target before continuing. It refuses a different Core
or an alive but unresponsive process instead of stopping it or choosing a release fallback.

Recovery reads the retained phase before acting. A completed child start whose verified running
projection survived is reconciled without another stop/start. An uncertain partial start keeps the
existing verified-stop recovery path. A lost Core Stop response uses the lifetime lock to prove exit;
a lost candidate Start response checks the exact project/generation and actual ready process. A Core
that owns the lifetime lock but cannot serve status remains available for diagnosis, and is not started
again. If a candidate dies during final group verification, recovery restarts its retained generation
without rebuilding or taking another snapshot. Candidate and selected-app readiness must pass before the group becomes active. Completed or
returned requests never recreate processes, snapshots or backups.

Core handover keeps its previous listen address and captured launch identity. Snapshot creation and
replay retain the existing stopped-state and archive verification rules. Source settings saved during
an active operation do not rewrite its captured previous runtime.

## Review And Client Controls

`POST /api/development/workspaces/{workspaceId}/activation/{kind}` accepts `plan`, `apply`, `list`,
`status`, `cancel`, `resume` or `return`. `plan` receives `{ "selection": ... }` and returns `plan`,
`planDigest` and consequences. `apply` requires the same selection, digest and a UUID `requestId`.
The digest covers participant facts, source contents and installed runtime/configuration identity;
changes invalidate admission. The earlier `activation-plan` endpoint remains a selection-only API.

The advanced activation APIs retain explicit app/Core selections for Core handover and recovery.
Ordinary app selection uses the unified execution paths above; Dashboard and workspace detail do not
expose the retained-activation panel or its participant/compatibility controls. Core Source exposes
repository URL, ref, relative project and optional source connection alongside the running build and
update origin. Unsaved source fields retain their opening revision; background status cannot overwrite them.

The client retains uncertain action IDs and exact request bodies locally, without credentials.
Accepted apply bodies also survive remounts. A released preparation offers exact retry or an explicit
review of the same selection after source repair, preserving its original activation ID.
The client lists durable groups, observes helper and child phases, and offers boundary pause, original-request
resume and selected-participant Return. Visible in-progress panels refresh every three seconds;
visibility restoration and explicit refresh recover missed progress. Terminal groups stop recurring
requests. Changing the retained activation clears the Return selection and compatibility acknowledgement.
The retained group stays fixed while a review or action runs, so a delayed review cannot target
a different group from the one displayed.
The helper remains the operation owner. If returning to an older Core removes these APIs,
the retained ID and CLI status command remain available for diagnosis.

## Return And Runtime Consumers

A Return request has its own UUID and explicit selection:

```json
{
  "activationId": "original-group-UUID",
  "return": {
    "requestId": "new-Return-UUID",
    "apps": ["example.notes"],
    "core": false,
    "acceptDataChanges": true
  }
}
```

Returning apps restores each child journal's prior runtime, source and artifact selection, and its
original running/stopped state. It keeps current data and source edits. Changed managed app data
requires compatibility acknowledgement. Group admission requires that acknowledgement for every
selected Return before any app stops; refusal leaves the active runtime and receipt unchanged.
Successful children are recorded individually. Partial failures retain the other achieved results;
a subsequent explicit request can select the remaining participants. Reusing a Return ID with changed
arguments is refused; replay of a retired request is an observation, not a new dispatch.

Core Return requires explicit acceptance of current-data compatibility with the captured previous
executable. Before Stop it verifies that executable's retained hash and the current candidate identity.
It never selects an arbitrary release fallback. Lost Stop/Start responses reconcile the lifetime lock
and exact prior launch target. A healthy returned app or Core is not restarted again on replay.

Before Core Return stops the candidate, the helper captures the current running/stopped states and
target fingerprints of returned applications. If the previous Core's startup policy changes those
states, the helper waits for that boundary and reconciles only the same installation/source/artifact
targets. A durable boundary receipt makes lost start/stop responses replayable; actual app health must
pass before completion. Core checks the retained Return request and captured target under the same
app operation lock as the lifecycle action, so a replacement installation cannot be started or stopped
by an earlier observation. An older Core without guarded recovery leaves Return pending if an app
needs reconciliation; it reports the recovery requirement and never falls back to an unconditional
lifecycle request. Autostart preferences and ordinary data remain unchanged.

Unrelated current targets are refused. The Core snapshot and app backups remain recovery evidence;
Return does not automatically restore an archive, roll back users/data or reset Git.

The local CLI can prepare and dispatch Return even when the browser is unavailable:

```bash
hosty --data-root <root> core return-workspace <activation-id> <return-request-id> --app example.notes --core --accept-data-changes
hosty --data-root <root> core workspace-activation <activation-id>
```

Selected app journals and Core reservations remain durable workspace consumers. Transition phases
block new source writers and destructive Git/cleanup; active runtime use allows ordinary edit leases
but still prevents removal or destructive branch operations. Close and sandbox Finish do not stop an
ordinary runtime consumer. Returning one participant releases only that participant's ownership.
Harness shows app/Core runtime users and the activation controls needed to inspect or Return them.
Harness's native setup installs the monorepo dependency set so its setup cannot prune dependencies
used by Shell or another app in a shared worktree.

## Testing Expectations

- Verify URL/ref/project validation, canonical GitHub matching, fork distinction, stale revisions,
  dirty legacy migration, clone failure cleanup and offline source reuse without reset.
- Verify private-source owner checks, changed/revoked connections and preservation after refusal.
- Build and execute real temporary CLI generations from a fork and registered worktree; inspect
  immutable metadata after edits and fresh metadata after rebuild. Reject credential-bearing metadata.
- Prepare/replay Core-only workspaces without an installed app and retain unfinished files. Verify branch defaults, explicit development branches for tag-pinned or ambiguous refs, and refusal before worktree allocation.
- Exercise explicit app bindings, multiple repositories/worktrees, missing/reinstalled apps, ambiguous
  profiles, optional Core selection and rejection of foreign choices without runtime mutations.
- Exercise actual HTTP routing, DI, JSON serialization, admin/CSRF/app permission refusal and revision
  conflicts in isolated in-process Core hosts. These are not browser or runtime activation acceptance.
- Run affected Core/CLI suites, builds, Core Native AOT and documentation/version validation. Run
  platform-specific coordinated handover and Harness/browser acceptance independently of unit tests.

- Verify pre-stop setup/compile failures preserve running processes; verify repair leases, original-request retry, and explicit fresh review with the same ID after source repair. Reject selection/authority drift, stale review and review refresh beyond released preparation; retain accepted apply bodies through UI remounts. Verify cleanup ignores unrelated completed journals, preserves active operation ownership and resumes a partially released child without lifecycle effects.
- Verify native and Docker setup use scratch data/cache context and target environment precedence; verify service scoping, missing cache refusal, mixed dependency order, selected app backups, stopped-Core snapshot hashes, exact replacement identity and retained unrelated processes.

- Interrupt helpers after app apply, Core Stop and candidate Start; reconcile the original request without repeating completed effects or claiming readiness for a different target.
- Verify cancellation boundaries, stale helper attempts, local-control authorization, dead previous-Core recovery and source/data preservation on isolated native instances.

- Verify individual/group Return, compatibility refusal, partial results, previous-executable mutation,
  lost-response replay, revoked authority and source/data preservation.
- Exercise policy changes between queue and dispatch, confirmed native exit before lease release,
  resumed UI requests, selection invalidation and activation-specific compatibility acknowledgement.
- Run `python3 scripts/check-workspace-activation.py . return --managed` on a host with Docker after
  Debug Core/CLI builds. The fixture performs normal setup/password login, reviewed HTTP activation,
  exact-target Return and replay, and verifies parent-owned Finish and process/port cleanup.
- Run the native `return` and `auto` scenarios on macOS, Windows and Linux; CI defines that matrix.
  Windows receipt observers allow delete sharing, retry transient access denial within the existing
  deadline and preserve the final I/O cause. Verify atomic replacement with a concurrent reader,
  temporary and persistent legacy-reader conflicts, immediate access-denial refusal, concurrent
  creation and preservation after partial replacement failure. Core JSON storage tests hold a reader
  open across typed, owner-only and text writes and verify old/new snapshots and temporary-file cleanup.
  Failed CI fixtures export bounded, sanitized owned log tails and selected recovery state; they do
  not upload raw journals, authentication files, snapshots or app data.
- Exercise managed Git checkout, inspection and removal with paths longer than 260 characters, including Windows with global/system Git configuration disabled.
  Passing on one operating system does not establish another platform's process-control result.

- Exercise normal password login and a real authorized agent through Core/Shell URLs with isolated
  users/data. Cover native Harness self-activation and self-Return, Core/Shell interruption and chat
  recovery, Docker live edits, individual then group Return, and unchanged source/data sentinels.
- Verify a returned manual Docker app stays running after previous-Core autostart reconciliation,
  initially stopped apps remain stopped, and changed installation/source targets are refused.
  Lost start/stop responses resume from the durable boot-boundary receipt without another restart.
- Finish the child through its owner, verify container/network/volume and native process/port removal,
  then remove disposable fixture credentials, data and outputs. Preserve the product workspace and
  unrelated ordinary apps; do not copy provider credentials merely to make acceptance pass.

- Change an app installation or source between helper observation and post-Core Return recovery.
  The guarded action must refuse before lifecycle effects; a superseded/completed Return cannot be
  reapplied. Older Core without that endpoint retains pending diagnostics without a generic fallback.

- Keep compatibility acceptance on the explicit legacy captured-activation/Core-handover contracts.
  Unified package/workspace selection and its CLI/MCP paths require no routine acknowledgement.

- Exercise Docker deferred apply, Return and resume with real policy generations, including Ask
  approval and policy disable/revocation while shutdown waits. Worker shutdown alone must not cancel
  an approved request; actual cancellation and revocation must still prevent dispatch.
- Replace a Core project file or ancestor with an escaping link after source Save or activation
  preparation. Preparation, participant planning and pre-build revalidation must refuse it without
  touching external files, compiling the substituted project or stopping participants.

- Generate the typed activation MCP schema without constructing invocation services. Expose only
  workspaceId, kind and typed input; service dependencies never become model-selected arguments.

- Version and execution edits admit ordinary/system workspace participants without replacing the
  installed package. Actual access expansion requires exact scoped approval before setup or Stop.
- Corrupt one app's recipe or remove/corrupt its development journal and verify shared inventory
  retains healthy app choices while its direct endpoint preserves the diagnosis. Include expected
  metadata I/O failures; cancellation and programming errors must still propagate. Preserve records
  and runtimes.
- Verify workspace/package group admission omits removed or reinstalled bindings while current
  participants complete, without creating stale child journals or changing admitted replay intent.
- Verify workspace-wide package return after private-source revocation or source loss, retained
  request replay, and refusal of foreign users/credentials without app lifecycle effects.
- Verify package -> A -> B -> package, changed release defaults, current-data preservation, invalid
  source Stop/return, old-request retirement and healthy lost-response recovery. A failed candidate
  build preserves the running app; a live preparation lease protects its source until native
  consumers exit and the app journal owns the binding.
- Verify named workspace creation/rename, source-only recipe configuration without activation,
  exact replay, unchanged source stamps and UI rename refresh without page reload.

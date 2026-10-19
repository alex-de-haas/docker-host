---
created: 2026-10-19
updated: 2026-10-19
summary: Configure Core source and provenance, select workspace participants and supervise resumable local activation with managed-data backups.
components: [apps/core, apps/cli, shared]
---

# Core Source And Workspace Activation

Core exposes configurable development source, immutable build provenance, a read-only workspace
participant planner and supervised local runtime activation. The local control API and CLI compose
prepared application runtimes with optional Core replacement. Group Return, agent authority, UI and
persistent Core workspace consumers are tracked in the [remaining plan](plan.md).

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
including symlink containment. Saving configuration performs no clone, reset or restart.

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

The new HTTP routes require an administrator session and browser CSRF protection. Calls presented by
an app also require `core.configure`; workspace read/cleanup or ordinary lifecycle permissions alone
are insufficient. Existing workspace ownership and private-source visibility remain enforced. Delegated MCP/Harness execution authority is separate from these selection APIs. Local activation uses
the existing host control secret and explicitly names the workspace owner.

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
to Docker. A live manifest edit must pass the existing separate update review before activation.

Each selected app receives a deterministic child ID in its existing development-mode journal, with
its prior runtime, source, artifacts, initial running state and installation identity. Preparation
resolves Docker image/build artifacts and native prebuilt artifacts, and executes declared setup in
scratch data/cache context. No ordinary app data, identity token, configured settings or dependency
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
A preparation failure releases only pre-Stop app reservations, allowing a new source-edit lease and
re-preparation with the original request. Core compile failure uses the same release path.
`POST /control/v1/workspace-activations/{id}/release-preparation` explicitly releases only such
pre-Stop reservations; it refuses an already-started transition. A review tied to a replaced Core or
changed Core source is retired on release and requires a fresh review. Nothing resets files or data.

## Supervision And Recovery

The initiating client or terminal does not own an admitted transition. The detached CLI
helper holds the existing Core launch lock through build, app application, stopped-Core snapshot,
replacement and readiness verification. Ordinary Core start/restart and source changes refuse a
pending group. Helper receipts live separately from group and app receipts; a lost HTTP response
cannot overwrite a later Core-owned phase. Each dispatch retains its own log and process/start identity.

`POST /control/v1/workspace-activations/{id}/start` admits the same helper through the local control
secret. `GET /control/v1/workspace-activations/{id}` returns group, helper and current child journals;
`POST .../{id}/verify-apps` checks the selected installation/runtime/source binding and actual readiness.
These local endpoints do not grant Harness or MCP new authority. The full client policy remains D7.

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
an active operation do not rewrite its captured previous runtime. Group/Core Return and data-compatibility
review remain D6; browser/real-agent and Windows/Linux native acceptance remain D11-D12 in the plan.

## Testing Expectations

- Verify URL/ref/project validation, canonical GitHub matching, fork distinction, stale revisions,
  dirty legacy migration, clone failure cleanup and offline source reuse without reset.
- Verify private-source owner checks, changed/revoked connections and preservation after refusal.
- Build and execute real temporary CLI generations from a fork and registered worktree; inspect
  immutable metadata after edits and fresh metadata after rebuild. Reject credential-bearing metadata.
- Prepare/replay Core-only workspaces without an installed app and retain unfinished files.
- Exercise explicit app bindings, multiple repositories/worktrees, missing/reinstalled apps, ambiguous
  profiles, optional Core selection and rejection of foreign choices without runtime mutations.
- Exercise actual HTTP routing, DI, JSON serialization, admin/CSRF/app permission refusal and revision
  conflicts in isolated in-process Core hosts. These are not browser or runtime activation acceptance.
- Run affected Core/CLI suites, builds, Core Native AOT and documentation/version validation. Keep
  platform-specific coordinated handover and Harness/browser acceptance with the remaining plan.

- Verify pre-stop setup/compile failures preserve running processes; verify repair leases and original-request retry.
- Verify native preparation uses scratch context, mixed dependency order, selected app backups, stopped-Core snapshot hashes, exact replacement identity and retained unrelated processes.

- Interrupt helpers after app apply, Core Stop and candidate Start; reconcile the original request without repeating completed effects or claiming readiness for a different target.
- Verify cancellation boundaries, stale helper attempts, local-control authorization, dead previous-Core recovery and source/data preservation on isolated native instances.

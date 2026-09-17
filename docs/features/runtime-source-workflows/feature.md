# Runtime Source Workflows

Created: 2026-06-03
Updated: 2026-09-17

Runtime source workflows let administrators and local operators inspect and update the source state stored for an installed Hosty runtime app. Manifests declare source metadata, Core stores managed checkout and local override state, local command runtimes run from those folders, and Shell exposes Git inspection and reviewed file discard.

```mermaid
flowchart LR
  A["app.0.1 manifest source"] --> B["Core app record"]
  B --> C["Managed checkout under apps/app-id/source"]
  B --> D["Local override worktree"]
  C --> E["Runtime start"]
  D --> E
```

## Source State

An app manifest may declare one app-level source repository. Multi-repository runtime apps are out of scope for the first source runtime implementation; split independently-owned services into separate runtime apps. Future source extensions are tracked in [Runtime Source Extensions](../../ideas/runtime-source-extensions.md).

Core stores source state as Host installation state, not as public manifest metadata:

- repository type and URL/path;
- resolved ref;
- immutable commit SHA — the reviewed pin, advanced only by `source-resolve` or a reviewed update;
- managed checkout path, by default `apps/<app-id>/source/` inside the app root (pre-existing records may still point at the retired top-level `sources/<app-id>/` location);
- optional administrator-selected local source override path;
- the override folder's own commit, when one was recorded;
- update timestamp.

The reviewed pin and the override's commit are separate fields because they answer different questions: which upstream commit Core reviewed, and where the operator's folder happened to be. Configuring an override therefore never moves the pin, and a pinned start (reviewed source profile) runs the recorded pin as-is — fetching it when the checkout does not have it yet. A recorded commit that the repository does not contain even after a fetch falls back to the reviewed ref rather than failing the start, and the record self-heals. The override's commit is whatever `git rev-parse HEAD` answers in that folder, so a linked worktree or a folder nested inside a repository records one too; a folder git does not recognize records none.

Installation records predate this split at schema version 1, where both facts shared the `commit` field. Core migrates such a record on read — the commit of a record that has an override moves to the override's field and the pin re-resolves from the reviewed ref, exactly as a pre-split Core behaved — and the next write stores it at version 2, after which a recorded pin is taken as reviewed.

Managed checkouts are for public-readable `http`/`https` Git repositories or local filesystem repositories. Core rejects embedded credentials and SSH-style repository URLs, and git subprocesses run with interactive credential prompts disabled. Private repositories should be cloned by an administrator and connected through `source-override` until Hosty has a Core-owned credential provider.

## Development Profiles And Source Preservation

Development is selected through a manifest profile with `development: true`, not a separate toggle.
The profile name is arbitrary and its commands supply reload behavior. Old independent mode settings
are ignored; see [profile-bound development](../runtime-artifact-model/feature.md).

A profile named `dev` without the development flag is still a reviewed source profile. For a
remote install, it runs the managed checkout even when a local override is saved. Enabling the
flag in an updated manifest requires applying that manifest first; saving an override alone does
not change the installed profile. Reviewed update plans explicitly list changes to the selected
profile's development flag and require review, including when accompanied by a version bump.

A pinned start never discards edits or cleans new files. It refuses a dirty managed checkout and
instructs the operator to commit or explicitly discard work, or select a development profile.
Switching to Docker leaves source intact. Returning to a reviewed source profile can therefore fail
with a source-change error; a running runtime switch then restores the previous selection and leaves
the app stopped. Source history and explicit discard belong to Git; data backups are not source backups.

## Source Inspection And Selected Discard

Core inspects the effective source root (local override first, otherwise managed checkout). In a
monorepo it narrows inspection to the recorded manifest subdirectory. Shell displays that absolute
scope: changes in shared libraries outside the app directory are not included. No extra source
registry, history, automatic commit, fetch or push is involved.

The administrator-only Dashboard version cell for a live/development app shows the current branch
with a dotted underline and changed-file count (`No changes` when clean). Its tooltip contains the
full HEAD, scope and observation time; the hash takes no space in the table. The branch only exposes
the tooltip; clicking the separate change-count line opens the source dialog. Manifest version remains
in the source dialog. Other apps
can open **Inspect source changes** in Source settings. Visible panels refresh every 15 seconds and
on explicit refresh; observations carry their time. A clean result describes files on disk, not an
uploaded commit, a running process's loaded code or successful hot reload.

Status distinguishes `none`, `missing`, `no-git`, `clean`, `changes` and `unavailable`. Unborn branches
have no HEAD; detached HEAD and linked worktrees are supported. No-Git folders have no invented
clean/dirty state or recovery promise. Failed probes are unavailable, never clean. Results contain
at most 512 files, with a truncation flag; each Git invocation has a ten-second deadline and bounded
output. Git paths are literal and no credentials or remote URLs are returned by these reads.

The source dialog previews a selected file's HEAD-to-working-tree diff and its staged changes
separately. New untracked text files have a bounded content preview; binary files have a label.
Previews are limited to 64 KiB/characters per part and mark truncation. Rename detection is disabled:
a rename appears as the old path's deletion and the new path's addition, so each path is explicit.
Symlinks, submodule directories and special files cannot be previewed through this panel.

**Select all** above the file list selects/deselects all eligible files and shows a mixed state for
partial selection. After status refreshes, review requests and counts include only currently discardable
selected files. Viewers without source-management rights see the manifest version instead of Git details.
Unsupported files remain unavailable; lists above the 32-file review limit
explain the limit and require manual selection rather than silently selecting only a subset.

**Review discard** accepts 1–32 selected paths. The review names the exact HEAD, source scope and
files, marking new files for deletion. It expires after five minutes and is single-use. Apply checks
HEAD, canonical source binding, selected Git status/index, file mode and contents again. A changed
review is refused before mutation. Complete status and an existing HEAD are required; no-Git and
unborn repositories cannot discard against a fictitious baseline.

Tracked selections restore both their index and worktree to the reviewed HEAD. Only exact selected
new files are deleted; unrelated edits/staging are preserved. Files above 4 MiB, conflicts, unsafe
paths, symlinks and submodules require an external Git workflow. Core never recursively cleans the
source tree and keeps no recovery copy. Its app/scope locks serialize its own discard operations;
external editors and Git clients are not locked. A concurrent external write or filesystem failure
can interrupt apply or leave a partial result, so the UI refreshes status after failures as well as
success. Users reload/restart explicitly when the profile commands do not provide hot reload.

Browser API routes under `/api/apps/{appId}/source`:

| Method and suffix | Purpose |
| --- | --- |
| `GET /status` | Bounded scoped source/Git observation |
| `POST /diff` | Preview a currently changed `path` |
| `POST /discard/plan` | Review explicit `paths` and return an opaque `reviewId` |
| `POST /discard` | Apply that `reviewId` once after revalidation |

All require a Host administrator; browser POSTs require CSRF. Equivalent trusted local control
routes use `/control/v1/apps/{appId}/source` and the control secret. Responses are `no-store`.
Scoped assistant credentials do not become administrator sessions through these routes. Assistant
source grants and runtime orchestration remain tracked in
[development controls](../app-development-controls/plan.md) and
[approval rules](../assistant-approval-rules/plan.md). No new CLI or MCP discard wrapper is exposed.

## CLI Commands

- `hosty apps source <app-id>` shows the current source state for an installed app.
- `hosty apps source-resolve <app-id> [--branch <name>|--tag <tag>|--commit <sha>] [--fetch]` prepares or refreshes the managed checkout and records an immutable commit SHA.
- `hosty apps source-override <app-id> --path <worktree> [--commit <sha>]` stores an administrator-selected local worktree override in installation state. `--commit` (or the folder's `HEAD`) is recorded as the override's commit; the reviewed pin is left alone.
- `hosty apps source-clear-override <app-id>` removes the local override and its commit, and leaves managed source state intact.
- `hosty apps health <app-id>` reports runtime health. For `localCommand` runtimes, Core reports each service process status, PID, exit code, log path, and working directory.
- Add `--format json` to any source command for scripting.

Only one of `--branch`, `--tag`, or `--commit` may be passed to `source-resolve`. If none is passed, Core resolves the app's stored ref or `HEAD`.

## Runtime Behavior

Local command runtime profiles require a source root. Core resolves it in this order:

- administrator-selected `source-override` path, when configured;
- local worktree inferred at install/update time when the manifest was loaded from a local filesystem path;
- managed checkout under `apps/<app-id>/source` when the manifest was loaded from an HTTP(S) URL.

When a manifest is installed from a local manifest file or app directory, Core treats that filesystem location as a developer/operator-owned worktree. It does not clone or fetch `source.repository`; instead it records the nearest Git root above the manifest when one exists, or falls back to the manifest directory/relative `workingDirectory` inference.

When a manifest is installed from an HTTP(S) URL and the selected runtime profile is `localCommand`, Core requires an app-level `source.repository` that can be cloned as an absolute Git URL or local repository path. Relative repositories such as `.` are rejected for this remote-manifest start path because Core has no repository root to resolve them against.

Docker runtime profiles do not need a source root and ignore source checkout state during start. Source override state is not public manifest metadata; it belongs to the local Hosty installation.

Docker-only apps remain valid without source metadata. Resolving source for an app with no source repository returns a Core validation error instead of changing the app.

The managed checkout lives inside the app root, so removing the app with "Delete source checkout" enabled removes it (both the current in-root location and the retired top-level `sources/<app-id>` location, for installs that predate the move). The dedicated `source-cleanup` commands and Core cleanup endpoints were removed together with the top-level `sources/` root.

Local command runtimes are Core-supervised process runtimes. Core starts each service command from the resolved working directory, injects app data/settings/dependency/port/Core identity environment, captures stdout/stderr into app logs, and reports per-service health with process state, PID, exit code, log path, and working directory. Core fails the start when the resolved working directory does not exist; it does not create missing source directories on behalf of the app.

Core places each published `localCommand` service inside an operating-system process-tree boundary before the platform shell starts: a dedicated process group on POSIX and a kill-on-close Job Object on Windows. Stop terminates that boundary rather than relying only on a snapshot of parent/child relationships. A command chain such as `cmd → npm → tsx → node` therefore cannot leave the final Node runtime holding its assigned port when an intermediate process exits during shutdown. Setup commands use the same temporary Windows boundary, and closing Core itself also closes every owned job.

## Runtime Switch Reviews

`hosty apps switch-runtime-plan <app-id> --runtime <key>` returns a reviewed plan with a digest and a `changes` list. The plan compares the current and target runtime contracts, including runtime type, service images or commands, ports, service environment keys, settings, dependencies, endpoint contracts, data target compatibility, and generated Docker container names. `hosty apps switch-runtime` requires the reviewed digest, and Core includes the `changes` list in the digest seed so a stale review is rejected if the runtime contract changes before apply.

Runtime switching can move between Docker profiles, from Docker to `localCommand`, and from `localCommand` back to Docker. Core rejects switching an app with existing primary data to a target runtime that cannot preserve a compatible primary data target.

When a running app is switched, Core stops the current runtime, updates selected runtime state, and starts the target runtime. If the target runtime fails to start, Core restores the selected runtime in installation state to the previous runtime, leaves the app stopped, records `LastError`, and returns `runtime_switch_restart_failed`. Any `pre-runtime-switch` backup created before mutation remains available through normal backup commands.

## Default Hosty Apps

Hosty Shell is also a runtime app. Its manifest declares Docker and `dev` local command runtime profiles, so administrators can use the same source commands for Shell-only local runtime work:

```bash
hosty apps source-override hosty.shell --path "$PWD"
hosty apps switch-runtime-plan hosty.shell --runtime dev
hosty apps switch-runtime hosty.shell --runtime dev --plan-digest <digest>
```

Core and combined-Host self-runtime changes are different from Shell-only changes. Core cannot complete its own replacement after it stops, so Core runtime switching still requires the trusted CLI or another outer supervisor.

Shell also exposes Hosty Shell runtime switching in the Installed Apps System Apps table when Core reports multiple runtime profiles. System apps also use the ordinary lifecycle controls; stopping Shell interrupts its UI.

## Testing Expectations

- Changing the selected profile's development flag in either direction appears in the update plan and requires review, even alongside a version bump.
- `source-override` records the folder's commit as the override's own and leaves the reviewed pin unchanged, including for a folder nested inside a repository; clearing the override drops both.
- A schema-version-1 record that has an override reads back with its commit moved to the override's field, once, and keeps a reviewed pin recorded afterwards.
- A pinned start (reviewed source profile) checks out the recorded pin — including one a reviewed update has just advanced to — with an override configured, and fetches when the checkout does not have that commit yet.
- A pinned start whose recorded commit is unreachable even after a fetch falls back to the reviewed ref instead of failing.
- A pinned start refuses a dirty checkout with `source_changes_present`, preserving staged, unstaged and untracked work. Non-forcing checkout also protects ignored files that would be overwritten.
- On Windows, stopping a `localCommand` service terminates descendants held by its Job Object even when an intermediate command process has already exited; an immediate start can reuse the assigned port.
- Source status covers clean, staged, unstaged/untracked, unborn, detached, linked-worktree, no-Git,
  missing and truncated states; monorepo observations exclude sibling apps and shared root files.
- Reviewed discard refuses changed content/index/HEAD/bindings, symlinks and special files, preserves
  unrelated staging, and handles literal filenames, renamed files and cached deletions.
- Browser source routes reject non-admin sessions and missing CSRF; trusted control routes require
  the control secret. Large child-process outputs are drained with bounded retention.
- Core-managed Shell verification: edit a clean Demo App source file, see the changed title in the
  embedded app, inspect its diff, review/discard that file, verify clean scoped status and the original
  title. This verifies source operations, not assistant execution grants or app-role identity.

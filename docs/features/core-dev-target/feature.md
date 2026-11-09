---
created: 2026-09-18
updated: 2026-10-26
summary: Run Core from source in Debug, restart into isolated build generations and switch back to the installed release.
components: [apps/core, apps/cli, apps/shell]
---

# Core Development Mode

Core remains a CLI-launched platform process. The Dashboard Core row exposes Release and named
existing workspace selection through More > Runtime / workspace, plus Restart, console logs and
separate Source settings. The row has one contextual action: pending progress, Restart for a
reported pending change, Logs for a factual degraded/unhealthy/failed Core status, then Stop.
Source/Git, configuration and update-check warnings do not count as runtime-health failures.
The selector has no generic Source/main target. Its current state comes from the running Core;
there is no browser-owned launch mode and no persisted default mode.

## Launch And Restart

`hosty --data-root <root> core start --project <absolute-csproj>` and `core restart --project ...`
prepare a Debug build in `<root>/core/builds/<generation>/artifacts` using .NET's artifacts layout.
Each generation isolates intermediates and executable output, including dependencies. The CLI
launches the prepared apphost directly, without another build or restore. Watch/hot reload is not
part of this workflow. Foreground launches use the same preparation and release the launch lease
once startup has been checked.

Preparation precedes stopping the old Core. A compiler failure returns a nonzero CLI exit code,
the original diagnostics and build-log path, and leaves the running instance untouched. The
restart operation carries a bounded compiler-error summary for Shell toasts. A successful build
followed by startup failure is a failed operation: the previous output and logs remain, but there
is no automatic binary rollback or data restore.

Without `--project`, both Start and Restart select the installed release executable, regardless
of Source settings or any previous launch. Shell and MCP preserve the live mode by supplying the
project explicitly. A conflicting `core start` is refused rather than silently switching an
already-running instance. Status includes mode, absolute project and generation paths, PID, and
process start time on authenticated/control surfaces. A direct launch without launcher metadata
reports `unmanaged`; Shell displays it as `external` with a keyboard-accessible tooltip explaining
the external launch and CLI recovery. New runtime selection is disabled when launch control or the
Hosty CLI is unavailable; an existing retained operation remains inspectable.

The Dashboard and app menus share the name Runtime / workspace. Core offers Release and matching
registered workspaces by their names, with unavailable reasons and a checkmark based on its actual
project. Its source identity still shows only the workspace display name or observed branch/commit
with a dotted underline and complete hover/focus/click details. The adjacent runtime reads workspace
when the factual development project matches an active registered worktree, otherwise source; the
backend launch mode remains `dev`. Configured source for a later restart never relabels the live
project. Source settings and IDE/external state remain available independently of selectable targets.

Opening the Core selector reads one uncached `GET /api/core/execution-targets` catalog. It projects
owned, authorized registered workspace metadata against the configured Core repository/project and
includes retained Core operations for recovery. Listing does not collect Git status/diffs, hash executables or
prepare activation plans for every candidate. The selected destination receives a fresh Core-only
review before switching; catalog availability is not permission to apply. Reopening the menu
refreshes its choices. Only unfinished or conflicting switches add a contextual recovery/progress
entry; healthy active switches add no separate details action.

Start, Restart, Stop, Update, Source edits and detached restart operations coordinate through one
per-data-root launch lease. `hosty update` updates installed release artifacts while a dev Core
continues running; Shell hides release updates and does not initiate release checks in dev mode.

## Source

Source configuration is stored in `<root>/core/source-settings.json`, independently of live launch
identity. The Core settings dialog follows app settings layout: a wide dialog with the component ID,
a Source section, Standard Hosty source and Custom source folder cards, and a fixed Save source footer.
Save is enabled only for a changed, nonempty custom path or clearing an existing override.
Save failures appear inline with alert semantics for assistive technology.
The existing Shell dialog edits the folder override; the administrator API also supports a repository
URL, ref and relative project path through [Core source configuration](../workspace-live-activation/feature.md).
New selections use separate managed checkouts; legacy `<root>/core/source` and overrides remain intact.
Restart reuses the selected checkout without an implicit pull. An override is an absolute host
repository directory containing the configured Core project; saving it does not rewrite or clean
the repository. The default project path remains `apps/core/src/Haas.Hosty.Core/Haas.Hosty.Core.csproj`.
The development API reports embedded build provenance separately from selected source and release
update origin.

Git presentation describes the running project in dev mode, including branch (or detached commit),
changed files and available additions/deletions, including untracked files. The changed-file
summary opens the shared read-only [Core source viewer](../core-source-inspection/feature.md).
The Source dialog separately shows the selected
checkout and running project. Missing Git or unavailable source is a visible diagnostic.

Source saves use a revision check. A dev Source change creates a pending change bound to the
current Core instance. The title row shows a yellow warning `Restart required` badge, and the single
contextual button becomes Restart with the same handler as More > Restart Core. There is no
separate inline warning or additional restart icon. Preparation failure preserves the pending
change and live instance.
A successful replacement clears that instance's pending indication. Release Source edits need no
restart. A stale instance or Source revision is refused. The running project path is normalized
before comparison so Windows separator differences do not leave a spurious pending restart.

## Durable Restart Operations

Admin HTTP routes are:

- `GET /api/core/development`: factual launch and selected-source state.
- `PUT /api/core/source`: `{ overridePath, revision, repository? }`, with browser CSRF protection.
  The optional repository selection and preparation/workspace routes are documented in
  [Core source and participants](../workspace-live-activation/feature.md).
- `POST /api/core/restart`: `{ requestId, instance, mode?, sourceRevision }`, with browser CSRF
  protection. Omitted mode preserves the live target and applies pending Source changes.
- `GET /api/core/operations/{requestId}`: durable operation status and diagnostics.

Request IDs are UUIDs formatted as 32 hexadecimal characters. Invalid request arguments return
HTTP 400; stale instance/source state and busy operations return HTTP 409. The accepted record is persisted
before spawning the detached CLI helper. Retrying the same ID returns its existing operation.
Statuses distinguish accepted, building, starting, completed and failed. Completion requires the
replacement Core's reported launch target to match the prepared target. A dead helper is reported
as failed, with its retained log; a lost HTTP response is not proof that a restart failed or succeeded.

The existing Core MCP provides `get_core_development`, `restart_core(requestId, instance,
sourceRevision)`, and `get_core_operation`. `get_host_status` also reports launch identity.
Restart requires an administrator session or `mcp:read` + `mcp:core-restart` for audience
`hosty:core`. App lifecycle authority does not grant Core restart. Delegated/facade credentials
remain unable to mutate Core. Consent and manual token issuance expose the separate grant.
Restart is annotated as disruptive; caller-generated operation IDs provide deduplication.
Audit entries record requests/refusals, and durable operation records hold helper outcomes.

Shell retains only the pending operation ID in session storage so a reload can resume status
checks. It reconnects and reads the result without automatically replaying the mutation. If Core
cannot start, the local CLI and log files remain the recovery interface.

## Stopping Core Without Stopping Apps

The administrator HTTP endpoint `POST /api/core/stop` takes `{ instance }` and requires browser
CSRF protection. Its management route maps to `core.lifecycle`. An empty instance is invalid;
a stale instance or concurrent restart, Source edit or workspace handover is refused before
shutdown. Admission uses the same per-data-root cross-process launch lease as the CLI and other
Core lifecycle operations, and retains it until the admitted Core has stopped.

Acceptance returns HTTP 202 with `{ status: "accepted", instance, keepApps: true }`. Shutdown is
signalled only after response completion. Core preserves the existing runtime applications and their
runners; it does not stop apps, delete source or remove workspace data. The receipt acknowledges the
request rather than proving process exit. The bounded `core.lifecycle.stop` audit record contains
reviewed lifecycle metadata and outcome, without request bodies, secrets or runtime configuration.

Shell rereads factual development state before asking for destructive confirmation and submits the
reviewed instance. The confirmation explains that Core APIs and management go offline, applications
remain running, and the local Hosty CLI is needed to start Core again. It prevents duplicate
submissions and cancels obsolete queued work when the Core origin/instance changes or management
is disabled. Accepted or uncertain requests keep the control busy; a lost connection, server failure
or unrecognized receipt does not
produce false exit confirmation or automatic retry. The operator checks Core through the local CLI
before trying another request.

A new `hosty --data-root <root> core start` restores management access. Starting the intended
source build still requires its explicit `--project <absolute-csproj>`; omitting it selects the
installed release.

## Surviving Local Services

A minimal independent runner owns each newly launched `localCommand` service's stdout/stderr,
process group on POSIX, and kill-on-close Job Object on Windows. Core-only shutdown does not
close the Windows job. On Windows the runner also remains alive after the command shell exits
while service descendants remain in its job, so a replacement Core can adopt and stop them.
For explicit Stop, Core opens the runner's named job using its verified PID/start identity,
checks membership and retains member process handles until their exit signals, as well as checking
that job accounting is empty. No Core-owned handle is retained
during normal operation. A failure to terminate or confirm job shutdown fails Stop. Core
also waits on every operating system for the recorded service TCP ports to become available before Stop returns;
a port that remains unavailable fails Stop without killing any unrelated holder. Runners
created before named-job support retain the legacy best-effort stop path until their next app restart.
On POSIX, the port wait follows process-group reclaim: a runner exiting does not imply that its
descendants have already released their listening sockets. Immediate Restart therefore waits for
the previous service's ports instead of failing the new command's port preflight. The wait is bounded
and cancellation-aware, applies to registered, adopted, and pidfile-only recovered services, and does not add a delay when
the ports are already free.
Stop attempts every service before reporting teardown failures. Start rollback also attempts every
started service and preserves the original start error while logging cleanup failures.
Runners append console logs and rotate at 10 MiB with two previous files;
Core reads these files after handover. OTLP telemetry is independent.

PID records include process start time, instance/app/service identity, executable, runtime,
command, working directory, actual ports, log path and runner generation. They do not include
injected credentials. Startup adopts verified live services before autostart reconciliation,
including unhealthy services and apps with autostart disabled. Adoption does not run setup or
replace the process. Unverifiable ownership blocks automatic startup and records an error;
foreign listeners are never evidence of ownership. Explicit app Stop/Restart still controls
the process tree after adoption. An explicit Stop clears an adoption conflict only after all
ownership records have been removed; failed record cleanup keeps automatic startup blocked.

Existing legacy PID records can be adopted using their recorded PID/start identity, but their
old Core-owned pipes cannot be reattached. Full log and Windows lifetime continuity applies
once the service has been started with the independent runner. There is no forced migration
restart of an active app.

Hosty Harness distinguishes transient Core/token-exchange failures from credential refusals.
A temporary outage preserves the active session, harness and MCP routes; background token
refresh retries after 15 seconds. A failed mint returns a retryable unavailable response before
forwarding a tool call. It neither marks the delegation expired nor replays the mutation.
Actual authorization refusal still removes the expired delegation.

## Output Retention

Only generation directories with Hosty's versioned ownership marker are eligible for cleanup.
Lifecycle-triggered cleanup retains live process outputs, prepared output owned by a live helper,
the newest two successful builds, the latest diagnostic/preparation output, and generations
referenced by surviving local runners. Installed/DLL-hosted Core copies its runner output closure
into a managed generation so release replacement is not blocked by runner executable locks.
Uncertain ownership, unreadable metadata and locked files fail conservatively; cleanup cannot
turn successful startup into failure. Source, operator output, app data and operation logs are
outside this cleanup. There are no automatic Core-state snapshots.

## Verification Recorded On 2026-09-18

The implementation was exercised on macOS ARM64 with isolated data roots and ports. No live user
Core or Shell was restarted. The local run verified:

- Real CLI dev restart with the same runner, child PID, port and continued stdout/stderr; an
  unhealthy service was adopted; explicit Stop subsequently stopped the adopted process tree.
- Compiler failure through CLI and the pending-Source HTTP operation left the active Core alive.
  Direct scoped MCP restart completed, preserved the actual project and deduplicated the same
  request ID after reconnect. Explicit release selection used the isolated installed slot.
- A Core-managed Shell opened the Source-only dialog, saved Standard/Override choices, showed
  `Restart required`, and successfully restarted dev Core while Shell stayed alive and reconnected.
- An eligible Docker container retained its ID and start time across dev Core restart, deliberate
  post-build startup failure and explicit source recovery. A published CLI/Core artifact update
  in a disposable installation preserved the live dev Core identity and generation.
- Actual Core-managed Hosty Harness processes in local and dev profiles retained their active fake
  harness session across restart and completed the pending action once without a second message.
  Automated Gateway tests also covered transient credential refresh and proxy-token mint recovery.

`npm run cli:test` passed 221 tests, `npm run shell:test` passed 162, and `npm run ai-gateway:test`
passed 283. The full Core suite passed 1968 tests with four existing opt-in integration skips, including the final revision and
ownership guards. One existing TIME_WAIT port
availability test failed under concurrent load, passed in isolation, and passed on the full rerun.
Shell lint has zero errors and two existing navigation warnings. Shell production build passed
with `npm run build --workspace @haas/hosty-shell -- --webpack`; the default Turbopack build could
not run in this environment. Core Native AOT published for osx-arm64 without new trim/AOT warnings.
Version consistency and documentation-index checks pass.

After integrating main at `c502a77c`, Shell tests passed 164 and Gateway tests passed 300.
Both components passed lint (the same two existing Shell warnings) and production webpack builds.
Core/CLI sources are unchanged by that integration. Release versions are platform 0.105.0,
Shell 0.79.0 and Gateway 0.30.2; shared launch sources are included in CI and release path filters.

Linux ARM64 validation used the official `mcr.microsoft.com/dotnet/sdk:10.0` container with an
isolated source copy: Core tests filtered to `CoreDevelopmentTests`, `McpLifecycleHttpTests` and
`LocalCommand` passed 69 tests; the full CLI suite passed 221. Windows execution, a complete Linux
CLI/Shell end-to-end run and a real provider-backed active agent turn remain unverified and are
tracked in [the remaining plan](plan.md). The four opt-in Docker/VPN/telemetry suites were not enabled;
the separate disposable Docker-container continuity check above did run.
The fake harness is an in-process fixture and is not evidence of a provider subprocess surviving.

PR review regression checks cover unavailable CLI paths for both managed modes, HTTP 400 versus
409, and explicit recovery of adoption conflicts without killing reused PIDs. The complete local
Core suite passes 1976 tests with the same four opt-in skips. The explicit local `npm run test:integration -- windows` suite
also covers runner log survival and explicit recovery, including adoption and Stop after the command
shell exits while its detached descendant remains alive.

## Workspace Runtime Activation

[Workspace activation](../workspace-live-activation/feature.md) composes explicitly bound applications
and repository-matched Core with a reviewed selection, supervised handover and individual/group
Return. Runtime consumers persist independently of workspace Close and sandbox Finish. Core
participation requires separate Core authority; ordinary source or lifecycle access is insufficient.
Return preserves current data and live source edits.

The Dashboard Core selector reads existing named workspace candidates and reviews an explicitly
Core-only selection, deselecting every app participant before apply. It reuses the same administrator,
source/binding and separately reviewed Core activation authority as Harness. Opening the menu or
review does not change runtimes. The dialog lives outside the transient More menu.

A retained active Core workspace can switch directly to another reviewed workspace. The detached
handover builds the selected candidate before Stop, verifies its workspace-handover contract and
transfers Core ownership only after exact candidate readiness. Applications retain their selected
runtimes and current data. The new activation retains the chain's original captured Return target.
Release selection explicitly accepts current-data compatibility with that baseline; source/dev
baselines still require explicit continuation to installed Release.

Ordinary same-target CLI start/restart records a separate durable workspace-launch continuation
before Stop and updates the owning activation only after the exact prepared generation confirms
readiness. The executable, generation marker, PID and process-start identity are checked. A lost
ready response recovers the retained prepared generation instead of rebuilding or adopting a
process merely because its project path matches. The original captured Return executable and
application ownership remain unchanged; pending generations remain protected from cleanup.

Old launches without continuation evidence require an explicit local administrator recovery:
`hosty --data-root <root> core adopt-workspace <activation-id> --instance <pid:ticks> --generation
<absolute-path>`. This metadata-only operation checks the factual current instance, managed
executable/hash, generation ownership, registered workspace/project/source and retained authority
before writing an explicit adoption receipt. It does not claim historical restart ancestry, stop
Core, select another target or change the captured Return baseline. An unconfirmed or unrelated
process remains blocked.

Candidate builds expose the read-only `--workspace-activation-contract` probe. Direct handover and
workspace restart continuity require `workspace-activation.2` before any application or Core Stop.
An older candidate receives an actionable update refusal while the current Core remains running.
Existing Return to the captured baseline retains its exact executable/hash contract.

Workspace apply/Return requests and staged Release are retained without credentials under the
current user/Core-origin scope. Reconnect and remount read status rather than creating another
request. Failed preparation exposes diagnostics and exact retry or explicit review of the same
selection after source repair; resume and boundary pause reuse the retained operation. Actor/scope
changes abort queued mutations and discard stale read results. Core's existing CLI/log recovery
remains available when a returned older Core cannot serve these APIs.

A successful Core Return to Release can be followed by a later workspace launch while a browser
is closed or suspended. When Shell reads the successful Core-return receipt and a factual dev
launch newer than the returned activation, it clears only that completed browser recovery entry.
Dashboard lifecycle controls become available again; the current Core and application runtimes
stay as they are. Pending/failed returns, an unconfirmed request, a dev Return baseline or the
original launch keep their recovery state.

## Testing Expectations

- CLI: build failure before stop, explicit release/dev selection, isolated output and generation
  retention, including a live runner reference and unknown directories.
- Core: Source revisions and pending state, durable operation deduplication, admin/CSRF and
  dedicated MCP grants, inherited/delegated refusal, readiness identity and AOT JSON metadata.
- Runner: surviving closed parent pipes, continued console capture, PID/port adoption, reused-PID
  refusal, unhealthy/autostart-disabled adoption, rotation and explicit tree stop after handover.
  On Windows, verify a detached descendant's actual TCP port can be rebound immediately when
  Stop returns, both with the original registry and after adoption. Do not hide teardown races
  by awaiting the descendant or retrying the bind before this assertion.
  On POSIX, cover delayed socket release after the registered root exits, including an already-exited
  root, and a port that remains held: Stop must fail within its deadline and leave unrelated listeners alive.
  Include pidfile-only recovery, stopping siblings after a port timeout, and start rollback preserving
  the original failure while stopping all previously started services.
- Core Stop: administrator/CSRF and `core.lifecycle` route mapping, empty and stale instance
  refusals, conflict with restart/Source/workspace/CLI launch admission, response-completion ordering,
  lease retention through shutdown, preserved runtime apps, bounded audit metadata and AOT JSON
  contracts. Acceptance is not exit proof; no shutdown starts after an admission or response failure.
- Shell: live mode and Git/version cells, Source dialog, title-row Restart required badge and one
  contextual pending/Restart/factual-problem Logs/Stop action, with no extra restart icon or inline
  warning. Verify fresh-instance Stop confirmation, cancellation, duplicate protection, Core scope
  and management-permission changes, exact accepted receipt and retained uncertain state after
  lost/malformed responses. Stop Core remains in More when narrow layouts hide the contextual button.
  Stop explains local CLI recovery and never automatically replays or claims exit from acceptance.
  Retain compiler diagnostics, operation reconciliation after connection loss and hidden dev updates.
  Runtime / workspace lists Release and eligible existing named workspaces, with no generic
  Source/main option. Verify direct Core-only handover, exact workspace/worktree/project and factual
  generation/PID/start checks, explicit baseline Return compatibility and factual Release readiness. Retain original IDs/bodies
  through uncertainty, stale-review repair, remount and queued actor cancellation; do not replay
  work after an unknown status. External launches explain unavailable selection on hover/focus,
  while Source settings and factual source/IDE state remain available.
  Git inspection errors retain the amber dev warning and accessible diagnostic even with cached Git
  data, without selecting the contextual Logs action; Source save failures expose an alert without
  requiring focus to move. Runtime health uses only factual Core status, never Source/Git,
  configuration or update-check errors.
- Gateway: token outage versus revocation and recovery through the same proxy route without
  forwarding or replaying the failed mutation.
- Exercise a Core-managed instance on each supported OS; verify the actual Gateway/harness turn
  as well as process identity. Record unavailable platform/provider checks explicitly.

- Verify durable same-target workspace restart continuation before/after lost ready receipts,
  original baseline preservation, pending generation retention, exact executable/marker/process
  checks and explicit legacy adoption without guessed history or source/grant bypass.

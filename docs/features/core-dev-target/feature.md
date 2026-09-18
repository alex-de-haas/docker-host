# Core Development Mode

Created: 2026-09-18
Updated: 2026-09-18

Core remains a CLI-launched platform process. The Dashboard Core row exposes release/dev selection,
Restart, console logs, and a Source-only settings dialog. Its state comes from the running Core;
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
reports `unmanaged`; Shell disables launch control and directs the operator to the CLI.

Start, Restart, Stop, Update, Source edits and detached restart operations coordinate through one
per-data-root launch lease. `hosty update` updates installed release artifacts while a dev Core
continues running; Shell hides release updates and does not initiate release checks in dev mode.

## Source

Source configuration is stored in `<root>/core/source-settings.json`, independently of live launch
identity. Standard uses `<root>/core/source` and clones the official repository's default branch
on first use. Restart reuses the checkout without an implicit pull. Override is an absolute host
repository directory containing `apps/core/src/Haas.Hosty.Core/Haas.Hosty.Core.csproj`; saving it
does not rewrite or clean the repository.

Git presentation describes the running project in dev mode, including branch (or detached commit),
changed files and tracked additions/deletions. The Source dialog separately shows the selected
checkout and running project. Missing Git or unavailable source is a visible diagnostic.

Source saves use a revision check. A dev Source change creates a pending change bound to the
current Core instance. The row shows `Restart required` and an inline Restart with the same action
as the normal Restart button. Preparation failure preserves the pending change and live instance.
A successful replacement clears that instance's pending indication. Release Source edits need no
restart. A stale instance or Source revision is refused.

## Durable Restart Operations

Admin HTTP routes are:

- `GET /api/core/development`: factual launch and selected-source state.
- `PUT /api/core/source`: `{ overridePath, revision }`, with browser CSRF protection.
- `POST /api/core/restart`: `{ requestId, instance, mode?, sourceRevision }`, with browser CSRF
  protection. Omitted mode preserves the live target and applies pending Source changes.
- `GET /api/core/operations/{requestId}`: durable operation status and diagnostics.

Request IDs are UUIDs formatted as 32 hexadecimal characters. The accepted record is persisted
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

## Surviving Local Services

A minimal independent runner owns each newly launched `localCommand` service's stdout/stderr,
process group on POSIX, and kill-on-close Job Object on Windows. Core-only shutdown does not
close the Windows job. Runners append console logs and rotate at 10 MiB with two previous files;
Core reads these files after handover. OTLP telemetry is independent.

PID records include process start time, instance/app/service identity, executable, runtime,
command, working directory, actual ports, log path and runner generation. They do not include
injected credentials. Startup adopts verified live services before autostart reconciliation,
including unhealthy services and apps with autostart disabled. Adoption does not run setup or
replace the process. Unverifiable ownership blocks automatic startup and records an error;
foreign listeners are never evidence of ownership. Explicit app Stop/Restart still controls
the process tree after adoption.

Existing legacy PID records can be adopted using their recorded PID/start identity, but their
old Core-owned pipes cannot be reattached. Full log and Windows lifetime continuity applies
once the service has been started with the independent runner. There is no forced migration
restart of an active app.

AI Gateway distinguishes transient Core/token-exchange failures from credential refusals.
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
- Actual Core-managed AI Gateway processes in local and dev profiles retained their active fake
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

## Testing Expectations

- CLI: build failure before stop, explicit release/dev selection, isolated output and generation
  retention, including a live runner reference and unknown directories.
- Core: Source revisions and pending state, durable operation deduplication, admin/CSRF and
  dedicated MCP grants, inherited/delegated refusal, readiness identity and AOT JSON metadata.
- Runner: surviving closed parent pipes, continued console capture, PID/port adoption, reused-PID
  refusal, unhealthy/autostart-disabled adoption, rotation and explicit tree stop after handover.
- Shell: live mode and Git/version cells, Source dialog, one Restart action for pending and normal
  use, compiler diagnostics, operation reconciliation after connection loss, and hidden dev updates.
- Gateway: token outage versus revocation and recovery through the same proxy route without
  forwarding or replaying the failed mutation.
- Exercise a Core-managed instance on each supported OS; verify the actual Gateway/harness turn
  as well as process identity. Record unavailable platform/provider checks explicitly.

# Hosty Platform — Full Codebase Review

- **Date:** 2026-07-05
- **Baseline:** `main` @ `26cda25` (platform 0.32.0)
- **Scope:** apps/core (~19k LOC C#), apps/cli (~4.7k LOC C# + tests), apps/shell (~10.7k LOC TS), apps/telemetry-backend, apps/demo-app, apps/telemetry manifest, `.github/workflows`, `scripts/`, channels/skills/repo hygiene.
- **Method:** four parallel static reviews (one per area), every finding verified against surrounding code; the highest-severity claims (Core H1/H2/H3, CSRF asymmetry, CLI uninstall, telemetry ingest cadence) were independently re-verified line-by-line before inclusion. No builds/tests were run as part of this review.

**Severity scale.** *High* — real data-loss, security exposure, deadlock/corruption path, or actively misleading behavior. *Medium* — correctness/robustness defects with a plausible trigger, or systemic drift generators. *Low* — hardening, UX, hygiene.

**Totals:** 0 Critical / 11 High / 30 Medium / ~30 Low across the repo.

> **Remediation status (2026-07-06):** the entire **P0 and P1** tiers (§12) are fixed on `main`.
> **P0:** C-H1 (session-token leak), L-H1/L-H2 (uninstall `--yes` + real data root + PID-wait), T-H1 (misleading "internal network" comment — token auth still deferred to §2d), C-M12 (`/api/core/status` admin-gated), C-M3 (`TelemetryBackendClient` logger), C-M6 (atomic manifest-copy + cloudflared config writes).
> **P1:** C-H2/C-M11 (shared `ProcessRunner` — concurrent drain + deadline + kill-on-cancel — for docker & git), C-H3 (`UserDirectoryStore.UpdateAsync` serialization + all callers migrated), C-H4 (per-app lifecycle locks via `WithAppLockAsync` + `*CoreAsync` split), C-H5/C-M1/C-M2 (partial-start unwind, post-stop inspect, label-checked `rm -f`, periodic label sweep), I-H1 (publish workflows gated on a test job), T-H2 (split ingest cadences + unchanged-sample skip + env overrides).
> New concurrency/process tests added (ProcessRunner, UserDirectoryStore, per-app lock, docker reconciliation, MetricDeduplicator). Core 603 + CLI 130 + telemetry-backend 67 tests green.
>
> **P2 (correctness/UX) is also fixed on `main`:** L-H4 (`JsonException` catch + `RespectNullableAnnotations` + `RequiredHeaders` null-guard), L-M1 (`Timeout.InfiniteTimeSpan` on artifact downloads), L-M2/M5/M6 (`CoreNotRunningException` → exit 1; failure messages to stderr; empty-response messages), L-H3 (channel `ReleaseTag` wired into artifact download + downgrade warning), C-M5 (secrets passed via docker process env, not argv), C-M9 (`requireCsrf` on the 3 plan routes + Shell `sendCsrfJson`), S-H1 (metrics request-generation guard), S-H2 (observability inline empty-state + id constant), S-M1 (`markAllRead` toast), S-M2 (traces/logs keep data on error), D-M1 (demo-app Windows spawn), R-M1 (versioned telemetry-backend image). Core 604 + CLI 147 + telemetry-backend 67 green, Shell builds clean.
>
> **P3 (structural) — the contained, high-leverage half is done on `main`:** §2.4/R-L1/R-L2/D-M2 (`scripts/check-versions.mjs` + CI `versions` job — demo-app baked version synced 0.2.1→0.4.2, channels cliVersion→0.32.0), endpoint-authorization matrix test (source guardrail: every session-authed `/api` mutation must set `requireCsrf` — catches the C-M9 class), I-M2 (build-provenance attestation on the 4 publish workflows) + I-M4 (cache `mode=max`), I-M3 (`.github/dependabot.yml` for actions/npm/nuget/docker; converting the tag-pinned `actions/*` to SHA pins still needs a networked follow-up), L-M4 (deleted `CoreCommand`'s private discovery/client copy — one `CoreControlClient` stack). **Deferred as focused separate PRs (large mechanical churn, high regression risk, correctness now guarded by the tests above):** `MapDual` dual-prefix mapper, Shell `coreFetchJson` helper, `JsonStateStore<T>` unification, `CoreLifecycleService` plan/diff + telemetry-proxy extraction, Shell god-file splits.

---

## 1. Executive summary

The codebase is in good shape overall: no remote-unauthenticated compromise path or guaranteed-data-loss defect was found; SQL is fully parameterized in the telemetry backend; the install scripts are unusually robust for `curl | sh` installers; Shell has zero `any` and zero XSS sinks; Core's test suite is substantial (590+ tests) with a clean fake-based docker adapter harness.

The highest-value problems cluster into five groups:

1. **Secrets/credentials exposure inside the trust boundary** — live session tokens serialized to admin clients (C-H1), app secrets on the `docker run` command line (C-M5), an unauthenticated telemetry data plane reachable by any local process (T-H1), unauthenticated `/api/core/status` that is published through ingress (C-M12).
2. **Process/concurrency discipline is inconsistent** — the docker CLI runner can deadlock Core (C-H2); `UserDirectoryStore` is the one store without write serialization (C-H3); lifecycle verbs have no per-app lock (C-H4). In each case a sibling component already implements the correct pattern — the defect is drift, not ignorance.
3. **Failed-state reconciliation is one-directional** — docker containers that survive a failed stop/start are reported "stopped" forever (C-H5, C-M1); this is the mechanism behind the known "stopped but running" badge issue.
4. **The release pipeline ships unverified bits** — publishing is not gated on CI (I-H1), `hosty update --channel stable` silently installs the rolling `cli-dev` build (L-H3), the telemetry-backend image is `:latest`-pinned (R-M1), binaries are checksummed but not signed/attested.
5. **Duplication is the dominant future-bug generator** — ~40 hand-duplicated `/api` vs `/control/v1` route registrations in Core, two discovery/client stacks in the CLI, ~15 copies of the fetch/error/redirect block in Shell, three manifest-reference normalizers, and four independent hand-maintained version constants. Several present findings (CSRF asymmetry, CLI timeout drift, Shell stale-response bugs) are direct products of this duplication.

The single most valuable structural investment: **make the correct patterns structural instead of conventional** — one `JsonStateStore<T>` with `UpdateAsync`, one shared `ProcessRunner`, one dual-prefix endpoint mapper, one Shell API helper. Each collapses a whole class of current and future findings.

---

## 2. Cross-cutting themes and recommendations

### 2.1 Silent failure swallowing (all components)

The pattern that has already cost production debugging sessions (IPv6 hang incident) is still widespread:

- Core: `TelemetryBackendClient` returns `null` on every failure with no logger injected ([TelemetryBackendClient.cs:36](../../apps/core/src/Haas.Hosty.Core/TelemetryBackendClient.cs)); empty `catch {}` blocks on the lifecycle failure-recording path (`CoreLifecycleService.cs:1553-1590`).
- Shell: `markAllRead` swallows errors with a comment that claims the opposite (`notification-bell.tsx:107-125`); shared-mounts fetch failure renders as "No shared mounts" (`shell-client.tsx:174-178`); error states destroy previously displayed data (traces/logs pages).
- CLI: null-deserialized Core responses exit 1 with no message, or print a notice but exit 0 (`AppsCommand.cs:418-437, 139-140`).

**Recommendation:** adopt a repo-wide rule — *a failure may be degraded but never erased*. Minimum: every catch logs; every "empty because of an error" UI state says so; every null-body CLI response produces a stderr line and nonzero exit. Add `ILogger` to `TelemetryBackendClient` first (known issue, smallest diff, highest recurrence).

### 2.2 Duplication → drift → bugs

Verified drift already caused by duplication: `/api/apps/install/plan` lacks `requireCsrf` while `/api/apps/install` has it (C-M9); `CoreCommand`'s private discovery stack uses a 3 s timeout vs `CoreControlClient`'s 10 s and skips a null guard (L-M4); Shell's metrics page lacks the stale-response token that its two sibling pages implement (S-H1); `NormalizeManifestReference` exists twice with different `file:` semantics (L-M8).

**Recommendation:** four consolidations, in value order:
1. Core: a `MapDual(route, handler, auth)` helper registering both `/api` and `/control/v1` variants — halves `LifecycleEndpoints.cs` and makes auth-guard drift impossible.
2. Shell: a `coreFetchJson<T>(path, { signal, token })` helper (the shape already exists in `catalog-api.ts`) — fixes M4/H1/M8/L4 in one place; optionally lint-ban raw `fetch(` outside it.
3. CLI: delete `CoreCommand`'s private discovery/client copy; route through `CoreControlClient` with a configurable timeout.
4. One shared manifest-reference normalizer (currently 3 variants: `AppsCommand`, `UpdateCommand`, `LaunchSettings`).

### 2.3 Concurrency discipline

Correct patterns exist and are simply not applied everywhere:

- `NotificationStore`, `AppAuthCodeStore`, `GlobalMountService` serialize read-modify-write with a `SemaphoreSlim`; `UserDirectoryStore` (auth-critical: sessions, users, invitations) does not (C-H3).
- `AppRegistryStore` serializes single writes but whole lifecycle operations interleave (C-H4).
- Shell: request tokens exist on 3 pages, AbortControllers on 3 others; no page has the full set it needs (S-H1, S-M8).

**Recommendation:** structural fixes — `JsonStateStore<T>.UpdateAsync(Func<T,T>)` shared by all Core stores; per-app `SemaphoreSlim` keyed like `AppRegistryStore.appLocks` around each public lifecycle verb; Shell fetch helper with built-in token+abort semantics.

### 2.4 Version constants scattered by hand

Four independently hand-maintained version sources have drifted: `channels/product-channels.json` says `cliVersion: 0.3.0` vs actual 0.32.0; demo-app bakes `0.2.1` in two places vs manifest 0.4.2; `eslint-config-next` 16.0.7 vs `next` 16.2.6. This is the same failure class as the historical package.json/Directory.Build.props incident.

**Recommendation:** a CI consistency check (script comparing manifest/package/Dockerfile/channel versions) — cheaper and more reliable than extending the AGENTS.md checklist.

### 2.5 Release integrity chain

Today: push to `main` → images/`cli-dev` published immediately, in parallel with (not gated on) CI; checksums are same-origin with binaries; channels metadata is decorative (L-H3). Before any "stable" channel is advertised, the chain needs: CI-gated publishing (I-H1) → channel-wired artifact URLs (L-H3) → provenance attestation (I-M3) → version-pinned system-app images (R-M1).

---

## 3. Core (`apps/core`) — 5 High, 13 Medium, 8 Low

### High

**C-H1. Live session tokens serialized to clients.** `DomainEndpoints.cs:41,49` return `state.Sessions` inside `UsersResponse` (`:82-86`); `AuthSessionRecord.Id` *is* the `hosty_session` cookie value compared directly in `CoreSessionAuthorization.ResolveSessionAsync` (`CoreSessionAuthorization.cs:94-104`). Every admin Users-page response contains every user's bearer credential — one XSS, HAR file, or debug log away from full multi-user session hijack. **Fix:** purpose-built session DTO (created/expires/revoked + hashed or truncated id) for both `/api/users` and `/control/v1/users`. *Independently re-verified.*

**C-H2. Docker CLI runner can deadlock Core.** `ProcessDockerCommandRunner.RunAsync` (`RuntimeAppManifest.cs:991-993`) awaits stdout `ReadToEndAsync` to completion before touching stderr; a child writing >~64 KiB to stderr while stdout is open blocks forever (`docker logs --tail 1000` on a stderr-chatty app is a realistic trigger; `docker pull` progress another). No timeout; cancellation abandons but never kills the child, so a wedged docker daemon hangs lifecycle verbs indefinitely. Same sequential pattern in `AppSourceService.RunGitProcessAsync` (`AppSourceService.cs:399-401`), which additionally never disposes the `Process` (C-M11). **Fix:** one shared `ProcessRunner` — concurrent stream draining (`Task.WhenAll`), overall deadline, `Kill(entireProcessTree: true)` on cancellation, `using` disposal — used by both docker and git call sites. *Independently re-verified.*

**C-H3. `UserDirectoryStore` has no write serialization.** `UserDirectoryStore.cs:7-12` is a bare read/write; all callers (session create `AuthEndpoints.cs:207-216`, logout, invitation lifecycle, user updates, assignments in `UserManagementService.cs`, bootstrap) do whole-document read-modify-write. Two concurrent logins can drop a session record (user holds a cookie Core never persisted → immediate 401s); login racing invitation-accept can drop the new user. Sibling stores already implement the guarded-`UpdateAsync` pattern. **Fix:** `SemaphoreSlim`-guarded `UpdateAsync(Func<state,state>)`, migrate all callers. *Independently re-verified.*

**C-H4. No per-app operation lock in `CoreLifecycleService`.** `ApplyUpdateAsync` (`CoreLifecycleService.cs:644-689`) and `ApplyRuntimeSwitchAsync` (`:738-796`) read the app record, run long operations, then upsert a rebuilt record — a concurrent `ConfigureAsync` committing in between is silently reverted (settings loss). Concurrent `StartAsync` calls interleave `docker rm -f`/`run`. **Fix:** per-app `SemaphoreSlim` around each public lifecycle verb; do record rebuilds inside `UpdateAppAsync` lambdas (as `ReconcileLiveContractAsync` already does).

**C-H5. Docker adapter doesn't unwind partial multi-service starts.** `DockerRuntimeAdapter.StartAsync` (`RuntimeAppManifest.cs:1019-1210`) has no failure unwind (the localCommand adapter does: `LocalCommandRuntimeAdapter.cs:137-145`); `CoreLifecycleService.StartAsync` cleanup is gated on `runtimeStarted` which is only set after the whole adapter returns (`:489-517`). Service B failing leaves service A's container running while the record says `stopped` — and per C-M1 the drift is permanent. **Fix:** unwind started containers in the adapter's catch, or stop unconditionally on recordable start failure.

### Medium

**C-M1. "Stopped but actually running" docker drift is permanent.** `docker stop` runs with `ignoreFailures: true` and unconditionally returns `stopped` (`RuntimeAppManifest.cs:1212-1220`); health observation only probes apps *persisted* as running (`CoreLifecycleService.cs:3579-3584`); list-path reconcile is localCommand-only (`:3498-3501`). Matches the known stale-badge issue. **Fix:** inspect after stop and record failure if still running; periodic docker-label sweep (`docker ps --filter label=hosty.app.id` — `DockerStatsExposition` already polls every 10 s) to reconcile all container states. Pairs with adding a `hosty.app.id` label check before `rm -f` (C-M2).

**C-M2. Container/network name collisions.** `BuildContainerName` normalizes every non-alphanumeric to `-` (`RuntimeAppManifest.cs:1668-1672, 1907-1911`): `my.app`/`my-app` collide; app `x-y` service `z` vs app `x` service `y-z` collide. Start does `docker rm -f <name>` (`:1046`) — one app can kill another's container. **Fix:** unambiguous separator + short hash, or label-checked removal.

**C-M3. `TelemetryBackendClient` swallows every failure silently.** (`TelemetryBackendClient.cs:36-56`) — known issue, confirmed: no logger injected; misconfigured backend indistinguishable from "no data". **Fix:** inject `ILogger`, rate-limited/state-change warnings; surface backend reachability on core status.

**C-M4. Empty catch blocks on the failure-recording path.** `RecordBackgroundLifecycleFailureAsync` (`CoreLifecycleService.cs:1553-1557`), `RecordForegroundLifecycleFailureAsync` (`:1576-1578`), `TryStopRuntimeAsync` (`:1581-1590` — a bare `catch {}`). If persisting `LastError` fails, both the original failure and the recording failure vanish. **Fix:** log in all three; narrow the bare catch.

**C-M5. Secrets on the `docker run` command line.** Settings (incl. secrets) and `HOSTY_APP_SERVICE_TOKEN` passed as `-e KEY=VALUE` argv (`RuntimeAppManifest.cs:1104-1120`) — visible to every local user via `ps`/`/proc/*/cmdline` while the CLI runs. **Fix:** mode-0600 `--env-file` deleted after start, or `-e KEY` with values in the child environment.

**C-M6. Reviewed manifest copy written non-atomically.** `AppManifestService.SaveManifestCopyAsync` uses plain `File.WriteAllTextAsync` (`RuntimeAppManifest.cs:54-67`); corruption bricks every lifecycle verb for that app (`manifest_json_invalid`, no self-heal). Same for the cloudflared config write (`CloudflareIngress.cs:103`). **Fix:** route both through the `JsonStorage` temp+rename idiom (this is exactly the [[core-private-file-create-or-load]] class of bug).

**C-M7. `Exited` handler races `Process.Dispose()`.** `LocalCommandRuntimeAdapter.cs:108-112` vs `:731`; a late `Exited` callback reading `process.ExitCode` after dispose throws on a threadpool thread → unhandled exception → Core process death. Narrow window, host-crash cost. **Fix:** try/catch in the handler body.

**C-M8. Session records grow without bound and are scanned per-request.** Sessions only appended/flagged, never pruned; `state.json` re-read and linearly scanned on every authenticated request (`CoreSessionAuthorization.cs:100-104`). **Fix:** drop expired+revoked during session create or a retention pass (`NotificationRetentionScheduler` is the template).

**C-M9. Plan-creation POSTs lack the CSRF guard; manifest fetch is an SSRF primitive.** `/api/apps/install/plan`, `/{id}/update/plan`, `/{id}/switch-runtime/plan` are POSTs without `requireCsrf: true`, unlike their apply twins (verified: `LifecycleEndpoints.cs:7-19` vs `:21-34`); `CreateInstallPlanAsync` fetches arbitrary http(s)/file `manifestPath` (`RuntimeAppManifest.cs:390-431`). *Nuance:* practical cross-site exploitability is limited — ASP.NET's JSON binding rejects non-`application/json` bodies, and cross-site JSON POSTs trigger a CORS preflight that Core won't approve. Still worth fixing as defense-in-depth (a future content-type-tolerant endpoint or permissive CORS change would silently arm it). **Fix:** `requireCsrf: true` on every session-authenticated POST (Shell sends the header via `sendCsrfJson` — its plan calls must be updated in the same change, since today Shell deliberately omits the header for plan routes); optionally deny loopback/link-local manifest URL targets.

**C-M10. `finally`-block restarts mask the original failure.** `CreateManualBackupAsync` (`CoreLifecycleService.cs:905-917`) and `ConfigureDevelopmentModeAsync` (`:345-354`) `await StartAsync` in `finally` — a restart exception replaces the operative one; on success it discards a completed backup response. **Fix:** catch/log restart failure inside the `finally`.

**C-M11. Git child processes never disposed.** `AppSourceService.cs:383-408`; folds into the shared `ProcessRunner` (C-H2).

**C-M12. `/api/core/status` unauthenticated, leaks host paths through ingress.** `HostyCoreApplication.cs:106`; with cloudflared, Core is published at `core.<domain>` (`CloudflareIngress.cs:184`) making `DataRoot`/manifest paths/warnings world-readable. **Fix:** session-gate the detailed payload; keep only status/version public.

**C-M13. 0777 directories under system-app data.** `EnsureSystemAppDataSubdirectory` (`CoreLifecycleService.cs:2691-2711`) — collector sinks and the telemetry SQLite dir are world-writable; any local user can tamper telemetry or corrupt the DB. **Fix:** chown to container UID (10001) or group-scoped modes.

### Low

- **C-L1.** Control-secret comparison not constant-time (`HostyCoreApplication.cs:246-258`); the trusted-proxy path already uses `FixedTimeEquals`.
- **C-L2.** One torn NDJSON line permanently breaks `/control/v1/audit/recent` (`AuditStore.cs:26-33`); file unbounded, fully read per query. Per-line try/catch + rotation.
- **C-L3.** CSRF cookie issued `Secure = false` unconditionally (`AuthEndpoints.cs:16-21`); mirror the session cookie's `IsHttps` logic.
- **C-L4.** localCommand service logs never rotated; `GetLogsAsync` streams the whole file for a tail (`LocalCommandRuntimeAdapter.cs:72-77, 293`).
- **C-L5.** Missing-app error inconsistency: `UpdateAppAsync` paths → 400 `lifecycle_operation_failed`, `RequireAppAsync` paths → 404 `app_not_found`.
- **C-L6.** `RemoveAsync` leaves `logs/`, `run/`, `runtimes/` behind (`CoreLifecycleService.cs:839-860`).
- **C-L7.** App service tokens signed with the per-process `ControlSecret` — workloads surviving a Core restart hold tokens the new Core rejects (confusing transient 401s). Persist the signing key (the `AppIdentityService` key file is the pattern).
- **C-L8.** `PrebuiltArtifactStore.Resolve` hashes synchronously on the start path and follows directory symlinks (`PrebuiltArtifactStore.cs:28-68`).

### Architecture observations

- `CoreLifecycleService` (3,958 lines) mixes orchestration, the ~700-line plan/diff engine, telemetry proxying, mount validation, and path heuristics. The plan/diff engine and telemetry read-proxy are natural extraction seams (mostly static/pure already).
- ~40 hand-duplicated `/api` vs `/control/v1` registrations (§2.2 fix 1).
- Persistence idioms inconsistent across stores (§2.3).
- Internal records serialized wholesale to clients: C-H1 is one instance; `AppSummary` also exposes absolute host paths and `LastError` internals to non-admin users. Purpose-built response DTOs per audience make leaks reviewable.
- State reconciliation one-directional (C-M1/H5).

---

## 4. CLI (`apps/cli`) — 4 High, 8 Medium, 8 Low

### High

**L-H1. `hosty uninstall` destroys all data without confirmation.** `UninstallCommand.cs:15-31` — no `--yes`, no prompt; app data, backups, sources, config deleted irreversibly, while `apps remove` and `backups prune` both require `--yes` and the help text says "(optionally delete data)". **Fix:** require `--yes` + a `--delete-data` flag; align help text. *Independently re-verified.*

**L-H2. Uninstall misses external `HOSTY_DATA_ROOT` and races Core shutdown.** Always passes `RootDirectory` as data root (`:17`), so a configured external data root is silently left behind while claiming success; waits a fixed 750 ms after `core/stop` vs Core's 15 s shutdown budget, then deletes files a dying Core may still hold/recreate (Windows: locked-exe exception mid-deletion). **Fix:** resolve the real data root via `SettingsStore`; reuse the existing PID-wait pattern (`UpdateCommand.TryStopWindowsCoreBeforeExecutableUpdateAsync`, `UpdateCommand.cs:88-98`).

**L-H3. Channels are decorative: `--channel stable` installs the rolling `cli-dev` build.** `ReleaseArtifactService.cs:9` hard-pins the download URL to the `cli-dev` tag; `ProductChannel.CliVersion`/`CoreArtifactPrefix` have zero consumers outside the `--list-channels` table (`UpdateCommand.cs:129-139, 286-291`); currency is SHA-equality only — silent downgrades possible. Already caused production confusion. **Fix:** wire channel fields into URL construction (or remove them); print old→new versions; warn on downgrade.

**L-H4. Malformed Core responses crash with a raw stack trace.** `CommandLine.RunAsync`'s catch chain (`CommandLine.cs:56-96`) misses `JsonException` (escapes from `CoreControlClient.cs:135-136`); source-gen contexts don't set `RespectNullableAnnotations`, so missing properties null-collapse into non-nullable slots — `discovery.RequiredHeaders` dereferenced unguarded (`CoreControlClient.cs:84`, `CoreCommand.cs:575`), `app.Version` NREs in `RenderApps` (`AppsCommand.cs:477`). A half-up Core or older-schema `control.json` produces an exception dump instead of a message. **Fix:** catch `JsonException` → exit 1 "Core returned an invalid response"; enable `RespectNullableAnnotations` on `CliJson.Options`; null-guard `RequiredHeaders`.

### Medium

- **L-M1.** Artifact downloads die at the default 100 s `HttpClient.Timeout` (`SelfUpdateService.cs:25`, `CoreInstallationService.cs:40`) — `ResponseHeadersRead` does not exempt body reads. Use `Timeout.InfiniteTimeSpan` + explicit cancellation (as `CoreControlClient` already does).
- **L-M2.** "Core is not running" → exit 2 + full usage dump in `apps`/`storage`/`users` (`AppsCommand.cs:451-462` et al.) but exit 1 + clean message in `auth`/`open`/`core status`. Scripts misclassify a down Core as bad invocation. Standardize on the exit-1 pattern.
- **L-M3.** Windows `hosty update` stops Core, never restarts it, then prints "update step skipped because Core is not running" — factually wrong at that point (`UpdateCommand.cs:49, 59, 146`). Reword + restart-or-instruct explicitly.
- **L-M4.** Duplicate discovery/client stack in `CoreCommand` (`CoreCommand.cs:568-619, 735-739`) already diverging from `CoreControlClient` (3 s vs 10 s timeout, missing null guard). Consolidate (§2.2).
- **L-M5.** Several non-zero-exit failure messages go to stdout (`AppsCommand.cs:259-262, 308-311`; `CoreCommand.cs:87-89, 441-443`), breaking pipes. Route through `context.Error`.
- **L-M6.** Null/empty Core responses: exit 1 with no message at all (`AppsCommand.cs:418-437`) or a notice with exit **0** (`:139-140, 504-510`). Pick one convention: message + exit 1.
- **L-M7.** CLI-side stale `control.json` deletion is not ownership-guarded (`CoreControlClient.cs:74-78`) — read-then-delete can remove a *new* Core's discovery file during restart races; the deserialized `Nonce` has zero readers. Compare-and-delete on PID/nonce, mirroring Core's guard.
- **L-M8.** `NormalizeManifestReference` ×2 with different `file:` semantics (`AppsCommand.cs:1492-1503` vs `UpdateCommand.cs:222-233`; `LaunchSettings.ResolveManifestReference` is a third variant). One shared helper.

### Low

- **L-L1.** `SelectChannelAsync` NREs on an index without `channels` (`UpdateCommand.cs:132`); `ListChannelsAsync` guards the same field.
- **L-L2.** Ctrl+C during start/update reports failure (exit 1) instead of cancellation (130) — `OperationCanceledException` folded into generic catches (`CoreCommand.cs:66`, `UpdateCommand.cs:39,52`).
- **L-L3.** Background start truncates `core.log` on every start (`CoreCommand.cs:146,176`) — crash-loop history lost. Append or rotate.
- **L-L4.** `apps install` positional catch-all swallows misspelled flags (`AppsCommand.cs:857-867`); `StorageCommand.ParseAddOptions` already rejects `-`-prefixed positionals.
- **L-L5.** `users list --format` validated only after the network round-trip (`UsersCommand.cs:49-64`).
- **L-L6.** `core stop` on already-stopped Core exits 1, breaking `hosty core stop && …` scripts; `restart` treats NotRunning as fine.
- **L-L7.** `config set` rewrites launch.env from the definitions list — unknown keys/comments silently destroyed; no 0600 permissions on a file that will eventually carry secrets (`LaunchSettingsStore.cs:15-21, 59-69`).
- **L-L8.** Foreground `Process` never disposed (`CoreCommand.cs:74-77`); fresh `HttpClient` per 500 ms status poll (`:525-540`).

### Architecture observations

Two Core-client stacks (L-M4); copy-heavy hand-rolled parsing (`RequireOptionValue` ×5, `OpenCoreAsync` ×3) — a small `CommandBase` would remove most drift vectors; the per-command source-gen JSON contexts are a clean AOT pattern but nothing enforces DTO contract fidelity with Core (contract tests would); an implicit exit-code policy (0/1/2/130) exists but is unwritten and unevenly applied — document it and add a helper.

---

## 5. Shell (`apps/shell`) — 2 High, 8 Medium, 12 Low

### High

**S-H1. Metrics page has no stale-response guard.** `metrics-page.tsx:102-133,146-148` — plain fetch, unconditional state write, no token/AbortController; switching 1h→5m can leave 1h data displayed under a "5m" label. The traces (`traces-page.tsx:81-119`) and structured-logs pages implement exactly the missing token pattern. **Fix:** per-app token ref or AbortController; best via the shared helper (§2.2).

**S-H2. Observability section gated on stale `runtimeState` of a hardcoded app id.** `shell-client.tsx:1016-1019` + `shell-route-pages.tsx:26-40`: `apps.some(id === "hosty.telemetry" && runtimeState === "running")`. Core's known stale-state issue (C-M1) makes the whole section vanish with a silent redirect to `/dashboard`; the string literal has already survived one app rename. **Fix:** inline "telemetry backend is not running" empty state instead of redirect (redirect only for non-admins); lift the id into a constant, ideally sourced from Core.

### Medium

- **S-M1.** `markAllRead` swallows all failures; the catch comment claims `sendCsrfJson` surfaces errors — it throws (`notification-bell.tsx:107-125`). Add `toast.error`.
- **S-M2.** Traces/logs pages set `response: null` on fetch error — one transient 502 mid-typing (debounced search) wipes the displayed table (`traces-page.tsx:111-115`, `structured-logs-page.tsx:97-101`). Keep previous data on error (metrics page already does).
- **S-M3.** Copy says "(live, last hour)" but nothing polls — metrics/logs/traces are static snapshots until manual refresh; app list refreshes only on mount/mutation (hence lingering stale badges). Add visibility-gated polling or drop "live" until Phase-2d SSE.
- **S-M4.** Fetch/redirect/error boilerplate copy-pasted ~15× (`shell-client.tsx` ×7, `installed-apps-page.tsx`, all observability pages, `user-management-page.tsx`, `app-details-dialog.tsx`); `catalog-api.ts` demonstrates the right shape. Consolidate (§2.2).
- **S-M5.** Trace waterfall renders every span unmemoized; toggling one span re-renders the whole table, O(spans×depth) DOM (`traces-page.tsx:439-524`). Memoized `WaterfallRow` + cap/virtualize above a few hundred rows.
- **S-M6.** `OtlpLogTable` keys on `content|originalIndex` with a comment asserting append-only stability — false for a rolling 500-record window; refreshes shift keys and collapse the expanded row (`otlp-log-table.tsx:30-57`).
- **S-M7.** Catalog `app.icon`/`screenshots` go into `img src` unvalidated (publisher URL *is* sanitized) — hostile catalog can inject `data:` payloads/tracking pixels; no `img-src` CSP (`marketplace-page.tsx:163-165`, `catalog-app-details-dialog.tsx:110-114`). Apply the same http(s) allowlist.
- **S-M8.** No AbortController on observability/installed-apps fetches — "All resources" fans out N requests that keep running after navigation. Fold `signal` into the shared helper.

### Low

- **S-L1.** Workspace-launch pending panel renders nothing while in flight (`embedded-workspace-pending-panel.tsx:3-13`).
- **S-L2.** Marketplace unmount cleanup aborts the mount-time controller, not `abortRef.current` after a refresh (`marketplace-page.tsx:42-60`).
- **S-L3.** Shared-mounts fetch failure → silent "No shared mounts" (`shell-client.tsx:174-178`).
- **S-L4.** `loadInstallPlan` has no request token; a stale plan's `planDigest` fails safe on Core but yields a confusing "plan digest mismatch" (`shell-client.tsx:940-974`).
- **S-L5.** Every `loadUsers()` resets invite-form TTL state mid-dialog (`user-management-page.tsx:80-83`).
- **S-L6.** Cross-app clock skew renders `+-500µs` span offsets (`traces-page.tsx:642,796-804`).
- **S-L7.** `formatBytes` caps at MB — "8192.0 MB" on memory cards (`app-helpers.ts:407-415`).
- **S-L8.** Unbounded client maps: `metricsByApp` never prunes removed apps; `knownIds` in the notification bell grows forever; metric-selection localStorage accumulates uninstalled apps' instruments.
- **S-L9.** localStorage keys unversioned (`shell-routes.ts:3-8`) — cheap to namespace `v1` now.
- **S-L10.** `iframe sandbox="allow-scripts allow-same-origin"` is decorative for same-origin content — protection currently comes only from apps living on other origins; document the invariant (`embedded-workspace-panel.tsx:67`).
- **S-L11.** `server-env.ts:14` defaults to `http://localhost:3001` — browser-dialed so Happy Eyeballs applies, but the platform principle after the IPv6 incident is literal `127.0.0.1`.
- **S-L12.** Expanded-row health/digest panel goes stale after lifecycle actions until collapse/re-expand (`installed-apps-page.tsx:702-705`).

### Architecture observations

Clean route→context→page layering, but three god-files (`shell-client.tsx` 1,386 / `installed-apps-page.tsx` 1,134 / `app-details-dialog.tsx` 1,017 — five dialogs in one file); extract `useAppLifecycleActions`/`useBackups` hooks and split the dialog. `ShellStateContext` bundles `busyAction` with the whole load state — every busy-flag flicker re-renders all consumers, and each `refresh()` rebuilds `state.apps` identity, cascading through memos (and re-triggering metrics fan-out). DTO layer: `types.ts` (674 lines) is a faithful hand-mirror of Core records with zero `any`, but all responses are blind `as T` casts — drift surfaces as silent `undefined`. Security posture otherwise good: no `dangerouslySetInnerHTML`, sanitized notification/publisher links, `frame-ancestors 'none'`, CSRF double-submit with an ordering queue.

---

## 6. telemetry-backend (`apps/telemetry-backend`) — 2 High, 2 Medium, 2 Low

**T-H1. Unauthenticated query + ingest data plane; the "internal network" premise in the code is false.** `Program.cs:3-7` claims the query API "is reached only by Core's read proxy over the internal network"; in fact the query port is container-published to host loopback (that's how Core reaches it — `apps/telemetry/manifest.json:58-64`, same path the IPv6 incident confirmed), and the collector's `otlp-http` port is `"expose": "host"` (`manifest.json:26-32`). Any local process can read the fleet's telemetry and inject spoofed data attributed to any `hosty.app.id`. This is the known-open "2nd data-plane auth" item — but the comment will mislead contributors into assuming a boundary that doesn't exist. **Fix now:** correct the comment. **Fix soon:** Core-minted shared-secret bearer token (Core already injects the backend's env) for query and ingest.

**T-H2. 1 Hz metrics scrape defeats the store's own retention design.** `IngestInterval = 1s` (`TelemetryBackendOptions.cs:30`, *re-verified*) with `ScrapeMetricsAsync` on every tick (`TelemetryIngestService.cs:66-91`) inserts one row per series per second regardless of change (the Prometheus exporter re-serves last values). ~50 series/app ≈ 4.3 M rows/day; the 1 GiB ceiling holds ~5–10 M rows, so with 2–3 apps effective metrics retention collapses from the intended 14 days to hours–days of prune churn. No env override for the cadence exists. **Fix:** split cadences (tail logs/traces at 1 s; scrape metrics at 10–15 s), skip unchanged samples, add `HOSTY_TELEMETRY_INGEST_INTERVAL_*` overrides.

- **T-M1.** Scrape-time stamping (`PrometheusTextParser` drops exposition timestamps; everything stamped `nowMs`) makes a stopped app's series look live for the exporter-expiry window (~5 min) — flat "live" lines for dead apps.
- **T-M2.** `FileTailReader` rotation handling loses the tail of the rotated-out file (never opens the backup the collector keeps), and the >4 MB backlog skip discards data silently — both trigger under log bursts, exactly when logs matter (`FileTailReader.cs:29-42`).
- **T-L1.** At-least-once ingest can duplicate rows (offset saved in a separate transaction after commit); a `(trace_id, span_id)` unique constraint would be cheap.
- **T-L2.** `QueryPort` validated only as `> 0`; 99999 passes and Kestrel throws obscurely.

*Positives:* fully parameterized SQL including the dynamic `IN` filter; WAL + freelist-aware sizing + `incremental_vacuum` is a correct disk-bounded retention design; range/limit clamps mirror Core; the unprivileged constraint holds (no docker.sock anywhere).

---

## 7. CI/CD and release pipeline (`.github/workflows`) — 1 High, 4 Medium, 1 Low

**I-H1. Publishing is not gated on CI.** `cli-release.yml` and all three image workflows trigger on push to `main` in parallel with `ci.yml`. A commit with failing tests still force-retags `cli-dev` (the default install/update target) and pushes `:latest` images referenced by manifests. **Fix:** `workflow_run`-gate the publish workflows on CI success, or run the test jobs inside them before push/upload.

- **I-M1.** `cli-dev` publish race: only the publish job is serialized with `cancel-in-progress: false` — a slow older build can retag `cli-dev` back over a newer one; `--clobber` asset replacement is non-atomic, so a mid-window installer sees new binary + old `SHA256SUMS` → spurious checksum failures. Guard with a "is my SHA still ahead?" check; upload `SHA256SUMS` last.
- **I-M2.** No provenance/signature: `SHA256SUMS` is same-origin with the binaries — integrity only, not authenticity. Add `actions/attest-build-provenance` (or sigstore) with `id-token: write, attestations: write` scoped to the publish job.
- **I-M3.** Inconsistent pinning: docker actions SHA-pinned, all `actions/*` tag-pinned, in workflows holding `contents: write`/`packages: write`. Pin by SHA; add `.github/dependabot.yml` (currently absent).
- **I-M4.** `cache-to: mode=min` exports only thin final-stage layers — the expensive restore/publish and `npm ci`/build stages rebuild from scratch every run under QEMU arm64. Use `mode=max`.
- **I-L1.** `ci.yml` path filters omit `apps/telemetry/manifest.json`, `channels/**`, `skills/**`; nothing validates manifest/channel JSON at all.

---

## 8. Install scripts (`scripts/`) — 3 Low

- **N-L1.** `irm … | iex` (advertised in `install.ps1:27-28` and README) defeats `#requires`, disables `param()`, and `Fail`'s `exit 1` kills the user's interactive session on any error. Recommend `& ([scriptblock]::Create((irm …)))` in docs; `throw` instead of `exit` when not run as a file.
- **N-L2.** Skill installer fetches mutable `main` with no integrity option surfaced; document `--ref <sha>`.
- **N-L3.** `README.md:9` says checksums are verified "when available" — stale; both installers now hard-fail without them. Update (it understates the actual guarantee).

*Positives:* mandatory checksum verification with three hash-tool fallbacks, `set -eu` + trap cleanup, temp-then-rename, idempotent PATH block, genuine Windows parity including the in-use-binary backup/restore dance.

---

## 9. demo-app — 2 Medium, 2 Low

- **D-M1. Dev profile broken on Windows.** `run-next.mjs:5,12` spawns `next.cmd` without `shell: true`; since Node's CVE-2024-27980 hardening this throws `EINVAL` — and this is the template app authors copy. Fix: `spawn(nextBin, args, { shell: process.platform === "win32", … })` or spawn `process.execPath` with next's bin script.
- **D-M2. Baked version stale by two minors.** Dockerfile `HOSTY_APP_VERSION=0.2.1` and `demo-config.ts:46` vs manifest/package 0.4.2 — `/api/health` contradicts the installed manifest, the exact "stale version" confusion the platform already fought. Derive at build time.
- **D-L1.** Anonymous `/api/config`+`/api/health` list directory entries of operator-configured external mounts — as a template this normalizes leaking host-folder listings on public endpoints. Gate `storage.entries` behind an authenticated role.
- **D-L2.** Role store read-modify-write race (atomic rename prevents corruption, not lost updates); a one-line mutex would make the template pattern sound.

*Positives:* role-mutating routes re-validate identity server-side against Core; service token never echoed; sensible auth-code cookie flags.

---

## 10. Manifests / channels / skills / hygiene — 2 Medium, 2 Low

- **R-M1.** `hosty.telemetry` backend service pinned to `ghcr.io/...:latest` (sibling collector is version-pinned at 0.155.0); under the `pinned` policy a fresh install freezes whatever `main` last pushed (see I-H1), the manifest lacks the `update` capability, so there's no operator path to advance the pin. Tag images per release (`:0.x.y` matching manifest version) and reference that.
- **R-M2.** `skills/hosty-app-skill/references/app-manifest.md:138` still claims OTLP-log viewing "is planned for P4" — P4–P6 and Phase 2 shipped months ago; app authors following the skill will under-instrument. Sweep skill references against current observability docs.
- **R-L1.** `channels/product-channels.json` `cliVersion: 0.3.0` vs platform 0.32.0, user-visible via `hosty update --list-channels`. Wire into release checklist or derive from the tag.
- **R-L2.** Version-constant drift class (§2.4): demo-app ×2, channels ×1, `eslint-config-next` 16.0.7 vs `next` 16.2.6. One CI consistency check closes the class.

*Positives:* no tracked build artifacts; zero lingering `hosty.observability.collector` references; `Directory.Build.props` respected as the single platform version source; Shell/demo-app manifest↔package versions in step.

---

## 11. Test coverage assessment

**Core** (strong overall: 590+ tests, injectable docker fake): gaps at `AppSourceService` (2 tests; pin/override/cleanup/retry untested), `AuthEndpoints` (1 test; session lifecycle, trusted proxy, CSRF check uncovered), `AppBackupService` cleanup planner + `RestoreBackupAsync` staged swap/rollback (the data-safety core), `TelemetryBackendClient`, and **zero concurrency tests** (would have caught C-H3/H4). The highest-leverage new test: an **endpoint-authorization matrix** asserting every `/api` route's session/CSRF requirements — it would have caught both C-H1's payload and C-M9's asymmetry mechanically.

**CLI**: good route coverage for source/backup/mounts, but the entire update pipeline (`SelfUpdateService`, `CoreInstallationService`, channel selection), the Unix `StartBackground` shell-command assembly (highest-risk string building in the codebase), and the `CommandLine` exception→exit-code mapping are untested. The uninstall tests exercise the external-data-root branch that production never reaches — a test through `ExecuteAsync` would have caught L-H2.

**Shell**: zero tests, no runner configured. First targets are the pure modules — `buildWaterfallRows`, `shell-routes` parsing, `metricGroup`/`metricSeriesKey`, `safeHttpUrl`, `formatUpdateChange` — all testable without DOM. Add `noUncheckedIndexedAccess` to tsconfig while at it.

**telemetry-backend**: tests exist; add coverage for `FileTailReader` rotation (T-M2) and a retention-vs-cadence property check (T-H2).

---

## 12. Prioritized action plan

**P0 — security/data-safety, small diffs (do first):** — ✅ **all done (2026-07-06)**
| # | Item | Effort | Status |
|---|------|--------|--------|
| 1 | C-H1 strip session ids from `UsersResponse` (both twins) | XS | ✅ `AuthSessionSummary` (SHA-256 fingerprint id) |
| 2 | L-H1/L-H2 uninstall: `--yes`, real data root, PID-wait | S | ✅ `--yes` + opt-in `--delete-data`, settings-resolved data root, `ProcessLiveness.WaitForExitAsync` |
| 3 | T-H1 fix the false "internal network" comment; plan token auth | XS now / M later | ✅ comment corrected (token auth still deferred to §2d) |
| 4 | C-M12 session-gate `/api/core/status` detail | XS | ✅ admin-gated; anonymous gets liveness/version only |
| 5 | C-M3 logger in `TelemetryBackendClient` (known issue) | XS | ✅ `ILogger` injected, logs on reachability transitions |
| 6 | C-M6 temp+rename for manifest copy + cloudflared config | XS | ✅ `JsonStorage.WriteTextAsync` (atomic) for both |

**P1 — reliability of the core loop:** — ✅ **all done (2026-07-06)**
| # | Item | Effort | Status |
|---|------|--------|--------|
| 7 | C-H2/C-M11 shared `ProcessRunner` (concurrent drain, deadline, kill-on-cancel) for docker+git | M | ✅ `ProcessRunner.cs` + tests |
| 8 | C-H3 `UserDirectoryStore.UpdateAsync` + caller migration | S | ✅ `SemaphoreSlim`-guarded `UpdateAsync`, all callers migrated, concurrency test |
| 9 | C-H4 per-app lifecycle locks | M | ✅ `WithAppLockAsync` + `*CoreAsync` split (reentrancy-safe), serialization test |
| 10 | C-H5 + C-M1 + C-M2 docker unwind, post-stop inspect, label-checked `rm -f`, periodic label sweep | M | ✅ all four, `IRunningContainerProbe` sweep in supervisor, 5 tests |
| 11 | I-H1 gate publishing on CI | S | ✅ each publish workflow's job `needs` a `test` gate |
| 12 | T-H2 split ingest cadences + unchanged-sample skip | S | ✅ `MetricsScrapeInterval`/`MetricsHeartbeat` + `MetricDeduplicator` + env overrides |

**P2 — correctness/UX:** — ✅ **all done (2026-07-06)**
L-H3 (channels wiring or removal), L-H4 (+`RespectNullableAnnotations`), L-M1 (download timeout), C-M5 (env-file for secrets), C-M9 (CSRF on plan routes, coordinated with Shell), S-H1/S-H2, S-M1/S-M2, D-M1 (Windows spawn), R-M1 (versioned backend image), exit-code/stream conventions in CLI (L-M2/M5/M6).

**P3 — structural (pays down the drift class):** — ⚑ **partially done (2026-07-06):** version-consistency CI check ✅, endpoint-authorization matrix test ✅, provenance attestation ✅, CLI client-stack consolidation (L-M4) ✅, dependabot ✅. Deferred to separate PRs: dual-prefix `MapDual` mapper, Shell `coreFetchJson` helper, `JsonStateStore<T>` unification, `CoreLifecycleService` plan/diff extraction, Shell god-file splits.
Dual-prefix endpoint mapper; Shell `coreFetchJson` helper + lint ban on raw fetch; CLI client-stack consolidation + `CommandBase`; `JsonStateStore<T>` unification; `CoreLifecycleService` plan/diff + telemetry-proxy extraction; Shell god-file splits; endpoint-authorization matrix test; version-consistency CI check; provenance attestation.

---

*Notes: findings marked "independently re-verified" were re-read line-by-line in the main review session on top of the area reviewers' verification. Known-issue overlaps: C-M1 = the open "stopped but running" badge issue; C-M3 = the known TelemetryBackendClient silent-swallow; T-H1 = the open "2nd data-plane auth" design item — the review confirms all three are real and still open.*

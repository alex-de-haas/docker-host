# Consolidated Review

Date: 2026-09-06
Baseline commit: `8a7abbc87b0673b58c62ff0d89bd1fd3e1798219`
Baseline working tree: clean apart from the uncommitted 2026-09-05 review this document absorbs.
Review artifact only: no application changes, commits, or version changes.

## Purpose

This document replaces every earlier review in `docs/reviews/`. Each finding of the superseded reviews was re-verified against the baseline commit above; what is still open or only partly addressed is restated here under one severity scale and one numbering. Findings that are fixed are not restated: the fix commits, pull requests, and the feature documents are the record of what is true now, and the superseded reviews remain readable in git history (`git log --all -- docs/reviews/`).

Under the repository's documentation policy a review never carries status. A finding below becomes tracked work only when it is triaged into the relevant feature's `plan.md`; this document is the input to that triage, not a substitute for it.

## Superseded reviews

| Review | Baseline | Items | Fixed | Partial | Open | Obsolete / refuted |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| `2026-07-05-code-review.md` (full repository) | `26cda25` | 108 | 51 | 18 | 39 | 0 |
| `2026-07-10-core-code-review.md` (Core security) | `5fb8dda8` | 33 | 13 | 11 | 9 | 0 |
| `2026-08-18-full-review.md` (full repository) | post-#376 | 42 | 3 | 2 | 37 | 1 |
| `2026-08-25-core-performance-review.md` (Core performance) | pre-#406 | 27 | 7 | 7 | 13 | 1 |
| `2026-09-05-code-documentation-simplification-review.md` (never committed; absorbed in full) | `8a7abbc8` | 15 | 0 | 0 | 15 | 0 |

The remediation pattern across all five is the same: the High findings whose IDs appear in commit subjects were fixed (`a7f6a7ea` for 2026-07-05; #235–#277 for 2026-07-10; #406–#408 for 2026-08-25), and the Medium/Low tail, the concurrency cluster, and the structural items were never worked. The three items closed from the 2026-08-18 review were side effects of the read-path caching PR and the assistant-panel move, not targeted fixes.

The concern that reviews this old no longer describe the code applied to very few items. Code moved (telemetry pages into `apps/telemetry-ui`, the assistant panel into `apps/ai-gateway/web`, the marketplace into `apps/marketplace`) but unfixed defects moved with it and are cited below at their new locations. Only three items became moot through deletion; they are listed under "Obsolete and refuted".

## Method and evidence

Every finding of the five reviews was checked against the baseline by reading the current code, not the review text. A renamed or moved file is not a fix; where the reviewed logic moved, the new location was found and judged. Fix commits were located with `git log -S` and `git log --grep`. Four independent read-only passes (one per superseded review) produced the verdicts; a sample of the strongest claims (login throttling, localCommand `setup`, the 0777 directories, the empty catch blocks, the CLI credential purge, the CNAME rollback) was re-read by hand.

Evidence labels:

- **Reproduced:** a deterministic local probe exercised the implementation with a controlled asynchronous store (carried from the 2026-09-05 review at this same baseline; the probe outline is recorded at the end of this document).
- **Verified:** the cited code establishes the behavior or a concrete interleaving at the baseline; no live reproduction is claimed.
- **Recommendation:** a maintainability improvement, not an assertion that current behavior is wrong.

Line anchors are at the baseline commit and drift with every change; locate findings by symbol when the anchor no longer matches.

## Severity model

- **High** — a trust-boundary defect, a data-loss or state-corruption path, or a correctness bug on an ordinary path.
- **Medium** — a bounded correctness, reliability, or contract defect; or a performance cost that scales with fleet size or request rate.
- **Low** — hardening, efficiency, duplication, or documentation.
- **Structural** — responsibility coupling that raises the cost of every change in its area; no single failing behavior.

Origin labels map as: Critical/High → High, Medium → Medium, Low → Low, P1 → High, P2 → Medium, P3 → Low. Where the re-verification judged the impact narrower than the origin label, the note says so; the origin label is kept.

**Status:** *Open* means nothing has been done; *Partial* means a named part landed and the rest did not. The "Origin" column keeps the original IDs from the superseded reviews so existing plans, memory notes, and pull requests stay traceable.

## Executive summary

132 distinct items remain after merging duplicates: 15 High, 49 Medium, 58 Low, 10 Structural. The clusters with the highest value per unit of work:

1. **AI Gateway approval boundary and session ownership** (GW-1..GW-5). `Task` is auto-approved, operator permission rules are loaded into sessions, and session events can persist and publish out of order. Two of these are reproduced.
2. **Core login denial of service** (SEC-1). Parallel logins are admitted before the first failure lands; PBKDF2 runs unbounded.
3. **localCommand `setup` and process ownership** (LC-2..LC-5). A hung setup hangs the start forever; a cancelled one leaks its tree; the startup-crash log tail is lost; Windows reclaim has no durable identity.
4. **Health observation versus lifecycle verbs** (LC-1). Found in July, re-found in September, never fixed; the drift sweep already shows the cheap fix.
5. **App identity token without an audience** (SEC-2). A verifier-local convention stands in for a claim; the delegated-token path already has the real thing.
6. **CLI connector reliability** (CLI-1..CLI-3). The credential purge can strand a valid token; one Core restart ends the fleet poll for the session.

The structural items (STR-1, SH-14, CLI-14, GW-8) have all regressed since they were first reported: `CoreLifecycleService.cs` went from 3,958 to 6,344 lines and `shell-client.tsx` from 1,386 to 2,401.

## Findings

### Core: security and trust boundary

| ID | Origin | Severity | Status | Finding and what remains | Evidence |
| --- | --- | --- | --- | --- | --- |
| SEC-1 | 07-10 C-H5 | High | Open | Parallel login requests pass `IsThrottled` before the first `RegisterFailure` lands; each runs the 600k-iteration PBKDF2. No rate limiter, no admission reservation, no KDF semaphore, no request body cap, no `KnownProxies`/`KnownNetworks`. | `LocalPasswordAuthService.cs:65,93,174-200`; `HostyCoreApplication.cs:183-189` |
| SEC-2 | 08-18 H3 | High | Open | The `hosty_app_identity` payload is `(App, Iat)` with no audience; "is this token mine" is a verifier-local convention. PR #442 added `aud` validation for delegated tokens only. | `AppIdentityTokenService.cs:92`; `TelemetryCallerAuth.cs:119`; `HostyDelegatedToken.cs:109` |
| SEC-3 | 07-10 C-H1 | High | Partial | The install plan now carries `ArtifactDigests` and `System`. Capabilities, devices, host network, ports, mounts, and command/setup are still absent from the install review, and the Shell dialog never displays the digests it receives. The update plan surfaces these change kinds; install does not. | `CoreLifecycleService.cs:6212-6238`; `install-review-dialog.tsx:230-246` |
| SEC-4 | 07-10 C-M7 | Medium | Partial | The service token survives restarts (durable key) but is still HMAC(appId) with no expiry, scope, or install generation; a leaked token survives remove and reinstall. | `AppServiceTokenService.cs:15-24`; `AppServiceSigningKey.cs:22-45` |
| SEC-5 | 07-10 C-M9; 07-05 Arch-Core-4 | Medium | Open | One `AppSummary` for every role: `LastError` (raw `ex.Message`, including a 15-line setup output tail), `ManagedCheckoutPath`, source paths, and mount `HostPath` reach any user who passes `CanAccessApp`. | `DomainEndpoints.cs:367-380`; `AppRegistryStore.cs:1071,1089,1177`; `CoreLifecycleService.cs:3583`; `LocalCommandRuntimeAdapter.cs:298-302` |
| SEC-6 | 07-10 C-M12 | Medium | Open | Manifest settings are not a strict schema: a duplicate key is an unhandled `ArgumentException` from `ToDictionary`; an undeclared incoming key is accepted and stored as non-secret; no env-name syntax check or reserved `HOSTY_*` namespace. | `CoreLifecycleService.cs:3234-3241,5638-5676` |
| SEC-7 | 07-10 C-M13; 07-05 Core-M13 | Medium | Open | System-app telemetry data subdirectories are chmod 0777. The comment now defends it (the distroless collector runs as UID 10001 through the bind mount); no narrower group or ownership model was adopted. | `CoreLifecycleService.cs:4664-4671` |
| SEC-8 | 07-10 C-M14 | Medium | Partial | Sessions and grants are pruned; bootstrap and recovery tokens are appended forever with no prune. Lookup is a linear scan, now off an in-memory cache. | `AuthBootstrapService.cs:238-248`; `CoreSessionAuthorization.cs:200` |
| SEC-9 | 07-10 C-M8; 08-25 L8 | Medium | Partial | Audit is gated, rotated at 8 MiB, and read backwards. It is still awaited after the privileged mutation, so a failed audit write follows a committed change; the file is reopened per append and awaited inline on the introspection path. | `AuthBootstrapService.cs:216-221`; `AuditStore.cs:53`; `TokenIntrospectionEndpoints.cs:97` |
| SEC-10 | 07-05 Core-L2 | Low | Partial | A torn audit line throws `JsonException` out of the read; rotation landed, the per-line guard did not. | `AuditStore.cs:162,232` |

### Core: lifecycle concurrency and recovery

| ID | Origin | Severity | Status | Finding and what remains | Evidence |
| --- | --- | --- | --- | --- | --- |
| LC-1 | 07-10 C-M3; 09-05 F3 | High | Open | `ObserveRuntimeHealthForAppAsync` probes a stale record snapshot and commits `RuntimeState` through `UpdateAppAsync`, which locks only the record write. A probe that observes the old runtime between a restart's stop and start commits `stopped` over the newer `running`. Only the docker drift sweep and the boot sweep take the per-app operation lock. No fix commit ever existed. Re-verification note: the window is narrow, but the localCommand variant sticks because the observer skips non-up unsupervised apps until the next verb. | `CoreLifecycleService.cs:5870-5913` vs `:5853-5866`, `:1742-1745` |
| LC-2 | 08-18 H4 | High | Open | localCommand `setup` awaits `WaitForExitAsync(cancellationToken)` with both pipes redirected and no deadline of its own; `LogDrainTimeout` is stop-only. A hung setup hangs the start until the caller cancels. | `LocalCommandRuntimeAdapter.cs:29,260` |
| LC-3 | 08-18 H5 | High | Open | A cancelled or failed `setup` leaks its tree: the POSIX process-group flag is discarded, cancel falls back to `Kill(entireProcessTree)` when there is no Windows job, a non-zero exit kills nothing, and no setup pidfile is written. | `LocalCommandRuntimeAdapter.cs:209,276,289-302` |
| LC-4 | 08-18 M1; 07-05 Core-M7 | Medium | Open | The `Exited` handler disposes the log writer before the output readers reach EOF (the startup-crash tail is dropped) and reads `process.ExitCode` unguarded while `Dispose` runs on another path. | `LocalCommandRuntimeAdapter.cs:141-145,886,963` |
| LC-5 | 08-18 M13; 07-10 C-H9 | Medium | Open | The pidfile models only `bool ProcessGroup`; Windows records `false`, the job name is never persisted, and reclaim always takes the `Kill(entireProcessTree)` path. Windows localCommand trees cannot outlive Core. | `LocalCommandProcessReclaim.cs:10-15,118-131`; `LocalCommandRuntimeAdapter.cs:484` |
| LC-6 | 07-10 C-H9 | High | Partial | Unwind, cancellation, and boot sweeps landed. A container is registered for unwind only after the fallible `docker run` await; `ReclaimAsync` deletes the pidfile even when the kill failed; `IsRecordableLifecycleFailure` is a narrow type list, so an unlisted post-side-effect failure skips `TryStopRuntimeAsync`. | `RuntimeAppManifest.cs:2013-2014`; `LocalCommandProcessReclaim.cs:63-68`; `CoreLifecycleService.cs:3605-3606` |
| LC-7 | 07-10 C-H10 | High | Partial | Marker plus boot flag cover only the asynchronous update path, and the boot sweep marks `updating` as failed rather than repairing. The synchronous apply persists no marker; restore is still two `Directory.Move` calls with an in-process rollback only, no journal, and nothing scans for orphaned `.replaced-*` directories. | `CoreLifecycleService.cs:1597-1598,1787-1800,2044-2050`; `AppBackupService.cs:179-210` |
| LC-8 | 07-10 C-H8 | High | Partial | Remove and adopt are label-and-instance checked. Stop, logs, `network rm`, and health inspect act on the derived container name alone; `NormalizeDockerName` still maps `.`/`_`/`-` to `-`; a daemon-unavailable `inspect` reads as "absent", so remove reports success and deletes state. | `RuntimeAppManifest.cs:2044-2086,2186,2355-2382,2910-2918` |
| LC-9 | 07-10 C-M11 | Medium | Open | Source, global-mount, and ingress operations use unrelated lock domains: `GlobalMountService.DeleteAsync` checks usage under its own mutex, not the per-app lock that guards mount configure; `ReconcileIngressAsync` reads every record and writes one global file with no serialization point, so a stale snapshot can land last. | `SourceEndpoints.cs:16-42`; `GlobalMountService.cs:60-93`; `CoreLifecycleService.cs:5621-5636` |
| LC-10 | 07-10 C-M4 | Medium | Partial | App-triggered backups gained keep-last-5 retention. Still no app operation lock, quota, free-space check, or concurrency bound. | `AppBackupEndpoints.cs:13-56`; `AppBackupService.cs:36-60` |
| LC-11 | 07-10 C-M5; 07-05 Core-L8 | Medium | Partial | Prebuilt materialization is staged and renamed, but the lock hash comes from an earlier traversal of the mutable source (`IgnoreInaccessible = true`, `AttributesToSkip = None`, so reparse points are followed), computed synchronously on the start path. | `PrebuiltArtifactStore.cs:19-25,55-61,117-131` |
| LC-12 | 07-10 C-M6 | Medium | Partial | Pipe-FD leak and tail memory fixed. `ProcessRunner` still reads on `CancellationToken.None` with an unbounded post-kill await; no setup deadline (LC-2); no runtime-log rotation (PERF-6). | `ProcessRunner.cs:69-88` |
| LC-13 | 07-05 Core-M4; 07-05 Theme-2.1 | Medium | Open | The failure-recording paths have empty exception filters and `TryStopRuntimeAsync` is a bare `catch {}`; six empty catches remain in the file. | `CoreLifecycleService.cs:3566-3568,3588-3601` |
| LC-14 | 07-05 Core-M10 | Medium | Partial | Development mode gained a `completed` guard. `CreateManualBackupCoreAsync` still restarts unconditionally inside `finally`, so a restart failure replaces the operative exception and discards the backup response. | `CoreLifecycleService.cs:2457-2467` vs `:766-789` |
| LC-15 | 07-05 Core-L6 | Low | Open | `RemoveCoreAsync` deletes data, cache, secrets, backups, and source; `logs/`, `run/`, and `runtimes/` are left behind and only an empty app root is removed. | `CoreLifecycleService.cs:2355-2373,2405` |
| LC-16 | 08-18 M9 | Medium | Open | Rename rollback never restores the CNAME: `createdDnsId` stays null on the update path, so `RollbackPublishAsync` reverts tunnel rules only. Narrow window; self-heals on retry. | `CloudflarePublicationReconciler.cs:112-118,184-224` |

### Core: API contract and error mapping

| ID | Origin | Severity | Status | Finding and what remains | Evidence |
| --- | --- | --- | --- | --- | --- |
| API-1 | 07-10 C-M16 | Medium | Partial | CORS normalization and the telemetry client half are closed. Error mapping is still 400 except `app_not_found`, `already_installed`, and `public_origin_managed`; no ProblemDetails, no 502/503 for upstream failures, no correlation id. | `LifecycleEndpoints.cs:899-929`; `ShellCorsPolicyProvider.cs:26-42` |
| API-2 | 07-05 Core-L5 | Low | Open | `ConfigureCoreAsync` and `ConfigureAutostartCoreAsync` call `UpdateAppAsync` first, so a missing app yields 400 `lifecycle_operation_failed` where the `RequireAppAsync` verbs now yield 404. | `CoreLifecycleService.cs:498,584`; `LifecycleEndpoints.cs:915-927` |
| API-3 | 09-05 S3 | Medium | Recommendation | Update changes are generated as strings such as `image:{service}:{old}->{new}`, then parsed by the same class to decide whether review is required; the browser Shell and the Swift client parse the vocabulary again. Keep a typed change internally, render the wire strings at the boundary, and share a fixture corpus across the three language suites. Preserve: unknown changes require review; `->unknown` never implies an available update; byte-for-byte wire compatibility. | `CoreLifecycleService.cs:4933-5009`; `app-helpers.ts:47`; `AppUpdateChange.swift:39` |
| API-4 | 09-05 D1 | Medium | Open | The read-path document says fleet listing performs no manifest loads; `ResolveRuntimeProfilesAsync` still falls back to `manifests.LoadAsync` for records with no persisted profiles. The same document promises "at most one supervision interval stale", which is a nominal cadence, not a bound (startup precedes the timer, probes can fail or be skipped). The parallelism document says each observation writes "under its own lock", which a record-level mutex does not deliver (LC-1). `FileStamp` should be documented as a best-effort out-of-band change detector. | `CoreLifecycleService.cs:3435,3498-3522`; `core-read-path-caching/feature.md:44,50`; `core-lifecycle-parallelism/feature.md:44`; `JsonStorage.cs:11` |

### Core: performance

| ID | Origin | Severity | Status | Finding and what remains | Evidence |
| --- | --- | --- | --- | --- | --- |
| PERF-1 | 08-25 M3 | Medium | Partial | Introspection passes directory state and the app record through. `AppSessionGrantStore.ReadAsync` still does a full file read plus an O(n) scan on every revalidation, which every app process performs for cookie validation. | `AppSessionGrantStore.cs:17-19,38-42` |
| PERF-2 | 08-25 M4 | Medium | Open | Session and grant "touch" rewrites the whole indented document (users, invitations, password hashes for the session case); only the 5-minute throttle mitigates. No in-memory accumulation, no separate sessions file. | `CoreSessionAuthorization.cs:274-281`; `AppSessionGrantStore.cs:46-68` |
| PERF-3 | 08-25 M5 | Medium | Open | `ECDsa.Create()` + `ImportPkcs8PrivateKey` + `ToArray()` copies on every delegated-token sign and verify. | `DelegatedTokenSigningKey.cs:31-48` |
| PERF-4 | 08-25 M6 | Medium | Partial | The per-tick `docker ps` is gone (owner map cached, 60 s age cap). The blocking `docker stats --no-stream` spawn every 10 s over all containers remains; no streaming child or Engine API path. | `DockerStatsExposition.cs:54-62,115-117,134-138` |
| PERF-5 | 08-25 M8 | Medium | Partial | Orphan re-hash and the doubled metadata parse are fixed. Zip and unzip still run synchronously at `CompressionLevel.Optimal` on the request thread inside the per-app lock. | `AppBackupService.cs:62,184` |
| PERF-6 | 08-25 M9; 07-05 Core-L4 | Medium | Open | localCommand service logs open `FileMode.Append` with no rotation; `GetLogsAsync` is synchronous (`Task.FromResult`) and reads the whole file through `ReadSharedLines(...).TakeLast(...)` to serve at most 1000 lines. | `LocalCommandRuntimeAdapter.cs:92,323,342,360,366-374` |
| PERF-7 | 08-25 M10 | Medium | Open | `docker stop` and the running-check are issued one service at a time, so a multi-service app pays every SIGTERM grace period back to back. | `RuntimeAppManifest.cs:2039-2050` |
| PERF-8 | 08-25 M11 | Medium | Partial | The record cache removed the per-read cost. The `if (app.Ui is not null)` gate still misses for every headless app, so each cache miss (every write to that record) re-reads and deserializes the manifest. | `AppRegistryStore.cs:101-102,227` |
| PERF-9 | 08-25 L1; 08-18 Eff-3 | Low | Partial | MCP `get_app` and `get_host_status` still call `ListAppsAsync` and `FirstOrDefault`. Cheap now that the list neither probes nor loads manifests, but no single-app summary API exists. | `McpEndpoints.cs:213,247` |
| PERF-10 | 08-25 L2 | Low | Partial | `ReconcileIngressAsync` re-lists the registry after every lifecycle verb with no debounce; cost collapsed to a stat per app via the record cache. | `CoreLifecycleService.cs:5625-5626` |
| PERF-11 | 08-25 L3 | Low | Open | Pinned source apps run `CommitExistsAsync`, `git checkout --detach --force`, and `git clean -fd` unconditionally on every start, then an unconditional record write that publishes `app.changed` even when the pin did not move. | `AppSourceService.cs:91,113-132`; `AppRegistryStore.cs:157,164` |
| PERF-12 | 08-25 L4 | Low | Open | A hard `Task.Delay(250)` per service in the localCommand start loop before the `HasExited` check. | `LocalCommandRuntimeAdapter.cs:167` |
| PERF-13 | 08-25 L5 | Low | Open | A new `CorsPolicyBuilder` and `CorsPolicy` on every cross-origin request; only origin resolution is cached. | `ShellCorsPolicyProvider.cs:33-43` |
| PERF-14 | 08-25 L6 | Low | Open | `cloudflare-integration.json` is read from disk on every `/api/core/status` and `/control/v1/core/status` behind the store's single gate. | `CloudflareConnection.cs:336-347`; `HostyCoreApplication.cs:219,228` |
| PERF-15 | 08-25 L7 | Low | Open | Cloudflare diagnostics list publications twice per inspect and classify each publication (one DNS list call each) in a sequential loop. | `CloudflareDiagnostics.cs:31,47,102-109,251` |
| PERF-16 | 08-25 L9 | Low | Open | `WriteIndented = true` for every machine-owned store, roughly doubling every whole-file rewrite including PERF-2. | `JsonStorage.cs:24` |
| PERF-17 | 08-25 L10 | Low | Open | Credential list fingerprints every row and scans users per row; revoke fingerprints every grant and then every session until it matches. | `AccessTokenEndpoints.cs:211-239,399,449-452` |
| PERF-18 | 08-25 L11 | Low | Open | The boot permission sweep enumerates every backup archive and app log with a `GetUnixFileMode` stat per entry on every non-Windows boot; no done-marker. | `CoreFilePermissionMigration.cs:47-85` |
| PERF-19 | 08-25 L12 | Low | Open | `OrderServices` computes waves but flattens them; `StartAsync` starts independent services one at a time. | `RuntimeAppManifest.cs:1801,2841-2864` |

### Core: structure and duplication

| ID | Origin | Severity | Status | Finding and what remains | Evidence |
| --- | --- | --- | --- | --- | --- |
| STR-1 | 07-10 A1; 07-05 Arch-Core-1; 09-05 S1, S2 | Structural | Open, regressed | `CoreLifecycleService.cs` 3,958 → 6,344 lines (install/update/runtime-switch planning, execution, backups, sources, ports, ingress, observation); `RuntimeAppManifest.cs` 3,817 (manifest service, runtime interfaces, `ProcessDockerCommandRunner`, `DockerRuntimeAdapter`, contract types); `HostyCoreApplication.cs` 2,184 (composition plus the supervisor, discovery writer, and retention schedulers). Its constructor exposes optional production collaborators for old fixtures, so a test can omit a behavior enabled in production. Recommended order: move the already-separate types into their own files first (no new abstraction), then extract pure planning/projection (change construction at `:4740`, manifest projection at `:3362`) with explicit inputs, keep the façade and the per-app lock, and use a fixture builder instead of another optional parameter. Do not introduce a workflow engine, generic repositories, or partial-file splits that only move text. | `CoreLifecycleService.cs`; `RuntimeAppManifest.cs:12,1635,1684,1725,3191`; `HostyCoreApplication.cs:1240,1779,1920,2001` |
| STR-2 | 07-10 A2; 07-05 Arch-Core-2 | Structural | Open | 47 hand-registered `/control/v1` routes mirror the `/api` block; the count in `LifecycleEndpoints.cs` alone grew from 21 to 24. Only MCP uses `MapGroup`. The endpoint-authorization harness guards correctness; it does not reduce the duplication. | `LifecycleEndpoints.cs`; `McpEndpoints.cs:23` |
| STR-3 | 07-10 A3; 07-05 Arch-Core-3 | Structural | Open | Each store rolls its own gate and cache; `JsonStorage` exposes read, write, and a stamp only. No shared `UpdateAsync`, compare-and-swap, append writer, or journal, which is why LC-7 and PERF-2 each need their own fix. | `JsonStorage.cs:36-96` |
| STR-4 | 08-18 Reuse-1 | Low | Open | The app-to-Core service-token auth prologue is copied nine times across five files; `AppSecretsEndpoints.Authorize` is the extractable shape. | `DomainEndpoints.cs:90,135,197,242,304`; `AppDirectoryEndpoints.cs:15`; `AppBackupEndpoints.cs:24`; `NotificationEndpoints.cs:59`; `AppSecretsEndpoints.cs:124` |
| STR-5 | 08-18 Reuse-2 | Low | Open | Path-containment check exists four times; `MountPathPolicy` is the owner. | `CoreLifecycleService.cs:886,3672`; `MountPathPolicy.cs:196`; `LocalCommandRuntimeAdapter.cs:790-796` |
| STR-6 | 08-18 Reuse-4 | Low | Open | A second Core-side `JsonSerializerOptions` plus two inlined AOT type-info lookups duplicate `JsonStorage.Options`. | `HostyCoreApplication.cs:1828,1889,1900` |
| STR-7 | 08-18 Reuse-5 | Low | Open | `AppIdentityTokenService.ResolveAppId` has only test callers; its round-trip tests prove nothing about the real verifier in the telemetry backend. | `AppIdentityTokenService.cs:51` |
| STR-8 | 08-18 Reuse-8 | Low | Open | `RestoreIngress` restates `UpsertIngress`'s insert-before-catch-all rule and AOT cast. | `CloudflareTunnelConfigPatcher.cs:18,71-96` |
| STR-9 | 08-18 Alt-1 | Low | Open | Three per-app-id switches sit under the file's "a list entry, not a code path" header; only `hosty.shell` can receive a source override. | `SystemAppBootstrap.cs:5,71,115,129` |
| STR-10 | 08-18 Alt-2 | Low | Open | A second health fold yields `"unhealthy"` where the shared `SummarizeHealthStatus` yields `"unknown"` for all-exited; documented as a deliberate fork. | `LocalCommandRuntimeAdapter.cs:388-398` vs `RuntimeAppManifest.cs:2116-2146` |

### AI Gateway

| ID | Origin | Severity | Status | Finding and what remains | Evidence |
| --- | --- | --- | --- | --- | --- |
| GW-1 | 08-18 H1 | High | Open | `Task` is in `AUTO_ALLOWED_TOOLS`; `requestApproval` returns `allow` for it with no card and no audit line. The comment and `ai-gateway/feature.md:184` still describe the set as read-only. The `query` options set no `allowedTools`, `disallowedTools`, or `agents`. | `harness/claude.ts:31,37,189-210,248-252` |
| GW-2 | 08-18 H2 | High | Open | `settingSources: ["user", "project"]` loads the operator's `permissions.allow` rules into every session; nothing strips or overrides `permissions` before the SDK sees them. The comment describes CLAUDE.md and skills only. | `harness/claude.ts:206`; `settings/store.ts:19` |
| GW-3 | 09-05 F1 | High | Open, **Reproduced** | `append` increments `lastEventSeq` synchronously, then awaits `appendEvent` and `saveRecord`, then publishes; `dispatchHarnessEvent` launches independent promises for a burst. A barrier probe delivered `[3, 2]` to a live subscriber. A client that saw 3 reconnects with `after=3` and never recovers 2; the replay merge uses the last replayed seq as its boundary, so the late event is dropped; two concurrent `saveRecord` calls also race on `record.json` (GW-5). Fix: one per-session promise queue around allocation, append, checkpoint, status, and publish; keep sessions independent; drain under the existing shutdown deadline. | `sessions/manager.ts:832-846,930-946,746`; `sessions/store.ts:170` |
| GW-4 | 09-05 F2 | High | Open, **Reproduced** | `requireLive` is check, await `readRecord`, construct, insert. Two callers after a gateway restart (two Shell tabs, or a subscribe racing a `postMessage`) construct separate `LiveSession` objects; the second insert replaces the first's listeners and pending state. A barrier probe left one of two live subscribers with no events. Fix: share an in-flight load promise per id, remove it on failure, and coordinate with deletion so a late load cannot resurrect a deleted session. | `sessions/manager.ts:803-829,724` |
| GW-5 | 09-05 F4 | Medium | Open | `saveRecord` writes `record.json` in place with `writeFile`; a crash mid-write, or two concurrent saves, leaves an empty or torn record that `readRecord` reports as "not found" and `listRecords` silently drops while the transcript still exists. The temp-plus-rename pattern already exists in the gateway. Fix behind the GW-3 writer; distinguish missing from corrupt in diagnostics. | `sessions/store.ts:130-146`; pattern at `settings/store.ts:167`, `sessions/attachments.ts:217` |
| GW-6 | 08-18 M7 | Medium | Partial | Provider discovery is shared. `refreshAutoAllowedFromPolicy` still lacks the `!this.proxy || !this.proxyBaseUrl` guard, has no empty-servers branch (never calls `proxy.unregister`), reads policy before the fleet where the builder reads both together, and discards the per-provider tokens it mints. | `sessions/manager.ts:459-484` vs `:355-383` |
| GW-7 | 08-18 Reuse-6 | Low | Open | The handshake message names are literals in the panel instead of the SDK constants; the file moved with the panel and the literals moved with it. | `web/src/lib/delegated-token.ts:15-16` vs `packages/app-sdk/src/index.ts:94-95` |
| GW-8 | 09-05 S5 | Structural | Recommendation | After GW-3 and GW-4, extract MCP server discovery, policy refresh, token refresh scheduling, and configuration assembly into a collaborator with explicit inputs; keep session state, transcript ordering, and harness ownership together. Do not split into record/event/status services that independently mutate one session. | `sessions/manager.ts:355-599` |

### CLI and MCP connector

| ID | Origin | Severity | Status | Finding and what remains | Evidence |
| --- | --- | --- | --- | --- | --- |
| CLI-1 | 08-18 H6 | High | Open | `ReadContextNames` swallows a read failure with `yield break`, then the unconditional `DeleteQuietly(contextsFile)` removes the only record of the keychain account names and counts toward the notice, so a valid host token is stranded. | `LegacyCredentialPurge.cs:60,106-111` |
| CLI-2 | 08-18 H7 | High | Open | `CoreControlClient.SendAsync` converts only `OperationCanceledException`; `HttpRequestException` and `JsonException` escape, and neither `RefreshAsync` nor `PollAsync` catches them, so the first connection-refused after a Core restart ends the fleet poll for the session. | `CoreControlClient.cs:113-146`; `McpCommand.cs:250,328` |
| CLI-3 | 08-18 M8 | Medium | Open | One instance-wide handshake gate is taken before the session-cache check and held across the HTTP round trips; N wedged apps cost N timeouts; `Forget` blocks a pool thread with `.Wait()`. | `AppMcpClient.cs:32,51,54,114` |
| CLI-4 | 08-18 L1 | Low | Open | `ToolKey.Escape` uses variable-width `"x2"`, so the escape is not injective; fix is `"x4"`. | `Mcp/ToolKey.cs:112` |
| CLI-5 | 08-18 L3 | Low | Open | The connector's catch-all writes a stderr diagnostic and never answers an id-bearing JSON-RPC request. | `Mcp/StdioMcpServer.cs:108-115` |
| CLI-6 | 07-05 CLI-M6 | Medium | Partial | Two sites now message and exit 1; `RenderLifecycle` still prints a green `ok` on a null body and returns 0. | `AppsCommand.cs:491-496` |
| CLI-7 | 07-05 CLI-M7 | Medium | Partial | The stale `control.json` delete is PID-gated but is a plain `File.Delete`, not compare-and-delete; the deserialized `Nonce` has zero readers although Core implements the nonce guard. | `ControlDiscovery.cs:8-17`; `CoreControlClient.cs:178`; `HostyCoreApplication.cs:1892` |
| CLI-8 | 07-05 CLI-M8 | Medium | Partial | Two `NormalizeManifestReference` variants remain and disagree on `file:` handling. | `AppsCommand.cs:1453-1464`; `UpdateCommand.cs:238-249` |
| CLI-9 | 07-05 CLI-L2 | Low | Partial | `CommandLine` maps cancellation to 130, but `core start` and `update` fold `OperationCanceledException` into generic catches that return 1 first. | `CoreCommand.cs:78`; `UpdateCommand.cs:45,75` |
| CLI-10 | 07-05 CLI-L4 | Low | Open | A misspelled `apps install` flag is absorbed as the manifest path by the default branch. | `AppsCommand.cs:835-843` |
| CLI-11 | 07-05 CLI-L5 | Low | Open | `users list --format` is validated after the round trip. | `UsersCommand.cs:53,61-64` |
| CLI-12 | 07-05 CLI-L6 | Low | Open | `core stop` on a stopped Core exits 1 while `restart` treats the same state as fine. | `CoreCommand.cs:421-423,508-510` |
| CLI-13 | 07-05 CLI-L8 | Low | Open | The foreground `Process` is never disposed; the health poll builds a fresh `HttpClient` every 250–500 ms. | `CoreCommand.cs:86-89,625,665-704` |
| CLI-14 | 07-05 Arch-CLI-2; 09-05 S6 | Structural | Open | `RequireOptionValue` is copied in five files and `OpenCoreAsync` in four; `AppsCommand.cs` is 1,728 lines of mixed command families and DTO registrations. Move command families into cohesive files with a shared request-and-error helper; keep the switch-based dispatch, no generic handler hierarchy or auto-registration. Preserve flags, help, exit codes, JSON output, and secret-safe diagnostics. | `AppsCommand.cs:47,1442`; `CoreCommand.cs:781` |
| CLI-15 | 07-05 Arch-CLI-3 | Structural | Open | No CLI↔Core DTO contract tests; the source-generation contexts are hand-mirrored. | `apps/cli/tests` |
| CLI-16 | 07-05 Arch-CLI-4 | Structural | Partial | The exit-code policy is applied consistently and commented in code; it is not documented under `docs/` and has no helper. | `CommandLine.cs:76-131` |

### Shell (browser)

| ID | Origin | Severity | Status | Finding and what remains | Evidence |
| --- | --- | --- | --- | --- | --- |
| SH-1 | 08-18 M6 | Medium | Open | `.finally(() => inFlight.delete(appId))` runs after `invalidateAll()` and deletes the successor mint's entry, producing duplicate Core mints; the epoch check prevents caching a stale grant but not the map deletion. Fix: identity check before delete. | `workspace/delegated-token-intent.ts:66-77` |
| SH-2 | 08-18 L2 | Low | Open | The launch-code staleness guard compares one closure snapshot of `workspace` to itself and never fires; a stale response re-mounts the previous app's frame until the route effect corrects it. | `shell-client.tsx:1880,1904` |
| SH-3 | 08-18 Reuse-9 | Low | Open | Two install-dialog openers duplicate five resets and keep two mutually exclusive intent fields. | `shell-client.tsx:1852,1861,2350` |
| SH-4 | 08-18 Alt-3 | Low | Open | The install-feed gate hardcodes `hosty.marketplace`; its sibling delegated-token gate keys on the declared interface. | `workspace/install-intent.ts:8,16` vs `delegated-token-intent.ts:104-107` |
| SH-5 | 07-05 Shell-M4; 07-05 Theme-2.2 | Medium | Partial | Error-reading and login-redirect helpers are extracted. There is no `coreFetchJson`, and `shell-client.tsx` alone keeps twelve raw `fetch(` sites with the copied guard block; no lint rule bans raw fetch. | `core-api.ts:1-64`; `shell-client.tsx:264,299,310,351,376,475,789,824,994,1067,1269,1473` |
| SH-6 | 07-05 Shell-L1 | Low | Open | The pending workspace panel renders nothing. | `embedded-workspace-pending-panel.tsx:3-13` |
| SH-7 | 07-05 Shell-L3 | Low | Open | A mounts fetch failure yields a silent empty list (`if (ok)` with no else). | `shell-client.tsx:310-313` |
| SH-8 | 07-05 Shell-L5 | Low | Open | `loadUsers` resets the invite TTL on every reload. | `user-management-page.tsx:80-83` |
| SH-9 | 07-05 Shell-L7 | Low | Open | `formatBytes` caps at MB. | `app-helpers.ts:418-426` |
| SH-10 | 07-05 Shell-L8 | Low | Open | Client-side maps in the notification bell and the metrics page never prune. | `notification-bell.tsx:37,61,98`; `metrics-page.tsx:58,76` |
| SH-11 | 07-05 Shell-L9 | Low | Open | Persisted preference keys are unversioned (now cookies instead of localStorage). | `shell-routes.ts:13-15` |
| SH-12 | 07-05 Shell-L10 | Low | Open | The iframe `sandbox` attribute set is unchanged and the invariant it relies on is undocumented. | `embedded-app-frame.tsx:249` |
| SH-13 | 07-05 Shell-L11 | Low | Open | The default Core origin is still `http://localhost:${corePort}`. | `server-env.ts:13-14` |
| SH-14 | 07-05 Arch-Shell-1; 09-05 S4 | Structural | Open, regressed | `shell-client.tsx` 1,386 → 2,401 lines (initial/session/fleet reads, CSRF, delegated-token minting, iframe launch and recovery, install/update/removal, backups, global mounts, settings, presentation); `dashboard-page.tsx` 1,646; `app-details-dialog.tsx` 1,346. Extract a fleet-data controller, an app-launch controller, and install/details workflow hooks along the existing callback boundaries (backups `:781-1062`, install `:1523-1632`); use discriminated workflow state; no global state-machine framework and no single giant context. Preserve event-sync coalescing, stale full-refresh protection, self-update origin recovery, URL navigation, iframe identity checks, and token-refresh invalidation. | `shell-client.tsx`; `pages/dashboard-page.tsx`; `dialogs/app-details-dialog.tsx` |
| SH-15 | 07-05 Arch-Shell-2 | Structural | Partial | Actions moved to a stable context; `busyAction` still sits in the same value as `state`, so every busy flip re-renders every consumer. | `shell-context.tsx:21-46,92-93` |
| SH-16 | 07-05 Arch-Shell-3 | Structural | Open | DTOs are blind `as T` casts (twelve in `shell-client.tsx`); `noUncheckedIndexedAccess` is off. Pure-module tests now exist under `apps/shell/test/`, which makes a typed boundary cheaper to add. | `types.ts`; `shell-client.tsx` |

### Telemetry (backend and UI)

| ID | Origin | Severity | Status | Finding and what remains | Evidence |
| --- | --- | --- | --- | --- | --- |
| TEL-1 | 08-18 M2 | Medium | Open | `truncated` is computed as `returned >= effectiveLimit`; the store returns a plain list with no signal that the 20,000-span scan cap was hit, so a capped fleet trace list reports itself complete. | `TelemetryMcpEndpoint.cs:389`; `SqliteTelemetryStore.cs:394-413` |
| TEL-2 | 08-18 M3 | Medium | Open | The `/api/mcp` body parse and the `method` read sit outside every try block and no exception middleware is registered, so a malformed body is a 500 rather than a JSON-RPC error. | `Program.cs:85`; `TelemetryMcpEndpoint.cs:27,100` |
| TEL-3 | 08-18 M5 | Medium | Open | `healthz` returns a static `ok`; with the delegated-token public key missing every `/api` read is a 401 while the app shows healthy. It is the `ui` service's only healthcheck; the backend has none. | `telemetry-ui/src/app/healthz/route.ts:9`; `telemetry/manifest.json:99-103` |
| TEL-4 | 08-18 M12 | Medium | Open | `ECDsa.Create()` + `ImportSubjectPublicKeyInfo` on every verify, inside the filter that runs for every `/api` request. Cache the parameters or use a thread-local instance. | `TelemetryCallerAuth.cs:148-149` |
| TEL-5 | 08-18 Eff-1 | Low | Open | `new JsonSerializerOptions(Web)` per token read; also the one reflection-based deserialize that breaks the project's stated AOT invariant. | `TelemetryCallerAuth.cs:167` |
| TEL-6 | 08-18 Eff-2 | Low | Open | The fleet-traces path selects and deserializes `attrs_json` for up to 20,000 rows under the ingest-contended lock; `TraceAccumulator` never reads them. | `SqliteTelemetryStore.cs:404,453` |
| TEL-7 | 08-18 Reuse-7 | Low | Open | Window caps are bare literals shadowing the service constants (drift has happened once already); `ParseCsv` still diverges from `ParseAppFilter` on `.Distinct`. | `TelemetryMcpEndpoint.cs:149,175,394-403` vs `TelemetryQueryService.cs:10-19`, `Program.cs:91-103` |
| TEL-8 | 07-05 TB-M1 | Medium | Open | Exposition timestamps are dropped and every sample is stamped at scrape time, so a stopped app's series reads live for the exporter-expiry window; the heartbeat re-record guarantees rows keep landing. Documented as intentional. | `PrometheusTextParser.cs:6-9`; `TelemetryIngestService.cs:139,206` |
| TEL-9 | 07-05 TB-M2 | Medium | Open | `FileTailReader` handles rotation only by resetting to offset 0 when the file shrank and never opens the rotated backup; backlog beyond 4 MiB is skipped with no signal. | `FileTailReader.cs:29-41` |
| TEL-10 | 07-05 TB-L1 | Low | Open | The `spans` table has no `(trace_id, span_id)` unique constraint. | `SqliteTelemetryStore.cs:93-108` |
| TEL-11 | 07-05 TB-L2 | Low | Open | `HOSTY_TELEMETRY_QUERY_PORT` accepts any positive integer. | `TelemetryBackendOptions.cs:156-162` |
| TEL-12 | 07-05 Shell-M3 | Medium | Partial | The app list is SSE-driven. The three observability pages still say "(live, last hour)" and never poll. | `metrics-page.tsx:234`; `traces-page.tsx:176`; `structured-logs-page.tsx:116` |
| TEL-13 | 07-05 Shell-M5 | Medium | Open | Waterfall rows are mapped inline in the parent; toggling one span re-renders every row; no cap or virtualization. | `traces-page.tsx:353,432-434` |
| TEL-14 | 07-05 Shell-M6 | Medium | Open | The log table keys rows on `content\|originalIndex` and its comment still claims append-only stability, which the rolling 500-row window breaks. | `otlp-log-table.tsx:30-37,55-59` |
| TEL-15 | 07-05 Shell-M8 | Medium | Open | No `AbortController` in the observability pages; the "All resources" fan-out runs to completion after navigation; generation tokens only discard results. | `metrics-page.tsx:101-140`; `traces-page.tsx:77-119` |
| TEL-16 | 07-05 Shell-L6 | Low | Partial | The waterfall bar is clamped at zero; the "Start offset" field still renders a negative offset with a `+` sign. | `traces-page.tsx:638,711` |

### SDKs, demo app, marketplace

| ID | Origin | Severity | Status | Finding and what remains | Evidence |
| --- | --- | --- | --- | --- | --- |
| SDK-1 | 09-05 F5 | Medium | Open | The .NET positive identity cache is a plain `AddMemoryCache()` with no capacity policy, while the SDK document claims both packages are bounded; the TypeScript cache has a 256-entry cap. Only successful validations are cached, so growth is bounded by distinct valid tokens within the TTL, not by an attacker. Fix the document; if a bound is wanted, use an SDK-owned bounded cache rather than a `SizeLimit` on the consumer's shared cache. | `CachingIdentityValidator.cs:20`; `HostyAppServiceCollectionExtensions.cs:59`; `hosty-app-sdk/feature.md:116-118` |
| SDK-2 | 09-05 D2 | Medium | Open | The SDK document presents one classification contract, but the packages differ: .NET collapses invalid/denied/unavailable to `null` and a Core timeout to a 401; token precedence is cookie → bearer → identity header in TypeScript and bearer → identity header → cookie in .NET; only TypeScript ships a browser recovery UI. Publish the matrix; do not align precedence silently. | `server.ts:93,154`; `CoreIdentityValidator.cs:21`; `HostyAuthenticationHandler.cs:78` |
| SDK-3 | 08-18 Reuse-3; 09-05 S7 | Low | Open | `demo-app/src/lib/host-auth.ts` is a 545-line hand-rolled copy of SDK session resolution with its own header literal and `readAppIdentityToken`, while depending on `@hosty-sdk/app`. Tracked by the SDK second-wave plan (Draft); triage there, enumerate intentionally app-specific behavior first, validate through a Core-managed app and Shell. | `host-auth.ts:8,353`; `hosty-app-sdk/plan.md` |
| SDK-4 | 08-18 Reuse-10 | Low | Open | The app-id fallback is re-derived in the marketplace and the telemetry UI instead of calling SDK `getAppId`. | `marketplace/src/lib/installed-apps.ts:12,52`; `telemetry-ui/src/lib/roster.ts:11`; `app-sdk/src/server.ts:61` |
| SDK-5 | 07-05 Demo-L1 | Low | Open | `/api/config` and `/api/health` in the demo app are anonymous and return `storage[].entries` for operator-configured external mounts. | `demo-app/src/app/api/config/route.ts:7-29`; `demo-config.ts:205-213` |
| SDK-6 | 07-05 Demo-L2 | Low | Open | The role store is read-then-write with an atomic rename but no mutex; concurrent assignments lose updates. | `app-roles.ts:148-175,277-284` |

### CI, scripts, documentation

| ID | Origin | Severity | Status | Finding and what remains | Evidence |
| --- | --- | --- | --- | --- | --- |
| OPS-1 | 07-05 CI-M1 | Medium | Partial | The `cli-dev` freshness guard shipped; the publish step is still one `gh release upload dist/* --clobber`, so `SHA256SUMS` is not uploaded last and a mid-window mismatch remains possible. | `cli-release.yml:169-200,290-297` |
| OPS-2 | 07-05 CI-M3 | Medium | Partial | Dependabot covers actions; `actions/checkout@v7`, `actions/setup-dotnet@v6`, `dorny/paths-filter@v4`, `NuGet/login@v1` remain tag-pinned in workflows holding `contents: write`. | `.github/workflows/*.yml` |
| OPS-3 | 07-05 CI-L1 | Low | Partial | Versions and docs checks run ungated; nothing validates manifest or channel JSON against a schema; `skills/**` is uncovered. | `ci.yml:10-16,39,169-185` |
| OPS-4 | 07-05 Scripts-L1 | Low | Open | `irm \| iex` is still the advertised Windows install and `Fail` still `exit 1`s the host shell; no scriptblock form is documented. | `scripts/install.ps1:14-28`; `README.md:20` |
| OPS-5 | 07-05 Scripts-L2 | Low | Open | The skill installer has `--ref` but the README fetches mutable `main` and never mentions it. | `scripts/install-hosty-app-skill.sh:5,29`; `README.md:84-92` |
| OPS-6 | 07-05 Scripts-L3 | Low | Open | The README says checksums are verified "when available"; the installer refuses to install without them. | `README.md:9`; `scripts/install.sh:227,233` |
| OPS-7 | 07-05 Hyg-M2 | Medium | Open | The app-manifest skill reference still tells authors OTLP log viewing is "planned for P4" and the collector has no logs pipeline; the shipped telemetry app contradicts both. | `skills/hosty-app-skill/references/app-manifest.md:173` |
| OPS-8 | 08-18 Doc-1 | Low | Open | Unfinished work parked as prose in three feature documents that have no `plan.md`. | `telemetry-mcp/feature.md:183`; `core-app-shell/feature.md:146`; `access-tokens/feature.md:179-183` |
| OPS-9 | 08-18 Doc-2 | Low | Open | `## Testing Plan` instead of `## Testing Expectations`. | `shell-access-and-system-apps/feature.md:92` |
| OPS-10 | 08-18 Doc-3 | Low | Open | A legacy flat document carries free-text status that the generated index mirrors. | `docs/features/manifest-level-app-assets.md:3,14`; `docs/root.md:173` |
| OPS-11 | 09-05 D3 | Low | Open | Eleven broken relative links in current documents, undetected by `docs-index.mjs --check`; one sits inside the generated block, so the generator's handling of legacy status text needs fixing, not the block. Add a local-link validation gate with explicit handling of generated content, fragments, external URLs, and archives. | `docs/root.md:46,182`; `shell-access-and-system-apps/feature.md:13,122,130,131`; `runtime-app-marketplace/feature.md:131`; `core-app-shell/feature.md:120,146,150,151` |

## Obsolete and refuted

Not counted above; listed so nobody re-files them.

- **07-10 C-M15** (catalog-source corruption fails open): `CatalogSourceStore` and `CatalogSourceService` were deleted by the marketplace pivot; the successor `AppFeeds.cs:84-113` throws on fetch, JSON, or schema failure, which fails closed.
- **07-05 Core-M3** (`TelemetryBackendClient` swallows failures): the Core read proxy for telemetry was deleted (`85d509d0`); there is no successor swallower.
- **07-05 Core-M9, SSRF sub-point**: private-IP manifest install is documented as a supported flow at `RuntimeAppManifest.cs:42-43`; the CSRF half of that finding was fixed.
- **08-18 Refuted-1** (boot-sweep update advisory): notifications were removed from both paths deliberately (`d2009d9e`); the app row carries the failure. Unchanged.
- **08-25 Observation**: three negligible items (update-sweep, event-hub, event-stream) are still present verbatim and still need no action.

## Complexity worth retaining

Carried from the 2026-09-05 review so that remediation does not remove what works:

- The list path reads one registry snapshot and resolves dependency state against it; the legacy profile fallback (API-4) is the only exception. Do not reintroduce per-app live probes into the list.
- Autostart uses priority tiers with bounded concurrency; dependency-graph ordering has its own plan and is not a regression.
- `ApplyManifestProjections` is one shared entry point for normal construction and boot backfill; keep that ownership through any STR-1 extraction.
- TypeScript SDK classification, positive-only caching, and iframe recovery helpers are shared package behavior, not a reason to copy another auth implementation into each app.
- The gateway's shutdown intake barrier, bounded drain, and subscriber replay buffering solve real races; GW-3 must compose with them, not replace them.
- Telemetry's administrator gate is inherited from Core token issuance by design; the absence of a local role check is not a defect. Its app-identity branch still needs its own audience restriction (SEC-2).
- Atomic JSON helpers, lifecycle operation locks, digest-bound apply, iframe sender checks, and standalone recovery-loop guards are necessary complexity even where removing them would shorten a function.

## Recommended remediation order

This is a recommendation for triage into feature plans, not tracked status. Each fix ships with the affected artifact's version bump; this document needs none.

1. **Cheap and high value, one PR each or batched by file:** LC-1 (reuse the drift sweep's nonblocking lock, plus the API-4 wording), GW-1, GW-2, CLI-1, CLI-2, LC-16, SH-1, PERF-3 and TEL-4 (one cached-key pattern), CLI-4, SDK-1 (document), OPS-11.
2. **One PR with deterministic tests each:** GW-3 + GW-4 + GW-5 as one session-ownership change; LC-2 + LC-3 (setup deadline and process-group ownership); SEC-1 (admission reservation plus a KDF semaphore plus body cap); SEC-2 (audience claim across Core, the telemetry verifier, and both SDKs, with a compatibility window); LC-7 (restore journal and orphan scan); LC-4 and LC-5 together with the setup work.
3. **Contract and documentation corrections, separated from behavior changes:** SDK-2, API-4, OPS-7, OPS-8..OPS-10, SEC-3's dialog half.
4. **Bounded correctness tail, batched by subsystem:** the remaining LC, TEL, CLI, and SH Mediums.
5. **Structure, after ownership is stable:** STR-1 file moves first (no abstraction), then pure-planner extraction and API-3; SH-14 workflow extraction; GW-8; CLI-14. Continue SDK adoption through the existing SDK plan.
6. **Performance and Low tail opportunistically**, inside PRs that already touch the file.

## Verification performed

| Check | Result |
| --- | --- |
| `git rev-parse HEAD`; `git status --short` | Baseline `8a7abbc8`; clean apart from the uncommitted 2026-09-05 review |
| Per-finding re-verification of the four earlier reviews against the baseline (read-only: `git log -S`, `git log --grep`, `grep`, `sed`) | 210 items examined (108 + 33 + 42 + 27); verdict counts in the table above. The 15 items of the 2026-09-05 review were not re-verified: it was written at this same baseline, so they are absorbed as they stand, which brings the total to 225. Obsolete and refuted entries are counted inside their review's item count, not in addition to it. |
| Hand re-read of SEC-1, LC-2, LC-3, SEC-7, LC-13, CLI-1, LC-16 | Agreed with the automated verdicts |
| `node scripts/docs-index.mjs --check` | Passes; does not detect OPS-11 |
| Build and test status at this baseline | Carried from the 2026-09-05 review, which ran at the same commit: `npm run lint` passed with two Shell navigation warnings; `npm run build` passed for Core, CLI, telemetry backend, Marketplace, telemetry UI, Shell, demo app; `npm run ai-gateway:build-web` passed; `npm test` passed (TypeScript SDK 69, .NET SDK 53, Core 1,754, CLI 217, telemetry backend 115, Marketplace 103, telemetry UI 10, Shell 103, AI Gateway 248); `swift test` for HostyKit passed 157 tests in 24 suites |

No builds or tests were run for this consolidation itself; the verdicts are static. Green existing tests do not invalidate the reproduced interleavings (GW-3, GW-4), which have no regression tests yet.

### Reproduction outline for GW-3 and GW-4

Recorded so the findings do not depend on a temporary file. The probe ran outside the repository against the real `SessionManager` with a fake store, no credentials, no services:

```ts
// GW-3: a SessionStore-shaped fake, otherwise immediately completing.
appendEvent: async (_id, event) => {
  if (event.seq === 2) await firstAppendBarrier;
  events.push(event);
}
// createSession emits seq 1. Subscribe, then:
const first = manager.addAttachment(id, attachmentA);
await manager.addAttachment(id, attachmentB);
releaseFirstAppend();
await first;
// Observed subscriber sequence: [3, 2].

// GW-4: new manager, no live sessions, a stored record available.
readRecord: async () => {
  if (++reads === 1) await firstReadBarrier;
  return { ...storedRecord };
}
const firstSub = restored.subscribe(id, 0, listenerOne);
await restored.subscribe(id, 0, listenerTwo);
releaseFirstRead();
await firstSub;
await restored.addAttachment(id, attachmentC);
// listenerOne received the event; listenerTwo received nothing.
```

Required regressions when fixing: hold the first append with a barrier, dispatch a second event, and prove neither the second store commit nor its publication overtakes the first; disconnect after an observed cursor and prove replay supplies every later durable event exactly once; subscribe and send simultaneously to a persisted unloaded session with `readRecord` blocked, and assert one live object, one harness start, delivery to both subscribers, and correct behavior if deletion or a read failure occurs while initialization is pending.

## Verification limits

No Core-managed browser end-to-end session, Docker or Cloudflare deployment, network failure injection, Windows execution, native Swift build, or Cardputer firmware test was performed for this consolidation. Findings marked Verified rest on code paths and concrete conditions, not on live reproductions. External repositories that consume the SDKs were not inspected. Line anchors are at the baseline commit only.

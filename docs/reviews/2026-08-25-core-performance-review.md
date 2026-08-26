# Hosty Core — Performance Review

- **Date:** 2026-08-25
- **Baseline:** `main` @ `9b6b229b` (merge of PR #404, platform 0.89.0).
- **Scope:** `apps/core/src/Haas.Hosty.Core` only — performance, not correctness or security. Covers the auth hot paths and persistent stores, the app lifecycle and runtime adapters, the event bus / SSE / stats / HTTP pipeline, and the background services and external integrations.
- **Method:** four independent subsystem passes (auth + stores; lifecycle + process execution; events + HTTP pipeline; background services + integrations), each verifying every candidate against the source before reporting. Cross-pass duplicates are consolidated below; two passes independently confirmed the two headline findings. No source was changed and no benchmark was run — cost statements are structural (what scales with what), not measured.
- **Excluded:** `apps/cli`, runtime apps, packages, and anything outside `apps/core`.

## Severity model

- **High** — cost on a hot path (per-request or per-poll) that scales with fleet size, store size, or client count.
- **Medium** — steady-state background cost, per-operation amplification, or unbounded growth that degrades over time.
- **Low** — measurable but small; worth fixing opportunistically or subsumed by a higher item.

**Totals:** 4 High / 11 Medium / 12 Low.

## Executive summary

Core's foundations are strong: Native AOT with source-generated JSON everywhere (no reflection serialization at all), disciplined `HttpClient` usage, atomic temp+rename store writes, a bounded parallel update sweep, a serialize-once event hub with bounded per-subscriber channels, and no `.Result`/`.Wait()` blocking anywhere in the reviewed code. The problems are almost entirely of one species: **nothing in the process caches parsed state, so the hottest read paths pay disk I/O, JSON parsing, and even live network probes on every call** — despite every store being single-writer within the process, which makes correct caching trivial.

Three changes dominate everything else:

1. **Cache `UserDirectoryState` in memory (H1).** Every authenticated request re-reads and re-parses the entire `auth/state.json`. One `volatile` field invalidated by the store's own writes removes the dominant recurring I/O in the process and fixes the double-read patterns in introspection and revalidation as a side effect.
2. **Take live work out of `GET /api/apps` (H2).** The endpoint the Shell polls re-reads every app's `state.json`, re-parses and re-hashes manifests, and runs sequential live HTTP/TCP health probes per request — duplicating what the 15-second supervisor already maintains. Serve persisted state.
3. **Write-through caches in `AppRegistryStore` and `AppManifestService` (H3).** These two uncached read paths are the shared multiplier under `GET /api/apps`, the supervision tick, ingress reconciles after every lifecycle verb, runtime-context builds, and the stats gate.

---

## High

### H1 — Every authenticated request re-reads and re-parses the whole auth store from disk

[CoreSessionAuthorization.cs:197](../../apps/core/src/Haas.Hosty.Core/CoreSessionAuthorization.cs#L197), [UserDirectoryStore.cs:19](../../apps/core/src/Haas.Hosty.Core/UserDirectoryStore.cs#L19), [JsonStorage.cs:23](../../apps/core/src/Haas.Hosty.Core/JsonStorage.cs#L23)

`ResolveSessionAsync` — the front door for every session-gated route (89 `RequireSessionAsync`/`RequireAdminSessionAsync` call sites, plus `/api/auth/session` which every Shell client polls, the SSE connect, MCP requests, introspection, revalidation, and on-behalf-of) — calls `users.ReadAsync`, which is a raw `File.OpenRead` + full `DeserializeAsync` of `auth/state.json`: all users, sessions, invitations, assignments, and PBKDF2 password credentials, every time, with no cache anywhere. It then does O(n) `FirstOrDefault` scans over sessions and users and discards the graph. `GET /api/apps` reads the store **twice** per request (once in `RequireSessionAsync`, again for `FilterAppsForUser`, [DomainEndpoints.cs:22](../../apps/core/src/Haas.Hosty.Core/DomainEndpoints.cs#L22)).

Core is a single-process daemon and `UserDirectoryStore` is the sole writer of its file, so invalidation is trivially correct and the instant-revocation guarantee is preserved exactly: cache the parsed `UserDirectoryState` in a `volatile` field, replace it inside `WriteAsync`/`UpdateAsync`, and build a session-id dictionary on load (which fixes the per-request O(n) scans for free). Optionally guard with a file-mtime check for out-of-band edits.

### H2 — `GET /api/apps` re-parses manifests and runs live network health probes on every poll

[CoreLifecycleService.cs:90](../../apps/core/src/Haas.Hosty.Core/CoreLifecycleService.cs#L90) (`ListAppsAsync`), [CoreLifecycleService.cs:5687](../../apps/core/src/Haas.Hosty.Core/CoreLifecycleService.cs#L5687) (`ReconcileRuntimeStateForSummaryAsync`), [RuntimeAppManifest.cs:43](../../apps/core/src/Haas.Hosty.Core/RuntimeAppManifest.cs#L43), [LocalCommandRuntimeAdapter.cs:399](../../apps/core/src/Haas.Hosty.Core/LocalCommandRuntimeAdapter.cs#L399), [HealthProbe.cs:28](../../apps/core/src/Haas.Hosty.Core/HealthProbe.cs#L28)

Per request, sequentially per app: every app's `state.json` is read from disk (H3); for every *running* app — docker included — `LoadSelectionForAppAsync` performs a full manifest load (file read + SHA-256 of the whole document + deserialize + full validation; **twice** for live-source apps, last-good + live) *before* the localCommand-only early return; for each running localCommand app it additionally builds a full runtime context (global-mounts file read, one registry read per declared dependency, one for the collector) and performs a **live HTTP/TCP probe** per service with a declared healthcheck (default timeout 5 s).

This is the hottest read path in the system, and the event bus amplifies it: events are hints, so one `app.changed` makes every connected client re-fetch `/api/apps` — one registry commit → N clients × (M state reads + M manifest parses + K network probes). A single hung localCommand service stalls the whole apps list for everyone, per poll, by up to its probe timeout.

The 15-second supervisor already performs this same reconciliation and persists `RuntimeState`, and every record commit publishes `app.changed` — the per-request re-probe is duplicate work. Recommendation: serve persisted state from the list path (at most a cheap `Process.HasExited` check for localCommand), or cache the reconcile result with a short TTL (5–15 s); persist the runtime-profile type on the record so the list never needs a manifest load just to branch on runtime kind; if any per-request reconcile is kept, fan it out with bounded `Task.WhenAll`.

### H3 — No in-memory cache for app records or manifests; every operation re-reads disk

[AppRegistryStore.cs:18](../../apps/core/src/Haas.Hosty.Core/AppRegistryStore.cs#L18) (`ListAppRecordsAsync`), [AppRegistryStore.cs:63](../../apps/core/src/Haas.Hosty.Core/AppRegistryStore.cs#L63) (`GetAppAsync`), [RuntimeAppManifest.cs:43](../../apps/core/src/Haas.Hosty.Core/RuntimeAppManifest.cs#L43) (`AppManifestService.LoadAsync`)

`ListAppRecordsAsync` enumerates every app directory and deserializes each `state.json` on every call. Callers: every `GET /api/apps`, every 15 s supervision tick, `ReconcileIngressAsync` after **every** start/stop/restart/remove/reassign/routing-configure ([CoreLifecycleService.cs:5550](../../apps/core/src/Haas.Hosty.Core/CoreLifecycleService.cs#L5550)), boot sweeps, the update sweep, removal impact, port plans. `GetAppAsync` runs per dependency and per telemetry-endpoint resolution inside every runtime-context build. `AppManifestService.LoadAsync` has no cache: full read + SHA-256 + validation per call.

All registry mutations funnel through the store's per-app lock (`UpsertAppCoreAsync`), so a write-through in-memory cache keyed by app id is trivially coherent. Manifests can be cached on (path, mtime) or on the digest the loader already computes. Individual files are small — this is death by frequency, not size — but it is the single broadest multiplier in the process.

### H4 — Boot starts all autostart apps strictly sequentially

[CoreLifecycleService.cs:3051](../../apps/core/src/Haas.Hosty.Core/CoreLifecycleService.cs#L3051) (`StartAutostartAppsAsync`), driven from [HostyCoreApplication.cs:1129](../../apps/core/src/Haas.Hosty.Core/HostyCoreApplication.cs#L1129)

Each app is `await`ed in a `foreach`; one start can include a `docker pull`, per-service docker spawns, up to 5 s of port-release polling, and git spawns for pinned source apps. Time-to-all-running scales linearly with app count, and one slow image pull delays every app behind it. The only ordering constraint is capability providers before consumers (`PlatformCapabilities.StartPriority`); within a tier the apps are independent — each start runs under its own per-app lock, and shutdown already proves parallel per-app lifecycle is safe (`StopRuntimeAppsAsync` is `Task.WhenAll`). Recommendation: group by `StartPriority`, `Task.WhenAll` within each tier, optionally capped by a small semaphore (~4) to bound concurrent pulls.

---

## Medium

### M1 — Supervision tick: sequential per-service `docker inspect` spawns every 15 seconds

[CoreLifecycleService.cs:5761](../../apps/core/src/Haas.Hosty.Core/CoreLifecycleService.cs#L5761) (`ObserveRuntimeHealthAsync`), [RuntimeAppManifest.cs:2020](../../apps/core/src/Haas.Hosty.Core/RuntimeAppManifest.cs#L2020) (`DockerRuntimeAdapter.GetHealthAsync`), [RuntimeAppManifest.cs:2400](../../apps/core/src/Haas.Hosty.Core/RuntimeAppManifest.cs#L2400) (`ResolveImageRepoDigestAsync`)

Every believed-running docker app gets one `docker inspect <container>` **plus** one `docker inspect <imageId>` per service, sequentially, every tick — on the order of 90k process spawns/day for a 10-app / 15-container host — and each observed app re-parses its manifest and rebuilds a runtime context per tick (subsumed by H3). Independent fixes: batch — `docker inspect` accepts multiple names, so one spawn per app or per fleet; cache imageId → repoDigest in a `ConcurrentDictionary` (the mapping is immutable for a given image id; this alone halves the spawns and also serves `GET /api/apps/{id}/health`); fan per-app observations out with bounded `Task.WhenAll` as the update sweep already does.

### M2 — Audit log grows forever; every read loads the entire file

[AuditStore.cs:8](../../apps/core/src/Haas.Hosty.Core/AuditStore.cs#L8) (append), [AuditStore.cs:24](../../apps/core/src/Haas.Hosty.Core/AuditStore.cs#L24) (`ReadRecentAsync`)

Appends are true NDJSON appends (good), but no rotation or retention exists anywhere, and the log receives a line for every login attempt, credential issue/revoke, delegated-token exchange (success *and* refusal), and **every named MCP tool call** via introspection ([TokenIntrospectionEndpoints.cs:94](../../apps/core/src/Haas.Hosty.Core/TokenIntrospectionEndpoints.cs#L94)). `ReadRecentAsync` does `File.ReadAllLinesAsync` of the whole file then `.Reverse().Take(≤500)` — O(total history) allocation per admin audit view, growing without bound on an agent-trafficked host. Recommendation: size- or age-based rotation, and a tail read that seeks backward from EOF (or streams into a 500-line ring buffer).

### M3 — Token introspection and grant revalidation read the same stores twice per call

[TokenIntrospectionEndpoints.cs:46](../../apps/core/src/Haas.Hosty.Core/TokenIntrospectionEndpoints.cs#L46), [TokenIntrospectionEndpoints.cs:63](../../apps/core/src/Haas.Hosty.Core/TokenIntrospectionEndpoints.cs#L63), [AppIdentityService.cs:166](../../apps/core/src/Haas.Hosty.Core/AppIdentityService.cs#L166), [AppSessionGrantStore.cs:38](../../apps/core/src/Haas.Hosty.Core/AppSessionGrantStore.cs#L38)

Per MCP tool call: 2 full `state.json` reads, 2 app-record reads (`RequireAccessibleUserAsync` re-reads both internally), an awaited audit append, and a possible touch write. Same shape in `OnBehalfOfTokenEndpoints`. `RevalidateAsync` — called by every app process for cookie validation, with only a 30 s SDK-side cache — adds a whole-file read + O(n) scan of `app-grants.json`. Recommendation: overloads that accept the already-read state/app; cache `AppSessionGrantState` in memory with a `TokenHash` index (same single-writer argument as H1). H1+H3 turn this path into the pure in-memory check its design comment already claims it is.

### M4 — Session/grant "touch" rewrites the entire store file for one timestamp

[CoreSessionAuthorization.cs:261](../../apps/core/src/Haas.Hosty.Core/CoreSessionAuthorization.cs#L261) (`TouchSessionAsync`), [AppSessionGrantStore.cs:46](../../apps/core/src/Haas.Hosty.Core/AppSessionGrantStore.cs#L46) (`TouchAsync`)

The 5-minute per-credential throttle is real mitigation, but each touch is still a full read + full indented-JSON rewrite (temp+rename+chmod) of a document containing users, invitations, and password hashes — K live credentials produce K such rewrites per 5 minutes, all queued on the same global store gate as logins and revocations. Recommendation: accumulate `LastSeenAt` advances in memory and flush in one batched write (periodic or piggybacked on the next real mutation) — the design comments themselves argue minutes of imprecision are irrelevant. Alternatively split sessions into their own smaller document.

### M5 — ECDSA key re-imported and a fresh `ECDsa` created on every sign/verify

[DelegatedTokenSigningKey.cs:31](../../apps/core/src/Haas.Hosty.Core/DelegatedTokenSigningKey.cs#L31)

`Sign` and `Verify` each do `ECDsa.Create()` + `ImportPkcs8PrivateKey` per call (plus `ToArray()` span copies). Consumers: delegated-token issuance/read and app-identity tokens — `ReadClaims` runs as the first probe on every `POST /api/apps/{appId}/delegated-token`, and issuance recurs every ≤5 minutes per user per system app (5-minute TTL, refresh = call again), plus every exchange/on-behalf-of call. Recommendation: pool `ECDsa` instances initialized once from the PKCS8 blob; use the `ReadOnlySpan<byte>` overloads to drop the copies.

### M6 — Docker stats: two CLI spawns every 10 s, with `--no-stream` blocking ~1–2 s per sample

[DockerStatsExposition.cs:21](../../apps/core/src/Haas.Hosty.Core/DockerStatsExposition.cs#L21), [DockerStatsExposition.cs:71](../../apps/core/src/Haas.Hosty.Core/DockerStatsExposition.cs#L71)

While the telemetry app runs, each tick spawns `docker ps` + `docker stats --no-stream` (which samples **all** containers and waits two cgroup samples to compute CPU%) — ~17k spawns/day for a fixed-cadence sampler. The idle gating (no spawns when telemetry is absent) is already correct, but the gate itself is a registry disk read per tick (subsumed by H3). Recommendation: one long-lived streaming `docker stats --format …` child (or the Engine API `/containers/{id}/stats`), owners map refreshed on `app.changed` instead of `docker ps` per tick; at minimum pass the owned container names as arguments to skip foreign containers.

### M7 — Notification store rewrites the whole all-users inbox per publish/mark-read; unread is never pruned

[NotificationStore.cs:16](../../apps/core/src/Haas.Hosty.Core/NotificationStore.cs#L16), [NotificationService.cs:207](../../apps/core/src/Haas.Hosty.Core/NotificationService.cs#L207)

Every publish and mark-read is a full read-modify-rewrite of `notifications.json` under one global gate, with an O(recipients × inbox) dedupe scan. Retention caps only *read* records (100/user + 30 days); **all unread records are kept unconditionally** — an admin who never opens the bell accumulates unread advisories without bound, and every later publish pays the growing rewrite. Recommendation: cap unread per user too (drop oldest beyond N); keep the parsed state in memory between writes (the gate already serializes writers).

### M8 — Backup housekeeping re-hashes orphaned archives on every plan build

[AppBackupService.cs:479](../../apps/core/src/Haas.Hosty.Core/AppBackupService.cs#L479), [AppBackupService.cs:81](../../apps/core/src/Haas.Hosty.Core/AppBackupService.cs#L81), [AppBackupService.cs:52](../../apps/core/src/Haas.Hosty.Core/AppBackupService.cs#L52)

A `.zip` without its `.json` metadata is fully SHA-256-hashed every time the cleanup plan is built — which happens every 6 h on the scheduler, on **every GET of an app's backup list**, and after every retention-managed backup — yet orphans are `Automatic: false`, so the sweep never deletes them: a multi-GB orphan is re-hashed ~4×/day + per list view, forever. Also: `ListBackupsAsync` parses all metadata twice per request (lines 80–81), and `ZipFile.CreateFromDirectory(…, Optimal)` / `ExtractToDirectory` run synchronously on the request thread inside the per-app lock. Recommendations: hash orphans lazily at delete time only (the delete path already re-hashes) or cache the digest on (path, size, mtime); pass the records into the plan builder; `CompressionLevel.Fastest` + `Task.Run` for the zip work.

### M9 — localCommand log tail reads the entire log file to serve ≤1000 lines, synchronously

[LocalCommandRuntimeAdapter.cs:336](../../apps/core/src/Haas.Hosty.Core/LocalCommandRuntimeAdapter.cs#L336), [LocalCommandRuntimeAdapter.cs:360](../../apps/core/src/Haas.Hosty.Core/LocalCommandRuntimeAdapter.cs#L360)

`TakeLast(≤1000)` over a line enumeration of the whole file — bounded memory but full-file I/O and UTF-8 decode on the request thread, and service logs have no rotation on this path, so a chatty app makes every logs request cost the full file. Recommendation: seek from EOF and scan backward for N newlines (or cap at the last 1–2 MB), async.

### M10 — Docker stop is serial per service inside an app

[RuntimeAppManifest.cs:1958](../../apps/core/src/Haas.Hosty.Core/RuntimeAppManifest.cs#L1958) (`StopAsync`)

App-level stops are parallel (`Task.WhenAll`), but within an app each service gets its own `docker stop` (waiting out the SIGTERM grace, default 10 s) + `docker inspect`, serially — a 2-service app using its full grace can alone blow the 15 s shutdown budget. Recommendation: one `docker stop c1 c2 …` invocation (docker stops them concurrently) + one batched inspect.

### M11 — `HydrateAppUiAsync` re-reads the manifest on every registry read for every headless app

[AppRegistryStore.cs:185](../../apps/core/src/Haas.Hosty.Core/AppRegistryStore.cs#L185)

The early-return gate is `app.Ui is not null`, but `Ui` is legitimately null for headless apps (the projection stores null), so every `ListAppRecordsAsync`/`GetAppAsync` re-reads and deserializes the manifest copy just to discard the identical result — doubling the JSON work per registry read for, e.g., the OTLP collector, which is fetched inside every runtime-context build. Recommendation: persist a hydrated marker, or treat any record with a current `NormalizedBy` as already projected.

---

## Low

### L1 — MCP `get_app` / `get_host_status` run the full fleet pipeline to answer about one app

[McpEndpoints.cs:212](../../apps/core/src/Haas.Hosty.Core/McpEndpoints.cs#L212), [McpEndpoints.cs:246](../../apps/core/src/Haas.Hosty.Core/McpEndpoints.cs#L246) — both call `lifecycle.ListAppsAsync` (the whole H2 pipeline, probes included); `get_app` then `FirstOrDefault`s the id. A single-app path (`GetAppAsync` + `BuildAppSummaryAsync`) suffices; `get_host_status` needs records, not reconciled summaries.

### L2 — `ReconcileIngressAsync` re-lists the whole registry after every lifecycle verb

[CoreLifecycleService.cs:5550](../../apps/core/src/Haas.Hosty.Core/CoreLifecycleService.cs#L5550) — full `ListAppRecordsAsync` + provider reconcile even when nothing routing-relevant changed. Subsumed by H3; otherwise pass the changed record or debounce.

### L3 — Pinned source apps pay 3+ git spawns and a registry write on every start, even unchanged

[AppSourceService.cs:60](../../apps/core/src/Haas.Hosty.Core/AppSourceService.cs#L60) — unconditional `git checkout --detach --force` + `git clean -fd` + an `UpdateAppAsync` rewrite that publishes `app.changed` even when the pin did not move. Check `git rev-parse HEAD` against the pin first and skip.

### L4 — Fixed 250 ms sleep per service on every localCommand start

[LocalCommandRuntimeAdapter.cs:161](../../apps/core/src/Haas.Hosty.Core/LocalCommandRuntimeAdapter.cs#L161) — a hard `Task.Delay` before the fast-fail check, serial per service (750 ms for a 3-service app). `WaitForExitAsync` with a 250 ms timeout returns early on instant death and costs nothing otherwise.

### L5 — Shell CORS policy object rebuilt per cross-origin request

[ShellCorsPolicyProvider.cs:33](../../apps/core/src/Haas.Hosty.Core/ShellCorsPolicyProvider.cs#L33) — origin resolution is already cached (5 s TTL), but a new `CorsPolicyBuilder` + `CorsPolicy` is allocated per request carrying an `Origin` header. Cache the built policy keyed by resolved origin.

### L6 — `/api/core/status` reads `cloudflare-integration.json` from disk per request behind a global semaphore

[CloudflareConnection.cs:336](../../apps/core/src/Haas.Hosty.Core/CloudflareConnection.cs#L336), used from [HostyCoreApplication.cs:195](../../apps/core/src/Haas.Hosty.Core/HostyCoreApplication.cs#L195). A short-TTL cache (the resolver pattern) fixes both the read and the serialization of concurrent status requests.

### L7 — Cloudflare diagnostics: sequential per-publication DNS lookups and a doubled store read

[CloudflareDiagnostics.cs:92](../../apps/core/src/Haas.Hosty.Core/CloudflareDiagnostics.cs#L92) — one `ListDnsRecordsAsync` per stored publication in a sequential `foreach`, and `publications.ListAsync` read twice per inspect. Request-driven only; bounded `Task.WhenAll` + reuse the first list.

### L8 — Audit append re-ensures the directory and reopens the file every time

[AuditStore.cs:10](../../apps/core/src/Haas.Hosty.Core/AuditStore.cs#L10) — per append: `EnsurePrivateDirectory` (mkdir + chmod) + new `FileStream`, awaited inline on the introspection path. Ensure the directory once in the constructor; optionally a channel-backed background writer.

### L9 — `WriteIndented = true` for all machine-owned stores

[JsonStorage.cs:9](../../apps/core/src/Haas.Hosty.Core/JsonStorage.cs#L9) — cosmetic formatting roughly doubles the bytes of every whole-file rewrite (M4's touches, every login, every grant append). Compact JSON where humans don't read the file.

### L10 — Credential list/revoke fingerprint every record per request

[AccessTokenEndpoints.cs:211](../../apps/core/src/Haas.Hosty.Core/AccessTokenEndpoints.cs#L211), [AccessTokenEndpoints.cs:392](../../apps/core/src/Haas.Hosty.Core/AccessTokenEndpoints.cs#L392) — per-row SHA-256 fingerprints plus an O(sessions×users) projection on list; revoke fingerprints every grant/session until a match. Management endpoints, low frequency; a fingerprint→id map makes revoke O(1).

### L11 — Boot-time permission sweep re-runs its full scan every boot

[CoreFilePermissionMigration.cs:47](../../apps/core/src/Haas.Hosty.Core/CoreFilePermissionMigration.cs#L47) — enumerates all backup archives and app log files with a `GetUnixFileMode` stat per entry on every startup, long after migration. A done-marker makes it O(1).

### L12 — Docker `StartAsync` runs same-wave services serially

[RuntimeAppManifest.cs:1705](../../apps/core/src/Haas.Hosty.Core/RuntimeAppManifest.cs#L1705) — `OrderServices` computes dependency waves, but independent services within a wave still start one at a time (each with its own `inspect` + `rm` + possible `pull` + `run`). Parallelizing within a wave cuts multi-service start latency.

### Observation (no action needed)

- The disabled update-check scheduler wakes every 5 minutes purely to read an in-memory volatile ([AppUpdateSweep.cs:222](../../apps/core/src/Haas.Hosty.Core/AppUpdateSweep.cs#L222)) — negligible; the event hub could serve as the wake channel if it ever bothers anyone.
- The CoreEventHub publish path allocates a LINQ snapshot per publish, and the SSE loop allocates a linked CTS per wait and an interpolated frame string per event ([CoreEventHub.cs:74](../../apps/core/src/Haas.Hosty.Core/CoreEventHub.cs#L74), [EventStreamEndpoints.cs:79](../../apps/core/src/Haas.Hosty.Core/EventStreamEndpoints.cs#L79)) — cosmetic at hint-level event rates.

---

## Confirmed mitigations (verified — the baseline is healthy)

- **Native AOT + source-generated JSON everywhere**: `CoreJsonSerializerContext` backs both storage and all endpoint responses; a repo-wide grep found no `JsonSerializer` call without a source-gen `JsonTypeInfo`.
- **HttpClient hygiene**: all outbound clients are factory-named/typed or long-lived singletons with explicit timeouts; `NetworkHealthProbe` shares one `SocketsHttpHandler`; no `new HttpClient` per call anywhere reviewed.
- **Registry digest fast path**: raw registry HEAD with per-(registry, scope) anonymous-token caching replaces `buildx imagetools` (the known 7× issue), with capped streamed bodies and a CLI fallback only when HTTP can't answer.
- **Update sweep**: single-flight with join semantics, bounded fan-out (16 apps) over a host-wide probe gate (8), 90 s per-app ceiling, cached verdicts/plans so the UI never re-probes.
- **Event hub**: serialize-once fan-out, serialization skipped when nobody is subscribed, bounded per-subscriber channels (64, DropOldest) so slow consumers can't grow memory, subscriber cleanup on disconnect.
- **SSE**: batch drain with one flush per batch, heartbeats, stream token linked to `ApplicationStopping` (the shutdown-starvation issue is fixed), auth once per connection.
- **Stores**: atomic temp+rename writes; no global registry file (one `state.json` per app under a per-app lock); reads bypass store gates so readers never queue behind writers; PBKDF2 (600k iterations) runs only at login; session/grant/auth-code stores prune on write; ephemeral flows (device auth, OAuth pending) are in-memory.
- **No blocking async**: no `.Result` / `.Wait()` / `GetAwaiter().GetResult()` / `Thread.Sleep` in the reviewed code.
- **No global lifecycle lock**: verbs serialize per app; status reads take no operation lock; boot sweeps take locks non-blockingly.
- **Settings and origins cached**: `CoreSettingsService` is volatile-swap in-memory; `ShellPublicOriginResolver` has a 5 s TTL cache keeping the per-request CORS path off disk.
- **Stats exposition**: fully idle (no docker spawns) unless the telemetry app is installed and running; the scrape endpoint serves a prebuilt string swapped atomically.
- **Large files stream**: backups zip directly to disk; asset downloads use `Results.File` with weak-ETag conditional GET; feed documents capped at 1 MB with single-pass read+hash.
- **Cloudflare reconciler**: diffs stored vs. desired before any network call — a steady-state boot performs zero Cloudflare API I/O.

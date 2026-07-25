# Hosty Core — Security and Code Quality Review

- **Date:** 2026-07-10
- **Baseline:** `main` @ `5fb8dda8` (merge of PR #141)
- **Primary scope:** `apps/core`, including authentication, lifecycle orchestration, runtime adapters, filesystem boundaries, persistence, backup/restore, ingress, and API authorization.
- **Boundary scope:** the Shell and CLI paths that create, display, and apply Core install/update plans.
- **Method:** static review with three independent Core-focused passes (security, runtime/storage/concurrency, and ASP.NET/API/architecture), followed by line-by-line re-verification of the highest-risk claims. Existing local file modes were inspected without reading file contents. No exploit was run and no source code was changed.
- **Excluded:** third-party dependency CVE research, deployment-specific firewall rules outside the repository, and an exhaustive review of non-Core applications.

> **Status note (2026-07-18).** This document was written against `5fb8dda8` and re-verified finding by finding against `main` @ `1f842a68`, eight days and roughly 17,000 changed Core lines later. **Every file path and line anchor below refers to the old baseline and is stale — locate findings by symbol, not by line number.** Three items closed, one became obsolete, four got measurably worse; the rest stand. See [Status re-verification](#status-re-verification-2026-07-18) immediately after the executive summary.

## Severity model

- **Critical:** defeats a primary security boundary and can turn an explicitly reviewed action into execution of different, unreviewed code or privileges.
- **High:** credible cross-user/cross-app isolation failure, secret exposure, host-impacting action, authentication failure, data-loss window, or persistent runtime/state corruption.
- **Medium:** meaningful availability, integrity, information-disclosure, or correctness defect with a realistic trigger, but narrower prerequisites or blast radius.
- **Low:** defense-in-depth, hardening, test-guard, or maintainability problem without a demonstrated high-impact path by itself.

Severity measures impact, not whether a finding is an externally exploitable vulnerability. Several High findings are authorized-operation, local-host, crash-consistency, or reliability defects whose prerequisites are stated in their impact sections. Finding counts must therefore not be read as a vulnerability count.

**Totals:** 1 Critical / 10 High / 16 Medium / 2 Low, plus four structural observations.

## Executive summary

Core has several good foundations: cryptographically random sessions, fixed-time password verification, owner-restricted auth/key files, JSON temp-and-rename writes, per-app lifecycle locks, label-checked Docker removal on the start path, argument-list process invocation in most places, manifest/asset size caps, and a substantial unit-test suite.

The strongest security property, however, is currently not true: **the manifest that the operator reviews is not necessarily the manifest that Core installs, and image identity is not durably bound to the review**. The install API does not accept the reviewed manifest digest at all. Install review authorizes a mutable image-tag string rather than exact image bytes. Update apply recomputes a plan and then fetches the manifest a second time without binding that second response to the accepted plan; a resolved image digest can likewise change before start. A changing or malicious feed can therefore display a benign manifest and deliver different commands, image bytes, capabilities, devices, networking, or mounts at apply/start time.

The next risk cluster is filesystem and runtime isolation. External mount validation does not canonicalize ancestor symlinks and passes the original path to Docker after validation. App assets can expose unassigned apps' runtime data and stale files; asset vendoring follows HTTP redirects without revalidating the destination and follows local symlinks. Docker names/networks are collision-prone, and stop/inspection paths do not consistently verify ownership or distinguish “not found” from “daemon unavailable.”

Authentication and local-host hardening also need attention. Recovery tokens are not atomically consumed, the login throttle can be bypassed by parallel requests before a 600,000-iteration PBKDF2 failure is recorded, and app state/backups/logs/audit files are created with ordinary filesystem modes. On the inspected development host, existing app state and backup files were `0644` and their directories were `0755`, confirming that the issue is not merely theoretical under a normal Unix umask.

The most important remediation principle is to make security decisions structural: immutable server-side review snapshots, one data-root process lease, one app-operation coordinator, canonical/no-follow filesystem access, identity-based Docker operations, audience-specific DTOs, and real HTTP policy tests.

---

## Status re-verification (2026-07-18)

Re-checked against `main` @ `1f842a68`. Statuses are evidence-based: nothing is marked closed without code that closes it.

| Finding | Status | Note |
| --- | --- | --- |
| C-CR1 reviewed manifest not bound to apply | **Partial** | Update path closed (cached confirmed plan, no second fetch). Direct install still has no digest or plan binding, and no path persists the reviewed image digest as the lock that start runs. |
| C-H1 review omits security effects | Open | Install plan gained only a `System` flag. Still no images, command/setup, capabilities, devices, host networking, ports, or mounts. |
| C-H2 install overwrites existing app | **Open, worse** | Reinstall now additionally nulls `PortAssignments` and reallocates ports while the old runtime holds them. The digest-bound feed path calls the same core and applies `already-installed` plans. |
| C-H3 mount ancestor-symlink bypass | Open | `MountPathPolicy.cs` byte-identical to baseline. |
| C-H4 asset endpoint IDOR | Open | `AppAssetEndpoints.cs` byte-identical to baseline. |
| C-H5 parallel login bypasses throttle | Open | Unchanged; no rate limiter, no KDF semaphore, no body limit. |
| C-H6 permissive file modes | Partial | Newer stores opt into owner-only. The four named targets — registry state, backups, logs, audit — still use default modes; no startup migration. |
| C-H7 two Cores share a data root | Open | No lease. Discovery nonce is a CLI-discovery fix only. |
| C-H8 collision-prone Docker names | Partial | `remove`/adopt are label-checked. `stop`, `logs`, health inspect and networks are not; daemon-unavailable still collapses to "not found" and deletes state. |
| C-H9 cancellation leaves untracked runtimes | Partial | Unwind now runs on an uncancelled token; pidfile, pgid reclaim and boot sweep are new. Container registration is still after the fallible await, reclaim still deletes the PID record unconditionally, and `OperationCanceledException` is still outside the cleanup filter. |
| C-H10 multi-file crash windows | Partial | Update gained an `updating` marker plus boot recovery — but it flags rather than repairs, and the synchronous apply path writes no marker. Restore is unchanged, with no boot scan for orphaned `.replaced-*`. |
| C-M1 asset vendoring SSRF | Open | Unchanged. Note the feed client now sets `AllowAutoRedirect = false` with an explicit SSRF comment; the manifest/asset client does not. |
| C-M2 recovery tokens not atomic | Open | Still read-validate-mutate-then-mark from a stale snapshot. Setup path gained a re-check; recovery did not. |
| C-M3 health reconciliation overwrites | Open | The one path that took the lock still does; the two that did not, still do not. |
| C-M4 app-triggered backups bypass coordination | Open | Service-token route still calls the backup service directly, outside the app lock, with no quota. |
| C-M5 prebuilt locks name different bytes | Partial | Materialization is now staged and atomically renamed, but the hash is still computed in a separate earlier traversal of the mutable source. |
| C-M6 deadlines miss stream drainage | Partial | The pipe-FD leak was fixed (PR #141). Reads still use `CancellationToken.None` with no post-kill grace, output is still unbounded, and there is still no setup deadline or log rotation. |
| C-M7 service-token lifetime | **Partial, replay worse** | The signing key is durable now (PR #220), so restart continuity is fixed. The token still has no expiry, scope or install generation — so a leaked token is now valid forever, including across remove/reinstall, where a restart used to invalidate it. |
| C-M8 audit writes | Open | Unchanged: unsynchronized append, full-file read, no rotation, still awaited after the business commit. |
| C-M9 admin-oriented DTOs for normal users | Open | No audience DTOs. `LastError` is still raw `ex.Message`; setup failures still embed command output. |
| C-M10 internal metrics public | **Open, worse** | The endpoint went from conditionally mapped to always mapped. Ingress still publishes the Core listener with no path exclusion. |
| C-M11 incompatible lock domains | Open | No coordinator exists. Ingress gained atomic config writes, which prevents torn reads but not stale-snapshot overwrites. |
| C-M12 settings not a strict schema | Open | No unique-key or env-name validation, no reserved namespace, undeclared keys still accepted; adapter precedence still differs in opposite directions. |
| C-M13 world-writable telemetry dirs | Open | Still `0777`, now documented as deliberate. |
| C-M14 auth records unbounded | Partial | Sessions and app grants are pruned, but only on session creation. Bootstrap tokens are never pruned; authorization is still a full scan per request. |
| C-M15 catalog corruption fails open | **Obsolete** | `CatalogSourceStore`/`CatalogSourceService` were deleted by the marketplace pivot. Superseded by `AppFeedService`, which was not audited for an equivalent fail-open. |
| C-M16 HTTP policy inconsistent | Partial | CORS origin normalization is fixed; `TelemetryBackendClient` no longer exists. Exception mapping still collapses to 400/404. |
| C-L1 control secret not fixed-time | Open | Unchanged — and now inconsistent, since the trusted-proxy secret does use a fixed-time comparison. |
| C-L2 CSRF/cookie inconsistencies | Open | Unchanged. |
| A1 god classes | **Open, regressed** | `CoreLifecycleService.cs` 4,190 → 5,143; `RuntimeAppManifest.cs` 2,833 → 3,135. Net +1,195 lines across the four; no extraction seam landed. |
| A2 duplicated route registrations | Open | 21 hand-registered `/control/v1` endpoints still mirror the `/api` block. |
| A3 inconsistent persistence primitives | Open | `JsonStorage` still offers no atomic update, generation/CAS, append writer or journal. |
| A4 authorization tests are heuristics | Open | Still a regex over a hardcoded 9-file list; PATCH still unhandled; no `WebApplicationFactory`/`TestServer` suite and no such package reference. |

### What actually closed

- **The update half of C-CR1.** Apply now consumes a cached confirmed plan and applies the reviewed manifest bytes verbatim, with a base-state guard under the app lock. The double-fetch the review cited is gone, and a digest-bound feed install path was added alongside it.
- **CORS origin normalization** (half of C-M16), and the telemetry read proxy that the other half described was removed outright.
- **C-M15**, by deletion rather than by fix.

### What got worse

1. **C-M7.** Fixing restart continuity removed the accidental expiry that a per-process key provided. Closing this needs a per-install generation mixed into the token, not another key change.
2. **C-H2.** Port reservations are now part of what a reinstall destroys.
3. **C-M10.** The unauthenticated metrics endpoint is now unconditionally mapped.
4. **A1.** The god classes grew by roughly the size of a small service.

### Revised remediation order

The second-pass commentary's cost-ordering still holds, and two items became cheaper because the needed primitive now exists elsewhere in the repository:

1. **C-H6** — apply the existing owner-only file primitive to registry state, backups, logs and audit, plus a startup migration. Retires a class of findings.
2. **C-M1 and C-L1** — both are now a matter of copying an in-repo pattern: `AllowAutoRedirect = false` from the feed client, and the fixed-time comparison from the trusted-proxy secret path.
3. **C-H2** — one `409 already_installed` guard under the app lock.
4. **C-H4** — the assignment predicate already exists in the domain endpoints; it is private and unreachable from the asset route.
5. **C-CR1** — the remaining structural work: digest/plan binding for install, and persisting the reviewed artifact digest as the lock that start uses.

`hosty apps install` inherited the plan-bypassing install from the deleted catalog command, so the "CLI installs without a review" limb of C-CR1 and C-H2 survived the pivot under a new name.

---

## Critical

### C-CR1. The reviewed manifest is not bound to apply, and artifact identity is not pinned to review

**Category:** Security boundary / integrity.

**Evidence**

- Install review fetches the manifest and returns `TargetManifestDigest` in [CoreLifecycleService.cs:97-132](../../apps/core/src/Haas.Hosty.Core/CoreLifecycleService.cs#L97-L132), but [AppInstallRequest at CoreLifecycleService.cs:3911-3925](../../apps/core/src/Haas.Hosty.Core/CoreLifecycleService.cs#L3911-L3925) has no expected digest, plan digest, or server-issued plan identifier.
- Apply fetches `ManifestPath` again and immediately uses the new selection in [CoreLifecycleService.cs:135-190](../../apps/core/src/Haas.Hosty.Core/CoreLifecycleService.cs#L135-L190).
- The Shell receives the digest, but apply sends only the manifest path/runtime/settings in [shell-client.tsx:960-999](../../apps/shell/src/app/shell-client.tsx#L960-L999).
- `hosty catalog install` skips plan creation entirely and calls install directly in [CatalogCommand.cs:135-150](../../apps/cli/src/Haas.Hosty.Cli/Commands/CatalogCommand.cs#L135-L150).
- Update apply verifies a newly computed plan in [CoreLifecycleService.cs:788-794](../../apps/core/src/Haas.Hosty.Core/CoreLifecycleService.cs#L788-L794), then fetches `plan.ManifestPath` again at [CoreLifecycleService.cs:796-812](../../apps/core/src/Haas.Hosty.Core/CoreLifecycleService.cs#L796-L812) without comparing that second `selection.ManifestDigest` to the accepted plan.
- Install review does not resolve the image tag to an exact digest at all; update can include a resolved digest in descriptive plan changes, but the mutable tag is pulled/resolved again for the actual run in [RuntimeAppManifest.cs:1714-1769](../../apps/core/src/Haas.Hosty.Core/RuntimeAppManifest.cs#L1714-L1769).
- Interactive install defaults to immediate start in [LifecycleEndpoints.cs:22-37](../../apps/core/src/Haas.Hosty.Core/LifecycleEndpoints.cs#L22-L37), and `localCommand` ultimately executes through a shell in [LocalCommandRuntimeAdapter.cs:403-431](../../apps/core/src/Haas.Hosty.Core/LocalCommandRuntimeAdapter.cs#L403-L431).

**Impact**

A mutable or malicious source can return benign manifest A for review and different manifest B for apply. B can change a Docker profile into a shell command, add host networking/capabilities/devices, or change mount contracts. Independently, install authorizes only a mutable image tag, and an update-resolved digest can move again before start. The operator's explicit review is therefore not an authorization for the exact manifest and artifact bytes that Core executes.

**Recommendation**

1. Store the exact reviewed manifest bytes and resolved per-service artifact digests server-side under a random, single-use plan ID with an expiry and actor/app binding.
2. Apply must accept that plan ID, consume it atomically under the app operation lock, and use the stored manifest bytes rather than fetching the source again.
3. Persist the reviewed artifact locks before start and run images only as `repository@sha256:...`; a changed or unresolved target must require a new review.
4. Remove or explicitly gate direct install paths that bypass review. If an internal/bootstrap path must remain, model it as a separate trusted operation rather than the same public install contract.
5. Add adversarial tests where consecutive HTTP responses are A then B and image resolution returns digest A then B; apply must either execute A exactly or reject the operation.

---

## High

### C-H1. Install review omits the security-relevant behavior it is expected to authorize

**Category:** Security boundary / informed authorization.

**Evidence**

- The install plan contains identity/version/runtime/digest/settings, but not images, setup/command, capabilities, devices, host networking, bind effects, or host-exposed ports in [CoreLifecycleService.cs:114-132](../../apps/core/src/Haas.Hosty.Core/CoreLifecycleService.cs#L114-L132) and [CoreLifecycleService.cs:3996-4011](../../apps/core/src/Haas.Hosty.Core/CoreLifecycleService.cs#L3996-L4011).
- The Shell only gives a generic `localCommand` warning in [install-review-dialog.tsx:192-217](../../apps/shell/src/app/shell/dialogs/install-review-dialog.tsx#L192-L217).
- Docker applies network/capability/device grants in [RuntimeAppManifest.cs:1355-1377](../../apps/core/src/Haas.Hosty.Core/RuntimeAppManifest.cs#L1355-L1377) and [RuntimeAppManifest.cs:2168-2187](../../apps/core/src/Haas.Hosty.Core/RuntimeAppManifest.cs#L2168-L2187).
- The allowed capability set includes high-impact capabilities in [RuntimeAppManifest.cs:2610-2618](../../apps/core/src/Haas.Hosty.Core/RuntimeAppManifest.cs#L2610-L2618), while the feature documentation describes review as the safety boundary in [container-capabilities.md:88-99](../features/container-capabilities.md#L88-L99).

**Impact**

Even a static, unchanged manifest can receive materially more host access than the operator sees before Core starts it. This makes meaningful informed consent impossible and amplifies C-CR1.

**Recommendation**

Return a structured security-effects section for every service: exact image/digest, command/setup, capabilities, devices, host network, published TCP/UDP ports, data/mount bindings, and secret inputs. Require an additional acknowledgement for high-risk grants and add a contract test asserting that every privileged manifest field is represented in the plan and UI.

### C-H2. Direct install can overwrite an existing app without update semantics or stopping its runtime

**Category:** Integrity/correctness; requires an authorized install caller or client bug.

**Evidence**

- Planning recognizes `already-installed` at [CoreLifecycleService.cs:97-126](../../apps/core/src/Haas.Hosty.Core/CoreLifecycleService.cs#L97-L126).
- Apply does not enforce that state; it creates a record with `existing: null` and upserts it at [CoreLifecycleService.cs:135-190](../../apps/core/src/Haas.Hosty.Core/CoreLifecycleService.cs#L135-L190).
- Direct callers such as the catalog CLI do not perform the plan check in [CatalogCommand.cs:135-150](../../apps/cli/src/Haas.Hosty.Cli/Commands/CatalogCommand.cs#L135-L150).

**Impact**

Reinstalling a running app can reset persisted settings, mounts, source state, artifact locks, endpoints, and runtime state while the old process/container remains alive. Removed services can become orphaned, and the registry can claim `stopped` while an untracked old runtime is still serving.

**Recommendation**

Inside the app lock, reject install with `409 already_installed` whenever a record exists. Provide an explicit update/reinstall operation with stop, backup, state-preservation/migration rules, and a reviewed diff. Add a direct-API regression test against a configured running app.

### C-H3. External mount policy is bypassable through ancestor symlinks and a check/use race

**Category:** Filesystem isolation.

**Evidence**

- `ResolveRealPath` resolves only the final `DirectoryInfo` link and fails open to the lexical path on errors in [MountPathPolicy.cs:43-82](../../apps/core/src/Haas.Hosty.Core/MountPathPolicy.cs#L43-L82).
- Start repeats the same check at [CoreLifecycleService.cs:2281-2313](../../apps/core/src/Haas.Hosty.Core/CoreLifecycleService.cs#L2281-L2313).
- The context retains the original host path in [CoreLifecycleService.cs:2204-2231](../../apps/core/src/Haas.Hosty.Core/CoreLifecycleService.cs#L2204-L2231), and Docker later mounts that path in [RuntimeAppManifest.cs:1463-1469](../../apps/core/src/Haas.Hosty.Core/RuntimeAppManifest.cs#L1463-L1469).

**Impact**

`/allowed/link/subdir`, where `link` points into the Hosty data root or a denied system directory, may pass because the final component is not itself a link. A writable link can also be swapped after validation but before `docker run`. A container can then receive Core auth state, backups, other apps' data, or sensitive host files that the policy explicitly intends to deny.

**Recommendation**

Canonicalize every path component, fail closed on resolution errors, capture the canonical path, and pass that exact value to the runtime adapter. On Unix, prefer a no-follow/openat2-style primitive or constrain mounts to operator-owned roots whose ancestry cannot be changed by the app. Test ancestor links and a barrier-controlled link swap between validation and runtime invocation.

### C-H4. The asset endpoint is an IDOR over any allowlisted file in an app root

**Category:** Authorization / confidentiality.

**Evidence**

- Any authenticated session is accepted without checking the app record or assignment in [AppAssetEndpoints.cs:30-46](../../apps/core/src/Haas.Hosty.Core/AppAssetEndpoints.cs#L30-L46).
- Resolution accepts any existing `.md` or allowlisted image path under the app root in [AppAssetEndpoints.cs:93-113](../../apps/core/src/Haas.Hosty.Core/AppAssetEndpoints.cs#L93-L113).
- App runtime data is stored under the same `apps/<id>/data` root in [AppBackupService.cs:540-550](../../apps/core/src/Haas.Hosty.Core/AppBackupService.cs#L540-L550).
- Normal app listing does enforce assignment filtering in [DomainEndpoints.cs:60-79](../../apps/core/src/Haas.Hosty.Core/DomainEndpoints.cs#L60-L79).
- Link resolution fails open and does not canonicalize ancestor directories in [AppAssetEndpoints.cs:115-135](../../apps/core/src/Haas.Hosty.Core/AppAssetEndpoints.cs#L115-L135).
- Any `?v` query switches the authenticated response to public immutable caching in [AppAssetEndpoints.cs:76-87](../../apps/core/src/Haas.Hosty.Core/AppAssetEndpoints.cs#L76-L87).

**Impact**

A regular user can request `/api/apps/{appId}/assets/data/uploads/private.jpg` from an unassigned app (`assetPath` is `data/uploads/private.jpg`). Uninstalled/stale app directories remain addressable, and an intermediate symlink or resolution failure can extend the read boundary beyond the intended asset directory.

**Recommendation**

Store vendored assets under a dedicated, immutable, digest-scoped directory. Serve only an allowlist derived from the currently installed manifest; require the app to exist; and apply the same app-access policy as listing/opening. Resolve/open files with no-follow semantics and fail closed. Make authenticated caching private, not `public`, unless the endpoint is intentionally made public.

### C-H5. Parallel login requests bypass throttling and amplify PBKDF2 into a CPU denial of service

**Category:** Authentication availability / brute-force control.

**Evidence**

- Password verification uses 600,000 PBKDF2 iterations in [LocalPasswordAuthService.cs:11-27](../../apps/core/src/Haas.Hosty.Core/LocalPasswordAuthService.cs#L11-L27).
- Throttling is checked before the synchronous KDF, while a failure is registered only after it completes in [LocalPasswordAuthService.cs:57-101](../../apps/core/src/Haas.Hosty.Core/LocalPasswordAuthService.cs#L57-L101).
- Check and registration are separate lock sections in [LocalPasswordAuthService.cs:174-201](../../apps/core/src/Haas.Hosty.Core/LocalPasswordAuthService.cs#L174-L201).
- The authentication path does not apply the create-password length limit before UTF-8 conversion/KDF in [LocalPasswordAuthService.cs:117-167](../../apps/core/src/Haas.Hosty.Core/LocalPasswordAuthService.cs#L117-L167).
- Forwarded headers are trusted before login in [HostyCoreApplication.cs:95-108](../../apps/core/src/Haas.Hosty.Core/HostyCoreApplication.cs#L95-L108), and the throttle key uses the rewritten remote IP in [HostyCoreApplication.cs:176-193](../../apps/core/src/Haas.Hosty.Core/HostyCoreApplication.cs#L176-L193). A host-network app can share the host network namespace in [RuntimeAppManifest.cs:1355-1363](../../apps/core/src/Haas.Hosty.Core/RuntimeAppManifest.cs#L1355-L1363), so a local/host-network caller can also spoof `X-Forwarded-For` unless proxy trust is narrowed.

**Impact**

A sufficiently concurrent unauthenticated burst can have many or all requests admitted before the first failure is recorded, causing them to run the expensive KDF concurrently and exhaust CPU/thread-pool capacity. The dummy credential intentionally makes the same cost available for nonexistent accounts; very large password bodies add allocation pressure. A limiter based only on the post-forwarding IP remains bypassable by a caller inside the trusted proxy boundary.

**Recommendation**

Apply request/body limits before parsing, ASP.NET rate/concurrency limiting before the KDF, an atomic admission reservation per IP+email, and a global bounded KDF semaphore/worker. Preserve/rate-limit by the original peer, and trust forwarding headers only from a dedicated, authenticated proxy boundary rather than every loopback/host-network caller. Return `Retry-After`; consider durable/distributed throttling if multiple Core instances ever become supported. Add parallel burst, forged-forwarded-header, and oversized-body tests.

### C-H6. App secrets, backups, logs, and audit records are created with permissive filesystem modes

**Category:** Local-host confidentiality.

**Evidence**

- App registry state is written through the default writer in [AppRegistryStore.cs:110-120](../../apps/core/src/Haas.Hosty.Core/AppRegistryStore.cs#L110-L120); the record contains setting values and secret flags in [AppRegistryStore.cs:196-213](../../apps/core/src/Haas.Hosty.Core/AppRegistryStore.cs#L196-L213) and [AppRegistryStore.cs:295-298](../../apps/core/src/Haas.Hosty.Core/AppRegistryStore.cs#L295-L298).
- Default `JsonStorage` creates ordinary directories/files; owner-only restriction is opt-in in [JsonStorage.cs:72-101](../../apps/core/src/Haas.Hosty.Core/JsonStorage.cs#L72-L101).
- Backup archives and metadata are created normally in [AppBackupService.cs:25-60](../../apps/core/src/Haas.Hosty.Core/AppBackupService.cs#L25-L60).
- Runtime logs and audit entries use ordinary append/create paths in [LocalCommandRuntimeAdapter.cs:72-77](../../apps/core/src/Haas.Hosty.Core/LocalCommandRuntimeAdapter.cs#L72-L77) and [AuditStore.cs:7-16](../../apps/core/src/Haas.Hosty.Core/AuditStore.cs#L7-L16).
- A correct private-file pattern already exists in [SecureFileSystem.cs:8-32](../../apps/core/src/Haas.Hosty.Core/SecureFileSystem.cs#L8-L32) and is used for retained secrets in [CoreLifecycleService.cs:2880-2886](../../apps/core/src/Haas.Hosty.Core/CoreLifecycleService.cs#L2880-L2886).

**Impact**

On a multi-user host, another OS user or group member may read application credentials, service output, audit identities, and complete backup snapshots. A mode-only inspection on the current development host found existing app state/backup files at `0644` and containing directories at `0755`.

**Recommendation**

Create Core-owned roots and app/backups/log directories as `0700`, sensitive files/archives as `0600`, and apply equivalent restricted ACLs on Windows. Create ZIP output through a private `FileStream`, do not rely on umask, and add a startup permission audit/migration for existing data. Add Unix mode and Windows ACL integration tests.

### C-H7. Two Core processes can concurrently mutate the same data root

**Category:** Operational integrity; requires a second Core process or service misconfiguration.

**Evidence**

- Startup binds the configured URL but takes no data-root lease in [HostyCoreApplication.cs:16-24](../../apps/core/src/Haas.Hosty.Core/HostyCoreApplication.cs#L16-L24).
- Lifecycle/store locks are in-memory and process-local, for example [CoreLifecycleService.cs:61-82](../../apps/core/src/Haas.Hosty.Core/CoreLifecycleService.cs#L61-L82) and [AppRegistryStore.cs:8-124](../../apps/core/src/Haas.Hosty.Core/AppRegistryStore.cs#L8-L124).
- The discovery hosted service writes the shared `control.json` path rather than acting as an exclusive lease in [HostyCoreApplication.cs:1562-1620](../../apps/core/src/Haas.Hosty.Core/HostyCoreApplication.cs#L1562-L1620).

**Impact**

Two instances on different ports with the same `HOSTY_DATA_ROOT` can pass startup, lose JSON updates, issue incompatible ephemeral service credentials, race backup/restore/delete, and both start/stop/remove the same containers or host processes.

**Recommendation**

Acquire and hold an exclusive data-root lock file before registering hosted services or mutating discovery/state. Store diagnostic PID/start/endpoint metadata and fail the second instance clearly. Add an integration test starting two hosts with one data root and different ports; the second must fail before any side effect.

### C-H8. Docker resources are identified by collision-prone names and ownership checks are inconsistent

**Category:** Cross-app/runtime isolation.

**Evidence**

- Docker name normalization maps `.`, `_`, and `-` to the same `-` representation in [RuntimeAppManifest.cs:2035-2039](../../apps/core/src/Haas.Hosty.Core/RuntimeAppManifest.cs#L2035-L2039) and [RuntimeAppManifest.cs:2274-2278](../../apps/core/src/Haas.Hosty.Core/RuntimeAppManifest.cs#L2274-L2278).
- Stop blindly targets the derived container name before any owner-label validation in [RuntimeAppManifest.cs:1513-1536](../../apps/core/src/Haas.Hosty.Core/RuntimeAppManifest.cs#L1513-L1536).
- Label validation exists only on a removal helper in [RuntimeAppManifest.cs:1787-1811](../../apps/core/src/Haas.Hosty.Core/RuntimeAppManifest.cs#L1787-L1811).
- Networks use the normalized app ID, tolerate an existing network, attach containers to it, and later remove it without an ownership check in [RuntimeAppManifest.cs:1299-1306](../../apps/core/src/Haas.Hosty.Core/RuntimeAppManifest.cs#L1299-L1306), [RuntimeAppManifest.cs:1364-1371](../../apps/core/src/Haas.Hosty.Core/RuntimeAppManifest.cs#L1364-L1371), and [RuntimeAppManifest.cs:1539-1548](../../apps/core/src/Haas.Hosty.Core/RuntimeAppManifest.cs#L1539-L1548).
- Docker command/inspect failures are collapsed into absence in [RuntimeAppManifest.cs:1772-1817](../../apps/core/src/Haas.Hosty.Core/RuntimeAppManifest.cs#L1772-L1817).

**Impact**

IDs such as `com.foo.a-b` and `com.foo.a.b` can share a network, exposing unpublished service ports and aliases across apps. Stopping one colliding app can stop another app's or a user's container. If the daemon is unavailable, remove can report success and delete state/data while a container continues running.

**Recommendation**

Use an unambiguous name plus a hash of the original app/service identity. Label networks and containers with immutable owner/generation identifiers; perform stop/log/inspect/remove by stored container ID or verified labels. Model inspection as `owned | not found | foreign | error` and fail closed on `error`. Test colliding IDs, foreign resources, and unavailable-daemon behavior for every verb.

### C-H9. Cancellation and reclaim failures can leave untracked host processes or containers

**Category:** Runtime integrity/availability; requires cancellation, process-control failure, or persistence failure near a side-effect boundary.

**Evidence**

- Core marks `runtimeStarted` only after the adapter returns and its cleanup catch excludes cancellation/non-recordable persistence failures in [CoreLifecycleService.cs:592-653](../../apps/core/src/Haas.Hosty.Core/CoreLifecycleService.cs#L592-L653) and [CoreLifecycleService.cs:677-715](../../apps/core/src/Haas.Hosty.Core/CoreLifecycleService.cs#L677-L715).
- Docker records a container for unwind only after the `docker run` process returns in [RuntimeAppManifest.cs:1471-1474](../../apps/core/src/Haas.Hosty.Core/RuntimeAppManifest.cs#L1471-L1474), although the daemon can create it before CLI cancellation/disconnect.
- The local-command adapter registers a process in memory before writing the durable PID file in [LocalCommandRuntimeAdapter.cs:127-141](../../apps/core/src/Haas.Hosty.Core/LocalCommandRuntimeAdapter.cs#L127-L141); cancellation during that write leaves only process-memory bookkeeping and stale persisted app state.
- Local-command reclaim unconditionally deletes the PID record in `finally` in [LocalCommandProcessReclaim.cs:63-70](../../apps/core/src/Haas.Hosty.Core/LocalCommandProcessReclaim.cs#L63-L70), while kill/wait failures are swallowed or reduced to a timeout in [LocalCommandProcessReclaim.cs:90-133](../../apps/core/src/Haas.Hosty.Core/LocalCommandProcessReclaim.cs#L90-L133) and [LocalCommandProcessReclaim.cs:173-205](../../apps/core/src/Haas.Hosty.Core/LocalCommandProcessReclaim.cs#L173-L205).

**Impact**

Client disconnect, state-write error, CLI cancellation, `EPERM`, or a stubborn process can leave a running runtime with stale persisted state and missing durable cleanup bookkeeping. A local command can remain reachable through the in-memory registry during the same process, but becomes fully untracked after an abrupt Core exit without its PID file. Docker and partial multi-service runtimes can similarly survive the registration window.

**Recommendation**

Register a compensating resource before the first fallible await after process/container creation. Catch all failures after a side effect, run bounded cleanup with a non-cancelled internal token, then rethrow the original error. Keep PID/container ownership records until absence or foreign ownership is positively verified, and return explicit reclaim outcomes for retry. Add fault injection at every creation/persistence boundary.

### C-H10. Multi-file lifecycle and restore mutations have crash windows without recovery

**Category:** Durability/correctness; requires a crash or I/O failure between committed phases.

**Evidence**

- Update writes the new internal manifest before committing the matching app record in [CoreLifecycleService.cs:788-833](../../apps/core/src/Haas.Hosty.Core/CoreLifecycleService.cs#L788-L833); live reconciliation has the same multi-file pattern in [CoreLifecycleService.cs:2677-2715](../../apps/core/src/Haas.Hosty.Core/CoreLifecycleService.cs#L2677-L2715).
- Restore moves live data to a generated `.replaced-*` directory and then promotes staging, but has no durable journal/startup recovery in [AppBackupService.cs:145-179](../../apps/core/src/Haas.Hosty.Core/AppBackupService.cs#L145-L179).

**Impact**

A crash/cancellation between manifest and registry writes can leave version/settings/runtime metadata inconsistent with the manifest Core subsequently loads. A crash between restore moves leaves the canonical app data path absent until manual intervention, even though the prior data may still exist under an implementation-specific temporary name.

**Recommendation**

Use versioned immutable manifest/data generations with one atomically replaced pointer, or a durable operation journal with startup recovery. For restore, record source/staging/replaced paths and phase before each move, fsync the journal/directory where required, and repair every partial state on boot. Add crash-point tests for every phase.

---

## Medium

### C-M1. Asset vendoring can fetch internal URLs or copy files through symlinks

**Category:** Security hardening / information disclosure. Exploitation requires an administrator to apply an attacker-controlled manifest or source; the app content is already being placed in a trusted execution workflow.

**Evidence**

- Remote assets are restricted only by the initial URL prefix, then fetched using a default redirect-following `HttpClient` in [RuntimeAppManifest.cs:239-292](../../apps/core/src/Haas.Hosty.Core/RuntimeAppManifest.cs#L239-L292).
- The final response URI/address is never revalidated after redirects.
- Local asset reads perform lexical containment, then follow normal filesystem resolution in [RuntimeAppManifest.cs:214-236](../../apps/core/src/Haas.Hosty.Core/RuntimeAppManifest.cs#L214-L236).
- Vendored bytes are written under attacker-chosen relative paths beneath the entire app root in [RuntimeAppManifest.cs:295-310](../../apps/core/src/Haas.Hosty.Core/RuntimeAppManifest.cs#L295-L310), including reserved namespaces such as `data/`, `logs/`, and `run/`.

**Impact**

A remote asset URL can redirect Core to loopback, link-local/cloud metadata, or an internal service and then expose the returned bytes through the authenticated asset endpoint. A local/source repository can use symlinks to copy Core-readable host files. Crafted asset paths can also overwrite runtime-owned files with an allowed extension.

**Recommendation**

Disable automatic redirects and validate every hop's scheme, host, resolved IP, and port; block loopback/private/link-local ranges unless explicitly allowed. Reject filesystem links component-by-component. Vendor only to a reserved asset root, validate decoded content rather than extension alone, atomically replace the complete asset set, and remove stale files. Add redirect-to-loopback, DNS rebinding, ancestor-link, and reserved-path tests.

### C-M2. Recovery tokens can be consumed more than once concurrently

**Category:** Authentication integrity. Exploitation requires possession of the high-privilege recovery bearer token; the defect breaks its single-use guarantee rather than granting privilege without that token.

**Evidence**

- `AuthBootstrapTokenStore` exposes only unsynchronized read/write operations in [AuthBootstrapService.cs:6-16](../../apps/core/src/Haas.Hosty.Core/AuthBootstrapService.cs#L6-L16).
- Recovery validates a pending token, mutates the privileged user/password state, and only afterwards marks the token used in [AuthBootstrapService.cs:122-176](../../apps/core/src/Haas.Hosty.Core/AuthBootstrapService.cs#L122-L176).
- `MarkTokenUsedAsync` writes from the stale snapshot originally read by the caller in [AuthBootstrapService.cs:217-229](../../apps/core/src/Haas.Hosty.Core/AuthBootstrapService.cs#L217-L229).
- Token issuance is another unsynchronized read-modify-write in [AuthBootstrapService.cs:180-200](../../apps/core/src/Haas.Hosty.Core/AuthBootstrapService.cs#L180-L200).

**Impact**

Two concurrent requests with the same recovery token can both pass validation and reset/promote different accounts or race passwords for the same account. Concurrent issuance/consumption can also lose token state.

**Recommendation**

Implement a serialized/transactional token-store `TryConsumeAsync` that performs a single pending→consumed transition before the privileged mutation and never writes a stale snapshot. If the user mutation can fail, model reservation/commit explicitly. Add a barrier plus `Task.WhenAll` test proving exactly one success for a shared token.

### C-M3. Health reconciliation can overwrite a newer lifecycle result with stale observation

Summary/supervisor health paths load, probe, and write without the per-app operation lock in [CoreLifecycleService.cs:3643-3690](../../apps/core/src/Haas.Hosty.Core/CoreLifecycleService.cs#L3643-L3690), [CoreLifecycleService.cs:3713-3735](../../apps/core/src/Haas.Hosty.Core/CoreLifecycleService.cs#L3713-L3735), and [CoreLifecycleService.cs:3792-3835](../../apps/core/src/Haas.Hosty.Core/CoreLifecycleService.cs#L3792-L3835). The reverse Docker sweep correctly takes that lock in [CoreLifecycleService.cs:3770-3788](../../apps/core/src/Haas.Hosty.Core/CoreLifecycleService.cs#L3770-L3788). A valid race is: stale record=`running`, a delayed probe observes `stopped`/`unknown`, a concurrent Start or Restart commits `running`, then reconciliation writes its stale observation. Use the same operation coordinator or a persisted generation/CAS and re-read intent before commit; add barrier-based lifecycle/probe tests.

### C-M4. App-triggered backups bypass lifecycle coordination and can exhaust CPU/disk

The service-token route calls `AppBackupService` directly in [AppBackupEndpoints.cs:13-56](../../apps/core/src/Haas.Hosty.Core/AppBackupEndpoints.cs#L13-L56). Creation performs synchronous full-directory compression/counting without a lock, quota, or cancellable worker in [AppBackupService.cs:25-65](../../apps/core/src/Haas.Hosty.Core/AppBackupService.cs#L25-L65), while remove/restore/delete touch the same roots. Parallel calls can create multiple full ZIPs before retention, race removal/restore, and leave orphan archives on failure. Put all app data/backup operations under the shared app coordinator, enforce size/free-space/concurrency quotas, write a private temporary archive, and atomically publish only after metadata/hash succeeds.

### C-M5. Prebuilt artifact locks can name bytes different from the materialized bytes

`PrebuiltArtifactStore` hashes a mutable source tree and copies it in a second traversal in [PrebuiltArtifactStore.cs:48-68](../../apps/core/src/Haas.Hosty.Core/PrebuiltArtifactStore.cs#L48-L68) and [PrebuiltArtifactStore.cs:84-158](../../apps/core/src/Haas.Hosty.Core/PrebuiltArtifactStore.cs#L84-L158). Enumeration ignores inaccessible entries, and the source can change between traversals, so the bytes stored under a `BundleHash` can differ from the bytes that produced it. Absolute delivery paths are intentionally supported by the documented contract in [runtime-app-manifest.md:114](../features/runtime-app-manifest.md#L114), so source-root containment would be a separate breaking policy decision rather than part of this fix. Copy to staging first, fail on unreadable input, hash the completed staging tree, then atomically rename by that hash. Mutation and unreadable-entry tests should prove the recorded lock identifies the exact executed tree.

### C-M6. Process deadlines do not cover stream drainage and output is unbounded

`ProcessRunner` applies its deadline to `WaitForExitAsync`, but stdout/stderr reads use `CancellationToken.None` and are awaited without a bounded post-kill grace in [ProcessRunner.cs:35-76](../../apps/core/src/Haas.Hosty.Core/ProcessRunner.cs#L35-L76). A descendant retaining inherited pipes or a failed kill can outlive the deadline; `ReadToEndAsync` buffers arbitrary output. Local-command setup streams incrementally and keeps only a 15-line memory tail, but it has no independent setup deadline in [LocalCommandRuntimeAdapter.cs:150-260](../../apps/core/src/Haas.Hosty.Core/LocalCommandRuntimeAdapter.cs#L150-L260); its on-disk logs grow indefinitely and tail reads scan the full file in [LocalCommandRuntimeAdapter.cs:278-311](../../apps/core/src/Haas.Hosty.Core/LocalCommandRuntimeAdapter.cs#L278-L311). Use bounded streaming/ring buffers in `ProcessRunner`, a deadline covering process plus drains, a short post-kill grace followed by pipe disposal, and output truncation metadata. Separately add a setup timeout plus log rotation and tail-from-end tests.

### C-M7. App service-token lifetime is coupled to the Core process, not an app installation

App service tokens are deterministic HMACs of app ID under a per-process secret in [AppServiceTokenService.cs:6-50](../../apps/core/src/Haas.Hosty.Core/AppServiceTokenService.cs#L6-L50), and the secret is regenerated during Core startup in [HostyCoreApplication.cs:20-25](../../apps/core/src/Haas.Hosty.Core/HostyCoreApplication.cs#L20-L25). Tokens have no expiry, scope, or install generation. Running workloads survive a Core restart with now-invalid tokens; conversely, a stolen token becomes valid again after remove/reinstall of the same ID within the same Core process. Use a persistent rotatable signing key plus random per-install generation/credential, expiry/audience/scopes, hash-only storage, and explicit rotation/revocation on start/remove/reinstall. Test both restart continuity and old-token replay rejection.

### C-M8. Audit writes are unsynchronized, unbounded, and can fail after the business commit

`AuditStore` appends concurrently without a single writer and reads/parses the entire unbounded file in [AuditStore.cs:7-33](../../apps/core/src/Haas.Hosty.Core/AuditStore.cs#L7-L33). Many operations commit state and then await audit; recovery is one example in [AuthBootstrapService.cs:134-176](../../apps/core/src/Haas.Hosty.Core/AuthBootstrapService.cs#L134-L176). An audit I/O error can return failure after a successful privileged mutation, causing unsafe retries; concurrent/torn NDJSON can break later reads. Use a serialized channel/single writer, explicit best-effort or transactional-outbox semantics, rotation/retention, private permissions, and per-line tolerant tail reading.

### C-M9. Normal users receive admin-oriented paths and raw lifecycle error text

`/api/apps` filters rows by assignment but returns the same `AppSummary` to every role in [DomainEndpoints.cs:10-26](../../apps/core/src/Haas.Hosty.Core/DomainEndpoints.cs#L10-L26) and [DomainEndpoints.cs:60-79](../../apps/core/src/Haas.Hosty.Core/DomainEndpoints.cs#L60-L79). The DTO carries `LastError` and related status at [AppRegistryStore.cs:553-566](../../apps/core/src/Haas.Hosty.Core/AppRegistryStore.cs#L553-L566), source/managed host paths at [AppRegistryStore.cs:590-617](../../apps/core/src/Haas.Hosty.Core/AppRegistryStore.cs#L590-L617), and mount host paths at [AppRegistryStore.cs:736-763](../../apps/core/src/Haas.Hosty.Core/AppRegistryStore.cs#L736-L763). Setup failures embed command output in exceptions in [LocalCommandRuntimeAdapter.cs:182-256](../../apps/core/src/Haas.Hosty.Core/LocalCommandRuntimeAdapter.cs#L182-L256), and lifecycle state persists `ex.Message` into `LastError` in [CoreLifecycleService.cs:1690-1737](../../apps/core/src/Haas.Hosty.Core/CoreLifecycleService.cs#L1690-L1737). A command that prints a setting/service token can expose it to a regular assigned user. Define role/audience-specific DTOs, persist a stable public error code plus sanitized text, redact known secret values, and keep raw stderr/paths in admin-only diagnostics.

### C-M10. With observability and managed cloudflared ingress enabled, internal metrics become public

When observability is enabled, `/internal/telemetry/metrics` is deliberately unauthenticated in [LifecycleEndpoints.cs:409-419](../../apps/core/src/Haas.Hosty.Core/LifecycleEndpoints.cs#L409-L419) and reveals app/service CPU/memory inventory from [DockerStatsExposition.cs:64-113](../../apps/core/src/Haas.Hosty.Core/DockerStatsExposition.cs#L64-L113). When managed cloudflared ingress is also configured and reachable, it publishes that same Core listener without a path exclusion in [CloudflareIngress.cs:170-187](../../apps/core/src/Haas.Hosty.Core/CloudflareIngress.cs#L170-L187). Put scrape traffic on a separate loopback-only listener or require a dedicated service credential/mTLS, and test that `/internal` is not routable through the public origin.

**Fixed 2026-07-24 (credential half).** The endpoint moved to `/api/internal/telemetry/metrics` and now requires an app service token, like every other app→Core route; the telemetry backend presents its own `HOSTY_APP_SERVICE_TOKEN` when scraping (and only to Core — never to the third-party collector). The old unauthenticated path is gone. The `/api/internal/` prefix also brings it inside the endpoint-authorization harness, which enumerates `/api` routes and had no view of `/internal`.

The routing half is deliberately **not** fixed, and was reframed rather than deferred: Hosty's ingress rules are `hostname` → `service` with no path support, so a published Core origin exposes *every* route — `/api/internal/apps/...` included. Path exclusion is therefore not a gap specific to this endpoint but a possible extra layer for all of them, tracked as [internal-endpoint-exposure](../features/internal-endpoint-exposure/plan.md). Credentials remain the actual boundary.

### C-M11. Source, mount-library, and ingress operations use incompatible lock domains

- Source routes call `AppSourceService` outside the lifecycle app lock in [SourceEndpoints.cs:7-43](../../apps/core/src/Haas.Hosty.Core/SourceEndpoints.cs#L7-L43), while source checkout/state mutations span multiple awaits in [AppSourceService.cs:15-110](../../apps/core/src/Haas.Hosty.Core/AppSourceService.cs#L15-L110) and [AppSourceService.cs:129-230](../../apps/core/src/Haas.Hosty.Core/AppSourceService.cs#L129-L230).
- Global mount deletion checks usage and then deletes under a different lock from per-app configure in [GlobalMountService.cs:60-88](../../apps/core/src/Haas.Hosty.Core/GlobalMountService.cs#L60-L88) and [CoreLifecycleService.cs:486-510](../../apps/core/src/Haas.Hosty.Core/CoreLifecycleService.cs#L486-L510).
- Ingress reconciliation builds and writes one global config without a global serialization point in [CoreLifecycleService.cs:3544-3559](../../apps/core/src/Haas.Hosty.Core/CoreLifecycleService.cs#L3544-L3559) and [CloudflareIngress.cs:69-106](../../apps/core/src/Haas.Hosty.Core/CloudflareIngress.cs#L69-L106).

These races can record one source commit while another checkout is present, retain a binding to a just-deleted shared mount, or let an older ingress snapshot erase newer routes. Introduce one `IAppOperationCoordinator` plus a global ingress generation/gate; re-read authoritative state immediately before commit and add deliberate interleaving tests.

### C-M12. Manifest settings are not a strict schema boundary

The manifest selection/validation path in [RuntimeAppManifest.cs:339-626](../../apps/core/src/Haas.Hosty.Core/RuntimeAppManifest.cs#L339-L626) does not enforce unique setting keys, environment-name syntax, or a reserved namespace; the setting model itself is at [RuntimeAppManifest.cs:2719-2732](../../apps/core/src/Haas.Hosty.Core/RuntimeAppManifest.cs#L2719-L2732). Building definitions uses `ToDictionary`, so duplicates become runtime exceptions in [CoreLifecycleService.cs:3562-3579](../../apps/core/src/Haas.Hosty.Core/CoreLifecycleService.cs#L3562-L3579). Request merge accepts undeclared keys and marks them non-secret in [CoreLifecycleService.cs:3582-3599](../../apps/core/src/Haas.Hosty.Core/CoreLifecycleService.cs#L3582-L3599); Docker and local-command environment precedence also differs. Enforce a unique strict schema, reject unknown client keys except explicit Core-generated settings, reserve `HOSTY_*`/runtime-owned names, and define one precedence model across adapters.

### C-M13. System-app telemetry directories are deliberately world-writable

Core sets selected system-app data subdirectories to `0777` in [CoreLifecycleService.cs:2850-2872](../../apps/core/src/Haas.Hosty.Core/CoreLifecycleService.cs#L2850-L2872). This lets any local OS user tamper with collector output or telemetry database content and combines poorly with the ordinary file modes in C-H6. Provision ownership for the container UID or a narrow shared group and use `0700/0600` or, where sharing is required, `0770/0660`; validate the resulting ownership/mode at startup.

### C-M14. Authentication records grow without retention and are scanned from JSON state

Sessions are appended or revoked but not pruned in [AuthEndpoints.cs:207-259](../../apps/core/src/Haas.Hosty.Core/AuthEndpoints.cs#L207-L259), and authorization rereads/scans the state in [CoreSessionAuthorization.cs:100-123](../../apps/core/src/Haas.Hosty.Core/CoreSessionAuthorization.cs#L100-L123). Bootstrap-token histories similarly append in [AuthBootstrapService.cs:180-200](../../apps/core/src/Haas.Hosty.Core/AuthBootstrapService.cs#L180-L200). Add bounded retention for expired/revoked/used records, prune opportunistically under atomic store updates, and consider an indexed persistence model if session volume grows.

### C-M15. Catalog-source corruption fails open to the environment default

`CatalogSourceStore` turns corrupt, unreadable, or locked state into `null` in [CatalogSourceStore.cs:16-29](../../apps/core/src/Haas.Hosty.Core/CatalogSourceStore.cs#L16-L29), and the service interprets `null` as “use the environment-seeded default” in [CatalogSourceService.cs:17-23](../../apps/core/src/Haas.Hosty.Core/CatalogSourceService.cs#L17-L23) and [CatalogSourceService.cs:75-80](../../apps/core/src/Haas.Hosty.Core/CatalogSourceService.cs#L75-L80). A permission glitch or corrupt file can silently reverse an operator's removal/disable decision. Distinguish missing from corrupt/unreadable state, fail closed for an existing bad file, preserve/recover a last-good copy, and surface a health warning.

### C-M16. HTTP policy/error behavior is difficult for clients to reason about

Lifecycle exceptions with different meanings are broadly mapped to client errors in [LifecycleEndpoints.cs:813-836](../../apps/core/src/Haas.Hosty.Core/LifecycleEndpoints.cs#L813-L836); telemetry backend timeout/non-2xx/invalid JSON collapses to `null` in [TelemetryBackendClient.cs:43-66](../../apps/core/src/Haas.Hosty.Core/TelemetryBackendClient.cs#L43-L66), producing a successful empty response instead of “backend unavailable.” Public-origin configuration is passed to CORS without the normalization helper in [HostyCoreApplication.cs:85-93](../../apps/core/src/Haas.Hosty.Core/HostyCoreApplication.cs#L85-L93). Centralize exception-to-ProblemDetails mapping (`400/404/409/424/502/503`, opaque `500` with correlation ID), expose degraded dependency state explicitly, and canonicalize origins at startup.

---

## Low / hardening

### C-L1. Control-secret comparison is not fixed-time

The control-secret path uses ordinary string equality in [HostyCoreApplication.cs:263-282](../../apps/core/src/Haas.Hosty.Core/HostyCoreApplication.cs#L263-L282), while other token paths use cryptographic comparison. Require exactly 64 hexadecimal characters, decode both values to 32-byte spans (reject malformed input), and use `CryptographicOperations.FixedTimeEquals`; alternatively hash both inputs to fixed-size digests before comparison. The secret is high entropy and normally local, so this is defense-in-depth rather than a demonstrated remote exploit.

### C-L2. CSRF/cookie handling has avoidable inconsistencies

The CSRF cookie is emitted with `Secure = false` in [AuthEndpoints.cs:13-23](../../apps/core/src/Haas.Hosty.Core/AuthEndpoints.cs#L13-L23), and logout paths do not require a session-bound CSRF check in [AuthEndpoints.cs:92-96](../../apps/core/src/Haas.Hosty.Core/AuthEndpoints.cs#L92-L96) and [HostyCoreApplication.cs:232-242](../../apps/core/src/Haas.Hosty.Core/HostyCoreApplication.cs#L232-L242). Mirror the session cookie's HTTPS behavior and require POST+CSRF for logout; retain GET only as a compatibility redirect without state mutation.

---

## Structural code-quality findings

### A1. Core has several mixed-responsibility god classes

At this baseline, `CoreLifecycleService.cs` is 4,190 lines, `RuntimeAppManifest.cs` 2,833, `HostyCoreApplication.cs` 1,863, and `LifecycleEndpoints.cs` 842. `CoreLifecycleService` combines lifecycle orchestration, planning/diffing, source preparation, telemetry proxying, backup coordination, mount validation, health reconciliation, supervision, and DTO construction. Natural extraction seams are an immutable plan service, `IAppOperationCoordinator`, runtime state reconciler, telemetry query service, source coordinator, and audience DTO mappers.

### A2. Browser and control endpoint registrations are hand-duplicated

`LifecycleEndpoints` repeats `/api` and `/control/v1` registrations across [LifecycleEndpoints.cs:7-526](../../apps/core/src/Haas.Hosty.Core/LifecycleEndpoints.cs#L7-L526) and [LifecycleEndpoints.cs:528-798](../../apps/core/src/Haas.Hosty.Core/LifecycleEndpoints.cs#L528-L798). This has already created review/authorization drift in earlier revisions. Map one handler/policy to both routes through a shared route-group abstraction; keep differences explicit rather than copying endpoint bodies.

### A3. Persistence guarantees vary by store and multi-file operation

Some state stores offer atomic updates and private files; others offer only read/write, append, or several independently atomic files. The result is a system where each caller must remember serialization, stale-snapshot avoidance, permissions, audit semantics, and cross-file recovery. Standardize on a small set of persistence primitives: atomic `UpdateAsync`, explicit file classification/permissions, generation/CAS, append-log writer, and journaled multi-file transaction.

### A4. Authorization guard tests are source-text heuristics, not HTTP policy tests

The current guard lists selected endpoint files manually and parses only a subset of mutation verbs in [EndpointAuthorizationTests.cs:13-66](../../apps/core/tests/Haas.Hosty.Core.Tests/EndpointAuthorizationTests.cs#L13-L66). It omits newer endpoint groups and can miss PATCH, service-token, public, or incorrectly mapped routes. No `WebApplicationFactory`/`TestServer` integration suite was found. Enumerate `EndpointDataSource` metadata, maintain an explicit public/service-token allowlist, and run HTTP tests for authentication, role, assignment, CSRF, CORS, content type, and error contracts.

---

## Positive controls observed

- Session identifiers use 32 random bytes; the cookie is `HttpOnly` and `SameSite=Lax` in [AuthEndpoints.cs:191-233](../../apps/core/src/Haas.Hosty.Core/AuthEndpoints.cs#L191-L233).
- Password verification uses a dummy credential against account enumeration and fixed-time hash comparison in [LocalPasswordAuthService.cs:20-27](../../apps/core/src/Haas.Hosty.Core/LocalPasswordAuthService.cs#L20-L27) and [LocalPasswordAuthService.cs:130-145](../../apps/core/src/Haas.Hosty.Core/LocalPasswordAuthService.cs#L130-L145).
- User-directory mutations have a serialized atomic update primitive in [UserDirectoryStore.cs:20-44](../../apps/core/src/Haas.Hosty.Core/UserDirectoryStore.cs#L20-L44).
- JSON state writes use temp-and-rename and can opt into owner restriction in [JsonStorage.cs:72-101](../../apps/core/src/Haas.Hosty.Core/JsonStorage.cs#L72-L101).
- Docker partial-start unwind and label-aware removal exist on important paths in [RuntimeAppManifest.cs:1308-1311](../../apps/core/src/Haas.Hosty.Core/RuntimeAppManifest.cs#L1308-L1311), [RuntimeAppManifest.cs:1493-1507](../../apps/core/src/Haas.Hosty.Core/RuntimeAppManifest.cs#L1493-L1507), and [RuntimeAppManifest.cs:1787-1811](../../apps/core/src/Haas.Hosty.Core/RuntimeAppManifest.cs#L1787-L1811).
- Manifest fetches have a size cap and deadline in [RuntimeAppManifest.cs:685-748](../../apps/core/src/Haas.Hosty.Core/RuntimeAppManifest.cs#L685-L748).
- Raw session bearer tokens are not exposed by the users response; only fingerprints are projected in [DomainEndpoints.cs:82-118](../../apps/core/src/Haas.Hosty.Core/DomainEndpoints.cs#L82-L118).

## Recommended remediation order

### P0 — restore the claimed trust boundary

1. Fix C-CR1 with immutable server-side plan snapshots and exact artifact digests.
2. Make every public/CLI install use that reviewed operation; reject direct reinstall (C-H2).
3. Expose all security effects in plan/UI and require acknowledgement (C-H1).
4. Close mount and asset read/fetch boundaries (C-H3, C-H4, and C-M1).

### P1 — protect host identity and isolation

1. Atomically consume recovery tokens and add global/admission login limits (C-M2/C-H5).
2. Migrate Core-owned files/directories to private modes/ACLs (C-H6/C-M13).
3. Add the data-root process lease (C-H7).
4. Replace Docker name-based operations with identity/label-based operations and tri-state errors (C-H8).

### P2 — make failures recoverable and state truthful

1. Close runtime cleanup/reclaim gaps (C-H9).
2. Journal or generation-swap update/restore operations (C-H10).
3. Unify app/source/backup/mount/health coordination (C-M3/C-M4/C-M11).
4. Make prebuilt locks, process deadlines, audit, and token lifecycle explicit (C-M5 through C-M8).

### P3 — reduce recurrence

1. Split the mixed-responsibility classes around the boundaries above.
2. Replace dual route copies with shared handlers/policies.
3. Add real HTTP authorization/CSRF/CORS/error-contract tests.
4. Add fault-injection and concurrency tests at each persistent side-effect boundary.

## Verification performed for this review

- Static inspection of Core and the Shell/CLI install boundary at baseline `5fb8dda8`.
- Three independent focused passes, with the highest-severity findings rechecked against current source.
- Non-content inspection of existing local Hosty file modes to validate the Unix permission finding.
- Markdown code-link targets and line anchors checked against the baseline workspace.
- `dotnet test apps/core/tests/Haas.Hosty.Core.Tests/Haas.Hosty.Core.Tests.csproj --no-restore` — **passed: 669, failed: 0, skipped: 0**. The first sandboxed attempt was aborted by VSTest before test execution because local socket binding was denied; the same command passed after granting the test runner local socket access.

## Limitations

- This is not a penetration test. No malicious manifest, symlink swap, redirect SSRF, login flood, process kill failure, or crash injection was executed.
- Dependency advisories and current external service behavior were not assessed.
- Deployment controls can reduce exposure, but repository code should not rely on undocumented reverse-proxy path filtering, single-user host permissions, or operator sequencing for the security properties described above.

---

## Reviewer commentary (2026-07-10, second pass)

A follow-up pass re-verified the highest-cost findings line-by-line against `main @ 5fb8dda8`. The review holds up: the findings I checked are backed by the cited code, the severity-measures-impact model is applied honestly, and the "Positive controls" section keeps it from over-claiming. The notes below are corrections, precision improvements, and a re-ordering of remediation by fix cost — not disagreements with the substance.

### Missing threat model skews how the severities read

The document has no explicit threat model, which inflates the apparent weight of several findings. Hosty is a self-hosted tool for one-or-few administrators. Some High/Medium items are "a second local OS user on the same host" (C-H6, C-M13) or "a second Core process on the same data root" (C-H7) — real defects, but their weight depends on whether a multi-user host and a fronting proxy are in scope. Add a short threat-model section (who the attacker is, whether local OS users are trusted, whether Core sits behind a trusted proxy) at the top; without it "10 High" reads scarier than the actual exposure.

### C-CR1 is the right crux, but split it by path

This is correctly the headline, and it lands directly on the marketplace trust model: the MVP is single-source **unsigned**, trust = install-review, with signing (WS5) deferred. If review does not bind the artifact, that trust boundary is broken by construction — so C-CR1 is the argument for pulling pinning/signing forward, not a "later" item. But the blanket claim "the reviewed manifest is not the installed manifest" should be split, because it is only unconditionally true for one path:

- **Install path — fully confirmed.** `AppInstallRequest` ([CoreLifecycleService.cs:3911](../../apps/core/src/Haas.Hosty.Core/CoreLifecycleService.cs#L3911)) has no digest/plan-id field; `InstallCoreAsync` never compares `TargetManifestDigest` — it reloads the manifest by path and installs. No binding.
- **Update path — the review slightly overstates it.** `AppUpdatePlanDigestSeed` **includes** `TargetManifestDigest` ([CoreLifecycleService.cs:3892](../../apps/core/src/Haas.Hosty.Core/CoreLifecycleService.cs#L3892)) and `ApplyUpdateCoreAsync` recomputes and compares `PlanDigest` ([CoreLifecycleService.cs:791](../../apps/core/src/Haas.Hosty.Core/CoreLifecycleService.cs#L791)); if the source changed between review and apply, the digest mismatches and the update is **rejected**. The residual defect here is narrower: a TOCTOU between the validated fetch ([CoreLifecycleService.cs:790](../../apps/core/src/Haas.Hosty.Core/CoreLifecycleService.cs#L790)) and the applied fetch ([CoreLifecycleService.cs:797](../../apps/core/src/Haas.Hosty.Core/CoreLifecycleService.cs#L797), never compared to the first), plus the image tag being resolved again before run ([RuntimeAppManifest.cs:1714](../../apps/core/src/Haas.Hosty.Core/RuntimeAppManifest.cs#L1714)).

Recommendation stands (immutable server-side snapshot under a single-use plan ID + `repository@sha256:` pinning), but state it as two distinct fixes: **install = add digest/plan binding (the tag has none); update = pin the resolved image digest and close the double fetch.** This is more precise and denies reviewers an excuse to dismiss the whole finding on the update path.

### Re-order remediation by fix cost

P0–P3 is sensible, but within it I would front-load the cheap, high-return fixes ahead of the structural C-CR1 work:

1. **C-H6 (file modes) first — nearly free.** The correct primitive already exists in-repo (`SecureFileSystem`, already used for retained secrets). This is applying it to state/backups/logs/audit plus a startup mode migration, not a refactor. It retires a whole class of local findings cheaply.
2. **C-H2 and C-H4 next — one guard and one access check.** Both are point fixes with outsized security return; close them before the structural C-CR1 work rather than after.
3. **C-CR1** — most valuable, most expensive (needs a server-side plan store + pinning); split install-digest-binding (small) from resolved-image pinning.
4. Local multi-user items (C-M13 `0777` telemetry dirs) rank **below** C-H2/C-H4, since they depend on the multi-user threat model.

### Findings independently re-confirmed

- **C-H2** — `InstallCoreAsync` ignores the `already-installed` state, builds the record with `existing: null` / `RuntimeState="stopped"` and upserts; the catalog CLI calls install directly ([CatalogCommand.cs:142](../../apps/cli/src/Haas.Hosty.Cli/Commands/CatalogCommand.cs#L142)). Reinstall over a running app is real. Cheap fix: reject `409 already_installed` under the app lock.
- **C-H3** — `ResolveRealPath` resolves only the final component and **fails open** to the lexical path ([MountPathPolicy.cs:73](../../apps/core/src/Haas.Hosty.Core/MountPathPolicy.cs#L73)); the non-canonical path is handed to Docker. Ancestor-symlink bypass confirmed.
- **C-H4** — the most under-rated finding by ease of exploitation: `Serve` requires only a session, with no app-existence or assignment check ([AppAssetEndpoints.cs:41](../../apps/core/src/Haas.Hosty.Core/AppAssetEndpoints.cs#L41)), while `/api/apps` filters by assignment; app `data/` sits under the same root. Any `host.user` can read another app's private files, and `?v=` flips the response to `public, immutable` caching.
- **C-H5** — `IsThrottled` and `RegisterFailure` are separate lock sections, and failure is recorded only after the 600k-iteration PBKDF2; a parallel burst is admitted before the first failure lands.

### Structural notes

- **A2 should rank above "structural."** The hand-duplicated `/api` vs `/control/v1` registrations have **already** produced authorization drift between the two route sets in this codebase — a recurring auth-hole source, not a hypothetical. Worth treating as a live risk factor.
- **A4 is on point** — until there is a `WebApplicationFactory`/`TestServer` HTTP-level suite, findings like C-H4 will keep slipping through precisely because the text-heuristic guard test cannot see them.

### Small corrections to fold into the document

- In C-CR1, separate install (no binding) from update (bound, modulo TOCTOU + tag) so the claim is not formally rebuttable on the update path.
- Add the threat-model section noted above.
- C-M10 (internal metrics public under observability + managed cloudflared) is valid but doubly conditional; label it "conditional exposure" so it does not read as unconditional.

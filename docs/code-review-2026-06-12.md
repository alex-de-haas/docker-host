# Hosty Code Review — 2026-06-12

Full-codebase review of the Hosty platform (Core, CLI, Shell, demo-app, scripts, CI).
Conducted via a multi-agent fan-out (10 specialized finder passes) followed by an
adversarial verification round in which each top finding was re-checked against the
source by a skeptic whose job was to *refute* it. Every finding below was confirmed
against actual code; where verification changed the severity, the adjustment is noted.

## Overall assessment

The architecture is sound: clean separation between Core (C# .NET 10 minimal API),
the `hosty` CLI, the Next.js Shell, and embedded runtime apps. The issues cluster in
three areas:

1. **The trust boundary between Core and embedded apps** — the most serious problems.
2. **Concurrency in the file-backed JSON stores** — lost updates and replay windows.
3. **Error and edge-case handling in the CLI and Shell.**

There is also meaningful duplication in Core worth paying down.

**Single most important fix:** `POST /api/auth/trusted-proxy/session` is an
unauthenticated admin-impersonation endpoint.

### Severity scale

| Severity | Meaning |
| --- | --- |
| Critical | Exploitable security hole or data loss |
| High | Real bug users will hit, or a serious security weakness |
| Medium | Bug in edge cases, or a meaningful quality/perf problem |
| Low | Minor improvement / hardening |

### Summary

| # | Severity | Area | Issue |
| --- | --- | --- | --- |
| 1 | Critical | Core auth | Unauthenticated trusted-proxy endpoint mints a session for any user |
| 2 | Critical | Core / demo-app | Cross-app identity-token replay (revalidate not bound to caller) |
| 3 | High | demo-app | Host user directory exposed with no authorization |
| 4 | High | Core backups | Restore destroys live data before it is safe |
| 5 | High | Core stores | File-backed JSON stores have no locking |
| 6 | High | CI | PR CI compiles but never runs tests |
| 7 | High | Core | Secrets written world-readable |
| 8 | High | CLI | 10-second timeout aborts long lifecycle operations |
| 9 | High | CLI | Several commands crash instead of erroring cleanly; Windows log lost |
| 10 | Medium | Shell | Shared busy/detail state races; silent backup failure |
| 11 | Medium | Core | App-id path traversal (`..`) can delete the data root |
| 12 | Medium | Core | git argv injection / backup-reason path traversal |
| 13 | Medium | Core | localCommand runs arbitrary manifest commands |
| 14 | Medium | Core | Port allocation TOCTOU; start-already-running marks app stopped |
| 15 | Medium | Core | Pre-update backup taken while the app is running |
| 16 | Medium | Shell/Core | Contract drift between TS and C# |
| 17 | Medium | Build | Version numbers out of sync |
| 18 | Medium | Shell | No anti-framing headers (clickjacking) |
| 19 | Medium | CI | Missing workflow permissions; unpinned actions |
| 20 | Medium | Scripts | `dev-local.mjs` orphans Core on Windows |
| 21 | Medium | Install | Install/update integrity check is optional |
| Q1–Q3 | — | Core | Maintainability / refactoring opportunities |

---

## Critical

### 1. Unauthenticated trusted-proxy endpoint mints a session for any user

- **File:** `apps/core/src/Haas.Hosty.Core/AuthEndpoints.cs:55`
- **Category:** security

`POST /api/auth/trusted-proxy/session` reads `X-Hosty-Trusted-User-Id` and calls
`CreateSessionAsync` for that user with zero verification — no shared proxy secret, no
`KnownProxies` restriction, no environment gate. Contrast the dev `/api/auth/session`
route directly above it, which is gated on `IsDevelopment()`. There is no
`UseAuthentication`/`UseAuthorization` anywhere in Core, so nothing guards this route.

The default listener is loopback, so the out-of-the-box install requires local access
or an SSRF vector — but this endpoint *exists for* reverse-proxy deployments, where it
becomes a remote, unauthenticated "become host.admin" primitive. The configured
`ForwardedHeadersOptions` sets no `KnownProxies`, so the "trusted" header is fully
attacker-controllable.

```csharp
app.MapPost("/api/auth/trusted-proxy/session", async (HttpRequest request, ...) =>
{
    var userId = request.Headers["X-Hosty-Trusted-User-Id"].ToString();
    ...
    var result = await CreateSessionAsync(userId, secureCookie: true, response, users, clock, cancellationToken);
```

**Fix:** Require a pre-shared trusted-proxy secret (mirror the existing
`X-Hosty-Control-Secret` pattern) and/or restrict the route to configured known
proxies. Gate it behind an explicit opt-in config flag that is off by default.

### 2. Cross-app identity-token replay

- **Files:** `apps/demo-app/src/lib/host-auth.ts:172`, `apps/core/src/Haas.Hosty.Core/AppIdentityService.cs:77`
- **Category:** security

Core's `/api/auth/apps/revalidate` is an unauthenticated `MapPost` that validates a
token purely against the token's *own* embedded audience claim — it does not bind
revalidation to the calling app. `RevalidateAsync` validates only the HMAC signature
and expiry, then calls `RequireAccessibleUserAsync(claims.Audience, claims.Subject, ...)`
using the token's self-described audience and returns that audience plus the user's
`hostRole`.

The demo app (the reference implementation third-party apps copy) POSTs only
`{ accessToken }` and never reads the returned `appId`; its snapshot `appId` is
hard-set from config. Result: a still-valid identity token minted for app B can be
replayed against app A and accepted, inheriting that user's `hostRole`. Tokens are
per-app scoped and short-lived (5 min), but the scoping buys nothing because no one
checks the caller.

```ts
return {
  ...baseSnapshot,
  status: readBooleanField(record.active) ? "active" : "expired",
  userId: readString(record.userId),
  hostRole: readString(record.hostRole),
  // record.appId (the returned audience) is never read or compared to config.host.appId
};
```

**Fix (two layers):**
- Core should require the calling app's service token on revalidate and reject when
  `claims.Audience != callingApp`.
- The demo should compare `record.appId` to `config.host.appId` and reject mismatches,
  so the copied pattern is safe by default.

---

## High

### 3. Reference app leaks the host user directory with no authorization

- **Files:** `apps/demo-app/src/app/api/people/route.ts:11`, `apps/demo-app/src/app/api/roles/route.ts:7`
- **Category:** security

`GET /api/people` (and `/api/roles`, and both server pages) calls
`getAppDirectorySnapshot()` using the app's powerful service token and returns every
assigned user's id, **email**, and `hostRole` with no caller identity or permission
check. The endpoints are `public: true` in the manifest, so an unauthenticated visitor
harvests the entire directory. The PUT/DELETE role routes *do* enforce `canManage`,
making the ungated reads an obvious inconsistency — and a dangerous pattern for
third-party developers to copy.

```ts
export async function GET() {
  const [directory, assignments] = await Promise.all([
    getAppDirectorySnapshot(),       // authenticates with HOSTY_APP_SERVICE_TOKEN
    readDemoAppRoleAssignments(),
  ]);
  return NextResponse.json({ people: directory.users.map(/* includes email, hostRole */) });
}
```

**Fix:** Resolve caller permissions via `getDemoAuthSnapshot(headers)` and gate every
directory-returning route and page (e.g. require `demo.people.read` /
`demo.directory.read`), returning 403 for anonymous/insufficient roles.

### 4. Backup restore destroys live data before it is safe

- **File:** `apps/core/src/Haas.Hosty.Core/AppBackupService.cs:127`
- **Category:** bug (data loss)

`RestoreBackupAsync` deletes the entire app data directory recursively and *then*
extracts the zip directly into the live directory — no temp-dir-and-swap, and the
recorded `ArchiveSha256` is never checked before the destructive delete. (Ironically,
the cleanup path *does* verify the hash, so the dangerous path has less protection than
the safe one.) The pre-restore safety backup defaults to off
(`CreatePreRestoreBackup = false`). A truncated/corrupt archive or a disk-full
mid-extraction is permanent data loss.

```csharp
if (Directory.Exists(dataPath)) { Directory.Delete(dataPath, recursive: true); }
Directory.CreateDirectory(dataPath);
ZipFile.ExtractToDirectory(record.ArchivePath, dataPath, overwriteFiles: true);
```

**Fix:** Verify `ArchiveSha256` against the archive, extract into a sibling temp
directory, and only swap it into place (rename old aside, rename new in) after
extraction succeeds.

### 5. File-backed JSON stores have no locking

- **Files:** `apps/core/src/Haas.Hosty.Core/JsonStorage.cs:37`, `apps/core/src/Haas.Hosty.Core/AppRegistryStore.cs:64`, `apps/core/src/Haas.Hosty.Core/AppIdentityService.cs:37`
- **Category:** concurrency

Three confirmed sub-issues, none of which have any synchronization in the call stack:

1. **`JsonStorage.WriteAsync` uses a fixed temp path `{path}.tmp`** for every write, so
   concurrent writers to the same file collide: one truncates the other's temp file,
   then `File.Move(..., overwrite: true)` publishes a half-written `state.json` (or the
   second `File.Create` throws).
2. **`AppRegistryStore.UpdateAppAsync` is a lockless read-modify-write** (`GetAppAsync`
   then `UpsertAppAsync`) — a concurrent update silently discards the first delta, e.g.
   an app left marked `stopped` with no endpoint URLs while its processes run.
3. **`AppIdentityService.ExchangeCodeAsync` checks `ConsumedAt == null` then `await`s**
   `RequireAccessibleUserAsync` before writing the consumed state, so two parallel
   exchanges of the same auth code both succeed (replay).

```csharp
var tempPath = $"{path}.tmp";              // fixed name — collides under concurrency
await using (var stream = File.Create(tempPath)) { ... }
File.Move(tempPath, path, overwrite: true);
```

Severity for the registry/state races is **medium** given the single-operator loopback
model, but the **auth-code replay stays high** because it is directly
attacker-influenceable over HTTP.

**Fix:** Route every store mutation through a per-key `SemaphoreSlim` held across the
read-modify-write cycle; use a unique temp filename per write
(`{name}.{Guid.NewGuid():N}.tmp`).

### 6. PR CI compiles but never runs tests

- **File:** `.github/workflows/ci.yml:100`
- **Category:** bug

The workflow triggers on both `pull_request` and `push`, but "Test Core" (line 100),
"Test CLI" (line 125), "Lint Demo App" (line 78), and "Validate installer syntax"
(line 116) are all guarded with `if: github.event_name == 'push'`. Pull requests only
build — failing unit tests get a green check and are caught only after merge to main,
which is also what triggers the release/image-publish workflows.

```yaml
- name: Test Core
  if: github.event_name == 'push'
  run: npm run core:test
```

**Fix:** Remove the `push`-only guards so tests and lint run on `pull_request`.

### 7. Secrets written world-readable

- **Files:** `apps/core/src/Haas.Hosty.Core/HostyCoreApplication.cs:1051`, `apps/core/src/Haas.Hosty.Core/AppIdentityService.cs:171`
- **Category:** security

`control.json` (the master control secret that authorizes every `/control/v1/*`
operation, including `core/stop`) and `app-identity-signing.key` (the HMAC key that
signs every identity token) are written with default permissions — 0644 on Linux. Any
local user can read the signing key and forge identity tokens for any user, including
`host.admin`. The auth `state.json` (session ids, password hashes) goes through the
same unhardened `JsonStorage`.

```csharp
await File.WriteAllTextAsync(config.ControlDiscoveryPath, json, cancellationToken);
// and
await using var stream = new FileStream(path, FileMode.CreateNew, FileAccess.Write,
    FileShare.None, 4096, useAsync: true);   // no UnixCreateMode
```

**Fix:** Create secret-bearing files with `UnixFileMode.UserRead | UnixFileMode.UserWrite`
(via `FileStreamOptions.UnixCreateMode` / `File.SetUnixFileMode`) and restrict the
`core/run` and `core/auth` directories to 0700.

### 8. CLI: 10-second timeout aborts long lifecycle operations

- **File:** `apps/cli/src/Haas.Hosty.Cli/Commands/CoreControlClient.cs:34`
- **Category:** bug

Core runs `docker pull`/`docker run`, backups, and git fetches *synchronously inside
the HTTP request*, but the CLI's control client hard-codes a 10-second `HttpClient`
timeout. A first image pull (minutes) makes `hosty apps start` throw "Unable to reach
Hosty Core: the request was canceled..." while the operation actually continues
server-side — the user has no idea what happened.

```csharp
var httpClient = new HttpClient { Timeout = TimeSpan.FromSeconds(10) };
```

**Fix:** Use the short timeout only for cheap status/discovery probes; give lifecycle
POSTs a long/infinite timeout with a per-request `CancellationToken`, or have Core
expose async job semantics. At minimum, distinguish the timeout error message from
"unreachable".

### 9. CLI: several commands crash instead of erroring cleanly; Windows log lost

- **Files:** `apps/cli/src/Haas.Hosty.Cli/Commands/UsersCommand.cs:46`, `apps/cli/src/Haas.Hosty.Cli/Commands/CoreCommand.cs:110`
- **Category:** bug

`hosty users` and `hosty open` have no try/catch around their Core calls (unlike
`apps`/`auth`), and `CommandLine.RunAsync` only catches a few exception types. A killed
Core (stale `control.json`) makes these commands exit with a raw .NET stack trace
instead of a friendly message and exit 1.

Separately, the Windows background-start branch starts Core with no
`RedirectStandardOutput`/`RedirectStandardError`, so `core.log` is never written — yet
the CLI still prints `Log: <path>` and `hosty core logs` reads it. On Windows you get
zero diagnostics exactly when Core fails to start. The Windows branch also ignores a
null return from `Process.Start`.

```csharp
if (OperatingSystem.IsWindows())
{
    var windowsStartInfo = CreateCoreStartInfo(target, url, settings);
    windowsStartInfo.CreateNoWindow = true;
    using var windowsProcess = Process.Start(windowsStartInfo);   // output discarded
    return logPath;                                               // log never written
}
```

**Fix:** Hoist the `CoreControlException`/`HttpRequestException`/`IOException`/
`TaskCanceledException` handling into `CommandLine.RunAsync`. On Windows, redirect
stdout/stderr to `core.log` and throw if `Process.Start` returns null.

---

## Medium

### 10. Shell: shared busy/detail state races; silent backup failure

- **File:** `apps/shell/src/app/shell-client.tsx:330` (and 393, 496, 106)
- **Category:** concurrency / bug

- `busyAction` is a single shared string and every action callback ends with an
  unconditional `setBusyAction(null)` in `finally`, so a fast action clears a slower
  concurrent action's busy state and re-enables its buttons mid-flight (allowing
  duplicate/conflicting lifecycle requests). The correct conditional pattern is already
  used elsewhere in the file.
- The detail-dialog loaders (`loadAppLogs`/`loadAppBackups`/`loadUpdatePlan`)
  unconditionally overwrite the shared `detailPanel` on resolution with no staleness
  guard and no abort on close, so a slow Logs fetch for app A clobbers app B's panel.
- `createManualBackup` failure from the row menu is **silent** (line 496): the spinner
  stops with no toast, so the user believes a backup was created when it was not.
- `refresh()` (line 106) has no AbortController or in-flight guard, so an older response
  resolving last reverts fresh state.

**Fix:** Clear busy state conditionally (`current === actionKey ? null : current`),
guard detail loads with a request token, add `toast.error` on backup failure, and
sequence/abort overlapping `refresh()` runs.

### 11. App-id path traversal can delete the data root

- **File:** `apps/core/src/Haas.Hosty.Core/RuntimeAppManifest.cs:422`
- **Category:** security

`IsSafeIdentifier` allows `.`, so an id of `..` passes validation and flows
unnormalized into `Path.Combine` (`GetAppRoot`, `GetBackupRoot`, etc.). Removing such
an app with `DeleteBackups=true` resolves `GetBackupRoot` to the data root itself and
`Directory.Delete(backupRoot, recursive: true)` wipes apps, sources, auth, and audit.

```csharp
private static bool IsSafeIdentifier(string value) =>
    value.All(c => char.IsLetterOrDigit(c) || c is '.' or '_' or '-');  // ".." passes
```

Verification **downgraded this from critical to medium** because exploitation requires
an authenticated `host.admin` (valid session + CSRF) or the control secret to install
the malicious manifest — there is no remote/unauthenticated path. It remains a real
"confused admin / malicious manifest URL" data-destruction bug.

**Fix:** Anchor ids to a strict regex (e.g. `^[a-z0-9][a-z0-9._-]{0,62}$`), explicitly
reject `.`/`..`/path separators, and add a `Path.GetFullPath` containment check before
any create/delete.

### 12. git argv injection / backup-reason path traversal

- **Files:** `apps/core/src/Haas.Hosty.Core/AppSourceService.cs:203` (and 251), `apps/core/src/Haas.Hosty.Core/AppBackupService.cs:32`
- **Category:** security

`ValidateManagedRepository` only checks URI schemes and SCP-style SSH; a value
beginning with `-` (e.g. `--upload-pack=...`) falls through and reaches `git clone
<repository> <checkoutPath>` as a positional argument with no `--` separator — classic
git argument injection. `ResolveCommitAsync` similarly builds `git rev-parse
"{request.Commit}^{commit}"` with no `--` and no leading-dash guard. Separately,
`CreateManualBackupAsync` interpolates an unsanitized `reason` into the archive path
(`{timestamp}_{reason}.zip`), so `reason="../../sources/x/y"` escapes the backups
directory.

Both inputs are control-secret-gated (authenticated admin), so verification
**downgraded these to low/medium** — defense-in-depth gaps rather than unauth RCE. The
fixes are cheap.

**Fix:** Insert a literal `--` before user-controlled positional git args and reject
values starting with `-` (or validate commits against `^[0-9a-fA-F]{4,64}$`); validate
`reason` against an allowlist such as `^[a-z0-9][a-z0-9-]{0,30}$`.

### 13. localCommand runs arbitrary manifest commands

- **File:** `apps/core/src/Haas.Hosty.Core/LocalCommandRuntimeAdapter.cs:168`
- **Category:** security

`CreateShellStartInfo` runs `service.Runtime.Command` straight through `/bin/sh -c`
(or `cmd.exe /c`), and manifests can be fetched from remote http(s) URLs. Installing
and starting a remote `localCommand` app is therefore silent code execution on the host
with Core's privileges. This is partly by design for a self-hosting tool, but it
deserves an explicit trust/confirmation gate.

```csharp
startInfo.FileName = "/bin/sh";
startInfo.ArgumentList.Add("-c");
startInfo.ArgumentList.Add(command);   // command = service.Runtime.Command, from manifest
```

**Fix:** Treat remote-manifest `localCommand` installs as a privileged operation
requiring explicit operator confirmation/trust pinning; consider disallowing
`localCommand` for remotely fetched manifests.

### 14. Port allocation TOCTOU; start-already-running marks app stopped

- **Files:** `apps/core/src/Haas.Hosty.Core/RuntimePortHelper.cs:80`, `apps/core/src/Haas.Hosty.Core/LocalCommandRuntimeAdapter.cs:18`
- **Category:** concurrency / bug

`AllocateLoopbackPort` binds on port 0, reads the port, then closes the listener before
handing the port to the child — any other process can grab it before the child binds,
and nothing serializes concurrent starts. Separately, `StartAsync` probes pinned port
availability *before* stopping the previous instance, so starting an already-running app
finds its own listener, throws `local_command_port_unavailable`, and the catch records
`RuntimeState = "stopped"` while the old processes keep serving.

**Fix:** Track recently-allocated ports process-wide to exclude self-races; stop
existing services (or skip ports held by this app's own registry entries) before
probing; only record `stopped` when the runtime is verifiably not running.

### 15. Pre-update backup taken while the app is running

- **File:** `apps/core/src/Haas.Hosty.Core/CoreLifecycleService.cs:281`
- **Category:** bug

`ApplyUpdateAsync` (and `ApplyRuntimeSwitchAsync`) create the pre-update/pre-switch
backup *before* stopping the running app, so `ZipFile.CreateFromDirectory` zips a live,
mutating data directory — an internally inconsistent backup (e.g. half-committed SQLite
WAL state), and on Windows it can fail outright on locked files. The code stops the app
moments later anyway, so the ordering is gratuitous.

**Fix:** Stop the running app first, then create the backup, then apply the manifest and
restart. (Also: `ApplyUpdateAsync` returns the raw `StartAsync` result on the
running-app path, dropping the backup id and reporting `"started"` instead of
`"updated"` — mirror the runtime-switch path which handles this correctly.)

### 16. Contract drift between TS and C#

- **Files:** `apps/shell/src/app/shell/types.ts:18`, `apps/shell/src/app/shell/pages/dashboard-page.tsx:24`, `apps/shell/src/app/shell/types.ts:224`
- **Category:** bug

- `CoreSetting.required` / `CoreInstallSetting.required` exist on the TS side but have no
  C# counterpart (the manifest schema and DTOs carry no `Required` field), so
  `setting.required` is always `undefined`. The "required" badge, `hasMissingRequiredSettings`,
  and the auto-open/attention behavior are dead code — users are never warned about
  missing required settings.
- The dashboard "Installed" metric counts `operationStatus === "installed"`, but Core
  overwrites `OperationStatus` with the latest operation (`started`, `stopped`,
  `configured`, ...), so the count silently drops toward zero on a healthy host.
- `SessionResponse.user.email`/`displayName` are typed non-nullable but Core serializes
  them as nullable.

**Fix:** Add a `Required` flag through the manifest/DTOs (or delete the dead fields and
UI branches); count installed apps as `runtimeApps.length` (or expose a stable
lifecycle state separate from last-operation); make `SessionResponse.user` fields
nullable. The empty `packages/contracts` directory is the missing seam that would
prevent this drift — either populate it (codegen TS from the C# records / an OpenAPI
doc) and add it to the npm workspaces, or remove it.

### 17. Version numbers out of sync

- **Files:** `apps/cli/src/Haas.Hosty.Cli/CommandLine.cs:73`, `channels/product-channels.json:6`
- **Category:** quality

Root `package.json`, the Shell, the demo-app, and the Shell manifest were all bumped to
`0.2.1`, but the CLI's hardcoded `Version = "0.1.0"` and `product-channels.json`
`cliVersion: "0.1.0"` were never updated. `cli-release.yml` also runs `dotnet publish`
without any `-p:Version`, so every rolling CLI binary self-reports `0.1.0` regardless
of what was built — "is my CLI current?" is undiagnosable.

**Fix:** Derive the CLI version from a single source (pass `-p:Version` in
`cli-release.yml` from `package.json`/a `VERSION` file; read it via assembly metadata)
and update `product-channels.json` in the same change that bumps the product version.

### 18. No anti-framing headers (clickjacking)

- **File:** `apps/shell/next.config.ts:6`
- **Category:** security

The privileged admin Shell sets no security headers and has no middleware, so no
`X-Frame-Options` or CSP `frame-ancestors` is emitted. A malicious page can frame the
Shell and clickjack an authenticated admin into state-changing actions, several of which
are guarded only by `window.confirm()`. The demo-app likewise has no `frame-ancestors`
restriction.

**Fix:** Add a Next `headers()` entry (or middleware) sending
`Content-Security-Policy: frame-ancestors 'none'` (or the specific allowed embedder) and
`X-Frame-Options: DENY` for the Shell; for runtime apps, emit `frame-ancestors` limited
to the Shell/Core origin.

### 19. Missing workflow permissions; unpinned actions

- **Files:** `.github/workflows/cli-release.yml:17`, `.github/workflows/shell-image.yml:33`
- **Category:** security

`cli-release.yml` and `ci.yml` define no top-level `permissions:` block, so their jobs
run with the repository default `GITHUB_TOKEN` grants. The image-publish workflows pin
`docker/*` actions by mutable major tag (`@v4`/`@v6`/`@v7`) rather than commit SHA, and
those images are pulled with `pullPolicy: always` — a tag-retarget compromise becomes a
supply-chain path into every install.

**Fix:** Add top-level `permissions: contents: read` (keep the job-level
`contents: write` only on the release job); pin third-party actions to full commit SHAs
and let Dependabot/Renovate bump the pins.

### 20. dev-local.mjs orphans Core on Windows

- **File:** `scripts/dev-local.mjs:87`
- **Category:** bug

`spawn` is invoked with `shell: process.platform === "win32"`, so on Windows the tracked
child is a `cmd.exe` wrapper. `stopAll()` calls `child.kill()` on the wrapper only, so
Ctrl+C leaves the actual `dotnet` Core process (and the Shell) running; the next
`npm run dev` then fails the `assertPortAvailable` check.

**Fix:** Drop `shell: true` (dotnet resolves fine without a shell) or kill the whole
process tree on Windows (e.g. `taskkill /pid <pid> /T /F`).

### 21. Install/update integrity check is optional

- **Files:** `scripts/install.sh:239`, `scripts/install.ps1`, `apps/cli/src/Haas.Hosty.Cli/Commands/SelfUpdateService.cs:51`
- **Category:** security

Both installers and the CLI self-update download an artifact, then attempt to fetch
`SHA256SUMS`; if that fetch fails they print a warning and install the binary anyway.
Because `HOSTY_INSTALL_REPO`/`HOSTY_INSTALL_TAG` are honored from the environment, a
release that simply omits (or an interception that strips) `SHA256SUMS` bypasses the
only non-TLS integrity gate, and the unverified binary is then executed. The skill
installer (`install-hosty-app-skill.sh`) has no integrity check at all and defaults to
the mutable `main` ref.

**Fix:** Treat a missing/unparseable `SHA256SUMS` as a hard failure for installs and
self-update; ideally verify a detached signature over `SHA256SUMS`. Also avoid passing
the GitHub token to `curl` via `-H` (visible in the process list) — use `--config`/a
600-mode netrc instead.

---

## Maintainability (worth scheduling)

### Q1. `CoreLifecycleService` is a 2105-line god class

- **File:** `apps/core/src/Haas.Hosty.Core/CoreLifecycleService.cs`

Clean extraction seams already exist as self-contained statics: the ~470-line
change-plan/diff machinery (→ `AppChangePlanCalculator`), source-root inference
(→ `LocalSourceRootResolver`), and channel resolution (→ `AppChannelResolver`, which
should reuse `AppManifestService.LoadAsync` instead of a raw synchronous
`File.ReadAllText`). ~650 lines move out with no behavior change.

### Q2. `LifecycleEndpoints` registers every route twice

- **File:** `apps/core/src/Haas.Hosty.Core/LifecycleEndpoints.cs:36`

19 near-identical `/api/apps/...` + `/control/v1/apps/...` pairs — roughly 500 of 557
lines are boilerplate that must be kept in sync by hand (the channels routes have
already drifted; they exist only on the control plane). A `MapAdminAndControl(...)`
helper driven by a small route table collapses it to ~80 lines and makes the two planes
impossible to desync. The five per-file exception-to-HTTP mappers (two `HandleIdentityError`
copies already disagree on 403 vs 404) should likewise collapse into one
`CoreErrorResults` helper.

### Q3. Duplicated primitives and grab-bag files

- **Files:** `apps/core/src/Haas.Hosty.Core/RuntimeAppManifest.cs`, plus several services

Five `JsonSerializerOptions` instances, five SHA-256-hex helpers, two `IsLoopbackHost`
implementations, two `TryDelete`, and a duplicated `GetAppDataPath`. `RuntimeAppManifest.cs`
(945 lines) is named after a DTO but actually contains `AppManifestService`, the
`IAppRuntimeAdapter` interface, and the entire `DockerRuntimeAdapter` — split it to
mirror `LocalCommandRuntimeAdapter.cs`. Core state-machine values (`"running"`,
`"stopped"`, `"host.admin"`, `"docker"`, `"localCommand"`) are compared ordinally across
many files as raw literals with no constants, so a typo compiles silently and breaks
reconciliation or authorization. Introduce `RuntimeStates`/`RuntimeTypes`/`HostRoles`
constant classes and a shared `CoreHashing`/`JsonStorage.Options`.

---

## Suggested fix order

1. **Trust-boundary holes:** #1 (trusted-proxy endpoint), then #2 (cross-app token
   replay) + #3 (demo-app directory exposure).
2. **Data integrity:** #4 (restore data loss) and #5 (store locking, especially the
   auth-code replay window).
3. **Release safety:** #6 (CI test gate) and #7 (secret file permissions).
4. **Reliability:** #8 and #9 (CLI timeouts and crash handling), then the Medium items
   as capacity allows.
5. **Maintainability:** Q1–Q3 once the correctness/security work has landed.

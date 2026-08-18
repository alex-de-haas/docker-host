# Hosty Platform — Full Codebase Review

- **Date:** 2026-08-18
- **Baseline:** `main` @ `50e9175c` (merge of PR #376, platform 0.83.0).
- **Scope:** changes landed since the last full review (`2026-07-05`) — roughly 670 commits across `apps/core`, `apps/cli`, `apps/ai-gateway`, `apps/shell`, `apps/telemetry-backend`, `apps/telemetry-ui`, `apps/demo-app`, `apps/marketplace`, and `packages/`. Hot areas: the `hosty mcp` connector, the CLI local-only pivot (`hosty login` removal), the Windows localCommand job object, telemetry read-auth + telemetry-over-MCP, the ai-gateway approval model, Cloudflare publication rename, and the delegated-token / app-identity flows.
- **Method:** eight independent finder passes (three correctness angles — line-by-line, removed-behavior, cross-file tracer — plus reuse, simplification, efficiency, altitude, and CLAUDE.md/AGENTS.md conventions), producing 47 candidates, each then re-verified finding by finding against the source. Verdicts: **44 confirmed, 2 plausible, 1 refuted.** No source was changed and no exploit was run. The two repository checkers (`node scripts/docs-index.mjs --check`, `node scripts/check-versions.mjs`) both pass.
- **Excluded:** third-party dependency CVE research, deployment-specific infrastructure, `apps/shell-swift` and `apps/shell-cardputer` native clients, and an exhaustive re-review of items already tracked in the `2026-07-10` Core review.

## Severity model

Severity measures impact, not external exploitability — several High items are authorized-operation, local-host, availability, or data-integrity defects whose prerequisites are stated inline. Finding counts are not a vulnerability count.

- **High** — approval/isolation boundary bypass, auth failure, secret/credential exposure or permanent orphaning, host-impacting availability loss, or persistent state corruption.
- **Medium** — meaningful availability, integrity, information-disclosure, or correctness defect with a realistic trigger and a narrower blast radius.
- **Low** — defense-in-depth, hardening, performance, or maintainability without a demonstrated high-impact path by itself.

**Totals:** 7 High / 13 Medium / 26 Low (2 of the High are `plausible`, pending SDK-internal confirmation). 1 candidate refuted.

## Executive summary

The platform's recent work is generally sound, and several of the findings below are the *residue* of good fixes — bounds, guards, and honesty contracts that were added in one place and not carried to a sibling path. The three themes worth acting on first:

1. **The ai-gateway approval boundary has two holes and a mislabel.** The gateway's stated design is "every write is routed through `canUseTool`" ([claude.ts:19](../../apps/ai-gateway/src/harness/claude.ts#L19)), but `Task` (sub-agent spawn) is in the auto-allow set, and `settingSources: ["user", "project"]` loads the host operator's own `permissions.allow` rules into the session. Both can let a tool run without an approval card or an audit line. The exact runtime effect depends on SDK-internal behavior that is not inspectable in-repo, so both are filed `plausible` — but the mislabelling of `Task` as "read-only" is confirmed, and nothing in the gateway constrains a spawned sub-agent's tools.

2. **The localCommand runtime still has an unbounded-wait class and a POSIX tree-kill gap.** The Windows job object and the bounded stop-path drains from the July work did not reach the *setup* path: setup can hang a start indefinitely under boot autostart, its failure paths leak reparented descendants that hold the app's port until reboot, and the service log writer is disposed before the async readers drain — dropping exactly the stack trace that explains a startup crash.

3. **The telemetry honesty contract leaks one layer down, and the app-identity token has no audience.** `list_traces` reports `truncated: false` even when the underlying 20k-span scan cap silently dropped data (the same class of lie `820f08dd` set out to remove, moved one level deeper), and `hosty_app_identity` carries no `aud` claim, so every verifier must remember an "is it mine?" check by convention — the precise shape of the hole that already let any app read the whole fleet's telemetry once.

Beyond these, the connector has a self-terminating fleet poll and a global handshake lock that serializes its fan-out; the CLI's legacy-credential purge can permanently strand a still-valid host token; and there is a broad seam of duplication (an app-to-Core auth prologue copied eight times, an OS-aware path-containment check four times, the SDK session-auth flow hand-rolled once more in demo-app) where the next security fix has to be found and applied in N places or it is incomplete.

---

## High

### H1 — `Task` is auto-approved, bypassing the gateway's write-approval boundary *(plausible)*

[apps/ai-gateway/src/harness/claude.ts:37](../../apps/ai-gateway/src/harness/claude.ts#L37)

`AUTO_ALLOWED_TOOLS` includes `"Task"`, and `requestApproval` returns `{behavior:"allow"}` for anything in the set ([claude.ts:232](../../apps/ai-gateway/src/harness/claude.ts#L232)) with no approval card and no `ai_action_approved` audit line (`manager.ts:393` fires only on `resolveApproval`). `Task` spawns a sub-agent, not a read-only operation, yet it is labelled "read-only" in code ([claude.ts:31](../../apps/ai-gateway/src/harness/claude.ts#L31), [228-231](../../apps/ai-gateway/src/harness/claude.ts#L228)) and in [docs/features/ai-gateway/feature.md:131](../../docs/features/ai-gateway/feature.md#L131). The `query` options set no `allowedTools`, `disallowedTools`, or `agents`, so nothing in the gateway bounds what a spawned sub-agent may run. Whether a sub-agent's `Bash`/`Write` calls route back through the parent's `canUseTool` is SDK-internal to the pinned `@anthropic-ai/claude-agent-sdk` 0.3.232 and not verifiable in-repo — hence `plausible` — but the design is one SDK upgrade away from silently opening a card-less write path.

**Fix:** remove `Task` from the auto-allow set (or gate it), and correct the "read-only" labels. If sub-agents are wanted, constrain their tools explicitly via `agents`/`disallowedTools`.

### H2 — Operator `permissions.allow` rules are loaded into gateway sessions *(plausible)*

[apps/ai-gateway/src/harness/claude.ts:190](../../apps/ai-gateway/src/harness/claude.ts#L190)

`settingSources: ["user", "project"]` loads the host operator's `~/.claude/settings.json` and the workdir `.claude/settings.json`. The comment acknowledges only CLAUDE.md and skills, but those files also carry `permissions`, and SDK permission rules are evaluated ahead of the `canUseTool` callback. An admin who also runs Claude Code by hand on this host commonly has entries like `"allow": ["Bash(docker:*)"]`; loaded into a gateway session, those pre-approve the tool, so the assistant can run host `docker` commands with no approval card and no audit line. Nothing neutralizes them — the options are just `permissionMode: "default"` + `canUseTool`, and a repo-wide grep finds no `disallowedTools`/`allowedTools`. Filed `plausible` on the same SDK-internal caveat as H1; "the operator's permissions are loaded" is confirmed.

**Fix:** narrow `settingSources` to what is actually wanted (CLAUDE.md/skills), or strip/override `permissions` before handing settings to the SDK, so the gateway's own approval model is the sole authority.

### H3 — `hosty_app_identity` token carries no audience claim

[apps/telemetry-backend/src/Haas.Hosty.TelemetryBackend/Query/TelemetryCallerAuth.cs:119](../../apps/telemetry-backend/src/Haas.Hosty.TelemetryBackend/Query/TelemetryCallerAuth.cs#L119)

`AppIdentityTokenPayload(string App, long Iat)` ([AppIdentityTokenService.cs:92](../../apps/core/src/Haas.Hosty.Core/AppIdentityTokenService.cs#L92)) has no audience, and Core mints one for every app from the same key pair whose public half every app receives. So the only thing separating "this app's identity" from "any app's identity" is a verifier-local convention — here `string.Equals(payload.App, appId, Ordinal)`, whose own comment records that omitting it once "would let any installed app read the whole fleet's telemetry" (the hole closed in `820f08dd`). The delegated path beside it is structurally safer: it checks `payload.Aud` ([line 134](../../apps/telemetry-backend/src/Haas.Hosty.TelemetryBackend/Query/TelemetryCallerAuth.cs#L134)), a claim the issuer put in the token, so forgetting it is a check against a present field rather than a silent omission. The next first-party app that accepts an identity token repeats the hole verbatim.

**Fix:** put the audience in the token Core mints (or verify through one shared helper), so a verifier cannot accidentally accept a foreign app's identity.

### H4 — localCommand `setup` can hang a start indefinitely

[apps/core/src/Haas.Hosty.Core/LocalCommandRuntimeAdapter.cs:254](../../apps/core/src/Haas.Hosty.Core/LocalCommandRuntimeAdapter.cs#L254)

`RunSetupAsync` redirects both pipes ([CreateShellStartInfo:464](../../apps/core/src/Haas.Hosty.Core/LocalCommandRuntimeAdapter.cs#L464)) and `await process.WaitForExitAsync(...)`, which on .NET also waits for the readers to reach EOF. On POSIX the shim deliberately does not redirect its own child ([LocalCommandShim.cs:61](../../apps/core/src/Haas.Hosty.Core/LocalCommandShim.cs#L61)), so `/bin/sh` and every descendant inherit Core's pipe write end. A `setup` that backgrounds anything surviving the shell — `npm install` with a postinstall daemon, `nohup helper &` — leaves the grandchild holding the pipe after sh and the shim exit, and the await never returns. There is no drain bound on this path: `LogDrainTimeout` is stop-only ([line 856](../../apps/core/src/Haas.Hosty.Core/LocalCommandRuntimeAdapter.cs#L856)) and `WindowsDrainTimeout` is Windows-only. The start wedges at "setup" — indefinitely under boot autostart, whose cancellation token is the host lifetime token. The 2026-07-10 Core review already recorded "no independent setup deadline".

**Fix:** bound the setup wait with its own deadline (mirror the stop-path drain), and treat setup as killable process-group work (see H5).

### H5 — cancelled or failed `setup` leaks its process tree; the failure path kills nothing

[apps/core/src/Haas.Hosty.Core/LocalCommandRuntimeAdapter.cs:203](../../apps/core/src/Haas.Hosty.Core/LocalCommandRuntimeAdapter.cs#L203)

Line 203 is `var (startInfo, _, windowsJob) = CreateShellStartInfo(setup, workingDirectory)` — the discarded middle element is the POSIX process-group flag, which is `true` where the setsid shim makes the setup root a group leader reachable by `kill(-pgid)`. On cancel, setup falls back to `process.Kill(entireProcessTree: true)` ([line 270](../../apps/core/src/Haas.Hosty.Core/LocalCommandRuntimeAdapter.cs#L270)), the ppid-walk that misses any descendant whose intermediate parent already exited — the exact traversal race the shim was built to close, for the exact workload (ai-gateway `npm install`) the Windows job object was added for. Worse, when setup exits non-zero ([lines 285-296](../../apps/core/src/Haas.Hosty.Core/LocalCommandRuntimeAdapter.cs#L285)) no kill runs at all. Setup writes no pidfile, so reclaim never finds the orphans: they hold the app's assigned port until reboot, and the next start fails preflight with a port conflict Core cannot explain.

**Fix:** thread the process-group flag (and, on Windows, the job) through setup and route its teardown through the same group/job kill the start path uses; give setup a pidfile so reclaim can find it.

### H6 — the CLI legacy-credential purge can permanently strand a valid host token

[apps/cli/src/Haas.Hosty.Cli/Configuration/LegacyCredentialPurge.cs:60](../../apps/cli/src/Haas.Hosty.Cli/Configuration/LegacyCredentialPurge.cs#L60)

`ReadContextNames` swallows a read failure (`IOException`/`JsonException`/`UnauthorizedAccessException`) with `yield break` ([lines 106-111](../../apps/cli/src/Haas.Hosty.Cli/Configuration/LegacyCredentialPurge.cs#L106)), and control still falls through to delete `contexts.json`. On macOS the removed `CredentialStore` kept the account names *only* in that index (it deletes the file copy after a successful keychain save), so a truncated index means the keychain items under service `hosty-cli` survive with no record of their names and no `hosty logout` left to remove them — a live host bearer token, valid until revoked in Shell, now permanently unreachable, which is the precise state `c5800911` exists to prevent. Separately, `removed += DeleteQuietly(contextsFile) ? 1 : 0` counts the index itself, so the "Removed the credential saved by the former 'hosty login'… still valid on the host until you revoke it" notice prints even when zero credentials were removed.

**Fix:** delete the index only after the names were read and their keychain items removed; do not count the index toward the credential total.

### H7 — the `hosty mcp` connector's fleet poll dies permanently on one Core restart

[apps/cli/src/Haas.Hosty.Cli/Commands/McpCommand.cs:270](../../apps/cli/src/Haas.Hosty.Cli/Commands/McpCommand.cs#L270)

`LiveToolCatalog.RefreshAsync` filters on `ex is CoreControlException or CoreControlTimeoutException`, but `CoreControlClient.SendAsync` converts only `OperationCanceledException` ([CoreControlClient.cs:139](../../apps/cli/src/Haas.Hosty.Cli/Commands/CoreControlClient.cs#L139)) — a connection-refused `HttpRequestException` (and `JsonException`) propagates unwrapped. `PollAsync` catches only `OperationCanceledException` ([line 247](../../apps/cli/src/Haas.Hosty.Cli/Commands/McpCommand.cs#L247)), so the first such throw exits the `while` loop; the fault is then silently swallowed by `ConfigureAwait(SuppressThrowing)` at [line 97](../../apps/cli/src/Haas.Hosty.Cli/Commands/McpCommand.cs#L97) and nothing restarts it. For the rest of the session the connector never re-reads the fleet and never emits `notifications/tools/list_changed` — installed/started/stopped apps become invisible, the one thing the connector exists to track. Every other Core-touching CLI command lists `HttpRequestException` in its filter (e.g. `AppsCommand.cs:232`), so this looks accidental.

**Fix:** catch the transport exceptions in the poll loop (treat an unreachable Core as "unchanged", not fatal) so the loop survives a restart.

---

## Medium

### M1 — the service log loses the tail that explains a startup crash

[apps/core/src/Haas.Hosty.Core/LocalCommandRuntimeAdapter.cs:138](../../apps/core/src/Haas.Hosty.Core/LocalCommandRuntimeAdapter.cs#L138)

The `Process.Exited` handler disposes `logWriter` immediately, while `OutputDataReceived`/`ErrorDataReceived` keep firing until pipe EOF; `LocalCommandLogWriter.TryWriteLine` silently drops lines once disposed ([line 961](../../apps/core/src/Haas.Hosty.Core/LocalCommandRuntimeAdapter.cs#L961)) — behaviour the suite even pins (`LocalCommandLogWriter_IgnoresLateWritesAfterDispose`). A service that writes a stack trace and exits ends its log with `[hosty] process exited with code 1` and no cause, and `local_command_start_failed` carries only the exit code. The bounded stop-path drain cannot help — the writer is already closed. **Fix:** dispose the writer after the readers reach EOF, not in the `Exited` handler.

### M2 — `list_traces` reports `truncated: false` when the 20k-span scan cap dropped data

[apps/telemetry-backend/src/Haas.Hosty.TelemetryBackend/Query/TelemetryQueryService.cs:76](../../apps/telemetry-backend/src/Haas.Hosty.TelemetryBackend/Query/TelemetryQueryService.cs#L76)

`GetFleetTraces` groups traces from at most `MaxSpansScan = 20_000` newest spans (`ORDER BY start_nano DESC LIMIT 20000`, [SqliteTelemetryStore.cs:407](../../apps/telemetry-backend/src/Haas.Hosty.TelemetryBackend/Telemetry/SqliteTelemetryStore.cs#L407)), but `WithWindow` computes `truncated` purely as `returnedTraces >= effectiveLimit` ([TelemetryMcpEndpoint.cs:211](../../apps/telemetry-backend/src/Haas.Hosty.TelemetryBackend/Query/TelemetryMcpEndpoint.cs#L211)). On a host emitting >20k spans/hour, a window returns a handful of traces with `truncated: false`, and an agent concludes it has seen everything — the false fleet statement the window contract (`820f08dd`) exists to prevent, moved one layer down. Traces straddling the cut are summarized from a subset, so their `spans` and `durationMs` are silently wrong. The cap is surfaced nowhere in the response. **Fix:** have the store report whether the scan cap bit, and fold it into `truncated`.

### M3 — a malformed `/api/mcp` body is a 500, not a JSON-RPC error

[apps/telemetry-backend/src/Haas.Hosty.TelemetryBackend/Program.cs:85](../../apps/telemetry-backend/src/Haas.Hosty.TelemetryBackend/Program.cs#L85)

`JsonNode.ParseAsync(request.Body)` and the `body?["method"]?.GetValue<string>()` read ([TelemetryMcpEndpoint.cs:27](../../apps/telemetry-backend/src/Haas.Hosty.TelemetryBackend/Query/TelemetryMcpEndpoint.cs#L27)) sit outside the `try/catch (JsonException or FormatException or InvalidOperationException)` that guards the tool-argument path ([line 100](../../apps/telemetry-backend/src/Haas.Hosty.TelemetryBackend/Query/TelemetryMcpEndpoint.cs#L100)). A truncated body or `{"method":5}` throws to a bare ASP.NET 500 (no exception middleware is registered), and a hand-rolled client like `AppMcpClient` treats a non-OK response as null — so the whole app silently drops out of the connector catalog. **Fix:** parse and read `method` inside the JSON-RPC error envelope.

### M4 — the assistant panel leaks an unabortable SSE reconnect loop on fast unmount

[apps/shell/src/app/shell/assistant/assistant-panel.tsx:110](../../apps/shell/src/app/shell/assistant/assistant-panel.tsx#L110)

`streamAbortRef.current` is assigned only after three awaits (`client.health()`, `getSession`/`createSession`), but the mount effect's cleanup is `streamAbortRef.current?.abort()` ([line 145](../../apps/shell/src/app/shell/assistant/assistant-panel.tsx#L145)). Closing the panel within the ~0.5–2s those take (it is conditionally rendered, so it unmounts) runs cleanup while the ref is still null — a no-op. `startSession` then creates an orphaned gateway session and starts `client.streamEvents` with a signal nothing can abort; the `while (!signal.aborted)` loop reconnects every 2s for the life of the page, re-minting an operator delegated token on expiry and calling `setEvents`/`setDraft` on the unmounted component. **Fix:** create the `AbortController` before the awaits (or check a cancelled flag after each).

### M5 — total telemetry-auth refusal reports healthy

[apps/telemetry-ui/src/app/healthz/route.ts:9](../../apps/telemetry-ui/src/app/healthz/route.ts#L9)

`/healthz` returns a static `{status:"ok"}` without touching the backend or any token, and it is the app's only healthcheck ([apps/telemetry/manifest.json:99](../../apps/telemetry/manifest.json#L99) wires it to the `ui` service; the `backend` service declares none). When `HOSTY_DELEGATED_TOKEN_PUBLIC_KEY` is absent (older Core), `TelemetryCallerAuth.Authenticate` returns null unconditionally and the `/api` filter refuses *every* read with `telemetry_auth_unconfigured` (401). Metrics, Structured logs and Traces are all dead while Core and the Dashboard show `hosty.telemetry` healthy. **Fix:** make the health route (or a dedicated readiness probe) exercise the token/backend path.

### M6 — a superseded delegated-token mint deletes its successor's in-flight entry

[apps/shell/src/app/shell/workspace/delegated-token-intent.ts:76](../../apps/shell/src/app/shell/workspace/delegated-token-intent.ts#L76)

`.finally(() => inFlight.delete(appId))` deletes unconditionally by key. After `invalidateAll()` clears the map and a successor mint re-registers under the same `appId`, the superseded mint's `.finally` deletes the *successor's* entry, so the next `issue()` misses the fast path and mints a duplicate at Core; the later-resolving mint's grant can also overwrite the newer token in the cache. **Fix:** guard the cleanup with an identity check (`if (inFlight.get(appId) === minting) inFlight.delete(appId)`).

### M7 — the auto-allow refresh path diverges from the session-start builder

[apps/ai-gateway/src/sessions/manager.ts:218](../../apps/ai-gateway/src/sessions/manager.ts#L218)

`refreshAutoAllowedFromPolicy` re-implements the "read settings + read providers + `exchange.buildServers`" sequence of `buildMcpServers` ([line 170](../../apps/ai-gateway/src/sessions/manager.ts#L170)), and the two already differ in four ways: (1) the tick omits the `!proxy || !proxyBaseUrl` guard, so with no proxy it repopulates `autoAllowed` that session-start cleared; (2) it has no empty-server branch, so it never `unregister`s a route whose servers vanished; (3) different read order can observe different settings/fleet snapshots; (4) it mints one token per provider and discards them. The security-relevant set — which app tools skip the approval card — is computed twice, so a tool can alternate between asking and running unprompted depending on which path ran last. **Fix:** extract one shared "build servers from policy + fleet" method; keep only the cheap short-circuit unique to the tick.

### M8 — one process-wide handshake lock serializes the connector fan-out

[apps/cli/src/Haas.Hosty.Cli/Mcp/AppMcpClient.cs:51](../../apps/cli/src/Haas.Hosty.Cli/Mcp/AppMcpClient.cs#L51)

`EnsureInitializedAsync` takes the single instance `handshakeGate` semaphore *before* the session-cache check and holds it across up to two full-timeout HTTP round trips, while `ToolCatalog.BuildAsync` fans out through one shared client. N wedged apps therefore cost N × `listTimeout` instead of one, and `remaining` is computed before the gate wait — so the documented "a wedged app costs the fan-out one timeout" budget does not hold, and the client can show zero Hosty tools past its startup timeout. `Forget` additionally blocks a thread-pool thread via `handshakeGate.Wait()` from async code. **Fix:** make the gate per-app (or per-session), and take it only around the initialize itself, after the cache check.

### M9 — a rename rollback never restores the CNAME name

[apps/core/src/Haas.Hosty.Core/CloudflarePublicationReconciler.cs:113](../../apps/core/src/Haas.Hosty.Core/CloudflarePublicationReconciler.cs#L113)

On a rename, step 3 renames the owned CNAME via `UpdateCnameAsync` but `createdDnsId` stays null (the record already exists), so `RollbackPublishAsync` ([line 184](../../apps/core/src/Haas.Hosty.Core/CloudflarePublicationReconciler.cs#L184)) reverts only the tunnel rules and never puts the DNS name back. If a later step throws — realistically `publications.UpsertAsync` on an IO/full-disk error — the new hostname resolves with no route while the old hostname has a route but no DNS record, and the stored publication matches neither. Blast radius is bounded: the record keeps the same id, so re-running the rename or reverting the label self-heals. **Fix:** capture the pre-rename hostname as a rollback token and rename the CNAME back on failure.

### M10 — `state.json` is fully parsed on every authenticated request

[apps/core/src/Haas.Hosty.Core/UserDirectoryStore.cs:21](../../apps/core/src/Haas.Hosty.Core/UserDirectoryStore.cs#L21)

`ReadAsync` does `File.OpenRead` + a full deserialize of the entire user directory (all users, sessions, invitations, assignments) with no cache, and `CoreSessionAuthorization.ResolveSessionAsync` calls it on every authenticated request. `GET /api/apps` pays it twice — once in the gate, once in the handler ([DomainEndpoints.cs:28](../../apps/core/src/Haas.Hosty.Core/DomainEndpoints.cs#L28)) — and with a Shell SSE stream re-reading `/api/apps` on every `app.changed` hint, that is two whole-document parses per event per open tab. **Fix:** cache an in-memory snapshot invalidated on write; the existing `SemaphoreSlim` already serializes writers, so coherence is trivial.

### M11 — the summary reconcile loads the manifest before checking it is needed

[apps/core/src/Haas.Hosty.Core/CoreLifecycleService.cs:5698](../../apps/core/src/Haas.Hosty.Core/CoreLifecycleService.cs#L5698)

`ReconcileRuntimeStateForSummaryAsync` calls `LoadSelectionForAppAsync` — a file read + SHA-256 + full deserialize + validation pass — and only *then* returns early for anything that is not `localCommand`, so every docker app pays the whole load for nothing. `AppManifestService` has no cache, `ListAppsAsync` walks apps sequentially, and localCommand `GetHealthAsync` probes services sequentially — on the endpoint Shell re-reads on every SSE hint. **Fix:** check the profile type (already on the app record) before loading; cache `LoadAsync` by path+mtime; parallelize the fleet loop and the per-service probes.

### M12 — per-request ECDSA key import on every telemetry read

[apps/telemetry-backend/src/Haas.Hosty.TelemetryBackend/Query/TelemetryCallerAuth.cs:148](../../apps/telemetry-backend/src/Haas.Hosty.TelemetryBackend/Query/TelemetryCallerAuth.cs#L148)

`Verify` does `ECDsa.Create()` + `ImportSubjectPublicKeyInfo` on every call, and the auth filter runs on the whole `/api` group — so every metrics/logs/traces/MCP read re-parses the SPKI and allocates a native key handle, at UI refresh rate per open tab. The key is set once in the constructor and never changes. **Fix:** cache the parsed `ECParameters` (or a `ThreadLocal<ECDsa>` — instance members are not thread-safe) and reuse it.

### M13 — the Windows job object has no durable identity for reclaim

[apps/core/src/Haas.Hosty.Core/LocalCommandProcessReclaim.cs:15](../../apps/core/src/Haas.Hosty.Core/LocalCommandProcessReclaim.cs#L15)

`LocalCommandPidFile` models only the POSIX mechanism (`bool ProcessGroup`); the Windows job exists solely as an in-memory `SafeJobHandle`, and its name (`Local\Hosty.LocalCommand.{guid}`) is never persisted. Every Windows pidfile therefore says `ProcessGroup: false`, and reclaim falls to `leader.Kill(entireProcessTree: true)` — the exact API the job object was added (`8870388d`) to replace because it cannot reach a reparented descendant. The moment a Windows tree must outlive Core (a keep-apps light restart for a localCommand app), there is no durable identity to reclaim through, and the startup sweep deletes the pidfile while the tree keeps the port. **Fix:** persist a platform-neutral tree token (pgid *or* job name) and resolve it back to a kill in one owner.

---

## Low — correctness & hardening

### L1 — `ToolKey.Escape` is not injective

[apps/cli/src/Haas.Hosty.Cli/Mcp/ToolKey.cs:112](../../apps/cli/src/Haas.Hosty.Cli/Mcp/ToolKey.cs#L112)

The `_x` fallback emits `((int)c).ToString("x2")`, a *minimum* width — two hex digits for chars ≤ 0xFF, four above — so `Escape("中") == Escape("N2d") == "_x4e2d"` (uppercase `N`=0x4E escapes, `2`/`d` pass through). A collision drops the second app's tools at the `claimed.Add` check in `ToolCatalog.BuildAsync` with a warning that blames "a bug in ToolKey". Unreachable via a validated manifest (Core's id pattern is `[a-z0-9._-]`), but the escape's stated purpose is to survive a hand-edited registry, which is exactly the case it fails. **Fix:** fixed-width `"x4"` or a length prefix.

### L2 — the launch-code staleness guard compares a value to itself

[apps/shell/src/app/shell-client.tsx:1814](../../apps/shell/src/app/shell-client.tsx#L1814)

In `handleAuthRequired`, `const current = workspace` ([1790](../../apps/shell/src/app/shell-client.tsx#L1790)) and `const stillCurrent = workspace` ([1814](../../apps/shell/src/app/shell-client.tsx#L1814)) read the same `useState` snapshot in one closure invocation, so `stillCurrent.path !== current.path` can never fire. A launch-code response arriving after the operator switched apps re-mounts the old app's frame over the new one — a wrong-frame flash plus a redundant `/launch-code` round trip, self-corrected by the route effect. `launchAppPage` ([1532](../../apps/shell/src/app/shell-client.tsx#L1532)) does it correctly by re-reading `window.location.href`. **Fix:** re-read the live location (or a ref), not the captured state.

### L3 — the connector drops id-bearing requests with no JSON-RPC answer

[apps/cli/src/Haas.Hosty.Cli/Mcp/StdioMcpServer.cs:59](../../apps/cli/src/Haas.Hosty.Cli/Mcp/StdioMcpServer.cs#L59)

The request-loop catch-all writes a stderr diagnostic and continues without emitting a response, so a `tools/call` that throws (e.g. the delegated-token fetch in `AppMcpClient.SendAsync` at [line 140](../../apps/cli/src/Haas.Hosty.Cli/Mcp/AppMcpClient.cs#L140), outside the guarded `PostAsync`) leaves an outstanding id with neither result nor error, stalling the model's turn until the client's own timeout. **Fix:** emit a JSON-RPC internal-error response whenever the failed message carried an id.

---

## Low — efficiency

- **L4 — per-request `JsonSerializerOptions` in the auth path.** [TelemetryCallerAuth.cs:167](../../apps/telemetry-backend/src/Haas.Hosty.TelemetryBackend/Query/TelemetryCallerAuth.cs#L167) constructs `new JsonSerializerOptions(Web)` on every token read, rebuilding the metadata cache each time; it is also the one reflection-based `Deserialize` breaking the project's stated AOT-clean invariant. Hoist to `static readonly` (or a source-gen context).
- **L5 — fleet-traces parses span attributes it never reads.** [SqliteTelemetryStore.cs:404](../../apps/telemetry-backend/src/Haas.Hosty.TelemetryBackend/Telemetry/SqliteTelemetryStore.cs#L404) selects `attrs_json` and `ReadSpans` deserializes it for up to 20k rows under the ingest-contended `gate` lock, but `TraceAccumulator` never touches `Attributes` — stalling OTLP ingest during a UI refresh. Give the summary path a projection without `attrs_json`.
- **L6 — `get_app` reconciles the whole fleet for one app.** [McpEndpoints.cs:88](../../apps/core/src/Haas.Hosty.Core/McpEndpoints.cs#L88) runs `ListAppsAsync` then `FirstOrDefault`, amplifying M11 per call on the connector path. Needs a small public single-app summary API (`BuildAppSummaryAsync` already accepts a null snapshot for this case).

---

## Low — reuse & simplification

The recurring cost here: a security or contract fix has to be found and applied in every copy, or it is silently incomplete.

- **L7 — the app-to-Core auth prologue is copied 8×.** The `ReadBearerToken → ValidateToken → 401 → GetAppAsync → 404` gate appears four times in [DomainEndpoints.cs](../../apps/core/src/Haas.Hosty.Core/DomainEndpoints.cs#L52) (52, 84, 129, 191) and again in `AppDirectoryEndpoints`, `AppBackupEndpoints`, `NotificationEndpoints`, and `AppSecretsEndpoints` — the last of which already extracted the shareable form as `Authorize`. Adding a step (reject a disabled app's token, an audit line, constant-time compare) is eight edits with no compiler help.
- **L8 — the OS-aware path-containment check exists 4×.** `PathEqualsOrWithin` is byte-identical in [CoreLifecycleService.cs:883](../../apps/core/src/Haas.Hosty.Core/CoreLifecycleService.cs#L883) and [MountPathPolicy.cs:196](../../apps/core/src/Haas.Hosty.Core/MountPathPolicy.cs#L196) (whose header names `CoreLifecycleService` as a consumer), with two more inlinings at `CoreLifecycleService.cs:3600` and `LocalCommandRuntimeAdapter.cs:781`. A containment hardening (trailing separators, Unicode, Windows 8.3 names) must land in four places — miss one and it is a path-escape hole in the un-audited copy.
- **L9 — demo-app hand-rolls the SDK session-auth flow.** [apps/demo-app/src/lib/host-auth.ts:123](../../apps/demo-app/src/lib/host-auth.ts#L123) is ~545 lines duplicating `@hosty-sdk/app/server` (`resolveAppSession`, `readAppIdentityToken`, `HOSTY_APP_IDENTITY_HEADER`), which demo-app already depends on; marketplace and telemetry-ui were migrated, demo-app is the last copy and has already drifted (no 30s cache, `"error"` vs `"misconfigured"`, no `core_response_invalid` guard). The app that *demonstrates* the contract is the one running a stale copy of it.
- **L10 — a second Core-side JSON options + AOT lookup.** [HostyCoreApplication.cs:1744](../../apps/core/src/Haas.Hosty.Core/HostyCoreApplication.cs#L1744) duplicates `JsonStorage.Options` plus two inlined `TypeInfo<T>()` lookups; any option added to `JsonStorage.Options` silently skips `control.json`, the CLI cross-process contract.
- **L11 — `AppIdentityTokenService.ResolveAppId` is dead.** [AppIdentityTokenService.cs:51](../../apps/core/src/Haas.Hosty.Core/AppIdentityTokenService.cs#L51) has only test callers; its round-trip test proves nothing about the real verifier (`TelemetryCallerAuth`, an independent implementation). A change to the signing input keeps Core's tests green while every app's telemetry read starts 401-ing. Delete it and pin the format against the real verifier.
- **L12 — the delegated-token handshake constants are hardcoded in the settings page.** [apps/ai-gateway/src/settings/page.ts:89](../../apps/ai-gateway/src/settings/page.ts#L89) inlines `"hosty:delegated-token"` / `"hosty:request-delegated-token"` instead of interpolating the SDK constants it already imports elsewhere; a protocol version bump desyncs only this page, whose failure message cannot distinguish the case. The SDK's own inline bootstrap shows the interpolation pattern.
- **L13 — telemetry-MCP window caps and app-filter are duplicated.** [TelemetryMcpEndpoint.cs:192](../../apps/telemetry-backend/src/Haas.Hosty.TelemetryBackend/Query/TelemetryMcpEndpoint.cs#L192) passes clamp caps as bare literals shadowing private `TelemetryQueryService` consts (the comment at 155-157 records this drift already happened once, 100 vs 50), and `ParseApps` ([line 216](../../apps/telemetry-backend/src/Haas.Hosty.TelemetryBackend/Query/TelemetryMcpEndpoint.cs#L216)) duplicates `Program.cs`'s `ParseAppFilter`, already diverged on `.Distinct`. Move both onto the query service.
- **L14 — `RestoreIngress` duplicates the insert-before-catch-all half of `UpsertIngress`.** [CloudflareTunnelConfigPatcher.cs:71](../../apps/core/src/Haas.Hosty.Core/CloudflareTunnelConfigPatcher.cs#L71) restates the placement rule and the AOT `(JsonNode)` cast twice; the copy in the rarely-run rollback path is the one that will silently drift.
- **L15 — `openFeedInstallDialog` duplicates `openInstallDialog`'s five state resets.** [apps/shell/src/app/shell-client.tsx:1771](../../apps/shell/src/app/shell-client.tsx#L1771); the two mutually-exclusive intent fields must stay in lockstep with the dialog remount key at line 2008. One opener + one `installSource` field removes the invariant.
- **L16 — the app-id fallback is re-derived per app.** [apps/marketplace/src/lib/installed-apps.ts:12](../../apps/marketplace/src/lib/installed-apps.ts#L12) (and :52, and telemetry-ui `roster.ts:11`) recompute `process.env.HOSTY_APP_ID?.trim() || "hosty.<app>"` instead of the SDK's `getAppId(config)` against the app's existing `hostyAppConfig`; if the fallback ever changes, session-auth and service-token calls can resolve different ids and Core answers 401 for the app's own data.

---

## Low — altitude

- **L17 — first-party bootstrap is per-id `switch`, not the data it claims to be.** [SystemAppBootstrap.cs:71](../../apps/core/src/Haas.Hosty.Core/SystemAppBootstrap.cs#L71) hardcodes `ShellBootstrap.AppId`/`CollectorBootstrap.AppId` arms (and two more per-id switches at `LegacyEnabled`/`ApplyLegacyManifestOverride`) despite the file's "a list entry, not a code path" header; only `hosty.shell` can ever get a dev source override, because `config.ShellSourceOverridePath` is the sole source. Drive `Runtime`/`Autostart`/`SourceOverridePath` from a keyed convention or from the distribution entry.
- **L18 — a second health-summary fold with a silent divergence.** [LocalCommandRuntimeAdapter.cs:382](../../apps/core/src/Haas.Hosty.Core/LocalCommandRuntimeAdapter.cs#L382) inlines a copy of `RuntimeAppManifest.SummarizeHealthStatus` that maps all-`exited` to `"unhealthy"` where the shared one yields `"unknown"`; the localCommand-only `"exited"` status is a vocabulary the shared summarizer lacks. Unify on one `AppRuntimeServiceHealth.Status` vocabulary across adapters rather than forking the fold.
- **L19 — the install-feed gate hardcodes `hosty.marketplace`.** [apps/shell/src/app/shell/workspace/install-intent.ts:8](../../apps/shell/src/app/shell/workspace/install-intent.ts#L8) gates on a literal app id while its sibling `delegated-token-intent.ts` already keys on a declared interface (with a comment about replaceability). A forked or vendor-namespaced catalog app posts a well-formed `hosty:install-feed` that Shell drops before parsing, with no error surface. Gate on a manifest-declared capability.

---

## Low — documentation & conventions (AGENTS.md)

The version checkers and the docs index both pass; these are rule violations the scripts do not enforce.

- **L20 — unfinished work parked as prose, not as a plan deliverable.** AGENTS.md: *"Unfinished work exists only as unchecked deliverables — never hidden in notes, 'future work' sections, or follow-up remarks."* Violated by [telemetry-mcp/feature.md:143](../../docs/features/telemetry-mcp/feature.md#L143) ("Not yet verified live" — two outstanding checks in `## Testing Expectations`, no `plan.md`), [core-app-shell/feature.md:142](../../docs/features/core-app-shell/feature.md#L142) (future-work pointer into `docs/ideas/`), and [access-tokens/feature.md:176](../../docs/features/access-tokens/feature.md#L176) ("It was planned… would first require…").
- **L21 — a feature.md uses `## Testing Plan`, not `## Testing Expectations`.** AGENTS.md requires the latter section; [shell-access-and-system-apps/feature.md:92](../../docs/features/shell-access-and-system-apps/feature.md#L92) is the only feature.md missing it, and the docs-index script does not validate section names, so `--check` passes it.
- **L22 — a legacy flat doc carries a free-text status.** [manifest-level-app-assets.md:3](../../docs/features/manifest-level-app-assets.md#L3) has `Status: **In progress.**` (outside the permitted plan.md vocabulary and forbidden on a reality doc) plus a "Only follow-up left…" remark carrying two deliverables and no `plan.md`. `docs/root.md` mirrors the free-text status into the generated index.
- **L23 — `docs/reviews/` is outside the documented layout.** AGENTS.md: *"There are no other documentation folders,"* and the lazy-migration exemption lists only `docs/features/*.md`, `docs/ideas/`, `docs/planning/`. This folder (and this review) is ungoverned by the docs workflow and never appears in the generated index — a known, accepted gap worth either legitimizing in AGENTS.md or moving under a feature.

---

## Refuted

- **The interrupted-update boot sweep does not drop an admin notification.** Candidate claimed a regression; `git show d2009d9e` shows the update-applied/failed advisories were removed from *both* the background apply path and the boot sweep deliberately, and both paths surface failure the same way — by writing `OperationStatus = "failed"` + `LastError` to the app record ([CoreLifecycleService.cs:3482](../../apps/core/src/Haas.Hosty.Core/CoreLifecycleService.cs#L3482)). Whether the reboot-mid-apply case *should* additionally hit the inbox is a product judgment, not a defect in this path.

---

## Recommended remediation order

1. **The ai-gateway approval boundary (H1, H2).** Confirm the SDK's sub-agent and permission-rule semantics against 0.3.232, then close whichever holes are real and fix the "read-only" mislabel regardless. Highest security return, small code.
2. **localCommand setup (H4, H5) and the log-tail (M1).** One focused pass on `LocalCommandRuntimeAdapter`: bound the setup wait, route setup teardown through the group/job kill, give it a pidfile, and move the log-writer dispose after EOF. Retires an availability class and a diagnostics class together.
3. **Token audience (H3) and the credential purge (H6).** Both are small, security-shaped, and cheap: add `aud` to the identity token; delete `contexts.json` only after its names were read and their keychain items removed.
4. **The connector reliability pair (H7, M8).** Catch transport exceptions in the poll loop; make the handshake gate per-app. Together they make the connector survive a Core restart and a wedged app.
5. **The honesty and health contracts (M2, M3, M5).** Surface the scan cap in `truncated`; wrap the `/api/mcp` parse in the JSON-RPC envelope; make `/healthz` exercise the auth/backend path.
6. **The hot-path parses (M10, M11, M12).** Cache `state.json`, the manifest, and the ECDSA key; these compound under the Shell's SSE re-read storm.
7. **The duplication seam (L7–L16), front-loading the security-relevant copies (L7 auth prologue, L8 path containment, L9 demo-app auth).** Extract before the next auth change, so that change lands once.

## Verification performed

- Static review only; no source changed, no exploit run.
- Every finding above was independently re-verified against the baseline source after the finder pass; `plausible` marks the two items whose final impact depends on SDK-internal behavior not inspectable in this repository.
- `node scripts/docs-index.mjs --check` → pass. `node scripts/check-versions.mjs` → "Version consistency OK."

## Limitations

- The pinned `@anthropic-ai/claude-agent-sdk` is not installed in the tree, so H1/H2's exact runtime effect (whether a loaded permission rule or a sub-agent tool call bypasses `canUseTool`) could not be confirmed from source; both are filed conservatively as `plausible` with the confirmed half stated.
- Line anchors refer to baseline `50e9175c`; locate by symbol if the tree has moved.
- Native clients (`apps/shell-swift`, `apps/shell-cardputer`) and CI/release workflows were out of scope.

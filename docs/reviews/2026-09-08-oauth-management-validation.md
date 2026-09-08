# OAuth Management And Scope Validation

Date: 2026-09-08
Baseline: `e4efc205` (the committed OAuth management, credential identification and
selectable-consent implementation validated by this report).

This report describes local validation, not deployment to production. Platform version: 0.98.0;
Shell version: 0.70.0. No production deployment was made.

## Automated Results

- `dotnet test apps/core/tests/Haas.Hosty.Core.Tests/Haas.Hosty.Core.Tests.csproj --no-restore`:
  1,783 passed, zero failures. Two additional app/facade refusal cases were then added; the final
  targeted `--filter FullyQualifiedName~OAuthHttpTests` run passed all 36 OAuth HTTP cases.
- `dotnet build apps/core/src/Haas.Hosty.Core/Haas.Hosty.Core.csproj --no-restore`: passed after fixes. Native AOT (`npm run core:aot`) published osx-arm64 without new
  trim/AOT warnings. Existing unused-parameter/platform warnings remain; an initial restore could
  not fetch NuGet vulnerability metadata in the restricted environment.
- `npm run shell:test`: 103 passed. Final `npm run shell:lint`: zero errors, two existing Next.js
  navigation warnings in unrelated files.
- `npm run shell:build`: Turbopack failed because its PostCSS worker could not bind a service port
  (`Operation not permitted`), including the elevated retry. The production fallback
  `npm run build --workspace @haas/hosty-shell -- --webpack` passed, including TypeScript checks.
- Version consistency and `git diff --check`: passed. Documentation index regenerated and checked.

Coverage includes selected consent subsets, actual token scopes, Core-only scope/audience checks,
AS catalog versus read-only PRM, rejected refresh scopes leaving the refresh token usable, narrowed
access tokens retaining grant authority, and browser/CSRF refusals. Deletion tests cover exact-id
isolation, pending-code invalidation, concurrent code/refresh issuance, retry, interrupted durable
revocation and startup recovery. A storage I/O failure leaves authenticated activity requests
successful, while failed revocation recovery aborts startup; restoring storage completes revocation
and closes the associated stream. Credential tests cover device/manual/OAuth labels, unchanged
identity/authority, first request activity, per-grant throttling and session-prune persistence.

## Local Core And Shell

The final environment used `http://127.0.0.1:3341` for Core and `http://127.0.0.1:3340` for Shell,
with a fresh data root under `/private/tmp/hosty-oauth-validation/data3`. Shell was installed and
started by Core from a disposable manifest using the repository's built Shell. Only Shell was
enabled in the temporary distribution catalog. A separate `com.hosty.oauth-probe` app used an
assigned loopback port and Python's HTTP server, also installed and started through Core.

Browser observations through the Codex in-app browser:

- Two registrations named Codex appeared as distinct groups, with exact registration ids and
  distinct grant fingerprints. OAuth, device and manual credentials were clearly separated.
- Renaming the expanded Codex grant to `Codex — test MacBook` preserved its fingerprint and all
  three scopes. Device and manual labels were also edited and remained in their own groups.
- Actual MCP requests populated Last authenticated request. Refresh populated Last refresh without
  adding a credential row; labels and fingerprints survived rotation.
- Revocation confirmation identified the old read grant by label, fingerprint and permissions.
  Revoking it removed only that row: its token subsequently returned 401 while the newer labeled
  grant still initialized MCP with 200.
- An unused client was deleted through confirmation and disappeared from the active list. Deleting
  one active Claude registration identified its grant and left the same-name other registration.
- Consent initially required read and left lifecycle/update unchecked. Submitting unchanged issued
  exactly `mcp:read`; checking both options issued all three scopes. Deny returned `access_denied`
  and issued no token. These flows used the actual Core code exchange and a loopback callback.
- A screenshot exposed overflow in the existing create form at the narrow browser width. The form
  now wraps its controls; the final Shell build includes that small responsive correction.

Direct calls using the disposable OAuth-issued credentials confirmed: both could call `list_apps`;
the read credential was refused by `start_app` and `plan_app_update`; the expanded credential
started the disposable app. Its update-plan call passed the scope guard and returned the expected
source-runtime limitation. Applying a compiled-image update was not performed in this source-app
fixture; this run does not claim such an update occurred.

After restarting the same temporary Core, grant ids, labels, scopes and revocations were unchanged.
The removed Claude connection was no longer connected; the other connected successfully. A further
local deletion invalidated both a parked consent request and an already-issued authorization code.

## Stock Client Isolation And Results

Claude Code 2.1.263 ran twice with separate temporary `CLAUDE_CONFIG_DIR` directories, fresh local
MCP configuration and a macOS sandbox that denied outbound networking except loopback. Both
requested all three scopes. Core granted read to one and all three to the other; both completed
OAuth login and `claude mcp get local_probe` reported Connected. Expiring only their disposable
server-side access sessions forced refresh/reconnect; both reconnected and retained their original
granted scopes. The directories also isolate the macOS credential entry as documented by
[Claude Code authentication](https://code.claude.com/docs/en/authentication#credential-management).
No model-backed Claude tool invocation is claimed here; Core tool gates were exercised directly.

The isolated Codex probe did **not** run. Automatic approval review rejected creation/execution of
its launcher because this agent session forbids overriding `CODEX_HOME`. The agent did not bypass
that rejection or fall back to the production configuration. The earlier compatibility probe is
separate evidence and is not substituted for this missing Core integration run. The remaining
Codex check is tracked in [the scopes plan](../features/oauth-core-control-scopes/plan.md).

## Cleanup

Both isolated Claude MCP profiles were logged out. All disposable OAuth clients and credentials
were explicitly revoked. The disposable app, Shell and Core were stopped; no listener remained on
3340/3341. Temporary credential/configuration directories were removed after retaining sanitized
results. The user's primary local Hosty was not restarted, and no production MCP call or deployment
was part of this validation.

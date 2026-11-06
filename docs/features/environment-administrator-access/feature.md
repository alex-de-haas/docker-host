---
created: 2026-11-03
updated: 2026-11-03
summary: Owners obtain ordinary child Core setup or recovery links from Dashboard without knowing agent-created passwords.
components: [apps/core, apps/shell]
---

# Environment Administrator Access

Dashboard shows **Get access** for every running owned Core environment, including agent-created
children without distribution initialization and children with an existing administrator. Stop and
Restart remain in the row menu. Stopped and transitional environments cannot issue access links.

The action opens the child's ordinary setup page for an empty user directory or recovery page for
an existing directory. Recovery with a new email creates a separate administrator; recovery with
an existing email changes its password and revokes its sessions. Shell explains that distinction.
No account changes occur merely by obtaining a link. The existing first-administrator setup-link
operation retains its original behavior for other clients.

## Authorization And Transport

`POST /api/core-environments/{id}/access-link` checks the current administrator, environment owner,
standing consent and running process. Browser mutations require the normal cookie/CSRF checks.
Installed operator clients need environment operate and API permissions; direct scoped clients need
`mcp:environments-read`, `mcp:environments-manage` and `mcp:environment-api`. Shell declares
`core.environments.api` alongside its existing environment permissions, subject to ordinary app
permission review. Other parent users receive no access or invitation authority from this action.

The parent serializes issuance with the environment lifecycle and uses the child's verified
loopback control endpoint, allocated port and live process identity. It reads the ordinary
initialization status, then calls the existing `auth/setup-token` or `auth/recovery-token` operation.
The child keeps its normal users, token store and authentication; no parent credentials, shared
sessions, new child login mode or parent trust relationship are introduced.

The returned browser URL is constructed from the registry-owned child preview origin and token,
never from a child-supplied public URL. Shell also checks the exact child origin, page path, token
and expiry before opening it. Responses are non-cacheable. Links and tokens remain in UI memory,
are cleared on expiry or environment scope/lifecycle change, and late results cannot open a stopped
or replaced environment. A setup link is cleared after administrator registration is observed.
A blocked popup has an explicit Open access page action and copy controls in the access dialog.
Tokens use the child's existing fifteen-minute, single-use setup/recovery lifecycle. Issuing a
replacement invalidates the previous pending token of the same kind.

This extends the [environment controls](../unified-sandbox-environments/feature.md) and uses
[local password login](../local-password-login/feature.md). Environment ownership and the existing
[trusted child Core model](../app-sandbox-runtimes/feature.md) remain applicable.

## Verification Record

Verified on 2026-11-03 on macOS arm64 with Linux Docker application containers:

- `dotnet test apps/core/tests/Haas.Hosty.Core.Tests/Haas.Hosty.Core.Tests.csproj --filter 'FullyQualifiedName~CoreEnvironmentHttpTests|FullyQualifiedName~AuthBootstrapServiceTests|FullyQualifiedName~AuthEndpointsTests'`: 67 passed.
- `npm run shell:test`: 207 Node tests and 814 component tests passed. The focused Dashboard
  and initialization selection also passed all 40 cases after the final UI changes.
- `npm run shell:build`, the final Core build and the integration suite's Core/CLI and Shell
  Docker builds passed. `npm run shell:lint` has no errors and three existing unrelated warnings.
- `npm run test:integration -- shell`: passed with the real Shell permission and CSRF checks,
  child setup, second-admin recovery, both password logins, token reuse and parent rejection.
  The first attempt omitted Shell's CSRF token in the new test request and correctly received
  403; the fixture was corrected without relaxing application authorization.
- A separate Chromium session signed in normally through Core/Shell, used Get access for an
  empty agent-style child, registered its first administrator, requested recovery after setup,
  created a second administrator, and signed in with that account's password. The button stayed
  visible after registration and disappeared after Stop. The desktop layout was inspected.
- Dashboard Finish removed the browser child's data root and listener. The integration owner
  then confirmed removal of child resources, processes, ports, credentials and fixture roots.
  Shell became healthy in 3.0 seconds. No live Hosty lifecycle or ordinary app data was changed.
- Version consistency, documentation/link validation and `git diff --check` passed. Platform
  version changes from 0.169.3 to 0.170.0; Shell changes from 0.119.1 to 0.120.0.

The full unrelated Core suite, NativeAOT and native Windows/Linux-host checks were not run for
this change; the affected HTTP/authentication tests, managed runtime and browser checks establish
only the platforms and paths above.

## Testing Expectations

- Verify owner and non-owner boundaries, missing environment API permission, anonymous requests,
  stopped children and non-cacheable replies through the real Core HTTP pipeline.
- Cover setup, recovery-required directories, initialized and agent-created children, persistent
  Get access, expired links, foreign destinations and responses arriving after Stop in Shell.
- Run `npm run test:integration -- shell` in a registered workspace. Its managed child scenario
  uses Shell's real app session and CSRF protection, adds a second administrator through recovery,
  verifies both password logins, rejects a child token at its parent and rejects token reuse.
- Check the visible Dashboard action and ordinary setup/recovery pages in a managed browser fixture.
  Finish owned children through their manager and verify resource removal.

# Feature: Automatic Runtime App Ports

Created: 2026-06-05
Updated: 2026-07-14

## Goal

Prevent runtime apps from colliding on hard-coded development ports. Core should assign available host ports by default, expose those ports through environment variables, keep Shell launch URLs aligned with the actual assigned endpoint, and reuse stored automatic ports across restarts.

## Non-goals

- A separate Core API for apps to request ports before lifecycle start.
- Removing explicit `localPort` / `hostPort` overrides from the manifest contract.
- Proxying all app traffic through a single shared gateway port.

## Current Behavior

Core already allocates an available loopback port when a service port does not declare `localPort` or `hostPort`. It exposes that assignment as `HOSTY_PORT_{KEY}` and stores the resulting endpoint URL after start.

Older examples still hard-coded dev ports in app manifests and scripts. When two apps copied the same example, both declared the same local port and Shell could open the wrong app because one app failed to bind while the stale endpoint still pointed at the occupied port.

## Proposed Behavior

Runtime app manifests should omit `localPort` and `hostPort` unless a specific host port is required. Core assigns an available host port for each declared service port on first successful start and reuses the stored endpoint port on later start/restart operations.

For each assigned port Core injects:

- `HOSTY_PORT_{KEY}` for all declared port keys.
- `PORT` when a `localCommand` service has exactly one assigned port and the app did not explicitly define `PORT` through runtime environment or settings.

Explicit `localPort` / `hostPort` values remain supported for cases where a fixed port is required. Core checks explicit local command ports before starting the process and fails with a clear lifecycle error when the port is already in use.

The app-level `HOSTY_PORT_{KEY}` setting remains supported as a manual override for single-service apps or apps whose port keys are unique at app scope. For multi-service apps with repeated service-local port keys such as `http`, sticky endpoint URLs preserve separate per-service assignments without requiring global settings.

## User/API Scenarios

- A single-port Next.js runtime app declares one `http` port without `localPort`. Core assigns a free port, injects `PORT`, and `npm run dev` can bind to the assigned port.
- A multi-service app declares `api.http` and `web.http` without fixed ports. Core assigns each service independently and injects the service-local `HOSTY_PORT_HTTP`.
- A runtime app restarts after its first successful start. Core reuses the previous endpoint URL port so reverse proxies and direct local bookmarks do not need to change.
- An app intentionally declares `localPort: 3100`, but another process already listens on 3100. Core fails start with `local_command_port_unavailable` and records the app as stopped/failed.
- Shell opens an app using the endpoint URL stored after Core successfully starts the runtime.

## Technical Design

Runtime adapters assign ports during start. The assigned port is added to endpoint metadata and injected into the service environment before the runtime starts.

Before allocating a new automatic port, Core checks the installed app's stored endpoint URLs for an endpoint with matching `service` and `port` metadata. If a previous endpoint URL exists, Core reuses that URL's port. This makes automatic ports sticky per installed app, service, and port key without adding a new manifest field.

When exactly one port is assigned to a service and no explicit `PORT` exists in runtime environment or app settings, Core sets `PORT` to the assigned host port. This keeps common frameworks such as Next.js working without requiring every manifest to wrap commands with shell-specific `PORT=$HOSTY_PORT_HTTP` syntax.

For fixed local command ports and sticky stored local command ports, Core attempts to bind loopback IPv4 and IPv6 before starting the process. A failed bind means the port is already occupied or invalid, so start fails before the app command runs instead of silently changing the app URL. Docker starts use the same sticky port resolution and rely on Docker's port binding failure when the port cannot be reused.

Start and restart lifecycle failures update app state with:

- `runtimeState: "stopped"`
- `operationStatus: "failed"`
- `lastOperation: "start"` or `"restart"`
- `lastError` containing the failure message

## Data Model / API Changes

No manifest schema change is required. Existing `ports[].localPort` and `ports[].hostPort` remain valid optional overrides.

No new persistent model is required. Sticky automatic assignments are derived from the installed app endpoint URLs that Core already stores after successful runtime start.

The effective runtime environment gains the compatibility variable `PORT` for single-port local command services.

## Edge Cases

- If a service declares multiple ports, Core does not infer `PORT`; the app must read `HOSTY_PORT_{KEY}`.
- If the manifest or settings explicitly define `PORT`, Core does not overwrite it.
- If a fixed port becomes occupied between preflight and process bind, the process may still fail; app health and logs remain the diagnostics source.
- If a sticky automatic port is occupied by another process, Core fails start with `local_command_port_unavailable`. Administrators can stop the conflicting process, clear/reinstall the app endpoint state, or configure an explicit port override.
- Docker runtime ports are also sticky after the first successful start when Docker ports omit host mapping.

## Testing Plan

- Unit test that local command start injects matching `PORT` and `HOSTY_PORT_HTTP` for a single-port service.
- Unit test that local command stop/start and restart reuse the stored automatic endpoint port.
- Unit test that an occupied explicit `localPort` fails start and records stopped/failed state.
- Regression test existing local command health, logs, source override, and endpoint storage behavior.
- Manual validation through Core-managed Demo App start and Shell open.

## Rollout / Migration Notes

Demo App no longer hard-codes dev ports in its manifest. App authors should remove fixed local ports from `localCommand` manifests unless a fixed port is part of the app contract.

Existing installed apps that already have copied manifests under Core data roots need reinstall/update/restart from an updated manifest to get auto-assigned ports.

## Decision

Core does not inject endpoint URLs such as `HOSTY_ENDPOINT_HTTP_URL` in this feature. `HOSTY_PORT_{KEY}` and stored endpoint metadata solve the current local collision problem.

## Links

- [Install-Time Runtime Port Reservations](../ideas/install-time-runtime-port-reservations.md) — exploratory
  replacement for first-start allocation that would reserve and expose ports during installation.

# Feature: Automatic Runtime App Ports

## Goal

Prevent local runtime apps from colliding on hard-coded development ports. Core should assign available host ports for `localCommand` services by default, expose those ports through environment variables, and keep Shell launch URLs aligned with the actual assigned endpoint.

## Non-goals

- Persistent port reservations across Core restarts.
- A separate Core API for apps to request ports before lifecycle start.
- Removing explicit `localPort` / `hostPort` overrides from the manifest contract.
- Proxying all app traffic through a single shared gateway port.

## Current Behavior

Core already allocates an available loopback port when a service port does not declare `localPort` or `hostPort`. It exposes that assignment as `HOSTY_PORT_{KEY}` and stores the resulting endpoint URL after start.

Older examples still hard-coded dev ports in app manifests and scripts. When two apps copied the same example, both declared the same local port and Shell could open the wrong app because one app failed to bind while the stale endpoint still pointed at the occupied port.

## Proposed Behavior

Runtime app manifests should omit `localPort` and `hostPort` for normal local development. Core assigns an available port for each declared service port.

For each assigned port Core injects:

- `HOSTY_PORT_{KEY}` for all declared port keys.
- `PORT` when a `localCommand` service has exactly one assigned port and the app did not explicitly define `PORT` through runtime environment or settings.

Explicit `localPort` / `hostPort` values remain supported for cases where a fixed port is required. Core checks explicit local command ports before starting the process and fails with a clear lifecycle error when the port is already in use.

## User/API Scenarios

- A single-port Next.js runtime app declares one `http` port without `localPort`. Core assigns a free port, injects `PORT`, and `npm run dev` can bind to the assigned port.
- A multi-service app declares `api.http` and `web.http` without fixed ports. Core assigns each service independently and injects the service-local `HOSTY_PORT_HTTP`.
- An app intentionally declares `localPort: 3100`, but another process already listens on 3100. Core fails start with `local_command_port_unavailable` and records the app as stopped/failed.
- Shell opens an app using the endpoint URL stored after Core successfully starts the runtime.

## Technical Design

`LocalCommandRuntimeAdapter` assigns ports during start. The assigned port is added to endpoint metadata and injected into the process environment before the command starts.

When exactly one port is assigned to a service and no explicit `PORT` exists in runtime environment or app settings, Core sets `PORT` to the assigned host port. This keeps common frameworks such as Next.js working without requiring every manifest to wrap commands with shell-specific `PORT=$HOSTY_PORT_HTTP` syntax.

For fixed local ports, Core attempts to bind loopback IPv4 and IPv6 before starting the process. A failed bind means the port is already occupied or invalid, so start fails before the app command runs.

Start and restart lifecycle failures update app state with:

- `runtimeState: "stopped"`
- `operationStatus: "failed"`
- `lastOperation: "start"` or `"restart"`
- `lastError` containing the failure message

## Data Model / API Changes

No manifest schema change is required. Existing `ports[].localPort` and `ports[].hostPort` remain valid optional overrides.

The effective runtime environment gains the compatibility variable `PORT` for single-port local command services.

## Edge Cases

- If a service declares multiple ports, Core does not infer `PORT`; the app must read `HOSTY_PORT_{KEY}`.
- If the manifest or settings explicitly define `PORT`, Core does not overwrite it.
- If a fixed port becomes occupied between preflight and process bind, the process may still fail; app health and logs remain the diagnostics source.
- Docker runtime behavior remains unchanged except for the existing automatic host port allocation when Docker ports omit host mapping.

## Testing Plan

- Unit test that local command start injects matching `PORT` and `HOSTY_PORT_HTTP` for a single-port service.
- Unit test that an occupied explicit `localPort` fails start and records stopped/failed state.
- Regression test existing local command health, logs, source override, and endpoint storage behavior.
- Manual validation through Core-managed Demo App start and Shell open.

## Rollout / Migration Notes

Demo App no longer hard-codes dev ports in its manifest. App authors should remove fixed local ports from `localCommand` manifests unless a fixed port is part of the app contract.

Existing installed apps that already have copied manifests under Core data roots need reinstall/update/restart from an updated manifest to get auto-assigned ports.

## Open Questions

- Should assigned ports become sticky per installed app?
  Recommended answer: not in this change. Add sticky reservations only if users need stable direct-origin bookmarks.

- Should Core inject endpoint URLs such as `HOSTY_ENDPOINT_HTTP_URL`?
  Recommended answer: defer. `HOSTY_PORT_{KEY}` and stored endpoint metadata solve the current local collision problem.

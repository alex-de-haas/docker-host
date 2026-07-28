# Feature: Automatic Runtime App Ports

Created: 2026-06-05
Updated: 2026-07-28

Runtime apps do not hard-code host ports. Core assigns an available host port to every declared
service port, exposes it to the app through the environment, and keeps the stored endpoint URL
pointing at the port the app actually got. Manifests omit `localPort` / `hostPort` unless a fixed
port is part of the app's contract.

## Assignment

A declared port without an explicit `localPort` / `hostPort` is reserved at install, before the app
has ever started: a stopped app already carries durable endpoint URLs, and its ports are excluded
from every other app's allocation
([CoreLifecycleService.cs:422](../../../apps/core/src/Haas.Hosty.Core/CoreLifecycleService.cs),
[RuntimePortAllocator.cs](../../../apps/core/src/Haas.Hosty.Core/RuntimePortAllocator.cs)).

Start resolves each port to the first source that answers
([RuntimePortHelper.TryResolvePinnedHostPort](../../../apps/core/src/Haas.Hosty.Core/RuntimePortHelper.cs)):

1. the service-scoped `HOSTY_PORT_{SERVICE}_{KEY}` setting, then the app-scoped `HOSTY_PORT_{KEY}` —
   an operator override; the service-scoped form wins because the app-scoped one cannot express a
   port key such as `http` that two services in the same app both declare;
2. the manifest's explicit `localPort` / `hostPort`;
3. the install-time reservation for that service and port key;
4. the port inside an endpoint URL stored by an earlier start — the fallback for records that
   predate the reservation model, or for a port added to a manifest after install.

Ports are resolved for every service of an app in one pass before any process binds, so two
not-yet-started siblings cannot be handed the same port.

## Environment

- `HOSTY_PORT_{KEY}` carries the assigned host port for every declared port key, in both runtimes.
- `PORT` is set for a `localCommand` service that has exactly one assigned port, unless the manifest
  runtime environment or an app setting already defines `PORT`. This keeps frameworks such as
  Next.js working without every manifest wrapping its command in shell-specific
  `PORT=$HOSTY_PORT_HTTP` syntax
  ([LocalCommandRuntimeAdapter.cs:546](../../../apps/core/src/Haas.Hosty.Core/LocalCommandRuntimeAdapter.cs)).

A service with several ports gets no `PORT`; the app reads `HOSTY_PORT_{KEY}`.

## Conflict detection

A port Core reserved but another process holds is caught before the runtime starts, so the operator
gets a named, reassignable conflict instead of a bind failure from inside docker or the app process:

- `runtime_port_unavailable` — a start's loopback-scoped reservations
  ([`PreflightLoopbackAssignments`](../../../apps/core/src/Haas.Hosty.Core/CoreLifecycleService.cs)).
  A *running* app is skipped: its own bound ports are not a conflict. Cold starts wait up to 5s for
  the port to clear; the start half of a stop→start pair waits longer and then starts anyway, since
  the port is almost certainly our own still being torn down.
- `local_command_port_unavailable` — the localCommand adapter's own preflight over fixed and sticky
  ports, which also rejects two services of one app claiming the same port.
- `port_in_use` — an operator's manual port choice during reassignment.

All three ask the same question,
[`RuntimePortHelper.IsLoopbackTcpPortAvailable`](../../../apps/core/src/Haas.Hosty.Core/RuntimePortHelper.cs):
a TCP bind probe against loopback *and* wildcard, in both address families. The wildcard probes are
what see a holder bound to `0.0.0.0` / `::` — the shape a localCommand app that listens on "all
interfaces" produces. A loopback-only probe cannot: on BSD/macOS the kernel lets a specific address
bind alongside a wildcard one whenever the new socket carries `SO_REUSEADDR`, and .NET enables that
option inside `Socket.Bind` on Unix no matter what `ExclusiveAddressUse` says. An exact-address match
is refused whatever the reuse flags are, so the wildcard holder is found by probing the wildcard.

Only the loopback bind has to succeed; for the other three probes just `AddressAlreadyInUse` is
disqualifying, so a platform that refuses a wildcard bind for an unrelated reason does not invent a
conflict. Because every probe binds with `SO_REUSEADDR`, TIME_WAIT sockets left by a just-stopped app
never register as one either — restarting an app that served traffic is not blocked. Probes bind
without listening: the answer comes from `bind()`, and no probe ever accepts a connection.

The probe is TCP-only (as is the reservation model) and point-in-time, not a lease: a port taken
between preflight and the runtime's own bind still fails at the runtime, where app health and logs
are the diagnostics.

## Edge cases

- Host-network ports bind a fixed container port outside the loopback pool and are never probed.
- A reserved port held by an unrelated process on one specific non-loopback address is reported as a
  conflict even though a loopback-only bind could still squeeze in beside it. A reserved port shared
  with a foreign listener is worth failing loudly for, and the error names the port and offers a
  reassignment.
- Docker publishes loopback ports as `127.0.0.1:{host}:{container}`; a port that opts into
  `expose: host` publishes on `0.0.0.0` instead and is recorded with the `host` bind scope.
- Sticky reuse means an app that has started once keeps its port across restarts, so reverse proxies
  and local bookmarks stay valid.

## Testing Expectations

- Local command start injects matching `PORT` and `HOSTY_PORT_{KEY}` for a single-port service, and
  no `PORT` for a multi-port one.
- Stop/start and restart reuse the stored automatic port.
- An occupied explicit `localPort` fails start and records stopped/failed state.
- `IsLoopbackTcpPortAvailable` reports a conflict for every holder shape — loopback, IPv4 wildcard,
  IPv6 wildcard, dual-stack wildcard — and reports a port left in TIME_WAIT by a stopped app as
  available
  ([RuntimePortHelperTests.cs](../../../apps/core/tests/Haas.Hosty.Core.Tests/RuntimePortHelperTests.cs)).
- A wildcard-bound holder on a reserved port raises `runtime_port_unavailable` naming the endpoint.

## Links

- [Install-Time Runtime Port Reservations](../../planning/install-time-runtime-port-reservations.md)
  — the reservation model this feature resolves against.
- [Manual Port Assignment](../../ideas/manual-port-assignment.md) — operator-chosen ports and
  reassignment.

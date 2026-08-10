# Feature: Automatic Runtime App Ports

Created: 2026-06-05
Updated: 2026-08-09

Runtime apps do not hard-code host ports. Core reserves an available host port for every declared
service port at install, exposes it to the app through the environment, and keeps the stored endpoint
URL pointing at the port the app actually got. Manifests omit `localPort` / `hostPort` unless a fixed
port is part of the app's contract.

## Assignment

A declared port without an explicit `localPort` / `hostPort` is reserved at install, before the app
has ever started: a stopped app already carries durable endpoint URLs, and its ports are excluded
from every other app's allocation
([CoreLifecycleService.cs:428](../../../apps/core/src/Haas.Hosty.Core/CoreLifecycleService.cs),
[RuntimePortAllocator.cs](../../../apps/core/src/Haas.Hosty.Core/RuntimePortAllocator.cs)).

The reservation is an `AppPortAssignment` on the app record
([AppRegistryStore.cs:333](../../../apps/core/src/Haas.Hosty.Core/AppRegistryStore.cs)), identified by
`(service, port key, transport, bind scope)` — the numeric port alone cannot be the identity, because
one app may publish the same port key from two services. Each assignment records how it was chosen
(`automatic`, `manifest`, `operator`, `host-network`) and whether it is remappable; only `automatic`
assignments are. The collection is nullable and additive, so a record written before the model
existed still deserializes.

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

**Install is the only path that reserves.** Update and runtime switch carry the existing assignments
forward verbatim, so an app keeps its ports across both
([CoreLifecycleService.cs:2872](../../../apps/core/src/Haas.Hosty.Core/CoreLifecycleService.cs)), and
a live-source manifest change does not touch them at all. A port key that appears for the first time
in an update, a runtime switch, or a live manifest therefore has no reservation: it is allocated by
the adapter at start and persisted only as an endpoint URL, which resolution step 4 recovers on later
starts. A reservation whose port key the new manifest no longer declares stays on the record, inert —
nothing resolves or projects it.

### The allocation pool

Automatic ports come from a fixed band, **20000–32767**
([RuntimePortHelper.AutomaticPortRangeStart](../../../apps/core/src/Haas.Hosty.Core/RuntimePortHelper.cs)).
A candidate is drawn at random and probed; the first free one that is not excluded wins.

The band exists because a reservation is durable and an OS-allocated port is not. Until 0.76.0 an
automatic port was whatever a bind on port 0 returned — that is, a port out of the OS dynamic range
(Linux 32768+, macOS and Windows 49152+), which is also the pool every outbound connection on the
host draws from. Nothing tells the kernel to keep such a port aside, so the reservation was only ever
on loan. A Windows host reserved 52306 for `hosty.ai-gateway` and then handed the port out again
during the app's own `npm install` setup step, between Core's start preflight and the app's listen;
the app died with `EADDRINUSE` on every start. The band sits above the crowded development-port
neighbourhood apps pin by hand and below the lowest dynamic-range floor of any supported platform, so
no operating system allocates inside it unless told to.

Candidates are drawn at random rather than swept from the floor: a sweep would put every host's first
app on the same number, so one unlucky foreign service would collide identically everywhere. The band
does contain a few familiar services (MongoDB 27017, CockroachDB 26257, Plex 32400) and there is no
deny-list for them — a running one is never handed its port because every candidate is probed, and a
stopped one is the same exposure any pinned port already carries.

A band with no free candidate left falls back to the old port-0 allocation and logs a warning. The
resulting reservation is as fragile as every automatic port was before the band existed, which is
worth saying out loud, but a saturated host that can still install beats one that cannot.

### Allocation coordination

Every allocation runs under one process-wide gate
([RuntimePortAllocator.cs:14](../../../apps/core/src/Haas.Hosty.Core/RuntimePortAllocator.cs)). The
exclusion view is read, the ports chosen, and the record persisted without releasing it, so two
concurrent installs cannot each allocate against a snapshot that predates the other's write — the
second observes the first's reservation.

The excluded set is every non-host-network reservation held by any other installed app, plus Core's
own port. On top of it, a process-wide memory of the last 64 allocations keeps a port handed to a
start that has not bound it yet from being handed out again — the bind probe cannot see that one.

Resolution runs in two passes over the app's declared ports. The first resolves every port whose
number the app does not get to choose — host-network, an operator override, a manifest pin, an
existing reservation, a started endpoint's sticky port — and seeds the exclusion set with all of
them; the second allocates what is left. Reserving pins *before* drawing matters because the band is
a range apps may legitimately pin inside: a single pass excluding only the siblings it had already
visited could hand an early service the number a later one pins, and the record would persist the
same host port twice. Both the install-time allocator and the localCommand adapter's start-time
resolution work this way.

Shell is not special-cased: it pins its port in its own manifest like any app, and once installed its
reservation is in the set. Before Shell installs, nothing holds its pinned port — but that is exactly
the position every other app is already in, and the band is deliberately clear of the ports apps pin
by hand. An app that pins inside the band can still collide, and it then fails start with the same
reassignable `runtime_port_unavailable` any app gets.

## Environment

- `HOSTY_PORT_{KEY}` carries the assigned host port for every declared port key, in both runtimes.
- `PORT` is set for a `localCommand` service that has exactly one assigned port, unless the manifest
  runtime environment or an app setting already defines `PORT`. This keeps frameworks such as
  Next.js working without every manifest wrapping its command in shell-specific
  `PORT=$HOSTY_PORT_HTTP` syntax
  ([LocalCommandRuntimeAdapter.cs:546](../../../apps/core/src/Haas.Hosty.Core/LocalCommandRuntimeAdapter.cs)).

A service with several ports gets no `PORT`; the app reads `HOSTY_PORT_{KEY}`.

## Reassignment

An automatic port can be moved, and any remappable port can be pinned to an operator's exact choice,
through an admin-only plan/apply pair
([LifecycleEndpoints.cs:145](../../../apps/core/src/Haas.Hosty.Core/LifecycleEndpoints.cs)):
`POST /api/apps/{appId}/ports/reassign/plan` and `POST /api/apps/{appId}/ports/reassign`.

The plan reports the current port and URL, whether the port is pinned, the lowest port an operator
may choose, whether the owning app is running, and every installed dependent that may hold the old
local URL in its environment — each flagged with whether it is running
([CoreLifecycleService.cs:5604](../../../apps/core/src/Haas.Hosty.Core/CoreLifecycleService.cs)). It
does not pre-allocate a candidate port; the new port is chosen inside apply, under the gate. The plan
carries a digest over the app, the assignment, the current port and the dependent set; apply rejects
a stale one with `reassign_state_changed`.

Apply has two modes. Without a port, Core allocates automatically and clears any override, returning
the assignment to `automatic`/remappable. With a port, Core validates it and pins it: the
service-scoped `HOSTY_PORT_{SERVICE}_{KEY}` override is written, and the assignment becomes
`operator`/non-remappable so a later automatic pass cannot silently move a port the operator chose
for a firewall rule or a router forward. Validation rejects `port_out_of_range`, `port_privileged`
(below 1024 — Core never runs as root, so the bind would only fail later), `port_reserved` (naming
the holder), and `port_in_use`. Re-pinning the port an endpoint already holds is allowed and skips
the bind probe, since the owning app may legitimately be listening on it.

Assignment, endpoint URL, and override setting are persisted as one record, so the three can never
disagree. Reassignment never restarts anything as a side effect: apply returns
`restartRequiredAppIds` — the owner if it is up, plus every running dependent — and the operator
restarts them.

An `automatic` assignment always qualifies. An `operator`-pinned one qualifies too — otherwise a pin
would be a one-way door, since pinning clears `remappable` and even loading the plan to un-pin would
be refused — but only when the request states its mode explicitly
([RequireRemappableAssignment](../../../apps/core/src/Haas.Hosty.Core/CoreLifecycleService.cs)). The
plan always admits a pinned port; apply admits one only when `mode` is present, so a client that
omits the field (the pre-pinning payload) cannot move a deliberate choice by accident. A
manifest-declared port and a host-network port are rejected with `reassign_not_remappable` in both
modes.

Shell drives both endpoints from one dialog on the endpoint row
([port-reassign-control.tsx](../../../apps/shell/src/app/shell/pages/port-reassign-control.tsx)),
with an Automatic/Manual toggle that opens in the mode the endpoint is already in. Before applying it
shows the owner-running warning and the dependent list with a per-dependent restart badge; after
applying it reports the restart-required ids in a toast. Core's error message renders inline in the
dialog, so a rejected pin explains itself; Shell does not branch on the error codes themselves.
Pinned-ness is visible inside the dialog but not on the endpoint row.

## Endpoint availability

App summaries project an `availability` onto each endpoint, so a non-null URL no longer implies
reachability ([AppRegistryStore.cs:980](../../../apps/core/src/Haas.Hosty.Core/AppRegistryStore.cs)):
`running` when the owning app is up, `assigned` when it is stopped but a durable target exists, and
null for a legacy endpoint with neither a reservation nor a resolved URL. The value is computed per
request and never persisted, like `publicOrigin`.

The vocabulary also defines `unavailable`, and Shell renders it — a red marker on the endpoint and an
app-level problem alert. Core does not currently produce it: a reserved port taken by another process
surfaces when the next start throws `runtime_port_unavailable`, not as endpoint state.

Shell shows no marker for `running` or `assigned`
([port-reassign-control.tsx:18](../../../apps/shell/src/app/shell/pages/port-reassign-control.tsx)) —
`running` duplicates the service status badge above the endpoint, and `assigned` duplicates the
endpoint URL block below it. Only the failure case earns one. A stopped app's endpoint URL stays a
live link, and configuration actions such as Public origins remain available while it is stopped.

## Existing-record migration

Two boot passes run ahead of autostart reconciliation, in this order
([HostyCoreApplication.cs:1102](../../../apps/core/src/Haas.Hosty.Core/HostyCoreApplication.cs)): the
backfill below, then the rehoming pass, so a reservation derived from a legacy endpoint URL on this
boot is rehomed in the same pass rather than waiting for the next one. Both are best-effort — a
failure is logged and boot continues.

### Rehoming OS-allocated ports

Every automatic port reserved before 0.76.0 came out of the OS dynamic range, where it was never
safe to hold (see [the allocation pool](#the-allocation-pool)). A boot pass moves them into the band
([`RehomeOsAllocatedPortsAsync`](../../../apps/core/src/Haas.Hosty.Core/CoreLifecycleService.cs)), so
an existing install heals without operator action.

An assignment qualifies when it is `automatic`, remappable, not host-network, holds a port at or
above 32768, and is not shadowed by a `HOSTY_PORT_*` setting. An operator pin and a manifest-declared
port are someone's deliberate choice and are left where they are, even inside the dynamic range —
the operator may have a firewall rule on one.

An endpoint that a Cloudflare API publication routes to is also left alone, whatever the currently
selected ingress provider. That provider pushes the local `serviceUrl` into a remotely-managed tunnel
and is only ever driven by an operator's explicit publish, so nothing re-points it when a port moves —
unlike the local-config provider, which re-renders its whole config from the app records on every
reconcile and therefore follows a moved port by itself. Moving a published port would aim a live
public hostname at a port nothing listens on. This is an interim guard: the app keeps a reservation in
the dynamic range, and it goes away once the API provider sits behind `IIngressController` like the
local one does. See [Public Origins](../public-origins/plan.md).

A legacy record needs one extra check. The backfill above derives its assignments from stored
endpoint URLs and classifies anything without a matching `HOSTY_PORT_*` setting as `automatic`,
because a URL cannot say whether Core chose the port or the manifest declared it. A pre-reservation
record whose manifest pins a port in the dynamic range would therefore look remappable. Before moving
anything, the pass reads the app's reviewed manifest copy and skips every `(service, port key)` the
manifest pins with an explicit `localPort`/`hostPort`, across all runtime profiles — skipping is the
safe direction, and a port pinned under a profile the app is not currently running is still a pin. An
unreadable or missing copy yields no pins and is logged. 32768 is used as the threshold on every platform rather
than the running OS's actual floor: it is the lowest of the three, so a Windows 52306 and a Linux
40000 both qualify, and reading `netsh` or `sysctl` would put platform-specific shelling out on a
boot path that stays AOT-friendly.

Each move runs through the allocator, so the new port is chosen under the same gate and against the
same exclusion view an operator-driven reassignment uses, and the endpoint URL moves with the
assignment. One port moves per round and the record is re-read between rounds, since each move
persists a new revision. Selection is by port range, so the pass is idempotent — a rehomed record
stops matching, and steady-state boots move nothing.

An app that is currently up is skipped and retried on a later boot. Core may have adopted a live
listener (keep-apps light restart, docker adoption), and moving the reservation would leave the
record disagreeing with the process actually serving.

### Backfilling pre-reservation records

A boot pass ahead of autostart reconciliation backfills reservations for records written before the
model existed
([PortAssignmentMigration.cs](../../../apps/core/src/Haas.Hosty.Core/PortAssignmentMigration.cs)). It
derives one loopback TCP assignment per endpoint that already carries a URL, keeping the port that
URL already advertises, and classifies it as `operator` when a `HOSTY_PORT_*` setting holds that same
number. It never changes a stored URL and never allocates.

An endpoint that has never started gets no reservation from this pass, and none from its first start
either: the adapter allocates a port and only the endpoint URL is persisted. The durable assignment
appears when the migration next runs — the following Core boot. Until then that port sits outside
every other app's exclusion view, and is protected only by the OS refusing to hand out a bound port
while the app is running.

The pass is additive and idempotent — existing assignments win, only missing identities are added, so
a second run produces no delta. It tolerates a record carrying duplicate identities rather than
throwing, because it runs at boot and an abort there would strand the whole backfill.

## Conflict detection

A port Core reserved but another process holds is caught before the runtime starts, so the operator
gets a named, reassignable conflict instead of a bind failure from inside docker or the app process:

- `runtime_port_unavailable` — a start's loopback-scoped reservations
  ([`PreflightLoopbackAssignments`](../../../apps/core/src/Haas.Hosty.Core/CoreLifecycleService.cs)).
  An app that already holds its own reserved ports is exempt — a restart or a docker adoption must
  not have its own ports reported as stolen — and the caller passes that in rather than re-reading a
  record the start path has already stamped `starting`. Cold starts wait up to 5s for the port to
  clear; the start half of a stop→start pair waits longer and then starts anyway, since the port is
  almost certainly our own still being torn down.
- `local_command_port_unavailable` — the localCommand adapter's own preflight over fixed and sticky
  ports, which also rejects two services of one app claiming the same port. The adapter probes a
  second time immediately before each service's command spawns, closing the window the first preflight
  leaves open: the two are separated by the whole of the service's `setup` command, and `npm install`
  alone opens dozens of outbound connections that each take a local port from the OS dynamic range.
  That second probe covers only ports inside that range. A band port cannot be taken by the OS on its
  own, so re-probing it would buy nothing and cost something real — on Windows a Node listener binds
  with `SO_EXCLUSIVEADDRUSE`, so an app's own `TIME_WAIT` sockets from the run just stopped can still
  hold its port, and a strict probe there would fail ordinary restarts.
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
conflict. On Unix, where .NET enables `SO_REUSEADDR` inside `Socket.Bind`, TIME_WAIT sockets left by a
just-stopped app do not register as one either, so restarting an app that served traffic is not
blocked; that is the platform the covering test asserts on. Probes bind without listening: the answer
comes from `bind()`, and no probe ever accepts a connection.

The probe is TCP-only (as is the reservation model) and point-in-time, not a lease: a port taken
between preflight and the runtime's own bind still fails at the runtime, where app health and logs
are the diagnostics.

## Why the record owns the reservation

The app record is the reservation, rather than a separate Core-wide reservations document. Installed
state and reservation state therefore cannot diverge after a crash or a partial write, and uninstall,
backup/restore, and migration stay one state machine instead of two. Uninstall releases a reservation
by deleting the record — there is no second ledger to sweep.

Core does not hold sockets open for stopped apps. That would not survive Core downtime, would
complicate handoff to the docker and process runtimes, and would make a stopped app appear to have
listeners. A reservation is a logical claim, not a kernel lease; the start preflight and explicit
reassignment are what contain the gap.

Two rules follow from the same reasoning and still bind the code: a host-network port is a fixed
reservation that is never remapped, and the `app.0.1` manifest contract is unchanged — assignment
state is Core-owned and service-scoped, so no manifest had to learn about it. The first rule is only
half-realised: a host-network assignment is recorded and refused reassignment, but it is excluded
from the cross-app exclusion set and never probed, so it contributes to no collision diagnostics
beyond blocking its own app's reassigned ports.

## Edge cases

- Host-network ports bind a fixed container port outside the loopback pool and are never probed.
- A reserved port held by an unrelated process on one specific non-loopback address is reported as a
  conflict even though a loopback-only bind could still squeeze in beside it. A reserved port shared
  with a foreign listener is worth failing loudly for, and the error names the port and offers a
  reassignment.
- Docker publishes loopback ports as `127.0.0.1:{host}:{container}`; a port that opts into
  `expose: host` publishes on `0.0.0.0` instead and is recorded with the `host` bind scope. That
  scope is excluded from other apps' allocation, but it is not probed at start and does not widen
  the collision domain — the reserved set is a flat set of TCP port numbers.
- Every assignment is recorded as `tcp`. A manifest may declare `transport: ["udp"]` and docker
  publishes it, but UDP never enters the reservation or collision model.
- Uninstalling with app data retained does not retain the port: the retained snapshot holds settings,
  mounts, and autostart only, and `HOSTY_PORT_*` is not a manifest-declared setting, so even an
  operator pin is dropped. A reinstall gets a fresh automatic port.
- `POST /api/apps/{appId}/configure` accepts a `HOSTY_PORT_*` value without validating it and without
  re-reserving, so a port written that way diverges from the reservation until the next install. The
  reassign endpoint is the supported way to pin a port.
- Sticky reuse means an app that has started once keeps its port across restarts, so reverse proxies
  and local bookmarks stay valid.

## Testing Expectations

- Local command start injects matching `PORT` and `HOSTY_PORT_{KEY}` for a single-port service, and
  no `PORT` for a multi-port one.
- Stop/start and restart reuse the stored automatic port.
- An occupied explicit `localPort` fails start and records stopped/failed state.
- Install with start disabled projects a non-null endpoint URL and an automatic assignment; a
  multi-service app repeating a port key gets distinct ports and URLs
  ([RuntimePortAllocatorTests.cs](../../../apps/core/tests/Haas.Hosty.Core.Tests/RuntimePortAllocatorTests.cs)).
- Allocation and persistence happen under one gate, and an app's own id is excluded from its
  exclusion view.
- Reassignment allocates a new port, pins a manual one, clears the override on return to automatic,
  re-pins the port it already holds, and rejects an invalid, reserved, or externally held port.
- A host-network assignment uses the container port and is not remappable.
- Migration derives assignments from started endpoint URLs, is idempotent, preserves existing
  assignments, classifies an operator override, and tolerates duplicate identities
  ([PortAssignmentMigrationTests.cs](../../../apps/core/tests/Haas.Hosty.Core.Tests/PortAssignmentMigrationTests.cs)).
- Allocation lands inside the band and never returns an excluded port; a held candidate is never
  handed out; an exhausted band falls back to an OS-allocated port; `IsOsDynamicRangePort` covers
  every platform floor
  ([RuntimePortHelperTests.cs](../../../apps/core/tests/Haas.Hosty.Core.Tests/RuntimePortHelperTests.cs)).
- Rehoming selects only automatic, remappable, non-host-network assignments above the dynamic-range
  floor that no `HOSTY_PORT_*` setting shadows, and orders them by service then port key
  ([PortRehomingSelectionTests.cs](../../../apps/core/tests/Haas.Hosty.Core.Tests/PortRehomingSelectionTests.cs)).
- The rehoming pass moves an OS-allocated port into the band and carries the endpoint URL with it,
  leaves an operator pin in the same range alone, changes nothing on a second run, skips an app that
  is running, keeps several ports on one app distinct, and leaves a legacy manifest pin — or an endpoint
  with a Cloudflare API publication — in place while still moving that app's genuinely automatic ports.
- A port a later service pins inside the band is reserved before an earlier service's automatic port
  is drawn, so one app never persists the same host port twice
  ([RuntimePortAllocatorTests.cs](../../../apps/core/tests/Haas.Hosty.Core.Tests/RuntimePortAllocatorTests.cs)).
- The pre-spawn probe rejects a dynamic-range port taken during `setup` with
  `local_command_port_unavailable` naming the port, and does not probe a band port even when one is
  held ([LocalCommandRuntimeAdapterTests.cs](../../../apps/core/tests/Haas.Hosty.Core.Tests/LocalCommandRuntimeAdapterTests.cs)).
- `IsLoopbackTcpPortAvailable` reports a conflict for every holder shape — loopback, IPv4 wildcard,
  IPv6 wildcard, dual-stack wildcard — and reports a port left in TIME_WAIT by a stopped app as
  available
  ([RuntimePortHelperTests.cs](../../../apps/core/tests/Haas.Hosty.Core.Tests/RuntimePortHelperTests.cs)).
- A wildcard-bound holder on a reserved port raises `runtime_port_unavailable` naming the endpoint.
- An `unavailable` endpoint becomes an app problem naming the endpoint, and `assigned` / `running`
  endpoints raise nothing
  ([app-problems.test.mjs](../../../apps/shell/test/app-problems.test.mjs)).

## Links

- [Automatic Runtime App Ports Plan](plan.md) — the reservation work that remains.
- [Cross-App Dependencies](../cross-app-dependencies/feature.md) — consumes a dependency's local
  endpoint URL, which a reassignment invalidates until the dependent restarts.
- [Raw L4 Ports](../raw-ports.md) — `expose: host` and UDP publishing.
- [Host Networking](../host-networking.md) — fixed host-namespace ports.

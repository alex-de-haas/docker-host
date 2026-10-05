---
created: 2026-06-17
updated: 2026-10-05
summary: A docker service port can opt into publishing on all interfaces over TCP and UDP with expose and transport.
components: [apps/core]
---

# Raw L4 Port Publishing

A runtime app can opt a service port into being published on **all** network interfaces
(`0.0.0.0`) with **TCP and/or UDP** under the `docker` runtime, so it can run a raw L4 listener
reachable from outside the host. The motivating case is a BitTorrent peer/DHT port such as
`6881/tcp` + `6881/udp` that must accept inbound connections from the internet. It is opt-in per
port; a port that does not use it is published on loopback over TCP.

## Behavior

A service runtime's `ports[]` entry has two optional fields:

- `expose`: `"loopback"` (default) or `"host"`. `"host"` binds the published port on `0.0.0.0`
  instead of `127.0.0.1`.
- `transport`: a non-empty subset of `["tcp", "udp"]`, default `["tcp"]`. Each listed transport is
  published as its own `-p` rule.

A port that declares neither field is published as `-p 127.0.0.1:{hostPort}:{containerPort}`, with
no protocol suffix. Declaring either field switches that port to the explicit
`bind:hostPort:containerPort/proto` form, one `-p` per transport.

```jsonc
"ports": [
  {
    "key": "torrent",
    "containerPort": 6881,
    "hostPort": 6881,       // required when expose is "host"
    "expose": "host",        // bind 0.0.0.0 instead of 127.0.0.1
    "transport": ["tcp", "udp"]
  }
]
```

For this port Core runs the container with
`-p 0.0.0.0:6881:6881/tcp -p 0.0.0.0:6881:6881/udp -e HOSTY_PORT_TORRENT=6881`.
`HOSTY_PORT_{KEY}` is injected once regardless of how many transports are published. The app binds
its listener on that port and advertises it to peers; the operator forwards the port on the router.

A host-exposed port must pin `hostPort` or `localPort`: an automatically reserved port
([automatic runtime app ports](../automatic-runtime-app-ports/feature.md)) could differ from what
the router forwards and the app advertises. Ports without `expose: "host"` keep the automatic
reservation.

`protocol` stays the HTTP URL scheme used to build endpoint URLs; transport is a separate field. A
raw L4 port is usually not HTTP, so its endpoint URL is informational only. Under `localCommand`,
`expose` and `transport` are validated but inert: the process binds whatever address it chooses.

Core does not configure UPnP, NAT-PMP, the router or the host firewall, and there is no per-interface
bind beyond loopback versus all interfaces. A service that needs the whole host network namespace
uses [host networking](../host-networking/feature.md) instead.

## Implementation

- **Manifest model** (`RuntimePortManifest`): optional `Expose` (`string?`) and `Transport`
  (`IReadOnlyList<string>?`). `Transport` stays nullable so validation distinguishes an absent field
  from an explicit empty list.
- **Validation** (`AppManifestService.ValidatePorts`, per selected service): `expose` is `loopback`
  or `host`, case-insensitive; each `transport` entry is `tcp` or `udp`, not duplicated, and the list
  is non-empty when present; `expose: "host"` requires an explicit `hostPort` or `localPort`. Error
  codes: `app_manifest_port_expose_invalid`, `app_manifest_port_transport_invalid`,
  `app_manifest_port_transport_duplicate`, `app_manifest_port_host_requires_pinned_port`.
- **Publishing** (`DockerRuntimeAdapter.BuildPortArguments`): with neither field present it returns
  the loopback form without a protocol suffix. Otherwise the bind is `0.0.0.0` for `host` and
  `127.0.0.1` for `loopback`, the transports default to `["tcp"]`, and it emits one
  `-p {bind}:{host}:{container}/{proto}` per lowercased transport, then one `HOSTY_PORT_{KEY}`.
- **Change detection** (`CoreLifecycleService.PortSignature`): the signature includes the normalized
  `expose` and sorted `transport`, so toggling either across manifest versions restarts the service.

## Edge Cases

- `transport: []` is rejected; omitting the field means TCP only.
- Mixed case (`expose: "HOST"`, `transport: ["TCP"]`) is accepted and emitted lowercased.
- A pinned host port that another process already holds makes `docker run` fail at start, through
  the normal start path. The start-time preflight of automatic runtime app ports does not cover UDP
  yet; that work is tracked in its [plan](../automatic-runtime-app-ports/plan.md).
- `0.0.0.0` binds on the Docker daemon host's interfaces.

## Security

`expose: "host"` widens a port from loopback to every interface, so it becomes reachable from the
LAN and, once forwarded, from the internet. It is declared per port in the manifest and visible to
install review; an app cannot widen a port without declaring it. A host-exposed port is reachable
only as far as the host firewall and the operator's router allow, and the app owner is responsible
for whatever listens on it.

## Testing Expectations

- `DockerRuntimeAdapterTests`: a default port publishes exactly `127.0.0.1:{host}:{container}` with
  `HOSTY_PORT_*` injected once; `expose: "host"` with `transport: ["tcp", "udp"]` publishes both
  `0.0.0.0:6881:6881/tcp` and `/udp` with one `HOSTY_PORT_*`; `expose` is case-insensitive.
- `AppManifestServiceTests`: a valid host-exposed raw port is accepted, including through the
  source-generated JSON deserializer; bad `expose`, bad, empty or duplicate `transport`, and
  `expose: "host"` without a pinned port are rejected.

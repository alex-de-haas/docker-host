# Feature: Raw L4 Port Publishing

## Goal

Let a runtime app opt a service port into being published on **all** network interfaces (`0.0.0.0`) with **TCP and/or UDP** under the `docker` runtime, so the app can run a raw L4 listener that is reachable from outside the host. The driving use case is a BitTorrent peer/DHT port (e.g. `6881/tcp` + `6881/udp`) that must accept inbound connections from the public internet. The feature is opt-in and off by default; ports that do not use it are published exactly as before.

## Non-goals

- UPnP / NAT-PMP / automatic router port mapping. Core does not touch the router; the app or operator forwards the port. Core only changes the host-side bind and transport of the docker publish.
- Per-interface bind selection beyond loopback vs all interfaces. `expose` is `loopback` or `host` — there is no "bind to one specific interface/IP".
- Changing the `localCommand` runtime. A localCommand process binds whatever address it chooses; Core still injects `HOSTY_PORT_{KEY}` and otherwise stays out of the way.
- Repurposing `protocol`. `protocol` remains the HTTP **URL scheme** used when building endpoint URLs; transport (TCP/UDP) is a separate field.
- Firewall configuration on the host. Reaching a host-exposed port still requires the host firewall to allow it.
- Sharing the whole host network namespace. `expose: "host"` widens a **single** port to all interfaces while the rest stay loopback. A service that needs the whole namespace — e.g. high-churn peer-to-peer where the docker bridge NAT itself is the throughput bottleneck — should use [Host Networking](host-networking.md) instead.

## Current Behavior

Before this feature the docker adapter published every port as `-p 127.0.0.1:{hostPort}:{containerPort}` — loopback-only and TCP-only (docker's default protocol). That is correct for HTTP services fronted by Core/Shell, but it makes a raw peer-to-peer listener unreachable: it is bound to loopback and never accepts UDP. There was no way for a manifest to ask for a wider bind or for UDP.

## Behavior

Two optional fields are added to a service runtime's `ports[]` entry:

- `expose`: `"loopback"` (default) or `"host"`. `"host"` binds the published port on `0.0.0.0` instead of `127.0.0.1`.
- `transport`: a subset of `["tcp", "udp"]`, default `["tcp"]`. Each listed transport is published as its own `-p` rule.

A port that declares **neither** field is published byte-for-byte as before (`127.0.0.1:{hostPort}:{containerPort}`, TCP). Opting into either field switches that port to the explicit `bind:hostPort:containerPort/proto` form, one `-p` per transport.

```jsonc
"services": [{
  "key": "torrent",
  "runtimes": {
    "docker": {
      "type": "docker",
      "image": "ghcr.io/example/torrent:1.0.0",
      "ports": [
        {
          "key": "torrent",
          "containerPort": 6881,
          "hostPort": 6881,      // required when expose is "host"; recommend == containerPort
          "expose": "host",       // bind 0.0.0.0 instead of 127.0.0.1
          "transport": ["tcp", "udp"]
        }
      ]
    }
  }
}]
```

For the manifest above Core runs the container with:

```
-p 0.0.0.0:6881:6881/tcp -p 0.0.0.0:6881:6881/udp -e HOSTY_PORT_TORRENT=6881
```

`HOSTY_PORT_{KEY}` is injected exactly once regardless of how many transports are published. The app reads `HOSTY_PORT_TORRENT`, binds its listener inside the container on `6881`, and advertises `6881` to peers; the operator forwards `6881/tcp` and `6881/udp` on the router to the host.

## User/API Scenarios

- An app author ships a BitTorrent service whose manifest declares `expose: "host"`, `transport: ["tcp", "udp"]`, and `hostPort: 6881`. The app installs and starts; the listen port is reachable on all host interfaces for both protocols.
- An author sets `expose: "host"` but forgets to pin `hostPort`/`localPort`. Install fails validation with `app_manifest_port_host_requires_pinned_port` — an ephemeral, changing port would break router forwarding and the app's advertised port.
- An author writes `transport: ["sctp"]` or `transport: []` or `transport: ["tcp", "tcp"]`. Install fails with `app_manifest_port_transport_invalid` / `app_manifest_port_transport_duplicate`.
- An existing HTTP app with a plain `{ "key": "http", "containerPort": 8080 }` port is unaffected: it still publishes `127.0.0.1:{assigned}:8080` (TCP), and Core still assigns an ephemeral loopback port.
- An operator updates an app's manifest to add/remove `expose`/`transport` on an existing port. Core detects the changed port signature and restarts the service so the new publish takes effect.

## Technical Design

- **Manifest model** (`RuntimePortManifest`): two new optional properties, `Expose` (`string?`) and `Transport` (`IReadOnlyList<string>?`). `Transport` is intentionally left nullable (not coalesced to `[]`) so validation can distinguish an absent field from an explicit empty list.
- **Validation** (`AppManifestService.ValidatePorts`, run from `Select` per selected service): `expose` must be `loopback`/`host` (case-insensitive); each `transport` entry must be `tcp`/`udp`, non-duplicate, and the list must be non-empty when the field is present; `expose: "host"` requires an explicit `hostPort`/`localPort`. Error codes follow the existing `app_manifest_*` style: `app_manifest_port_expose_invalid`, `app_manifest_port_transport_invalid`, `app_manifest_port_transport_duplicate`, `app_manifest_port_host_requires_pinned_port`.
- **Publishing** (`DockerRuntimeAdapter.BuildPortArguments`): a pure helper that, given a port and its resolved host port, returns the docker `run` arguments. When `expose` and `transport` are both absent it returns the legacy `-p 127.0.0.1:{host}:{container}` (no protocol suffix). Otherwise `bind = expose == "host" ? "0.0.0.0" : "127.0.0.1"`, `transports = transport ?? ["tcp"]`, and it emits one `-p {bind}:{host}:{container}/{proto}` per (lowercased) transport, then a single `HOSTY_PORT_{KEY}` if the port has a key.
- **Host-port resolution** is unchanged (`RuntimePortHelper`): explicit `localPort`/`hostPort`, `HOSTY_PORT_{KEY}` setting override, the previous endpoint's port, else an ephemeral loopback port. A host-exposed port reaches the explicit-port branch because validation requires it to be pinned.
- **Change detection** (`CoreLifecycleService.PortSignature`): the signature now includes the normalized `expose` and sorted `transport`, so toggling either across manifest versions is detected as a port change and triggers a restart.
- **localCommand** (`LocalCommandRuntimeAdapter`): unchanged. It already injects `HOSTY_PORT_{KEY}`; the process binds whatever address it chooses, so `expose`/`transport` are validated but otherwise inert under that runtime.

## Data Model / API Changes

- Manifest: `services[].runtimes[].ports[]` gains optional `expose` and `transport`.
- No new endpoints, settings, or app-record fields. `HOSTY_PORT_{KEY}` injection is unchanged.
- Published endpoint URLs are unchanged (still derived from `protocol` + host + assigned port); raw L4 ports are typically not HTTP, so the endpoint URL is informational only.

## Edge Cases

- **`expose: "host"` without a pinned port**: rejected at validation. A stable port is mandatory so router forwarding and the app's advertised port stay constant across restarts.
- **`transport: []`**: rejected (`app_manifest_port_transport_invalid`). Absent (`transport` omitted) means TCP-only; an explicit empty list is treated as a mistake.
- **Mixed case** (`expose: "HOST"`, `transport: ["TCP"]`): accepted; comparisons are case-insensitive and the emitted protocol is lowercased.
- **Host port collision**: Core does not reserve OS ports for docker; if the pinned host port is already bound, `docker run` fails at start and the error surfaces through the normal start path (same as today for any pinned port).
- **`expose`/`transport` on a `localCommand` port**: validated for correctness but has no publishing effect under that runtime.
- **Remote docker daemon**: Core assumes a local daemon and binds on the daemon host. `0.0.0.0` binds on the daemon host's interfaces.

## Security

`expose: "host"` deliberately widens a port from loopback to all interfaces, so it is reachable from the LAN and — once the operator forwards it — the public internet. This is opt-in per port in the app manifest and visible to install review; an app cannot widen a port without the author declaring it. Core does **not** open the host firewall or map the router, so a host-exposed port is only reachable to the extent the host's own firewall and the operator's router allow. Default behavior remains loopback-only, so existing apps gain no new exposure. The app owner is responsible for the security of whatever listens on a host-exposed raw port.

## Testing

- `DockerRuntimeAdapterTests`: a default port publishes exactly `127.0.0.1:{host}:{container}` (TCP-only, no protocol suffix) with `HOSTY_PORT_*` injected once; an `expose: "host"` + `transport: ["tcp", "udp"]` port publishes both `0.0.0.0:6881:6881/tcp` and `/udp` with `HOSTY_PORT_*` injected once; `expose` controls the bind address case-insensitively.
- `AppManifestServiceTests`: accepts a valid host-exposed raw port (and confirms the source-generated JSON deserializes `expose`/`transport`); rejects bad `expose`, bad/empty/duplicate `transport`, and `expose: "host"` without a pinned port.

## Decision

`expose` and `transport` are separate, additive fields rather than overloads of `protocol`, because `protocol` is the HTTP URL scheme used to build endpoint URLs and conflating it with L4 transport would break endpoint URL generation. The default path is kept byte-for-byte identical (loopback bind, no `/tcp` suffix) so the change is provably inert for existing apps. A host-exposed port is required to pin its host port — rather than allowing an ephemeral port — so the operator's router forwarding and the app's advertised peer port stay stable across restarts. UPnP/NAT-PMP is left out of Core on purpose: router mapping is an operator/app concern and would add a privileged, network-facing surface to the kernel.

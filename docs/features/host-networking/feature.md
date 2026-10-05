---
created: 2026-06-22
updated: 2026-10-05
summary: A docker service can run with network host to share the host network namespace, for peer-to-peer workloads the bridge NAT throttles.
components: [apps/core]
---

# Host Networking

A runtime app can run a `docker` service in **host networking** mode (`--network host`) so its
listeners bind the host's network namespace directly, with no docker bridge NAT and no `-p`
publishing. The motivating case is high-churn peer-to-peer traffic (BitTorrent peer/DHT), where the
bridge NAT, and on Docker Desktop/WSL2 the VM's userspace network relay, collapses throughput to a
fraction of a native client's. Host networking is opt-in per service and off by default.

## Behavior

A service's runtime profile has one optional field:

- `network`: `"bridge"` (default) or `"host"`. `"host"` is valid only under the `docker` runtime.

When a docker service declares `network: "host"`, Core:

- launches it with `--network host` instead of attaching it to the per-app user network;
- emits no `-p` publish rules, because docker discards published ports under host networking;
- still injects `HOSTY_PORT_{KEY}` for each declared port, carrying the **container port**, which
  under host networking is the port the listener binds on the host;
- resolves intra-app discovery to this service as `host.docker.internal:{containerPort}` for its
  siblings, because a host-networked service is not on the user network and the service-name alias
  does not apply.

```jsonc
"services": [{
  "key": "api",
  "runtimes": {
    "docker": {
      "type": "docker",
      "image": "ghcr.io/example/api:1.0.0",
      "network": "host",
      "ports": [
        { "key": "torrent", "containerPort": 6881 },  // HOSTY_PORT_TORRENT=6881, bound on the host
        { "key": "internal", "containerPort": 8080 }
      ]
    }
  }
}]
```

`--network host` shares the **whole** namespace, so every one of the service's ports is reachable on
the host; there is no per-port choice as with [raw L4 ports](../raw-ports/feature.md). Core does not
configure the host firewall or the router, and it cannot change the WSL2 VM's networking mode.

## Networking On Windows/WSL2

On Linux, host networking removes the last NAT hop and gives full peer-to-peer throughput and clean
inbound connections. On **Docker Desktop (Windows/WSL2)** it is necessary but not sufficient:

1. Host networking must be enabled in Docker Desktop (Settings → Resources → Network, Docker
   Desktop 4.34+); otherwise the flag is silently ignored.
2. The dominant bottleneck is the WSL2 VM network layer. Default WSL2 NAT throttles BitTorrent's
   connection churn to near zero. The operator enables **mirrored networking** by adding
   `networkingMode=mirrored` under `[wsl2]` in `%UserProfile%\.wslconfig`, running
   `wsl --shutdown` and restarting Docker Desktop. This is a host-level setting outside any
   `docker run`, so Core does not change it.

So that this is not a silent failure, Core logs a one-time warning when it starts a
peer-to-peer-shaped service (host networking, or a host-exposed UDP port) against Docker Desktop on
Windows/WSL2, pointing at the mirrored-networking fix.

## Implementation

- **Manifest model** (`RuntimeServiceProfileManifest`): optional `Network` (`string?`) and a derived,
  `[JsonIgnore]`d `IsHostNetwork` predicate.
- **Validation** (`AppManifestService.ValidateNetwork`, per selected service): `network` is `bridge`
  or `host`, case-insensitive; `host` is rejected outside the docker runtime. Error codes:
  `app_manifest_service_network_invalid`, `app_manifest_service_network_host_requires_docker`.
  Under host networking `ValidatePorts` relaxes `app_manifest_port_host_requires_pinned_port`: with
  no `-p` mapping there is nothing to keep stable.
- **Launch** (`DockerRuntimeAdapter.StartAsync`): a host-networked service adds `--network host`,
  skips the user-network attach and resolves each port's host port to its container port;
  `BuildPortArguments(..., hostNetwork: true)` returns only the `HOSTY_PORT_{KEY}` environment.
- **Discovery** (`BuildDockerServiceUrl`): a host-networked target is addressed as
  `{scheme}://host.docker.internal:{containerPort}`; bridged targets keep the service-name alias.
- **Change detection** (`CoreLifecycleService.AddNetworkChange`): toggling `network` across manifest
  versions is a detected change (`network:{service}:{from}->{to}`) that restarts the service. An
  absent or empty value normalizes to `bridge`, so declaring the default is inert.
- **Advisory** (`DockerRuntimeAdapter.MaybeAdviseWslMirroredNetworking`): once per app per Core
  process, detected through `OperatingSystem.IsWindows()` or a WSL kernel-release marker.
- **localCommand**: a local process binds whatever address it chooses; `network` is validated and
  `host` rejected, but otherwise inert.

## Edge Cases

- Two host-networked services, or one and another host listener, binding the same port fail at
  `docker run`, surfaced through the normal start path.
- A host-networked service reaching a **bridged** sibling is not supported: the bridged sibling is
  published only on loopback and is not reachable through `host.docker.internal`. The supported
  direction is a bridged dependent reaching a host-networked target.
- Host networking exposes every port of the service, not only the peer-to-peer one.
- On Docker Desktop without the host-networking feature enabled, `--network host` is ignored and the
  listeners are not reachable.

## Security

`network: "host"` removes network isolation for that service: all of its ports bind the host's
interfaces and are reachable from the LAN and, once forwarded, from the internet. It is declared per
service in the manifest and visible to install review. Prefer a single host-exposed raw port when only
one port needs to be reachable; use host networking when the workload's performance requires
bypassing the bridge NAT.

`network` is a per-service field rather than a per-port one because `--network host` switches the
whole namespace. Core does not rewrite an operator's `.wslconfig`, which would require restarting the
whole WSL subsystem; the start-time warning makes the requirement visible instead.

## Testing Expectations

- `DockerRuntimeAdapterTests`: host networking emits no `-p` but keeps `HOSTY_PORT_*`; a
  host-networked discovery target resolves to `host.docker.internal`.
- `AppManifestServiceTests`: `network: "host"` is accepted and relaxes the pinned-port rule; an
  invalid `network` value and `host` under `localCommand` are rejected.
- `CoreLifecycleServiceTests`: toggling `network` to `host` is reported as a
  `network:{service}:bridge->host` change.

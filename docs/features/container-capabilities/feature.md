---
created: 2026-06-22
updated: 2026-10-05
summary: A docker service can add named Linux capabilities and device nodes under /dev, opt-in per service and never as --privileged.
components: [apps/core]
---

# Container Capabilities And Devices

A `docker` runtime service can request a small set of **Linux capabilities** (`--cap-add`) and
**host device nodes** (`--device`), so an app that needs more than an ordinary unprivileged
container can run without blanket `--privileged`. The motivating case is an in-container VPN: an
OpenVPN or WireGuard client needs `NET_ADMIN` to configure routes and `/dev/net/tun` for the tunnel.
Both lists are opt-in and empty by default; a service that declares neither launches as an ordinary
container.

## Behavior

A service's docker runtime profile has two optional lists:

- `capabilities`: Linux capability names to add. Accepted with or without the `CAP_` prefix and in
  any case, emitted in docker's prefixless uppercase form (`NET_ADMIN`). Each must be a real
  capability name.
- `devices`: absolute host device paths under `/dev` to expose.

```jsonc
"services": [{
  "key": "torrent",
  "runtimes": {
    "docker": {
      "type": "docker",
      "image": "ghcr.io/example/torrent:1.0.0",
      "capabilities": ["NET_ADMIN"],   // configure the VPN tunnel
      "devices": ["/dev/net/tun"]      // the tunnel device
    }
  }
}]
```

For this manifest Core adds `--cap-add NET_ADMIN --device /dev/net/tun` to the container's `run`
arguments.

Core never grants `--privileged`. A device is a single absolute path under `/dev` that the container
sees at the same path with docker's default `rwm` permissions; there is no `host:container`
remapping. Ordinary host folders use [external mounts](../external-mounts/feature.md) instead. Both
lists are docker-only: a `localCommand` process already runs with the host user's privileges, so
declaring them there is rejected.

## Implementation

- **Manifest model** (`RuntimeServiceProfileManifest` in `RuntimeAppManifest.cs`): `Capabilities` and
  `Devices`, coalesced to empty lists. `LinuxCapabilities` holds the capability vocabulary and a
  `Normalize` helper that strips `CAP_` and uppercases.
- **Validation** (`AppManifestService.ValidateCapabilities` / `ValidateDevices`, per selected
  service): docker-only; each capability is known and not duplicated; each device is an absolute
  path under `/dev` with no `..` and no `:` mapping, not duplicated. Error codes:
  `app_manifest_service_capabilities_require_docker`, `app_manifest_service_capability_invalid`,
  `app_manifest_service_capability_duplicate`, `app_manifest_service_devices_require_docker`,
  `app_manifest_service_device_invalid`, `app_manifest_service_device_duplicate`.
- **Launch** (`DockerRuntimeAdapter.BuildPrivilegedArguments`): returns `--cap-add {CAP}` per
  normalized capability and `--device {path}` per device, appended after the network arguments.
- **Change detection** (`CoreLifecycleService.AddCapabilityChanges`): adding or removing a capability
  or device across manifest versions is a detected change (`capabilities:{service}:{from}->{to}`,
  `devices:{service}:{from}->{to}`, order-insensitive and normalized), so it restarts the service.

## Edge Cases

- An unknown capability, such as a typo, is rejected at validation, so a misconfigured grant never
  silently does nothing.
- `NET_ADMIN`, `net_admin` and `CAP_NET_ADMIN` are equivalent; declaring two of them is a duplicate.
- A device outside `/dev` (for example `/etc/passwd`) or with a `:` mapping is rejected.
- A device missing on the Docker host makes `docker run` fail at start, and the error surfaces
  through the normal start path. Core does not create device nodes.

## Security

Capabilities and devices widen a container's privilege beyond the unprivileged default. Like a
host-exposed port or host networking, they are declared per service in the manifest and visible to
install review, and they are enumerated rather than a blanket `--privileged`. Capabilities such as
`NET_ADMIN` give full control of the container's network namespace, so operators should grant them
only to images they trust. Core restricts requests to real capability names and leaves the policy
of which grants are acceptable to install review, the same boundary used for
[raw ports](../raw-ports/feature.md) and [host networking](../host-networking/feature.md).

## Testing Expectations

- `DockerRuntimeAdapterTests`: `BuildPrivilegedArguments` emits `--cap-add` and `--device` with
  normalized capability names and nothing when neither list is declared; `LinuxCapabilities.Normalize`
  strips `CAP_` and uppercases.
- `AppManifestServiceTests`: valid capabilities and devices are accepted; an unknown capability, a
  duplicate capability, a device outside `/dev`, a `:`-mapped device and capabilities under
  `localCommand` are rejected.
- `CoreLifecycleServiceTests`: granting a capability across manifest versions is reported as a
  `capabilities:app:none->NET_ADMIN` change.

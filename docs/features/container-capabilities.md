# Feature: Container Capabilities & Devices

## Goal

Let a `docker` runtime service request a small set of **Linux capabilities**
(`--cap-add`) and **host device nodes** (`--device`), so an app that needs more than
an ordinary unprivileged container can run — without granting blanket `--privileged`.
The driving use case is an **in-container VPN**: an OpenVPN/WireGuard client needs
`NET_ADMIN` (to configure routes/iptables) and `/dev/net/tun` (the tunnel device).
Both are opt-in and empty by default; a service that declares neither launches exactly
as before.

## Non-goals

- `--privileged`. Core never grants it. Capabilities are enumerated explicitly, which
  is strictly narrower and reviewable.
- Arbitrary host bind mounts via `--device`. `devices` is for device nodes under
  `/dev` only; ordinary host paths use `externalMounts`.
- `host:container` device remapping or per-device permission bits in v1. A device is a
  single absolute path under `/dev`; the container sees it at the same path with
  docker's default `rwm`.
- Capability/device support under `localCommand`. A local process already runs with
  the host user's privileges; these fields are docker-only and rejected elsewhere.

## Behavior

Two optional lists are added to a service's docker runtime profile:

- `capabilities`: Linux capability names to add (`--cap-add`). Accepted with or
  without the `CAP_` prefix, case-insensitive; emitted in docker's prefixless
  uppercase form (`NET_ADMIN`). Must be real capability names.
- `devices`: absolute host device paths under `/dev` to expose (`--device`).

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

For the manifest above Core adds `--cap-add NET_ADMIN --device /dev/net/tun` to the
container's `run` arguments. With neither list declared, no such arguments are emitted.

## Technical Design

- **Manifest model** (`RuntimeServiceProfileManifest`): `Capabilities` and `Devices`
  (`IReadOnlyList<string>`, coalesced to empty). `LinuxCapabilities` holds the
  canonical capability vocabulary and a `Normalize` helper (strip `CAP_`, uppercase).
- **Validation** (`AppManifestService.ValidateCapabilities` / `ValidateDevices`, per
  selected service): both are docker-only; each capability must be a known Linux
  capability and non-duplicate; each device must be an absolute path under `/dev` with
  no `..` and no `:` mapping, non-duplicate. Error codes:
  `app_manifest_service_capabilities_require_docker`,
  `app_manifest_service_capability_invalid`,
  `app_manifest_service_capability_duplicate`,
  `app_manifest_service_devices_require_docker`,
  `app_manifest_service_device_invalid`, `app_manifest_service_device_duplicate`.
- **Launch** (`DockerRuntimeAdapter.BuildPrivilegedArguments`): a pure helper that
  returns `--cap-add {CAP}` per capability (normalized) and `--device {path}` per
  device; appended to the `run` args after the network arguments.
- **Change detection** (`CoreLifecycleService.AddCapabilityChanges`): adding/removing a
  capability or device across manifest versions is a detected change
  (`capabilities:{service}:{from}->{to}`, `devices:{service}:{from}->{to}`,
  order-insensitive, normalized), so it triggers a restart.

## Edge Cases

- **Unknown capability** (typo, or a non-capability string): rejected at validation
  (`app_manifest_service_capability_invalid`), so a misconfigured grant never silently
  no-ops.
- **`CAP_` prefix / casing**: `NET_ADMIN`, `net_admin`, and `CAP_NET_ADMIN` are
  equivalent and normalize to `NET_ADMIN`; declaring both forms is a duplicate.
- **Device outside `/dev`** (e.g. `/etc/passwd`) or with a `:` mapping: rejected
  (`app_manifest_service_device_invalid`).
- **Device missing on the daemon host** (`/dev/net/tun` absent): `docker run` fails at
  start and the error surfaces through the normal start path; Core does not pre-create
  device nodes.
- **localCommand**: declaring `capabilities`/`devices` is rejected, since the field has
  no meaning there.

## Security

`capabilities` and `devices` widen a container's privilege beyond the unprivileged
default, so — like a host-exposed port or host networking — they are **opt-in per
service in the app manifest and visible to install review**. An app cannot escalate
without the author declaring it, and the declaration is enumerated (no blanket
`--privileged`). Capabilities such as `NET_ADMIN` are powerful (full control of the
container's network namespace); operators should grant them only to images they trust.
Core does not restrict *which* capabilities may be requested beyond requiring real
capability names — the review step is the gate, consistent with the rest of the
privileged-feature surface. The default (no capabilities, no devices) is unchanged, so
existing apps gain no new privilege.

## Testing

- `DockerRuntimeAdapterTests`: `BuildPrivilegedArguments` emits `--cap-add`/`--device`
  and normalizes capability names; empty when none declared; `LinuxCapabilities.Normalize`
  strips `CAP_` and uppercases.
- `AppManifestServiceTests`: accepts valid capabilities + devices; rejects an unknown
  capability, a duplicate capability, a device outside `/dev`, a `:`-mapped device, and
  capabilities under localCommand.
- `CoreLifecycleServiceTests`: granting a capability across manifest versions is
  reported as a `capabilities:app:none->NET_ADMIN` change (which drives a restart).

## Decision

Capabilities and devices are explicit enumerated lists rather than a `privileged`
boolean, because least-privilege is the whole point: an in-container VPN needs exactly
`NET_ADMIN` + `/dev/net/tun`, not root-equivalent access. They are docker-only because
`localCommand` already runs with the host user's privileges. Validation rejects unknown
capability names (so typos fail loudly) and confines devices to `/dev` (so `--device`
cannot smuggle in an arbitrary host path), while leaving the *policy* of which grants
are acceptable to install review — the same boundary used for host-exposed ports and
host networking. See [Host networking](host-networking.md) and [Raw L4 ports](raw-ports.md).

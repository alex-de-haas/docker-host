# Feature: Host Networking

## Goal

Let a runtime app run a `docker` service in **host networking** mode (`--network host`) so its
listeners bind the host's network namespace directly — no docker bridge NAT, no `-p` publishing.
The driving use case is high-churn peer-to-peer traffic (BitTorrent peer/DHT), where the docker
bridge NAT — and, on Docker Desktop/WSL2, the VM's userspace network relay — collapses throughput
to a fraction of what a native client on the same host achieves. Host networking is opt-in per
service and off by default; services that do not request it are launched exactly as before.

## Non-goals

- Replacing the host's WSL2 networking mode. On Docker Desktop/WSL2, host networking removes the
  *docker bridge* hop but the container still sits behind the *WSL2 VM* network layer. Core launches
  containers via the `docker` CLI and cannot set the WSL2 VM's networking mode — that is the
  operator's `.wslconfig` (`networkingMode=mirrored`). See [Networking on Windows/WSL2](#networking-on-windowswsl2).
- Per-port isolation under host networking. `--network host` shares the **whole** host namespace, so
  *every* one of the service's ports is reachable on the host — there is no per-port loopback-vs-host
  control as there is with [raw L4 port publishing](raw-ports.md).
- Firewall / router configuration. As with raw ports, reaching a host-bound listener still requires
  the host firewall to allow it, and inbound from the internet still requires the operator to forward
  the port on the router.

## Behavior

One optional field is added to a service's runtime profile:

- `network`: `"bridge"` (default) or `"host"`. `"host"` is valid only under the `docker` runtime.

When a docker service declares `network: "host"`, Core:

- launches it with `--network host` (instead of attaching it to the per-app user network or the
  default bridge),
- emits **no** `-p` publish rules (docker discards published ports under host networking),
- still injects `HOSTY_PORT_{KEY}` for each declared port, carrying the **container port** — under
  host networking that is the exact port the listener binds on the host,
- and resolves intra-app discovery to this service via `host.docker.internal:{containerPort}` for
  dependent siblings (a host-networked service is not on the user network, so the service-name DNS
  alias does not apply).

```jsonc
"services": [{
  "key": "api",
  "runtimes": {
    "docker": {
      "type": "docker",
      "image": "ghcr.io/example/api:1.0.0",
      "network": "host",          // share the host network namespace
      "ports": [
        { "key": "torrent", "containerPort": 6881 },  // bound directly on the host; HOSTY_PORT_TORRENT=6881
        { "key": "internal", "containerPort": 8080 }
      ]
    }
  }
}]
```

For the manifest above Core runs the container with `--network host` and injects
`HOSTY_PORT_TORRENT=6881` / `HOSTY_PORT_INTERNAL=8080` — no `-p` flags. The app binds `6881`
(tcp + udp, its own concern) inside the container and it is reachable on the host's interfaces; the
operator forwards `6881` on the router for inbound peers.

## Networking on Windows/WSL2

Host networking is the right fix for **production on Linux**: bridge networking there is kernel-native
and host networking removes the last NAT hop, giving full P2P throughput and clean inbound. On
**Docker Desktop (Windows/WSL2)** it is necessary but **not sufficient** on its own:

1. Host networking must be **enabled in Docker Desktop** (Settings → Resources → Network, Docker
   Desktop 4.34+); otherwise the flag is silently ignored.
2. The dominant bottleneck for P2P is the **WSL2 VM network layer**, not the docker bridge. Default
   WSL2 NAT throttles the connection churn of BitTorrent to near-zero. The operator must enable
   **WSL2 mirrored networking**: add `networkingMode=mirrored` under `[wsl2]` in
   `%UserProfile%\.wslconfig`, run `wsl --shutdown`, and restart Docker Desktop. Core **cannot** set
   this itself — it is a host-level WSL setting outside any `docker run` invocation.

To keep this from being a silent failure, Core logs a one-time **warning** when it starts a
peer-to-peer-shaped service (host networking, or a host-exposed UDP port) and detects it is running
against Docker Desktop on Windows/WSL2, pointing the operator at the mirrored-networking fix.

## Technical Design

- **Manifest model** (`RuntimeServiceProfileManifest`): a new optional `Network` (`string?`)
  property and a derived, `[JsonIgnore]`d `IsHostNetwork` predicate.
- **Validation** (`AppManifestService.ValidateNetwork`, run from `Select` per selected service):
  `network` must be `bridge`/`host` (case-insensitive); `host` is rejected outside the docker
  runtime. Error codes: `app_manifest_service_network_invalid`,
  `app_manifest_service_network_host_requires_docker`. Under host networking the
  `app_manifest_port_host_requires_pinned_port` rule is **relaxed** — there is no `-p` mapping to keep
  stable, so a host-exposed port no longer needs a pinned `hostPort`.
- **Launch** (`DockerRuntimeAdapter.StartAsync`): a host-networked service adds `--network host`,
  skips the user-network attach, and resolves each port's host port to its container port.
  `BuildPortArguments(..., hostNetwork: true)` returns only the `HOSTY_PORT_{KEY}` env (no `-p`).
- **Discovery** (`BuildDockerServiceUrl`): a host-networked **target** is addressed as
  `{scheme}://host.docker.internal:{containerPort}`; bridged targets keep the service-name alias form.
- **Change detection** (`CoreLifecycleService.AddNetworkChange`): toggling `network` (bridge↔host)
  across manifest versions is a detected change (`network:{service}:{from}->{to}`) and triggers a
  restart so the new launch flags take effect. null/empty normalizes to `bridge`, so declaring the
  default explicitly is inert.
- **Advisory** (`DockerRuntimeAdapter.MaybeAdviseWslMirroredNetworking`): once per app per Core
  process, warns about the WSL2 mirrored-networking requirement when a P2P-shaped service starts on
  Windows/WSL2 (detected via `OperatingSystem.IsWindows()` or a WSL kernel-release marker).
- **localCommand**: unaffected. A localCommand process binds whatever address it chooses; `network`
  is validated (host rejected) but otherwise inert.

## Edge Cases

- **Port collision**: two host-networked services (or a host-networked service and another host
  listener) that bind the same port fail at `docker run`, surfaced through the normal start path —
  the same way a pinned host-port collision does today.
- **Host depends on bridged**: a host-networked service reaching a *bridged* sibling is not
  supported — the bridged sibling is published only on loopback and is not reachable via
  `host.docker.internal`. The supported direction is bridged-dependent → host-networked-target.
- **All ports exposed**: host networking exposes every one of the service's ports on the host, not
  just the P2P one. Declare host networking only on services whose full port set is safe to expose
  (see Security).
- **Host networking unsupported by the daemon**: on Docker Desktop without the host-networking
  feature enabled, `--network host` is ignored and the listeners are not reachable; enable it in
  Docker Desktop settings.

## Security

`network: "host"` removes container network isolation for that service: all of its ports bind the
host's interfaces and are reachable from the LAN (and, once forwarded, the internet). This is opt-in
per service in the app manifest and visible to install review — an app cannot widen its exposure
without the author declaring it. Prefer [raw L4 port publishing](raw-ports.md) (`expose: "host"` on
a single port) when only one port needs to be reachable and the rest should stay loopback; reach for
host networking when the workload's performance genuinely requires bypassing the bridge NAT (P2P).
Default behavior remains bridge networking, so existing apps gain no new exposure.

## Testing

- `DockerRuntimeAdapterTests`: host networking emits no `-p` but keeps `HOSTY_PORT_*`; a
  host-networked discovery target resolves to `host.docker.internal`.
- `AppManifestServiceTests`: accepts `network: "host"` (and relaxes the host-port pin requirement);
  rejects an invalid `network` value and `host` under localCommand.
- `CoreLifecycleServiceTests`: toggling `network` to `host` across manifest versions is reported as a
  `network:{service}:bridge->host` change (which drives a restart).

## Decision

`network` is a per-service runtime field rather than a per-port one because `--network host` is a
whole-namespace switch — modelling it per port would misrepresent docker's behaviour. It is kept
distinct from raw-port `expose`/`transport`: those publish a *single* port more widely while
preserving isolation for the rest; host networking trades all isolation for raw performance. Core
deliberately does not try to manage the WSL2 networking mode — that is a privileged host setting, and
silently rewriting an operator's `.wslconfig` (which requires restarting the whole WSL subsystem)
would be surprising and destructive. Making the requirement loud (the start-time advisory and this
doc) is the right boundary.

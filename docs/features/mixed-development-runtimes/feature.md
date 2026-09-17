# Mixed Development Runtimes

Created: 2026-09-17
Updated: 2026-09-17

## Contract

A `development: true` profile can use `type: docker` or `type: mixed`, in addition to
`localCommand`. Mixed profiles require an explicit `docker` or `localCommand` type on each
service. A development profile requires at least one source service; image dependencies are
permitted, while prebuilt folder artifacts remain restricted to reviewed profiles. Core validates
all declared profiles, including unselected profiles and dependency cycles. The additive contract
uses `app.0.1`; these new profiles require Core 0.104.0 or later.

## Docker Source Execution

A Docker source service declares `sourceMount`, a `command`, and either an `image` or `build`:

```json
{
  "type": "docker",
  "artifact": "source",
  "build": { "context": ".", "dockerfile": "Dockerfile.dev", "revision": "1" },
  "sourceMount": {
    "path": ".", "target": "/workspace", "mode": "ro",
    "caches": ["src/Api/bin", "src/Api/obj"]
  },
  "setup": "dotnet restore src/Api/Api.csproj",
  "command": "exec dotnet watch --project src/Api/Api.csproj run"
}
```

Source paths resolve inside the registered app checkout. Context and source paths reject traversal
and symlink escapes. The Dockerfile path is relative to the build context; workingDirectory is
relative to the source mount. Read-only source access is the default; writable access requires
`mode: rw`. Cache paths overlay named Docker volumes so Linux outputs do not overwrite host build
outputs. The image's user owns writes to those volumes: non-root SDK images must arrange compatible
permissions. Caches survive stop, profile switches and app removal; operators can remove the
Core-prefixed development volumes with Docker when no development container uses them. Source and
persistent app data are never cache-cleanup targets.

Core passes setup followed by command as image CMD, preserving the image entrypoint. Environment
images that require VPN/firewall initialization keep that initialization before the development
command. Capabilities, devices and external mounts remain explicit manifest/operator configuration.
No Docker socket, privileged mode or host networking is added by development mode.

The first build uses the authorized checkout and Docker build cache, then records the immutable
image ID. Restarts reuse that ID. Source edits are visible through the mount; the app's watch command
owns reload. Dockerfile/dependency changes require a reviewed build-revision change before Core
builds a new environment. A local supplied image without a registry digest is also locked by image
ID. Missing locked environments produce an actionable error rather than silently following a tag.
Builds execute the checkout's Dockerfile with normal Docker semantics; the reviewed manifest is
not an immutable snapshot of a live checkout's build context.

Source mounts require a local Docker endpoint (Unix socket or named pipe). Remote TCP/SSH engines
are refused because their filesystem cannot be assumed to contain the operator's checkout.

## Mixed Lifecycle

Core reserves host ports before startup and validates the complete dependency graph before
launching services. The mixed adapter starts services in dependency order and stops/removes them
in reverse order. It aggregates health and logs. Failure cleanup removes services created by that
start while preserving adopted containers; cleanup failures are reported. Local processes retain
the existing process-tree supervision and container services retain Docker ownership checks.

Peer URLs depend on the consumer: Docker-to-Docker uses the app network's service DNS; host
consumers use assigned loopback ports. A container-to-host edge requires an explicit host-exposed
port and a listener reachable through `host.docker.internal` (Core supplies Docker's host-gateway
mapping). Core does not change a local command's bind address. Existing Docker port publication
semantics remain unchanged: ordinary declared ports publish on loopback, explicit host exposure
publishes on all interfaces. Data/cache targets can name a service; local services receive host
paths while Docker services receive their declared container paths.

Live command/setup edits remain restart-adoptable. Changes to image dependencies, environment
build recipes, mounts, privileges, ports and other protected contract fields require an explicit
manifest update review. The last accepted contract remains usable while a protected edit awaits
review. Ordinary reviewed runtime switching applies to mixed profiles too.

## Telemetry

Telemetry's `dev` profile runs the unchanged third-party collector in Docker, backend through
`dotnet watch`, and UI through Next.js dev. Backend/UI bind loopback. The backend depends explicitly
on the collector's metrics port, receives its assigned loopback URL, and uses the same app-data
logs, traces and `store/telemetry.db` as the Docker profile. Core still provisions collector config
and injects identity verification keys. Reloading source does not restart the collector; an explicit
app restart operates on the whole graph.

`source.paths` restricts source inspection and discard to the three sibling directories
`apps/telemetry`, `apps/telemetry-backend`, and `apps/telemetry-ui`. These are directories relative
to the app source root; unrelated monorepo paths are excluded. Shell/CLI service health details
show execution type and artifact type separately.

## Testing Expectations

- Validate every profile, source/build path containment, image locks and protected manifest changes.
- Cover graph order, cross-runtime URL preflight, recreated versus adopted service cleanup, and
  continued cleanup after a service fails.
- Cover monorepo preview/discard confinement and preserve existing source/profile-switch tests.
- Opt in with `HOSTY_TEST_DOCKER_DEVELOPMENT=1` to run the real Docker/source fixture and Core-managed
  Telemetry ingestion/authentication checks. These use isolated Core state and container names.
- `HOSTY_TEST_TORRENT_SOURCE` points to the companion checkout for the Core-managed Torrent test:
  an empty test VPN folder, SDK source execution, and direct-egress refusal with the firewall closed.
- Add `HOSTY_TEST_TORRENT_VPN=<authorized-profile-folder>` and
  `HOSTY_TEST_TORRENT_METADATA=<legal-test.torrent>` to opt into live VPN acceptance. It verifies real
  payload/pieces, mid-transfer tunnel loss, fresh and established egress refusal, bridge packet capture,
  and automatic transfer recovery. Only its isolated container is interrupted; the VPN mount is read-only.
- Remaining Windows, native Linux and embedded UI acceptance is tracked in the accompanying plan.

# Runtime App Manifest

## Description

Hosty installs user workloads from an app manifest with `schemaVersion: "app.0.1"`. The manifest is the only supported install contract for new local development, tests, and runtime app lifecycle work. Legacy Docker metadata files are not part of the current workflow.

## Manifest Location

Repository-local apps should keep the manifest at:

- `apps/{app-name}/manifest.json`

The Demo App uses:

- `apps/demo-app/manifest.json`

Runtime apps can be installed from:

- an HTTP(S) URL that points directly to a manifest file;
- a local manifest file path;
- a local app directory that contains `manifest.json` directly inside that directory.

For local development, prefer the app directory form so a checked-out runtime app repository can be installed with `hosty apps install .`.

Install the Demo App locally through Core:

```bash
hosty core start
hosty apps install apps/demo-app --runtime dev
hosty apps start com.haas.demo-app
```

## Required Fields

- `schemaVersion` - must be `app.0.1`.
- `id` - stable reverse-DNS app id.
- `name` - display name shown by Shell and CLI.
- `version` - app version.
- `runtimeProfiles` - supported runtime profiles such as `docker` and `localCommand`.
- `services` - one or more services and their runtime-specific implementation.
- `endpoints` - externally visible or internal service endpoints.
- `ui` - Shell entrypoint and navigation metadata when the app has UI.

## Runtime Profiles

`docker` profiles run service images through Docker. `localCommand` profiles run repository-local commands under Core supervision. Core injects app environment such as:

- `HOSTY_APP_ID`
- `HOSTY_APP_SERVICE_KEY`
- `HOSTY_APP_SERVICE_TOKEN`
- `HOSTY_CORE_PUBLIC_ORIGIN`
- `HOSTY_CORE_ORIGIN`
- `HOSTY_APP_DATA_DIR`
- `HOSTY_PORT_{KEY}`
- `HOSTY_DEPENDENCY_{KEY}_URL` (cross-app: another installed app's public endpoint)
- `HOSTY_SERVICE_{KEY}_URL` (intra-app: a sibling service's internal base URL — see below)
- `HOSTY_MOUNT_{KEY}` (one per configured `externalMounts` slot)

`HOSTY_CORE_PUBLIC_ORIGIN` is the browser-facing Core origin. `HOSTY_CORE_ORIGIN` is the runtime process-to-Core origin. For `docker` profiles, loopback Core origins are injected into `HOSTY_CORE_ORIGIN` as a container-reachable origin using `host.docker.internal`, so app server code can exchange Hosty app codes and revalidate identity with Core from inside the container. For `localCommand` profiles, `HOSTY_CORE_ORIGIN` uses Core's listen URL. Published runtime endpoint URLs remain browser-facing `localhost` URLs unless a generated public origin setting overrides them.

For `localCommand` profiles, omit `localPort` and `hostPort` unless the app explicitly requires a fixed local port. Core assigns an available loopback port on first successful start, stores the resulting endpoint URL, reuses that port on later start/restart operations, and exposes it as `HOSTY_PORT_{KEY}`. When a service has exactly one assigned port and did not explicitly set `PORT`, Core also injects `PORT` with the assigned value for framework compatibility.

Use explicit `localPort` / `hostPort` only as an override. If an explicit local command port is already in use, Core fails start instead of launching the process against a conflicting port.

Core publishes local runtime endpoint URLs as `http://localhost:<assigned-port>`. It does not use `127.0.0.1` or `app.localhost` in app URLs. Install review only asks for manifest-owned settings. After installation, each public endpoint gets a Hosty-managed optional setting named `HOSTY_PUBLIC_ORIGIN_{ENDPOINT_KEY}`, where the endpoint key is normalized to uppercase env style. For example, `http` becomes `HOSTY_PUBLIC_ORIGIN_HTTP` and `app.http` becomes `HOSTY_PUBLIC_ORIGIN_APP_HTTP`. The `HOSTY_PUBLIC_ORIGIN_` prefix is reserved for Hosty-managed settings; manifest-provided settings with that prefix are ignored and cannot pre-seed public origins. Leave the generated setting empty for local `localhost` URLs, or set it to an absolute `http`/`https` origin such as `https://project.example.com` when Shell and standalone links should use an externally exposed origin. The public origin setting must be an origin only, without a path, query, or fragment.

### Port fields

Each entry in a service runtime's `ports` array accepts:

- `key` - stable port key; surfaced to the app as `HOSTY_PORT_{KEY}`.
- `containerPort` - the port the service listens on inside the container.
- `localPort` / `hostPort` - explicit host port to pin (otherwise Core assigns one).
- `protocol` - the URL scheme for the published HTTP endpoint (default `http`); not a transport.
- `public` - whether the endpoint is externally visible.
- `expose` - `loopback` (default) or `host`. `host` binds the published port on `0.0.0.0` (all interfaces) instead of `127.0.0.1`, for raw L4 listeners reachable off the host. A `host`-exposed port **must** pin `hostPort` (or `localPort`); recommended `hostPort == containerPort`. Docker runtime only.
- `transport` - subset of `["tcp", "udp"]`, default `["tcp"]`. Each transport is published as a separate `-p` rule. Docker runtime only.

`expose` and `transport` are opt-in and off by default; a port that omits both publishes exactly as before (loopback, TCP). See [Raw L4 ports](raw-ports.md).

### Service network mode

A `docker` service runtime accepts an optional `network` field:

- `network` - `"bridge"` (default) or `"host"`. `"host"` runs the container with `--network host`: it shares the host's network namespace, so its listeners bind the host interfaces directly with no NAT and no `-p` publishing (each declared port's `HOSTY_PORT_{KEY}` carries its `containerPort`). Docker runtime only; `"host"` under `localCommand` is rejected. Off by default.

Host networking is for high-churn peer-to-peer workloads (e.g. BitTorrent) where the docker bridge NAT — and, on Docker Desktop/WSL2, the VM network layer — collapses throughput. It exposes **all** of the service's ports on the host (no per-port isolation), and on Windows/WSL2 also requires WSL2 mirrored networking. See [Host networking](host-networking.md).

### Service dependencies and intra-app discovery

A service may declare `dependsOn` to reference one or more sibling services in the same app. Each entry is either a service-key string or a `{ "service", "port" }` object that names a specific port:

```jsonc
{ "key": "web", "dependsOn": ["api"] }
{ "key": "web", "dependsOn": [{ "service": "api", "port": "internal" }] }
```

`dependsOn` does two things from one declaration:

- **Ordering** — Core starts a depended-on service before its dependents (topological order).
- **Intra-app discovery** — Core injects the depended-on service's **internal** base URL into the dependent as `HOSTY_SERVICE_{KEY}_URL`, where `{KEY}` is the sibling's service key normalized to env style (e.g. `HOSTY_SERVICE_API_URL`). This is distinct from the cross-app `HOSTY_DEPENDENCY_{KEY}_URL` namespace, which resolves a *different* installed app's public endpoint.

The target port is the one named in the object form, otherwise the sibling's first non-`public` port (falling back to its first declared port). A dependency on a sibling that declares no ports is ordering-only and injects no URL. The reachable URL differs by runtime:

- `docker` — siblings join a per-app user network and are reached by service-name DNS at the container port, e.g. `http://api:3000`. The internal port is **not** published to the host, so the management surface stays private.
- `localCommand` — siblings are reached on the loopback host at the sibling's assigned port, e.g. `http://localhost:43210`.

This lets a BFF/proxy service (`web`) reach an internal API service (`api`) without pinning ports app-side or exposing the internal port publicly.

## Source

`source` is optional app-level metadata that describes where Core can obtain the app source when a runtime needs it.

For `docker` runtime profiles, Core starts the declared image and does not need source checkout state.

For `localCommand` runtime profiles, Core resolves a source root before starting services:

- local manifest file and app directory installs use the local worktree that contains the manifest, without cloning `source.repository`;
- HTTP(S) manifest URL installs require `source.repository` to be an absolute clonable Git URL or local repository path;
- administrator `source-override` state takes priority over both local inference and managed checkouts.

Relative source repositories such as `.` are only meaningful for local filesystem installs. They are rejected when starting a `localCommand` runtime from a remote manifest URL.

## Storage

When `data.enabled` is true, Core creates a primary app data directory:

```text
<HOSTY_HOME>/apps/<app-id>/data/
```

Backups cover only this primary app data directory. External mounts and dependency-owned data are outside the backup scope.

## External Mounts

When the app needs large operator-owned host folders outside app data (for example media catalog roots), declare `externalMounts` slots. The manifest declares the slot; the operator binds concrete host paths after install. Core injects each configured slot as `HOSTY_MOUNT_{KEY}` — container paths under `docker`, host paths under `localCommand`. See [External host-path mounts](external-mounts.md) for the full contract.

## User Directory

Runtime apps can read their scoped app directory through Core:

```text
GET /api/internal/apps/{appId}/directory/users
Authorization: Bearer <HOSTY_APP_SERVICE_TOKEN>
```

The response includes enabled Host users explicitly assigned to that app.

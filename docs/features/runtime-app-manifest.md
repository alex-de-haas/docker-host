# Runtime App Manifest

Created: 2026-06-04
Updated: 2026-07-11

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

## App Role

The optional top-level `role` field marks a platform system app:

- `role` - omitted for ordinary runtime apps, or exactly `"system"`. Any other value fails manifest validation (`app_manifest_role_unsupported`), so a manifest written for a newer role vocabulary can never install as an ordinary runtime app by accident.

Install stores the role as the app record's `System` flag and reports it on the install plan (`system: true`) so review UIs can surface the escalation. On a reviewed update, a manifest that newly declares `role: system` adds a `role:runtime->system` entry to the plan changes; confirming the plan applies the escalation. The flag is sticky: dropping `role` from a later manifest never downgrades an installed system app, and no lifecycle path flips `System` outside install and reviewed update.

System apps are administrator surfaces: Core requires an enabled `host.admin` in every app identity flow for them (`system_app_admin_required`), they are hidden from ordinary users' app listings, and they are excluded from user assignments.

A system app that declares `ui` is validated strictly and fail-closed: the entrypoint must name an explicit endpoint that resolves to a declared http(s) endpoint (`app_manifest_system_ui_endpoint_required` / `app_manifest_system_ui_endpoint_unknown` / `app_manifest_system_ui_endpoint_not_http`), page paths must be root-relative with no scheme, host, query, fragment, or backslash (`app_manifest_system_ui_path_invalid`), and duplicate page paths are rejected (`app_manifest_system_ui_path_duplicate`). Ordinary manifests keep the permissive runtime behavior (endpoint fallback, path prefixing).

## Platform Capabilities (`provides`)

The optional top-level `provides` field lists platform capability *slots* the app fulfills — a concept distinct from `capabilities` (the client action list, below) and from a service's `runtimes[].capabilities` (Linux `--cap-add`). Each entry is a lowercase kebab token (`^[a-z][a-z0-9-]{0,62}$`); blanks or duplicates fail validation (`app_manifest_provides_invalid` / `app_manifest_provides_duplicate`). Unknown slot names are accepted (forward-compatible: a manifest may declare a slot a newer Core understands).

Core reacts to a provided slot it has a handler for by running Core-owned provisioning on the app's start path and by ordering the app's autostart relative to others — keyed by the capability, not the app id or how the app was installed. The one slot Core registers today is `otlp-collector`: a provider is given the Core-owned OpenTelemetry collector config and sink directories before its services start, and is started before OTLP-exporting apps so its endpoint resolves first. This is why the telemetry collector works whether it was installed by the boot bootstrap, the marketplace, or a direct `hosty apps install`. See [Generic bootstrap](../ideas/generic-bootstrap.md) (Phase 4).

## Runtime Profiles

Each `runtimeProfiles[]` entry has `key`, `type` (`docker` or `localCommand`), an optional `default: true` (at most one), and an optional `development: true`.

`development: true` marks a runtime meant for local development. It is only valid for a `localCommand` profile (rejected on `docker` with `app_manifest_development_requires_local_command`), and at most one profile per manifest may set it (`app_manifest_multiple_development_runtimes`). A development runtime has two coupled effects: the operator may point it at their own source folder (source override), and it runs **live** from that folder — the manifest is adopted on restart, so there is no reviewed-update path (clients show a "Live" badge and hide Update). A `localCommand` runtime **without** `development` runs from source too, but is treated as a locked, reviewed-update artifact (e.g. it builds a production bundle via `setup`), not as live. See [Runtime artifact & storage model](runtime-artifact-model.md).

`docker` profiles run service images through Docker. `localCommand` profiles run repository-local commands under Core supervision. Core injects app environment such as:

- `HOSTY_APP_ID`
- `HOSTY_APP_SERVICE_KEY`
- `HOSTY_APP_SERVICE_TOKEN`
- `HOSTY_CORE_PUBLIC_ORIGIN`
- `HOSTY_CORE_ORIGIN`
- `HOSTY_APP_DATA_DIR`
- `HOSTY_PORT_{KEY}`
- `HOSTY_DEPENDENCY_{ALIAS}_URL` (cross-app: a wired endpoint of another installed app — see [Cross-app dependencies](cross-app-dependencies.md))
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

### Local command setup

A `localCommand` service runtime accepts an optional `setup` command. Core runs it to completion in the service's `workingDirectory`, with the same injected environment as `command`, **before** starting the long-running `command` — on every start. Use it to prepare the source Core checked out, which ships without installed dependencies or build output:

```json
"dev": {
  "type": "localCommand",
  "workingDirectory": "apps/shell",
  "setup": "npm install",
  "command": "npm run dev"
}
```

Without `setup`, `command` runs against a bare checkout and fails (e.g. `sh: next: command not found`). A non-zero `setup` exit fails the start, with the setup output captured in the service log. Because it runs every start, `setup` must be idempotent (`npm install`, `dotnet restore`, and `pip install` all no-op when already satisfied), which also lets it pick up dependency changes after Core pulls new source. `setup` is `localCommand`-only; declaring it under `docker` is rejected with `app_manifest_service_setup_requires_local_command`.

### Prebuilt artifact

A `localCommand` service may set `artifact: "prebuilt"` to run an already-compiled build (a binary, a compiled Next.js standalone, a static bundle) instead of source. It declares a `delivery` descriptor for where the build comes from — v1 supports `{ "type": "folder", "path": … }`:

```json
"release": {
  "type": "localCommand",
  "artifact": "prebuilt",
  "delivery": { "type": "folder", "path": "dist" },
  "workingDirectory": ".",
  "command": "node server.js"
}
```

The folder `path` resolves relative to the app's source root (or absolute). On start Core content-hashes the folder, materializes an immutable copy under `apps/<id>/runtimes/<key>/artifact/<hash>/`, records the hash as a run-lock (`ArtifactLock.BundleHash`), and runs `command` from the copy (plus any `workingDirectory`). This mirrors the docker image digest lock: Core re-runs the locked copy on every start, and any reviewed update drops the lock so the next start re-hashes and adopts the current delivery (the per-start `rolling` re-hash was removed). `delivery` is required for `prebuilt` (`app_manifest_prebuilt_delivery_required`), rejected for other artifact kinds (`app_manifest_delivery_requires_prebuilt`), and `prebuilt` is `localCommand`-only. Update plans do not yet probe prebuilt movement, so a changed delivery under an unchanged manifest surfaces only through the next reviewed update. See [Runtime artifact & storage model](runtime-artifact-model.md).

### Service network mode

A `docker` service runtime accepts an optional `network` field:

- `network` - `"bridge"` (default) or `"host"`. `"host"` runs the container with `--network host`: it shares the host's network namespace, so its listeners bind the host interfaces directly with no NAT and no `-p` publishing (each declared port's `HOSTY_PORT_{KEY}` carries its `containerPort`). Docker runtime only; `"host"` under `localCommand` is rejected. Off by default.

Host networking is for high-churn peer-to-peer workloads (e.g. BitTorrent) where the docker bridge NAT — and, on Docker Desktop/WSL2, the VM network layer — collapses throughput. It exposes **all** of the service's ports on the host (no per-port isolation), and on Windows/WSL2 also requires WSL2 mirrored networking. See [Host networking](host-networking.md).

### Service capabilities and devices

A `docker` service runtime accepts two optional privileged lists (empty by default):

- `capabilities` - Linux capabilities to add (`--cap-add`), e.g. `["NET_ADMIN"]`. Accepted with or without the `CAP_` prefix; must be real capability names. No blanket `--privileged`.
- `devices` - host device nodes to expose (`--device`), each an absolute path under `/dev`, e.g. `["/dev/net/tun"]`.

Both are docker-only (rejected under `localCommand`), widen container privilege, and are surfaced for install review. The canonical use is an in-container VPN (`NET_ADMIN` + `/dev/net/tun`). See [Container capabilities & devices](container-capabilities.md).

### Service dependencies and intra-app discovery

A service may declare `dependsOn` to reference one or more sibling services in the same app. Each entry is either a service-key string or a `{ "service", "port" }` object that names a specific port:

```jsonc
{ "key": "web", "dependsOn": ["api"] }
{ "key": "web", "dependsOn": [{ "service": "api", "port": "internal" }] }
```

`dependsOn` does two things from one declaration:

- **Ordering** — Core starts a depended-on service before its dependents (topological order).
- **Intra-app discovery** — Core injects the depended-on service's **internal** base URL into the dependent as `HOSTY_SERVICE_{KEY}_URL`, where `{KEY}` is the sibling's service key normalized to env style (e.g. `HOSTY_SERVICE_API_URL`). This is distinct from the cross-app `HOSTY_DEPENDENCY_{ALIAS}_URL` namespace, which wires an endpoint of a *different* installed app (see [Cross-app dependencies](cross-app-dependencies.md)).

The target port is the one named in the object form, otherwise the sibling's first non-`public` port (falling back to its first declared port). A dependency on a sibling that declares no ports is ordering-only and injects no URL. The reachable URL differs by runtime:

- `docker` — siblings join a per-app user network and are reached by service-name DNS at the container port, e.g. `http://api:3000`. The internal port is **not** published to the host, so the management surface stays private.
- `localCommand` — siblings are reached on the loopback host at the sibling's assigned port, e.g. `http://localhost:43210`.

This lets a BFF/proxy service (`web`) reach an internal API service (`api`) without pinning ports app-side or exposing the internal port publicly.

### Cross-app dependencies

A top-level `dependencies` array declares dependencies on **other installed apps** (distinct from intra-app `dependsOn`):

```jsonc
"dependencies": [
  { "id": "com.haas.torrent-engine", "required": true, "endpoints": [{ "key": "control", "as": "torrent" }] }
]
```

Each wired endpoint is injected into this app as `HOSTY_DEPENDENCY_{ALIAS}_URL` (alias defaults to the endpoint `key`). A cross-app dependency is discovery + a start-time advisory only — Core does not auto-install/auto-start the dependency, and it is **not** an access barrier. See [Cross-app dependencies](cross-app-dependencies.md).

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

## Catalog Metadata

Optional catalog-style display metadata for an installed app. It is **entirely optional** and its content lives **outside runtime validation** — a manifest without it is fully valid, and its values never fail runtime validation (Core normalizes them best-effort *after* parsing and surfaces them for display only). It must still be well-formed, deserializable JSON of the shape below: a type mismatch (e.g. `tags` as a string instead of an array) fails the whole manifest parse like any other field. Strict content checks (SPDX license, category enum) belong to catalog publishing, not Core. The Marketplace app reads display-ready metadata from its catalog entry and does not query Core for installed manifest metadata. See [Marketplace System App](runtime-app-marketplace.md) for the catalog boundary.

```json
"catalogMetadata": {
  "publisher": { "name": "Example Co", "url": "https://example.com", "email": "team@example.com" },
  "category": "Productivity",
  "tags": ["notes", "sync"],
  "icon": "assets/icon.png",
  "screenshots": ["assets/1.png", "assets/2.png"],
  "license": "AGPL-3.0-only",
  "links": { "website": "https://example.com", "docs": "https://example.com/docs", "support": "https://example.com/help" },
  "summary": "Take notes.",
  "description": "A longer description shown on the app detail page.",
  "changelog": "0.1.0 — initial release"
}
```

All fields are optional; blanks are dropped and an all-empty block is ignored. `category` is catalog-style metadata, distinct from the simpler `ui.category` used by the app directory. `icon` is an asset path or URL (richer than `ui.icon`, which is a Lucide name). Core exposes the normalized block on each installed app summary as `catalogMetadata` for Shell's installed-app surfaces.

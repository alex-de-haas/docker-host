# App Manifest Reference

Use this reference when authoring or reviewing Hosty runtime app manifests, storage, settings, dependencies, endpoints, install/update behavior, or app data backups.

## Sources Of Truth

- `docs/features/runtime-app-manifest.md`
- `docs/features/hosty-runtime-app-platform.md`
- `apps/core/src/Haas.Hosty.Core/RuntimeAppManifest.cs`
- `apps/demo-app/manifest.json`

## Required Contract

- `schemaVersion` must be `app.0.1`.
- Store repository-local manifests as `apps/{app-name}/manifest.json`.
- Local installs can pass the app directory that contains `manifest.json`; from inside a runtime app repository, use `hosty apps install .`.
- Remote installs must pass an HTTP(S) URL that points directly to the manifest file.
- Define one or more runtime profiles.
- Define one or more services.
- Define endpoints for service access.
- Define `ui.entrypoint` when the app has a Shell UI.
- Do not set the top-level `role` field: it accepts only `"system"` (anything else fails validation), and `role: "system"` is reserved for first-party platform system apps. A system app is administrator-only and hidden from ordinary users, which is wrong for a domain app.

## Versioning

The manifest carries two independent version fields:

- `schemaVersion` - the manifest *contract* version, owned by Hosty Core (the required value is fixed under Required Contract above). Do not change it for ordinary app changes; it moves only when the manifest format itself changes.
- `version` - the app's own release version, in `major.minor.patch` semver. Bump it in the same change that ships the work:
  - **patch** (`x.y.Z`) - bug fix or small enhancement to existing functionality.
  - **minor** (`x.Y.0`) - new functionality, or a large change to existing functionality. While the app is in `0.x`, breaking changes also go here.
  - **major** (`X.0.0`) - reserved until the app declares a stable `1.0.0`; after that, breaking changes for the app's users (breaking data migration, removed endpoint/behavior, or requiring a higher `schemaVersion`).

Each runtime app versions independently from Hosty Core/CLI and from other apps. See `docs/features/repository-release-model/feature.md` for the repository-wide policy.

## Runtime Environment

Core injects:

- `HOSTY_APP_ID`
- `HOSTY_APP_SERVICE_KEY`
- `HOSTY_APP_SERVICE_TOKEN`
- `HOSTY_CORE_ORIGIN`
- `HOSTY_APP_DATA_DIR`
- `HOSTY_PORT_{KEY}`
- `HOSTY_DEPENDENCY_{KEY}_URL` (cross-app: another installed app's public endpoint)
- `HOSTY_SERVICE_{KEY}_URL` (intra-app: a sibling service's internal base URL — see Service Dependencies)
- `HOSTY_MOUNT_{KEY}` (one per declared `externalMounts` slot — see External Mounts)
- `OTEL_*` (only when the app opts into `telemetry` and the host has observability enabled — see Telemetry)

For `localCommand` runtime profiles, do not hard-code development ports by default. Omit `localPort` and `hostPort` so Core assigns an available loopback port and injects it as `HOSTY_PORT_{KEY}`. If a service declares exactly one port and the app did not explicitly set `PORT`, Core also injects `PORT=<assigned-port>` for common dev servers such as Next.js.

A `localCommand` service may declare `setup` — a one-shot preparation command Core runs to completion **before** `command`, in the same `workingDirectory` with the same environment. Use it to install dependencies or build from the source Core checked out (`npm install`, `dotnet restore`, `pip install`, …); that checkout has no `node_modules`/build artifacts, so a source-run app that needs them must declare `setup` or its `command` fails to start. Setup runs on every start (it should be idempotent — `npm install` no-ops when up to date), so it also picks up dependency changes after Core pulls new source. A non-zero exit fails the start with the setup output in the service log. `setup` is `localCommand`-only; declaring it under `docker` is rejected with `app_manifest_service_setup_requires_local_command`.

### Runtime Artifact Kind

Each `services[].runtimes[<key>]` may declare `artifact`, which tells Core how the running code is delivered and therefore how it updates:

- `image` — a compiled OCI image. The update is **locked**: Core resolves the tag to an immutable digest and pins it, so restarts are deterministic and advancing it is a reviewed change (the `rolling` per-start re-resolve was removed; `updatePolicy` accepts only `pinned`). This is the default (and only supported value) for `docker`.
- `source` — code that runs **live** from the operator's own folder. There is no run-lock; Core re-reads and reconciles the manifest on each start. This is the default (and only supported value) for `localCommand`.

`artifact` is optional — when omitted Core infers it from the runtime type (`docker` → `image`, `localCommand` → `source`), so existing manifests need no change. Declaring a value that does not match its runtime (e.g. `artifact: source` under `docker`) is rejected with `app_runtime_artifact_unsupported`. `prebuilt` is reserved and not yet supported.

### Service Dependencies

A service's `dependsOn` lists sibling services. Each entry is a service-key string (`"api"`) or a `{ "service", "port" }` object naming a specific port. From that one declaration Core both **orders** startup (the depended-on service starts first) and injects the sibling's **internal** base URL as `HOSTY_SERVICE_{KEY}_URL` (e.g. `HOSTY_SERVICE_API_URL`). Use this for a BFF/proxy service to reach an internal API service without pinning ports or exposing the internal port publicly:

- Target port = the named port, else the sibling's first non-`public` port.
- `docker`: resolves by service-name DNS on a per-app network, e.g. `http://api:3000` (internal port not host-published).
- `localCommand`: resolves over loopback, e.g. `http://localhost:43210`.
- Distinct from `HOSTY_DEPENDENCY_{KEY}_URL` (cross-app public endpoint); the two namespaces never collide.

Use explicit `localPort` only when a fixed local port is a real requirement. If that port is occupied, Core fails start with a lifecycle error instead of silently routing Shell to another app.

## Settings

Manifest settings are app-owned configuration. Each entry supports `key`, `type`, `default`, `secret`, `required`, and the optional presentation fields `label` and `description`. Settings marked `required: true` are highlighted in the Shell and surface a configuration warning until the operator provides a value. Do not define settings with the `HOSTY_PUBLIC_ORIGIN_` prefix. That prefix is reserved for Hosty-managed public endpoint origin settings, and Core ignores manifest-provided entries with that prefix so apps cannot pre-seed redirect origins.

`label` and `description` are presentation-only hints for the Shell settings and install-review UI: `label` replaces the raw env-var `key` as the field's friendly name (the `key` stays visible on hover), and `description` surfaces as an info-icon tooltip next to the label (shown on hover or focus). Both are optional — omit them and the Shell falls back to showing the `key`. Core never validates or acts on either.

```jsonc
"settings": [
  {
    "key": "APP_MODE",
    "type": "string",           // "string" | "number" | "boolean" | "url"
    "default": "standard",
    "required": true,
    "label": "Operating mode",  // optional: friendly name shown instead of the key
    "description": "Controls how the app processes incoming requests." // optional: help text
  }
]
```

## Storage And Backups

Use `data.enabled: true` when the app needs a primary persistent data directory. Backups cover that primary app data directory only.

When an operator takes a manual backup of a running app, Core briefly stops and restarts the app to copy a consistent snapshot (the same happens for updates and runtime switches). Design the app to tolerate a clean stop/restart at any time and to flush or checkpoint persistent state on shutdown.

### Cache Directory

Use `cache.enabled: true` for **derived, rebuildable data** — media indexes, transcode output, downloaded artwork — that would bloat backups for nothing. The cache directory persists across restarts, updates, and runtime switches like `data` does, but it is never backed up and never restored, and it is deleted together with `data` when the operator removes the app with its data. The block mirrors `data` exactly:

```jsonc
"cache": {
  "enabled": true,
  "targets": [
    { "runtime": "docker", "service": "api", "containerPath": "/app/cache", "environment": "HOSTY_APP_CACHE_DIR" },
    { "runtime": "dev", "environment": "HOSTY_APP_CACHE_DIR" }
  ]
}
```

- Under a `docker` profile with no explicit target, Core synthesizes the default: `/app/cache` bind-mounted into the first service, announced as `HOSTY_APP_CACHE_DIR`.
- Under `localCommand`/`dev` runtimes no target is needed: `enabled: true` alone injects `HOSTY_APP_CACHE_DIR` with the host path.
- **The app must treat cache content as absent-at-any-time**: a restore can make the database older than the cache, a runtime switch to a profile without a cache target runs without the variable entirely (that is not an error, unlike a missing `data` target), and the operator may delete the directory between runs. Key cache entries so stale ones invalidate themselves — for example by stamping them with the source file's size and mtime.
- Additive under `app.0.1`; a Core that predates the contract simply never sets the variable, so apps should fall back (typically to a subdirectory of `HOSTY_APP_DATA_DIR`).

## External Mounts

Use `externalMounts` when the app needs large operator-owned host folders that live **outside** app data — for example media catalog roots. Unlike `data`, external mounts are operator-configured after install, are never backed up or deleted by Hosty, and survive update / restart / runtime-switch / app removal.

Declare slots in the manifest. The manifest declares *what the app can accept*; the operator later binds concrete host paths to each slot.

```jsonc
"externalMounts": {
  "catalogRoots": {
    "kind": "host-path",   // only "host-path" is supported
    "multiple": true,       // allow more than one host path in this slot
    "mode": "rw",           // "rw" (default) or "ro" — authoritative, the operator cannot change it
    "service": "api",       // optional: bind only into this service (omit = all services)
    "required": true         // optional: Core blocks start until at least one path is configured
  }
}
```

- Slot keys match `^[A-Za-z][A-Za-z0-9_-]{0,62}$` (camelCase is allowed).
- The operator configures each path with a stable **label**; Core exposes it at a deterministic container path `/mnt/{key}/{label}` so it does not move when sibling paths are added or removed.

**How Core injects it.** For each slot that has configured paths, Core injects `HOSTY_MOUNT_{KEY}` (the key uppercased, non-alphanumerics → `_`) with the active bindings comma-joined as `label=path` and sorted by label:

- Under the `docker` runtime the path is the container path, and each path is bind-mounted (`-v host:/mnt/{key}/{label}[:ro]`):
  `HOSTY_MOUNT_CATALOGROOTS=anime=/mnt/catalogRoots/anime,movies-4k=/mnt/catalogRoots/movies-4k`
- Under `localCommand`/`dev` there is no container, so the path is the operator host path read directly:
  `HOSTY_MOUNT_CATALOGROOTS=anime=/srv/anime,movies-4k=/srv/movies-4k`

Read the variable, split on `,`, then split each entry on the **first** `=` into `label` and `path` — the contract is identical across runtimes. Each path is a single bind/mount point, so hardlinks work within one path but not across two different paths. The label is each bind's stable key; use it to address a specific mount (e.g. to pair a root with a sibling app's mount on the same host path). A host path may contain `=`, so split on the first `=` only (labels match `^[a-z0-9][a-z0-9._-]{0,62}$`).

**App responsibilities.** Validate each injected root yourself (e.g. exists, is a single filesystem via `st_dev` if you hardlink within it). Do not assume two roots share a filesystem.

**Operator configuration.** Paths are not in the manifest. The operator sets them via Core (`POST /api/apps/{appId}/mounts`, admin-only) after install. Core rejects host paths inside the Hosty data root or sensitive system paths, and fails app start if a configured path does not exist.

## Telemetry

Opt in to OpenTelemetry export with a top-level `telemetry` block (additive; absent or `enabled: false` means the app emits nothing). `docker` runtime only in v1.

```jsonc
"telemetry": {
  "enabled": true,       // opt in to OTLP export
  "sampleRatio": 0.1      // optional, traces head-sample ratio in [0,1] (default 0.1)
}
```

When the app opts in **and** the host has observability enabled (`HOSTY_OBSERVABILITY_ENABLED=1`, off by default), Core injects the standard OpenTelemetry env so any OTel SDK exports with no app-specific wiring:

- `OTEL_EXPORTER_OTLP_ENDPOINT` — the collector's OTLP/HTTP origin (reachable from the container).
- `OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf`
- `OTEL_SERVICE_NAME` — the app id; `OTEL_RESOURCE_ATTRIBUTES` also carries `hosty.app.id` and `hosty.app.service`.
- `OTEL_TRACES_SAMPLER=parentbased_traceidratio` with `OTEL_TRACES_SAMPLER_ARG` = `sampleRatio`.

Instrument with your language's OTel SDK and read these env vars (most SDKs read them automatically). If the env is absent, observability is off or the collector is not up yet — degrade gracefully and emit nothing. See `docs/features/observability/feature.md`.

`OTEL_EXPORTER_OTLP_ENDPOINT` is the base endpoint for all signals — traces, metrics, and **logs** (`/v1/logs`). Apps that want structured, trace-correlated logs only need to enable their OTel logs SDK (no extra Hosty config). These OTLP logs are a **separate stream** from the app's console (`docker logs`) output and are never merged with it; Core/Shell support for receiving and viewing them is planned for P4 (the collector currently has no logs pipeline).

## Interfaces

Declare platform interfaces the app exposes for other components to discover with a top-level `interfaces` map (draft extension, additive under `app.0.1`; absent means the app exposes none). Keys are interface names (lowercase kebab, e.g. `ai-gateway`); unknown names are inert and forward-compatible, like `provides` slots. Each declaration names an HTTP surface on the app's own origin:

```jsonc
"interfaces": {
  "ai-gateway": [
    {
      "key": "default",     // optional, names the declaration within the interface (default "default")
      "endpoint": "web",    // optional endpoints[] key that serves the interface (same reference as ui.entrypoint.endpoint)
      "path": "/api/ai"     // absolute path on that origin (default "/")
    }
  ]
}
```

Core validates shape only (names and keys are kebab tokens, keys unique per interface, paths absolute) and surfaces the declarations on the apps API with each declaration resolved to a ready-to-call URL, so clients can gate features on an installed provider — e.g. Shell shows its assistant UI only when an installed app declares `ai-gateway`. Declaring an interface does not grant the app anything; it is discovery metadata. See `docs/features/ai-agent-bridge/feature.md` ("Manifest Interfaces And Registry").

## UI Surfaces

`ui.entrypoint` and `ui.navigation` place an app's pages in a shell's sidebar. Two optional sibling
fields place pages elsewhere, chosen by **who the page is for and what it changes** — not by whether
it looks like settings:

```jsonc
"ui": {
  "entrypoint": { "endpoint": "http", "path": "/" },
  "navigation": [ { "label": "People", "path": "/people" } ],

  // At most one. Lands on Shell's Settings page, which is administrator-only.
  "settings": { "endpoint": "http", "path": "/settings" },

  // Any number. Tabs on Shell's right panel, docked beside the content.
  "panels": [ { "label": "Session", "endpoint": "http", "path": "/panel" } ]
}
```

| Field | How many | Audience | Where it lands |
| --- | --- | --- | --- |
| `ui.navigation` | any | users | the shell's sidebar |
| `ui.settings` | at most one | administrators | a tab on Shell's Settings page |
| `ui.panels` | any | users | tabs on Shell's right panel |

Litmus tests: *would a `host.user` ever legitimately open it?* → `navigation` or `panels`. *Does it
change the app's behaviour rather than produce or consume content?* → `settings`.

**A sidebar row comes from `ui.navigation` and nothing else.** An app that declares `ui.entrypoint`
but no navigation gets no pages in a shell — no sidebar row, no entry on the Apps page. The
entrypoint still says where `hosty apps open` and an explicit deep link land; it does not buy a
place in the navigation. Declare navigation for every page you want offered.

Both fields are additive under `app.0.1` and need no `schemaVersion` bump. `endpoint` is optional and
defaults to the entrypoint's; `path` is absolute on that origin. A panel's `label` names its tab —
several apps' tools share one strip, so the app's own name is a poor label, and a system app must
declare one. Two panels of one app may not share a label.

**A surface declaration is placement metadata, not access control.** The page stays reachable
standalone (`hosty apps open`) and Shell's embedding grants it nothing, so the app keeps enforcing
its own authorization on every request regardless of where it is embedded. For a `role: system` app
Core does refuse a non-administrator a session at all — `RequireAccessibleUserAsync` runs on every
identity flow including revalidation — but an ordinary app gets no such rule and must check for
itself.

Embedded surfaces authenticate exactly like a sidebar page: Shell mints a launch code and the frame
lands with a real Hosty app session (see `app-auth-and-users.md`). A surface that only works with a
delegated token is an app authenticating differently from every other, not a supported shape.

While the app is stopped its tabs remain, dimmed and saying so, rather than disappearing — a surface
that vanished with its app would read as uninstalled.

## Agent Skill

An app may ship the prose an agent needs to use it well, as a sibling of `interfaces`:

```jsonc
"agent": {
  "skillFile": "docs/agent.md"   // manifest-relative markdown, inside the app's own folder
}
```

Deliberately **not** in `catalogMetadata` beside `descriptionFile`. That block is display-only and
outside runtime validation; this is prose a model acts on, so its path is validated at install —
relative, contained in the manifest folder, `.md` — and a declaration that escapes is refused there
rather than resolving to nothing later. Core vendors the file with the other assets, under the same
byte budget.

**One per app.** An app with several `interfaces.mcp` entries still has one story about how it is
worked; division is sections in the file, not another axis here.

### Who reads it

| Reader | When |
| --- | --- |
| The Hosty assistant | the app's MCP provider is enabled, and the session actually got its tools |
| `hosty mcp` | the app contributed tools to the connector's catalog |

There is **no separate switch**. Enabling an app's MCP provider already accepts that its text enters
the model's context — a tool arrives with its description and there is no version of it that does
not — so a second toggle would ask the operator the same question twice.

Wherever it lands, the skill is fenced and attributed, under a preamble naming it as documentation an
app wrote about its own tools, which speaks for nobody else and grants nothing. Write it accordingly:
guidance for calling *this* app.

### What belongs in it

Procedure, not inventory. Restating tool descriptions duplicates what MCP already carries and goes
stale separately. Worth writing:

- which tool to call first, and what its answer decides;
- what the app's domain words mean, especially where they collide with Hosty's (an app role is not a
  host role);
- what a refusal means and whether retrying can fix it;
- what the app does **not** know, so an agent stops guessing.

Capped when delivered (8,000 characters), so one app cannot crowd out the operator's own instructions
or another app's.

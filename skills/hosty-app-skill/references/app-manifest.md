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

## Runtime Environment

Core injects:

- `HOSTY_APP_ID`
- `HOSTY_APP_SERVICE_KEY`
- `HOSTY_APP_SERVICE_TOKEN`
- `HOSTY_CORE_ORIGIN`
- `HOSTY_APP_DATA_DIR`
- `HOSTY_PORT_{KEY}`
- `HOSTY_DEPENDENCY_{KEY}_URL`
- `HOSTY_MOUNT_{KEY}` (one per declared `externalMounts` slot — see External Mounts)

For `localCommand` runtime profiles, do not hard-code development ports by default. Omit `localPort` and `hostPort` so Core assigns an available loopback port and injects it as `HOSTY_PORT_{KEY}`. If a service declares exactly one port and the app did not explicitly set `PORT`, Core also injects `PORT=<assigned-port>` for common dev servers such as Next.js.

Use explicit `localPort` only when a fixed local port is a real requirement. If that port is occupied, Core fails start with a lifecycle error instead of silently routing Shell to another app.

## Settings

Manifest settings are app-owned configuration. Each entry supports `key`, `type`, `default`, `secret`, and `required`. Settings marked `required: true` are highlighted in the Shell and surface a configuration warning until the operator provides a value. Do not define settings with the `HOSTY_PUBLIC_ORIGIN_` prefix. That prefix is reserved for Hosty-managed public endpoint origin settings, and Core ignores manifest-provided entries with that prefix so apps cannot pre-seed redirect origins.

## Storage And Backups

Use `data.enabled: true` when the app needs a primary persistent data directory. Backups cover that primary app data directory only.

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

**How Core injects it.** For each slot that has configured paths, Core injects `HOSTY_MOUNT_{KEY}` (the key uppercased, non-alphanumerics → `_`) with the active paths comma-joined and sorted by label:

- Under the `docker` runtime the value is the container paths, and each path is bind-mounted (`-v host:/mnt/{key}/{label}[:ro]`):
  `HOSTY_MOUNT_CATALOGROOTS=/mnt/catalogRoots/anime,/mnt/catalogRoots/movies-4k`
- Under `localCommand`/`dev` there is no container, so the value is the operator host paths read directly:
  `HOSTY_MOUNT_CATALOGROOTS=/srv/anime,/srv/movies-4k`

Read the variable, split on `,`, and use whatever paths it contains — the contract is identical across runtimes. Each path is a single bind/mount point, so hardlinks work within one path but not across two different paths.

**App responsibilities.** Validate each injected root yourself (e.g. exists, is a single filesystem via `st_dev` if you hardlink within it). Do not assume two roots share a filesystem.

**Operator configuration.** Paths are not in the manifest. The operator sets them via Core (`POST /api/apps/{appId}/mounts`, admin-only) after install. Core rejects host paths inside the Hosty data root or sensitive system paths, and fails app start if a configured path does not exist.

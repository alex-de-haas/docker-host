# Hosty runtime app platform

This document describes the implemented Hosty compatibility foundation that broadens Docker Host from Docker-only modules toward a Hosty Core, Shell, and runtime app model.

## Description

Hosty is the target product model for the current Docker Host implementation. The existing Docker module runtime remains supported, but new code and documentation should use these terms:

- **Hosty Core** - the backend API and orchestration process.
- **Hosty Shell** - the browser management UI client for Hosty Core.
- **System app** - a Hosty-owned app or service, initially Hosty Shell.
- **Runtime app** - an installed workload managed by Hosty, including legacy Docker modules.
- **Manifest** - the public contract name for app metadata. Legacy `metadata.json` remains a compatibility format.
- **Runtime profile** - the way an app runs, such as Docker image or local command.

The implementation is intentionally incremental. Docker remains the first runtime adapter and the legacy module engine still owns most lifecycle behavior. The app model is layered around it through compatibility adapters.

```mermaid
flowchart LR
  A["hosty CLI"] --> B["Hosty Core control API"]
  C["Hosty Shell"] --> B
  B --> D["System app registry"]
  B --> E["apps.json"]
  B --> F["modules.json compatibility adapter"]
  B --> G["Docker runtime adapter"]
  B --> H["App data backups"]
```

## Data root selection

The preferred Hosty data root is:

```text
~/.hosty
```

The legacy data root remains:

```text
~/.docker-host
```

Selection rules:

- `HOSTY_HOME` overrides the CLI root.
- Legacy `DOCKER_HOST_HOME` is still accepted as a compatibility override.
- When no override is set, `~/.hosty` is used if it exists.
- If `~/.hosty` does not exist and `~/.docker-host` exists, the legacy root remains active.
- If neither exists, new installations create and use `~/.hosty`.
- If both roots exist, `~/.hosty` wins. Hosty does not merge state automatically.

The default `HOST_DATA_ROOT_HOST` follows the selected root. This lets existing installations keep working while new installations use Hosty naming.

## CLI naming

The preferred command is now:

```text
hosty
```

The managed CLI installer and self-update flow create or refresh both:

- `hosty` - preferred command;
- `docker-host` - deprecated compatibility alias.

The command surface is otherwise intentionally compatible. Existing commands such as lifecycle, config, auth, dev, and module management still work. New app-oriented commands prefer:

```text
hosty apps list
hosty apps install <manifest-url>
hosty apps backup <app-id>
hosty apps backups <app-id>
hosty apps restore <app-id> <backup-id>
```

The legacy command group remains:

```text
docker-host modules ...
hosty modules ...
```

`hosty apps` is the preferred app-management alias. `hosty modules` remains for legacy scripts and documentation during the migration window.

## App registry and compatibility stores

The target app layout for new app-oriented records is:

```text
<hosty-data-root>/
  apps.json
  apps/
    <app-id>/
      manifest.json
      data/
  backups/
    <app-id>/
```

The legacy layout remains readable:

```text
<hosty-data-root>/
  modules.json
  modules/
    <module-id>/
      metadata.json
```

Current implementation details:

- `apps.json` is created and maintained as the app-oriented registry.
- New installs still use the legacy module lifecycle engine, but they also upsert an app record into `apps.json`.
- App manifest copies are written to `apps/<app-id>/manifest.json`.
- Legacy Docker metadata copies remain in `modules/<module-id>/metadata.json` for legacy module records.
- Records can contain both `manifestUrl` and legacy `metadataUrl`.
- Records can contain both `manifestPath` and legacy `metadataPath`.
- Compatibility code is isolated around root resolution, registry reading, manifest path resolution, and CLI aliases so it can be removed later.

Routine update does not migrate legacy data directories. Legacy modules discovered from `modules.json` continue updating in place through the legacy path.

## System apps and runtime apps

The app registry API now returns app summaries with these fields:

- `kind` - `system` or `runtime`;
- `system` - `true` for Hosty-owned system apps;
- `source` - `system`, `installed`, or `developer`;
- `selectedRuntime`;
- `selectedChannel`;
- `capabilities`.

Hosty Shell is synthesized as a system app:

```json
{
  "id": "hosty.shell",
  "kind": "system",
  "system": true,
  "source": "system",
  "displayName": "Hosty Shell",
  "version": "bundled",
  "selectedRuntime": "host-core",
  "capabilities": ["open", "update"]
}
```

The Apps portal and local control API separate system apps from runtime apps. System apps are non-removable and should not expose ordinary runtime app stop/remove actions.

## Manifest compatibility

`manifestUrl` is the preferred request field for new installs. Legacy `metadataUrl` remains accepted.

Supported inputs:

- legacy Docker module metadata with `schemaVersion: "0.2"`;
- legacy Docker module metadata with `schemaVersion: "0.3"`;
- new app manifests with `schemaVersion: "app.0.1"`.

The first `app.0.1` implementation maps app manifests into the legacy Docker module runtime model before planning. This keeps install/update safety behavior while allowing new manifests to use app vocabulary.

Supported `app.0.1` fields in the adapter:

- `id`, `name`, `description`, `version`;
- optional `source` for Git metadata;
- optional `channelsUrl`;
- `runtimes` with `docker` and `localCommand` profiles;
- `defaultRuntime`;
- `ui`;
- `data`;
- `storage`;
- `settings`;
- `dependencies` with `manifestUrl` or `metadataUrl`;
- `endpoints`.

Docker runtime profiles can be installed through the existing Docker module engine. Local command runtime profiles can be parsed and normalized, but production local-process runtime execution is not implemented yet.

Example minimal app manifest:

```json
{
  "schemaVersion": "app.0.1",
  "id": "com.example.notes",
  "name": "Notes",
  "version": "1.2.3",
  "runtimes": [
    {
      "key": "docker",
      "type": "docker",
      "image": "ghcr.io/example/notes:1.2.3",
      "ports": [
        {
          "key": "http",
          "containerPort": 3000,
          "protocol": "http"
        }
      ]
    }
  ],
  "ui": {
    "entrypoint": "/"
  },
  "data": {
    "enabled": true,
    "targets": [
      {
        "runtime": "docker",
        "containerPath": "/app/data"
      }
    ]
  }
}
```

## App data directory

Each runtime app has its own primary data directory. For new app manifests, the target path is:

```text
<hosty-data-root>/apps/<app-id>/data/
```

For legacy modules, existing module-owned storage mappings remain valid. Hosty resolves the primary app data directory in this order:

- `apps/<app-id>/data/` when it exists;
- legacy installed storage mapping with key `data`;
- legacy installed storage mapping whose host path ends in `data`;
- otherwise the target `apps/<app-id>/data/` path.

The Docker runtime injects `HOSTY_APP_DATA_DIR` when a data storage mapping exists. External mounts and additional storage mappings are not treated as Hosty-managed app data.

## App data backups

Hosty creates ZIP backups for the primary app `data/` directory only. External mounts are intentionally excluded.

Backup layout:

```text
<hosty-data-root>/backups/<app-id>/
  2026-06-01T12-00-00Z_manual.zip
  2026-06-01T12-00-00Z_manual.json
```

Backup metadata includes:

- app id;
- backup id;
- reason;
- created time;
- live data path;
- archive path;
- archive digest;
- archive size;
- file count.

Implemented backup reasons:

- `pre-update`;
- `manual`;
- `pre-restore`;
- `pre-runtime-switch`;
- `scheduled`.

Current behavior:

- `module update` apply creates a `pre-update` backup when the app data directory exists.
- Manual backup is available through `POST /control/v1/apps/{appId}/backups`.
- Backup listing is available through `GET /control/v1/apps/{appId}/backups`.
- Restore is available through `POST /control/v1/apps/{appId}/backups/{backupId}/restore`.
- Restore requires `confirmed=true`.
- Restore stops the app first by default.
- Restore creates a `pre-restore` backup by default.
- Restore verifies archive digest and per-entry CRC before replacing data.
- Restore does not automatically restart the app.

CLI commands:

```text
hosty apps backup <app-id>
hosty apps backups <app-id>
hosty apps restore <app-id> <backup-id>
```

## Not implemented yet

The following concepts remain planned, not implemented:

- product channel index download and `hosty update --channel`;
- runtime app channel discovery and switching;
- runtime profile switch planning and apply;
- repository checkout/cache and local command runtime process supervision;
- standalone auth redirect code exchange for Hosty-aware apps;
- optional gateway-protected app mode as a manifest-level access setting;
- agent bridge annotations, repository edits, and pull request channel promotion.

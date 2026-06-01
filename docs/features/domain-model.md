# Docker Host domain model

This document defines the Docker Host domain model. It is the shared vocabulary for Host backend API, Web UI, CLI module commands, and persistent files.

## Scope

The product model is module-first. Docker containers are an implementation detail managed by Docker Host, not the primary user-facing entity.

The domain model covers:

- installed module registry;
- Docker runtime status for installed modules;
- module start, stop, and restart actions;
- failed install retry and cleanup;
- installed module removal;
- module update planning, apply, and retry;
- persistent launch and module state files;
- settings, storage, and dependency contracts.

The domain model does not include:

- settings edit UI and APIs;
- storage configuration UI and APIs;
- module health checks beyond Docker daemon state;
- authentication and authorization details, which are covered by [Auth Gateway](auth-gateway.md).

## Core Entities

```mermaid
flowchart LR
  A["Metadata URL"] --> B["Module metadata"]
  B --> C["Install plan"]
  C --> D["Installed module registry entry"]
  D --> E["Module directory"]
  D --> F["Docker containers"]
  G["Docker daemon"] --> H["Runtime status"]
  F --> H
  D --> I["Web UI and Host API"]
  H --> I
```

### Module metadata

Module metadata is the JSON document downloaded from a metadata URL and copied into the installed module directory as `metadata.json`.

It defines:

- stable module identity: `id`, `name`, `version`;
- module-owned containers and Docker image references;
- dependency declarations;
- settings schema;
- storage declarations;
- module endpoints, container ports, and resource hints.

The metadata schema source of truth is [Module metadata files](module-metadata.md).

### Installed module

An installed module is a module metadata document plus Host-owned persistent state.

The installed module record is stored in root-level `modules.json` and includes:

- `id`;
- `metadataUrl`;
- `metadataPath`;
- `containers[]` with container names, network aliases, and image references;
- install/update bookkeeping status;
- setting values, including write-only secret values;
- computed storage mappings;
- resolved dependency URLs;
- timestamps;
- last operation error.

Docker runtime status is not persisted in the installed module record. The Host reads it from Docker daemon when serving API responses.

`modules.json` is also the location for any Host backend-owned settings that are not CLI launch settings. There is no separate `host-settings.json` file.

### Module directory

Each installed module has a directory under:

```text
~/.docker-host/modules/<module-id>/
```

The directory contains:

- `metadata.json` - local copy of the source metadata document;
- module-owned storage directories such as `settings/`, `data/`, `cache/`, or other metadata-declared paths.

There are no per-module `module-state.json`, `module-installation.json`, or `module-settings.json` files.

### Host launch configuration

The Host container launch configuration is stored in:

```text
~/.docker-host/config/launch.env
```

It owns Host container lifecycle settings, not module state:

- `HOST_IMAGE`;
- `HOST_CONTAINER_NAME`;
- `HOST_DATA_ROOT_HOST`;
- `HOST_DATA_ROOT_CONTAINER`;
- `HOST_UI_PORT`;
- `HOST_RESTART_POLICY`;
- `HOST_DOCKER_ENDPOINT`;
- `HOST_DOCKER_SOCKET`;
- `HOST_MODULE_NETWORK`.

The standalone `docker-host` CLI reads this file for Host lifecycle commands. `HOST_DOCKER_ENDPOINT` is the CLI-side Docker Engine endpoint, such as `unix:///var/run/docker.sock` on macOS/Linux/WSL or `npipe:////./pipe/docker_engine` on native Windows. On Windows with Docker Desktop, WSL integration must be enabled for the WSL distro where the CLI runs so the Unix socket is available there. `HOST_DOCKER_SOCKET` is the socket path mounted into the Linux Host container and remains `/var/run/docker.sock`.

## Persistent Files

| Path | Owner | Responsibility |
| --- | --- | --- |
| `~/.docker-host/config/launch.env` | CLI | Host container launch settings. |
| `~/.docker-host/modules.json` | Host backend | Installed module registry, persistent module state, and Host-owned settings. |
| `~/.docker-host/modules/<module-id>/metadata.json` | Host backend | Local copy of downloaded module metadata. |
| `~/.docker-host/modules/<module-id>/<storage-key>/` | Host backend | Default bind-mount target for module-owned persistent storage. |

The Host backend creates and validates the Host data root structure at startup. The CLI creates the initial Host data root and `launch.env` during bootstrap.

Private Host state files such as `modules.json` and `auth/state.json` are written with owner-only permissions. When the Host runs as root inside a container against a bind-mounted data root, it preserves those private permissions but synchronizes the file owner to the mounted data root owner after atomic writes so WSL and local editor access follow the data root ownership.

Initial `modules.json` shape:

```json
{
  "schemaVersion": "0.2",
  "hostSettings": {},
  "modules": [
    {
      "id": "com.acme.reports",
      "metadataUrl": "https://modules.example/reports/metadata.json",
      "metadataPath": "modules/com.acme.reports/metadata.json",
      "metadataDigest": "sha256:...",
      "planDigest": "sha256:...",
      "containers": [
        {
          "key": "app",
          "containerName": "mod-com-acme-reports-app",
          "networkAlias": "mod-com-acme-reports-app",
          "image": {
            "repository": "ghcr.io/acme/reports-module",
            "tag": "1.0.0",
            "reference": "ghcr.io/acme/reports-module:1.0.0",
            "pullPolicy": "ifNotPresent"
          }
        }
      ],
      "operationStatus": "installed",
      "settings": {
        "REPORT_RETENTION_DAYS": 30
      },
      "storageMappings": {
        "data": {
          "key": "data",
          "container": "app",
          "containerPath": "/app/data",
          "hostPath": "/Users/example/.docker-host/modules/com.acme.reports/data",
          "required": true,
          "writable": true,
          "readOnly": false
        }
      },
      "externalMounts": [
        {
          "collectionKey": "libraries",
          "key": "main-media",
          "label": "Main media disk",
          "hostPath": "/mnt/media",
          "container": "app",
          "containerPath": "/storage/libraries/main-media",
          "access": "readWrite",
          "readOnly": false
        }
      ],
      "resolvedDependencies": [
        {
          "id": "com.acme.identity",
          "endpoint": "http",
          "targets": [
            {
              "container": "app",
              "type": "env",
              "name": "IDENTITY_BASE_URL"
            }
          ],
          "resolvedBaseUrl": "http://mod-com-acme-identity-app:8080"
        }
      ],
      "installedAt": "2026-05-13T09:00:00Z",
      "updatedAt": "2026-05-13T09:00:00Z",
      "lastError": null
    }
  ],
  "updatedAt": "2026-05-13T09:00:00Z"
}
```

The Host backend creates an empty store automatically:

```json
{
  "schemaVersion": "0.2",
  "hostSettings": {},
  "modules": [],
  "updatedAt": "2026-05-13T09:00:00Z"
}
```

## Lifecycle States

The domain model separates persistent operation status from Docker runtime status.

### Persistent operation status

Persistent operation status is stored in `modules.json` and describes Host-managed module operations:

| Status | Meaning |
| --- | --- |
| `installed` | Module is installed and has no active or failed install/update operation. |
| `installing` | Install operation is in progress. |
| `updating` | Update operation is in progress. |
| `failed` | Last install/update/start preparation operation failed and needs explicit administrator action. |
| `removing` | Remove operation is in progress. This state is temporary and should return to `installed` with `lastError` if removal fails before the registry entry is deleted. |

The domain model does not include a disabled module state.

### Docker runtime status

Docker runtime status is read from Docker daemon for each installed module container. Module summaries also include an aggregate status derived from all module containers.

| Status | Meaning |
| --- | --- |
| `not_created` | Module is installed in registry, but no container exists. |
| `created` | Container exists but has not run. |
| `running` | Container is running. |
| `paused` | Container is paused. |
| `restarting` | Docker is restarting the container. |
| `exited` | Container stopped after running. |
| `dead` | Docker reports the container as dead. |
| `unknown` | Host could not determine container state. |

The MVP does not expose module health or readiness status. Future health support may use Docker healthcheck data or another unified model, but the current module API reports only Docker container states and an aggregate module runtime state.

## Settings

Module settings are declared by metadata and stored as values in `modules.json`.

Rules:

- every setting target is treated as an environment variable scoped to one container;
- setting values are stored as typed JSON values in `modules.json`;
- Docker environment variables are stringified only when Host creates a module container;
- secret values are write-only in API responses;
- API responses may expose whether a secret value is set, but never the raw value;
- settings changes outside install/update review are not supported.

## Storage Mappings

Storage declarations come from `metadata.json`. Computed or configured mappings are stored in `modules.json`.

Rules:

- `storage.directories[].mount.type` supports `bind`;
- default module-owned bind paths are created under `~/.docker-host/modules/<module-id>/`;
- external storage paths can point outside the module directory when configured by an administrator;
- Host validates required mappings before container start;
- Docker daemon mount errors are surfaced to the administrator with operation context.

## Dependency Resolution

Required dependencies are resolved before starting a consumer module.

The Host:

- reads dependency metadata URLs from the consumer metadata;
- ensures required dependency modules are installed and started;
- derives Docker network aliases from dependency module ids and endpoint container keys;
- computes internal base URLs from dependency module endpoints;
- injects base URLs into requested consumer containers through environment variables.

Optional dependencies are not supported. Metadata with `dependencies[].required: false` is rejected as unsupported.

## Install And Update Plans

Install and update plans are reviewed descriptions of Host mutations before apply.

An install plan describes:

- metadata URL and resolved metadata;
- metadata digest for the root metadata source and plan digest for the canonical normalized plan used to detect changes between review and apply;
- Docker images to pull;
- module directory and metadata copy target;
- required storage directories and mappings;
- settings requiring defaults or administrator input;
- external mount collection requirements and any administrator-selected external mount mappings;
- dependency modules that must be installed or started;
- container names, network aliases, endpoints, ports, mounts, environment variables, and restart policy.

`metadataDigest` is the SHA-256 digest of the root metadata JSON bytes downloaded from the submitted metadata URL. `planDigest` is the SHA-256 digest of canonical JSON for the normalized plan, including the dependency tree and computed install decisions, but excluding timestamps and transient runtime/download details. Install apply should compare the reviewed `planDigest`, not rely on durable pending plan state.

The install plan endpoint requires Docker daemon read access for conflict checks, but it must not create or mutate Docker resources. Docker conflict observations, such as an already existing container name or unavailable Host-managed network, are reported alongside the plan/error response and are not included in `planDigest`. Install apply must repeat these Docker checks before any mutation.

An update plan describes:

- refreshed metadata source;
- refreshed metadata digest and update plan digest;
- image changes;
- settings schema changes;
- storage mapping changes;
- dependency changes;
- container replacement steps.

Docker Host does not rely on durable pending plan state. Install and update apply operations recompute the reviewed plan from source metadata and submitted administrator decisions, then compare the reviewed plan digest before mutating files, module state, images, or containers.

Install and update use optimistic fail-fast behavior. If an install or update fails after changes have started, Host records failure state and preserves created files, directories, images, and containers for diagnosis.

## Naming Contracts

Module ids are stable and recommended to use reverse-DNS format, for example:

```text
com.modulis.storage
```

Docker names derived by Host must be deterministic:

- module container name: `mod-<normalized-module-id>-<container-key>`;
- network alias: `mod-<normalized-module-id>-<container-key>`;
- normalized id: lowercase, with characters outside `a-z` and `0-9` replaced by `-`.

Example:

```text
com.modulis.storage + app -> mod-com-modulis-storage-app
```

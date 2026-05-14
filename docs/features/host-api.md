# Docker Host API

Этот документ описывает начальный API surface для Docker Host. На первом этапе это не executable OpenAPI specification, а human-readable endpoint catalog для согласования backend, Web UI и будущих CLI module commands.

Host API реализуется внутри full-stack Next.js Host application. Web UI вызывает этот API напрямую. `docker-host` CLI использует этот же API только для module commands; lifecycle самого Host container CLI выполняет через Docker daemon.

## Principles

- Host backend API is the owner of module management logic.
- Runtime status is read from Docker daemon, not from persistent JSON files.
- Persistent installed module registry is stored in root-level `modules.json`.
- MVP API is local/private-network only and does not include authentication.
- API responses must not expose raw secret setting values.
- Executable OpenAPI generation can be added later after the initial endpoint model stabilizes.

## Initial API slice

The first API slice is intentionally small:

- return Host runtime, Docker daemon, module network, and installed module store status;
- list installed modules;
- return module runtime statuses;
- start a module;
- stop a module;
- restart a module.

Module install, update, remove, settings editing, storage configuration, install plans, update plans, logs, and external exposure are later API slices.

The shared domain vocabulary for this API is defined in [Docker Host domain model](domain-model.md).

## Response Types

### `ModuleSummary`

Returned by list and lifecycle endpoints.

```json
{
  "id": "com.acme.reports",
  "name": "Reports",
  "description": "Generates operational reports.",
  "version": "1.0.0",
  "metadataUrl": "https://modules.example/reports/metadata.json",
  "image": {
    "repository": "ghcr.io/acme/reports-module",
    "tag": "1.0.0",
    "reference": "ghcr.io/acme/reports-module:1.0.0"
  },
  "operationStatus": "installed",
  "runtimeStatus": {
    "state": "running",
    "containerId": "4b8d...",
    "containerName": "mod-com-acme-reports",
    "startedAt": "2026-05-13T09:30:00Z",
    "finishedAt": null
  },
  "installedAt": "2026-05-13T09:00:00Z",
  "updatedAt": "2026-05-13T09:30:00Z",
  "lastError": null
}
```

`operationStatus` is persistent Host bookkeeping from `modules.json`. `runtimeStatus` is read from Docker daemon for every request and must not be treated as stored state.

The first API slice does not expose module health or readiness. `runtimeStatus` reports only Docker container state. Health checks, including any future Docker healthcheck-based status, are deferred to a later feature.

Allowed `operationStatus` values:

- `installed`;
- `installing`;
- `updating`;
- `failed`.

Allowed `runtimeStatus.state` values:

- `not_created`;
- `created`;
- `running`;
- `paused`;
- `restarting`;
- `exited`;
- `dead`;
- `unknown`.

### `ModuleDetail`

Returned by `GET /api/modules/{moduleId}`.

It includes all `ModuleSummary` fields plus:

```json
{
  "settings": [
    {
      "key": "EXTERNAL_API_TOKEN",
      "type": "secret",
      "required": false,
      "target": { "type": "env", "name": "EXTERNAL_API_TOKEN" },
      "valueSet": true
    }
  ],
  "storage": {
    "directories": [
      {
        "key": "data",
        "containerPath": "/app/data",
        "hostPath": "~/.docker-host/modules/com.acme.reports/data",
        "required": true,
        "writable": true
      }
    ]
  },
  "dependencies": [
    {
      "id": "com.acme.identity",
      "required": true,
      "metadataUrl": "https://modules.example/identity/metadata.json",
      "resolvedBaseUrl": "http://mod-com-acme-identity:8080",
      "baseUrlEnv": "IDENTITY_BASE_URL"
    }
  ]
}
```

Secret setting values are never returned. For non-secret settings, later settings endpoints may return values when needed by the UI.

### `ModuleActionResult`

Returned by lifecycle actions.

```json
{
  "success": true,
  "module": {
    "id": "com.acme.reports",
    "runtimeStatus": {
      "state": "running",
      "containerName": "mod-com-acme-reports"
    }
  },
  "error": null
}
```

On failure:

```json
{
  "success": false,
  "module": null,
  "error": {
    "operation": "module.start",
    "httpStatus": 500,
    "dockerStatusCode": 404,
    "dockerMessage": "No such container: mod-com-acme-reports",
    "message": "Docker could not start the module container.",
    "nextStep": "Recreate the module container or reinstall the module when install flows are available."
  }
}
```

Docker operation failures should preserve operation name, Docker status code when available, Docker message, and an administrator-oriented next step.

### `HostStatus`

Returned by `GET /api/host/status`.

```json
{
  "host": {
    "ready": true,
    "dataRoot": {
      "hostPath": "/Users/example/.docker-host",
      "containerPath": "/data",
      "modulesPath": "/data/modules",
      "modulesStorePath": "/data/modules.json",
      "ready": true,
      "writable": true,
      "error": null
    },
    "store": {
      "path": "/data/modules.json",
      "exists": true,
      "readable": true,
      "writable": true,
      "moduleCount": 0,
      "error": null
    },
    "moduleNetwork": {
      "name": "docker-host-modules",
      "ready": true,
      "id": "c4c1...",
      "created": false,
      "error": null
    }
  },
  "docker": {
    "connected": true,
    "endpoint": "unix socket /var/run/docker.sock",
    "serverVersion": "29.0.2",
    "osType": "linux",
    "error": null
  }
}
```

This endpoint creates the Host data root, `modules/` directory, `modules.json`, and shared module network if they are missing. It returns HTTP `200` when the Host runtime and Docker daemon are ready, and HTTP `503` when a dependency is unavailable.

## Endpoints

The endpoints in this section are required for the first API implementation slice.

### `GET /api/modules`

Returns installed modules known to Docker Host.

The backend reads `modules.json` for installed module registry entries and persistent module state, reads each module's local `metadata.json` for display metadata, and asks Docker daemon for current runtime/container state. Persistent module state includes the source metadata URL, install/update status, failure state, last error details, computed storage mappings, and resolved dependency URLs. Docker runtime state is not stored in `modules.json`.

Response body:

```json
{
  "modules": []
}
```

Response should include, per module:

- module id;
- name;
- description, if available;
- version;
- source metadata URL;
- Docker image reference;
- lifecycle/install bookkeeping status from `modules.json`, if any;
- Docker runtime status;
- timestamps such as installed and last updated, if available;
- last install/update error summary, if available.

### `GET /api/modules/{moduleId}`

Returns detailed information for one installed module.

Response should include:

- fields from `GET /api/modules`;
- local metadata details needed by the UI;
- settings schema from `metadata.json`;
- indication of which secret settings are set, without raw secret values;
- storage declarations from metadata;
- computed or configured storage mappings stored in `modules.json`, if available;
- dependency declarations and resolved dependency URLs, if available;
- container details needed for status and logs links.

### `POST /api/modules/{moduleId}/start`

Starts the Docker container for an installed module.

The backend resolves the module from `modules.json`, maps it to the corresponding Docker container, and asks Docker daemon to start it.

Response should include:

- success/failure;
- updated runtime status from Docker daemon;
- clear Docker error details when start fails.

### `POST /api/modules/{moduleId}/stop`

Stops the Docker container for an installed module.

Response should include:

- success/failure;
- updated runtime status from Docker daemon;
- clear Docker error details when stop fails.

### `POST /api/modules/{moduleId}/restart`

Restarts the Docker container for an installed module.

Response should include:

- success/failure;
- updated runtime status from Docker daemon;
- clear Docker error details when restart fails.

## Near-Term Diagnostics Endpoints

These endpoints are not part of the first Phase 0 API slice, but they are expected soon after the initial module list/lifecycle implementation.

### `GET /api/modules/{moduleId}/logs`

Returns recent logs for one module container.

Recommended query parameters:

- `tail` - number of recent lines;
- `since` - optional timestamp or duration boundary;
- `timestamps` - whether Docker log timestamps should be included.

## Later API slices

### Module installation

Future endpoints should support:

- `POST /api/modules/install/plan` - load metadata from URL, validate and normalize metadata, resolve required dependencies, and return a read-only install plan with metadata/plan digest, conflicts, settings prompts, storage mappings, external mount collection requirements, Docker names, network aliases, and runtime ports;
- `POST /api/modules/install` - accept a reviewed install request with metadata URL, reviewed digest, settings values, and selected external mounts, recompute the plan, reject if the digest changed, then apply the install;
- expose install failure diagnostics with operation name, Docker status/message when available, administrator next step, and failed operation status.

The MVP should not persist pending install plans as durable state. Apply endpoints should recompute the plan and compare the reviewed digest before changing files, module state, images, or containers.

### Module update

Future endpoints should support:

- `POST /api/modules/{moduleId}/update/plan` - refresh the stored metadata URL, validate refreshed metadata, require the same module id, compare against local `metadata.json`, and return a reviewed update plan;
- `POST /api/modules/{moduleId}/update` - recompute the update plan, compare the reviewed digest, then apply image/container/settings/storage/dependency changes after confirmation;
- expose update failure diagnostics and explicit retry.

### Module removal

Future endpoints should support:

- remove or cleanup plan for installed modules and failed installs;
- container removal;
- optional module-owned data cleanup decisions;
- clear reporting of what data is preserved or deleted;
- never delete external host paths, only remove their mappings from Host state.

### Settings and storage

Future endpoints should support:

- editing module setting values stored in `modules.json`;
- write-only handling for secret settings;
- configuring external storage mounts;
- validating mount behavior through Docker daemon where needed.

## Documentation status

This document is the Phase 0/1 API planning artifact. It should be updated when implementation decisions change. Once the API stabilizes, generated OpenAPI can be introduced under `packages/contracts`.

## Open Questions

No Phase 0 API questions remain open. Later implementation slices should reopen API details for install plans, update plans, settings writes, storage configuration, logs streaming, and executable OpenAPI generation.

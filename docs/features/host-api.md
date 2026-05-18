# Docker Host API

Этот документ описывает API surface для Docker Host. В MVP это не executable OpenAPI specification, а human-readable endpoint catalog для согласования backend, Web UI и будущих CLI module commands.

Host API реализуется внутри full-stack Next.js Host application. Web UI вызывает этот API напрямую. `docker-host` CLI использует этот же API только для module commands; lifecycle самого Host container CLI выполняет через Docker daemon.

## Principles

- Host backend API is the owner of module management logic.
- Runtime status is read from Docker daemon, not from persistent JSON files.
- Persistent installed module registry is stored in root-level `modules.json`.
- The current pre-auth MVP API is local/private-network only. The Auth Gateway feature supersedes this by requiring Host-owned authentication and `host.admin` authorization for Host API functionality.
- API responses must not expose raw secret setting values.
- The API contract remains this Markdown endpoint catalog for the MVP. There is no separate contracts package, generated OpenAPI artifact, or generated API client.

## Implemented API Surface

The current MVP API surface includes:

- return Host runtime, Docker daemon, module network, and installed module store status;
- list installed modules;
- return installed module details and Docker runtime statuses;
- start, stop, and restart installed modules;
- create and apply reviewed module install plans;
- retry failed installs, clean up failed install artifacts, and remove installed modules through reviewed recovery plans;
- create and apply reviewed module update plans;
- retry failed updates separately from failed installs;
- serve scoped module directory responses to modules through an internal service-token API.

Settings editing outside install/update review, storage reconfiguration outside install/update review, module logs, module health checks, and richer external module exposure controls are later API slices.

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

The MVP API does not expose module health or readiness. `runtimeStatus` reports only Docker container state. Health checks, including any future Docker healthcheck-based status, are deferred to a later feature.

Allowed `operationStatus` values:

- `installed`;
- `installing`;
- `updating`;
- `failed`;
- `removing`.

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
    "nextStep": "Retry the failed operation, review update again, or remove and reinstall the module."
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

The endpoints in this section are implemented for the MVP Host API.

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

## Deferred Diagnostics Endpoints

These endpoints are not implemented in the module API yet, but remain the expected diagnostics surface.

### `GET /api/modules/{moduleId}/logs`

Returns recent logs for one module container.

Recommended query parameters:

- `tail` - number of recent lines;
- `since` - optional timestamp or duration boundary;
- `timestamps` - whether Docker log timestamps should be included.

## Module installation

The module installation API is implemented for the MVP install flow:

- `POST /api/modules/install/plan` - load metadata from URL, validate and normalize metadata, resolve required dependencies, and return a read-only install plan with `metadataDigest`, `planDigest`, conflicts, settings prompts, storage mappings, external mount collection requirements, Docker names, network aliases, and runtime ports;
- `POST /api/modules/install` - accept a reviewed install request with metadata URL, reviewed `planDigest`, settings values, and selected external mounts, recompute the plan, reject if the digest changed, then apply the install.

The install apply endpoint returns HTTP `201` on success:

```json
{
  "module": {},
  "installedModuleIds": ["com.acme.identity", "com.acme.reports"],
  "reusedModuleIds": [],
  "error": null
}
```

`module` is the installed root module summary after Docker runtime status refresh. `installedModuleIds` contains modules that the apply endpoint created or completed during this request. `reusedModuleIds` contains compatible dependencies that were already installed and were started if needed.

Apply request validation failures use HTTP `422` and the shared error envelope. Current-state conflicts, including reviewed plan digest mismatch, incompatible or missing-container reusable dependencies, and external mount conflicts, use HTTP `409`. Docker/runtime unavailability before mutation uses HTTP `503`. Failures after mutation has started use HTTP `500`, mark the affected module `failed`, and preserve created files, images, and containers for explicit recovery.

Install apply persists each newly installed module in root-level `modules.json` with:

- source `metadataUrl`, local `metadataPath`, root or dependency `metadataDigest`, and reviewed `planDigest`;
- Docker image reference, pull policy, container name, and operation status;
- typed setting values, including write-only secret values;
- computed module-owned `storageMappings`;
- selected `externalMounts`;
- resolved dependency base URLs;
- timestamps and the last operation error.

The reviewed install request payload shape is:

```json
{
  "metadataUrl": "https://modules.example.com/reports.json",
  "planDigest": "sha256:...",
  "settings": [
    {
      "moduleId": "com.acme.reports",
      "key": "REPORT_RETENTION_DAYS",
      "value": 30,
      "secret": false
    },
    {
      "moduleId": "com.acme.reports",
      "key": "EXTERNAL_API_TOKEN",
      "value": "submitted write-only secret",
      "secret": true
    }
  ],
  "externalMounts": [
    {
      "moduleId": "com.acme.storage",
      "collectionKey": "libraries",
      "key": "main-media",
      "label": "Main media disk",
      "hostPath": "/mnt/media",
      "containerPath": "/storage/libraries/main-media",
      "access": "readWrite"
    }
  ]
}
```

Secret setting values are accepted only as write-only submit values. API responses, plan summaries, logs, errors, diagnostics, and UI previews must never echo raw secret values; redacted previews may show that a secret value is present.

The install planner owns administrator-input filtering. Settings and external mount collections should be returned only for the root module and dependency modules that the plan will install. Already installed compatible dependencies with `installAction: "reuse"` should not ask for setting values or external mount selections during a consumer install.

The install plan request body is intentionally minimal:

```json
{
  "metadataUrl": "https://modules.example.com/reports.json"
}
```

The MVP install flow does not include request flags such as refresh behavior, diagnostics toggles, or conflict-check bypasses.

Successful `200` responses should use one top-level `plan` object:

```json
{
  "plan": {
    "metadataUrl": "https://modules.example.com/reports.json",
    "metadataDigest": "sha256:...",
    "planDigest": "sha256:...",
    "module": {
      "id": "com.acme.reports",
      "name": "Reports",
      "description": "Generates operational reports.",
      "version": "1.0.0"
    },
    "normalizedMetadata": {},
    "dependencies": [],
    "installOrder": ["com.acme.identity", "com.acme.reports"],
    "images": [],
    "settings": [],
    "storage": {
      "directories": [],
      "mountCollections": []
    },
    "runtime": {
      "ports": []
    },
    "docker": {
      "containerName": "mod-com-acme-reports",
      "networkAliases": ["mod-com-acme-reports"]
    },
    "conflicts": []
  }
}
```

The `dependencies` array represents the resolved dependency tree. `installOrder` is the topological module id order used for later apply. `normalizedMetadata` contains the normalized root metadata after defaults are applied. `settings` contains prompts, defaults, targets, and secret redaction markers, but never raw secret values.

The implementation returns dependency nodes with their own normalized metadata, Docker name, network alias, module paths, install action (`install` or `reuse`), and dependency connection mappings. The top-level `paths` object identifies the root module directory and local `metadata.json` copy paths in both host and Host-container path spaces.

Install plan Docker checks:

- `POST /api/modules/install/plan` requires Docker daemon read access.
- The endpoint must perform read-only Docker conflict checks for generated container names, missing containers for reusable dependencies, and, when the Host-managed network already exists, network aliases before returning a successful plan.
- The endpoint must not create or mutate files, module directories, images, containers, or Docker networks.
- A missing Host-managed network is not a plan conflict. The install apply endpoint creates the network at mutation time.
- If Docker daemon is unavailable, the endpoint should return HTTP `503` and should not return a successful install plan.
- Docker conflict observations are not part of `planDigest`; the apply endpoint must repeat Docker conflict checks before any mutation.

Digest semantics:

- `metadataDigest` is the SHA-256 digest of the root metadata JSON bytes downloaded from the submitted `metadataUrl`. It is used for source transparency, diagnostics, and explaining when the same URL now returns different metadata.
- `planDigest` is the SHA-256 digest of a canonical JSON representation of the normalized install plan. It covers normalized root metadata, dependency metadata tree, dependency install order, image references, computed paths, setting prompts, storage requirements, Docker container names, network aliases, and runtime ports. It must exclude timestamps, transient download details, Docker runtime status, read-only Docker conflict observations, and other fields that can change without changing the reviewed plan.
- `planDigest` is the primary review guard for install apply. The apply endpoint must recompute the plan from the submitted `metadataUrl` and administrator decisions, then reject the request if the recomputed `planDigest` differs from the reviewed `planDigest`.

The MVP should not persist pending install plans as durable state. Apply endpoints should recompute the plan and compare the reviewed `planDigest` before changing files, module state, images, or containers.

Install plan validation and conflict status boundaries:

- HTTP `422` is used when metadata is invalid by itself, dependency graph validation fails, or the metadata requests unsupported fields, setting types, protocols, storage mount types, or unsafe paths.
- HTTP `409` is used when metadata is valid but conflicts with current Host or Docker state, such as an already installed module id, generated container name collision, network alias collision, environment variable target collision, or storage mapping collision.
- `validationErrors[].path` should use a JSONPath-like string pointing to the failing metadata field, for example `$.image.repository` or `$.dependencies[0].connection.endpoint`.
- `validationErrors[].node` should identify the dependency graph node when the error belongs to dependency metadata rather than the root metadata. For the root metadata, `node` can be omitted or set to the root module id.
- `409` responses should include the partial install plan together with `conflicts[]` so the Web UI can show the reviewed plan and highlight conflict locations.
- The planner should aggregate as many validation errors and conflicts as possible in one response.
- The planner may fail fast only when it cannot continue meaningfully, such as when the root metadata URL cannot be fetched, root JSON cannot be parsed, or required dependency metadata cannot be fetched or parsed.
- HTTP `422` and `409` should use a shared error envelope with top-level `error.code`, `error.message`, `error.validationErrors[]`, and `error.conflicts[]`. For `409`, the partial install plan should be returned as a top-level `plan` sibling, not nested inside `error`.
- `conflicts[]` items should use `code`, `message`, `resourceType`, `resourceId`, and `path` as required fields. `node`, `existingValue`, and `proposedValue` are optional fields for UI highlighting and comparison.

Example `conflicts[]` item:

```json
{
  "code": "container_name_conflict",
  "message": "Container name mod-com-acme-reports already exists.",
  "resourceType": "docker_container",
  "resourceId": "mod-com-acme-reports",
  "path": "$.id",
  "node": "com.acme.reports",
  "existingValue": "mod-com-acme-reports",
  "proposedValue": "mod-com-acme-reports"
}
```

Example `422` response shape:

```json
{
  "error": {
    "code": "install_plan_validation_failed",
    "message": "Module metadata is invalid.",
    "validationErrors": [],
    "conflicts": []
  }
}
```

Example `409` response shape:

```json
{
  "plan": {},
  "error": {
    "code": "install_plan_conflict",
    "message": "The install plan conflicts with current Host or Docker state.",
    "validationErrors": [],
    "conflicts": []
  }
}
```

### Module update

The update contract is defined in [Module update flow](module-update.md). The API uses separate update endpoints:

- `POST /api/modules/{moduleId}/update/plan` - refresh the stored metadata URL, validate refreshed metadata, require the same module id, compare against local `metadata.json`, and return a reviewed update plan with refreshed metadata digest, update plan digest, prompts, warnings, and conflicts;
- `POST /api/modules/{moduleId}/update` - recompute the update plan from refreshed metadata and submitted administrator decisions, compare the reviewed update plan digest, then apply image, container, settings, storage, and dependency changes after confirmation;
- `POST /api/modules/{moduleId}/update/retry` - retry a failed update attempt using update semantics and the stored failed update context.

The MVP update API does not accept a replacement metadata URL. It updates from the metadata URL stored in the installed module record.

`POST /api/modules/{moduleId}/update/plan` has no request body. It returns HTTP `200` with a top-level `plan` object when the refreshed metadata can be reviewed:

```json
{
  "plan": {
    "moduleId": "com.acme.reports",
    "metadataUrl": "https://modules.example.com/reports.json",
    "currentMetadataDigest": "sha256:...",
    "refreshedMetadataDigest": "sha256:...",
    "updatePlanDigest": "sha256:...",
    "module": {
      "id": "com.acme.reports",
      "currentName": "Reports",
      "proposedName": "Reports",
      "currentVersion": "1.0.0",
      "proposedVersion": "1.1.0"
    },
    "changes": [],
    "warnings": [],
    "conflicts": []
  }
}
```

The full `ModuleUpdatePlan` includes current and proposed module identity, normalized refreshed metadata, dependency install/reuse decisions, install order, image references, setting prompts, preserved settings, storage mappings, preserved and removed external mount mappings, runtime port/resource details, deterministic Docker container configuration, replacement requirements, warnings, and conflicts.

The reviewed update request payload shape is:

```json
{
  "updatePlanDigest": "sha256:...",
  "confirmed": true,
  "settings": [
    {
      "moduleId": "com.acme.reports",
      "key": "REPORT_RETENTION_DAYS",
      "value": 60,
      "secret": false
    }
  ],
  "externalMounts": [
    {
      "moduleId": "com.acme.reports",
      "collectionKey": "exports",
      "key": "main",
      "label": "Main exports",
      "hostPath": "/srv/reports",
      "containerPath": "/exports/main",
      "access": "readWrite"
    }
  ]
}
```

Successful apply responses use HTTP `200`:

```json
{
  "module": {},
  "updatedModuleId": "com.acme.reports",
  "installedDependencyIds": [],
  "reusedDependencyIds": ["com.acme.identity"],
  "error": null
}
```

Update apply preserves compatible setting values, preserves compatible module-owned storage paths and external mount selections, removes deleted settings from runtime state after success, installs missing new required dependencies, and reuses/starts compatible installed dependencies. It does not recursively update already installed dependencies.

When runtime configuration changes, update apply stops/removes/recreates the module container with the deterministic container name. Metadata-only updates may skip container replacement. If refreshed `pullPolicy` is `always`, the Host pulls and recreates even when the image reference is unchanged.

Failed update apply uses the shared install-plan error envelope for validation/conflict failures before mutation. Partial failures after mutation has started mark the module `failed`, set `lastOperation` to `update`, preserve files, storage, images, and containers for diagnosis, and store enough update attempt context for `POST /api/modules/{moduleId}/update/retry`.

### Module recovery and removal

The recovery API adds explicit actions for failed installs, failed updates, failed install cleanup, and installed module removal.

- `POST /api/modules/{moduleId}/retry` retries a failed install from the local `metadata.json` and stored install record. Retry removes and recreates the failed module container, preserves module-owned data directories, starts stored dependencies when needed, and records fresh diagnostics if it fails again.
- `POST /api/modules/{moduleId}/update/retry` retries a failed update and is documented in [Module update](#module-update).
- `POST /api/modules/{moduleId}/cleanup/plan` returns a backend-generated cleanup preview for a failed module.
- `POST /api/modules/{moduleId}/cleanup` applies a confirmed cleanup request. Request body: `{ "confirmed": true, "deleteModuleData": false }`.
- `POST /api/modules/{moduleId}/remove/plan` returns a backend-generated removal preview for an installed module.
- `POST /api/modules/{moduleId}/remove` applies a confirmed removal request. Request body: `{ "confirmed": true, "deleteModuleData": false }`.

Cleanup and remove plan requests accept `{ "deleteModuleData": true | false }` so the Web UI can refresh the preview before confirmation. Plans return `canApply`, container state, image reference, local `metadata.json`, module directory, module-owned storage directories, external mount mappings, dependents, warnings, and conflicts.

The default is always to preserve module-owned data. Setting `deleteModuleData=true` deletes only module-owned directories under the Host data root. Docker images and external host paths are never deleted by the MVP recovery flows; external mount mappings are only removed from Host state.

Installed module removal is blocked when other installed modules depend on the target module. Remove sets `operationStatus=removing` only while the operation is in progress. If removal fails before the registry entry is deleted, the module returns to `installed` with `lastError`.

Lifecycle hardening marks modules `failed` when a lifecycle action discovers a missing Docker container or a missing required storage mapping. Transient Docker daemon, network, stop, or restart errors remain action errors and do not change persistent operation status.

### Internal module directory

The internal module directory API lets a module list Host users explicitly assigned to that module so the module can manage its own roles and permissions. It is not a browser session API and does not grant modules access to the full Host user directory.

- `GET /api/internal/modules/{moduleId}/directory/users` returns assigned, enabled Host users for the module.
- Authorization uses `Authorization: Bearer {module service token}`.
- The service token is generated by Host, stored only as a server-side hash, and injected into newly created module containers as `DOCKER_HOST_MODULE_SERVICE_TOKEN`.
- The module id associated with the token must match `{moduleId}` in the route.
- Browser session cookies and CLI tokens are not accepted for this endpoint.
- Email is omitted by default and included only when a module directory policy opts in.

Host administrators can manage the module directory policy and service credentials through admin-only endpoints:

- `POST /api/modules/{moduleId}/directory/service-tokens` creates a service token and returns the raw token once.
- `DELETE /api/modules/{moduleId}/directory/service-tokens/{tokenId}` revokes a service token for that module.
- `PUT /api/modules/{moduleId}/directory/policy` updates directory policy fields such as `includeEmail`.

Example response:

```json
{
  "schemaVersion": "0.1",
  "moduleId": "com.acme.reports",
  "users": [
    {
      "id": "user_123",
      "displayName": "Work User",
      "hostRole": "host.user"
    }
  ],
  "pagination": {
    "limit": 1,
    "offset": 0,
    "total": 1
  },
  "updatedAt": "2026-05-18T12:00:00Z"
}
```

### Settings and storage

Future endpoints should support:

- editing module setting values stored in `modules.json`;
- write-only handling for secret settings;
- configuring external storage mounts;
- validating mount behavior through Docker daemon where needed.

## Documentation status

This document is the Host API contract for the MVP. It should be updated when implementation decisions change.

## Open Questions

No MVP Host API questions remain open for the implemented install, recovery, remove, update, and internal module directory flows.

Later implementation slices may reopen API details for settings writes, storage reconfiguration, module diagnostics, logs streaming, health checks, and external exposure.

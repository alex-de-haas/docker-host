# Docker Host API

Этот документ описывает API surface для Docker Host. Это human-readable endpoint catalog для согласования backend, Web UI и CLI module commands.

Host API реализуется внутри full-stack Next.js Host application. Web UI вызывает этот API напрямую. `docker-host` CLI использует этот же API только для module commands; lifecycle самого Host container CLI выполняет через Docker daemon.

## Principles

- Host backend API is the owner of module management logic.
- Runtime status is read from Docker daemon, not from persistent JSON files.
- Persistent installed module registry is stored in root-level `modules.json`.
- Host API functionality requires Host-owned authentication and `host.admin` authorization unless an endpoint explicitly documents a narrower permission.
- API responses must not expose raw secret setting values.
- The API contract remains this Markdown endpoint catalog. There is no separate contracts package, generated OpenAPI artifact, or generated API client.

## Implemented API Surface

The current API surface includes:

- return Host runtime, Docker daemon, module network, and installed module store status;
- list installed modules;
- return installed module details and Docker runtime statuses;
- start, stop, and restart installed modules;
- create and apply reviewed module install plans;
- retry failed installs, clean up failed install artifacts, and remove installed modules through reviewed recovery plans;
- create and apply reviewed module update plans;
- retry failed updates separately from failed installs;
- support local and generic OIDC browser authentication flows;
- serve scoped module directory responses to modules through an internal service-token API;
- return authenticated, principal-filtered shell App registry data through `/api/apps`.

Settings editing outside install/update review, storage reconfiguration outside install/update review, module logs, and module health checks are not supported API functionality.

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
  "containers": [
    {
      "key": "app",
      "image": {
        "repository": "ghcr.io/acme/reports-module",
        "tag": "1.0.0",
        "reference": "ghcr.io/acme/reports-module:1.0.0"
      },
      "networkAlias": "mod-com-acme-reports-app",
      "endpoints": [
        {
          "key": "http",
          "container": "app",
          "port": "http",
          "public": true
        }
      ],
      "runtimeStatus": {
        "state": "running",
        "containerId": "4b8d...",
        "containerName": "mod-com-acme-reports-app",
        "startedAt": "2026-05-13T09:30:00Z",
        "finishedAt": null
      }
    }
  ],
  "operationStatus": "installed",
  "runtimeStatus": {
    "state": "running",
    "runningContainers": 1,
    "totalContainers": 1
  },
  "installedAt": "2026-05-13T09:00:00Z",
  "updatedAt": "2026-05-13T09:30:00Z",
  "lastError": null
}
```

`operationStatus` is persistent Host bookkeeping from `modules.json`. `containers[].runtimeStatus` is read from Docker daemon for every request and must not be treated as stored state. Top-level `runtimeStatus` is an aggregate derived from the module containers.

The API does not expose module health or readiness. `runtimeStatus` reports only Docker container state.

Allowed `operationStatus` values:

- `installed`;
- `installing`;
- `updating`;
- `failed`;
- `removing`.

Allowed `containers[].runtimeStatus.state` values:

- `not_created`;
- `created`;
- `running`;
- `paused`;
- `restarting`;
- `exited`;
- `dead`;
- `unknown`.

Allowed aggregate `runtimeStatus.state` values:

- `not_created`;
- `running`;
- `degraded`;
- `exited`;
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
      "targets": [
        { "container": "app", "type": "env", "name": "EXTERNAL_API_TOKEN" }
      ],
      "valueSet": true
    }
  ],
  "storage": {
    "directories": [
      {
        "key": "data",
        "container": "app",
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
      "resolvedBaseUrl": "http://mod-com-acme-identity-app:8080",
      "targets": [
        { "container": "app", "type": "env", "name": "IDENTITY_BASE_URL" }
      ]
    }
  ]
}
```

Secret setting values are never returned. Non-secret setting values are exposed only through reviewed install/update flows.

### `HostAppEntry`

Returned by `GET /api/apps`.

```json
{
  "id": "com.acme.reports",
  "source": "installed",
  "moduleId": "com.acme.reports",
  "displayName": "Reports",
  "description": "Generates operational reports.",
  "icon": "boxes",
  "version": "1.0.0",
  "status": "available",
  "statusReason": "available",
  "accessMode": "allAuthenticated",
  "operationStatus": "installed",
  "runtimeState": "running",
  "entryPath": "/apps/com.acme.reports",
  "embeddedUrl": "/api/apps/com.acme.reports/embed?path=%2F",
  "navigation": [
    {
      "label": "People",
      "path": "/people",
      "entryPath": "/apps/com.acme.reports?path=%2Fpeople",
      "embeddedUrl": "/api/apps/com.acme.reports/embed?path=%2Fpeople"
    }
  ]
}
```

Developer app entries use the same shape with `source: "developer"` and `developerTargetId`:

```json
{
  "id": "dev:mdev_reports",
  "source": "developer",
  "moduleId": "com.acme.reports",
  "developerTargetId": "mdev_reports",
  "displayName": "Reports Dev",
  "version": "1.0.0",
  "status": "available",
  "statusReason": "available",
  "accessMode": "allAuthenticated",
  "entryPath": "/apps/dev/mdev_reports",
  "embeddedUrl": "/api/apps/dev/mdev_reports/embed?path=%2F",
  "navigation": []
}
```

`GET /api/apps` intentionally omits raw Docker/container internals. It does not return container ids, container names, Docker network aliases, raw container URLs, public module UI domains, or service/API gateway exposure hostnames.

Allowed `accessMode` values:

- `allAuthenticated`;
- `assignedUsersOnly`.

No `public` or anonymous shell App mode exists. Separate service/API gateway exposures are not shell Apps.

### `ModuleActionResult`

Returned by lifecycle actions.

```json
{
  "success": true,
  "module": {
    "id": "com.acme.reports",
    "runtimeStatus": {
      "state": "running",
      "runningContainers": 1,
      "totalContainers": 1
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

The endpoints in this section are implemented by the Host API.

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
- Docker containers and image references;
- lifecycle/install bookkeeping status from `modules.json`, if any;
- Docker runtime status;
- timestamps such as installed and last updated, if available;
- last install/update error summary, if available.

### `GET /api/apps`

Returns app navigation data for the current authenticated Host principal.

This endpoint requires authentication but does not require `host.admin`. Unauthenticated callers receive HTTP `401` and no app discovery data. `host.admin` can see all shell-routable app entries, including unavailable entries with safe diagnostic status. `host.user` can see only available apps that are visible to all authenticated users or explicitly assigned to that user.

The backend reads installed module records from `modules.json`, reads each module's local `metadata.json`, requires explicit `ui` metadata, applies Host-owned module assignments, and reads runtime state for availability. It does not infer shell Apps from gateway exposure records or from `runtime.ports[].public` alone.

When `HOST_MODULE_DEV_MODE=enabled`, the backend also reads enabled developer targets with stored shell app snapshots from `/data/dev/module-targets.json`. These entries are marked as `source: "developer"` and use developer app routes. Disabled developer mode and disabled targets are omitted from `/api/apps`.

Response body:

```json
{
  "apps": []
}
```

Response entries include:

- app id;
- source (`installed` or `developer`);
- module id;
- developer target id, for developer entries;
- display name;
- description, if available;
- icon key, if declared by module `ui` metadata;
- version;
- app status and safe status reason;
- shell App access mode;
- module operation status;
- runtime state without container details;
- same-origin Host entry path;
- reserved embedded URL;
- nested navigation items.

### `GET /api/apps/{moduleId}/embed`

Reserved iframe transport for shell App UI content.

This endpoint requires Host authentication through the same `apps.read` authorization path as `GET /api/apps`. The Host validates that the selected module app is visible to the current principal and available before proxying. The selected module UI path is passed in the `path` query parameter and must be a same-origin absolute path beginning with `/`.

Example:

```text
/api/apps/com.acme.reports/embed?path=%2Fpeople
```

The endpoint proxies to the module runtime port declared by `ui.entrypoint`, injects module identity where applicable, strips Host-owned request headers, scopes module cookies to the reserved embed route, and rewrites root-relative HTML/CSS links through the reserved embed URL. Rewriting is limited to HTML tag attributes, style attributes, and style element CSS so inline script contents remain unchanged. It is not a public module UI hostname and `/apps/{moduleId}` is not a direct proxy path.

### `GET /api/apps/dev/{targetId}/embed`

Reserved iframe transport for developer shell App UI content.

This endpoint requires Host authentication through the same `apps.read` authorization path as `GET /api/apps`. It is available only when module developer mode is enabled and the selected developer target is enabled, visible to the current principal, and has a stored shell app snapshot.

Example:

```text
/api/apps/dev/mdev_reports/embed?path=%2Fpeople
```

The endpoint proxies to the developer target's local `targetBaseUrl`, preserves the target path prefix, injects module identity according to the developer target identity mode, strips Host-owned request headers, scopes module cookies to the developer embed route, and rewrites root-relative HTML/CSS links through the reserved developer embed URL using the same tag/style-only rewrite rules as installed module embeds. It does not create or read production gateway exposure records.

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

Starts the Docker containers for an installed module.

The backend resolves the module from `modules.json`, maps it to the corresponding Docker containers, and asks Docker daemon to start them.

Response should include:

- success/failure;
- updated runtime status from Docker daemon;
- clear Docker error details when start fails.

### `POST /api/modules/{moduleId}/stop`

Stops the Docker containers for an installed module.

Response should include:

- success/failure;
- updated runtime status from Docker daemon;
- clear Docker error details when stop fails.

### `POST /api/modules/{moduleId}/restart`

Restarts the Docker containers for an installed module.

Response should include:

- success/failure;
- updated runtime status from Docker daemon;
- clear Docker error details when restart fails.

## Module installation

The module installation API:

- `POST /api/modules/install/plan` - load metadata from URL, validate and normalize metadata, resolve required dependencies, and return a read-only install plan with `metadataDigest`, `planDigest`, conflicts, settings prompts, storage mappings, external mount collection requirements, Docker container names, network aliases, and endpoints/ports;
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
- Docker container image references, pull policies, container names, and operation status;
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

The install flow does not include request flags such as refresh behavior, diagnostics toggles, or conflict-check bypasses.

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
      "endpoints": []
    },
    "docker": {
      "containers": [
        {
          "moduleId": "com.acme.reports",
          "key": "app",
          "containerName": "mod-com-acme-reports-app",
          "networkAlias": "mod-com-acme-reports-app",
          "image": {
            "moduleId": "com.acme.reports",
            "container": "app",
            "repository": "ghcr.io/acme/reports-module",
            "tag": "1.0.0",
            "reference": "ghcr.io/acme/reports-module:1.0.0",
            "pullPolicy": "ifNotPresent"
          },
          "dependsOn": [],
          "ports": [],
          "endpoints": []
        }
      ]
    },
    "conflicts": []
  }
}
```

The `dependencies` array represents the resolved dependency tree. `installOrder` is the topological module id order used for apply. `normalizedMetadata` contains the normalized root metadata after defaults are applied. `settings` contains prompts, defaults, targets, and secret redaction markers, but never raw secret values.

The implementation returns dependency nodes with their own normalized metadata, Docker container names, network aliases, module paths, install action (`install` or `reuse`), and dependency connection mappings. The top-level `paths` object identifies the root module directory and local `metadata.json` copy paths in both host and Host-container path spaces.

Install plan Docker checks:

- `POST /api/modules/install/plan` requires Docker daemon read access.
- The endpoint must perform read-only Docker conflict checks for generated container names, missing containers for reusable dependencies, and, when the Host-managed network already exists, network aliases before returning a successful plan.
- The endpoint must not create or mutate files, module directories, images, containers, or Docker networks.
- A missing Host-managed network is not a plan conflict. The install apply endpoint creates the network at mutation time.
- If Docker daemon is unavailable, the endpoint should return HTTP `503` and should not return a successful install plan.
- Docker conflict observations are not part of `planDigest`; the apply endpoint must repeat Docker conflict checks before any mutation.

Digest semantics:

- `metadataDigest` is the SHA-256 digest of the root metadata JSON bytes downloaded from the submitted `metadataUrl`. It is used for source transparency, diagnostics, and explaining when the same URL now returns different metadata.
- `planDigest` is the SHA-256 digest of a canonical JSON representation of the normalized install plan. It covers normalized root metadata, dependency metadata tree, dependency install order, image references, computed paths, setting prompts, storage requirements, Docker container names, network aliases, endpoints, and runtime ports. It must exclude timestamps, transient download details, Docker runtime status, read-only Docker conflict observations, and other fields that can change without changing the reviewed plan.
- `planDigest` is the primary review guard for install apply. The apply endpoint must recompute the plan from the submitted `metadataUrl` and administrator decisions, then reject the request if the recomputed `planDigest` differs from the reviewed `planDigest`.

The Host should not persist pending install plans as durable state. Apply endpoints should recompute the plan and compare the reviewed `planDigest` before changing files, module state, images, or containers.

Install plan validation and conflict status boundaries:

- HTTP `422` is used when metadata is invalid by itself, dependency graph validation fails, or the metadata requests unsupported fields, setting types, protocols, storage mount types, or unsafe paths.
- HTTP `409` is used when metadata is valid but conflicts with current Host or Docker state, such as an already installed module id, generated container name collision, network alias collision, environment variable target collision, or storage mapping collision.
- `validationErrors[].path` should use a JSONPath-like string pointing to the failing metadata field, for example `$.containers[0].image.repository` or `$.dependencies[0].connection.endpoint`.
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

The update API does not accept a replacement metadata URL. It updates from the metadata URL stored in the installed module record.

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

The full `ModuleUpdatePlan` includes current and proposed module identity, normalized refreshed metadata, dependency install/reuse decisions, install order, image references, setting prompts, preserved settings, storage mappings, preserved and removed external mount mappings, endpoints/runtime resource details, deterministic Docker container configurations, replacement requirements, warnings, and conflicts.

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

When runtime configuration changes, update apply stops/removes/recreates the module containers with deterministic container names. Metadata-only updates may skip container replacement. If refreshed `pullPolicy` is `always`, the Host pulls and recreates affected containers even when an image reference is unchanged.

Failed update apply uses the shared install-plan error envelope for validation/conflict failures before mutation. Partial failures after mutation has started mark the module `failed`, set `lastOperation` to `update`, preserve files, storage, images, and containers for diagnosis, and store enough update attempt context for `POST /api/modules/{moduleId}/update/retry`.

### Module recovery and removal

The recovery API adds explicit actions for failed installs, failed updates, failed install cleanup, and installed module removal.

- `POST /api/modules/{moduleId}/retry` retries a failed install from the local `metadata.json` and stored install record. Retry removes and recreates failed module containers, preserves module-owned data directories, starts stored dependencies when needed, and records fresh diagnostics if it fails again.
- `POST /api/modules/{moduleId}/update/retry` retries a failed update and is documented in [Module update](#module-update).
- `POST /api/modules/{moduleId}/cleanup/plan` returns a backend-generated cleanup preview for a failed module.
- `POST /api/modules/{moduleId}/cleanup` applies a confirmed cleanup request. Request body: `{ "confirmed": true, "deleteModuleData": false }`.
- `POST /api/modules/{moduleId}/remove/plan` returns a backend-generated removal preview for an installed module.
- `POST /api/modules/{moduleId}/remove` applies a confirmed removal request. Request body: `{ "confirmed": true, "deleteModuleData": false }`.

Cleanup and remove plan requests accept `{ "deleteModuleData": true | false }` so the Web UI can refresh the preview before confirmation. Plans return `canApply`, `containers[]` states, `images[]` references, local `metadata.json`, module directory, module-owned storage directories, external mount mappings, dependents, warnings, and conflicts.

The default is always to preserve module-owned data. Setting `deleteModuleData=true` deletes only module-owned directories under the Host data root. Docker images and external host paths are never deleted by recovery flows; external mount mappings are only removed from Host state.

Installed module removal is blocked when other installed modules depend on the target module. Remove sets `operationStatus=removing` only while the operation is in progress. If removal fails before the registry entry is deleted, the module returns to `installed` with `lastError`.

Lifecycle hardening marks modules `failed` when a lifecycle action discovers a missing Docker container or a missing required storage mapping. Transient Docker daemon, network, stop, or restart errors remain action errors and do not change persistent operation status.

### Authentication

Browser authentication uses Host-owned sessions stored server-side in the auth state. Host session cookies are HttpOnly and are never forwarded to modules by the gateway.

Implemented browser auth endpoints:

- `POST /api/auth/bootstrap` creates the first local `host.admin` after a valid local setup token.
- `POST /api/auth/login` authenticates a local password user and creates a Host session.
- `POST /api/auth/logout` revokes the current Host session.
- `GET /api/auth/status` returns setup and current-session status.
- `POST /api/auth/recovery` consumes a local setup or recovery token, restores a `host.admin` account, revokes stale sessions for that account, and creates a new browser session.
- `POST /api/auth/reauth` refreshes the current browser session's recent reauthentication timestamp using a local password or recovery token.
- `GET /api/auth/diagnostics` returns safe OIDC and trusted-proxy diagnostics for Host administrators.
- `GET /api/auth/oidc/login` starts generic OIDC Authorization Code with PKCE when an OIDC provider is configured.
- `GET /api/auth/oidc/callback` validates the OIDC callback, exchanges the authorization code, verifies the ID token with provider JWKS, applies explicit role mapping, creates or updates the Host user for the external identity, and creates a normal Host session.

OIDC login denies access when the transaction state is invalid or expired, ID token verification fails, the token has no subject, no role mapping matches, or the mapped Host user is disabled. OIDC provider access tokens, refresh tokens, and ID tokens are not persisted.

### CLI admin tokens

CLI admin tokens authenticate local CLI commands to Host API routes as `host.admin` operations. The Host stores only token hashes and returns raw token material only when a token is created or rotated.

- `GET /api/auth/cli-tokens` returns CLI token metadata: `id`, `userId`, `label`, `createdAt`, optional `lastUsedAt`, optional `revokedAt`, and `scope`.
- `POST /api/auth/cli-tokens` creates a CLI token for the current administrator by default. Optional body: `{ "label": "Laptop CLI", "userId": "user_123" }`.
- `DELETE /api/auth/cli-tokens/{tokenId}` revokes an active CLI token.
- `POST /api/auth/cli-tokens/{tokenId}/rotate` revokes the selected token and returns a raw replacement token once. Optional body: `{ "label": "Replacement CLI" }`.

All CLI token lifecycle endpoints require `host.auth.configure`. Browser-session requests must pass the Host same-origin CSRF check. CLI Bearer-token requests are not subject to CSRF checks.

### Sessions and audit

Session and audit APIs support the `/settings/security` operations surface:

- `GET /api/auth/sessions` returns active Host sessions and can include recently revoked sessions with `includeRevoked=true`.
- `DELETE /api/auth/sessions/{sessionId}` revokes a Host session by id.
- `GET /api/auth/audit` returns sanitized audit events with cursor pagination and filters for event type, actor, target, result, and timestamp range.
- `DELETE /api/auth/audit` applies retention-based purge and appends a final `auth.audit.purged` summary event.

Session revocation and audit purge require `host.auth.configure`; mutating browser-session requests also require recent reauthentication. Responses never expose raw session cookies, token hashes, bearer tokens, setup tokens, recovery tokens, provider assertions, or provider tokens.

### Gateway exposure and ingress readiness

Gateway exposure APIs manage Host-owned module subdomain routing:

- `GET /api/gateway/exposures` lists gateway exposures and assigned Host user ids.
- `POST /api/gateway/exposures` creates or updates an exposure for `moduleId`, `hostname`, endpoint key in `endpointKey`, optional `exposurePolicy`, and optional `identityMode`.
- `PUT /api/gateway/exposures/{exposureId}` updates hostname, endpoint key, policy, identity mode, or enabled state.
- `DELETE /api/gateway/exposures/{exposureId}` removes an exposure.
- `PUT /api/gateway/exposures/{exposureId}/assignments` replaces assigned Host user ids for the exposure's module.

External ingress readiness APIs track manual provider-neutral publishing state for existing gateway exposures:

- `GET /api/ingress/exposures` lists readiness status, generated instructions, validation checks, and next steps for gateway exposures.
- `POST /api/ingress/exposures` creates or updates manual readiness intent. Request body includes `gatewayExposureId`, optional checklist fields, optional notes, and optional `markReady`.
- `GET /api/ingress/exposures/{exposureId}` returns one exposure's readiness status.
- `PUT /api/ingress/exposures/{exposureId}` updates that exposure's manual readiness intent.
- `POST /api/ingress/exposures/{exposureId}/refresh` reruns Host-side validation and marks the record `validated`, `failed`, or `drifted`.
- `DELETE /api/ingress/exposures/{exposureId}` unlinks the local readiness record without implying that external DNS, proxy, tunnel, or provider resources were deleted.

These endpoints require `modules.exposure.manage`. They validate only Host-owned prerequisites and stored manual checklist state; provider API automation is not part of this API.

### Module identity discovery

Module identity discovery is public because it exposes only public key material and validation metadata:

- `GET /.well-known/docker-host/module-identity.json` returns issuer, JWKS URI, supported algorithms, and the identity header name.
- `GET /.well-known/docker-host/jwks.json` returns the Host public JWKS for validating `X-Docker-Host-Identity`.

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

## Documentation status

This document is the Host API contract. It should be updated when implementation decisions change.

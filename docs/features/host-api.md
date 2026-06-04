# Docker Host API

This document describes the legacy Docker Host API surface. It is retained as a human-readable endpoint catalog for compatibility context while current Hosty Core APIs live in `apps/core`.

The retired full-stack Next.js Host implementation has been removed from the repository. New app lifecycle work should use Hosty Core APIs and `hosty apps`; legacy module commands should be treated as compatibility-only.

## Principles

- Hosty Core is the owner of app management logic. Legacy Host API notes describe the previous module-management contract.
- Runtime status is read from Docker daemon, not from persistent JSON files.
- App-oriented lifecycle state is stored in `apps.json` and app state. Legacy installed module records remain readable from root-level `modules.json`.
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
- expose Hosty Shell as a system app and legacy modules as runtime apps through `/api/apps` and `/control/v1/apps`;
- create, list, and restore app data backups through local control routes;
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

`operationStatus` is persistent Host bookkeeping from app lifecycle state or a legacy module record. `containers[].runtimeStatus` is read from Docker daemon for every request and must not be treated as stored state. Top-level `runtimeStatus` is an aggregate derived from the module containers.

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
  "kind": "runtime",
  "system": false,
  "source": "https://github.com/acme/reports",
  "displayName": "Reports",
  "description": "Generates operational reports.",
  "version": "1.0.0",
  "capabilities": ["open", "update", "restart", "stop", "remove", "backup", "restore", "logs"],
  "selectedRuntime": "docker",
  "selectedChannel": null,
  "autostart": true,
  "operationStatus": "started",
  "runtimeState": "running",
  "lastOperation": "start",
  "lastError": null,
  "settings": [],
  "endpoints": [
    {
      "key": "http",
      "protocol": "http",
      "url": "http://app.localhost:3210",
      "public": true
    }
  ],
  "entryPath": "/",
  "embeddedUrl": "http://app.localhost:3210/",
  "navigation": [
    {
      "label": "People",
      "path": "/people",
      "entryPath": "/people",
      "embeddedUrl": "http://app.localhost:3210/people"
    }
  ]
}
```

Hosty Shell is returned as a system app to administrators when Core has installed or bootstrapped it:

```json
{
  "id": "hosty.shell",
  "kind": "system",
  "system": true,
  "source": "system",
  "displayName": "Hosty Shell",
  "version": "bundled",
  "selectedRuntime": "host-core",
  "autostart": true,
  "operationStatus": "started",
  "runtimeState": "running",
  "capabilities": ["open", "update", "restart", "stop", "logs"],
  "entryPath": "/",
  "embeddedUrl": "/",
  "navigation": []
}
```

`GET /api/apps` intentionally omits raw Docker/container internals. It does not return container ids, container names, Docker network aliases, Docker network URLs, or service/API gateway exposure hostnames. It returns browser UI URLs derived from installed app `ui` metadata and runtime endpoint URLs. Shell uses those URLs as redirect targets when requesting app launch codes.

System apps and runtime apps share the response shape but differ in capabilities. System apps must not expose ordinary runtime app remove actions.

### `AppDataBackupRecord`

Returned by app backup control endpoints.

```json
{
  "schemaVersion": "app-backup.0.1",
  "id": "2026-06-01T12-00-00Z_manual",
  "appId": "com.acme.reports",
  "reason": "manual",
  "createdAt": "2026-06-01T12:00:00Z",
  "dataPath": "/data/apps/com.acme.reports/data",
  "archivePath": "/data/backups/com.acme.reports/2026-06-01T12-00-00Z_manual.zip",
  "archiveDigest": "sha256:...",
  "archiveBytes": 12345,
  "fileCount": 8
}
```

The archive includes only the primary app `data/` directory. External mounts and additional storage mappings are excluded.

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

This endpoint creates the Host data root, app directories, legacy `modules/` directory, and shared module network if they are missing. It does not create an empty `modules.json` for app-only lifecycle state. It returns HTTP `200` when the Host runtime and Docker daemon are ready, and HTTP `503` when a dependency is unavailable.

## Endpoints

The endpoints in this section are implemented by the Host API.

### `GET /api/modules`

Returns installed modules known to Docker Host.

The backend reads the merged compatibility view from `apps.json` and, when present, `modules.json`. App-oriented installs use local `manifest.json`; legacy module records use local `metadata.json`. The backend asks Docker daemon for current runtime/container state. Docker runtime state is not stored in the registry files.

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
- lifecycle/install bookkeeping status from app lifecycle state or a legacy module record, if any;
- Docker runtime status;
- timestamps such as installed and last updated, if available;
- last install/update error summary, if available.

### `GET /api/apps`

Returns app navigation data for the current authenticated Host principal.

This endpoint requires authentication but does not require `host.admin`. Unauthenticated callers receive HTTP `401` and no app discovery data. `host.admin` can see all shell-routable app entries, including unavailable entries with safe diagnostic status. `host.user` can see only available apps that are visible to all authenticated users or explicitly assigned to that user.

The backend reads installed runtime app records, hydrates shell UI metadata from each app's local `manifest.json` when older `state.json` records do not yet contain it, applies Host-owned app assignments, and returns runtime state from Core's registry. It does not infer shell Apps from gateway exposure records or from public runtime ports alone.

Response body:

```json
{
  "apps": []
}
```

Response entries include:

- app id;
- source (`installed`);
- display name;
- description, if available;
- version;
- app-level autostart setting;
- app operation status;
- runtime state without container details;
- direct browser UI URL;
- nested navigation items.

The response includes `ui.navigation[]` in manifest order. Each navigation item contains the manifest path and an `embeddedUrl` resolved against the selected UI endpoint. Older installed app records are compatible because Core can hydrate UI metadata from the stored manifest copy at read time.

### `POST /api/apps/install/plan`

Reviews a runtime app manifest before installation.

The request accepts a local manifest path or an absolute `http`/`https` manifest URL. `selectedRuntime` is optional; when omitted, Core selects the manifest default runtime (`defaultRuntime`, a profile with `default: true`, or the first profile).

The response returns the selected install plan plus `runtimeProfiles[]` so Shell can show a runtime selector only after the manifest is reviewed. Each runtime profile entry includes `key`, `type`, and `default`. `defaultAutostart` is `true` unless the request explicitly previews a disabled install.

### `POST /api/apps/{appId}/autostart`

Updates the installed runtime app's app-level startup setting. This endpoint requires an active admin Core browser session and CSRF token.

Request:

```json
{
  "autostart": true
}
```

The setting is runtime-neutral. Core uses it during Core startup; Docker runtime apps do not use Docker-managed restart policies.

### `POST /api/apps/{appId}/launch-code`

Issues a short-lived app authorization code for opening an installed runtime app from Hosty Shell.

This endpoint requires an active Core browser session and a valid CSRF token. Core validates that the selected app exists, that the current user is allowed to access it, and that `redirectUri` targets one of the installed app endpoint origins.

Request:

```json
{
  "redirectUri": "http://app.localhost:3210/people"
}
```

Response:

```json
{
  "code": "<opaque-code>",
  "redirectUri": "http://app.localhost:3210/people?code=<opaque-code>",
  "expiresAt": "2026-06-04T12:05:00Z"
}
```

The Shell uses the returned `redirectUri` as the iframe source for embedded app workspaces. The runtime app exchanges the one-time code through Core's app auth token endpoint and then owns its app-local session behavior.

### `GET /api/apps/{appId}/open`

Redirects the active Core browser session to a standalone runtime app URL with a short-lived app authorization code.

This endpoint is intended for normal browser links such as `target="_blank"` actions. It requires an active Core browser session, validates app access and the supplied `redirectUri`, then responds with an HTTP redirect to the app URL with `code=<opaque-code>` appended. It does not require a CSRF token because it is an OAuth-style browser navigation endpoint, not a JSON mutation endpoint.

Example:

```text
GET /api/apps/com.haas.demo-app/open?redirectUri=http%3A%2F%2Fapp.localhost%3A3100%2F%3Fhosty_theme%3Ddark%26hosty_theme_preference%3Dsystem
```

Shell-embedded runtime apps may receive the active Shell theme in two ways:

- Shell appends `hosty_theme=light|dark` and `hosty_theme_preference=light|dark|system` to the app launch redirect URI before requesting the launch code.
- Shell posts `{ "type": "hosty:shell-theme", "theme": "light|dark", "preference": "light|dark|system" }` to the app iframe whenever the iframe loads or the Shell theme changes.

Runtime apps must treat this as optional UI context. Standalone app launches should continue to work without Shell messages by using the URL value when present and otherwise falling back to the app's own stored or system theme.

The endpoint does not create or read gateway exposure records.

### `GET /api/modules/{moduleId}`

Returns detailed information for one installed module.

Response should include:

- fields from `GET /api/modules`;
- local metadata details needed by the UI;
- settings schema from `metadata.json`;
- indication of which secret settings are set, without raw secret values;
- storage declarations from metadata;
- computed or configured storage mappings stored in app lifecycle state or a legacy module record, if available;
- dependency declarations and resolved dependency URLs, if available;
- container details needed for status and logs links.

### `POST /api/modules/{moduleId}/start`

Starts the Docker containers for an installed module.

The backend resolves the module from the merged app/legacy registry, maps it to the corresponding Docker containers, and asks Docker daemon to start them.

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

- `POST /api/modules/install/plan` - load a manifest from `manifestUrl` or legacy metadata from `metadataUrl`, validate and normalize it, resolve required dependencies, and return a read-only install plan with `metadataDigest`, `planDigest`, conflicts, settings prompts, storage mappings, external mount collection requirements, Docker container names, network aliases, and endpoints/ports;
- `POST /api/modules/install` - accept a reviewed install request with manifest/metadata URL, reviewed `planDigest`, settings values, and selected external mounts, recompute the plan, reject if the digest changed, then apply the install.

If the requested metadata resolves to a module id that is already registered from the same stored metadata URL, the install plan endpoint returns `mode: "update"`, `existingModuleId`, and an `updatePlan` instead of treating the installed module id or its Docker container names as install blockers. Clients must then apply the reviewed plan through the module update endpoint, not `POST /api/modules/install`.

The Web UI can apply the install request directly from the reviewed form. A redacted JSON preview is optional and does not need to be generated before apply.

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

Install apply persists app-oriented installs in `apps.json` and writes `modules.json` only for legacy module records or when an existing legacy file must be preserved.

For legacy module records, `modules.json` stores:

- source `metadataUrl`, preferred `manifestUrl`, local `metadataPath` or `manifestPath`, root or dependency `metadataDigest`, and reviewed `planDigest`;
- Docker container image references, pull policies, container names, and operation status;
- typed setting values, including write-only secret values;
- computed module-owned `storageMappings`;
- selected `externalMounts`;
- resolved dependency base URLs;
- timestamps and the last operation error.

`apps.json` stores the app-oriented source pointer and current app selection:

- `id`;
- `manifestUrl`;
- `manifestPath`;
- `selectedRuntime`;
- `selectedChannel` when known;
- timestamps.

Legacy Docker metadata still writes `modules/<module-id>/metadata.json`. New `app.0.1` manifests use `apps/<app-id>/manifest.json` as their local manifest path. The compatibility adapter keeps legacy metadata paths readable.

The reviewed install request payload shape is:

```json
{
  "manifestUrl": "https://apps.example.com/reports/manifest.json",
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
- HTTP `409` is used when metadata is valid but conflicts with current Host or Docker state, such as an already installed module id from a different metadata URL, generated container name collision, network alias collision, environment variable target collision, or storage mapping collision.
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

The update API does not accept a replacement metadata URL. It updates from the metadata URL stored in the installed module record. Failed modules can create update plans; these plans force container replacement so a partially failed install or update can be repaired from the stored metadata URL.

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

### Module configuration

Installed modules can be reconfigured without reinstalling from metadata:

- `POST /api/modules/{moduleId}/configure/plan` - read the installed local metadata and stored runtime decisions, then return configurable setting prompts, current public endpoint origins and Host ports, external mount collections, selected external mounts, warnings, and a `configurationDigest`;
- `POST /api/modules/{moduleId}/configure` - accept the reviewed `configurationDigest`, setting values, endpoint origin selections, and external mounts, reject stale or conflicting decisions, then persist the configuration.

Changing only a public origin updates the app lifecycle state or legacy module record and Host app discovery without recreating containers. Changing setting values, external mounts, or endpoint Host ports requires container recreation so environment variables, bind mounts, and published ports match the stored configuration. Partial failures after mutation has started mark the module `failed` with `lastOperation: "configure"` and preserve the stored configuration for retry or cleanup.

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

Browser authentication uses Host-owned sessions stored server-side in the auth state. Host session cookies are HttpOnly and are never forwarded to modules by the gateway. Browser account switching uses a separate HttpOnly account-set cookie with only a server-side token hash stored in auth state.

Implemented browser auth endpoints:

- `POST /api/auth/bootstrap` creates the first local `host.admin` after a valid local setup token.
- `POST /api/auth/login` authenticates a local password user, creates a Host session, and remembers the account in the current browser account set.
- `POST /api/auth/logout` revokes the current Host session.
- `GET /api/auth/status` returns setup and current-session status.
- `POST /api/auth/recovery` consumes a local setup or recovery token, restores a `host.admin` account, revokes stale sessions for that account, creates a new browser session, and remembers the account in the current browser account set.
- `POST /api/auth/reauth` refreshes the current browser session's recent reauthentication timestamp using a local password or recovery token.
- `GET /api/auth/accounts` returns the active user and remembered account summaries for the current browser.
- `POST /api/auth/accounts/switch` accepts `{ "userId": "..." }`, validates that the user is remembered and enabled, creates a fresh active Host session, and returns the selected user's default shell path.
- `DELETE /api/auth/accounts/{userId}` removes one remembered account from the current browser. If it removes the active user, it also revokes the active session and clears the session cookie.
- `DELETE /api/auth/accounts` revokes the current browser account set and the active session, then clears both browser auth cookies.
- `GET /api/auth/diagnostics` returns safe OIDC and trusted-proxy diagnostics for Host administrators.
- `GET /api/auth/oidc/login` starts generic OIDC Authorization Code with PKCE when an OIDC provider is configured.
- `GET /api/auth/oidc/callback` validates the OIDC callback, exchanges the authorization code, verifies the ID token with provider JWKS, applies explicit role mapping, creates or updates the Host user for the external identity, creates a normal Host session, and remembers the account in the current browser account set.
- `GET /api/auth/invitations/accept?setupToken=...` returns a safe local invitation preview containing the invited email, role, display name, assigned module ids, and expiry.
- `POST /api/auth/invitations/accept` consumes a valid local invitation token, creates a local password user, applies initial module assignments, creates a Host session, and remembers the account in the current browser account set.

OIDC login denies access when the transaction state is invalid or expired, ID token verification fails, the token has no subject, no role mapping matches, or the mapped Host user is disabled. OIDC provider access tokens, refresh tokens, and ID tokens are not persisted.

Account switching endpoints use the active Host session for authorization and the HttpOnly `docker_host_accounts` cookie to find the browser account set. The account-set cookie is not a module credential and is stripped from gateway traffic. Direct-origin shell iframe traffic cannot receive Host cookies for its module origin.

### Local CLI control

Local CLI module and dev commands authenticate through trusted control discovery, not through browser sessions or CLI bearer tokens. The Host writes `<HOST_DATA_ROOT_HOST>/run/control.json` at startup, and the CLI calls `/control/v1` with the discovered control contract version and per-start control secret.

The control channel is not a public Host API surface. It is not proxied by the gateway, does not accept browser cookies, and does not grant remote API access.

Initial control routes:

- `GET /control/v1/host/status` returns Host readiness for CLI preflight checks.
- `GET /control/v1/apps` lists Hosty system apps and runtime apps for local CLI management.
- `POST /control/v1/apps/install` installs an `app.0.1` runtime app from a local manifest path or absolute `http` or `https` manifest URL.
- `POST /control/v1/apps/{appId}/autostart` updates the installed runtime app's app-level startup setting. Request body: `{ "autostart": true }`.
- `POST /control/v1/apps/{appId}/update/plan` creates a runtime app update plan. Apps installed from a manifest URL refresh that stored URL by default.
- `POST /control/v1/apps/{appId}/update` applies a reviewed runtime app update plan.
- `POST /control/v1/apps/{appId}/start`, `stop`, and `restart` run runtime app lifecycle actions.
- `GET /control/v1/apps/{appId}/backups` lists app data backups.
- `POST /control/v1/apps/{appId}/backups` creates a manual app data backup.
- `POST /control/v1/apps/{appId}/backups/{backupId}/restore` restores one backup. Request body: `{ "confirmed": true, "stopBeforeRestore": true, "createPreRestoreBackup": true }`.
- `GET /control/v1/modules` lists installed modules.
- `POST /control/v1/modules/install/plan` creates an install plan.
- `POST /control/v1/modules/install` applies a reviewed install plan.
- `POST /control/v1/modules/{moduleId}/update/plan` creates an update plan.
- `POST /control/v1/modules/{moduleId}/update` applies a reviewed update plan.
- `POST /control/v1/modules/{moduleId}/start`, `stop`, and `restart` run module lifecycle actions.
- `POST /control/v1/modules/{moduleId}/remove/plan` creates a remove plan.
- `POST /control/v1/modules/{moduleId}/remove` applies a reviewed remove plan.
App data backups protect only the primary app data directory:

- preferred path: `apps/<app-id>/data`;
- legacy fallback: installed storage mapping with key `data`;
- secondary fallback: installed storage mapping whose host path ends in `data`.

External mounts are excluded. Update apply creates a `pre-update` backup when a data directory exists. Current ZIP creation is in-memory and rejects app data above 256 MiB until a streaming archive writer is implemented. Restore verifies archive digest and per-entry CRCs, stops the app by default, creates a `pre-restore` backup by default, replaces the data directory, and does not restart the app automatically.

### Sessions and audit

Session and audit APIs support the `/settings/security` operations surface:

- `GET /api/auth/sessions` returns active Host sessions and can include recently revoked sessions with `includeRevoked=true`.
- `DELETE /api/auth/sessions/{sessionId}` revokes a Host session by id.
- `GET /api/auth/audit` returns sanitized audit events with cursor pagination and filters for event type, actor, target, result, and timestamp range.
- `DELETE /api/auth/audit` applies retention-based purge and appends a final `auth.audit.purged` summary event.

Session revocation and audit purge require `host.auth.configure`; mutating browser-session requests also require recent reauthentication. Responses never expose raw session cookies, token hashes, bearer tokens, setup tokens, recovery tokens, provider assertions, or provider tokens.

### User management

User Management APIs support the `/settings/users` operations surface:

- `GET /api/auth/users` returns Host user summaries, invitation summaries, assignable installed runtime apps, and supported invite expiry options.
- `GET /api/auth/invitations` returns invitation summaries.
- `POST /api/auth/invitations` creates a local user invitation. Request body: `{ "email": "user@example.test", "displayName": "User", "role": "host.user", "ttlMs": 86400000, "assignedModuleIds": ["com.example.reports"] }`. The response includes the raw setup token and setup URL once.
- `DELETE /api/auth/invitations/{inviteId}` revokes a pending invitation.
- `PATCH /api/auth/users/{userId}` updates local user fields such as display name or role.
- `DELETE /api/auth/users/{userId}` soft-disables the user.
- `PUT /api/auth/users/{userId}/assignments` replaces the user's module assignment list.

All administrator user-management endpoints require `host.users.manage`. Mutating browser-session requests also require recent reauthentication and the same-origin CSRF check.

Invitation tokens are setup-token style credentials with hash-only storage. Local invitations require email, are single-use, and can expire after 15 minutes, 24 hours, or 7 days. Accepting an invitation creates a local password user; it does not pre-provision OIDC or trusted-proxy identities.

User deletion is implemented as soft-disable. Disabling a user revokes active sessions, removes the user from remembered browser account sets, and removes module assignments. Docker Host prevents disabling or demoting the last active administrator.

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
- Browser session cookies and local control secrets are not accepted for this endpoint.
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

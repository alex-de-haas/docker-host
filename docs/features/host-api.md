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

- list installed modules;
- return module runtime statuses;
- start a module;
- stop a module;
- restart a module.

Module install, update, remove, settings editing, storage configuration, install plans, update plans, and external exposure are later API slices.

## Endpoints

### `GET /api/modules`

Returns installed modules known to Docker Host.

The backend reads `modules.json` for installed module registry entries and persistent module state, reads each module's local `metadata.json` for display metadata, and asks Docker daemon for current runtime/container state. Persistent module state includes the source metadata URL, install/update status, failure state, last error details, computed storage mappings, and resolved dependency URLs. Docker runtime state is not stored in `modules.json`.

Response should include, per module:

- module id;
- name;
- description, if available;
- version;
- source metadata URL;
- Docker image reference;
- lifecycle/install bookkeeping status from `modules.json`, if any;
- Docker runtime status;
- Docker health status, if Docker reports one;
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

### `GET /api/modules/{moduleId}/logs`

Returns recent logs for one module container.

This endpoint is useful for the first Web UI slice even before install/update/remove flows are implemented.

Recommended query parameters:

- `tail` - number of recent lines;
- `since` - optional timestamp or duration boundary;
- `timestamps` - whether Docker log timestamps should be included.

## Later API slices

### Module installation

Future endpoints should support:

- loading metadata from URL;
- validating metadata;
- producing an install plan;
- confirming and applying install;
- exposing install failure diagnostics.

### Module update

Future endpoints should support:

- refreshing the stored metadata URL;
- comparing local and remote metadata;
- producing an update plan;
- confirming and applying update;
- exposing update failure diagnostics.

### Module removal

Future endpoints should support:

- remove plan;
- container removal;
- optional data cleanup decisions;
- clear reporting of what data is preserved or deleted.

### Settings and storage

Future endpoints should support:

- editing module setting values stored in `modules.json`;
- write-only handling for secret settings;
- configuring external storage mounts;
- validating mount behavior through Docker daemon where needed.

## Documentation status

This document is the Phase 0/1 API planning artifact. It should be updated when implementation decisions change. Once the API stabilizes, generated OpenAPI can be introduced under `packages/contracts`.

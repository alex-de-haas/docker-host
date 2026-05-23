# Module Metadata Reference

Use this reference when authoring or reviewing Docker Host module metadata. The repository source of truth is `docs/features/module-metadata.md` plus validation code in `apps/host/src/lib/module-metadata.ts`.

## Contract

- A Docker Host module is installed from a direct JSON metadata URL, not from a Git repository URL or image registry alone.
- The current supported metadata schema is `schemaVersion: "0.2"`.
- Validation is strict for schema `0.2`; unknown fields are rejected at every object level.
- The Host downloads dependency metadata recursively and rejects cycles.
- Recommended module ids use reverse-DNS format, for example `com.acme.reports`.
- The Host stores one installed module instance per module `id`.
- Keep a local copy of the fetched metadata as the installed or latest updated contract.

## Required Shape

Top-level fields:

- `schemaVersion`: required string, currently `"0.2"`.
- `id`: required stable module id.
- `name`: required human-readable name.
- `description`: optional display description.
- `version`: required module contract version. Host currently uses only the major part for dependency compatibility.
- `containers`: required non-empty array.
- `endpoints`: optional array, default empty.
- `connections`: optional array for internal endpoint URL injection between containers in the same module.
- `dependencies`: optional array of required dependency metadata URLs.
- `settings`: optional array of Host-collected configuration values.
- `storage`: optional module-owned directories and external mount collections.
- `ui`: optional shell app entrypoint and navigation.

Container fields:

- `containers[].key`: stable lowercase key, unique inside the module.
- `containers[].dependsOn`: optional startup ordering inside the same module; cycles are rejected.
- `containers[].image.repository`: required Docker image repository.
- `containers[].image.tag`: required Docker image tag.
- `containers[].image.pullPolicy`: optional `ifNotPresent`, `always`, or `manual`; default `ifNotPresent`.
- `containers[].runtime.ports[]`: named ports with `key`, `containerPort`, and `protocol`. Current target protocol is `http`.
- `containers[].runtime.healthcheck`: accepted but ignored by the first implementation unless code has been extended.
- `containers[].runtime.resources`: CPU and memory hints.

Endpoint fields:

- `endpoints[].key`: stable module endpoint key.
- `endpoints[].container`: container key.
- `endpoints[].port`: port key inside the selected container.
- `endpoints[].public`: capability hint saying the endpoint is suitable for gateway exposure. It is not an authorization policy.

Settings fields:

- `settings[].key`: stable setting key.
- `settings[].type`: `string`, `number`, `boolean`, `url`, or `secret`.
- `settings[].required`: whether the administrator must provide or confirm a value.
- `settings[].default`: optional default. Never put real secret values in metadata.
- `settings[].targets[]`: usually environment targets of shape `{ "container": "app", "type": "env", "name": "ENV_NAME" }`.

Storage fields:

- `storage.directories[]`: fixed module-owned bind mounts under the Host module directory.
- `storage.directories[].mount.type`: currently `bind`.
- `storage.directories[].mount.modulePath`: path below the module directory, for example `data`.
- `storage.mountCollections[]`: administrator-selected external host paths.
- External mount collections are mappings only; Docker Host must not delete external host data during module removal.

UI fields:

- `ui.category`: optional, must be `Apps` when present.
- `ui.icon`: lowercase shell icon key, for example `boxes`.
- `ui.entrypoint.portKey`: references an `endpoints[].key` marked `public: true`.
- `ui.entrypoint.path`: same-origin absolute path starting with `/`.
- `ui.navigation[]`: optional same-origin navigation paths for the Host shell.
- Missing `ui` is valid and means the module does not appear as a shell App.

## Install And Update Behavior

- Install downloads metadata, validates it, resolves dependencies, prepares the module directory, computes storage mappings, shows an install plan, then applies it after administrator confirmation.
- Install/update failure is optimistic and fail-fast. Docker Host preserves created files, images, and containers for diagnosis and marks the module `failed`.
- Retry and cleanup are explicit administrator actions.
- Update always refreshes the stored metadata URL first. It is not only a pull of the current image tag.
- Update plans should highlight changes to images, settings, storage, dependencies, endpoints, resources, and UI metadata.

## Minimal Metadata Skeleton

Use `assets/module-template/metadata.json` as a valid starting point. Replace every id, image reference, setting, storage path, and navigation item before shipping.

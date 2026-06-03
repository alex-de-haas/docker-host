# Runtime app update flow

This document describes the behavior for updating installed runtime apps and legacy modules.
Update is a manifest refresh plus reviewed change plan, not only a Docker image pull.

## Scope

The update flow implements:

- an update plan API for installed runtime apps;
- a reviewed update UI;
- an update apply API;
- pre-update backup for the primary app data directory when it exists;
- explicit retry behavior for failed updates;
- same-source install handoff, where installing an already registered app id from the same manifest URL, or a legacy module id from the same metadata URL, opens update review instead of blocking on the existing id or container names.

The update flow does not support:

- automatic rollback after partial update failure;
- recursive automatic updates of already installed dependencies;
- SemVer range solving or multiple installed versions of the same module id;
- generic settings edit APIs outside the update review flow.

## Update API

The Host uses separate update endpoints:

- `POST /api/modules/{moduleId}/update/plan`
- `POST /api/modules/{moduleId}/update`
- `POST /api/modules/{moduleId}/update/retry`

The plan endpoint reads the installed record from `apps.json` when available, falls back to `modules.json` for legacy modules, and refreshes the stored `manifestUrl` or compatibility `metadataUrl`. The update API does not accept a replacement source URL during update.

`POST /api/modules/install/plan` may also return an update handoff when the requested manifest or legacy metadata resolves to an app/module id that is already registered with the same stored source URL. In that case clients should switch to update review and apply through `POST /api/modules/{moduleId}/update`, preserving existing settings, storage mappings, external mounts, and published ports where compatible.

The apply endpoint recomputes the update plan from the installed record, refreshed manifest or legacy metadata, and submitted administrator decisions. It rejects the request when the reviewed `updatePlanDigest` no longer matches the recomputed plan.

The retry endpoint is only for failed update attempts. Failed installs still have `POST /api/modules/{moduleId}/retry`; a same-source reinstall attempt can also move into update review when the administrator enters the original source URL again.

## Plan Shape

`ModuleUpdatePlan` is a separate type, not a reused `InstallPlan`. It reuses install planner internals where practical, but update review needs both the current installed state and the proposed refreshed state.

The plan includes:

- `moduleId`;
- stored `manifestUrl` or compatibility `metadataUrl`;
- current local manifest/metadata digest;
- refreshed manifest/metadata digest;
- `updatePlanDigest`;
- current and proposed module summary;
- container/image changes;
- settings schema changes and setting prompts;
- storage directory and external mount changes;
- dependency changes;
- endpoint/runtime resource changes;
- generated container configuration changes;
- replacement steps;
- warnings and conflicts.

The digest covers the proposed normalized manifest or legacy metadata, dependency tree, computed paths, Docker names, endpoints/runtime configuration, preserved compatible settings/storage decisions, and administrator decisions that affect generated runtime configuration. It must exclude timestamps, transient Docker status, download timing, and read-only Docker conflict observations.

Secret values must never be returned or embedded in a user-visible plan. When a secret decision affects the plan digest, the digest input may include only a redacted presence marker plus stable metadata such as key, type, and target.

## Update Flow

```mermaid
flowchart TD
  A["Installed app"] --> B["Read stored source URL"]
  B --> C["Refresh manifest or legacy metadata JSON"]
  C --> D["Validate schema and same app/module id"]
  D --> E["Build update plan"]
  E --> F["Administrator review"]
  F --> G["Apply with reviewed digest"]
  G --> H["Recompute update plan"]
  H --> I{"Digest matches?"}
  I -- "No" --> J["Reject and require review again"]
  I -- "Yes" --> K["Create pre-update app data backup"]
  K --> L["Set operationStatus=updating"]
  L --> M["Apply dependency changes"]
  M --> N["Pull images by refreshed pullPolicy"]
  N --> O["Replace runtime containers if needed"]
  O --> P["Save manifest/metadata and registries"]
  P --> Q["Set operationStatus=installed"]
```

Failed apps can create an update plan. A failed app always requires container replacement so a repeated same-source install can repair partially created files, images, directories, or Docker containers without manual cleanup first.

## Settings Decisions

Existing settings are preserved only when `key`, `type`, and environment targets are compatible.

- Compatible settings keep their stored typed value.
- New required settings are shown as prompts in the update review UI.
- Removed settings are removed from the generated runtime environment and from the installed record after a successful update.
- Type or target changes require a new value.

Secret settings follow the same compatibility rule, but the current secret value is never shown. If `key`, `type: "secret"`, and target are unchanged, the stored secret value is preserved. If any of those fields change, the update plan prompts for a new write-only value.

## Storage Decisions

Storage mappings are preserved by stable storage key when compatible.

- Existing app-owned host paths remain unchanged for the same storage key.
- New required directories are created during apply.
- Changed container paths, read-only flags, or writable flags are shown in the update plan and applied to the recreated container.
- Removed module-owned directories are not deleted automatically.

External mount collection selections are preserved by collection key and mount key when compatible. The update plan prompts only for new or insufficient required external mounts. External host paths are never deleted by update.

## Pre-update Backup

Before update apply mutates containers, manifests, or registries, the Host attempts to create a `pre-update` backup when the app has a primary data directory.

The backup includes only the primary app data directory:

- preferred path: `apps/<app-id>/data`;
- legacy fallback: installed storage mapping with key `data`;
- secondary fallback: installed storage mapping whose host path ends in `data`.

External mounts and additional storage mappings are not backed up. This is intentional because external mounts can contain very large media libraries or storage devices that Hosty should not archive automatically. Current ZIP creation is in-memory and rejects app data above 256 MiB until a streaming archive writer is implemented.

Backups are ZIP archives with sibling JSON metadata under:

```text
<host-data-root>/backups/<app-id>/
```

If the app has no data directory, update proceeds without creating a backup. If a backup is started and fails, update stops before mutation and records the failure through the normal update error path.

## Dependency Decisions

Dependency changes are applied before recreating the consumer module.

During dependency changes, the update flow:

- installs missing new required dependencies;
- reuses and starts compatible installed dependencies;
- blocks the update when an installed dependency is incompatible, failed, or missing required containers;
- updates the consumer's resolved dependency URLs after dependency changes are applied.

It does not automatically update already installed dependencies just because their own manifest or legacy metadata URL has changed. Recursive dependency update remains a separate explicit update action.

## Container Replacement

The replacement strategy is explicit:

- set the module record to `operationStatus=updating`;
- pull proposed images according to refreshed `pullPolicy`;
- stop/remove existing module containers when runtime configuration must change;
- create/start containers with deterministic container names;
- save refreshed `manifest.json` or legacy `metadata.json`, update `apps.json` for app-oriented records, and update `modules.json` only for legacy records or when preserving an existing legacy store.

If metadata-only changes do not affect images, environment, mounts, endpoints/ports, resources, or network aliases, the update may skip container replacement. If `pullPolicy` is `always`, update pulls and recreates affected containers even when an image reference is unchanged.

Partial failures are optimistic fail-fast. Host records `operationStatus=failed`, keeps `lastError`, and preserves files, directories, images, and containers for explicit administrator recovery.

## Failed Update Retry

Failed install retry and failed update retry do not share ambiguous behavior.

The installed app/module record stores the last operation, reviewed update plan digest, and administrator decisions for a failed update attempt. Update retry is exposed as update-specific behavior. On retry, the Host refreshes the manifest or legacy metadata URL and recomputes the update plan. If the digest still matches, it retries apply; if the digest changed, the administrator must review the update again.

## Web UI

The update review UI uses the dedicated route `/modules/{moduleId}/update`, while reusing install review components where practical.

Installed runtime app rows expose update as an action. Failed updates show retry/update-review recovery actions without treating them as failed installs.

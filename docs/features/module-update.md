# Module update flow

This document describes the implemented MVP behavior for updating installed modules.
Module update is a metadata refresh plus reviewed change plan, not only a Docker image pull.

## Scope

The update flow implements:

- an update plan API for installed modules;
- a reviewed update UI;
- an update apply API;
- explicit retry behavior for failed updates.

Out of scope for the MVP update flow:

- automatic rollback after partial update failure;
- recursive automatic updates of already installed dependencies;
- SemVer range solving or multiple installed versions of the same module id;
- generic settings edit APIs outside the update review flow.

## Update API

The Host uses separate update endpoints:

- `POST /api/modules/{moduleId}/update/plan`
- `POST /api/modules/{moduleId}/update`
- `POST /api/modules/{moduleId}/update/retry`

The plan endpoint reads the installed module record from `modules.json` and refreshes the stored `metadataUrl`. The MVP update API does not accept a replacement metadata URL during update. Changing the metadata URL is a separate future source-management action.

The apply endpoint recomputes the update plan from the installed record, refreshed metadata, and submitted administrator decisions. It rejects the request when the reviewed `updatePlanDigest` no longer matches the recomputed plan.

The retry endpoint is only for failed update attempts. Failed installs continue to use `POST /api/modules/{moduleId}/retry`.

## Plan Shape

`ModuleUpdatePlan` is a separate type, not a reused `InstallPlan`. It reuses install planner internals where practical, but update review needs both the current installed state and the proposed refreshed state.

The plan includes:

- `moduleId`;
- stored `metadataUrl`;
- current local metadata digest;
- refreshed metadata digest;
- `updatePlanDigest`;
- current and proposed module summary;
- image changes;
- settings schema changes and setting prompts;
- storage directory and external mount changes;
- dependency changes;
- runtime port/resource changes;
- generated container configuration changes;
- replacement steps;
- warnings and conflicts.

The digest covers the proposed normalized metadata, dependency tree, computed paths, Docker names, runtime configuration, preserved compatible settings/storage decisions, and administrator decisions that affect generated runtime configuration. It must exclude timestamps, transient Docker status, download timing, and read-only Docker conflict observations.

Secret values must never be returned or embedded in a user-visible plan. When a secret decision affects the plan digest, the digest input may include only a redacted presence marker plus stable metadata such as key, type, and target.

## Update Flow

```mermaid
flowchart TD
  A["Installed module"] --> B["Read stored metadata URL"]
  B --> C["Refresh metadata JSON"]
  C --> D["Validate schema and same module id"]
  D --> E["Build update plan"]
  E --> F["Administrator review"]
  F --> G["Apply with reviewed digest"]
  G --> H["Recompute update plan"]
  H --> I{"Digest matches?"}
  I -- "No" --> J["Reject and require review again"]
  I -- "Yes" --> K["Set operationStatus=updating"]
  K --> L["Apply dependency changes"]
  L --> M["Pull image by refreshed pullPolicy"]
  M --> N["Replace module container if needed"]
  N --> O["Save metadata.json and modules.json"]
  O --> P["Set operationStatus=installed"]
```

## Settings Decisions

Existing settings are preserved only when `key`, `type`, and environment target are compatible.

- Compatible settings keep their stored typed value.
- New required settings are shown as prompts in the update review UI.
- Removed settings are removed from the generated runtime environment and from the installed record after a successful update.
- Type or target changes require a new value.

Secret settings follow the same compatibility rule, but the current secret value is never shown. If `key`, `type: "secret"`, and target are unchanged, the stored secret value is preserved. If any of those fields change, the update plan prompts for a new write-only value.

## Storage Decisions

Storage mappings are preserved by stable storage key when compatible.

- Existing module-owned host paths remain unchanged for the same storage key.
- New required directories are created during apply.
- Changed container paths, read-only flags, or writable flags are shown in the update plan and applied to the recreated container.
- Removed module-owned directories are not deleted automatically.

External mount collection selections are preserved by collection key and mount key when compatible. The update plan prompts only for new or insufficient required external mounts. External host paths are never deleted by update.

## Dependency Decisions

Dependency changes are applied before recreating the consumer module.

During dependency changes, the update flow:

- installs missing new required dependencies;
- reuses and starts compatible installed dependencies;
- blocks the update when an installed dependency is incompatible, failed, or missing its container;
- updates the consumer's resolved dependency URLs after dependency changes are applied.

It does not automatically update already installed dependencies just because their own metadata URL has changed. Recursive dependency update remains a separate explicit update action.

## Container Replacement

The MVP replacement strategy is simple and explicit:

- set the module record to `operationStatus=updating`;
- pull the proposed image according to refreshed `pullPolicy`;
- stop/remove the existing module container when runtime configuration must change;
- create/start a container with the same deterministic container name;
- save refreshed `metadata.json` and updated `modules.json` only after successful apply.

If metadata-only changes do not affect image, environment, mounts, ports, resources, or network aliases, the update may skip container replacement. If `pullPolicy` is `always`, update pulls and recreates the container even when the image reference is unchanged.

Partial failures are optimistic fail-fast. Host records `operationStatus=failed`, keeps `lastError`, and preserves files, directories, images, and containers for explicit administrator recovery.

## Failed Update Retry

Failed install retry and failed update retry do not share ambiguous behavior.

The installed module record stores the last operation, reviewed update plan digest, and administrator decisions for a failed update attempt. Update retry is exposed as update-specific behavior. On retry, the Host refreshes the metadata URL and recomputes the update plan. If the digest still matches, it retries apply; if the digest changed, the administrator must review the update again.

## Web UI

The update review UI uses the dedicated route `/modules/{moduleId}/update`, while reusing install review components where practical.

Installed module rows expose update as an action for installed modules. Failed updates show retry/update-review recovery actions without treating them as failed installs.

## Test Bar

Focused tests cover:

- update plan digest stability and mismatch handling;
- same-module-id validation;
- settings preservation and prompts for new required settings;
- secret redaction and preservation rules;
- storage mapping preservation and new directory planning;
- external mount compatibility and required mount prompts;
- dependency conflicts and missing dependency installation;
- apply failure marking `operationStatus=failed`;
- update retry routing and digest mismatch behavior.

Use mocked Docker boundaries for apply/retry tests and keep manual Docker verification for the full install-update-remove flow.

## Open Questions

No MVP update flow questions remain open.

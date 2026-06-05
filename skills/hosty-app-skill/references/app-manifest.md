# App Manifest Reference

Use this reference when authoring or reviewing Hosty runtime app manifests, storage, settings, dependencies, endpoints, install/update behavior, or app data backups.

## Sources Of Truth

- `docs/features/runtime-app-manifest.md`
- `docs/features/hosty-runtime-app-platform.md`
- `apps/core/src/Haas.Hosty.Core/RuntimeAppManifest.cs`
- `apps/demo-app/manifest.json`

## Required Contract

- `schemaVersion` must be `app.0.1`.
- Store repository-local manifests as `apps/{app-name}/manifest.json`.
- Define one or more runtime profiles.
- Define one or more services.
- Define endpoints for service access.
- Define `ui.entrypoint` when the app has a Shell UI.

## Runtime Environment

Core injects:

- `HOSTY_APP_ID`
- `HOSTY_APP_SERVICE_KEY`
- `HOSTY_APP_SERVICE_TOKEN`
- `HOSTY_CORE_ORIGIN`
- `HOSTY_APP_DATA_DIR`
- `HOSTY_PORT_{KEY}`
- `HOSTY_DEPENDENCY_{KEY}_URL`

## Storage And Backups

Use `data.enabled: true` when the app needs a primary persistent data directory. Backups cover that primary app data directory only.

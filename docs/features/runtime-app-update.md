# Runtime App Update

## Description

Runtime app updates are reviewed changes from the currently installed `app.0.1` manifest to a new manifest, channel result, or source snapshot. Core owns the update plan, digest, backup, apply, and failure state.

## Update Flow

1. Core loads the installed app record and current manifest.
2. Core resolves the target manifest or source snapshot.
3. Core creates an update plan with changed services, images, settings, endpoints, storage, dependencies, and capabilities.
4. The caller applies the reviewed plan by passing the plan digest.
5. Core creates a `pre-update` backup when the app has a primary data directory.
6. Core applies runtime changes and records the final lifecycle state.

## CLI

```bash
hosty apps update-plan <app-id> --manifest apps/demo-app/manifest.json
hosty apps update <app-id> --plan-digest <digest> --manifest apps/demo-app/manifest.json
```

## Failure Behavior

Failed updates leave enough state for diagnosis and retry. Runtime state and app data are not deleted automatically. Restore uses normal app backup restore behavior.

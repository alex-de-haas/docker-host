# Runtime App Manifest

## Description

Hosty installs user workloads from an app manifest with `schemaVersion: "app.0.1"`. The manifest is the only supported install contract for new local development, tests, and runtime app lifecycle work. Legacy Docker metadata files are not part of the current workflow.

## Manifest Location

Repository-local apps should keep the manifest at:

- `apps/{app-name}/manifest.json`

The Demo App uses:

- `apps/demo-app/manifest.json`

Install it locally through Core:

```bash
hosty core start
hosty apps install apps/demo-app/manifest.json --runtime dev
hosty apps start com.haas.demo-app
```

## Required Fields

- `schemaVersion` - must be `app.0.1`.
- `id` - stable reverse-DNS app id.
- `name` - display name shown by Shell and CLI.
- `version` - app version.
- `runtimeProfiles` - supported runtime profiles such as `docker` and `localCommand`.
- `services` - one or more services and their runtime-specific implementation.
- `endpoints` - externally visible or internal service endpoints.
- `ui` - Shell entrypoint and navigation metadata when the app has UI.

## Runtime Profiles

`docker` profiles run service images through Docker. `localCommand` profiles run repository-local commands under Core supervision. Core injects app environment such as:

- `HOSTY_APP_ID`
- `HOSTY_APP_SERVICE_KEY`
- `HOSTY_APP_SERVICE_TOKEN`
- `HOSTY_CORE_ORIGIN`
- `HOSTY_APP_DATA_DIR`
- `HOSTY_PORT_{KEY}`
- `HOSTY_DEPENDENCY_{KEY}_URL`

## Source

`source` is optional app-level metadata that describes where Core can obtain the app source when a runtime needs it.

For `docker` runtime profiles, Core starts the declared image and does not need source checkout state.

For `localCommand` runtime profiles, Core resolves a source root before starting services:

- local manifest path installs use the local worktree that contains the manifest, without cloning `source.repository`;
- HTTP(S) manifest URL installs require `source.repository` to be an absolute clonable Git URL or local repository path;
- administrator `source-override` state takes priority over both local inference and managed checkouts.

Relative source repositories such as `.` are only meaningful for local manifest path installs. They are rejected when starting a `localCommand` runtime from a remote manifest URL.

## Storage

When `data.enabled` is true, Core creates a primary app data directory:

```text
<HOSTY_HOME>/apps/<app-id>/data/
```

Backups cover only this primary app data directory. External mounts and dependency-owned data are outside the backup scope.

## User Directory

Runtime apps can read their scoped app directory through Core:

```text
GET /api/internal/apps/{appId}/directory/users
Authorization: Bearer <HOSTY_APP_SERVICE_TOKEN>
```

The response includes enabled Host users explicitly assigned to that app.

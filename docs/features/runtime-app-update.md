# Runtime App Update

## Description

Runtime app updates are reviewed changes from the currently installed `app.0.1` manifest to a new manifest, channel result, or source snapshot. Core owns the update plan, digest, backup, apply, and failure state.

## Update Flow

1. Core loads the installed app record and current manifest.
2. Core resolves the target manifest or source snapshot.
3. Core creates an update plan with changed version, runtime, services, images, commands, ports, environment keys, settings, endpoints, storage, dependencies, and capabilities.
4. The caller applies the reviewed plan by passing the plan digest.
5. Core creates a `pre-update` backup when the app has a primary data directory.
6. Core applies runtime changes and records the final lifecycle state.

## Digest Semantics

`manifestDigest` is the SHA-256 of the exact manifest JSON text loaded from a local manifest file, local app directory, `file://` URL, or HTTP(S) URL. For a locally installed `dev` runtime app, Core hashes the manifest JSON, not the app source folder or local command working directory. If an update request does not provide a manifest reference, Core resolves the source in this order: the stored manifest URL for remote installs; otherwise the original local manifest path or directory captured at install (so edits to the source folder are picked up on recheck); and finally the installed manifest copy under the app's Core state directory when that original source is no longer present.

`planDigest` is the SHA-256 of the reviewed update plan seed: app id, current and target versions, current and target runtimes, target channel, current and target manifest digests, whether a pre-update backup will be created, and the reported changes. Update apply recomputes the current plan and rejects stale input when the supplied plan digest no longer matches.

## Changes

The `changes` list is a human-review summary of the update plan. Core reports specific contract changes when it can classify them, such as `version`, `runtime`, `service`, `image`, `command`, `port`, `environment`, `setting`, `endpoint`, `data`, `dependency`, and `capability` changes. When the target manifest digest differs but none of those contract categories changed, Core reports `manifest` as a fallback meaning "manifest content changed." A recheck against the same installed manifest returns an empty `changes` list.

## CLI

```bash
hosty apps update-plan <app-id> --manifest apps/demo-app
hosty apps update <app-id> --plan-digest <digest> --manifest apps/demo-app
```

## Failure Behavior

Failed updates leave enough state for diagnosis and retry. Runtime state and app data are not deleted automatically. Restore uses normal app backup restore behavior.

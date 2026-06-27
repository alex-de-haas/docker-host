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

## Live Source Runtimes

A reviewed update does not apply to a **live source** runtime: an app whose selected runtime is a source artifact (`localCommand` in v1) running from the operator's own folder (a `source-override`, or the original folder install) with no recorded manifest URL. For these the manifest is the operator's own contract and is re-read, validated, and adopted on each start — there is no trust boundary to gate, so changes take effect on restart rather than through an update plan (see [Runtime App Marketplace](../ideas/runtime-app-marketplace.md), "Live source").

Core reports this on the app summary as `live: true`. Clients mark the runtime **Live** and hide the Update affordance; it returns when the operator switches to a compiled (Docker) runtime. When no explicit manifest reference is supplied, `update-plan` for a live source app is refused with `update_live_source_runtime` instead of re-reading and validating the (possibly mid-edit) folder manifest. Passing an explicit `--manifest` path or URL remains available as an escape hatch for an out-of-band comparison. A URL/publisher install is never live source: its code may run live, but its manifest **contract** is still reviewed on change.

## CLI

```bash
hosty apps update-plan <app-id> --manifest apps/demo-app
hosty apps update <app-id> --plan-digest <digest> --manifest apps/demo-app
```

## Failure Behavior

Failed updates leave enough state for diagnosis and retry. Runtime state and app data are not deleted automatically. Restore uses normal app backup restore behavior.

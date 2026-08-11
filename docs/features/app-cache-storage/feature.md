# Feature: App Cache Storage

Created: 2026-08-11
Updated: 2026-08-11

Runtime apps can declare a Core-managed **cache** directory beside `data`: persistent
across restarts, updates, and runtime switches, but never part of a backup or a
restore. It exists for derived, rebuildable data — media indexes, transcode output,
downloaded artwork — that would otherwise inflate every backup, including the
automatic pre-update snapshot taken while the app is stopped, where the cost is paid
in downtime.

## Contract

The manifest block mirrors `data` (same shape, same manifest type), additive under
`app.0.1`:

```jsonc
"cache": {
  "enabled": true,
  "targets": [
    { "runtime": "docker", "service": "api", "containerPath": "/app/cache", "environment": "HOSTY_APP_CACHE_DIR" },
    { "runtime": "dev", "environment": "HOSTY_APP_CACHE_DIR" }
  ]
}
```

- **Host location**: `<HOSTY_HOME>/apps/<app-id>/cache/`, a sibling of `data/`. The
  placement is the entire backup-exclusion mechanism: `AppBackupService` archives
  and restores the data path only, so neither knows caches exist.
- **Selection** (`AppManifestService.LoadAsync`): the target matching the selected
  runtime profile's key or type is picked; under a `docker` profile with no match,
  a default is synthesized — `/app/cache` on the first service, announced as
  `HOSTY_APP_CACHE_DIR`. There is no synthesis for other profile types.
- **Docker runtime**: the cache path is bind-mounted at the target's container path
  and the environment variable carries that container path.
- **localCommand/dev runtimes**: `cache.enabled: true` alone (no target needed)
  injects `HOSTY_APP_CACHE_DIR` with the host path and creates the directory.
  Unlike `data`, whose variable is injected unconditionally, the cache variable
  exists only for apps that declared it.
- **App record**: a `cache` storage mapping is stored beside `data`, and
  install/update/runtime-switch plans diff both keys the same way
  (`cache:added:…`, `cache:target:…->…`, `cache:removed:…`). The mapping exists
  for the `enabled`-only localCommand form too — no container anywhere, so its
  target path is the host path itself; record and plan diffs resolve it through
  one `EffectiveCacheTargetPath`, so they cannot disagree with the adapter.

## Lifecycle

- Restart, update, runtime switch: the directory is untouched.
- A runtime switch to a profile without a cache target is **not** an error (there
  is no analogue of `runtime_switch_data_incompatible`): the app runs without the
  variable there. A cache is rebuildable by contract, so there is nothing to
  protect.
- Removal follows the data directory's fate: deleted when the operator removes the
  app with its data, kept when data is kept. A cache is typically keyed by
  identities in the app's own database, which lives in data; destroying one without
  the other either forces a pointless rebuild or retains orphaned bytes.
- Restore replaces `data/` only, which can leave the cache newer than the restored
  database. That is fine by contract: **the app must treat cache content as
  absent-or-stale-at-any-time** — the same property that makes never backing it up
  safe. Apps should stamp entries so stale ones invalidate themselves.
- A Core predating the contract never sets the variable; apps are expected to fall
  back (typically to a subdirectory of `HOSTY_APP_DATA_DIR`).

The first consumer is media-server's remux index store (media-server
`docs/features/cache-storage/`).

## Testing Expectations

- Manifest selection: docker default synthesis, explicit target selection, and the
  null cases (absent, disabled, non-docker without target) —
  `AppManifestServiceTests`.
- Docker adapter: the `run` arguments carry the cache bind and environment
  variable — `DockerRuntimeAdapterTests`.
- localCommand adapter: the variable and directory appear when cache is declared
  and do not otherwise — `LocalCommandRuntimeAdapterTests`.
- Lifecycle: install creates the directory and stores the `cache` mapping; removal
  keeping data preserves the cache; removal with data deletes it —
  `CoreLifecycleServiceTests`.
- Backup: the archive contains no cache content and a restore leaves the cache
  untouched — `AppBackupServiceTests`.

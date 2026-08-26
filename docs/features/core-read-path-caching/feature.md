# Core Read-Path Caching

Created: 2026-08-25
Updated: 2026-08-25

Core's hottest read paths serve parsed in-memory state instead of re-reading and
re-parsing their backing files on every call. Three caches exist, all built on
one invariant — each store is the only writer of its file inside the process —
plus one shared guard, `FileStamp` (`JsonStorage.cs`): the (exists, mtime,
length) identity of the on-disk document, checked on every read so a change made
behind the cache (an out-of-band edit, the uninstall path's direct `state.json`
delete) turns into a plain re-read rather than a stale serve. A read that races
a write can at worst cache fresh content under a stale stamp; the next read sees
the mismatch and re-reads, so no cache ever serves stale state past one
self-healing round trip.

## The three caches

- **`UserDirectoryStore`** keeps the parsed `UserDirectoryState` in a `volatile`
  field. Every write funnels through the store's gate and replaces the cache
  with the state it just persisted, so revocation lands in the cache in the same
  call that lands it on disk — session resolution (the front door of every
  authenticated request), MCP auth, introspection, and revalidation no longer
  touch disk in steady state, and the instant-revocation property is unchanged.
- **`AppRegistryStore`** keeps parsed `AppRecord`s in a `ConcurrentDictionary`
  keyed by app id. Writes invalidate rather than populate, so the read path's
  `Migrate` + `HydrateAppUiAsync` projections remain the only code that shapes a
  served record; the hydration result is cached with the record, so the legacy
  UI backfill runs once per record per process instead of on every read.
  Removal evicts; the direct `state.json` delete on the uninstall path is
  covered by the stamp.
- **`AppManifestService`** caches the parsed manifest (JSON text, SHA-256
  digest, deserialized object) per resolved local file path. `Select` still
  runs per call — its outcome depends on the requested runtime, and it is the
  validation whose errors callers expect fresh. URL manifests are never cached:
  they are install/update-time fetches that must observe the remote's current
  bytes. Keys are operator-driven manifest paths, a bounded set, so there is no
  eviction.

## The list path serves persisted state

`CoreLifecycleService.ListAppsAsync` (behind `GET /api/apps` and every other
fleet listing) reads the registry once and builds summaries from that snapshot —
no manifest loads, no runtime-context builds, and no live health probes on the
read path. Runtime-state freshness comes from the supervisor
(`RuntimeAppSupervisorService`, 15 s interval), whose observation pass covers
both runtimes, persists `RuntimeState` flips, and publishes `app.changed` on
each one; lifecycle verbs persist their own transitions synchronously, so
operator actions are visible immediately. The list is therefore at most one
supervision interval stale on states that changed behind Core's back, and a hung
app's healthcheck can no longer stall the list for every client.
`GET /api/apps/{id}/health` remains the live-probe surface.

Within a single identity call, state resolved once is passed through rather than
re-read: `AppIdentityService.RequireAccessibleUser` is the static policy core,
with async overloads for callers that hold nothing, the directory state, or both
the state and the app record (introspection, on-behalf-of).

## Testing Expectations

- `UserDirectoryStoreTests`: a repeated read serves the same instance (the
  cache, not a re-parse); an out-of-band rewrite of `auth/state.json` is
  observed by the next read; an `UpdateAsync` is visible to the next read.
- `AppRegistryStoreTests`: a repeated `GetAppAsync` serves the same instance; a
  store write invalidates; an out-of-band `state.json` delete is observed by
  both `GetAppAsync` and `ListAppRecordsAsync`; the v1 migration test doubles as
  the out-of-band rewrite guard (it writes `state.json` directly and re-reads
  through the same store instance).
- `CoreLifecycleServiceTests`: `ListAppsAsync` serves persisted state without
  probing (a stale `running` survives the list read), and the supervisor's
  `ObserveRuntimeHealthAsync` pass is what reconciles it; the docker drift
  sweep and lock-skip behavior keep their existing coverage.
- Auth/session/introspection suites exercise revoke-then-request sequences
  against the cached store, proving revocation still takes effect immediately.

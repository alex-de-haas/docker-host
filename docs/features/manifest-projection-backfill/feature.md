# Manifest Projection Backfill

Created: 2026-08-09
Updated: 2026-08-09

A Core upgrade heals installed app records without operator action. Records only re-run
manifest→record normalization at install, update, runtime switch, or a live-source start, so an app
installed under an older Core permanently lacked any manifest section that build's parser did not
know. The 2026-08-09 AI Gateway rollout hit exactly this: `hosty.ai-gateway` was installed while
Core 0.73.1 ran, the new `interfaces` block was silently dropped from the record, and Shell's
assistant discovery found nothing until a manual same-version reviewed update rebuilt it. Since Core
0.74.1 that class of gap closes itself at the next boot.

## One projection choke point

`CoreLifecycleService.ApplyManifestProjections` is the single place the pure manifest→record
denormalizations happen: capabilities, `provides`, dependencies, UI contract, catalog metadata,
`interfaces`, runtime profiles, and external-mount slots. Three paths funnel through it:

- **`BuildAppRecord`** — install, update apply, runtime switch, rollback.
- **`ReconcileLiveContractAsync`** — live-source adoption at start/restart. This previously copied
  projections through a hand-maintained field list, which is how `Interfaces` silently never reached
  a live adoption; the list is gone.
- **`BackfillManifestProjectionsAsync`** — the boot backfill below.

A future additive manifest section needs one line in the choke point to reach all three paths.
Endpoints, settings, and storage mappings deliberately stay in `BuildAppRecord`: they need the
runtime selection and existing-record carry-forward, not just the manifest.

## The stamp

Every run of the projections stamps `AppRecord.NormalizedBy` with the running platform version
(`CoreStatusResponse.PlatformVersionString`). The stamp answers one question: did the build whose
parser produced this record's projections differ from the build now running? Null on records written
before the stamp existed, which therefore backfill once. Additive/nullable — no
`AppStateDocument` schema bump, and the stamp is internal to `state.json` (not projected onto
`AppSummary`).

## The boot backfill

`BackfillManifestProjectionsAsync` runs in the supervisor's boot sequence after system-app seeding
and before autostart reconciliation (start ordering reads `Provides`). For every runtime record
whose `NormalizedBy` differs from the running build, it re-reads the app's reviewed internal
manifest copy (`apps/<id>/manifest.json`, or the recorded manifest path) with a raw read — the same
shape as the registry's UI hydration; the copy was validated when it was written — and re-runs the
projections under the per-app record lock. The heal persists the stamp, so it runs once per record
per Core build.

Properties:

- **Operator state is untouched by construction.** The choke point only rewrites pure manifest
  denormalizations; setting values, mount bindings, artifact locks, feed state, port reservations,
  autostart, and lifecycle state are never rebuilt by the backfill.
- **Steady-state boots are free.** A record stamped by the running build is skipped without a
  manifest read or a `state.json` write.
- **Failure is retried, not stamped.** A missing or unreadable manifest copy (or an id mismatch)
  skips the record un-stamped, so a later boot retries; the whole step is best-effort and never
  aborts boot.
- **Live-source apps may briefly show the reviewed contract.** A stale live app is backfilled from
  its last-good internal copy; the next start re-adopts the live folder manifest as always (adoption
  rewrites the internal copy, so the two never drift apart at rest).

## Testing Expectations

- `CoreLifecycleServiceTests`: install stamps `NormalizedBy` with the running build; the backfill
  heals a record stripped of `Interfaces` and its stamp (the older-Core shape) while preserving
  operator setting values and the version; a record stamped by the running build is skipped without
  a rewrite (`UpdatedAt` unchanged); a missing manifest copy skips without stamping so a later boot
  retries; a live-source adoption carries an `interfaces` block added to the folder manifest.

## Related

- [ai-gateway](../ai-gateway/feature.md) — the rollout that motivated this; its discovery gating
  consumes the healed `interfaces` projection.
- [automatic-runtime-app-ports](../automatic-runtime-app-ports/feature.md) — `PortAssignmentMigration`,
  the boot-backfill precedent this follows (durable Core-owned state, so it derives rather than
  re-projects).

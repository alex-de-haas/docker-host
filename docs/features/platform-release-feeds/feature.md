---
created: 2026-11-03
updated: 2026-11-06
summary: Shared Core and CLI release feeds, paired bootstrap, reviewed source selection and recoverable native updates.
components: [apps/core, apps/cli, apps/shell]
---

# Platform Release Feeds

Core and CLI resolve a platform release together. Feed names are opaque, case-sensitive publisher
IDs; daily and stable are distribution configuration. Applications keep their own independent feed
bindings. Core works with an empty application registry and without Shell or Marketplace.

## Metadata and selection

`hosty-platform-feeds.0.1` lists `{id, releaseRef, releaseSha256, default?}` entries. One entry is an
implicit default; multiple entries require one declared default or an explicit choice. IDs must be
unique, nonempty, at most 128 characters, without controls or surrounding whitespace. A platform
descriptor uses `hosty-platform-release.0.1` and names an immutable release, shared version, full
source commit and both CLI/Core artifacts for each supported RID. Hash, size and role validation
precedes executable replacement. Unknown contracts, removed feeds and inaccessible metadata fail
explicitly; resolution never silently chooses another feed.

Each data root stores `core/update-source.json` with the index reference, selected feed and source
revision. A changed publisher default does not change an existing selection. Installed receipts and
accepted operations separately retain the exact release. Explicit pins remain pins.

```sh
hosty --data-root /absolute/instance core feed
hosty --data-root /absolute/instance core feed Candidate --index https://publisher.example/platform/feeds.json
hosty --data-root /absolute/instance update --list-feeds
hosty --data-root /absolute/instance update
hosty --data-root /absolute/instance update --feed Reviewed
```

`--channel` and `--list-channels` remain aliases. Conflicting selections fail. No-argument update
uses the saved source. `core feed` selects without installing or restarting. `update --feed` saves
the deliberate choice even if later artifact preparation fails. An explicit CLI `--index` supports
a local file or HTTPS document; production resolution does not search the caller's working directory.
The unversioned product index is compatibility input only when explicitly selected.

Core exposes admin `GET/PUT /api/core/update-feed`, `GET /api/core/update-status`,
`POST /api/core/update` and `GET /api/core/updates/{id}`. Selection uses an expected source revision.
Shell presents it under Host → Updates. Delegated clients need `core.read` for inspection and
`core.configure` for selection, with Core-owned operator confirmation for the exact source change.
Applying an update needs `core.update`, an exact offer ID and a retained UUID request ID. Routine
read authority never authorizes source selection or lifecycle changes.

## Bootstrap and compatibility

Unix/PowerShell installers accept `--feed`/`-Feed` and `HOSTY_INSTALL_FEED`. They resolve once,
verify the CLI asset and save the selected feed plus exact paired descriptor in a bootstrap receipt.
The first missing-Core installation uses the Core paired with that CLI even if the feed has moved.
An unseeded default fails before replacing installed files. Explicit repository overrides retain
their own index; explicit tags use compatibility pins. Feed-plus-tag ambiguity is rejected.

The official distribution's legacy main/cli-dev selection migrates to daily only through verified
bridge provenance. The importer preserves a backup and durable receipt and does not leave competing
active selection files. Unknown/custom repositories, tags, indexes and malformed legacy records
require an explicit operator choice. Fresh bootstrap receipts distinguish a new default installation
from a legacy no-config installation. The official 0.172.0 bridge is frozen to release
`34349ded0196466e0579f4ed5c0414fa41b63dd73fcee1ceee5ecd9ec476c725`; its
[retained receipt](https://raw.githubusercontent.com/alex-de-haas/docker-host/app-releases/platform/bridge.json)
records the cutoff and verified descriptor. An old client first installs this pair through cli-dev;
the new reader imports daily when it next resolves an implicit update source. The initial daily
and stable platform entries both reference this complete release. The
[publisher workflow](../repository-release-model/feature.md#first-publication-and-existing-installations)
describes promotion and retention.

## Preparation and recovery

Before stopping Core or replacing either executable, update stages and verifies both artifacts and
the previous executable backups. A missing/corrupt counterpart leaves the running Core and CLI
untouched. The per-root launch lock and shared CLI executable lock serialize competing operations.
Core accepts UI updates under the launch lock and saves the frozen request before releasing that
lock and starting the detached CLI helper. Initial requests and retries use the same handoff, so
the helper can acquire the lock during Windows startup probing. The saved acceptance continues
blocking unrelated lifecycle and source changes. A failed helper launch preserves that acceptance
for recovery without overwriting a running helper's journal or a completed receipt.
The durable `core/platform-update.json` journal records the exact source/descriptor, request ID,
original launch identity and each replacement step. Recovery with `hosty update` uses those retained
bytes and never resolves a newer release from a moving feed. A source or installation change at
the replacement boundary is refused.

The restart preserves the factual listener, public origin and runtime host. A running release Core
uses keep-apps stop and a prepared restart, then verifies a new process-start identity, release
version and readiness. A stopped Core stays stopped. A source/dev Core keeps its factual project
running while only installed release artifacts change. Independent data roots keep their own Core
and feed state even when they share the CLI executable.

Two executable replacements are not an atomic filesystem transaction. Recoverable failures before
target launch restore only transaction-owned previous bytes; partial/restart failures retain the
journal and report failure. Once the new Core may have migrated data, no automatic binary/data
rollback occurs. Recovery uses the original operation ID. App-data rollback belongs to the separate
[recovery plan](../runtime-app-update-recovery/plan.md).

The Core NativeAOT matrix also runs `scripts/check-platform-native-update.py` on each supported
RID. It uses the checked native Core, a freshly published native CLI and lower-version managed
apphost fixtures in an isolated root. The fixture completes normal setup/password login, verifies
corrupt-counterpart preservation, replaces both distinct executables through frozen recovery,
checks native process readiness and listener continuity, and preserves stopped state after feed
selection. Temporary users, executables and data are removed after verified process shutdown.

## Testing Expectations

- Exercise arbitrary feed IDs/counts/defaults, saved selection, removed/default-changed feeds,
  explicit legacy inputs, bootstrap pairing and exact legacy provenance migration.
- Reject stale source revisions and offers, unauthorized delegated callers and missing CSRF;
  source selection has no lifecycle or app-feed side effect.
- Verify initial and retried UI updates release the actual launch lock before helper startup while
  retaining the frozen acceptance and blocking unrelated operations. Check launch-failure recovery,
  completed/conflicting replay and preservation of helper progress during error reporting.
- Check corrupt second assets, interrupted replacements, failed stop/start/readiness, frozen replay,
  shared CLI locks and stopped/dev modes. Verify the listener and a new ready process on native OSes.
- Verify all eight published artifacts and hashes; test interrupted upload and no-build promotion.

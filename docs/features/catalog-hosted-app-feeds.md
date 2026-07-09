# Catalog-Hosted App Feeds

Status: **Design confirmed 2026-07-09** (A1–A3 below, from a design discussion
after a real delivery failure — see Motivation). Implementation not started.
Created: 2026-07-09

## Motivation

The author-hosted version feed (`releases.json`, defined in
[runtime-app-marketplace.md](runtime-app-marketplace.md) — "Schemas (Sketch)",
shipped as WS1) pins every version's `manifestRef` to a **commit**. Delivering any change
to installed apps therefore requires a per-release, hand-maintained dance:
bump `version` in `manifest.json`, push, take the new commit hash, append a
`versions[]` entry, move `tags.stable`, push again. Forgetting any step — most
commonly the version bump, which agents and humans alike skip — silently
breaks delivery: the author believes they shipped, the operator sees no
update, and re-applying the same version faithfully re-reads the same frozen
commit.

Real incident (2026-07-09): project-manager PR #21 (sidebar nav icons via
`ui.navigation[].iconAsset`) landed on `main`, but the install stayed pinned
to commit `6e70930` / version `0.5.0` — the feed still declared
`stable = 0.5.0`, so no update was ever offered and the icons never arrived.

Three design-level problems compound this:

- **Badge and apply disagree.** `CatalogService` computes `UpdateAvailable` by
  version-**string** compare (`stable != installedVersion`), while the
  reviewed update plan compares manifest/artifact **digests**. The marketplace
  doc's "Update-available detection (read-only)" section already specifies
  digest compare against the lock — the string compare is an implementation
  gap, and it makes content changes under an unchanged version string
  undetectable from the catalog surface.
- **The pin contradicts the repo model.** A git repo carries exactly one
  `manifest.json` per app; there is no per-version manifest other than by
  commit archaeology. Git-branch installs and live-source dev installs are
  already content-driven (fetch → digest compare) and cause none of these
  problems; the pinned feed is the odd one out.
- **The feed file is misplaced.** `releases.json` was moved into the app repo
  because versions changed on every release. Once per-release churn is gone
  (below), the feed is pure marketplace data with no reason to live beside the
  app's code — it belongs back in `hosty-catalog`, next to the entry it
  serves.

## Current Behavior

- Feed schema (`hosty-catalog/schema/feed.schema.json`): `versions[]` (each
  `version` + commit-pinned `manifestRef` + optional `artifact`) and
  `tags{stable, beta}`.
- Catalog entry (`apps/<id>/entry.json`): `releasesUrl` points at the
  app-repo-hosted `releases.json`.
- `CatalogService.GetAppAsync`: `updateAvailable = stable != installedVersion`
  (ordinal string compare). No digest input.
- Install-from-catalog stamps `app.ManifestUrl` with the resolved version's
  `manifestRef` — a frozen commit URL. Every later recheck re-reads that
  frozen manifest, so "Check for updates" against an unmoved feed is a
  permanent no-op.

## Design

### A1 — Feeds move into the catalog entry; a feed is a moving ref

`entry.json` gains a `feeds` section and drops `releasesUrl`; the standalone
feed file and `feed.schema.json` are removed:

```json
{
  "id": "com.haas.project-manager",
  "publisher": { "name": "Haas", "url": "https://github.com/alex-de-haas" },
  "feeds": [
    { "id": "main", "manifestRef": "https://raw.githubusercontent.com/alex-de-haas/project-manager/main/manifest.json" }
  ],
  "signerIdentity": "github.com/alex-de-haas/project-manager"
}
```

- A **feed** is a named pointer at a **moving manifest ref** — a branch raw
  URL for git-backed apps; for repo-less OCI apps a hosted manifest whose
  image tag rolls (the artifact-digest compare covers that axis). Feed ids are
  author-defined (`main`, `beta`, …); a single-feed app declares exactly one.
- The entry — and therefore the catalog PR — changes **only when feed
  topology changes**, effectively never. Releasing = pushing to the branch.
  Zero per-release author action: the goal the marketplace doc already names
  (deferred Q8) reached without tag enumeration.
- **Feed quality is the author's responsibility.** A broken `main` cannot ship
  a docker-runtime update anyway (the image build fails; only the last
  successfully published image is pullable), and source runtimes are gated by
  the author's CI at PR time. Rollback is the natural git answer: the author
  reverts the branch, the head digest changes, and the "rollback" surfaces as
  a normal update offer. No operator-side pinning machinery.

### A2 — Version is informational; detection is digest-aware

- `manifest.json`'s `version` is display metadata: the update plan shows a
  delta when the author bumped it ("0.5.0 → 0.5.1") and falls back to the
  existing `manifest` / `image` change categories (runtime-app-update.md,
  "Changes") when content moved under an unchanged version. A forgotten bump
  degrades a changelog line, never delivery.
- Update-available implements the detection the marketplace doc already
  specifies: fetch the followed feed's manifest head (one small file), light
  artifact lookup (`docker manifest inspect` / `git ls-remote`) where a lock
  exists, then `UpdateAvailable` = manifest digest differs OR artifact digest
  moved. No version-string input anywhere.
- Apply is unchanged: the one reviewed-update path (plan → operator confirms
  plan digest → backup → apply). Feeds never auto-apply — the operator decides
  *when*; the feed head decides *what*. Manifest-by-URL asset vendoring
  (manifest-level-app-assets.md D1) composes unchanged: the branch URL base is
  the asset root, re-vendored on each applied update.

### A3 — Explicit feed selection; no compatibility layer, no migration

No legacy dual-format support and no automatic migration of existing installs.
Instead the feed reference becomes explicit operator-visible state:

- **Install** records which feed the app came from (catalog source + entry id
  + feed id). With one declared feed it is preselected; with several the
  installer chooses.
- **Runtime app settings** gain a feed selector: the operator can re-point an
  installed app at any feed the entry declares.
- **Check-updates without a usable feed** — an install that predates feeds, or
  whose recorded feed no longer exists in the catalog (entry removed or feed
  id renamed) — surfaces "no feed set — choose one in this app's settings"
  instead of pretending the app is up to date. That prompt *is* the migration
  path for existing installs: one explicit selection, no compat code.
- Non-catalog installs (folder, git URL, live source) keep their existing
  content-driven behaviors; feeds are a catalog concept only.

## Data Model / API Changes

- **hosty-catalog**: `entry.schema.json` + `feeds[]` (id, manifestRef),
  − `releasesUrl`; delete `feed.schema.json`; `validate.mjs` validates feeds
  inline (unique ids, https manifestRef) and **fails loudly** — a missing or
  unparseable entry/feed section is a CI failure, never silently skipped
  (same reject-don't-skip rule as the publish pipeline's asset discovery);
  convert existing entries; delete
  `releases.json` from app repos (project-manager, demo-app).
- **Core**: `CatalogService` resolves feeds from the entry (drop
  `LoadFeedAsync` versions/tags handling); digest-aware `UpdateAvailable`;
  `CatalogAppDetailResponse` carries feeds + followed feed; app record gains
  the followed-feed reference; a set-feed operation (settings surface);
  check-updates surfaces the no-feed state as actionable guidance, not
  "up to date". AOT DTO registration for changed shapes.
- **Shell**: feed selector in the installed app's settings; update badge and
  update-source display; "no feed set" prompt on check-updates; marketplace
  detail lists feeds instead of versions.
- **Docs**: runtime-app-marketplace.md (WS1 feed schema, update-available,
  Q8 note) updated to reference this doc.

## Confirmed Decisions

| # | Decision |
| --- | --- |
| **A1** | Feeds live in the catalog entry (`entry.json` `feeds[]`); a feed is a named moving manifest ref; the entry changes per-topology, never per-release. `releasesUrl` and the standalone feed file are removed. |
| **A2** | `version` is informational only; update detection is digest compare (manifest + artifact) per the marketplace doc's read-only detection spec; one reviewed-update apply path; feeds never auto-apply. |
| **A3** | No legacy feed format, no auto-migration. Installs record the followed feed; the feed is changeable in app settings; installs without a usable feed get an explicit "choose a feed" prompt on check-updates (also covers feeds deleted from the catalog). |

## Testing

- Entry parsing: feeds present/absent, duplicate feed ids, non-https
  manifestRef rejected; `releasesUrl` rejected by schema.
- Badge: feed head advanced → available; head digest equal → not available;
  content changed under same version string → available (the regression
  case); artifact-only change (re-pushed tag) → available.
- Feed state: install records feed; settings re-point changes the followed
  ref; recorded feed missing from catalog → no-feed guidance; pre-feeds
  install → no-feed guidance; non-catalog installs unaffected.
- Plan/apply: version delta shown when bumped; `manifest` fallback when not;
  applied update re-vendors manifest-URL assets from the new head.

## Boundaries

- **Not a revival of per-app channels.** The removed `channelsUrl` /
  `AppChannelIndex` / switch-channel machinery (marketplace doc, "Channels:
  Decision", PR #67) stays removed. Feeds are catalog-entry data resolved
  through the single reviewed-update path; there is no switch-channel flow —
  re-pointing the feed is an app setting.
- **Pinned-version publishing is removed from the model.** The "operator sits
  on a specific version" scenario is explicitly out of scope; reproducibility
  concerns are the author's (immutable image tags, git history), and WS5
  signing anchors trust to the catalog entry + `signerIdentity`, not to a
  commit pin.
- **Product channels are a different axis.** `channels/product-channels.json`
  (platform delivery of Core/Shell/CLI) is untouched.

## Open Questions

- Feedless git-backed entries: should an entry with no `feeds` and a known
  repo default to "follow the default branch" (the deferred Q8 idea, with
  branches instead of tags)? Deferred — `feeds` with one element is cheap
  enough.
- Multi-source catalogs: the followed-feed reference includes the catalog
  source; first-source-wins entry merging already exists — confirm the feed
  reference survives a source rename gracefully (likely folds into the
  no-feed guidance).

## Links

- [Runtime app marketplace](runtime-app-marketplace.md) — feed schema
  ("Schemas (Sketch)", WS1), update-available detection spec,
  "Channels: Decision" (PR #67 removal).
- [Runtime app update](runtime-app-update.md) — plan digest, `changes`
  categories the version-delta display rides on.
- [Manifest-level app assets](manifest-level-app-assets.md) — the incident
  that surfaced this gap; asset-root semantics feed installs compose with.
- [Repository release model](repository-release-model.md) — platform-side
  release/versioning context.
- [`hosty-catalog`](https://github.com/alex-de-haas/hosty-catalog) — entry
  schema, validation, publish pipeline.

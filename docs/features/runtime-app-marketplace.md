# Runtime App Marketplace

Status: **MVP shipped (2026-07-05).** The update/artifact/lock/live-source foundation was
already shipped; the catalog storefront now is too — **WS1** (catalogMetadata, PR #105),
**WS2** (`/api/catalog`, PR #106), and **WS3** (Shell `/marketplace`, PR #107) are merged to
`main` (platform 0.32.0 / Shell 0.19.0), and **WS6** (the public
[`hosty-catalog`](https://github.com/alex-de-haas/hosty-catalog) repo + CI publishing
`catalog.json` to GitHub Pages) is live and end-to-end verified. Remaining, deferred:
**WS4** (`hosty catalog` CLI), **WS5** (signing), **WS7** (federation). See "Implementation
Readiness" for the plan and "Delivery status" for what shipped.
Created: 2026-06-25
Updated: 2026-07-06

## Motivation

Installing a runtime app today is fully manifest-driven: Core loads an `app.0.1`
manifest from a local file, a local directory, or an HTTP(S) URL. This works, but
there is no discovery: an operator must already know the app exists and where its
manifest or repository lives.

A marketplace adds a thin layer over the existing install path. The transport
(OCI registries for Docker, Git for `localCommand`, manifest-by-URL) already
exists, so the marketplace only needs to provide three things:

- **Discovery** - where to find installable apps.
- **Curation / trust** - which apps and publishers are vouched for.
- **Version legibility** - which version is available and which one is actually running.

This document captures the design discussion and the decisions reached.

## Goals And Non-Goals

Goals:

- Reuse existing manifest-driven install and the reviewed-update-with-digest flow.
- Require **zero new server infrastructure** to launch. Current reach is a couple
  of enthusiasts; a hosted registry service is premature.
- Make adding an app a reviewable, trust-gated event.
- Make app **versions** flow without per-release friction.
- Be a natural on-ramp to a richer model later (federation, then a hosted service).

Non-Goals (for v1):

- A hosted registry service with accounts, server-side search, ratings, and trending.
- Semantic-version range negotiation.
- Private repository / private registry authentication.
- Automatic dependency install.

## Core Principle

The marketplace is a **discovery + trust index over existing transport**, not a new
way to ship bits. None of the reference systems (Homebrew taps, Helm repos, APT,
Docker Hub, Flathub, Artifact Hub) built distribution from scratch - each is a thin
metadata/trust layer over Git, OCI, or HTTP. Hosty already has the transport, so
the correct v1 target is a **signed catalog index over what exists**, not a service.

## Variant Spectrum

- **Variant A - Static Git catalog.** A single catalog index (a JSON file in a Git
  repo) lists apps and points at their manifests / version sources. Style:
  Homebrew tap / Helm repo. Minimal infra, evolves naturally.
- **Variant B - Federated catalog sources.** An operator configures one or more
  catalog sources (an official one plus private ones). Style: APT `sources.list`
  / configurable VS Code gallery. Same format, different trust identity per source.
- **Variant C - Hosted registry service.** A backend with publishing, server-side
  search, ratings, and featured/trending. Premature at current scale.

**Decision:** Build **Variant A, designed as a special case of B** - the index
schema supports multiple sources from day one, but v1 ships a single official
source. A "tap" is just another catalog repo URL. This evolves into B by adding
sources and into C by replacing the static index behind the same Core
`/api/catalog` contract, without breaking Shell.

## Layered Model

The single most important decision. Four layers, each owned by a different party
and changing at a different cadence:

| Layer | Owner | Written when | Holds digest/commit? | Mutable? |
| --- | --- | --- | --- | --- |
| **Manifest** (`app.0.1`, in the app repo) | Author, by hand | before build | No - tag/branch only | Declarative intent |
| **Catalog index** (`catalog.json`) | Catalog CI | on membership change | Optional (generated) | Storefront / membership |
| **Per-app version feed** (`releasesUrl` or registry tags) | Author CI | on each release | Yes (post-publish) | Author-driven |
| **Lock** (Core app state) | Core | at install/update | Yes (resolved) | The thing that runs |

The manifest is **declared intent** (like `package.json` with `^1.2.0` or a tag).
The lock is the **resolved immutable identity** (like `package-lock.json`). The
runtime must run the lock, never the tag.

This is why a digest is **never authored into the manifest**: it only exists where
it is generated *after* build (catalog CI, version feed) or resolved *at* install
(Core lock). The chicken-and-egg of "we don't know the digest/commit until after
build/commit" disappears because no human ever writes it.

This lock layer is the **compiled-artifact** path (see "Artifacts, Runtimes, and
Delivery"); a **source** artifact runs live and is not pinned. The existing
`AppSourceState` (mutable `ResolvedRef` + immutable `Commit` resolved at install) is the
implementation precedent for "resolve a ref to an immutable id and store it"; the Docker
side mirrors it for compiled images: tag -> digest, lock the digest, run the digest.

## Catalog vs Versions: Two Cadences

`catalog.json` is the **membership / storefront directory**, not the version
database. It lists *which apps exist* plus display and trust metadata, and it
points at each app's version source. It is **not** where releases land.

| Event | Touches catalog (PR)? | Cadence |
| --- | --- | --- |
| New app added | Yes - PR | Rare |
| Publisher / icon / category change | Yes - PR | Rare |
| App removed / deprecated | Yes - PR | Rare |
| **New version released (0.3.1)** | **No** | Frequent - author CI |

A PR to the catalog is an act of **membership and trust** (a one-time review of a
new app: capabilities, external mounts, publisher identity). Version releases flow
around the catalog, so authors are never forced to PR per release.

## GitHub As Backend (Variant A)

The official catalog is an ordinary GitHub repository. Adding an app is a PR. This
is the Homebrew-core / Flathub / Helm-repo model: no marketplace infrastructure,
just a Git repo plus CI. Zero servers.

Repository layout:

- One folder per app: `apps/<reverse-dns-id>/entry.{yaml,json}` plus `assets/`
  (icon, screenshots). Small diffs, one app reviewed per PR, `CODEOWNERS` per folder.
- An `entry` holds **metadata and pointers only**. Manifest and image live in the
  author's own repo / registry. The catalog never contains app code.

CI on PR (the automated gate):

- Validate the entry and the referenced manifest against `app.0.1`.
- Validate `id` format (reverse-DNS) and uniqueness across entries.
- Check that the OCI ref / manifest URL resolves.
- Sanity-check declared `capabilities` and `externalMounts` (surfaced to the reviewer).
- Optionally render a card preview in a PR comment.

CI on merge to `main`:

- Generate the flat `catalog.json` from all `entry` files.
- **Sign it keyless via cosign + GitHub OIDC (sigstore)** - no private key to hold;
  the trust anchor is "this index was built by the `org/catalog` workflow." This is
  npm-style provenance, free and key-management-free.
- Publish via GitHub Pages / raw / a Release asset. Core fetches it and verifies the
  signature against the expected OIDC identity.

Optional submission ergonomics: a GitHub Issue Form -> Action that opens a PR,
lowering the barrier for authors who do not use Git. Topic-crawler discovery is
rejected: it needs a crawler and loses the review/trust gate.

## Two-Level Trust

Why version releases without a PR stay safe:

1. **Catalog (PR-reviewed, one-time)** vouches: "releases of app X are signed by
   identity Y."
2. **The author's version feed** is signed by that same Y (keyless cosign via the
   author CI's OIDC).
3. Core trusts a new version automatically **as long as its signature is Y**, which
   the catalog already vouched for.

The publisher is reviewed once (membership); thereafter their releases are trusted
by signature - like a verified publisher in VS Code or an accepted APT PPA. For the
actual image bits, reuse cosign image signing; do not build a CA.

## Artifacts, Runtimes, and Delivery

Finalized 2026-06-25. This is the **foundational model** for updates and supersedes the
earlier "lockability by source ownership" framing: the primary split is **artifact kind**,
and `localCommand` is not itself a classification.

Two things are ever updated: the **manifest** (contract) and the **artifact** (what
runs). The artifact needs finer classification - splitting by runtime is not enough.
Three **orthogonal** concepts:

### Artifact kind

- **Compiled artifact** - an immutable built output: a Docker image, a pre-built
  Next.js bundle, etc.
- **Source artifact** - a buildable/runnable source tree.

Source is just another artifact, but with special properties (mutable, must be built and
run, can be edited). **The update model is chosen by artifact kind, not by runtime
type:** compiled -> lock + reviewed update; source -> the "live" model.

### Delivery method (orthogonal to kind)

How the artifact reaches the host: OCI registry, git repo, local folder, or a separate
manifest. **Delivery does not imply kind.** Git can deliver *compiled* code, not just
source; a folder can hold a pre-built app. So the kind must be **declared in the
manifest**, never inferred from how it was delivered.

### Runtime

Declared by the developer in the manifest. A runtime:

- specifies **which artifact** it consumes and **from where** (its artifact source),
- determines **how** the app is launched,
- and thereby implies the **artifact kind** it expects.

So "`localCommand`" by itself classifies nothing: one `localCommand` may run a pre-built
Next.js app from a folder (compiled), another may build and run source. The manifest's
per-runtime declaration is what says source vs compiled - and that drives the update
model.

### The from-source runtime (developer opt-in)

An app **may** declare a runtime that runs it **from source** ("source lives at
`<repo>`; here is the build/run command"). This is opt-in - not every app supports it.

- If declared and the operator selects it, Core **fetches the source into a folder inside
  the app's root folder** (a Core-managed location, not a random user folder) and switches
  to this runtime. Source can also be delivered via git or a separate manifest.
- The same app can also be run from an **operator-owned** source folder (the operator
  points Core at their own repo working tree) - the live dev loop.
- A runtime that consumes **source** -> **live update**. Any other runtime (compiled
  artifact) -> the **standard reviewed update + lock** for that artifact type.

### Installation (definition)

Installation = specifying *from where* to install the app. In every case:

1. **Find the manifest** first.
2. Create the app's **root folder** and store the manifest there.
3. From the declared runtimes, **propose a default**.
4. **Each runtime has its own artifact source**; selecting a runtime selects its source.

### Two axes of liveness (resolved)

`source = live` is the decision. But the manifest and the artifact have **different**
liveness rules, so keep two axes:

- **Code / artifact liveness = artifact KIND.** Source -> **live**: Core runs (and the
  runtime command builds) the source tree; "update" is a cheap re-fetch of the ref or a
  direct edit, then restart - no run-lock, no reviewed-update ceremony. Compiled ->
  **locked**: digest (image) or content hash (prebuilt), advanced only by a reviewed
  update. Reproducibility is what compiled artifacts are *for*; source is for iteration.
- **Contract / manifest liveness = TRUST ownership of the source.** The operator's **own**
  source (their folder/repo) crosses no trust boundary -> the manifest is **live** (re-read
  + reconciled + diff surfaced). A **publisher's** source or image is a boundary -> the
  manifest **contract** (capabilities, mounts, endpoints, settings schema) is **reviewed**
  when it changes, even while the code runs live.

Common cases fall out cleanly:

| Case | Code | Contract |
| --- | --- | --- |
| Operator's own folder + source runtime | live | live (the pure dev loop) |
| Core-fetched **publisher** source + source runtime | live | reviewed on change |
| Registry image (compiled) + docker runtime | locked (digest) | reviewed (distributed app) |

### Resolved manifest fields and build

- **Artifact kind is declared per runtime:** `runtime.artifact: source | image | prebuilt`
  (`image`/`prebuilt` are compiled; `source` is live). This single field selects the update
  model.
- **Is Core-fetched source live?** Yes - the *code* is live (re-fetch the ref + restart;
  the observed commit is a display breadcrumb, not a run-lock). Its *contract* is reviewed
  on change because the publisher authored it. (A future opt-in to pin a source to a commit
  is possible, but is deliberately not the default - if you want pinning, ship a compiled
  artifact.)
- **Build step:** Core does **not** build. The source runtime's developer-declared
  **command** builds and/or runs (e.g. `npm run dev`, or `npm run build && npm start`), and
  Core supervises the process - exactly as `localCommand` works today. Build output is the
  command's concern, not Core's; nothing is cached by Core.

## Version Resolution And Artifact Pinning

The drift problem, concretely: `demo-app` ships `image.tag = "latest"` with
`pullPolicy = "always"`. Declared `version` is `0.4.1` and static, but a restart
re-pulls `latest` and can silently run different bits. This is a **second, invisible
update path that bypasses reviewed-update**. The fix is the lock model above.

- **Pin-on-install/update + run-the-lock.** At install/update, resolve `tag ->
  digest`, record it in app state, and run the locked digest on start/restart.
  Restarts become deterministic; the declared version becomes truthful again.
  "Update" = re-resolve the tag, get a new digest, run it through the existing
  reviewed-update flow, advance the lock.
- **Explicit per-app update policy (authoritative).** `pinned` (default - lock and
  require a reviewed update) vs `rolling` (re-resolve on restart, drift accepted).
  The app-level policy is the single source of truth; the manifest `pullPolicy` field
  is **removed** because the policy fully covers it (`pinned` = pull the locked digest
  if missing, then run it; `rolling` = pull the tag, re-resolve, run). The freedom
  Hosty gives stays, but as a deliberate opt-in, not a silent default.
- **Immutable release tags.** Authors should tag releases immutably
  (`:0.3.1`, matching `version`) and avoid `:latest` for published apps. Then even
  unpinned resolution is stable, and `:latest` honestly means "I want rolling."
- **Update-available detection.** Periodically (or on demand) re-resolve the tag or
  dist-tag and compare to the lock; surface "update available" as a first-class
  state instead of a restart surprise.

GitOps-style pinning (writing the digest into the committed manifest, e.g. a
Renovate bot) is a valid alternative but pays exactly the build<->manifest coupling
we want to avoid. The Core-side lock is cleaner at this scale.

## Final Update Logic

The resulting end-to-end behavior once locks + app policy land and channels are gone.

### The update model is decided by artifact kind

Per "Artifacts, Runtimes, and Delivery": the selected runtime declares its artifact kind,
and that - not the runtime type - decides whether the lock applies.

| Artifact kind | Examples | Code update model | Restart runs |
| --- | --- | --- | --- |
| **Compiled** | registry image; pre-built bundle | **locked** - digest / content hash, advanced by reviewed update | the locked artifact |
| **Source** | operator folder; Core-fetched repo; manifest-pointed repo | **live** - run/build the tree; re-fetch or edit to update | the current source tree |

The lock machinery below (digest, `pinned`/`rolling`, plan-seed) is the **compiled**
branch. Source artifacts are live: no run-lock, no reviewed-update ceremony for the code.

### Manifest liveness follows trust ownership

The review gate exists to protect a **trust boundary** - adopting a manifest authored by
someone other than the operator (a remote/catalog publisher, or a Core-managed artifact
shared across operators). It is **not** about manifest mutability as such.

An **operator-owned local folder crosses no trust boundary**: the developer owns both the
Core host and the source and is editing their own manifest, so Core adopting those edits
is identical to the developer reinstalling - which they may do freely. So for a live
folder, **both the code and the manifest are live**:

- On each start/restart Core **re-reads, validates, and reconciles** the folder manifest.
  Changes - version, capabilities, mount slots, settings schema - take effect with **no
  reviewed-update ceremony**: no reinstall, no publish/PR, no "press Update". (The earlier
  "manifest is always the reviewed root copy" rule was wrong for this case - it applied a
  trust-boundary gate where there is no boundary.)
- Core **surfaces a diff** of what changed since the last start (especially capabilities,
  external mounts, endpoints), so a silent edit - e.g. one an agent made - is **visible**.
  Awareness, not a blocking gate.
- The real gate for host access is unchanged: an `externalMounts` **slot** is inert until
  the **operator binds a real host path** (`AppMountBinding`). A live manifest can declare
  a new slot but cannot reach a host path without the operator's explicit binding - so
  live manifest reading does not let an app self-grant host access.
- If the folder manifest is invalid mid-edit, Core keeps the last valid contract running
  and surfaces the error.

For sources **the operator did not author** (registry image, a Core-fetched publisher
source, a catalog install) the manifest **contract** is the **reviewed copy** and contract
changes require review - that is the trust boundary being crossed (the *code* may still run
live if the artifact kind is source).

**Governing invariant (two axes):** *code* liveness follows **artifact kind** (source =
live, compiled = locked); *contract* liveness follows **trust ownership** (operator's own
source = live manifest, publisher source/image = reviewed contract). The two are
independent: a Core-fetched publisher source runs **live code** but its **contract is
reviewed** on change. Switching to a **compiled** runtime is a reviewed transition that
**snapshots the current effective manifest** into the reviewed root copy and pins the
artifact.

### State per app

- `updatePolicy`: `pinned` (default) | `rolling`. Applies **only to compiled artifacts**.
- `ArtifactLocks`: per-service resolved immutable identity, set **only for compiled
  artifacts**:
  - Registry image -> `imageDigest` (`sha256:...`) plus the `repository:tag` it was
    resolved from.
  - Pre-built bundle -> a content hash of the built output.
- A **source** artifact carries **no run-lock** and is not on the `pinned`/`rolling` axis;
  the checked-out commit (if any) is an observed display breadcrumb only.

The manifest only ever carries intent (`repository:tag`, `branch`). No digest, no
`pullPolicy`.

### Live source (folder + localCommand): the dev loop

This is the development inner loop, and Core stays **hands-off on the artifact**:

- Core runs whatever **code** is in the folder, every start. It **never** checks out,
  resets, or rolls back - uncommitted/dirty work is exactly what the developer wants to
  run. The frequent inner-loop edits (components, handlers) are picked up live, often by
  the dev server's own HMR with no restart.
- The **manifest is live too** (see above): on each start Core re-reads, validates, and
  reconciles the folder manifest, using its profile definition (`command`,
  `workingDirectory`, `env`, ports) with the working directory resolved against the
  operator folder. Contract changes (version, capabilities, mount slots, settings schema)
  are adopted on restart - no reinstall, no `update` ceremony - and surfaced as a diff so
  silent edits are visible. New host access still needs the operator's mount binding.
- There is **no enforced lock** and **no reviewed "update available"** for the artifact.
- Core *may* **observe** for display only - `git rev-parse HEAD` + dirty flag, and the
  folder manifest's **version** - surfaced as "source: `0.1.1` @ `abc123` (dirty)"
  beside the installed version. Read-only breadcrumbs, never enforced. A non-git folder
  simply shows no commit.
- **UI:** mark the runtime as **Live** and hide the reviewed-update affordance while a
  live runtime is active; it reappears if the operator switches to a compiled-artifact
  runtime.

So the answer to "how does the lock work here" is: **it does not lock the artifact** - for
the operator's own folder both the code and the manifest are live (the manifest diff is
surfaced, not gated). A Core-fetched *publisher* source runs the code live but reviews
contract changes.

### Resolving a lock (compiled artifacts only)

- Registry image: `docker pull repository:tag`, then read the digest
  (`docker inspect --format '{{index .RepoDigests 0}}'` or parse the pull output);
  store it in `ArtifactLocks`.
- Pre-built bundle: hash the built output and store it.

Source artifacts are not resolved to a run-lock - they run live (`git rev-parse` may be
recorded for *display* only).

### Start / restart

- **pinned**: ensure the locked artifact is present (Docker: pull by digest
  `repository@sha256:...` if missing - deterministic), then run the locked artifact.
  Bits never change across restarts.
- **rolling**: re-resolve the mutable pointer (`pull repository:tag`; or a prebuilt's
  tracked ref re-fetched + re-hashed), update `ArtifactLocks` to what is now running, then
  run it. Drift is expected.
- **live** (source artifact): run/build the source tree as-is - no resolve, no run-lock,
  no policy. An operator folder picks up the developer's edits; a Core-fetched source picks
  up a re-fetched ref.

Restart = stop + start, same rules.

### Core start (lock backfill)

When Core (re)starts an app:

- If `ArtifactLocks` is missing (legacy install), resolve the current ref and record
  it (TOFU), then proceed as above. This is the only backfill step - no migration job.
- pinned apps then keep that lock; rolling apps re-resolve every start anyway.
- **Source artifacts are skipped** - nothing to lock; they are run/built live.

### Reviewed update (new version, re-resolve, or version/track switch)

1. Resolve the target ref -> target digest/commit.
2. Build the plan seed including **current vs target artifact digests** (not just
   manifest digests), so the operator sees an artifact change even when the manifest
   is byte-identical (e.g. a re-pushed tag).
3. Operator confirms the plan digest.
4. Apply: write the new manifest copy, advance `ArtifactLocks` to the target, take the
   pre-update backup (as today), and restart running the new lock.

A catalog/feed "version" or dist-tag (`stable`/`beta`) resolves to a concrete
manifest + digest and then takes this exact same path. There is no separate
"switch-channel" flow.

Source artifacts have **no reviewed update for the code** - it re-fetches/rebuilds live.
For the operator's own source the manifest is live too (diff surfaced, not gated); for a
publisher source a *contract* change still surfaces for review.

### Update-available detection (read-only)

- Re-resolve the app's pointer - the tag, or a dist-tag from the catalog/feed, or
  branch HEAD - to a candidate digest/commit **without a full pull**
  (`docker manifest inspect` / registry HEAD; `git ls-remote`).
- Compare candidate vs the current lock. If different, surface "update available"
  (with a version delta when the feed provides one). Applying it goes through the
  reviewed update above.

### Drift indicator

- **pinned**: drift is impossible by construction (the lock is always what runs).
- **rolling**: compare the running digest vs the last-recorded lock; if they differ,
  surface "running a newer build than recorded".

### Net effect

- The declared version is always truthful: pinned apps run exactly their lock.
- There is exactly **one** update path - the reviewed update - and `rolling` is the
  only sanctioned, clearly-labelled way to accept automatic drift.
- The silent "re-pull `latest` on restart" path is gone unless the operator
  explicitly chose `rolling`.

## Channels: Decision

The per-app channel feature (`channelsUrl`, `AppChannelIndex`, `switch-channel/plan`,
`switch-channel`) is **fully implemented**, but **confirmed unused** - there is no
Shell UI and no installed app relies on it in practice. It was motivated by pre-merge
testing, which is now covered by local install (folder install from a worktree plus
`source-override` tests any runtime, including `localCommand`, before merge).

**Decision: remove the channel code outright.** Because it is unused, no migration is
needed. Removal surface (implemented in PR #67; referenced by symbol/file, not line
number, so it does not drift):

- Manifest: `channelsUrl`, `AppChannelIndex`, `AppChannelEntry`.
- Core (`CoreLifecycleService`): `ListChannelsAsync`, `CreateChannelSwitchPlanAsync`,
  `ApplyChannelSwitchAsync`, `LoadChannelIndexAsync`, `ResolveChannelIndexPath`,
  `ResolveChannelManifestPath`.
- Endpoints (`LifecycleEndpoints`): `channels`, `switch-channel/plan`, `switch-channel`.
- State/plan: `AppRecord.SelectedChannel`, and `TargetChannel` on `AppUpdatePlan` /
  `AppUpdatePlanDigestSeed`.
- CLI: the `--channel` flag on `install` / `update`.

- **The version/track concept lives only in the catalog + per-app version feed**
  (dist-tags `stable`/`beta`), resolved into the standard reviewed-update path. It is
  built fresh on the catalog side - not the old channel code.
- **Pre-merge testing** is documented as the supported local dev loop, not a
  published channel.
- **Product channels stay separate.** `channels/product-channels.json` (delivery of
  Core / Shell / CLI themselves) is a different axis - a stability track for the
  *platform*, analogous to APT suites for the OS. Local app testing does not replace
  it; keep and evolve it independently of the app catalog.

This refines `update-channels.md`: app-level channels collapse into catalog
versions plus an author-owned version feed; product channels are retained.

## Manifest Metadata Extensions

Today the manifest carries only `ui.icon` (a Lucide name) for display. The
marketplace needs richer display metadata. Add a `catalogMetadata` block (kept out
of the runtime schema so `app.0.1` runtime validation stays lean), with fields
modeled on Flathub AppStream:

- `publisher` (name / url / email)
- `category`, `tags`
- `icon` (asset/URL, not just a Lucide name), `screenshots[]`
- `license` (SPDX)
- `links` (website / docs / support)
- `summary` / long description / changelog

## Schemas (Sketch)

Catalog entry (`apps/<id>/entry.yaml`, hand-authored, PR-gated):

```yaml
id: com.haas.demo-app
publisher: { name: "...", url: "...", email: "..." }
category: "..."
tags: ["..."]
display: { summary: "...", icon: assets/icon.png, screenshots: [...] }
releasesUrl: https://<author>/releases.json   # or: registry/git tag source
signerIdentity: github.com/<author>/<repo>     # trust anchor for the feed
```

Per-app version feed (`releasesUrl`, author-hosted, signed by author):

```json
{
  "versions": [
    { "version": "0.3.0", "manifestRef": "...", "artifact": { "kind": "image", "imageDigest": "sha256:..." } },
    { "version": "0.3.1", "manifestRef": "...", "artifact": { "kind": "image", "imageDigest": "sha256:..." } },
    { "version": "1.4.0", "manifestRef": "...", "artifact": { "kind": "source", "commit": "abc123", "ref": "refs/tags/v1.4.0" } }
  ],
  "tags": { "stable": "0.3.1", "beta": "0.4.0-rc1" }
}
```

**The feed is artifact-agnostic** (revised 2026-07-05, per Q7 - the catalog does not
restrict runtime kind). A version always carries `manifestRef`; the resolved artifact
identity is a **discriminated** `artifact` object keyed by `kind`: `image` ->
`imageDigest`, `source` -> `commit` (+ optional `ref`), `prebuilt` -> `bundleHash`
(deferred). `artifact` is **optional** - Core re-resolves it at install from the
manifest's declared runtime (clone -> commit / pull -> digest), so a bare
`{ version, manifestRef }` feed is valid; the resolved identity is a post-publish
optimization and the provenance anchor for signing.

Lowest-friction alternative to a feed file: the entry points directly at an OCI repo
/ Git repo and Core lists **tags directly** as versions - zero per-release author
action beyond `git tag` / `docker push :0.3.1`.

## Shell UI Surfaces

- A `/marketplace` page rendering the catalog (cards: icon, name, publisher,
  summary, category) on top of the existing install-review flow.
- App detail: versions from the feed, screenshots, changelog, publisher, capability
  list shown as install-time permissions.
- **Version legibility on cards/details:** declared version + short running digest +
  policy badge (`Pinned` / `Rolling`).
- **Drift / update badges:** lock != latest-resolved -> "Update available 0.3.0 ->
  0.3.1" with the reviewed-update CTA; running != lock (rolling drift) -> warning.
- **Install-time mutable-tag note:** when a profile tracks a mutable tag, show
  "This app tracks `latest` - restarts may update it. [Pin to current version]".
- **Live runtime:** when the active runtime runs from an operator folder, show a **Live**
  badge instead of the reviewed-update CTA (there is no reviewed update in live mode), the
  live `source: <version> @ <commit> (dirty)` line, and a **"definition changed"** diff
  banner when the folder manifest changed since the last start (highlighting capability /
  mount / endpoint changes). A compiled-artifact runtime restores the normal version +
  update CTA.

## Phased Plan

0. Remove the channel code (unused) - clears `channelsUrl`, `switch-channel*`, and
   `SelectedChannel`/`TargetChannel` before versions are built on the catalog.
1. Manifest metadata extensions (incl. per-runtime `artifact: source | image | prebuilt`)
   + `catalog.json` and version-feed schemas.
2. Artifact pinning (**compiled artifacts only**; source runtimes already run live): add
   per-service `ArtifactLocks`; resolve tag -> digest at install/update; run the lock on
   start/restart with lazy backfill on Core start; add the authoritative `pinned`/`rolling`
   policy and remove `pullPolicy`.
3. `/api/catalog` in Core reading the index; `/marketplace` page in Shell over the
   existing install-review flow.
4. Keyless signing of the catalog index and per-app feeds; two-level trust verification.
5. Federation: operator-configured additional catalog sources (Variant B).

## Decisions And Recommendations

- Build Variant A designed as a special case of B; keep a single official source in v1.
- Digest/commit lives only in the catalog (generated) and the Core lock (resolved),
  never in the hand-authored manifest.
- The catalog is membership/storefront (PR-gated, rare changes); versions come from
  an author-owned feed or registry/git tags (no per-release PR).
- Trust is two-level: the catalog vouches for a publisher's signing identity once;
  signed releases are then trusted automatically.
- Default to pinned (locked digest) with an explicit `rolling` opt-in; recommend
  immutable release tags.
- The app-level `pinned`/`rolling` policy is authoritative; **`pullPolicy` is removed
  from the manifest** because the policy fully covers pull behavior.
- The image lock is a new **per-service `ArtifactLocks`** on `AppRecord` (not an
  overload of `AppSourceState`, which stays git-flavored for `localCommand`).
- **The update model is decided by artifact kind (declared per runtime as
  `runtime.artifact: source | image | prebuilt`), not by runtime type.** Source = live
  (run/build the tree, re-fetch/edit to update, no run-lock); compiled = locked (digest /
  content hash, reviewed update).
- **Two axes of liveness.** *Code* follows artifact kind (source = live). *Contract*
  follows trust ownership: the operator's own source = live manifest (diff surfaced, no
  gate); a publisher source/image = reviewed contract on change. So a Core-fetched publisher
  source runs live code with a reviewed contract. The host-access gate (operator mount
  binding) is unchanged. Switching to a compiled runtime snapshots the manifest under review
  and pins the artifact.
- **Backfill the lock lazily**: when Core (re)starts an app with no lock, resolve the
  current ref to a digest/commit and record it (TOFU). No separate migration step - an
  update restarts the app anyway.
- **Remove the channel code outright** (confirmed unused); the version/track concept
  moves to the catalog + per-app feed. Keep product channels separate.

## Current Implementation Findings (verified 2026-06-25)

Checked against the code to ground the design. Key facts:

- **Channels are fully implemented**, not a skeleton (see Channels: Decision).
  Retiring is a migration, not a delete. Shell has no channel UI; CLI exposes
  `--channel` on install/update only (no `hosty apps channels` command).
- **The reviewed-update digest is manifest-only.** `AppUpdatePlanDigestSeed` hashes
  current/target *manifest* digests (`CoreLifecycleService.cs:1154-1163`,
  `HashPlanSeed` at `:945`). It does **not** observe the artifact. A force-pushed tag
  with an identical manifest produces the same plan digest -> the change is invisible
  to review. `ManifestDigest` is also transient (computed in the plan, not persisted
  in `AppRecord`).
- **No Docker image digest anywhere.** `RuntimeDockerImage(Repository, Tag, PullPolicy)`
  has no `Digest` field and `Reference => "{Repository}:{Tag}"`
  (`RuntimeAppManifest.cs:1293-1296`). No `repo@sha256:...` support.
- **Pull output is discarded; the resolved digest is never captured.** Start does
  `docker rm -f` then optionally `docker pull` then `docker run repo:tag`
  (`RuntimeAppManifest.cs:755-784, 912`). Only `pullPolicy == "always"` is honored;
  `missing`/`never`/`ifNotPresent` are silently treated as "do not pull".
  `demo-app` ships `tag: latest` + `pullPolicy: always`, so every restart re-pulls
  and can drift - exactly the reported behavior.
- **Docker health is explicitly unimplemented** (`RuntimeAppManifest.cs:982-994`,
  returns "unknown"). There is no way today to read the running image id/digest, so
  no drift/update-available signal exists.
- **`AppSourceState.Commit` is the existing lock precedent** for `localCommand`
  (`AppRegistryStore.cs:254-261`, resolved via `git rev-parse` in
  `AppSourceService`). There is **no image-identity field** on `AppRecord`
  (`AppRegistryStore.cs:186-218`); install/update record manifest + source only.
- **Catalog metadata gaps confirmed**: no publisher/tags/screenshots/license/links;
  `ui.icon` exists; `ui.category` exists but is **not surfaced to `AppSummary`**
  (`AppRegistryStore.cs:343-365`), so clients cannot even read the category today.
- **`channels/product-channels.json` is unconsumed** by Core/CLI/Shell - a build/
  pipeline placeholder, nothing reads it at runtime.

## Improvement Opportunities (grounded)

Ordered by leverage for the new update + catalog approach:

1. **Add `Digest` to `RuntimeDockerImage` and emit `repo@sha256:...`** when locked
   (`RuntimeAppManifest.cs:1293-1296`, parse at `:508`). Enables running a pinned
   artifact instead of a mutable tag.
2. **Capture the resolved digest after pull** instead of discarding it
   (`RuntimeAppManifest.cs:783`): parse the `Digest:` line or
   `docker inspect --format '{{index .RepoDigests 0}}'`.
3. **Persist a per-service image lock** (parallel to `AppSourceState.Commit`). New
   field on `AppRecord` (e.g. `ArtifactLocks`) keyed by service - per-service because
   services can use different images even though `demo-app` shares one.
4. **Run the lock on start/restart** (`RuntimeAppManifest.cs:755-784`): use the
   locked digest, not `repo:tag`. Makes restarts deterministic.
5. **Remove `pullPolicy`; derive pull behavior from the app-level `pinned`/`rolling`
   policy** (single source of truth). Today only `always` works; `pinned` pulls the
   locked digest if missing then runs it, `rolling` keeps `pull always` + re-resolve.
6. **Include image locks in the plan seed** (`AppUpdatePlanDigestSeed`,
   `CoreLifecycleService.cs:1154-1163`) so the operator sees "image changed even
   though the manifest did not" - closes the invisible-update gap.
7. **Implement Docker health / running-image inspection**
   (`RuntimeAppManifest.cs:982-994`) to report the running digest -> powers the
   "running != lock" drift warning and "update available".
8. **Surface running digest, policy, and category on `AppSummary`**
   (`AppRegistryStore.cs:343-365`) for marketplace cards and version legibility.
9. **Add a `catalogMetadata` block to the manifest** (publisher/tags/screenshots/
   license/links) and surface it; elevate/searchable category.
10. **Classify update by artifact kind, declared per runtime** (`runtime.artifact:
    source | image | prebuilt`). `pinned`/`rolling` and the digest lock apply to compiled
    artifacts only; source artifacts run live (no run-lock). Reuse `AppSourceState` /
    `git rev-parse` for *display* breadcrumbs on source, not as a run-lock.
11. **Remove the channel code** (manifest `channelsUrl`, `AppChannelIndex`/`Entry`,
    the three `switch-channel*` endpoints and their service methods,
    `AppRecord.SelectedChannel`, the `TargetChannel` plan field, the `--channel` CLI
    flag). See Channels: Decision for the full surface.

## Scope Decisions (confirmed 2026-06-26)

Closing the implementation-readiness review; IDs match the question list it produced.
These narrow v1 to a buildable scope.

Update model / artifact (A):

- **A1** Artifact kind is declared per runtime on `services[].runtimes[<key>].artifact`,
  one of `image` / `source` / `prebuilt`. `docker` defaults to `image`; `localCommand`
  must declare it.
- **A2** No per-runtime source in v1; a source runtime consumes the app-level
  `manifest.source`. Revisit only if an app needs two repos.
- **A3** Lock = `AppRecord.ArtifactLocks: Dictionary<string, ArtifactLock>?` (keyed by service), where
  `ArtifactLock { Kind, ImageDigest?, ResolvedFromRef?, BundleHash?, Commit?, ResolvedAt }`.
  Nullable/additive; registered in `CoreJsonSerializerContext`.
- **A4** Resolve the target digest at plan time with a light lookup (`docker manifest
  inspect` / registry HEAD, no full pull). Registry unreachable -> the plan does not fail;
  the artifact delta is marked "unknown" and the full pull happens at apply.
- **A5** The live source-reconcile is its own phase (**2b**), after image pinning (**2a**).
- **A6** `prebuilt` is **out of v1** (image + source only). Spec retained under Deferred.
- **A7** ~~Core-fetched publisher source is out of v1 (only the operator-owned dev
  folder is "source").~~ **Revised 2026-07-05 (Q7): the catalog is runtime-agnostic and
  Core-fetched source is IN v1 at the mechanism level** - it already works.
  `AppSourceService.ResolveManagedAsync`/`EnsureCheckoutAsync` `git clone` a public
  http/https source repo into `SourcesRoot/<appId>`, and Development Mode
  (`AppSummary.ResolveDevelopmentMode`) decouples live (edit/re-fetch) from pinned-to-commit
  (reviewed update) independently of operator-vs-publisher ownership. So `source ⇒
  operator-owned` (R15/R18) no longer holds. What is NOT yet coded: the strict "reviewed
  contract on publisher-source change" branch - in MVP that is covered by install-review +
  the 2b reconcile-diff (surfaced) + the mount-binding host-access gate. See "Implementation
  Readiness (confirmed 2026-07-05)".
- **A8** Remove `pullPolicy` from the manifest model; pull behaviour derives from the
  `pinned`/`rolling` policy.
- **A9** AppRecord changes are additive/nullable - no `SchemaVersion` transform; locks are
  lazily backfilled on start.

Marketplace (B):

- **B1** Versioned schemas (`marketplace.0.1`) for `catalog.json` / entry / feed, specced
  in phase 1.
- **B2** `GET /api/catalog/apps` + `/api/catalog/apps/{id}`; merge sources by priority,
  id-conflict -> first source wins + warning; pagination deferred.
- **B3** **ECDsa P-256 detached signatures** (BCL-native, AOT-proven - see spike) over the
  index + feed, verified against a public key pinned in Core. Keyless sigstore deferred.
- **B4** v1 resolves versions from an explicit `releasesUrl` feed only; bare OCI/git tag
  enumeration deferred.
- **B5** New top-level `catalogMetadata` block (outside runtime validation); also surface
  `ui.category` + metadata on `AppSummary`.
- **B6** The catalog repo + CI is a separate `hosty-catalog` deliverable; Core only
  consumes the published index.
- **B7** Offline verification = pinned public key + cached trust root; full air-gapped
  story deferred.

Cross-cutting (C):

- **C1** Product channels stay a separate axis; define the `product-channels.json`
  consumer before building platform delivery on it.
- **C2** Each phase = platform minor bump (0.x breaking-ish surface); Shell patch/minor.

### B3 spike result (2026-06-26)

Verified on .NET 10 with `PublishAot=true` (Core's exact build model):

- **ECDsa P-256 detached signature** (sign + verify, with tamper and wrong-key rejection)
  compiles **native-AOT clean** (warnings-as-errors) into a self-contained binary with
  **no native dependency**. This is the v1 choice.
- **Ed25519 is not in the .NET 10 BCL** (only ML-DSA / SLH-DSA PQC are), so an
  ed25519/minisign scheme would need a native libsodium dependency - hence ECDsa P-256.
- **`Sigstore` 0.5.0 does AOT-compile, link, and load** (0 IL trim/AOT warnings with the
  assembly rooted), so keyless is **not AOT-infeasible** - but it ships a native
  `libsodium.dylib` side-car (via `NSec.Cryptography`), a TUF client, and Fulcio/Rekor
  HTTP surface, and is 0.x. Deferred on cost/maturity, not feasibility.

## Phase 2b + A1 Resolutions (confirmed 2026-06-26)

Closes the non-marketplace remainder of the update track: the per-runtime `artifact` field
(A1) and live source-reconcile (phase 2b). IDs `R*` map to the open-questions review. Build
order: A1 → snapshot+fallback (R10/R13) → diff (R11) → reconcile wiring (R5–R9) →
liveness UI + breadcrumbs (R15/R16) → switch live→compiled (R17).

Artifact field (A1):

- **R1** Infer when omitted, never fail for back-compat: absent `artifact` → `docker` resolves
  to `image`, `localCommand` to `source`. A `localCommand` without an explicit `artifact` is
  inferred **silently** (no error). *(Implemented as silent inference; surfacing a "declaring
  artifact is recommended" advisory is deferred to the liveness-breadcrumb increment, R15/R16.)*
- **R2** Allowed values in v1: `docker = {image}`, `localCommand = {source}`. Any other
  combination → `app_runtime_artifact_unsupported`.
- **R3** `prebuilt` is **hard-rejected** at validation (fail fast), not accept-and-defer (per A6).
- **R4** The kind is **not persisted** on `AppRecord` — it is intent (like `repository:tag`),
  re-derived from the manifest at start. Resolved compiled identity already lives in
  `ArtifactLock.Kind`; a source artifact has no lock.

Reconcile granularity (phase 2b — closes the "reconcile granularity" open question):

- **R5** Reconcile is a **full re-evaluation of the run profile on every start**, no in-place
  patching. `command`/`env`/`workingDirectory`/ports are picked up by the normal re-spawn; a
  port change re-registers the router/ingress in the same start path.
- **R6** Capability wiring (ingress/notifications) is **idempotent and re-applied each start**;
  changes surface in the diff. No separate ceremony.
- **R7** A slot removed from a live manifest while an `AppMountBinding` exists: the binding is
  **kept but inert** — not injected and omitted from the mount summaries (keyed off current
  slots) rather than deleted. The host path is never touched (Hosty never deletes mounts) and a
  re-added slot auto-rebinds. *(Implemented as silently inert; explicitly surfacing the orphaned
  binding in the reconcile diff with a warning is a follow-up increment.)*
- **R8** Settings are **non-destructive**: stored values are validated against the new schema;
  mismatches surface as a warning and values are retained. Start is blocked only when a
  now-`required` setting is missing (reusing the existing required-settings gate).
- **R9** Endpoints/ingress: same as R5 — idempotent re-register on start, no separate logic.

Diff and snapshot (phase 2b):

- **R10** *(refined at implementation)* Reuse the existing **reviewed internal copy**
  (`app.ManifestPath` = `{appRoot}/manifest.json`, written by `SaveManifestCopyAsync` and always
  valid) as the last-good snapshot — no new content/digest field on `AppRecord` is needed. The
  start path prefers the live folder manifest and falls back to this copy when the live one is
  invalid (R13); the diff baseline (R11) is `live-digest vs copy-digest`. The only new persisted
  state is the nullable `AppRecord.ManifestError` (R14). Freshening the copy to the last *valid*
  live manifest (so the fallback/baseline tracks "since last start") lands with the diff (R11).
- **R11** Reuse `AddCapabilityChanges` / the plan-diff machinery; render it as an informational
  "reconcile diff", not an update plan. Surface on `AppSummary` + Shell; no CLI ceremony.
- **R12** The diff is **informational only**. The sole gate is new host access (operator mount
  binding); everything else is awareness.

Invalid manifest / edge (phase 2b):

- **R13** On an invalid folder manifest, run the **last-good snapshot** (R10) and set an app
  status `manifest-invalid` carrying the error. A cold Core start with a currently-invalid
  manifest also falls back to last-good if present; with **no** last-good (first install
  invalid) the app **refuses to start** with the validation error.
- **R14** Surface the error as a structured status field (`manifestError`) + a notification +
  a log line; Shell shows a non-blocking banner.

Liveness markers / UI (phase 2b):

- **R15** `isLive = (active runtime.artifact == source)` in v1 (source ⇒ operator-owned, per
  A7). Expose a `runtimeLive` boolean on `AppSummary` so Shell hides the update CTA. The
  publisher-source "live code + reviewed contract" branch is **not coded** — leave a TODO
  referencing A7 so the simplification is deliberate.
- **R16** Breadcrumbs are a small increment over the existing source/commit tracking
  (`AppSourceState.Commit`): add a dirty flag + folder-manifest version, exposed read-only as
  `sourceDisplay` on `AppSummary`. Reuse `AppSourceService` git logic; non-git → `commit=null`.

Switch and cross-cutting (phase 2b):

- **R17** Switch live→compiled is **in 2b scope** but minimal: one pass of the normal
  install/update review path that snapshots the effective manifest into the reviewed copy and
  pins the artifact (reuse the 2a lock resolve).
- **R18** Publisher-source (live code + reviewed contract) is **not implemented** (A7); assert
  `source ⇒ live` and omit the reviewed-contract-on-source branch.
- **R19** Phase 2b = platform minor bump (0.9.0 → 0.10.0); `AppRecord` additions are
  additive/nullable with lazy backfill, no `SchemaVersion` transform (per A9).
- **Scope guard:** 2b targets **only `localCommand` operator folders** (the real case today);
  docker-source does not exist and publisher-source is deferred — neither is coded.

Smallest shippable 2b: A1 + live re-read with last-good fallback (R10/R13/R14) + diff in
status (R11) + `runtimeLive` (R15). Orphaned-slot/stale-settings nuance (R7/R8) and the
runtime switch (R17) can land as a second increment.

## Deferred (out of v1)

- **`prebuilt` artifacts + bundle hash.** Add when a real app needs a built bundle that is
  not an OCI image. Spec to use when it lands: a versioned Merkle **bundle digest**
  (`bundle.v1:sha256:...`) in the style of Go's `h1:` dirhash, over the manifest-declared
  bundle root (per service): per file `sha256(bytes)` (no content normalization); key each
  entry by its POSIX, Unicode-NFC relative path plus a normalized exec-bit / `symlink ->
  target` flag; sort by raw path bytes; `sha256` the concatenation; ignore mtime/uid/gid
  and empty dirs plus a fixed ignore set (`.git`, OS junk); compute at install/update only,
  store in `ArtifactLocks`, include in the plan seed; re-hash on demand for drift. Hand-
  rolled Merkle over `SHA256` (AOT-clean, no deps); avoid reproducible-tar. Lowest-effort
  alternative: package the bundle as an OCI artifact and reuse the image digest.
- **Core-fetched publisher source** (live code + reviewed contract) - arrives with git-URL
  install.
- **Bare OCI/git tag enumeration** as a version source (auth, rate limits, dist-tag
  conventions).
- **Keyless sigstore verification** - AOT-viable (see B3 spike) but heavy; revisit if the
  catalog grows beyond a single trusted publisher.

## Open Questions

- **`product-channels.json` ownership.** Nothing consumes it yet - define its consumer
  (installer/build pipeline) before building platform delivery on it; separate from the
  app catalog.
- ~~**Phase 2b reconcile granularity.**~~ Resolved in *Phase 2b + A1 Resolutions* (R5–R9):
  reconcile re-evaluates the full run profile every start (no in-place patching); ports/ingress
  re-register on the same start path; orphaned slots and stale settings are non-destructive.

## Implementation Readiness (confirmed 2026-07-05)

Closes the implementation-readiness Q&A. Baseline at this point: platform **0.30.1** /
Shell **0.18.2**; the whole update/artifact/lock/live-source foundation (channels removed,
`artifact` kind, `ArtifactLocks` + `pinned`/`rolling`, live-source reconcile, Development
Mode) is **merged**. Only the catalog storefront remains.

### Governing invariant - marketplace is optional and non-intrusive

The catalog is a discovery/trust index over existing transport, **never a required source**:

- All current install paths stay unchanged: local file, local directory, HTTP(S) manifest
  URL, and git-URL source. Install-from-catalog is a thin wrapper that feeds a `manifestRef`
  into the same `CreateInstallPlanAsync`.
- The manifest `catalogMetadata` block is **optional** and kept **out of** runtime `app.0.1`
  validation (B5). A manifest without it is fully valid.
- An installed app **need not belong to any catalog**. `releasesUrl` / `signerIdentity` /
  provenance are properties of the catalog **entry**, not of the manifest or `AppRecord`;
  they are `null` for non-catalog installs.
- Feed-based update-available is **opt-in per app**. Without a feed, the existing
  reviewed-update (manifest/digest, or source commit) runs exactly as today.

### Runtime-agnostic catalog (Q7)

The catalog does **not** restrict runtime kind - an entry is just a pointer to a manifest,
and the manifest may declare `docker`/`image` **or** `localCommand`/`source` (real case:
`transcode-engine` has no image; on prod it runs `localCommand` from source with runtime
compilation). This is already supported at the mechanism level (see the revised **A7**):
`AppSourceService` git-clones a public source repo into a managed checkout, and Development
Mode pins-to-commit vs runs-live independently of who owns the source. Consequence: the
version feed schema is **artifact-agnostic** (see "Schemas") and install/update reuse the
existing paths for both kinds. `prebuilt` **catalog delivery** stays deferred (A6) only
because no catalog delivery path exists for it yet - not because the catalog rejects it.

### Confirmed answers (Q1-Q11)

| # | Decision |
| --- | --- |
| **Q1** | Ship an **MVP first**: WS1 + WS2 + WS3 + WS6, single official source, **unsigned** (trust rides on the existing install-review). Signing (WS5) and federation (WS7) are follow-ups. |
| **Q2** | Public `hosty-catalog` GitHub repo, published via GitHub Pages. |
| **Q3** | v1 verifies the **index + feed only**, not image bits (cosign image verify deferred). |
| **Q4** | ECDsa P-256: private key = catalog-CI secret; public key **embedded** in Core + config-override for rotation. Keyless sigstore deferred. |
| **Q5** | Manifest `catalogMetadata` is the **display source of truth**; the catalog `entry` holds only pointers + trust (`signerIdentity`, `releasesUrl`) + curation overrides. |
| **Q6** | Category = a **small fixed enum** in the schema + free-form `tags[]` for the long tail. |
| **Q7** | Catalog is **runtime-agnostic** - no image-only restriction (see above). |
| **Q8** | Versions resolve from an explicit **`releasesUrl` feed only** (bare OCI/git tag enumeration deferred). |
| **Q9** | Icons/screenshots served from the catalog's Pages as https URLs; confirm Shell CSP allows the catalog host (small icons may be data-URI-inlined in the index). |
| **Q10** | API namespace = `catalog` (`/api/catalog/...`); user-facing UI label = **"Marketplace"**. |
| **Q11** | App channels stay removed / untouched; a stability-track feature is a separate future concern if ever needed. |

### Workstreams and build order

| WS | Scope | Doc phase | Side | Version |
| --- | --- | --- | --- | --- |
| **WS1** | `catalogMetadata` (optional, outside runtime validation) + artifact-agnostic `marketplace.0.1` schemas (index / entry / feed) + AOT DTO registration + surface metadata on `AppSummary` | 1 | Core | platform -> 0.31.0 |
| **WS2** | `CatalogSourceStore` + `CatalogService` (fetch/cache/merge) + `CatalogEndpoints` (`GET /api/catalog/apps`, `/apps/{id}`) + install-from-catalog + update-from-feed - all reuse existing install / reviewed-update, no runtime restriction | 3 (Core) | Core | platform -> 0.32.0 |
| **WS3** | Shell `/marketplace` page (cards, search, detail) reusing the install-review dialog + app-details components; version/policy/Live badges | 3 (Shell) | Shell | Shell -> 0.19.0 |
| **WS4** | `hosty catalog` CLI (`list` / `show` / `install` / `sources`) reusing install-plan/apply | 3 (CLI) | CLI | folded into platform bump |
| **WS5** | ECDsa P-256 detached signature verification of index + feed; two-level trust; pinned public key | 4 | Core | platform -> 0.33.0 |
| **WS6** | Public `hosty-catalog` repo + CI: PR validation (entry + referenced manifest against `app.0.1`, id uniqueness, ref resolves, capability/mount sanity) -> merge generates + publishes (and later signs) `catalog.json` | B6 | separate repo | - |
| **WS7** | Federation - operator-configured additional catalog sources (Variant B) | 5 | Core+Shell+CLI | platform minor |

### Delivery status (2026-07-05)

| WS | Status |
| --- | --- |
| **WS1** | **Shipped** — PR #105, platform 0.31.0. `catalogMetadata` block, normalized + persisted + surfaced on `AppSummary`. |
| **WS2** | **Shipped** — PR #106, platform 0.32.0. `CatalogService` + `HttpCatalogDocumentFetcher` (streaming byte-cap) + `CatalogEndpoints`; `HOSTY_CATALOG_SOURCES` config; strict `schemaVersion` check. Install/update reuse existing endpoints (no new install path). |
| **WS3** | **Shipped** — PR #107, Shell 0.19.0. `/marketplace` storefront (cards, search, category chips) + `CatalogAppDetailsDialog`; install via the existing review dialog seeded with a version's `manifestRef`. |
| **WS6** | **Shipped** — public [`hosty-catalog`](https://github.com/alex-de-haas/hosty-catalog): `marketplace.0.1` schemas, dependency-free validate/generate tooling, PR-gate + Pages-publish workflows, an app-submission issue form, and a seed entry. Live at `https://alex-de-haas.github.io/hosty-catalog/catalog.json`. |
| **WS4 / WS5 / WS7** | **Deferred** — CLI `hosty catalog`, index/feed signing (ECDsa P-256), and federation. |

**End-to-end verified (2026-07-05):** a Core 0.32.0 configured with
`HOSTY_CATALOG_SOURCES=https://alex-de-haas.github.io/hosty-catalog/catalog.json` served the
published catalog and feed through `GET /api/catalog/apps[/{id}]` (list + version resolution).
Installed CLI launches now include that official catalog source in `launch.env` by default. Operators
can override it with `hosty config set HOSTY_CATALOG_SOURCES <comma-separated-sources>`, restore it
with `hosty config reset HOSTY_CATALOG_SOURCES`, or clear it with
`hosty config set HOSTY_CATALOG_SOURCES=` before restarting Core. A direct Core process still reads the plain
`HOSTY_CATALOG_SOURCES` environment variable and serves an empty catalog when it is unset.

Critical path: **WS1 -> WS2 -> WS3/WS4**; **WS6** parallels WS2 (WS2 develops against a
local fixture `catalog.json`); **WS5** attaches once WS6 publishes a signed index; **WS7**
after MVP. Smallest shippable MVP = WS1 + WS2 + WS3 + WS6 with one official source, unsigned.

Per-phase = platform minor bump (C2); Shell tracks its own minor. AOT: every new DTO is
registered in `CoreJsonSerializerContext`; ECDsa P-256 is AOT-proven (B3 spike). No
signing/verification scaffolding exists in Core today (only HMAC app-identity), so **WS5 is
net-new**.

## Links

- [Update channels](../ideas/update-channels.md) - refined by this document (app channels folded in; product channels retained).
- [Runtime app repository install](../ideas/runtime-app-repository-install.md)
- [Runtime source extensions](../ideas/runtime-source-extensions.md)
- [Runtime app manifest](runtime-app-manifest.md)
- [Final Hosty architecture](final-hosty-architecture.md)
- [Runtime artifact & storage model](runtime-artifact-model.md) - the artifact-kind foundation this builds on.

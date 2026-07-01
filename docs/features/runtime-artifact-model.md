# Runtime Artifact & Storage Model

> **Status: partially implemented.** Phase 0 (the `localCommand` `setup` command) and Phase 1a (the `development` flag) have shipped. Phases 1b–3 below are proposed, not built. This document is the concrete elaboration of the artifact-kind direction sketched in [Runtime app marketplace](../ideas/runtime-app-marketplace.md) ("Artifacts, Runtimes, and Delivery"), and it supersedes the single-source assumptions in [Runtime source workflows](runtime-source-workflows.md) as those phases land.

## Motivation

Today the platform conflates two independent axes:

- **Execution** — *how* a service runs: `docker` (container) or `localCommand` (host process).
- **Artifact kind** — *what* runs and *how it updates*: a compiled image, a compiled non-container build, or a live source tree.

In the current implementation these are welded together: [`ResolveArtifactKind`](../../apps/core/src/Haas.Hosty.Core/RuntimeAppManifest.cs) infers `docker → image` and `localCommand → source`, and rejects `prebuilt` as unsupported. So `localCommand` *is* source, in practice. Three consequences fall out of that:

1. **No place for a compiled, non-container artifact.** An app cannot declare a runtime that runs a pre-built binary or a compiled Next.js standalone output as a host process — only "build/run from source" or "docker image".
2. **Storage is keyed by app, not by runtime.** Managed source lives at `sources/<app-id>/`, one checkout per app. An app that wants *two* `localCommand` runtimes — one from source, one from a compiled build — has nowhere to keep the second artifact, and the two would collide.
3. **Liveness is a hidden special case attached to the wrong thing.** The live model (no lock, re-fetch/edit, hidden Update button, Live badge via `IsLiveSourceApp`) hangs off the runtime *type* + "there's an operator folder". But *running from source* does not imply *live*: a source runtime that compiles a production build (`npm run build` → `npm start`) is **not** live — it updates via a reviewed commit bump — while a source runtime running `npm run dev` **is** live (hot-reload). Both run from the same checkout. So liveness must be an **explicit, declared** property of the runtime, and today's inference mislabels the build-to-production case as Live.

The target scenarios this model must support:

> **(a)** One app declares two `localCommand` runtimes off the **same source**: one runs `npm run build` → `npm start` (production, **locked**, updated via commit bump); the other runs `npm run dev` (**live**, hot-reload). They differ only in liveness.
>
> **(b)** One app declares a `localCommand` runtime that runs an **already-compiled** artifact (a binary or compiled Next.js standalone) — a `prebuilt`, content-hash-locked release with no build step.
>
> Switching between runtimes switches the artifact source, the on-disk storage, *and* the update model.

## Model: execution × artifact kind

The primary classifier is **artifact kind**, declared per service-runtime via the existing `artifact` field. Execution type stays orthogonal.

| Artifact kind | What it is | Delivery (examples) | Update / liveness model | On-disk lock |
| --- | --- | --- | --- | --- |
| `image` | Compiled OCI image | OCI registry | Locked: tag → digest; reviewed update advances the digest (or `rolling` re-resolves each start) | Digest, in Docker store |
| `prebuilt` | Compiled non-container build (binary, compiled Next.js standalone, static bundle) | git release / folder / URL / OCI-as-files | Locked: content hash; reviewed update advances the hash | Content hash, in Hosty FS |
| `source` | Buildable/editable source tree | git checkout / operator-owned worktree | **Live *or* locked** — decided by the `live` flag, not by the kind (see below) | commit (locked) / none (live) |

Guiding rule (from the marketplace idea): **the update model is chosen by artifact kind, not by runtime type.** `localCommand` by itself classifies nothing — one may run a `prebuilt` build, another `source`.

**Delivery does not imply kind.** Git can deliver a *compiled* build, not only source; a folder can hold a pre-built app. So the kind is declared, not inferred from where the bytes came from.

### The `development` flag — a declared marker, not a consequence of the kind

The first draft of this model said "`kind=source` ⟹ live". That is wrong. The **same** source tree can back two different runtimes:

- a runtime whose `setup` **compiles** it and runs the production build (`npm ci && npm run build` → `npm start`) — edits do nothing until rebuilt; it advances by a reviewed **update** that bumps the pinned commit;
- a runtime whose `setup` does `npm install` and runs a dev server (`npm run dev`) — local edits are picked up on the fly; there is no reviewed-update path.

Both are `type: localCommand`, `artifact: source`, from the same checkout. What separates them is **the developer's declaration that a runtime is meant for local development** — not anything about the specific command. So this is a **declared per-runtime flag** (provisionally `development`; naming open — see below), *not* something inferred from the artifact kind, the runtime type, or the command string:

```jsonc
"runtimeProfiles": [
  { "key": "release", "type": "localCommand" },                     // development defaults to false → locked
  { "key": "dev",     "type": "localCommand", "development": true } // meant for local development
]
```

The flag is **not** tied to `npm run dev` or any particular command — the developer decides which runtime is the development one. Marking a runtime `development: true` has two coupled consequences:

1. **Source override is allowed.** The operator may point this runtime at their own local folder (the existing `source-override`). A non-development runtime runs only its declared/pinned source and offers no override.
2. **It runs live.** It executes against a mutable working copy (the override folder, else the managed checkout) with no lock and no reviewed-update path; clients show the **Live** badge and hide **Update**.

The flag is only valid where the delivery is an editable working copy (`artifact: source`). `image` and `prebuilt` are inherently locked and cannot be `development`.

| Runtime | type | artifact | development | setup / command | Override? | Update model |
| --- | --- | --- | --- | --- | --- | --- |
| Docker image | docker | image | — | (image) | no | Locked: digest, reviewed update |
| Compiled build (downloaded) | localCommand | prebuilt | — | run `command` | no | Locked: content-hash, reviewed update |
| **Build-from-source → prod** | localCommand | source | **false** | `npm ci && npm run build` → `npm start` | no | Locked: **commit**, reviewed update |
| **Development** | localCommand | source | **true** | e.g. `npm install` → `npm run dev` | **yes** | **Live**: edit in place, no lock, no update |

The two bottom rows are the user's scenario, and they differ **only** in the `development` flag.

**Naming is open.** `development` describes intent; `live` describes only the update-behavior half; `dev` is short but collides with the common runtime *key* `"dev"`. This document uses `development` provisionally.

```mermaid
flowchart TB
  K["artifact: image | prebuilt | source"] --> Lk{"kind"}
  Lk -->|image / prebuilt| L["Locked\ndigest / content-hash\n+ reviewed update"]
  Lk -->|source| Lv{"development?"}
  Lv -->|false default| LS["Locked to a commit\nsetup builds once per version\n+ reviewed update\nno source override"]
  Lv -->|true| V["Live\nmutable working copy\nedit in place\nno lock, no update\nsource override allowed"]
```

### Coverage matrix (current vs planned)

| | `docker` | `localCommand` |
| --- | --- | --- |
| `image` | ✅ implemented | — (n/a) |
| `prebuilt` | reserved (docker-from-image is the `image` cell) | 🔜 **Phase 2** |
| `source`, `development: true` | out of scope (docker-built-from-source — see Open questions) | ✅ implemented (dev/live is inferred today; **Phase 1a** makes it a declared flag) |
| `source`, `development: false` (build → prod) | out of scope | 🔜 **Phase 1a** (today Core would wrongly flag it Live and offer override) |

## Storage layout

Move all runtime assets under the app directory, keyed by **(app, runtime)** so switching a runtime never clobbers another runtime's materialized artifact. Retire the top-level `sources/` tree.

```
~/.hosty/apps/<app-id>/
  state.json                         # AppRecord (unchanged)
  manifest.json                      # manifest copy (unchanged)
  data/                              # app data — backed up (unchanged)
  runtimes/<runtime-key>/
    source/                          # kind=source: git checkout   (was ~/.hosty/sources/<app-id>)
    build-cache/                     # kind=source: build output cache (.next, bin/…), optional
    artifact/<content-hash>/         # kind=prebuilt: immutable extracted build
    current -> artifact/<hash>       # active-version pointer == the on-disk lock
    logs/<service>.log               # (optional) move localCommand logs under the runtime
```

Rationale:

- **App-scoped.** Everything for an app is under `apps/<id>/`; removal is a single subtree delete; no orphan `sources/` entries to garbage-collect.
- **Per-runtime, non-destructive switch.** Switching runtimes activates a different subtree; the previous runtime's `source/` or `artifact/<hash>/` survives, so switch-back is cheap.
- **`source/` is a live worktree.** A managed git checkout, or a *reference* to the operator's own worktree (override folders are referenced, never copied).
- **`artifact/<hash>/` is content-addressed and immutable.** `current` is the analog of the Docker digest lock, but on Hosty's filesystem. `prebuilt` thus gets exactly the lock semantics `image` already has.

Materialization is lazy: only the *selected* runtime needs its artifact present to start. Unselected runtimes may be un-materialized until first selected.

## Runtime artifact state

`AppSourceState` is currently a single record per app (one `ManagedCheckoutPath`, one `LocalOverridePath`), and `ArtifactLocks` is a separate map keyed by service key (docker images only). Generalize both into one **per-runtime artifact state**, keyed by runtime key:

```
RuntimeArtifactState (per runtime key)
  kind            : image | prebuilt | source
  delivery        : oci | git | folder | url
  development     : bool                            (source only; true = dev runtime, overridable, live)
  sourceRef       : resolved ref + commit           (kind=source / git-delivered)
  lock            : digest | contentHash | commit   (locked runtimes; absent when development)
  materializedPath: apps/<id>/runtimes/<key>/…       (or Docker store for image)
  operatorOverride: operator-owned path              (per development runtime — the source override)
  updatedAt
```

This folds the existing `ArtifactLocks` (image digests) and `AppSourceState` (source checkout/override) into one shape, extends it to `prebuilt` content-hash locks and **source-build commit locks**, and records the runtime's `development` flag. Per-runtime `operatorOverride` is the 1b shape; **1a keeps the existing single app-level override** (bound to the one development runtime — decision 6). Persisted additively in `state.json`.

### Where `setup` fits

The `localCommand` `setup` command ([shipped, Phase 0](runtime-app-manifest.md)) is the **build/prepare hook for `artifact: source`**, in *both* modes:

- `development: true` — `setup` installs deps (`npm install`) so the dev server can run; it runs every start (idempotent).
- `development: false` — `setup` **compiles** the pinned commit (`npm ci && npm run build`) to produce the production build the `command` serves; conceptually it runs once per locked version.

For `kind=prebuilt` there is no `setup` — the artifact is already built; its analog is the fetch → verify → extract → lock step at materialization time.

## Liveness & source override — the `development` flag

The `development` flag is declared per runtime, not inferred from kind or type (see "The `development` flag" above), and drives two derived facts:

- **`development: true`** (only valid for `artifact: source` on an editable working copy) → the runtime **supports source override** (operator points it at a local folder) and **runs live** against that folder (else the managed checkout): no lock, no reviewed-update path; clients show the **Live** badge and hide **Update**.
- **`development: false`** (default; the only option for `image`/`prebuilt`, and the default for `source`) → **no override**, and **locked** to a version (digest / content-hash / commit) advanced by a reviewed **update**. A source runtime here builds the pinned commit via `setup`.

This refines two existing derived flags:

- [`AppRecord.Live`](../../apps/core/src/Haas.Hosty.Core/AppRegistryStore.cs) / [`IsLiveSourceApp`](../../apps/core/src/Haas.Hosty.Core/CoreLifecycleService.cs) — today inferred from "non-URL install + selected runtime type `localCommand` + operator folder exists", which mislabels a build-to-production source runtime as Live. **Phase 1a** additionally requires the selected runtime declare `development: true`.
- [`AppSummary.SupportsSource`](../../apps/core/src/Haas.Hosty.Core/AppRegistryStore.cs) — today "non-URL install + **any** `localCommand` profile", which gates the Source tab. **Phase 1a** narrows it to "non-URL install + **any** profile with `development: true`", so the tab appears only when a development runtime exists.

## Manifest surface

Two per-runtime declarations drive the model: the existing `artifact` field (kind) and the new `development` flag. The user's target scenario — one Docker release plus two `localCommand` runtimes off the **same source**, one production-locked and one for development:

```jsonc
"runtimeProfiles": [
  { "key": "docker",  "type": "docker", "default": true },
  { "key": "release", "type": "localCommand" },                     // development defaults to false → locked
  { "key": "dev",     "type": "localCommand", "development": true } // development runtime: overridable + live
],
"services": [{
  "key": "web",
  "runtimes": {
    "docker": {
      "type": "docker",
      "artifact": "image",
      "image": { "repository": "ghcr.io/example/web", "tag": "latest" }
    },
    "release": {                      // build the pinned commit → run the production build (LOCKED)
      "type": "localCommand",
      "artifact": "source",
      "workingDirectory": "apps/web",
      "setup": "npm ci && npm run build",
      "command": "npm run start"
    },
    "dev": {                          // DEVELOPMENT: overridable + live; command is the developer's choice
      "type": "localCommand",
      "artifact": "source",
      "development": true,
      "workingDirectory": "apps/web",
      "setup": "npm install",
      "command": "npm run dev"
    }
  }
}]
```

`release` and `dev` are both `localCommand` + `source` from the same checkout; they differ only in `development`. A `prebuilt` runtime (downloaded compiled build) would instead declare `artifact: prebuilt` with a `delivery` block — its shape (git release asset / folder / URL / OCI-as-files) is deferred to Phase 2.

## Source override & the Source settings tab

The Shell lets the operator configure a development runtime's source override **without switching the app to that runtime**. The [Source settings tab](runtime-source-workflows.md) ([shipped](../../apps/shell)) is refined:

- **Visibility.** The tab shows only when `SupportsSource` is true — i.e. the app has a runtime profile with `development: true` (narrowed from "any `localCommand`"). No development runtime → no tab.
- **Target runtime.** Because a manifest may declare **at most one** `development: true` runtime (decision 6), the tab targets that single development runtime. The picker is rendered as a dropdown for forward-compatibility but currently holds one entry; it becomes a real choice only if the single-runtime rule is relaxed (deferred to 1b).
- **Override edit.** The tab shows/edits that runtime's override (Custom folder) or clears it (Standard = managed checkout), reusing the existing `source` / `source-override` / `source-clear-override` control routes. Phase 1a keeps the existing **single** app-level override, now bound to the development runtime and editable regardless of the currently selected runtime.

This needs `AppRuntimeProfileSummary` to carry the `development` flag (so the client can tell which runtime the tab targets and gate visibility). Per-runtime `operatorOverride` storage and a multi-entry dropdown are deferred to **Phase 1b**; **Phase 1a** ships the flag, the narrowed gating, and the single-override tab.

## Runtime switching

Switching remains the reviewed [`switch-runtime-plan` / `switch-runtime`](runtime-source-workflows.md) flow. The plan's `changes` already diff runtime type, commands, ports, etc.; it gains **artifact kind**, **`development`**, and **artifact source/lock** as diffed fields. Because per-runtime storage is non-destructive, switching `dev ↔ release` does not re-clone or re-download when the other runtime is already materialized and locked to the same version.

## Migration

- **Path move.** Installed apps with `sources/<app-id>/` migrate to `apps/<app-id>/runtimes/<selected-key>/source/`. Provide a one-time migration on Core start (move + rewrite `ManagedCheckoutPath`), with back-compat resolution that still reads the old path until migrated.
- **State shape.** `AppSourceState` + `ArtifactLocks` → per-runtime `RuntimeArtifactState`. Additive `state.json` change with lazy backfill (TOFU), consistent with how `ArtifactLocks` backfills today.
- **CLI.** `source-*` commands keep working against `kind=source` runtimes; `source-cleanup` scans the new per-app runtime dirs instead of the retired `sources/` root.

## Phasing

- **Phase 0 — shipped.** `localCommand` `setup` command (build hook for `artifact: source`). See [Runtime app manifest](runtime-app-manifest.md).
- **Phase 1a — shipped.** `development` flag on the runtime profile, validated source-only and **at most one per manifest** (`app_manifest_development_requires_local_command` / `app_manifest_multiple_development_runtimes`), surfaced on `AppRuntimeProfileSummary`. `IsLiveSourceApp`/`AppRecord.Live` and `SupportsSource` now require a `development: true` runtime; the in-repo `hosty.shell` / `demo-app` `dev` profiles declare it. The Source settings tab already gates on `SupportsSource`, so it now hides unless a development runtime exists and targets that runtime's (single, app-level) override without a runtime switch. This fixes the prior mislabeling of a build-to-production source runtime as Live/overridable, and unblocks "same source, two runtimes (release vs dev)". A `development: false` source runtime is a locked, reviewed-update artifact (its commit lock lands with the build-to-prod path in a later phase). Multi-entry override dropdown deferred to 1b (single-runtime rule).
- **Phase 1b — storage & state refactor.** Move to `apps/<id>/runtimes/<key>/…`; generalize `AppSourceState`/`ArtifactLocks` → per-runtime `RuntimeArtifactState` (incl. per-runtime `operatorOverride`); migration. Also where multiple development runtimes + the multi-entry override dropdown would land, if the single-runtime rule is relaxed. No new user-visible behavior for the single-runtime case — pure refactor for `source`/`image`.
- **Phase 2 — `prebuilt` kind.** Implement `artifact: prebuilt`: **folder + git-release-asset** delivery first (URL / OCI-as-files deferred — decision 7), content-hash lock, fetch/verify/extract into `artifact/<hash>/`, reviewed update. Per-runtime artifact-source selection in CLI.
- **Phase 3 — Shell.** Runtime switching UI that surfaces the human distinction **"Runs from source (live)"** vs **"Runs a built release (locked)"** (from the `development` flag), and per-runtime update-available state.

## Resolved decisions

1. **Flag placement — profile-level.** `development` sits on the `runtimeProfiles[]` entry (a whole-runtime property; all services run live together), not on `services[].runtimes[key]`.
2. **One flag, two consequences.** `development` couples *source-override capability* and *live update model*. It stays a single flag; splitting into `overridable` + `live` is reserved for a future use case that needs them apart.
3. **Back-compat — explicit opt-in.** After Phase 1a, `SupportsSource`/`Live` require `development: true`. Rather than inferring it for any `localCommand`+`source` (which would flip the "default locked" rule and force build-to-prod runtimes to opt *out*), development runtimes opt in explicitly, and the in-repo `hosty.shell` / `demo-app` `dev` profiles gain `development: true` as part of 1a.
4. **`development: false` source = commit lock, reviewed update by default; `rolling` is an explicit opt-in.** A build-to-production source runtime pins its commit and advances via reviewed update. A ref-re-fetch-every-start (`rolling`) mode, mirroring the docker image `rolling` policy, is available only when explicitly opted in (deferred; not in the first cut).
5. **Storage — retire `sources/` with a one-time migration.** Move to `apps/<id>/runtimes/<key>/…` (Phase 1b) rather than keeping `sources/` and layering an override map on top.
6. **Single development runtime for now.** A manifest may declare **at most one** `development: true` runtime (new validation, `app_manifest_multiple_development_runtimes`). One development runtime ⇒ one override suffices, so Phase 1a keeps the existing single app-level override (bound to that runtime) instead of a per-runtime override map. Relaxing this to multiple development runtimes (and per-runtime override storage) is deferred to 1b.
7. **`prebuilt` delivery — folder + git-release asset first.** Phase 2 implements the folder and git-release-asset deliveries; URL and OCI-as-files are deferred.
8. **`localCommand` → `localProcess` rename — deferred.** Cosmetic; not worth the manifest churn now.
9. **`docker` built from source — out of scope.** The `image` cell covers docker today.

## Open questions / out of scope

- **Flag name — decided: `development`.** (`live` describes only the update half; `dev` collides with the common runtime key `"dev"`.)
- **Private repositories & multi-repo source** — tracked in [Runtime source extensions](../ideas/runtime-source-extensions.md).
- **`prebuilt` URL / OCI-as-files delivery** — deferred past the folder + git-release-asset first cut (decision 7).
- **`rolling` mode for a source build-to-prod runtime** — deferred (decision 4).
- **Multiple `development` runtimes + per-runtime override storage** — deferred (decision 6).

## Related

- [Runtime app marketplace](../ideas/runtime-app-marketplace.md) — the artifact-kind direction this elaborates.
- [Runtime source workflows](runtime-source-workflows.md) — current source checkout / override / switching (single-source model this evolves).
- [Runtime app manifest](runtime-app-manifest.md) — `artifact` field, `setup`, per-runtime service fields.
- [Runtime app update](runtime-app-update.md) — lock + reviewed-update mechanics for compiled artifacts.

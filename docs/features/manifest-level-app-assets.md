# Manifest-Level App Assets

Status: **Planned — design confirmed 2026-07-07, nothing implemented.** All
decisions Q1–Q13 (including the Q3/D1–D7 endpoint design) are confirmed.
Promoted from `docs/ideas/manifest-level-app-assets.md`.
Created: 2026-07-07

## Motivation

Display assets (icons, screenshots) currently live at the **catalog** level:
the `hosty-catalog` repo stores them under `apps/<id>/assets/`, and the publish
pipeline rewrites relative paths to absolute URLs and copies the files into
`dist/`. That model cannot give icons to installed apps (folder installs,
git-URL installs, anything outside a catalog), duplicates assets per catalog
under federation, and makes every icon change a catalog PR.

This feature makes the **app repository the source of truth for its display
assets** — icon, screenshots, and a markdown description — stored under the
manifest's folder and referenced from `catalogMetadata`. Core serves them for
installed apps (sidebar, Installed Apps, app details), and the catalog vendors
them from the app repo at publish time for the storefront.

Why manifest-level wins:

- The manifest contract already points there: `catalogMetadata.icon` is
  documented as "an asset path or URL" resolved relative to the manifest.
  Today that is a dangling pointer — nothing serves the file.
- Icons become available for **all** installed apps, catalog or not, because
  Core has the manifest source locally.
- With catalog federation (WS7, shipped), one app listed in two catalogs means
  two drifting copies of the same icon; a manifest-level asset is one copy.
- Less submission friction: authors stop committing binaries to the catalog
  repo and re-PRing every icon change.

Git-repo installs are expected to become the primary install path over time;
the asset model leans into that while degrading gracefully for every other
path (folder, manifest-by-URL, image-only).

## Goals and Non-Goals

Goals:

- Serve app display assets from under the manifest's folder for every install
  kind, through one Core endpoint.
- Real images in Shell: sidebar app links, sidebar page links (`ui.pages`),
  Installed Apps, app details.
- A markdown description page (`catalogMetadata.descriptionFile`) rendered on
  the marketplace detail page and reusable for installed apps.
- Catalog publish vendors assets from app repos; hand-hosted copies in
  `hosty-catalog` are deprecated.

Non-goals:

- No automatic README pickup — the description is only ever the explicitly
  declared `descriptionFile` (a repo README is often developer-facing;
  publishing it to the storefront must be the author's explicit call).
- No storefront hotlinking to author-mutable URLs (see Boundaries).
- No SVG content sanitization — response headers make direct opens inert
  instead.
- Asset problems never gate install/update; everything here is display-only,
  same rule as the rest of `catalogMetadata`.

## Current Behavior

- demo-app's manifest has no `catalogMetadata` block; its icon exists only as
  a hand-copied file in the `hosty-catalog` repo, rewritten to a Pages URL at
  publish (`generate-catalog.mjs` `rewriteAsset`).
- Core normalizes `catalogMetadata` onto `AppSummary` but has no endpoint that
  serves a referenced file.
- Shell never reads `catalogMetadata.icon` for installed apps; sidebar app and
  page links render Lucide names (`ui.icon`) only. The marketplace page
  renders `<img src={app.icon}>` from the published catalog URL.

## Design

### Asset root (D1)

Every app has one **asset root: the manifest's folder**, defined identically
for every install kind:

- **git install** — the checkout subtree containing the manifest.
- **folder install** — the internal copy (already exactly that folder).
- **manifest-by-URL** — the manifest URL base ("folder", just remote; fetched,
  not enumerable).

The git checkout root is deliberately *not* the root: in a monorepo an app
cannot serve sibling apps' or repo-level files, the internal copy vendors only
the app subtree, and for the common single-app repo (manifest at repo root)
the folder is the whole repo anyway — nothing is lost where it matters.
Accepted cost: monorepo-shared assets get duplicated or build-copied into each
app folder. "Manifest at the app folder's root" becomes a load-bearing
convention (hosty-app-skill already scaffolds it).

### Asset endpoint (D2–D6)

`GET /api/apps/{id}/assets/{path}` on the **web plane**, any authenticated
session (Q4: `host.user` sees the sidebar too; admin-only would break the main
consumer). Not on the control plane — the CLI has no use for image bytes.

- **Wire format (D2).** Only canonical root-relative paths: no `.`/`..`/empty
  segments, no backslashes, no drive letters or `:` in segments (NTFS
  alternate data streams — prod hosts include Windows). With the root at the
  manifest folder no legitimate `..` exists, so dot segments are rejected
  outright, never resolved. Whoever emits a URL — Core building `iconUrl`,
  the markdown renderer rewriting `img src` — resolves relative refs to
  canonical paths before they reach the wire; the endpoint does no traversal
  resolution at all.
- **Symlink containment (D3).** The one enforced check that remains: the
  realpath of the final target (junctions included on Windows) must sit under
  the realpath of the root, comparing canonicalized paths on both sides
  (case-insensitive filesystems defeat naive prefix checks). A repo shipping
  `icon.png -> ../../secret` gets a 404.
- **Allowlist and content type (D4).** `svg png webp jpg jpeg gif avif md`
  (gif because animated README previews are common practice). Content-Type
  derives from the extension only, never sniffed. Any `.md` in the folder is
  technically fetchable — accepted; Shell renders only the declared
  `descriptionFile`.
- **Response headers (Q6).** Every response carries
  `X-Content-Type-Options: nosniff` and
  `Content-Security-Policy: default-src 'none'; sandbox`, so navigating
  directly to an SVG never executes scripts, without content sanitization.
- **Visibility (D5).** Assets are readable by any authenticated session; the
  manifest-folder root keeps that radius to exactly the folder the operator
  installed. Documented rule: the app folder is not a place for secrets.
- **Caching (D6).** URL emitters append `?v=<commit or content hash>`;
  responses carrying `v` get `Cache-Control: public, max-age=31536000,
  immutable`, responses without it get a content-hash ETag. Development Mode
  URLs are always versionless with a short max-age.
- Missing/oversized/disallowed targets are a plain 404 without path detail.

### Vendoring and serving source (Q1, Q2, D7)

- **Install/update:** copy the asset subtree (git/folder) or fetch the
  declared-plus-parsed set (manifest-by-URL: icon, screenshots,
  `descriptionFile` and the images it references) into the app's **internal
  copy** — same idiom as the manifest internal copy — so assets work for
  image-kind apps and survive upstream repo deletion.
- **Development Mode / live-source apps:** serve directly from the source
  checkout so an icon or description edit shows up without an update,
  matching live-source semantics elsewhere.
- **Budgets (D7):** icon ≤ 512 KB, screenshot ≤ 2 MB (schema caps count at 8),
  description ≤ 256 KB. Manifest-by-URL vendoring additionally capped at
  ~32 files / 20 MB total. Violations are treated-as-absent and logged — an
  install never fails over display assets; an unreachable asset simply means
  no icon.
- Uninstall cleanup rides the existing internal-copy removal.

### Manifest contract additions

```json
"catalogMetadata": {
  "icon": "assets/icon.svg",
  "screenshots": ["assets/1.png"],
  "descriptionFile": "README.md"
},
"ui": {
  "pages": [
    { "path": "/reports", "title": "Reports", "icon": "BarChart", "iconAsset": "assets/reports.png" }
  ]
}
```

- `catalogMetadata.descriptionFile` — **new**: manifest-relative path to a
  markdown document. `README.md` is the expected common value, but there is
  no automatic pickup, and an explicit field lets authors point at
  `docs/store.md` instead. Inline `description` stays as the fallback for
  repo-less installs and short descriptions.
- `ui.pages[].iconAsset` — **new**: optional manifest-relative image path,
  served through the same endpoint, rather than overloading the Lucide `icon`
  with a second meaning. Fallback chain: `iconAsset` → page Lucide `icon` →
  app icon.
- Both stay outside runtime `app.0.1` validation, like the rest of
  `catalogMetadata` (well-formedness still applies).

### Resolved URLs on `AppSummary` (Q7)

Core — the URL emitter per D2 — resolves manifest-relative declarations to
canonical asset URLs and surfaces them:

- `iconUrl` — Core-origin-relative path with the D6 version query. An absolute
  `https` value in `catalogMetadata.icon` passes through unchanged.
- `descriptionUrl` — same treatment for `descriptionFile`.
- each surfaced `ui.pages` entry gains its resolved `iconUrl`.

Shell never computes asset paths itself.

### Shell rendering (Q8, Q12)

- Sidebar app items, sidebar page links, and Installed Apps render
  `<img src={iconUrl}>` with the existing Lucide fallback chain.
- App details (installed) and the marketplace detail page render the markdown
  description with `react-markdown` + `remark-gfm` (GFM tables/task lists are
  table stakes for READMEs; lazy-loaded so the cost lands on detail pages,
  not the sidebar). Inline HTML is inert **structurally**: react-markdown
  renders to React elements with no `dangerouslySetInnerHTML`, and raw HTML
  stays text unless `rehype-raw` is added — which it never is. No sanitizer
  needed; same reject-don't-sanitize philosophy as D2.
- **Resolution base.** Relative refs inside the markdown resolve against the
  `descriptionFile`'s own folder (standard markdown semantics:
  `docs/store.md` + `./img/a.png` → `docs/img/a.png`). The renderer takes a
  `base` — the asset-endpoint URL of the md's folder (installed apps, `?v`
  propagated) or the vendored md's published URL (storefront) — one resolver
  for both surfaces. Refs escaping the asset root render as plain alt text.
- **External absolute image refs render as links, not inline images.**
  Otherwise the storefront still pulls mutable third-party content through
  the description body, defeating the no-hotlinking boundary; it also keeps a
  future `img-src` CSP tightening possible (today Shell's CSP is only
  `frame-ancestors 'none'`). README badges degrade to links — accepted;
  storefront-minded authors point `descriptionFile` at a dedicated
  `docs/store.md`.
- Details: `loading="lazy"` and `max-width:100%` on images;
  `target="_blank" rel="noopener noreferrer"` on external links;
  react-markdown's default `urlTransform` already strips `javascript:` URLs.
  Relative non-image links resolve against `links.website` when present,
  otherwise render as plain text.

### Catalog publish-time vendoring (Q9, Q13)

`generate-catalog.mjs` extends per entry, staying zero-dependency (plain Node
plus global `fetch`):

1. Resolve the feed's `stable` tag (highest version when the feed has no
   tags) and fetch the manifest behind it.
2. Read `catalogMetadata.icon` / `screenshots` / `descriptionFile`; resolve
   each against the manifest URL base; download.
3. **Discover — never rewrite** — the description's relative image refs via
   regex (`![...](...)`, `<img src="...">`, reference definitions
   `[label]: path`) and download them too, **preserving the relative layout**
   under `dist/apps/<id>/`. The vendored md stays byte-identical to the
   author's file: render-time base resolution (Q12) makes publish-time
   rewriting unnecessary, a discovery miss degrades to a visibly broken image
   at review while a mutation bug would corrupt content, and a byte-identical
   file stays diffable at review and hashable/signable under a future WS5.
4. Emit a generated `display.descriptionUrl` on the published entry.

Publish budgets mirror D7: description ≤ 256 KB, image ≤ 2 MB, ~32 files /
20 MB per app. `entry.display.icon` remains a fallback/override for apps with
no public repo (pure OCI image + manifest-by-URL). Asset *absence* is fine and
the build proceeds; a *failed fetch* of a declared asset fails the build — and
an image referenced by the description is declared-by-reference, so its failed
fetch fails the build too. Absolute http(s) refs are left untouched (Shell
renders them as links per Q12). Hand-hosted `apps/*/assets/` keeps validating
but is documented as deprecated (Q10); schema stays `marketplace.0.1` — purely
additive.

## Data Model / API Changes

- **New web endpoint:** `GET /api/apps/{id}/assets/{path}` (session auth; GET,
  no CSRF; D2–D6 semantics).
- **`AppSummary`:** + `iconUrl`, + `descriptionUrl`; surfaced `ui.pages`
  entries + `iconUrl`. Additive, registered in `CoreJsonSerializerContext`
  (AOT).
- **Manifest (`app.0.1`):** + `catalogMetadata.descriptionFile`,
  + `ui.pages[].iconAsset` — optional, outside runtime validation.
- **Install pipeline:** asset vendoring step (subtree copy / declared+parsed
  fetch with D7 budgets) on install and update; live-serve for Development
  Mode.
- **Catalog (`hosty-catalog`):** publish-time vendoring; generated
  `display.descriptionUrl`; no schema version bump.

## Confirmed Decisions

| # | Decision |
| --- | --- |
| **Q1** | Relative paths resolve against the manifest's own location (folder / URL base); fetched at install into the internal copy; unreachable assets never fail an install. |
| **Q2** | Vendor into the internal copy at install/update; Development Mode serves live from the source checkout. |
| **Q3** | Arbitrary paths under the **manifest-folder asset root**; D1–D7 design above. (Revised from "declared assets only"; then root narrowed from checkout root to manifest folder.) |
| **Q4** | Web plane, any authenticated session; not on the control plane. |
| **Q5** | Allowlist per D4; icon ≤ 512 KB, screenshot ≤ 2 MB, description ≤ 256 KB; violations treated-as-absent, logged. |
| **Q6** | `nosniff` + `CSP: default-src 'none'; sandbox` on every asset response; no SVG sanitization. |
| **Q7** | `AppSummary` exposes resolved `iconUrl` (and `descriptionUrl`); absolute `https` manifest values pass through. |
| **Q8** | New `ui.pages[].iconAsset`; fallback `iconAsset` → Lucide `icon` → app icon. |
| **Q9** | Catalog vendoring fetches at the feed's `stable` ref; `entry.display.icon` stays as override; failed fetch of a declared asset fails the publish build. |
| **Q10** | Purely additive; `marketplace.0.1` unchanged; hand-hosted catalog assets deprecated, demo-app converts first. |
| **Q11** | Explicit `descriptionFile` only — no automatic README pickup. |
| **Q12** | `react-markdown` + `remark-gfm`, inline HTML structurally inert (no `rehype-raw`, no sanitizer); render-time resolution against the `descriptionFile`'s folder as base, one resolver for installed + storefront; external absolute images render as links; ≤ 256 KB. |
| **Q13** | Publish vendoring **discovers** (regex) and downloads description images preserving relative layout — the md is never rewritten, stays byte-identical; budgets mirror D7; a referenced image's failed fetch fails the build (declared-by-reference). |

## Workstreams and Build Order

| WS | Scope | Side | Version |
| --- | --- | --- | --- |
| **A1** | Manifest contract (`descriptionFile`, `ui.pages[].iconAsset`) + asset-root resolution + install/update vendoring (budgets, treated-as-absent) + `GET /api/apps/{id}/assets/{path}` with D2–D6 guards + resolved URLs on `AppSummary` + AOT registration | Core | platform → 0.35.0 |
| **A2** | Shell rendering: sidebar app/page icons + Installed Apps icons (`<img>` + Lucide fallback), markdown description in app details and marketplace detail (`react-markdown` + `remark-gfm`, render-time base resolution) | Shell | Shell → 0.22.0 |
| **A3** | demo-app as reference: `assets/icon.svg` moved from the catalog repo, `catalogMetadata` block + `descriptionFile` in its manifest | demo-app | manifest bump |
| **A4** | Catalog publish-time vendoring (fetch at stable ref, regex image discovery, layout-preserving vendoring, `display.descriptionUrl`), deprecate hand-hosted assets, README update | hosty-catalog | — |

Critical path: **A1 → A2**; **A3** parallels A2 (and gives A2/A4 a real app to
verify against); **A4** last — the storefront keeps working on hand-hosted
assets until then. Live E2E: install demo-app from the published catalog,
verify sidebar icon + description page; then a folder install of the same app
to verify the catalog-independent path.

## Testing

- Path guard unit tests: dot segments, empty segments, backslashes, `:`
  segments (ADS), URL-encoded variants, case-insensitive prefix collisions,
  symlink/junction escapes → 404.
- Vendoring: budgets (count/total/per-file), treated-as-absent on violation,
  declared+parsed set for manifest-by-URL, Development Mode live-serve.
- Header assertions: nosniff + CSP on every asset response; immutable caching
  only with `v`.
- Shell: Lucide fallback when `iconUrl` absent; raw HTML in markdown renders
  as text; relative-ref base resolution (including refs escaping the root →
  plain alt text); external absolute images render as links.
- Catalog: regex discovery forms (`![...](...)`, `<img src>`, reference
  definitions); build failure on referenced-image fetch failure; vendored md
  byte-identical to source.

## Boundaries

- **No hotlinking from the storefront.** The published catalog must not point
  at mutable author URLs: the image could change after catalog PR review, and
  WS5 signing covers the feed, not asset bytes. Vendoring at publish keeps the
  storefront self-contained, CDN-cached, and frozen at review time.
- Everything served must live under the manifest's folder. Nothing above it
  (sibling apps in a monorepo, the repo root) is ever reachable, however the
  path is spelled. The folder is visible to any authenticated user — not a
  place for secrets.
- Display-only, never part of runtime validation; asset failures never gate
  install or update.
- Git-repo installs are expected to become the primary install path, but
  folder, manifest-by-URL, and image-only installs stay supported with
  graceful degradation.

## Open Questions

- Whether the installed-app details view should also show locally served
  screenshots (trivial once the endpoint exists; not required for v1).

## Links

- [Runtime app marketplace](runtime-app-marketplace.md) — catalog model this
  extends (WS1 `catalogMetadata`, WS6/WS7 catalog + federation).
- [Runtime app manifest](runtime-app-manifest.md) — `catalogMetadata` section
  to update when A1 ships.
- [`hosty-catalog`](https://github.com/alex-de-haas/hosty-catalog) — publish
  pipeline (A4).

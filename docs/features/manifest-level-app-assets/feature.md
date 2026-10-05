---
created: 2026-07-07
updated: 2026-10-05
summary: An app's icon, screenshots and markdown description live in its own repository and Core serves them for installed apps.
components: [apps/core, apps/shell, apps/marketplace]
---

# Manifest-Level App Assets

The app repository is the source of truth for its display assets — icon, screenshots and a
markdown description — stored under the manifest's folder and referenced from `catalogMetadata`.
Core serves them for installed apps, whether or not they came from a catalog, and the catalog vendors
them from the app repository at publish time for the storefront.

## Asset Root

Every app has one asset root: **the manifest's folder**. For a Git install it is the checkout subtree
containing the manifest; for a folder install, the internal copy of that folder; for a manifest
installed by URL, the URL's base (fetched, not enumerable). The repository root is not the asset
root: in a monorepo an app cannot serve sibling apps' or repository-level files. Assets shared across
a monorepo are copied into each app folder.

## Manifest Fields

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

- `catalogMetadata.descriptionFile` is a manifest-relative markdown document. There is no automatic
  `README.md` pickup; authors can point at a dedicated `docs/store.md`. Inline `description` remains
  the fallback.
- `ui.pages[].iconAsset` is an optional manifest-relative image. The fallback chain is
  `iconAsset` → the page's Lucide `icon` → the app icon.
- Both stay outside runtime `app.0.1` validation, like the rest of `catalogMetadata`.

## Asset Endpoint

`GET /api/apps/{appId}/assets/{path}` serves assets to any authenticated session. It is not on the
control plane.

- **Canonical paths only.** No `.`, `..` or empty segments, no backslashes, no drive letters or `:`
  in segments. URL emitters resolve relative references before they reach the wire; the endpoint
  resolves nothing.
- **Symlink containment.** The real path of the target, junctions included, must sit under the real
  path of the root, compared ordinally after canonicalization.
- **Allowlist.** `svg png webp jpg jpeg gif avif md`. The content type comes from the extension and
  is never sniffed.
- **Headers.** Every response carries `X-Content-Type-Options: nosniff` and
  `Content-Security-Policy: default-src 'none'; sandbox`, so opening an SVG directly never runs
  script.
- **Caching.** Emitters append `?v=<commit or content hash>`; versioned responses are
  `private, max-age=31536000, immutable`, unversioned ones use a content-hash ETag. Development
  Mode URLs are versionless with a short lifetime.
- A missing, oversized or disallowed target is a plain 404 without path detail. The app folder is
  readable by every authenticated user and is not a place for secrets.

## Vendoring

On install and update Core copies the asset subtree (Git and folder installs) or fetches the declared
assets plus the images the description references (manifest-by-URL) into the app's internal copy, so
assets keep working for image-only apps and after the upstream repository disappears. Development
Mode and live-source apps are served directly from the source checkout. Budgets: icon 512 KB,
screenshot 2 MB (at most 8), description 256 KB; manifest-by-URL vendoring is additionally capped at
about 32 files and 20 MB. A violation is treated as absent and logged — display assets never fail an
install or update. Remote fetches stream through a capped reader that ignores `Content-Length`.
Uninstall removes the internal copy.

## Resolved URLs And Rendering

`AppSummary` exposes Core-resolved `iconUrl` and `descriptionUrl`, and each surfaced `ui.pages`
entry its `iconUrl`. An absolute `https` icon passes through unchanged. Shell never computes asset
paths: sidebar app items, sidebar page links and Installed Apps render `iconUrl` with the Lucide
fallback.

Marketplace's detail dialog renders the markdown description with react-markdown and remark-gfm.
Raw HTML stays text because `rehype-raw` is never added. Relative references resolve against the
description file's own folder; references escaping the asset root render as plain alt text; external
absolute images render as links rather than inline images, so the storefront never pulls mutable
third-party content.

## Catalog Publish-Time Vendoring

`hosty-catalog`'s `generate-catalog.mjs` resolves each entry's `feedsUrl`, selects the default or
sole feed and fetches its manifest. It downloads the declared icon, screenshots and description and
discovers — never rewrites — the description's relative image references (`![...](...)`,
`<img src>`, reference definitions), preserving their layout under `dist/apps/<id>/`. The vendored
markdown stays byte-identical to the author's file. A discovered reference that escapes the root or
cannot be resolved fails the build, as does a failed fetch of a declared or referenced asset; asset
absence does not. The published entry gets a generated `display.descriptionUrl`;
`entry.display.icon` remains an override for apps without a public repository.

## Boundaries

- The storefront never hotlinks author URLs: vendoring freezes assets at review time.
- Nothing above the manifest's folder is reachable, however the path is spelled.
- Display assets are never part of runtime validation and never gate install or update.

## Testing Expectations

- Path guard: dot and empty segments, backslashes, `:` segments, URL-encoded variants,
  case-insensitive prefix collisions and symlink or junction escapes return 404.
- Vendoring: per-file, count and total budgets; treated-as-absent on violation; the manifest-by-URL
  declared-plus-referenced set; Development Mode live serving; the capped reader aborts an oversized
  body regardless of `Content-Length`.
- Headers: `nosniff` and the CSP on every response; immutable caching only with `v`.
- Shell and Marketplace: Lucide fallback without `iconUrl`; raw HTML renders as text; relative
  references resolve against the description's folder; external images render as links.
- Catalog: discovery forms, build failure on unresolvable references and failed fetches, and
  byte-identical vendored markdown.

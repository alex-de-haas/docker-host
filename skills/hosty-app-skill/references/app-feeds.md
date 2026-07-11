# Repository-Owned App Feeds

Use `feeds.json` when a runtime app should be discoverable through Marketplace and follow a named moving manifest source. The feed document belongs in the runtime app repository; Marketplace only points to it, and Core is the authoritative loader.

## Contract

```json
{
  "schemaVersion": "app-feeds.0.1",
  "appId": "com.example.notes",
  "feeds": [
    {
      "id": "main",
      "manifestRef": "https://raw.githubusercontent.com/example/notes/main/manifest.json",
      "default": true
    }
  ]
}
```

Requirements:

- `schemaVersion` is exactly `app-feeds.0.1`.
- `appId` exactly matches the manifest `id` selected by every feed.
- Feed ids are non-empty, unique, and no longer than 128 characters.
- At most one feed has `default: true`.
- A sole feed is the effective default; several feeds without a default require explicit operator selection.
- `manifestRef` is an absolute HTTP(S) manifest URL. Do not use a local path.
- Array order has no selection meaning.

The common Git-backed pattern points at the branch manifest. Releases move that manifest and its runtime artifacts; Core detects and applies changes through the ordinary reviewed update plan.

## Catalog Handoff

A `marketplace.0.2` catalog entry contains the public `feedsUrl`:

```json
{
  "id": "com.example.notes",
  "feedsUrl": "https://raw.githubusercontent.com/example/notes/main/feeds.json"
}
```

Do not copy `feeds[]` into the catalog entry. Marketplace may display the referenced choices, but Core fetches and validates both documents again before install/update.

## Validation

Test the feed through Core-managed lifecycle, not by parsing it only in app code:

```bash
hosty core start
```

Use Shell's feed install review for an end-to-end check. For repository fixtures, also keep the feed identity synchronized with `manifest.json`; the first-party Demo App is the reference.

See `docs/features/catalog-hosted-app-feeds.md` for Core API, state, selection, and digest behavior.

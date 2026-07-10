# Runtime App Repository Feeds

Status: Idea
Created: 2026-07-10
Updated: 2026-07-10

## Motivation

The current runtime-app feed behavior is sufficient. A feed already names a moving manifest reference, supports default selection, records which feed an installed app follows, and reuses the ordinary reviewed update flow.

The only architectural change needed is ownership: feeds should live with the runtime app instead of inside a catalog. This document covers that migration only. It does not introduce another channel model or expand update behavior.

## Confirmed Decisions

- The runtime contract and product term is **feed**.
- The canonical feed document is `feeds.json` in the runtime app repository.
- The existing feed entry shape remains unchanged: `id`, `manifestRef`, and optional `default`.
- Marketplace returns catalog information including `feedsUrl`; it does not resolve a feed or participate in install/update lifecycle.
- Core loads and validates `feeds.json`, selects the feed, stores followed-feed state, and remains the only install/update authority.
- Changing the followed feed changes only the future manifest source. The running app changes only through the existing reviewed update flow.
- Direct manifest installs remain valid and feed-less.

## Current Behavior

- Catalog entries contain inline `feeds[]`.
- A sole valid feed is treated as the default. Multiple feeds without an explicit default require operator selection.
- Install stores `FollowedFeedId` and the selected feed's `manifestRef` as `ManifestUrl`.
- `SetFeedAsync` resolves the selected feed through `CatalogService`, then updates `FollowedFeedId` and `ManifestUrl` without changing the running app.
- The Shell already exposes feed selection and the existing update plan/apply path handles actual changes.

## Target Ownership

Each runtime app repository contains a versioned `feeds.json`:

```json
{
  "schemaVersion": "app-feeds.0.1",
  "appId": "com.haas.project-manager",
  "feeds": [
    {
      "id": "main",
      "manifestRef": "https://raw.githubusercontent.com/example/project-manager/main/manifest.json",
      "default": true
    },
    {
      "id": "stable",
      "manifestRef": "https://example.invalid/project-manager/stable/manifest.json"
    }
  ]
}
```

The standalone envelope adds only document versioning and app identity. Feed behavior stays the same:

- feed ids are non-empty and unique;
- at most one feed declares `default: true`;
- a sole feed is the effective default;
- several feeds without a default require explicit selection;
- array order has no selection meaning;
- `appId` must match the selected manifest and catalog entry;
- `manifestRef` must be a Core-resolvable remote manifest URL.

A catalog entry references the app-owned file instead of embedding feeds:

```json
{
  "id": "com.haas.project-manager",
  "feedsUrl": "https://raw.githubusercontent.com/example/project-manager/main/feeds.json"
}
```

## Core State And Migration

Adapt the current installed-app state:

```text
FeedsUrl        new: source of the app-owned feeds.json
FollowedFeedId  existing: selected feed id
ManifestUrl     existing: selected feed's resolved manifestRef
```

Migration work is limited to:

- move feed parsing/default normalization from catalog code into a Core runtime-app feed loader;
- let install planning accept `feedsUrl` and an optional feed id;
- persist `FeedsUrl` after a successful feed-based install;
- make the existing set-feed operation resolve against the stored `FeedsUrl` instead of `CatalogService`;
- replace catalog `feeds[]` with `feedsUrl`;
- preserve legacy installed apps as direct-manifest update sources until an operator explicitly binds them to `feeds.json`.

Once installed from feeds, an app continues updating when Marketplace is stopped or its originating catalog is removed.

## Out Of Scope

- A parallel `app-channels` contract, channel index, or `switch-channel` lifecycle API.
- New feed selection or update semantics.
- Product-channel generation or coordinated platform releases.
- Pull-request or ephemeral feeds.
- Feed discovery from `manifest.json`.
- New signing, trust, compatibility, or update-status systems.
- New Shell feed UI beyond adapting the existing selector to Core-owned feed data.

## Conflicts With Existing Features

- [Catalog-Hosted App Feeds](../features/catalog-hosted-app-feeds.md) documents the current inline catalog ownership. This idea preserves the behavior but moves the document to the runtime app repository.
- [Runtime App Marketplace](../features/runtime-app-marketplace.md) documents catalog-owned feeds and installed-state enrichment. That remains current behavior until migration ships.
- [Marketplace As A System App](marketplace-system-app.md) depends on catalog entries exposing only `feedsUrl` while Core owns resolution.

## Open Questions

None at this scope. Implementation planning still needs exact API/DTO names and migration tests, but those details must not expand the accepted feed behavior.

## Current Recommendation

Retire the separate channel roadmap. Keep the current feed behavior unchanged and implement only the ownership migration from inline catalog `feeds[]` to runtime-app-owned `feeds.json` resolved by Core.

## Links

- [Marketplace As A System App](marketplace-system-app.md) - read-only catalog ownership and `feedsUrl` handoff.
- [Catalog-Hosted App Feeds](../features/catalog-hosted-app-feeds.md) - current feed behavior being retained.
- [Runtime App Marketplace](../features/runtime-app-marketplace.md) - current catalog and feed implementation.
- [Runtime App Update](../features/runtime-app-update.md) - existing reviewed update behavior reused unchanged.

## Notes

This document records the accepted direction but does not authorize implementation.

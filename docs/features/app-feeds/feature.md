---
created: 2026-07-09
updated: 2026-10-05
summary: Apps publish named update sources in an app-owned feeds.json that Core validates and follows without a catalog or Marketplace.
components: [apps/core]
---

# Runtime App Feeds

A runtime app can publish named update sources in an app-owned `feeds.json`. Core loads and
validates that document without a catalog or Marketplace service, resolves the selected manifest,
and stores enough state to follow the feed through later reviewed updates.

Feeds are optional. Direct manifest and local folder installs remain valid and have no feed state.

## Document Contract

The supported schema is `app-feeds.0.1`:

```json
{
  "schemaVersion": "app-feeds.0.1",
  "appId": "com.example.notes",
  "feeds": [
    {
      "id": "main",
      "manifestRef": "https://example.invalid/notes/main/manifest.json",
      "default": true
    }
  ]
}
```

Core requires:

- the exact supported `schemaVersion`;
- a non-empty `appId`;
- at least one feed;
- non-empty, unique feed ids of at most 128 characters;
- at most one explicit default;
- an HTTP(S) `manifestRef` for every feed;
- a selected manifest whose app id equals the document's `appId`.

A sole feed is the effective default even without `default`. With several feeds, Core uses the one
explicit default or requires the caller to name a feed. Array order never selects a feed. The
document is loaded from an HTTP(S) URL through Core's bounded remote-document loader; local feed
paths are not supported.

## Installation

`POST /api/apps/install/feed/plan` takes a `feedsUrl`, an optional `feedId` and the usual runtime and
autostart choices. Core fetches the feed and the selected manifest, builds the ordinary install
review and returns the resolved feed id, manifest URL, feed-document digest and plan digest.

Execution goes through the [Core installation confirmation](../app-installation-sdk/feature.md): the
approved installation consumes the cached manifest selection, so a feed or manifest that changes
after review does not alter what is installed. The legacy `POST /api/apps/install/feed` apply route
refuses direct execution with `approval_required`. A Marketplace-provided URL is treated like any
other untrusted input.

## Installed State

A feed install stores `FeedsUrl` (the app-owned `feeds.json`), `FollowedFeedId` and `ManifestUrl`
(the last resolved `manifestRef`). `GET /api/apps/{appId}/feeds` lists the current choices and
`POST /api/apps/{appId}/feed` changes the followed feed. Changing it resolves the feed from the
stored `FeedsUrl` and updates the future manifest source without touching the running app; any app
change still goes through the normal update plan and apply.

Update planning without an explicit manifest re-fetches the stored feed and resolves the followed
feed before loading the candidate manifest, so a feed can move its `manifestRef` without any catalog
change. An app without a stored feed URL keeps direct-manifest or local-source resolution.

## Independence From Marketplace

Catalog entries carry a `feedsUrl`; they do not embed or own feed entries. Marketplace may load the
document to display feed choices, but Core loads it independently for every lifecycle operation.
Stopping or removing Marketplace does not affect updates of an installed feed-bound app. There is no
reader for catalog-inline `feeds[]`; direct installs stay feed-less until reinstalled from a feed.

The first-party Demo App publishes [its feed document](../../../apps/demo-app/feeds.json), pointing
the `main` feed at its manifest on the repository's `main` branch. See also the
[Marketplace](../runtime-app-marketplace/feature.md), [runtime app update](../runtime-app-update/feature.md)
and [manifest](../runtime-app-manifest/feature.md) documents.

## Testing Expectations

- Feed validation rejects an unsupported schema, an empty app id, no feeds, duplicate or overlong
  ids, two defaults, a non-HTTP(S) `manifestRef` and a manifest whose app id differs.
- Default selection: a sole feed is the default; several feeds need one explicit default or a
  named feed; array order never decides.
- The install plan carries the resolved feed, manifest URL and digests; the legacy apply route
  refuses with `approval_required`; the confirmed installation uses the cached selection.
- Changing the followed feed does not restart the app; update planning resolves the followed feed.

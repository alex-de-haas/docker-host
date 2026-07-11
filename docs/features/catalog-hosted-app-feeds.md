# Runtime App Repository Feeds

Created: 2026-07-09
Updated: 2026-07-11

## Description

A runtime app can publish named update sources in an app-owned `feeds.json`. Core loads and validates that document without using a catalog or Marketplace service, resolves the selected manifest, and stores enough state for later feed changes and reviewed updates.

Feeds are optional. Direct manifest and local folder installs remain valid and do not acquire feed state.

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

- an exact supported `schemaVersion`;
- a non-empty `appId`;
- at least one feed;
- non-empty, unique feed ids no longer than 128 characters;
- no more than one explicit default;
- an HTTP(S) `manifestRef` for every feed;
- a selected manifest whose app id equals the feed document `appId`.

A sole feed is the effective default even when it omits `default`. With several feeds, Core uses the one explicit default or requires the caller to provide a feed id. Array order never selects a feed.

The feed document itself is loaded from an HTTP(S) URL through Core's bounded remote-document loader. Local feed paths are not supported.

## Reviewed Install

Shell starts a feed install through two Core browser endpoints:

```text
POST /api/apps/install/feed/plan
POST /api/apps/install/feed
```

The plan request supplies `feedsUrl`, an optional `feedId`, and the normal runtime/autostart choices. Core fetches the feed and selected manifest, builds the ordinary install review, and returns the resolved feed id, manifest URL, feed-document digest, and plan digest.

Apply supplies the confirmed plan digest together with the selected runtime, settings, and startup choice. Core re-fetches the feed and manifest and recomputes the plan. If either document or another reviewed input changed, apply rejects the stale digest rather than installing content different from the review.

The Marketplace app is not part of this validation path. A Marketplace-provided URL is treated exactly like any other untrusted operator input.

## Installed State

A successful feed install stores:

```text
FeedsUrl        URL of the app-owned feeds.json
FollowedFeedId  selected feed id
ManifestUrl     last resolved manifestRef
```

Core exposes the current feed choices through:

```text
GET  /api/apps/{appId}/feeds
POST /api/apps/{appId}/feed
```

Changing the followed feed resolves it from the installed app's stored `FeedsUrl` and updates the future manifest source. It does not mutate or restart the running app. Any app change still goes through the normal update plan and apply flow.

When update planning is requested without an explicit manifest, a feed-bound app re-fetches its stored feed and resolves the followed feed before loading the candidate manifest. The feed may therefore move its `manifestRef` without any catalog change. If an app has no stored feed URL, the existing direct-manifest/local-source resolution remains in effect.

## Independence From Marketplace

Catalog entries contain a `feedsUrl`; they do not embed or own feed entries. Marketplace may load the document to display feed choices, but that result is informational only. Core independently loads it for every lifecycle operation.

Stopping or removing Marketplace does not affect updates for an installed feed-bound app because the app record retains `FeedsUrl` and `FollowedFeedId`.

There is no compatibility reader for catalog-inline `feeds[]` and no state migration. Existing direct installs remain feed-less until they are reinstalled through a feed source.

## Repository Example

The first-party Demo App publishes [its feed document](../../apps/demo-app/feeds.json). It points the `main` feed at the app manifest on the repository's `main` branch.

## Links

- [Marketplace System App](runtime-app-marketplace.md)
- [Runtime App Update](runtime-app-update.md)
- [Runtime App Manifest](runtime-app-manifest.md)
- [Runtime App Repository Feeds idea](../ideas/runtime-app-repository-feeds.md)

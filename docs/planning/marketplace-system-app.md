# Marketplace System App - Vertical Slice

Status: Implemented
Created: 2026-07-10
Updated: 2026-07-11 (implemented; single-source retained)

## Goal

Move Marketplace discovery and storefront behavior completely into the optional first-party `hosty.marketplace` system app while making feeds a generic Core runtime-app lifecycle contract. Core must install and update apps from app-owned `feeds.json` without knowing catalogs or Marketplace domain APIs.

## Scope

- Add the generic `app-feeds.0.1` loader, validation, installed state, and reviewed install/update/feed-selection flows to Core.
- Bootstrap `hosty.marketplace` through an explicit first-party descriptor, matching the current Shell and telemetry bootstrap pattern.
- Make `hosty.marketplace` own its single catalog source as a manifest setting, defaulted by the official Marketplace manifest to the official Hosty catalog.
- Move the existing storefront, catalog detail, feed choice, source diagnostics, and catalog fetching into the Marketplace app.
- Replace catalog-inline `feeds[]` with an app-repository-owned `feedsUrl` on catalog entries.
- Hand a selected `feedsUrl` and optional feed id from the Marketplace iframe to Shell; Shell owns review and calls Core's generic feed lifecycle API.
- Remove Core catalog parsing, source state, Marketplace endpoints/DTOs, installed-state enrichment, and catalog dependencies.
- Remove the hardcoded Shell `/marketplace` implementation and the `hosty catalog` CLI command.
- Preserve direct manifest/folder installs and every non-catalog runtime-app lifecycle flow.

## Out of Scope

- Multiple Marketplace catalog sources or federation. Confirmed 2026-07-11: a single operator-configured source is sufficient for this increment; restoring the WS7 multi-source model is deferred and, when it returns, should ship together with catalog-qualified `(catalogId, appId)` identity to avoid bare-id collisions.
- Local host-path catalog sources and snapshot imports.
- Legacy catalog state, API, route, response, or CLI compatibility.
- A generic bootstrap registry for arbitrary system apps.
- A generic Core extension-provider contract (`provides`, provider election, or third-party Core extensions).
- Catalog or feed signing and install-blocking publisher trust.
- Automatic installation or update without an operator-reviewed plan.
- Replacing `role: system` or unifying its current authorization/navigation behavior with ordinary runtime apps.

## Current Behavior

- Core owns `CatalogService`, `CatalogSourceService`, `CatalogSourceStore`, catalog schemas, source persistence, catalog browser/control endpoints, installed-state enrichment, and feed lookup.
- Catalog entries contain inline `feeds[]`; `CoreLifecycleService.SetFeedAsync` resolves a feed through `CatalogService`.
- Install planning accepts a direct manifest reference. Feed-based apply is not bound to the reviewed install plan digest.
- `AppRecord` stores `FollowedFeedId` and the resolved `ManifestUrl`, but not the app-owned `FeedsUrl`.
- Shell owns the hardcoded `/marketplace` route and storefront components. The Marketplace app serves a read-only catalog API and only a placeholder root page.
- CLI `hosty catalog` calls Core catalog endpoints.
- `hosty.marketplace` is not bootstrapped by Core and its manifest has no UI or source setting.

## Target Behavior

- Core understands only `app-feeds.0.1`, manifests, reviewed plans, app state, and lifecycle operations. It has no catalog or Marketplace client/service/DTO/route.
- A feed-based install stores `FeedsUrl`, `FollowedFeedId`, and the last resolved `ManifestUrl`. Core independently re-fetches and validates the feed and manifest for plan/apply/update operations.
- Direct manifest and local folder installs remain feed-less and unchanged.
- The Marketplace app reads one configured catalog URL, renders catalog entry metadata, and may read referenced feeds for display only.
- Catalog entry details remain catalog-owned (`entry.json` / the generated catalog index). The entry exposes `feedsUrl` instead of inline feeds.
- Marketplace cannot install or update an app. A user action sends an untrusted install intent to Shell; Shell opens Core's reviewed install surface.
- Marketplace is visible through the generic System Apps navigation and normal app-origin SSO. No hardcoded Shell Marketplace route or UI remains.
- Marketplace absence or failure disables discovery only. Feed-bound installed apps continue to resolve their stored `FeedsUrl` through Core.

## Acceptance Criteria

- [x] Core validates `app-feeds.0.1`: schema version, app id, unique non-empty feed ids bounded to 128 characters, at most one explicit default, remote manifest refs, and manifest/feed app-id equality.
- [x] A sole feed is the effective default; multiple feeds without a default require an explicit feed id.
- [x] Feed install plan/apply is bound to a plan digest and rejects changed feed/manifest input between review and apply.
- [x] Feed-based install persists `FeedsUrl`, `FollowedFeedId`, and resolved `ManifestUrl`.
- [x] Feed list/change and update planning resolve through the stored `FeedsUrl` without Marketplace or catalog state.
- [x] Direct manifest/folder installs, source runtimes, runtime switches, updates, backups, and app start/restart remain operational.
- [x] `HOSTY_MARKETPLACE_MANIFEST_PATH` alone enables Marketplace bootstrap; no Marketplace-specific runtime or autostart setting is required.
- [x] First install uses the manifest's default runtime. Later bootstrap reconciliation preserves the installed runtime and autostart choices.
- [x] Marketplace manifest validates for `docker` and Core-managed `dev`, exposes a strict system-app UI entrypoint, and declares its source repository.
- [x] Marketplace declares one required URL setting, `HOSTY_MARKETPLACE_SOURCE_URL`, whose official default is the public Hosty catalog.
- [x] Marketplace displays catalog cards/details from catalog entry data and displays app-owned feeds referenced by `feedsUrl`.
- [x] Marketplace never receives a Core lifecycle scope, Core session cookie, or control secret.
- [x] Shell validates install-intent message source, origin, schema, size, and URL before opening review.
- [x] Core independently validates every Marketplace-provided `feedsUrl` and selected feed before install.
- [x] Core catalog services/endpoints/DTO registrations, Shell Marketplace implementation/route, and CLI `hosty catalog` are removed.
- [x] Unit, API, lifecycle, manifest, Shell, Marketplace, CLI, and existing regression tests pass.
- [ ] Core-managed Marketplace smoke tests pass for both `dev` and `docker` runtimes (pending manual pre-merge verification).
- [x] Feature documentation describes only the implemented generic feed and Marketplace boundaries.

## Deliverables

- [x] `app-feeds.0.1` Core models, bounded loader, validation, and tests.
- [x] Digest-bound feed install plan/apply API and lifecycle implementation.
- [x] Persisted feed source state, feed read/change API, and feed-based update resolution.
- [x] Marketplace bootstrap descriptor/configuration and reconciliation tests.
- [x] Marketplace single-source manifest setting and simplified catalog service.
- [x] Marketplace `marketplace.0.2` catalog contract with entry-owned details and `feedsUrl`.
- [x] Marketplace app-origin authentication, storefront UI, details/feed selection, diagnostics, and tests.
- [x] Generic Shell iframe install-intent handoff and reviewed feed install flow.
- [x] Removal of legacy Core catalog, hardcoded Shell Marketplace, and CLI catalog code/tests/docs.
- [x] Updated feature/local-development/release documentation and completed verification.

## Technical Design

### Generic Runtime-App Feeds

An app repository publishes a versioned document:

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

Core fetches the document with the existing remote-document safety bounds, validates it independently, selects the requested/default/sole feed, loads the selected manifest, and requires the feed `appId` to match the manifest id. Array order has no selection meaning.

`AppRecord` stores:

```text
FeedsUrl        app-owned feeds.json reference
FollowedFeedId  selected feed id
ManifestUrl     last resolved manifestRef
```

Direct manifest/folder installs leave `FeedsUrl` and `FollowedFeedId` null.

### Reviewed Feed Install

Core exposes a generic feed install plan/apply path alongside the unchanged direct-manifest path. Plan input contains `feedsUrl`, optional `feedId`, optional selected runtime, and autostart intent. The plan contains the resolved feed, manifest, runtime/settings/capability review, and a digest over the reviewed feed and manifest inputs.

Apply re-resolves the feed and manifest and succeeds only when the calculated plan digest matches the confirmed digest. No Marketplace identity or catalog data participates in the plan.

Changing an installed app's followed feed resolves against its stored `FeedsUrl`. Update planning always re-resolves the followed feed before loading the candidate manifest, so a feed may move its `manifestRef` without catalog involvement.

### Marketplace Catalog Contract

Marketplace reads a single HTTP(S) catalog URL from `HOSTY_MARKETPLACE_SOURCE_URL`. The official Marketplace manifest supplies the official Hosty catalog URL as the default. Core settings configuration restarts/reconciles the app using the ordinary runtime-app settings path.

The `marketplace.0.2` entry shape retains the current catalog-owned display details and replaces inline `feeds[]` with:

```json
{
  "id": "com.example.notes",
  "name": "Notes",
  "display": {
    "summary": "Take notes.",
    "icon": "https://example.invalid/assets/icon.png"
  },
  "feedsUrl": "https://example.invalid/notes/feeds.json"
}
```

Marketplace may fetch `feedsUrl` to show available feeds, but its result is informational. Core performs the authoritative fetch and validation only after the operator starts a lifecycle operation.

### Marketplace UI And Install Intent

`hosty.marketplace` declares a normal system-app `ui.entrypoint` and runs through the existing app-origin authorization-code/session flow. The storefront and detail UI live in the Marketplace Next.js app.

On user activation, Marketplace sends a versioned message containing `feedsUrl` and optional `feedId` to its Shell parent. Shell accepts it only from the active Marketplace iframe and exact resolved app origin, validates the payload and HTTP(S) URL, and opens the ordinary install-review dialog. Marketplace receives no lifecycle credential and cannot apply the installation.

### First-Party Bootstrap

Phase 1 intentionally follows the existing Shell/telemetry descriptor pattern. `HOSTY_MARKETPLACE_MANIFEST_PATH` is the enable/source switch. Core contains only the first-party bootstrap descriptor; it contains no Marketplace API client or catalog logic.

For a missing app, bootstrap installs the manifest with no explicit runtime so normal manifest default selection applies and normal autostart defaults to enabled. For an installed app, reconciliation uses the installed runtime and preserves the installed autostart value. An absent path performs no install, stop, or removal.

### Cleanup

The cutover has no compatibility period. Remove Core catalog storage/fetch/service/endpoints, all catalog serialization registrations, `HOSTY_CATALOG_SOURCES`, `hosty catalog`, the Shell `/marketplace` route/components, and catalog-based feed resolution. Generic feed state and APIs replace the lifecycle behavior that must remain.

## Assumptions

- The user's 2026-07-11 decisions explicitly approve this replacement scope and the absence of backward compatibility.
- The official Marketplace uses one catalog URL for this increment. Multiple sources are a later Marketplace-only feature.
- Catalog entry details remain catalog-owned; only feed ownership moves to runtime-app repositories.
- Marketplace feed reads are display-only and cannot satisfy Core trust or lifecycle validation.
- Shell mediates install review; Marketplace never calls a privileged Core apply endpoint.
- Marketplace bootstrap is intentionally app-specific for now. Generic system-app installation/extension discovery is deferred.
- Version bumps are evaluated once when the branch is prepared as a pull request.

## Risks

- Feed plan/apply drift could install content different from what was reviewed. Bind apply to both feed and manifest content through the plan digest.
- A compromised catalog or Marketplace may present a misleading app. Core must independently resolve the feed/manifest and the review must display the authoritative manifest identity and permissions.
- Iframe messages are untrusted. Validate exact source/origin, message type/version, bounded string lengths, and HTTP(S) URLs. Shell also gates the install-intent listener on the Marketplace app id so no other embedded app can initiate a feed install.
- Entry-owned `feedsUrl`/`descriptionUrl` are catalog content and can point anywhere. The Marketplace app runs inside the host network and returns a fetched description to the browser, so these fetches reject non-public hosts and do not follow redirects (SSRF guard); Core's authoritative feed fetch likewise refuses redirects. The operator-configured catalog source URL is trusted and not host-restricted (local/dev catalogs remain valid).
- Removing compatibility routes breaks older Shell/CLI builds by design; the current Shell and platform release must move together.
- Moving the storefront may accidentally retain imports or types that depend on Core DTO enrichment. Marketplace UI must render catalog facts only.
- Removing `CatalogService` must not remove generic update detection for feed-bound installed apps.
- **Upgrade drops existing WS7 catalog sources.** Operators who added extra catalog sources through the removed `hosty catalog` / `HOSTY_CATALOG_SOURCES` WS7 path lose them on upgrade: Marketplace now reads only the single `HOSTY_MARKETPLACE_SOURCE_URL`. This is an accepted behavior loss for a pre-1.0 platform; note it in release notes so affected operators re-point their catalog at the one supported source (or wait for the deferred federation increment).

## Open Questions

None.

## Implementation Phases

### Phase 1 - Generic Feed Foundation

- [x] Implement feed loading/validation/state and digest-bound install plan/apply.
- [x] Move feed selection/update resolution out of `CatalogService`.

### Phase 2 - Marketplace Vertical Slice

- [x] Add first-party bootstrap and Marketplace source setting.
- [x] Move catalog storefront/details into the Marketplace app and adopt `feedsUrl`.
- [x] Add app-origin auth and Shell install-intent handoff.

### Phase 3 - Direct Cutover And Cleanup

- [x] Remove legacy Core/Shell/CLI catalog implementations and compatibility state.
- [x] Update tests and feature documentation.

## Verification

- `npm run marketplace:lint`
- `npm run marketplace:build`
- `npm run marketplace:test`
- `npm run marketplace:docker:build`
- `npm run core:build`
- `npm run core:test`
- `npm run cli:build`
- `npm run cli:test`
- `npm run shell:lint`
- `npm run shell:build`
- `npm run check-versions`
- `npm run ci`
- Core-managed `hosty.marketplace` install/start/auth/catalog/install-intent smoke test with `--runtime dev`.
- Core-managed `hosty.marketplace` install/start/auth/catalog/install-intent smoke test with `--runtime docker`.

## Links

- [Marketplace As A System App](../ideas/marketplace-system-app.md)
- [Runtime App Repository Feeds](../ideas/runtime-app-repository-feeds.md)
- [Runtime App Marketplace](../features/runtime-app-marketplace/feature.md)
- [Catalog-Hosted App Feeds](../features/catalog-hosted-app-feeds.md)
- [System App Pages](../ideas/system-app-pages.md)

## Notes

This is a deliberate vertical replacement, not an extraction compatibility phase. Core remains the only lifecycle authority, but catalog discovery is entirely outside Core.

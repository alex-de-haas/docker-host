# Marketplace System App - Phase 1

Status: In Progress
Created: 2026-07-10
Updated: 2026-07-10

## Goal

Extract catalog source ownership, catalog parsing, fetch/cache, federation, and the catalog read API from Hosty Core into the optional first-party `hosty.marketplace` system app without breaking the existing Shell or CLI marketplace workflows.

## Scope

- Complete the `hosty.marketplace` Next.js runtime app with persistent app-data state, catalog fetching, schema validation, federation, diagnostics, and a versioned HTTP API. (Stack decision 2026-07-10: Next.js over .NET so the Phase 2 storefront moves from Shell into the same single service/image; the Shell components are already React, and the app-origin SSO reference lives in demo-app.)
- Add Docker and Core-managed `localCommand` runtime support, health checks, image publishing, CI, and tests.
- Bootstrap and reconcile the Marketplace through the generic system-app descriptor model.
- Migrate the legacy Core catalog-source state into Marketplace app data exactly once.
- Replace Core catalog implementations with a bounded, service-token-authenticated Marketplace client and compatibility adapter.
- Preserve the existing browser and control-plane catalog routes, source mutations, legacy response shapes, and lifecycle feed-selection behavior during the migration window.
- Remove installed/update projections from the Marketplace-owned API; keep temporary Core-owned enrichment only at the legacy compatibility boundary.

## Out of Scope

- Moving the storefront or source-management UI out of Shell (Phase 2).
- Replacing inline catalog `feeds[]` with repository-owned `feeds.json` / `feedsUrl` (Phase 3).
- Removing legacy Core compatibility DTOs and routes (Phase 4).
- Catalog signing or install-blocking trust enforcement.
- Granting Marketplace registry-read or lifecycle authority.
- A final catalog-qualified `(catalogId, appId)` public contract; Phase 1 keeps the current first-source-wins bare-id behavior until the feed/catalog contract migration is designed together.

## Current Behavior

- Core owns catalog source persistence, HTTP/local-file fetching, cache, schema parsing, federation, installed-state enrichment, update detection, and browser/control endpoints.
- Shell and CLI call Core's `/catalog` endpoints, including source add/remove operations.
- `CoreLifecycleService` reads Core's `CatalogService` to validate feed selection.
- The untracked `apps/marketplace` scaffold contains models, a fetcher, a partial service, options, and a manifest, but it has no executable entrypoint, source store/service, API, tests, Dockerfile, bootstrap, proxy, migration, or CI integration and does not compile.

## Target Behavior

- `hosty.marketplace` is the single owner of catalog source state and catalog-domain processing.
- Marketplace's API returns catalog-owned information only and requires the Core-generated app service token on non-health endpoints.
- Core resolves the installed Marketplace endpoint and forwards only the allowlisted catalog operations needed by existing Shell/CLI clients.
- Core temporarily enriches legacy compatibility responses with installed/feed/update state; Marketplace never receives registry access.
- Existing local-file sources are copied once into Marketplace app data. Their original path remains the operator-facing identity, but subsequent host-file changes are not followed automatically.
- Marketplace absence or failure leaves direct installs, installed apps, and updates operational; catalog reads degrade predictably and mutations return a coded availability error.

## Acceptance Criteria

- [ ] Marketplace builds and starts as both `docker` and Core-managed `dev` runtimes.
- [ ] The manifest validates for both runtime selections and uses Core-assigned ports and app data correctly.
- [ ] Catalog models, schema validation, source persistence, fetch/cache, federation, and diagnostics run outside Core.
- [ ] Source state persists atomically in Marketplace app data and concurrent mutations cannot clobber each other.
- [ ] Legacy Core source state is imported at most once; local paths become bounded snapshot copies inside Marketplace app data.
- [ ] Marketplace API requests other than `/healthz` reject missing or invalid app service tokens.
- [ ] Existing Shell and CLI catalog list/detail/source operations retain their current response shape and authorization behavior.
- [ ] Legacy installed version, followed feed, and update-available projections remain correct through the Core compatibility adapter.
- [ ] Feed selection continues to validate catalog app/feed ids without granting Marketplace lifecycle authority.
- [ ] Marketplace unavailability does not affect non-catalog lifecycle operations.
- [ ] Unit, API, proxy, migration, bootstrap, manifest, CLI, and existing Core regression tests pass.
- [ ] CI and image publishing cover Marketplace; feature documentation describes the implemented Phase 1 boundary.

## Deliverables

- [ ] Marketplace executable/API and service-token authorization.
- [ ] Marketplace source store/service, bootstrap import, local snapshot handling, and diagnostics.
- [ ] Marketplace catalog fetch/cache/schema/federation implementation.
- [ ] Marketplace manifest, Dockerfile, test project, package scripts, CI, image workflow, and dependency automation.
- [ ] Marketplace system-app bootstrap configuration and tests.
- [ ] Core Marketplace client, compatibility adapter, endpoint rewiring, and lifecycle feed integration.
- [ ] Core source-state migration and idempotency tests.
- [ ] Shell/CLI compatibility regression coverage.
- [ ] Feature and development documentation.

## Technical Design

### Marketplace API

The app serves `/healthz` without authentication. All `/v1/catalog/*` routes require the exact `HOSTY_APP_SERVICE_TOKEN` value in `X-Hosty-App-Service-Token`. The API exposes catalog apps/details plus source list/add/remove operations. It never exposes installed state or calls Core.

The Phase 1 API intentionally retains `marketplace.0.1` inline `feeds[]` and first-source-wins federation. The later catalog-qualified identity and `feedsUrl` contract remain Phase 3 work so this extraction does not silently pre-implement or redefine that migration.

### Source State And Migration

Marketplace persists `catalog-sources.json` below `HOSTY_APP_DATA_DIR` with an atomic temp-file replace and a schema version. Core writes a one-time `bootstrap-sources.json` handoff only when Marketplace has not materialized its own state. HTTP sources retain their URLs. Absolute local paths are copied with a size cap into a deterministic `imports/` location and the state keeps both the original operator-facing path and the internal relative snapshot path.

Adding a local path through a legacy Core endpoint performs the same bounded snapshot import. Removing it uses the original path identity. No arbitrary host directory is mounted into the Marketplace container.

### Core Compatibility Boundary

Core discovers the installed `hosty.marketplace` endpoint, creates the same app service token injected into the app, and calls only fixed `/v1/catalog/*` paths. Browser session and control-secret authorization remain at the existing Core endpoints. The compatibility adapter maps catalog-only Marketplace responses to the legacy response DTOs and joins Core-owned installed/update information temporarily.

Read failures preserve the current optional-storefront behavior (empty list or not found with diagnostics). Source mutation failures return coded errors and never fall back to the legacy Core store.

### Bootstrap

`MarketplaceBootstrap` is enabled and autostarted by default, with environment overrides for enabled, manifest path, runtime, and autostart. Bootstrap is best-effort like the existing optional system apps. The app remains independently stoppable; its absence only disables discovery.

## Assumptions

- The user's 2026-07-10 request to finish Phase 1 explicitly approves this Phase 1 implementation scope.
- Preserving existing Shell/CLI behavior is required even though the final target removes Core enrichment; therefore enrichment remains only in the temporary compatibility adapter.
- Local-file compatibility means a one-time/import-time snapshot, not an ongoing host-file watch.
- Existing source mutations remain available through a narrow authenticated proxy until the Phase 2 Marketplace settings UI replaces them.
- Marketplace starts at app version `0.1.0`. Platform versioning is evaluated once when the PR is prepared and is not bumped during implementation.

## Risks

- The transitional compatibility adapter can become permanent unless Phase 4 removes it; keep it isolated and explicitly documented.
- Snapshot local sources no longer live-follow host file edits. The API and docs must make the snapshot behavior visible.
- Bootstrap and proxy startup race: catalog requests may arrive before Marketplace is ready; return a stable availability result and retry on later requests.
- A tokenless loopback API would allow local source mutation; every non-health Marketplace route must enforce the app service token.
- Source-state import must never overwrite Marketplace-owned state after the first materialization.

## Open Questions

None. Phase 1 uses the explicit assumptions above; later UI, catalog identity, feeds, and trust decisions stay in their documented phases.

## Implementation Phases

### Phase 1A - Complete The Marketplace App

- [x] Add the source store/service, JSON context, executable API, authentication, error mapping, diagnostics, Dockerfile, and tests.
- [x] Correct the manifest for Docker and dev ports/data/health behavior.

### Phase 1B - Bootstrap And Migrate State

- [ ] Add Marketplace runtime configuration and the generic bootstrap descriptor.
- [ ] Add one-time source handoff and local snapshot import with idempotency coverage.

### Phase 1C - Replace Core Catalog Ownership

- [ ] Add the bounded Marketplace client and legacy compatibility adapter.
- [ ] Rewire catalog endpoints and feed selection; remove Core fetch/source implementations.
- [ ] Preserve browser/control authorization and legacy response contracts.

### Phase 1D - Ship And Document

- [x] Add package scripts, CI, image publishing, dependency automation, and version checks.
- [ ] Update current-behavior documentation and remove this plan when every criterion passes.

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
- Core-managed `hosty.marketplace` install/start and catalog smoke tests for both `dev` and `docker`.

## Links

- [Marketplace As A System App](../ideas/marketplace-system-app.md)
- [Runtime App Marketplace](../features/runtime-app-marketplace.md)
- [Catalog-Hosted App Feeds](../features/catalog-hosted-app-feeds.md)
- [System App Pages](../ideas/system-app-pages.md)

## Notes

Phase 1 is an extraction and compatibility migration. It must not silently pull Phase 2 UI work or Phase 3 feed ownership into this implementation.

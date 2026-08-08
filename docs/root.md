# Documentation

## Overview

Hosty is a local application orchestrator with a headless Core API, Core-managed Shell and Marketplace system apps, and user runtime apps. New local development and testing use runtime apps installed from `app.0.1` manifests.

```mermaid
flowchart LR
  A["app.0.1 manifest"] --> B["Hosty Core"]
  B --> C["App registry"]
  B --> D["Docker or localCommand runtime"]
  B --> E["Shell"]
  B --> F["App auth and directory"]
  D --> G["Runtime app services"]
```

## Current Feature Documents

- [Core app shell](features/core-app-shell/feature.md) - Shell foundation: what it is, how it authenticates, and how it embeds app UIs.
- [Shell navigation](features/shell-navigation/feature.md) - the three destinations (Dashboard, Settings, Apps), the route table, and the sidebar.
- [Shell access and system apps](features/shell-access-and-system-apps/feature.md) - administrator-only management views and system app visibility.
- [Hosty runtime app platform](features/hosty-runtime-app-platform.md) - current runtime app lifecycle platform.
- [Runtime app manifest](features/runtime-app-manifest.md) - `app.0.1` manifest contract.
- [Automatic runtime app ports](features/automatic-runtime-app-ports/feature.md) - host ports reserved at install so a stopped app has durable endpoints, `HOSTY_PORT_*` / `PORT` compatibility, conflict preflight, and operator reassignment or pinning.
- [Raw L4 ports](features/raw-ports.md) - opt-in `expose: host` / `transport` publishing of a docker port on all interfaces over TCP/UDP.
- [Host networking](features/host-networking.md) - opt-in `network: host` for a docker service (full host namespace, no NAT) for high-churn peer-to-peer workloads; WSL2 mirrored-networking advisory.
- [Cloudflare ingress](features/cloudflare-ingress/feature.md) - opt-in `cloudflared` provider that renders an operator-run Cloudflare Tunnel's config from the running-app set and derives `HOSTY_PUBLIC_ORIGIN_*`, plus an API-token connection that publishes one endpoint at a time under a chosen label; `none` (default) keeps operator-owned exposure.
- [Container capabilities & devices](features/container-capabilities.md) - opt-in `capabilities` (`--cap-add`) and `devices` (`--device`) for a docker service, e.g. `NET_ADMIN` + `/dev/net/tun` for an in-container VPN; no blanket `--privileged`.
- [External host-path mounts](features/external-mounts.md) - operator-configured external folders (`externalMounts`) injected as `HOSTY_MOUNT_{KEY}`.
- [Global (shared) host-path mounts](features/global-mounts/feature.md) - host-level shared-mounts library registered once (`hosty storage`) and attached to apps by reference; extends external mounts (the manifest slot stays the opt-in point).
- [Cross-app dependencies](features/cross-app-dependencies/feature.md) - declare a dependency on another installed app; Core wires `HOSTY_DEPENDENCY_{ALIAS}_URL` and reports each dependency's installed/running state on the app summary, which the Shell renders as problem icons (no auth, no auto-install).
- [Runtime app update](features/runtime-app-update/feature.md) - update plan and apply behavior.
- [Runtime source workflows](features/runtime-source-workflows.md) - source checkout, local override, and runtime switching.
- [Runtime artifact & storage model](features/runtime-artifact-model.md) - design: execution × artifact-kind (image/prebuilt/source) axes plus the `development` flag, per-runtime storage, and the compiled-artifact (`prebuilt`) path. Phased; Phases 0, 1a, 2 (prebuilt folder delivery), and 3 (Shell Live/Locked badges) shipped, plus the 2026-07-02 operator-toggled Development Mode revision. Remaining: git-release/URL prebuilt delivery and per-runtime update-available state.
- [Multi-service runtime apps](features/multi-service-runtime-apps.md) - multiple services per app.
- [Runtime app compact view](features/runtime-app-compact-view.md) - compact Shell view of installed app services and assigned endpoints.
- [Direct origin runtime app UI](features/direct-origin-runtime-app-ui.md) - app-origin UI and auth code exchange.
- [App Auth And Origin Separation](features/app-auth-origin-separation.md) - Core-owned app auth and app-local sessions.
- [Auth And Gateway Model](features/auth-gateway/feature.md) - current app auth, assignments, and scoped app directory.
- [User Management](features/user-management.md) - users, invitations, roles, and app access assignment.
- [Local Password Login](features/local-password-login.md) - Core-owned local password setup, recovery, invitations, and login.
- [App Data Backup Retention](features/app-data-backup-retention.md) - backup cleanup and retention.
- [Notifications](features/notifications.md) - Core-owned user-targeted notification stream (v1 backend): opt-in app producers, client-agnostic consumer, SSE live delivery, and retention.
- [App Secrets Store](features/app-secrets-store.md) - Core-managed keychain for runtime-acquired app secrets (OAuth tokens and the like): service-token API, `apps/<id>/secrets.json` beside `state.json` and therefore outside backup scope, removal following the operator's keep-data choice, and SDK clients in both packages.
- [Observability](features/observability/feature.md) - OpenTelemetry from runtime apps → OTel collector → telemetry backend (embedded SQLite store + query API) → telemetry UI system app (metrics, structured logs, traces); Core contributes only the host-privileged signals (`docker stats` exposition, on-demand `docker logs`). Ingest/query auth, realtime tail, and the fleet heat-map remain — see the [plan](features/observability/plan.md).
- [Marketplace System App](features/runtime-app-marketplace/feature.md) - optional first-party storefront that owns one catalog source and hands app-owned feed URLs to Shell without lifecycle authority.
- [Runtime App Repository Feeds](features/catalog-hosted-app-feeds.md) - `app-feeds.0.1`, digest-bound feed installs, stored followed-feed state, and Core-owned update resolution.
- [CLI bootstrap](features/cli-bootstrap.md) - `hosty` command setup and Core control discovery.
- [CLI app commands](features/cli-app-commands.md) - runtime app CLI commands.
- [Core API](features/core-api/feature.md) - current Core browser and control APIs.
- [Domain model](features/domain-model.md) - shared app-oriented vocabulary.
- [Repository and release model](features/repository-release-model/feature.md) - monorepo and release workflows.
- [Hosty Shell Docker Image](features/hosty-shell-image.md) - implemented Shell image publishing and Core-managed bootstrap behavior.
- [Demo App](features/demo-app.md) - repository-local runtime app used for validation.
- [Local development and testing](features/local-development.md) - Core-managed local workflows.
- [Hosty App Skill](features/hosty-app-skill.md) - repository-shipped agent skill.
- [AI Agent Bridge](features/ai-agent-bridge/plan.md) - draft concept for development agents and runtime app action agents.
- [Final Hosty architecture boundaries](features/final-hosty-architecture.md) - Core/Shell/CLI ownership boundaries.

## Planning

- [Marketplace System App - Vertical Slice](planning/marketplace-system-app.md) - approved replacement of the Core-owned catalog with a Marketplace system app and generic Core feed lifecycle.
- [App Secrets Store](planning/app-secrets-store.md) - Implemented plan (shipped in #266-#267) for the Core-managed runtime-secrets keychain; the behavior now lives in [features/app-secrets-store.md](features/app-secrets-store.md).

## Ideas

Draft, exploratory, or backlog items that are not current implementation commitments:

- [Runtime App Repository Feeds](ideas/runtime-app-repository-feeds.md) - promoted design that moved the feed contract from inline catalog data to app-owned `feeds.json` resolved by Core.
- [On-Demand System App Updates](ideas/system-app-updates.md) - concept for explicit Shell/system-app update discovery, reviewed apply, self-reload, and rollback without restarting Core.
- [Core Extension Model](ideas/core-extension-model.md) - concept for extending Core through out-of-process apps: contract-free API clients, driver/sink provider contracts with declared cardinality, pull-based event subscriptions, system app pages, "system" as an ownership label rather than a privilege tier, and additional login methods instead of replaceable auth providers.
- [Marketplace As A System App](ideas/marketplace-system-app.md) - read-only catalog data, API, and UI in an optional first-party system app while Core retains all feed and lifecycle decisions.
- [System App Pages](ideas/system-app-pages.md) - separate administrator-only Shell pages for UI-capable system apps using the existing app UI contract.
- [Agent Bridge Workflow](ideas/agent-bridge-workflow.md) - concept for Shell annotation, agent request lifecycle, repository changes, branch/PR workflow, and an unresolved isolated-validation boundary.
- [Browser account switching](ideas/account-switching.md) - retired behavior and future restoration boundary.
- [Gateway and app wrapping ideas](ideas/gateway-and-app-wrapping.md) - future gateway, ingress, and third-party app wrapping boundaries.
- [Auth session lifecycle and recovery](ideas/auth-session-lifecycle.md) - agreed design: split identity error contract (401/403/503), standalone and embedded session recovery through app-open + login continuation, opaque server-side app session grants replacing the browser JWT, and sliding idle+absolute Core sessions.
- [Hosty App SDK](ideas/hosty-app-sdk.md) - agreed design: shared auth/recovery SDK for runtime apps (TypeScript on npmjs + .NET on NuGet) packaging the session state machine with a `misconfigured` class, silent embedded recovery, standalone redirect recovery, the embedder contract for shells, and the no-version-sync compatibility policy.
- [App Secrets Store](ideas/app-secrets-store.md) - promoted design (shipped) for the Core-managed runtime-secrets keychain: ten ratified decisions, including plaintext-0600 parity with existing secret storage and the deferred platform-wide at-rest pass. Implemented behavior: [features/app-secrets-store.md](features/app-secrets-store.md).
- [Replaceable UI Clients](ideas/replaceable-ui-clients.md) - concept for shells as ordinary apps: a `ui-client` provides slot replacing the hardcoded `hosty.shell` lookup, primary-UI selection as pure resolution (setting > sole > earliest-installed), CORS for every installed UI client, and uninstall of the last shell always allowed with the CLI as recovery path.
- [Auth provider extensions](ideas/auth-provider-extensions.md) - future OIDC, trusted-proxy provisioning, password reset, and durable throttling directions.
- [Runtime source extensions](ideas/runtime-source-extensions.md) - future multi-repository source and private repository credential handling.
- [Runtime app repository install](ideas/runtime-app-repository-install.md) - future direct Git repository install flow for runtime apps.
- [Backup retention extensions](ideas/backup-retention-extensions.md) - future age-based and per-app backup retention policy.
- [Future work ideas](ideas/future-work.md) - small backlog items that are not yet planned in detail.

<!-- docs-index:begin -->

_Generated by `scripts/docs-index.mjs --fix` — do not edit this block by hand._

### Features

- **access-tokens** — [feature](features/access-tokens/feature.md)
- **advertised-app-origins** — [plan](features/advertised-app-origins/plan.md): Draft, updated 2026-07-30
- **ai-agent-bridge** — [plan](features/ai-agent-bridge/plan.md): Draft, updated 2026-08-08
- **ai-gateway** — [plan](features/ai-gateway/plan.md): Ready, updated 2026-08-08
- **app-lifecycle-states** — [feature](features/app-lifecycle-states/feature.md)
- **auth-gateway** — [feature](features/auth-gateway/feature.md)
- **automatic-runtime-app-ports** — [feature](features/automatic-runtime-app-ports/feature.md) · [plan](features/automatic-runtime-app-ports/plan.md): Draft, updated 2026-07-28
- **cardputer-shell** — [plan](features/cardputer-shell/plan.md): In Progress, updated 2026-08-02
- **cloudflare-ingress** — [feature](features/cloudflare-ingress/feature.md) · [plan](features/cloudflare-ingress/plan.md): In Progress, updated 2026-07-30
- **core-api** — [feature](features/core-api/feature.md)
- **core-app-shell** — [feature](features/core-app-shell/feature.md)
- **core-event-bus** — [feature](features/core-event-bus/feature.md)
- **core-public-origin** — [plan](features/core-public-origin/plan.md): Draft, updated 2026-07-30
- **cross-app-dependencies** — [feature](features/cross-app-dependencies/feature.md) · [plan](features/cross-app-dependencies/plan.md): Draft, updated 2026-07-28
- **dependency-ordered-autostart** — [plan](features/dependency-ordered-autostart/plan.md): Draft, updated 2026-07-28
- **embedded-app-chrome** — [feature](features/embedded-app-chrome/feature.md)
- **global-mounts** — [feature](features/global-mounts/feature.md)
- **internal-endpoint-exposure** — [plan](features/internal-endpoint-exposure/plan.md): Draft, updated 2026-07-24
- **local-password-login** — [feature](features/local-password-login/feature.md)
- **observability** — [feature](features/observability/feature.md) · [plan](features/observability/plan.md): Draft, updated 2026-07-25
- **removable-system-apps** — [feature](features/removable-system-apps/feature.md)
- **repository-release-model** — [feature](features/repository-release-model/feature.md)
- **runtime-app-marketplace** — [feature](features/runtime-app-marketplace/feature.md)
- **runtime-app-update** — [feature](features/runtime-app-update/feature.md)
- **shell-access-and-system-apps** — [feature](features/shell-access-and-system-apps/feature.md)
- **shell-navigation** — [feature](features/shell-navigation/feature.md)
- **swift-shell** — [feature](features/swift-shell/feature.md)

### Legacy documents (pre-migration)

- [features/app-auth-origin-separation](features/app-auth-origin-separation.md)
- [features/app-data-backup-retention](features/app-data-backup-retention.md)
- [features/app-secrets-store](features/app-secrets-store.md) — Implemented (Core store + API in Core 0.60.0; SDK clients in `HostySdk.App` 0.3.0 and `@hosty-sdk/app` 0.4.0). Verified against a live Core 2026-07-22.
- [features/catalog-hosted-app-feeds](features/catalog-hosted-app-feeds.md)
- [features/cli-app-commands](features/cli-app-commands.md)
- [features/cli-bootstrap](features/cli-bootstrap.md)
- [features/container-capabilities](features/container-capabilities.md)
- [features/demo-app](features/demo-app.md)
- [features/direct-origin-runtime-app-ui](features/direct-origin-runtime-app-ui.md)
- [features/domain-model](features/domain-model.md)
- [features/external-mounts](features/external-mounts.md)
- [features/final-hosty-architecture](features/final-hosty-architecture.md)
- [features/host-networking](features/host-networking.md)
- [features/hosty-app-skill](features/hosty-app-skill.md)
- [features/hosty-runtime-app-platform](features/hosty-runtime-app-platform.md)
- [features/hosty-shell-image](features/hosty-shell-image.md) — Implemented.
- [features/local-development](features/local-development.md)
- [features/manifest-level-app-assets](features/manifest-level-app-assets.md) — **In progress.** Design (Q1–Q13, incl. Q3/D1–D7) confirmed 2026-07-07.
- [features/multi-service-runtime-apps](features/multi-service-runtime-apps.md)
- [features/notifications](features/notifications.md) — v1 backend implemented (Core store/service/endpoints/SSE + retention). Shell bell UI and the MCP facade remain (the latter gated on the `ai-core` branch).
- [features/raw-ports](features/raw-ports.md)
- [features/runtime-app-compact-view](features/runtime-app-compact-view.md)
- [features/runtime-app-manifest](features/runtime-app-manifest.md)
- [features/runtime-artifact-model](features/runtime-artifact-model.md)
- [features/runtime-source-workflows](features/runtime-source-workflows.md)
- [features/user-management](features/user-management.md)
- [ideas/account-switching](ideas/account-switching.md) — Idea.
- [ideas/agent-bridge-workflow](ideas/agent-bridge-workflow.md) — Idea
- [ideas/app-secrets-store](ideas/app-secrets-store.md) — Promoted (shipped — see [features/app-secrets-store.md](../features/app-secrets-store.md))
- [ideas/auth-provider-extensions](ideas/auth-provider-extensions.md) — Idea.
- [ideas/auth-session-lifecycle](ideas/auth-session-lifecycle.md) — Idea (agreed 2026-07-13)
- [ideas/backup-retention-extensions](ideas/backup-retention-extensions.md) — Idea.
- [ideas/core-dev-target](ideas/core-dev-target.md) — Idea
- [ideas/core-extension-model](ideas/core-extension-model.md) — Idea
- [ideas/core-settings](ideas/core-settings.md) — Implemented (v1 — auth lifetimes; v2 — cloudflared ingress)
- [ideas/cross-app-auth](ideas/cross-app-auth.md) — Idea (proposed 2026-07-20 — awaiting owner ratification)
- [ideas/future-work](ideas/future-work.md) — Idea.
- [ideas/gateway-and-app-wrapping](ideas/gateway-and-app-wrapping.md) — Idea.
- [ideas/hosty-app-sdk](ideas/hosty-app-sdk.md) — Phase 1 (auth) shipped and adopted — second wave open (see Adoption Status)
- [ideas/marketplace-system-app](ideas/marketplace-system-app.md) — Promoted
- [ideas/replaceable-ui-clients](ideas/replaceable-ui-clients.md) — Idea
- [ideas/runtime-app-repository-feeds](ideas/runtime-app-repository-feeds.md) — Promoted
- [ideas/runtime-app-repository-install](ideas/runtime-app-repository-install.md) — Idea
- [ideas/runtime-source-extensions](ideas/runtime-source-extensions.md) — Idea.
- [ideas/system-app-pages](ideas/system-app-pages.md) — Idea
- [ideas/system-app-updates](ideas/system-app-updates.md) — Partially implemented (2026-07-13)
- [planning/app-secrets-store](planning/app-secrets-store.md) — Implemented (Core 0.60.0; `HostySdk.App` 0.3.0, `@hosty-sdk/app` 0.4.0)
- [planning/marketplace-system-app](planning/marketplace-system-app.md) — Implemented
- [planning/plan-first-app-updates](planning/plan-first-app-updates.md) — Implemented

<!-- docs-index:end -->

---
created: 2026-05-13
updated: 2026-10-05
summary: The shared vocabulary for Core, Shell, the CLI and runtime apps.
---

# Feature: Domain Model

## Description

Hosty manages Core, Shell, CLI, and runtime apps. A runtime app is installed from an `app.0.1` manifest and has app-owned lifecycle state, runtime profile selection, service health, settings, endpoints, source state, and data backups.

## Core Concepts

- **Core** - local ASP.NET Core process that owns lifecycle, auth, user directory, app registry, backups, and control APIs.
- **Shell** - Core-managed browser runtime app that provides the user interface.
- **CLI** - local bootstrap and Core control client exposed as `hosty`.
- **Runtime app** - user workload installed from an `app.0.1` manifest URL, local manifest file, or local app directory containing `manifest.json`.
- **Runtime profile** - a selectable runtime implementation such as `docker` or `localCommand`.
- **Service** - one process or container declared by a runtime app.
- **Endpoint** - a service URL that Core can expose to Shell, CLI, or other apps.
- **App data directory** - primary persistent data path for the app.
- **App cache directory** - derived-data sibling of the data directory; persists across restarts and updates but is never backed up or restored.

## Component Boundaries

- **Core** owns auth pages, the browser and control APIs, app state, runtime lifecycle, source and
  feed state, backups, logs and policy. It owns autostart as well: Docker containers are created
  with Docker's own restart policy disabled, so the daemon never restarts an app outside Core's
  lifecycle.
- **Shell** owns only the browser UI. It is installed, started, updated and health-checked through
  the same lifecycle as any runtime app and contains no Core-owned backend or state-mutation routes.
  Core stays manageable through the CLI and its local API when Shell is stopped or failed.
- **Marketplace** owns its catalog source and storefront and has no install authority of its own: it
  requests installations that Core confirms ([Marketplace](../runtime-app-marketplace/feature.md)).
- **CLI** is the bootstrap executable and a Core API client. Ordinary commands call Core; it keeps
  its own recovery behavior only for a Core that is not installed, not running or not reachable.

## Platform At A Glance

- The `hosty` CLI bootstraps Core and discovers its control API ([CLI bootstrap](../cli-bootstrap/feature.md)).
- Shell and the other first-party apps are Core-managed runtime apps ([removable system apps](../removable-system-apps/feature.md)).
- Runtime apps install from an `app.0.1` manifest URL, a local manifest file or a local app directory ([runtime app manifest](../runtime-app-manifest/feature.md)), optionally following an app-owned feed ([app feeds](../app-feeds/feature.md)).
- Docker and `localCommand` runtime profiles, reviewed runtime switching and updates ([runtime app update](../runtime-app-update/feature.md)).
- Source checkouts and local source overrides ([runtime source workflows](../runtime-source-workflows/feature.md)).
- App auth code exchange, app-origin sessions and the scoped app directory ([auth and gateway model](../auth-gateway/feature.md)).
- The primary app data directory with backup and restore ([backup retention](../app-data-backup-retention/feature.md)), plus a cache directory that is never backed up ([app cache storage](../app-cache-storage/feature.md)).
- Host ports reserved at install for every declared service port ([automatic runtime app ports](../automatic-runtime-app-ports/feature.md)).

## Storage Layout

```text
<HOSTY_HOME>/
  apps/
    <app-id>/
      manifest.json
      state.json
      data/
      cache/
      logs/
  backups/
    <app-id>/
  core/
    auth/
    run/
  sources/
```

## App Directory

The app directory is a scoped list of Host users assigned to one runtime app. Runtime apps read it with `HOSTY_APP_SERVICE_TOKEN` and use stable Host user ids for app-owned roles.

## Testing Expectations

This document is shared vocabulary and storage layout, not behavior; it carries no tests of
its own. The layout it draws is pinned where the behavior lives — for example
`AppBackupServiceTests` for what `data/` includes and `cache/` excludes.

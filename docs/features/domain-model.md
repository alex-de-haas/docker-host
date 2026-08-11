# Domain Model

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

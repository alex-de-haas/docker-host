# Documentation

## Overview

Hosty is a local application orchestrator with a headless Core API, a Core-managed Shell runtime app, and user runtime apps. New local development and testing use runtime apps installed from `app.0.1` manifests.

```mermaid
flowchart LR
  A["app.0.1 manifest"] --> B["Hosty Core"]
  B --> C["App registry"]
  B --> D["Docker or localCommand runtime"]
  B --> E["Shell"]
  B --> F["App auth and directory"]
  D --> G["Runtime app services"]
```

## Documents

- [Roadmap](roadmap.md) - active and deferred product stages.
- [Core app shell](features/core-app-shell.md) - Shell foundation and navigation.
- [Shell access and system apps](features/shell-access-and-system-apps.md) - administrator-only management views and system app visibility.
- [Hosty runtime app platform](features/hosty-runtime-app-platform.md) - current runtime app lifecycle platform.
- [Runtime app manifest](features/runtime-app-manifest.md) - `app.0.1` manifest contract.
- [Automatic runtime app ports](features/automatic-runtime-app-ports.md) - Core-assigned local ports and `PORT` compatibility behavior.
- [Runtime app update](features/runtime-app-update.md) - update plan and apply behavior.
- [Runtime source workflows](features/runtime-source-workflows.md) - source checkout, local override, and runtime switching.
- [Multi-service runtime apps](features/multi-service-runtime-apps.md) - multiple services per app.
- [Runtime app compact view](features/runtime-app-compact-view.md) - compact Shell view of installed app services and assigned endpoints.
- [Direct origin runtime app UI](features/direct-origin-runtime-app-ui.md) - app-origin UI and auth code exchange.
- [App Auth And Origin Separation](features/app-auth-origin-separation.md) - Core-owned app auth and app-local sessions.
- [Auth And Gateway Model](features/auth-gateway.md) - current app auth, assignments, and scoped app directory.
- [User Management](features/user-management.md) - users, invitations, roles, and app access assignment.
- [Local Password Login](features/local-password-login.md) - Core-owned local password setup, recovery, invitations, and login.
- [App Data Backup Retention](features/app-data-backup-retention.md) - backup cleanup and retention.
- [CLI bootstrap](features/cli-bootstrap.md) - `hosty` command setup and Core control discovery.
- [CLI app commands](features/cli-app-commands.md) - runtime app CLI commands.
- [Core API](features/core-api.md) - current Core browser and control APIs.
- [Domain model](features/domain-model.md) - shared app-oriented vocabulary.
- [Repository and release model](features/repository-release-model.md) - monorepo and release workflows.
- [Hosty Shell Docker Image](features/hosty-shell-image.md) - draft plan for publishing browser Shell as a Core-managed Docker image.
- [Demo App](features/demo-app.md) - repository-local runtime app used for validation.
- [Local development and testing](features/local-development.md) - Core-managed local workflows.
- [Hosty App Skill](features/hosty-app-skill.md) - repository-shipped agent skill.
- [Web UI dashboard](features/web-ui-dashboard.md) - Shell dashboard and app management surface.
- [Browser account switching](features/account-switching.md) - retired behavior and future restoration boundary.
- [Final Hosty architecture boundaries](features/final-hosty-architecture.md) - Core/Shell/CLI ownership boundaries.

## Planning

Active and deferred plans:

- [Update Channels](planning/update-channels.md) - generated channel indexes, product/runtime channel selection, pull request channels, and channel cleanup.
- [Agent Bridge Workflow](planning/agent-bridge-workflow.md) - Shell annotation, agent request lifecycle, repository changes, branch/PR workflow, and PR channel validation.

# Documentation

## Overview

Docker Host Manager is a local application for managing Docker containers. The planned module model extends this from direct container management to logical modules described by JSON metadata files.

A module is a Docker-hosted functional unit. Administrators add a module by providing a direct URL to a JSON metadata file. The Host downloads that JSON file, reads the Docker image reference and module metadata, then prepares local storage and container configuration.

The Host itself is expected to run as a Docker container in production-like usage. A standalone `docker-host` CLI executable bootstraps and manages the Host container lifecycle, while the Web UI remains the primary interface for daily module management.

When one module depends on another service module, the consumer declares which dependency endpoint it needs and which environment variable should receive its base URL. The Host starts the dependency, resolves an internal URL inside one shared Host-managed Docker network, and injects that URL into the consumer container. Network aliases are derived from module ids, for example `com.modulis.storage` becomes `mod-com-modulis-storage`. This does not require Docker Compose, although Compose could be one possible implementation detail.

```mermaid
flowchart LR
  A["Metadata JSON URL"] --> B["Docker Host"]
  B --> C["Module metadata"]
  C --> D["Docker image"]
  C --> E["Dependencies"]
  C --> F["Settings schema"]
  C --> G["Storage mappings"]
  E --> I["Dependency base URLs as env vars"]
  B --> H["Installed module directory"]
```

## Documents

- [Local development and testing](features/local-development.md) - local run modes for testing Host changes without pushing an image.
- [Host launch model](features/host-launch.md) - how the Host container, `docker-host` CLI executable, Web UI, and backend API fit together.
- [CLI bootstrap](features/cli-bootstrap.md) - Phase 2 `docker-host` command surface, launch configuration, and direct Docker Engine lifecycle integration.
- [Docker Host API](features/host-api.md) - initial Host backend API endpoint catalog for Web UI and future CLI module commands.
- [Docker Host domain model](features/domain-model.md) - shared Phase 0 vocabulary for installed modules, lifecycle state, settings, storage, dependency resolution, and plans.
- [Repository and release model](features/repository-release-model.md) - monorepo layout, artifact boundaries, and independent GitHub Actions builds for Host image and CLI.
- [Module metadata files](features/module-metadata.md) - detailed draft for installing Docker-hosted modules from JSON metadata URLs.
- [Docker Host MVP implementation plan](planning/docker-host-mvp-implementation.md) - rewrite-oriented implementation sequence based on the current documentation.
- [Prototype feature inventory](planning/prototype-feature-inventory.md) - useful behaviors from the current raw-container prototype to remember during rewrite.

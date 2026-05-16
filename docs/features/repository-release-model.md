# Repository and release model

Этот документ фиксирует решение хранить Docker Host, Web UI, backend API и `docker-host` CLI в одном repository, но собирать и публиковать их как независимые release artifacts.

## Решение

Docker Host должен использовать monorepo:

- Host Web UI и backend API остаются частью одного Host application;
- Host Docker image публикуется как отдельный container artifact;
- `docker-host` CLI публикуется как отдельный standalone executable artifact;
- общий API-контракт между Host backend API, Web UI и CLI описывается в документации repository;
- GitHub Actions разделяются по artifact type и запускаются только для затронутых частей.

Такой подход сохраняет синхронизацию между CLI и Host API, но не заставляет пересобирать Host image при каждом изменении CLI.

## Предлагаемая структура

```text
apps/
  host/
    src/
    public/
    Dockerfile
    package.json
  cli/
    src/
      Haas.DockerHost.Cli/
        Haas.DockerHost.Cli.csproj
    tests/
      Haas.DockerHost.Cli.Tests/
        Haas.DockerHost.Cli.Tests.csproj
scripts/
  install.sh
docs/
  features/
    host-api.md
.github/
  workflows/
```

Repository physically follows this skeleton: the Host app lives in `apps/host`, the CLI lives in `apps/cli`, and the Host API contract is documented in `docs/features/host-api.md`.

Host API contract между Web UI, Host backend API и CLI должен быть определен в `docs/features/host-api.md` при введении CLI-facing Host API surface. Отдельный package contract, generated OpenAPI artifact и generated clients не входят в MVP.

## Component boundaries

```mermaid
flowchart LR
  A["apps/cli"] -. reads .-> B["docs/features/host-api.md"]
  C["apps/host Web UI"] -. reads .-> B
  D["apps/host backend API"] -. owns .-> B
  C --> D
  A --> D
  D --> E["Docker daemon"]
  F["apps/host/Dockerfile"] --> G["Host Docker image"]
  A --> H["CLI release artifacts"]
```

Host backend API остается единственным владельцем module management logic. Web UI вызывает этот API напрямую. CLI вызывает этот же API для module commands и работает напрямую с Docker daemon только для lifecycle самого Host container: install, start, stop, restart, update, status и logs.

## GitHub Actions model

Сборки должны быть независимыми:

- `ci.yml` - общие проверки на pull request и push;
- `host-image.yml` - build/push Host Docker image;
- `cli-release.yml` - build/publish standalone CLI artifacts;
- опционально `docs.yml` - проверки документации.

Recommended path filters:

```text
Host image build:
  apps/host/**
  apps/host/Dockerfile
  package.json
  package-lock.json
  .github/workflows/host-image.yml

CLI build:
  apps/cli/**
  docs/features/host-api.md
  scripts/install.sh
  global.json
  .github/workflows/cli-release.yml

Docs-only changes:
  docs/**
  README.md
```

Если изменился только CLI, Host image не должен публиковаться. Если изменился только Host UI без изменения API-контракта, CLI artifacts не должны публиковаться. Если изменился `docs/features/host-api.md`, CI должен проверить и Host, и CLI.

Common CI runs Host lint, Host unit tests, Host production build, CLI build, and the CLI xUnit test suite. The root `npm run ci` script mirrors that sequence for local validation.

## Release artifacts

Host release artifact:

```text
ghcr.io/<owner>/<repo>:<host-version>
ghcr.io/<owner>/<repo>:latest
ghcr.io/<owner>/<repo>:sha-<commit>
```

This matches the current repository workflow, which publishes one Host image for the repository. There is no need to add a nested `/docker-host` image path unless the repository later publishes multiple different container images.

Immutable Host versions are created from `host-v*` git tags. The Host image workflow must not publish versioned Host images for CLI tags such as `cli-dev` or future `cli-v*` tags. The `latest` tag tracks the default branch, and `sha-<commit>` tags provide traceability for every published image.

The Host image should be published as a multi-platform Linux image for `linux/amd64` and `linux/arm64`, so Docker Desktop users on Apple Silicon and standard x64 Linux hosts can pull the same image reference without local emulation setup.

CLI release artifacts:

```text
docker-host-darwin-arm64
docker-host-darwin-x64
docker-host-linux-arm64
docker-host-linux-x64
docker-host-windows-x64.exe
SHA256SUMS
```

For development and early usage, CLI artifacts are published to one rolling GitHub prerelease with tag `cli-dev`. The `cli-dev` workflow overwrites existing release assets for every new CLI build, so installation URLs stay stable while the binary tracks the latest development build.

Unix users install the current development CLI through `scripts/install.sh`:

```sh
curl -fsSL https://raw.githubusercontent.com/alex-de-haas/docker-host/main/scripts/install.sh | sh
```

Stable CLI versions are deferred until the project needs public stable releases. Later stable CLI versions can be published as immutable GitHub releases, for example `cli-v0.2.1`. Those stable release assets should not be overwritten. GitHub Actions artifacts may still be used for CI/debugging, but they are not the installation channel because they have retention limits and less convenient download URLs.

`install.sh` detects OS/architecture, downloads the right `cli-dev` artifact, verifies checksums when available, installs the executable to `~/.docker-host/bin/docker-host`, marks it executable, and prints PATH instructions. If `SHA256SUMS` is available, checksum verification is mandatory; an installer that cannot verify the checksum should fail with a clear next step.

The script is intentionally thin. It delegates launch configuration creation and Docker preflight to `docker-host install`, which owns `launch.env` parsing and validation. Re-running the installer is a repair/reinstall path: it may replace the CLI executable, but it preserves existing launch settings through the CLI config flow. The installer supports scoped overrides for forks and tests: `DOCKER_HOST_INSTALL_REPO`, `DOCKER_HOST_INSTALL_TAG`, `DOCKER_HOST_INSTALL_DIR`, and `DOCKER_HOST_INSTALL_START`.

`docker-host update` updates both the CLI executable and the Host container image. It downloads the matching CLI artifact from `cli-dev`, verifies checksums when available, safely replaces the installed executable, then pulls and recreates the Host container with the configured Host image. `scripts/install.sh` remains the first-install and repair/reinstall path. Module updates are separate module commands, for example `docker-host modules update <module-id>`.

## Release-ready validation

A published Host image should not be treated as release-ready until the release candidate has been validated from published artifacts, not a local checkout:

```sh
docker pull ghcr.io/alex-de-haas/docker-host:latest
curl -fsSL https://raw.githubusercontent.com/alex-de-haas/docker-host/main/scripts/install.sh | sh -s -- --start
```

The manual release checklist is:

- install the CLI through the curl flow;
- confirm `docker-host install` validates Docker Engine reachability and Linux-container mode;
- start the published Host image with `docker-host start`;
- install a module through the Host UI/API using a metadata URL;
- remove the installed module and confirm preserved/deleted data behavior follows the remove plan;
- update an installed module and confirm the update plan, apply, and retry behavior work against the published Host image;
- run `docker-host update` and confirm the CLI channel plus Host image update path still works.

This checklist can later move into an automated smoke workflow, but the manual checklist is the MVP release gate.

## Versioning

CLI и Host image могут иметь независимые версии:

```text
host-v0.3.0
cli-v0.2.1
```

During early development, `cli-dev` is the main CLI distribution channel. Immutable `cli-v*` releases can be introduced when the project needs stable public versions.

При изменении API-контракта нужно явно проверить совместимость:

- старый CLI с новым Host API;
- новый CLI со старым Host API, если поддерживается upgrade path;
- version negotiation или понятная ошибка, если версии несовместимы.

Для базового этапа достаточно, чтобы CLI отправлял свой version и ожидаемую contract version в запросах к Host API, а Host возвращал понятную ошибку при несовместимости.

## Why not separate repositories

Отдельные repositories стоит рассматривать позже, если CLI станет самостоятельным продуктом с отдельным release process, командой или roadmap.

На текущем этапе отдельные repositories создадут больше проблем, чем пользы:

- сложнее менять API-контракт атомарно;
- сложнее гарантировать совместимость CLI и Host API;
- сложнее делать pull request, который одновременно меняет backend endpoint и CLI command;
- сложнее синхронизировать release notes и install script;
- выше риск, что CLI начнет дублировать business logic Host backend.

Monorepo лучше соответствует текущей архитектуре: один продукт, несколько independently built artifacts.

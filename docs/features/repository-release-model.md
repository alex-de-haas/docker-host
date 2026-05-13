# Repository and release model

Этот документ фиксирует решение хранить Docker Host, Web UI, backend API и `docker-host` CLI в одном repository, но собирать и публиковать их как независимые release artifacts.

## Решение

Docker Host должен использовать monorepo:

- Host Web UI и backend API остаются частью одного Host application;
- Host Docker image публикуется как отдельный container artifact;
- `docker-host` CLI публикуется как отдельный standalone executable artifact;
- общий API-контракт между Host backend API, Web UI и CLI хранится в repository рядом с кодом;
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
    DockerHost.Cli.csproj
packages/
  contracts/
    openapi.yaml
    generated/
scripts/
  install.sh
docs/
  features/
  planning/
.github/
  workflows/
```

На текущем этапе repository еще может физически не соответствовать этой структуре. Документ описывает целевую организацию, к которой нужно двигаться при появлении полноценного CLI и общего API-контракта.

## Component boundaries

```mermaid
flowchart LR
  A["apps/cli"] --> B["packages/contracts"]
  C["apps/host Web UI"] --> B
  D["apps/host backend API"] --> B
  C --> D
  A --> D
  D --> E["Docker daemon"]
  F["Dockerfile"] --> G["Host Docker image"]
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
  packages/contracts/**
  Dockerfile
  package.json
  package-lock.json
  .github/workflows/host-image.yml

CLI build:
  apps/cli/**
  packages/contracts/**
  scripts/install.sh
  .github/workflows/cli-release.yml

Docs-only changes:
  docs/**
  README.md
```

Если изменился только CLI, Host image не должен публиковаться. Если изменился только Host UI без изменения API-контракта, CLI artifacts не должны публиковаться. Если изменился общий API-контракт, CI должен проверить и Host, и CLI.

## Release artifacts

Host release artifact:

```text
ghcr.io/<owner>/<repo>:<version>
ghcr.io/<owner>/<repo>:latest
ghcr.io/<owner>/<repo>:sha-<commit>
```

This matches the current repository workflow, which publishes one Host image for the repository. There is no need to add a nested `/docker-host` image path unless the repository later publishes multiple different container images.

CLI release artifacts:

```text
docker-host-darwin-arm64
docker-host-darwin-x64
docker-host-linux-arm64
docker-host-linux-x64
docker-host-windows-x64.exe
```

`install.sh` должен скачивать CLI artifact под текущие OS и architecture. CLI уже после установки управляет Host container и использует configured Host image reference.

## Versioning

CLI и Host image могут иметь независимые версии:

```text
host-v0.3.0
cli-v0.2.1
```

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

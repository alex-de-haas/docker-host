# Host launch model

Этот документ описывает черновую модель запуска самого Docker Host. Это отдельный вопрос от запуска модулей: сначала нужно надежно поднять Host, а уже через него управлять modules.

## Решение

Host должен иметь Web UI без альтернативы: через него администратор видит список модулей, Docker container status, настройки, storage mounts, обновления и установку новых модулей.

Production-like запуск Host должен быть container-first:

- Host распространяется и запускается как Docker image/container;
- первый запуск и lifecycle самого Host выполняет standalone CLI executable с командой `docker-host`;
- Web UI является основным интерфейсом ежедневного управления модулями;
- CLI может выполнять module operations, но через тот же Host backend API, что и Web UI;
- бизнес-логика установки и обновления модулей живет в Host backend, а не дублируется в CLI.

Standalone `docker-host` CLI реализуется первым, потому что он должен быть надежным recovery path для Host container lifecycle: install, start, stop, restart, update, status, logs, open и configuration. Module metadata runtime начинается после того, как CLI умеет стабильно bootstrap/manage Host container.

Для первого CLI milestone Host container может продолжать запускать существующий Host application code. Текущий Next.js Docker container management UI остается рабочим launch target и smoke-test example, пока CLI bootstrap flow строится вокруг production-like Host container запуска.

## Компоненты

```mermaid
flowchart LR
  A["docker-host CLI"] --> B["Docker daemon"]
  B --> C["Host container"]
  D["Browser"] --> E["Host Web UI"]
  E --> F["Host backend API"]
  C --> E
  C --> F
  A --> F
  F --> B
  F --> G["Managed module containers"]
```

### Host container

Host container запускает Web UI и backend API. Backend API содержит module management logic и работает с Docker daemon через mounted Docker socket.

Host container отвечает за:

- установку модулей из metadata URLs;
- lifecycle module containers;
- Docker daemon status модулей;
- settings и storage mappings;
- updates module images;
- отображение ошибок Docker operations.

### Web UI

Web UI - основной рабочий интерфейс администратора.

Через UI должны быть доступны:

- список модулей;
- Docker container statuses;
- добавление module metadata URL;
- установка, запуск, остановка, рестарт и удаление модулей;
- настройка settings;
- настройка module-owned storage и external storage mounts;
- просмотр логов;
- update modules.

В MVP Host не вводит module health checks или readiness probes. UI показывает только состояние контейнера, которое возвращает Docker daemon. Унифицированные module health checks должны быть отдельной future feature.

### `docker-host` CLI executable

CLI нужен в первую очередь для bootstrap и lifecycle самого Host container.

`docker-host` CLI должен распространяться как standalone executable без внешнего runtime. Базовая реализация: .NET self-contained single-file application с использованием Spectre.Console для terminal UI, prompts, status output, tables, progress indicators и командной структуры.

Это решение является обязательным для первой CLI implementation. CLI artifact должен запускаться без установленного .NET runtime на машине администратора.

Базовые команды:

```text
docker-host install
docker-host uninstall
docker-host start
docker-host stop
docker-host restart
docker-host update
docker-host status
docker-host logs
docker-host open
docker-host config
docker-host auth
```

Lifecycle-команды работают напрямую через Docker daemon, потому что Host API может быть еще не запущен или может быть сломан.

Auth bootstrap and recovery commands also remain local-first. `docker-host auth setup-token` writes a one-time setup token hash into the Host data root so the first administrator can be created through `/setup` without relying on a pre-existing Host API session.

`docker-host uninstall` сохраняет сам CLI executable, но удаляет Host-managed runtime и local state: Host container, known module containers, Host/module images when Docker allows it, shared module network when it is no longer in use, launch configuration, and Host state under the data root. После этого `docker-host install` должен восстановить launch configuration и базовую структуру директорий.

В первой CLI implementation lifecycle-команды будут обращаться к Docker daemon напрямую через Docker Engine API. CLI не должен запускать установленный Docker CLI executable для Host lifecycle operations.

Docker Engine communication должен быть изолирован в adapter layer, чтобы CLI commands не знали конкретные HTTP endpoint paths, request bodies и transport details.

CLI также может иметь команды управления модулями:

```text
docker-host modules list
docker-host modules add <metadata-url>
docker-host modules restart <module-id>
docker-host modules update <module-id>
docker-host modules logs <module-id>
```

Эти команды должны обращаться к Host backend API. Они не должны повторно реализовывать module installation logic внутри CLI.

## Quick install script

Для быстрой установки из терминала используется Unix `scripts/install.sh`. Это чистый shell bootstrap script, который скачивает latest development `docker-host` CLI executable из GitHub Release `cli-dev`, ставит его локально и подготавливает первый запуск Host container.

Пример установки:

```sh
curl -fsSL https://raw.githubusercontent.com/alex-de-haas/docker-host/main/scripts/install.sh | sh
```

Пример быстрого запуска:

```sh
curl -fsSL https://raw.githubusercontent.com/alex-de-haas/docker-host/main/scripts/install.sh | sh
docker-host start
docker-host open
```

Более осторожный вариант:

```sh
curl -fsSL https://raw.githubusercontent.com/alex-de-haas/docker-host/main/scripts/install.sh -o install.sh
sh install.sh
docker-host start
docker-host open
```

`install.sh` должен:

- делегировать проверку local Docker endpoint и Linux-container-mode установленному `docker-host` CLI;
- определить OS/architecture;
- скачать подходящий `docker-host` standalone executable artifact из GitHub Release `cli-dev`;
- проверить `SHA256SUMS`, если checksum file доступен, и завершиться с понятной ошибкой, если проверку нельзя выполнить;
- положить executable в user-writable bin directory, например `~/.docker-host/bin/docker-host`;
- сделать файл executable;
- добавить `~/.docker-host/bin` в shell profile для будущих терминальных сессий или вывести точную команду, если profile нельзя определить;
- вызвать `docker-host install`, чтобы создать default Host data root `~/.docker-host` и подготовить launch configuration для Host container в `~/.docker-host/config/launch.env`;
- сохранять существующие значения `launch.env` при повторном запуске installer;
- поддерживать scoped overrides для forks, installer tests и кастомных shell profiles: `DOCKER_HOST_INSTALL_REPO`, `DOCKER_HOST_INSTALL_TAG`, `DOCKER_HOST_INSTALL_DIR`, `DOCKER_HOST_INSTALL_PROFILE`, `DOCKER_HOST_INSTALL_SKIP_PATH_UPDATE`, `DOCKER_HOST_INSTALL_START`;
- не дублировать module management logic;
- после установки вывести следующие команды и URL Web UI.

`install.sh` должен оставаться shell-only bootstrap layer for Unix-like systems. Сам `docker-host` CLI при этом не является shell script: это standalone executable, который не требует установленного .NET runtime, Node.js/npm или другого package manager.

На базовом этапе CLI implementation target:

- `net10.0` .NET self-contained single-file executable;
- project file `Haas.DockerHost.Cli.csproj`;
- root namespace `Haas.DockerHost.Cli`;
- published command name `docker-host` via project `AssemblyName` or release artifact rename;
- Spectre.Console для rich terminal output;
- cross-platform artifacts под поддерживаемые OS/architecture;
- test project created with the initial CLI scaffold;
- без зависимости от установленного runtime на машине администратора.

Recommended CLI layout:

```text
apps/
  cli/
    src/
      Haas.DockerHost.Cli/
        Haas.DockerHost.Cli.csproj
        Program.cs
        Commands/
        Configuration/
        Docker/
    tests/
      Haas.DockerHost.Cli.Tests/
        Haas.DockerHost.Cli.Tests.csproj
```

Docker Engine communication should be isolated inside the `Haas.DockerHost.Cli.Docker` namespace. The layer should have two levels:

- Docker Engine API transport: connects to Docker Engine over the configured local endpoint and returns structured status, headers, body and Docker error details;
- high-level Docker Engine adapter: exposes typed methods such as pull image, inspect container, create network, run Host container, start container, stop container, remove container and get logs.

CLI commands should not construct Docker Engine URLs or request bodies directly. Commands call the high-level adapter, while the adapter owns exact Docker Engine endpoints and structured JSON parsing for operations such as container inspect.

Because the CLI is a .NET executable and must support both Unix sockets and Windows named pipes, Docker Engine integration should use `Docker.DotNet` or an equivalent Docker Engine API client that supports both transports. The CLI still must not shell out to the `docker` executable. If a library is used, keep it behind the Host-specific adapter so command code remains independent from library models.

### Docker daemon access

CLI lifecycle commands должны управлять Host container через Docker daemon. The local Host launch model supports these Docker endpoint forms:

```text
macOS/Linux/WSL: unix:///var/run/docker.sock
native Windows: npipe:////./pipe/docker_engine
```

Native Windows support targets Docker Desktop with the WSL 2 Linux engine. Windows containers mode is explicitly unsupported for the MVP. If Docker reports `OSType != linux`, `docker-host install/start/status` should fail with a clear diagnostic that Docker Host requires Docker Desktop Linux containers.

CLI использует `HOST_DOCKER_ENDPOINT` для lifecycle commands самого Host container. Это endpoint на машине администратора, через который CLI общается с Docker Engine.

Host container остается Linux-based и получает доступ к Docker daemon через Unix socket path внутри Docker Desktop/Engine VM:

```text
/var/run/docker.sock:/var/run/docker.sock
```

`HOST_DOCKER_SOCKET` обозначает container-side socket path, который Host container видит как `/var/run/docker.sock`. Это отдельное значение от `HOST_DOCKER_ENDPOINT`: на native Windows CLI endpoint будет named pipe, но Host container socket mount still uses `/var/run/docker.sock`.

`DOCKER_HOST`, TCP, SSH, TLS и non-standard Docker daemon endpoints не входят в scope первой implementation. Их можно рассмотреть позже, если появится требование поддерживать remote Docker daemons.

Для первой CLI implementation доступ к Docker daemon выполняется напрямую через Docker Engine API over local Unix socket or Windows named pipe. Docker CLI executable не является runtime dependency для `docker-host` CLI.

Пример итоговой структуры после `install.sh`:

```text
~/.docker-host/
  bin/
    docker-host
  config/
    launch.env
  modules/
```

`~/.docker-host/config/launch.env` должен хранить параметры запуска самого Host container как env-style key/value file: image reference, container name, UI port, Docker endpoint, Docker socket mount, data mount, `HOST_DATA_ROOT_HOST`, `HOST_DATA_ROOT_CONTAINER`, restart policy и другие значения, которые нужны `docker-host start/restart/update`.

The file should stay shell-compatible for Unix values generated by `scripts/install.sh`, but the `docker-host` CLI owns parsing and writing. On Windows it must preserve platform-native paths such as `C:\Users\<user>\.docker-host` as raw values instead of applying Unix shell expansion rules.

Пример `launch.env`:

```env
HOST_IMAGE=ghcr.io/example/docker-host-manager:latest
HOST_CONTAINER_NAME=docker-host
HOST_DATA_ROOT_HOST=$HOME/.docker-host
HOST_DATA_ROOT_CONTAINER=/data
HOST_UI_PORT=auto
HOST_BIND_ADDRESS=127.0.0.1
HOST_PUBLIC_ORIGIN=
HOST_GATEWAY_BASE_DOMAIN=
HOST_RESTART_POLICY=unless-stopped
HOST_DOCKER_ENDPOINT=unix:///var/run/docker.sock
HOST_DOCKER_SOCKET=/var/run/docker.sock
HOST_MODULE_NETWORK=docker-host-modules
```

On native Windows, `docker-host install` should persist a Windows-appropriate default:

```env
HOST_DOCKER_ENDPOINT=npipe:////./pipe/docker_engine
HOST_DOCKER_SOCKET=/var/run/docker.sock
```

`HOST_DATA_ROOT_HOST` should also be resolved to a platform-native absolute path during install, for example `C:\Users\<user>\.docker-host` on Windows.

CLI должен передавать в Host container оба значения data root:

- `HOST_DATA_ROOT_HOST` - path на host machine, который Docker daemon должен использовать как bind mount source для module containers;
- `HOST_DATA_ROOT_CONTAINER` - path внутри Host container, который Host backend использует для чтения и записи собственного state.

`HOST_IMAGE` должен по умолчанию указывать на Host image, публикуемый текущим repository workflow: `ghcr.io/<owner>/<repo>:latest`. Это значение должно быть переопределяемым через `docker-host config`.

Gateway-related launch settings:

- `HOST_BIND_ADDRESS` defaults to `127.0.0.1`; administrators can set `0.0.0.0` when placing the Host behind external ingress.
- `HOST_PUBLIC_ORIGIN` is the canonical external Host UI origin, for example `https://host.example.com`.
- `HOST_GATEWAY_BASE_DOMAIN` is the parent domain for module subdomains, for example `example.com`.

`docker-host config` должен быть typed interface к известным Host launch settings, а не произвольным editor для `launch.env`.

MVP syntax:

```text
docker-host config list
docker-host config get HOST_IMAGE
docker-host config set HOST_IMAGE docker-host:dev
docker-host config set HOST_DATA_ROOT_HOST ~/.docker-host-dev
docker-host config set HOST_IMAGE=docker-host:dev
docker-host config reset HOST_IMAGE
```

`config list` печатает все launch settings с текущими значениями. `config get <KEY>` печатает одно значение. `config set <KEY> <VALUE>` и удобная форма `config set <KEY>=<VALUE>` записывают значение в `launch.env`. `config reset <KEY>` возвращает настройку к default value.

CLI должен валидировать known keys перед записью. Unknown keys должны возвращать понятную ошибку. `HOST_UI_PORT` должен принимать `auto` или valid TCP port number. `HOST_BIND_ADDRESS` должен принимать `127.0.0.1` или `0.0.0.0`. `HOST_PUBLIC_ORIGIN` должен быть absolute `http`/`https` origin без path. `HOST_GATEWAY_BASE_DOMAIN` должен быть valid DNS name или empty value. `HOST_DOCKER_ENDPOINT` должен принимать только supported local endpoints для текущей платформы: Unix socket on macOS/Linux/WSL или Docker Desktop named pipe on native Windows. `HOST_DATA_ROOT_CONTAINER` и `HOST_DOCKER_SOCKET` должны оставаться `/data` и `/var/run/docker.sock` для MVP launch model и не должны изменяться через обычный config flow.

Если `~/.docker-host/bin` не находится в `PATH`, install script должен добавить idempotent PATH-блок в shell profile. Для `zsh` используется `~/.zshrc`; для `bash` используется типичный bash profile текущей платформы; для `sh` используется `~/.profile`. Если profile нельзя определить или запись отключена через `DOCKER_HOST_INSTALL_SKIP_PATH_UPDATE=1`, script должен напечатать инструкцию:

```sh
export PATH="$HOME/.docker-host/bin:$PATH"
```

`DOCKER_HOST_INSTALL_PROFILE` может явно задать profile path для кастомных shell setup.

Default install script не должен автоматически запускать Host container без явного согласия администратора. Для one-command сценария можно поддержать флаг или environment variable:

```sh
curl -fsSL https://raw.githubusercontent.com/alex-de-haas/docker-host/main/scripts/install.sh | sh -s -- --start
```

или:

```sh
DOCKER_HOST_INSTALL_START=1 curl -fsSL https://raw.githubusercontent.com/alex-de-haas/docker-host/main/scripts/install.sh | sh
```

При `--start` или `DOCKER_HOST_INSTALL_START=1` script выполняет:

```text
docker-host install
docker-host start
docker-host open
```

`install.sh` должен быть тонким bootstrap layer. После установки все дальнейшие операции выполняет standalone executable `docker-host`.

## First launch flow

Первый запуск через CLI:

```text
docker-host install
docker-host start
docker-host open
```

`docker-host install` должен проверить доступность local Docker Engine, убедиться, что daemon работает в Linux-container mode, и подготовить launch configuration:

- Docker access: local CLI endpoint through `HOST_DOCKER_ENDPOINT`, with the Host container receiving `/var/run/docker.sock:/var/run/docker.sock`;
- Host image reference: default value bundled with CLI, override через `docker-host config`;
- Host data root: default `~/.docker-host` на машине администратора;
- Host container data mount: `~/.docker-host:/data`;
- Host container env: `HOST_DATA_ROOT_HOST=<host-data-root>` and `HOST_DATA_ROOT_CONTAINER=/data`;
- UI port mapping: CLI выбирает свободный host port по умолчанию, override через `docker-host config`;
- restart policy: default `unless-stopped`, override через `docker-host config`;
- container name: default `docker-host`, override через `docker-host config`;
- Host container должен быть подключен к shared module network;
- required environment variables: `HOST_DATA_ROOT_HOST=<host-data-root>` and `HOST_DATA_ROOT_CONTAINER=/data`;
- Windows preflight: Docker Engine must be reachable through `npipe:////./pipe/docker_engine` and must report Linux container mode.

Launch configuration должна храниться в:

```text
~/.docker-host/config/launch.env
```

CLI должен читать этот файл для `start`, `restart`, `update`, `status` и `logs`, чтобы повторно использовать одни и те же launch parameters.

Минимальный container launch contract:

```text
--name docker-host
--restart unless-stopped
-p <auto-selected-host-port>:3000
-v /var/run/docker.sock:/var/run/docker.sock
-v ~/.docker-host:/data
-e HOST_DATA_ROOT_HOST=~/.docker-host
-e HOST_DATA_ROOT_CONTAINER=/data
--network <shared-module-network>
<host-image-reference>
```

Все значения, кроме container-side data root `/data`, должны быть переопределяемы через `docker-host config`.

`docker-host start` создает или запускает Host container с сохраненной конфигурацией.

`docker-host open` открывает Web UI в браузере или печатает URL.

Для локальной проверки без push CLI должен поддерживать override `HOST_IMAGE` на локально собранный image tag, например `docker-host:dev`. Детальный dev/test flow описан в [Local development and testing](local-development.md).

## Restart and update

`docker-host restart` должен перезапускать Host container без изменения module data.

`docker-host update` должен:

- обновить standalone CLI executable из rolling GitHub Release `cli-dev`;
- скачать matching CLI artifact для текущих OS/architecture;
- проверить `SHA256SUMS`, если checksum file доступен;
- сравнить скачанный artifact с текущим executable и явно вывести, был ли CLI обновлен или уже актуален;
- если artifact отличается, заменить установленный `docker-host` binary безопасно: скачать во временный файл рядом с target executable, выставить permissions и затем заменить target;
- pull новой версии Host image;
- остановить текущий Host container;
- пересоздать Host container с теми же volumes, env vars, port mappings и restart policy;
- сохранить Host data root;
- показать понятную ошибку, если CLI artifact update или Docker operation failed.

`scripts/install.sh` используется для первой установки и также может быть повторно запущен как repair/reinstall path, но штатная update-команда обновляет и CLI, и Host container.

Обновление модулей должно выполняться отдельными module commands через Host backend API, например:

```text
docker-host modules update <module-id>
```

Host UI может позже получить кнопку self-update, но CLI должен оставаться recovery path, потому что UI недоступен во время recreate самого Host container.

## Shared API model

Web UI и CLI module commands должны использовать один Host backend API.

Это дает одну реализацию:

```text
Web UI -> Host backend API -> Docker daemon
CLI    -> Host backend API -> Docker daemon
```

CLI должен обращаться напрямую к Docker daemon только для lifecycle самого Host container: install, start, stop, restart, update, status, logs.

## Repository and release boundary

Host Web UI, backend API, Host Docker image definition and `docker-host` CLI should live in one monorepo, while being released as separate artifacts. The detailed repository layout, GitHub Actions path filters, and versioning model are described in [Repository and release model](repository-release-model.md).

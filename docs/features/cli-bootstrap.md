# CLI bootstrap

The `hosty` CLI is the recovery path for the Host container lifecycle. It is a .NET `net10.0` executable and uses Spectre.Console for terminal output.

`docker-host` remains a deprecated compatibility alias during the Hosty migration. New documentation and examples should prefer `hosty`.

## Command surface

Implemented commands:

```text
hosty install
hosty uninstall
hosty start
hosty stop
hosty restart
hosty update
hosty status
hosty logs
hosty open
hosty config
hosty apps
hosty modules
hosty auth
```

`hosty config` is a typed interface for known Host launch settings:

```text
hosty config list
hosty config get <KEY>
hosty config set <KEY> <VALUE>
hosty config set <KEY>=<VALUE>
hosty config reset <KEY>
```

Unknown setting keys are rejected. `HOST_UI_PORT` accepts `auto` or a TCP port number. `HOST_DOCKER_ENDPOINT` is limited to the supported local Docker Engine endpoint for the current platform.

`hosty apps` is the preferred trusted-control-backed app command group. It covers app list, install/add, start, stop, restart, update, runtime switching, remove, app data backup, app data restore, app logs, app identity, and app open links. Local development uses app manifests with local command runtime profiles, for example `hosty apps install apps/demo-app/manifest.json --runtime dev`. `hosty modules` and `docker-host modules` remain compatibility aliases for legacy module management. The detailed command behavior is documented in [CLI module commands](cli-module-commands.md).

`hosty auth` contains local authentication recovery and bootstrap commands:

```text
hosty auth setup-token
hosty auth recovery-token
```

`auth setup-token` creates a one-time first-admin setup token in the Host auth JSON store under `HOST_DATA_ROOT_HOST/auth/state.json`. It stores only the token hash and prints the raw token for local use in `/setup`.

`auth recovery-token` creates a one-time recovery token through local machine access and writes only the token hash to `HOST_DATA_ROOT_HOST/auth/state.json`. The command also records a sanitized audit event in `HOST_DATA_ROOT_HOST/auth/audit.ndjson`.

CLI app/module and dev commands do not use Host user credentials or bearer tokens. They read `<HOST_DATA_ROOT_HOST>/run/control.json` and call the Host's local `/control/v1` channel with the discovered control contract version and per-start control secret.

## Launch configuration

The CLI persists launch settings in the selected CLI root:

```text
~/.hosty/config/launch.env
```

The legacy `~/.docker-host/config/launch.env` remains readable when the legacy root is selected.

The Host writes trusted control discovery for the local CLI in:

```text
<HOST_DATA_ROOT_HOST>/run/control.json
```

Default values:

```env
HOST_IMAGE=ghcr.io/alex-de-haas/docker-host:latest
HOST_CONTAINER_NAME=docker-host
HOST_DATA_ROOT_HOST=$HOME/.hosty
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

On native Windows, the Docker endpoint default is:

```env
HOST_DOCKER_ENDPOINT=npipe:////./pipe/docker_engine
```

For tests and isolated local checks, `HOSTY_HOME` can override the CLI root. Legacy `DOCKER_HOST_HOME` remains supported. When an override is present, the default `HOST_DATA_ROOT_HOST` follows the override root instead of the user's real home directory.

Default root selection without overrides:

1. use `~/.hosty` when it exists;
2. otherwise use `~/.docker-host` when it exists;
3. otherwise create and use `~/.hosty`.

If both roots exist, `~/.hosty` wins and Hosty does not merge legacy state automatically.

## Docker Engine integration

The CLI does not shell out to the Docker executable for lifecycle operations. Docker Engine communication is isolated under `Haas.DockerHost.Cli.Docker`:

```mermaid
flowchart LR
  A["CLI command"] --> B["Host lifecycle helper"]
  B --> C["Typed Docker adapter"]
  C --> D["Docker Engine transport"]
  D --> E["Unix socket or Windows named pipe"]
  C --> F["Docker Engine API JSON"]
```

The transport supports:

- `unix:///var/run/docker.sock` on macOS, Linux, and WSL;
- `npipe:////./pipe/docker_engine` on native Windows.

When the CLI runs inside WSL with Docker Desktop for Windows, Docker Desktop WSL integration must be enabled for the active distro. If integration is disabled, commands running in that distro cannot reach `/var/run/docker.sock` even when Docker Desktop itself is running.

The high-level adapter owns Docker Engine paths, request payloads, response parsing, and Docker error diagnostics. Commands call typed methods for image pull, container inspect/create/start/stop/remove, logs, and network inspect/create.

## Lifecycle behavior

`hosty install` creates the root directories, writes `launch.env`, validates Docker Engine Linux container mode, and pulls the configured Host image so rolling tags such as `latest` are refreshed before the first start. If `HOST_IMAGE` is a single-component local tag such as `docker-host:dev` and that image already exists locally, install keeps the local image and skips the registry pull.

`hosty uninstall` removes Host-managed runtime and local state while preserving the CLI executable. It removes installed module containers known from `modules.json`, removes the Host container, attempts to remove Host/module images and the Host-managed module network, deletes launch configuration, and deletes Host state files. When the data root is the selected default root, uninstall clears that directory except for `bin/` so the installed CLI remains runnable. If `HOST_DATA_ROOT_HOST` points outside the CLI root, uninstall removes only known Host state paths such as `apps.json`, `apps/`, `backups/`, `modules.json`, and `modules/` from that external data root. `hosty install` recreates launch configuration and Host directories after uninstall and refreshes the configured Host image.

`hosty start`:

- validates launch settings;
- verifies Docker Engine reports Linux container mode;
- creates the shared module network if needed;
- checks the configured Host image before creating or starting a stopped Host container;
- pulls registry-backed Host image references so rolling tags such as `latest` can move forward;
- falls back to a locally cached Host image when the registry pull fails and the configured image already exists locally;
- recreates a stopped Host container when the configured image tag now points at a different local image id;
- selects a free loopback host port when `HOST_UI_PORT=auto`;
- creates and starts the Host container with Docker socket, data root, env vars, restart policy, and module network.

`hosty stop` reads the installed module registry from `HOST_DATA_ROOT_HOST`, stops every known Host-managed module container through Docker Engine, and then stops the Host container. This keeps the command useful as a recovery path even when the Host API or local control channel is unavailable. If the module registry cannot be read, the CLI warns that module containers may require manual cleanup and still stops the Host container.

`hosty restart` recreates the Host container with the current launch settings while preserving `HOST_DATA_ROOT_HOST`.

`hosty update` downloads the matching CLI artifact from the rolling GitHub prerelease `cli-dev`, showing Spectre.Console progress for the checksum file and CLI artifact. Downloads with a known `Content-Length` show a determinate progress bar, percentage, downloaded bytes, transfer speed, and remaining time; downloads without a known size show an indeterminate dotted spinner, downloaded bytes, and transfer speed. The command verifies `SHA256SUMS` when available, compares the downloaded artifact with the current executable, reports whether the CLI was updated or already current, and synchronizes both managed executable names: `hosty` and deprecated `docker-host`. It does not pull the Host image, recreate the Host container, or relaunch the updated executable. At the end it recommends restarting the Host with `hosty stop` and `hosty start`; the next `start` checks the configured Host image and recreates the stopped container only when the image id changed.

`hosty open` uses Docker container port metadata to open the current Host UI URL, with a plain URL fallback when browser launch fails.

Remote Docker endpoints, TLS, SSH, and `DOCKER_HOST` environment discovery are not part of the local Host launch model.

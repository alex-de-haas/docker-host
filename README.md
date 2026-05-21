# Docker Host Manager

Monorepo for Docker Host Manager, including the Host Web UI/backend API and the standalone `docker-host` CLI.

## Concepts

- [Project documentation](docs/root.md) contains the current module model, feature notes, and follow-up backlog.

## Install Current CLI Build

The Unix installer downloads the rolling `cli-dev` CLI release, verifies `SHA256SUMS` when available, installs `docker-host` under `~/.docker-host/bin`, adds that directory to your shell profile when possible, and delegates Docker preflight, Host image pull, and launch configuration setup to the CLI:

```bash
curl -fsSL https://raw.githubusercontent.com/alex-de-haas/docker-host/main/scripts/install.sh | sh
```

Open a new terminal, then start and open the Host:

```bash
docker-host start
docker-host open
```

Install the repository demo module:

```bash
docker-host modules install https://raw.githubusercontent.com/alex-de-haas/docker-host/main/modules/demo-module/metadata.json
```

To remove the Host container, Host-managed Docker resources, launch configuration, and local Host state while keeping the `docker-host` CLI executable:

```bash
docker-host uninstall
```

Run `docker-host install` again to recreate launch configuration, Host directories, and refresh the configured Host image.

For one-command install and start:

```bash
curl -fsSL https://raw.githubusercontent.com/alex-de-haas/docker-host/main/scripts/install.sh | sh -s -- --start
```

## Local development

Detailed local testing guidance is documented in [Local development and testing](docs/features/local-development.md).

Run the app directly on the host:

```bash
npm install
npm run host:dev
```

For UI work with isolated development state, auto-login, a switchable normal
user, and the repository demo app:

```bash
npm run host:dev:demo
```

This uses `.docker-host-dev-demo/` in the repository as the Host data root,
starts the demo module dev server, enables development-only auto-login, signs in
as `host.admin` by default, and remembers a normal `host.user` account in the
same browser account menu. Production setup-token behavior is unchanged.

The server connects to Docker using:

1. `DOCKER_SOCKET_PATH`, if set
2. `DOCKER_HOST`, if set
3. `/var/run/docker.sock`, by default

Examples:

```bash
DOCKER_SOCKET_PATH=/var/run/docker.sock npm run host:dev
DOCKER_HOST=unix:///var/run/docker.sock npm run host:dev
DOCKER_HOST=tcp://127.0.0.1:2375 npm run host:dev
```

## Running in Docker Desktop

For production-like local testing without pushing an image, build a local development tag first:

```bash
docker build -f apps/host/Dockerfile -t docker-host:dev .
```

If the app itself runs in a container, the container does not automatically get access to the host Docker socket. Mount it explicitly:

```bash
docker run --rm --name docker-host-dev -p 3000:3000 \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v "$HOME/.docker-host-dev:/data" \
  -e HOST_DATA_ROOT_HOST="$HOME/.docker-host-dev" \
  -e HOST_DATA_ROOT_CONTAINER=/data \
  docker-host:dev
```

If you expose Docker over TCP instead, pass `DOCKER_HOST`:

```bash
docker run --rm --name docker-host-dev -p 3000:3000 \
  -e DOCKER_HOST=tcp://host.docker.internal:2375 \
  -v "$HOME/.docker-host-dev:/data" \
  -e HOST_DATA_ROOT_HOST="$HOME/.docker-host-dev" \
  -e HOST_DATA_ROOT_CONTAINER=/data \
  docker-host:dev
```

Notes:

- `host.docker.internal:2375` only works if Docker Desktop is configured to expose the daemon over TCP.
- Mounting `/var/run/docker.sock` is the usual Docker Desktop setup for containerized tools like this.
- With the socket or `DOCKER_HOST` configured, the app can also update its own container image. The UI will be briefly unavailable while the new container takes over.

## Build image

```bash
docker build -f apps/host/Dockerfile -t docker-host .
```

## CLI development

Build the standalone CLI project:

```bash
npm run cli:build
```

Run the xUnit CLI test suite:

```bash
npm run cli:test
```

Run the same aggregate checks used by CI:

```bash
npm run ci
```

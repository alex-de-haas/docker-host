# Docker Host Manager

Monorepo for Docker Host Manager as it evolves into Hosty, including the Host Web UI/backend API and the standalone `hosty` CLI. The `docker-host` command remains a deprecated compatibility alias during migration.

## Concepts

- [Project documentation](docs/root.md) contains the current module model, feature notes, and follow-up backlog.

## Install Current CLI Build

The Unix installer downloads the rolling `cli-dev` CLI release, verifies `SHA256SUMS` when available, installs `hosty` under `~/.hosty/bin`, refreshes the deprecated `docker-host` alias, adds that directory to your shell profile when possible, and delegates Docker preflight, Host image pull, and launch configuration setup to the CLI:

```bash
curl -fsSL https://raw.githubusercontent.com/alex-de-haas/docker-host/main/scripts/install.sh | sh
```

Open a new terminal, then start and open the Host:

```bash
hosty start
hosty open
```

From a local checkout, install the repository Demo App:

```bash
hosty apps install apps/demo-app/manifest.json
```

## Install Hosty App Skill

Install the global Codex skill used to wrap applications from other repositories as Hosty runtime apps by asking Codex:

```text
Use $skill-installer to install the skill from alex-de-haas/docker-host at skills/hosty-app-skill.
```

The built-in Codex skill installer installs into `$CODEX_HOME/skills` and is the preferred first-install path inside the Codex app.

For repeatable command-line updates, run:

```bash
curl -fsSL https://raw.githubusercontent.com/alex-de-haas/docker-host/main/scripts/install-hosty-app-skill.sh | sh
```

Run the same command again to update the installed skill after Hosty runtime app contracts change. This is useful because the built-in installer does not overwrite an existing skill directory. Restart Codex after installing or updating, then invoke it explicitly from another repository with:

```text
Use $hosty-app-skill to wrap this app as a Hosty runtime app.
```

From a local checkout, install the current working copy of the skill with:

```bash
sh scripts/install-hosty-app-skill.sh --source-dir skills/hosty-app-skill
```

To remove the Host container, Host-managed Docker resources, launch configuration, and local Host state while keeping the `hosty` CLI executable:

```bash
hosty uninstall
```

Run `hosty install` again to recreate launch configuration, Host directories, and refresh the configured Host image.

For one-command install and start:

```bash
curl -fsSL https://raw.githubusercontent.com/alex-de-haas/docker-host/main/scripts/install.sh | sh -s -- --start
```

## Local development

Detailed local testing guidance is documented in [Local development and testing](docs/features/local-development.md).

Run Core and Shell directly from source with a seeded development admin:

```bash
npm install
npm run dev
```

This starts Core on `http://localhost:3001`, Shell on
`http://localhost:3000`, uses `.hosty-dev/` as an isolated data root, and
creates `admin@hosty.local` when no enabled local user exists.

If those ports are already occupied, either stop the existing Core/Shell or run
with explicit origins:

```bash
HOSTY_CORE_URL=http://localhost:3301 HOST_SHELL_PUBLIC_ORIGIN=http://localhost:3300 npm run dev
```

Run Core and Shell as separate processes when debugging one side:

```bash
npm run core:dev
npm run shell:dev
```

For runtime app work with Hosty identity and Shell integration, install the app
manifest with its local runtime profile and start it through Core:

```bash
npm run core:dev
hosty apps install apps/demo-app/manifest.json --runtime dev
hosty apps start com.haas.demo-app
```

The Core process listens on `http://127.0.0.1:3001` by default. The demo app
manifest's `dev` runtime profile starts local command services on ports `3100`
and `3101`.

The server connects to Docker using:

1. `DOCKER_SOCKET_PATH`, if set
2. `DOCKER_HOST`, if set
3. `/var/run/docker.sock`, by default

On Windows with Docker Desktop, enable WSL integration for the WSL distro where you run these commands. Without that integration, `/var/run/docker.sock` is unavailable in that distro even when Docker Desktop is running.

For direct app API probes that need Hosty identity, ask Core to issue a real
app identity token instead of inventing one:

```bash
TOKEN="$(hosty apps identity com.haas.demo-app --user user@docker-host.local --format token)"
curl -H "X-Docker-Host-Identity: $TOKEN" http://127.0.0.1:3100/api/auth/identity
```

Use `hosty apps open com.haas.demo-app --user user@docker-host.local` for
Shell or standalone launch links. Do not treat standalone app runs as valid
Hosty identity tests.

Examples:

```bash
DOCKER_SOCKET_PATH=/var/run/docker.sock npm run core:dev
DOCKER_HOST=unix:///var/run/docker.sock npm run core:dev
DOCKER_HOST=tcp://127.0.0.1:2375 npm run core:dev
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

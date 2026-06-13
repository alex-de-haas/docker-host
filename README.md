# Hosty

Monorepo for Hosty: the local-first Core API, the Shell browser client, the first-party Demo App, and the standalone `hosty` CLI.

See the [project documentation](docs/root.md) for the runtime app model, feature notes, and backlog.

## Install

The installer downloads the rolling `cli-dev` build, verifies `SHA256SUMS` when available, installs `hosty` under the local bin directory, and adds it to PATH. The first `hosty start` downloads the matching Core executable into `~/.hosty/core/bin`.

**macOS / Linux**

```bash
curl -fsSL https://raw.githubusercontent.com/alex-de-haas/docker-host/main/scripts/install.sh | sh
```

**Windows PowerShell**

```powershell
irm https://raw.githubusercontent.com/alex-de-haas/docker-host/main/scripts/install.ps1 | iex
```

Open a new terminal, then start Core and create the first administrator:

```bash
hosty start
hosty auth setup-token
```

Open the printed Setup URL, set the admin email and password, then open Shell:

```bash
hosty open
```

Install the repository Demo App from a local checkout:

```bash
hosty apps install apps/demo-app
```

### One-command install and start

**macOS / Linux**

```bash
curl -fsSL https://raw.githubusercontent.com/alex-de-haas/docker-host/main/scripts/install.sh | sh -s -- --start
```

**Windows PowerShell**

```powershell
$env:HOSTY_INSTALL_START = "1"; irm https://raw.githubusercontent.com/alex-de-haas/docker-host/main/scripts/install.ps1 | iex
```

Then run `hosty auth setup-token` and open the printed Setup URL to create the first administrator.

### Manage local state

```bash
hosty uninstall   # remove local Hosty state, keep the CLI executable
hosty install     # recreate local Hosty directories
```

## Hosty App Skill

The Hosty App skill teaches an agent to wrap applications from other repositories as Hosty runtime apps. It ships as a standard Agent Skill, so any agent that reads `SKILL.md` — Claude Code, Codex, and others — can use it.

### With the Skills CLI (recommended)

If you use the [`skills`](https://github.com/vercel-labs/skills) CLI, let it install the skill and link it into every agent you have:

```bash
npx skills add alex-de-haas/docker-host --skill hosty-app-skill
```

It detects your installed agents and keeps a single canonical copy, so re-running it updates the skill everywhere at once.

### With the bundled installer (no dependencies)

Otherwise, the repository script copies the skill into each agent's skills directory — Claude Code (`~/.claude/skills`) and Codex (`~/.codex/skills`):

```bash
curl -fsSL https://raw.githubusercontent.com/alex-de-haas/docker-host/main/scripts/install-hosty-app-skill.sh | sh
```

Re-run it to update after runtime app contracts change. Use `--agent claude` or `--agent codex` to target a single agent, and `--source-dir` to install the working copy from a local checkout:

```bash
sh scripts/install-hosty-app-skill.sh --source-dir skills/hosty-app-skill
```

### Use the skill

Restart the agent, then invoke the skill from another repository:

```text
Use $hosty-app-skill to wrap this app as a Hosty runtime app.
```

## Local development

See [Local development and testing](docs/features/local-development.md) for detailed guidance.

Run Core and Shell from source with a seeded development admin:

```bash
npm install
npm run dev
```

This starts Core on `http://localhost:3001` and Shell on `http://localhost:3000`, uses `.hosty-dev/` as an isolated data root, and seeds two local users: `admin@hosty.local` (admin) and `user@hosty.local` (user).

If those ports are taken, override them:

```bash
HOSTY_CORE_PORT=3301 HOSTY_SHELL_PORT=3300 npm run dev
```

Run Core and Shell as separate processes to debug one side:

```bash
npm run core:dev
npm run shell:dev
```

### Runtime apps

Install an app manifest with its local runtime profile and start it through Core:

```bash
npm run core:dev
hosty apps install apps/demo-app --runtime dev
hosty apps start com.haas.demo-app
```

The installed CLI runs Core from this checkout only when a project is passed explicitly:

```bash
hosty core start --project apps/core/src/Haas.Hosty.Core/Haas.Hosty.Core.csproj
```

**Default ports**

| Process            | Core   | Shell  |
| ------------------ | ------ | ------ |
| Installed CLI      | `7070` | `7171` |
| Source dev scripts | `3001` | `3000` |

The demo app's `dev` runtime profile starts local command services on ports `3100` and `3101`.

### Docker

Core runs Docker apps by shelling out to the `docker` CLI (`docker pull`/`run`/`stop`/`rm`), so it talks to whatever daemon your `docker` command is configured to reach — the active `docker context`, or `DOCKER_HOST` if set. The `docker` CLI must be installed and on `PATH`.

```bash
docker version                                       # confirm the CLI reaches a daemon
DOCKER_HOST=tcp://127.0.0.1:2375 npm run core:dev    # point Core at a non-default daemon
```

On Windows with Docker Desktop, enable WSL integration for the distro where you run these commands so the `docker` CLI is available there.

Apps can also use the `localCommand` runtime, which runs commands directly without Docker — that is what the demo app's `dev` profile uses.

### App identity probes

To probe an app API that needs Hosty identity, have Core issue a real token instead of inventing one:

```bash
TOKEN="$(hosty apps identity com.haas.demo-app --user user@hosty.local --format token)"
curl -H "X-Docker-Host-Identity: $TOKEN" http://127.0.0.1:3100/api/auth/identity
```

Use `hosty apps open com.haas.demo-app --user user@hosty.local` for Shell or standalone launch links. Standalone app runs are not valid Hosty identity tests.

## CLI development

```bash
npm run cli:build   # build the standalone CLI project
npm run cli:test    # run the xUnit CLI test suite
npm run ci          # run the same aggregate checks as CI
```

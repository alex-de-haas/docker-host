# Hosty

Monorepo for Hosty: the local-first Core API, the Shell browser client, the optional Marketplace system app, the first-party Demo App, and the standalone `hosty` CLI.

See the [project documentation](docs/root.md) for the runtime app model, feature notes, and backlog.

This disposable Harness acceptance branch verifies GitHub review against an exact published head.
The fixture is intentionally documentation-only and must not be merged.
A second synthetic fixture commit exercises stale-head protection for review replies.

## Install

The installer downloads the rolling `cli-dev` build, requires and verifies `SHA256SUMS`, installs `hosty` under the local bin directory, and adds it to PATH. `hosty init` downloads Core into `~/.hosty/core/bin` if it is missing, then configures this installation. Existing Core binaries are reused; `hosty update` upgrades them explicitly.

**macOS / Linux**

```bash
curl -fsSL https://raw.githubusercontent.com/alex-de-haas/docker-host/main/scripts/install.sh | sh
```

**Windows PowerShell**

```powershell
irm https://raw.githubusercontent.com/alex-de-haas/docker-host/main/scripts/install.ps1 | iex
```

Open a new terminal and initialize Hosty:

```bash
hosty init
```

Choose the applications you want. Shell and Marketplace are recommended and preselected; Core is
always included. Ports are assigned automatically and retained across restarts. Once the selected
apps are ready, init prints a setup link and opens the browser. Enter your administrator email,
name and password there; Shell opens after registration when installed. Docker must be running
for the standard application profiles.

Repeat `hosty init` to resume an interrupted installation or request a fresh registration link.
It keeps the same data root, users and completed work. Use `hosty init --review` only to explicitly
review changed choices or distribution inputs after a failed initialization. Once initialized, use `hosty start` to start
Core and `hosty setup` to add or remove distribution apps. Core-only installations are supported:
use `hosty init --core-only` and manage the host with CLI/API. For scripts, use `--yes` for the
recommended selection, `--apps <ID>[,..]` for an explicit selection, and `--no-open` to print the link
without opening a browser. See `hosty init --help` for advanced port and source-project options.

Dashboard's **Sandboxes → Create environment** starts a separate fresh Core with its own selected
apps and normal administrator registration. It shares the initialization mechanism with init;
repeating init itself never creates another environment.

Install the repository Demo App from a local checkout:

```bash
hosty apps install apps/demo-app
```

### One-command install and initialize

**macOS / Linux**

```bash
curl -fsSL https://raw.githubusercontent.com/alex-de-haas/docker-host/main/scripts/install.sh | sh -s -- --start
```

**Windows PowerShell**

```powershell
$env:HOSTY_INSTALL_START = "1"; irm https://raw.githubusercontent.com/alex-de-haas/docker-host/main/scripts/install.ps1 | iex
```

These forms initialize with the recommended apps without a terminal checklist, then open/print the administrator registration link. Omit the start option to choose apps interactively with `hosty init` afterwards.

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

Otherwise, the repository script copies the skill into the skills directory of each agent you have installed — Claude Code (`~/.claude/skills`) and Codex (`~/.codex/skills`):

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

Install .NET SDK 10.0.401 or a later .NET 10 SDK, as required by `global.json`. This includes
the Native AOT fix needed for current macOS linkers; older SDKs can fail during native linking.

See [Local development and testing](docs/features/local-development/feature.md) for detailed guidance.

Run Core and Shell from source:

```bash
npm install
npm run dev
```

This starts Core on `http://localhost:3001` and Shell on `http://localhost:3000`, using `.hosty-dev/` as an isolated data root. Sign-in requires an email and password in every environment; no default users or passwords are created.

After Core is ready, initialize a new development data root from another terminal:

```bash
hosty --data-root "$PWD/.hosty-dev" auth setup-token
```

Open the returned Core setup link and choose your administrator email and password. For an existing
development account without a password, use `auth recovery-token` instead. If `HOSTY_DEV_DATA_ROOT`
overrides the data root, pass that same absolute path to the CLI.

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

Marketplace uses the same Core-managed development flow:

```bash
hosty apps install apps/marketplace/manifest.json --runtime dev
hosty apps start hosty.marketplace
hosty apps open hosty.marketplace
```

Runtime apps published through Marketplace keep `app-feeds.0.1` in their own repository. See the Demo App's `apps/demo-app/feeds.json` for the canonical single-feed example.

The installed CLI runs Core from this checkout only when a project is passed explicitly:

```bash
hosty core start --project apps/core/src/Haas.Hosty.Core/Haas.Hosty.Core.csproj
```

**Ports**

| Process            | Core   | Shell  |
| ------------------ | ------ | ------ |
| Fresh `hosty init` | Automatic, persisted | Automatic, persisted |
| Source dev scripts | `3001` | `3000` |

Existing installations retain their assigned ports. Init prints the actual Core/Shell URLs.

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

Use `hosty apps open com.haas.demo-app` for Shell or standalone launch links. Standalone app runs are not valid Hosty identity tests.

## CLI development

```bash
npm run cli:build   # build the standalone CLI project
npm run cli:test    # run the xUnit CLI test suite
npm run ci          # run the same aggregate checks as CI
```

## License

Hosty is licensed under the [GNU Affero General Public License v3.0](LICENSE) (AGPL-3.0-only).

In short: you are free to use, self-host, modify, and redistribute Hosty — including for personal and internal commercial use. If you distribute a modified version, or run one that users interact with over a network — whether they are external customers or people inside your organization — you must offer those users its source code under the same license. For commercial licensing outside these terms, contact the author.

### Hosty Harness replacement

The former AI Gateway is now **Hosty Harness** (`hosty.harness`, `apps/harness`). Update in order:
Core/CLI **0.110.0+**, Shell **0.85.0+**, then uninstall `hosty.ai-gateway` and install Harness
**0.35.1+** fresh. Confirm its role/permissions, configure providers again and select it in Shell.
The old `apps/ai-gateway` manifest/feed URLs are retired; no aliases, state migration or credential
import are provided. Reconnect external MCP clients to the newly assigned Harness endpoint.
See the [contract and replacement procedure](docs/features/hosty-harness-rename/feature.md).

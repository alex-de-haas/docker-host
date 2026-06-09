# CLI Bootstrap

## Description

The Hosty CLI is exposed as `hosty`. It installs and updates the local CLI executable, bootstraps the installed Core executable, discovers the Core control API, and manages runtime apps through `hosty apps`.

## Commands

```bash
hosty install
hosty update
hosty uninstall
hosty core start
hosty core start --project apps/core/src/Haas.Hosty.Core/Haas.Hosty.Core.csproj
hosty core stop
hosty auth setup-token
hosty auth recovery-token
hosty apps list
hosty apps install apps/demo-app/manifest.json --runtime dev
```

## Root Selection

`HOSTY_HOME` can override the local Hosty root for tests and isolated runs. The default root is:

```text
~/.hosty
```

The installer places the CLI in:

```text
~/.hosty/bin/hosty
```

The installed Core executable is not placed on `PATH`. The CLI owns it under:

```text
~/.hosty/core/bin/hosty-core
```

On Windows the executable names use `.exe`.

`launch.env` also carries the default Shell bootstrap settings passed to Core:

```text
HOST_SHELL_PUBLIC_ORIGIN=http://localhost:3000
HOSTY_SHELL_MANIFEST_PATH=https://raw.githubusercontent.com/alex-de-haas/docker-host/main/apps/shell/manifest.json
HOSTY_SHELL_BOOTSTRAP_RUNTIME=docker
```

`HOSTY_SHELL_MANIFEST_PATH` can be a local manifest path or an HTTP(S) manifest URL. `HOSTY_SHELL_BOOTSTRAP_RUNTIME` selects the runtime profile Core should use when installing or reconciling `hosty.shell`.

Existing managed `launch.env` files that still contain the previous `http://127.0.0.1:3001` Core public origin or `http://127.0.0.1:3000` Shell public origin are migrated to the `localhost` defaults when the CLI loads and saves launch settings. Custom non-default origins are preserved.

## Core Bootstrap

`hosty start` and `hosty core start` start the installed Core executable by default. If `~/.hosty/core/bin/hosty-core` is missing, the CLI downloads the platform Core artifact from the rolling release, verifies `SHA256SUMS` when available, installs it into `core/bin`, and starts it.

Start does not check for newer Core builds when Core is already installed. Freshness checks and replacement are owned by `hosty update`.

After Core starts, Core bootstraps Hosty Shell as the system runtime app `hosty.shell` from the configured Shell manifest reference and runtime. The default installed configuration downloads `apps/shell/manifest.json` from GitHub and starts `ghcr.io/alex-de-haas/hosty-shell:latest` through Docker.

For a fresh installed data root, create the first administrator through Core-owned local setup:

```bash
hosty auth setup-token
```

Open the printed Setup URL, enter the first administrator email and password, and then use `/login` for later browser sessions. If an older local administrator does not have a password credential, use `hosty auth recovery-token` once to set a replacement password.

Explicit source mode is available only through `--project`:

```bash
hosty core start --project apps/core/src/Haas.Hosty.Core/Haas.Hosty.Core.csproj
```

The CLI does not scan the current directory or repository parents for a Core project when `--project` is omitted.

## Update

`hosty update` updates the managed CLI executable first. If that succeeds, it checks the current platform Core artifact, installs it when missing, or replaces the installed Core executable when a newer artifact is available. A running Core process uses the updated executable after the next restart.

Before replacing the running single-file CLI executable, `hosty update` preloads the CLI assembly dependency closure. This keeps the current update process from lazily loading managed assemblies from the replaced bundle while it continues into the Core and Shell checks.

On Windows, if the installed Core executable already exists, `hosty update` first makes a best-effort Core stop request before replacing the executable because a running `.exe` is normally locked by the process.

Shell remains a Core-managed runtime app. Core startup reconciles `hosty.shell` against the configured Shell manifest when the installed runtime matches `HOSTY_SHELL_BOOTSTRAP_RUNTIME`. `hosty update` still asks the running Core for Shell update planning when Core is reachable so operators can inspect pending Shell changes explicitly.

## Control Discovery

Core writes a local control discovery document under the run directory. CLI commands read that file and call `/control/v1` with `X-Hosty-Control-Secret`.

## Uninstall

`hosty uninstall` requests Core shutdown when local control discovery is available, then removes Hosty-owned state while preserving the CLI executable directory.

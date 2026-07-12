# CLI Bootstrap

Created: 2026-05-13
Updated: 2026-07-11

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
hosty apps install apps/demo-app --runtime dev
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

On Windows, `scripts/install.ps1` places the CLI in:

```text
%USERPROFILE%\.hosty\bin\hosty.exe
```

The installed Core executable is not placed on `PATH`. The CLI owns it under:

```text
~/.hosty/core/bin/hosty-core
```

On Windows the executable names use `.exe`.

The managed Core launch settings have these defaults:

```text
HOSTY_DATA_ROOT=$HOME/.hosty
HOSTY_CORE_PORT=7070
HOSTY_SHELL_PORT=7171
HOSTY_CORE_PUBLIC_ORIGIN=
HOSTY_SHELL_PUBLIC_ORIGIN=
HOSTY_SHELL_MANIFEST_PATH=
HOSTY_SHELL_BOOTSTRAP_RUNTIME=docker
HOSTY_COLLECTOR_MANIFEST_PATH=
HOSTY_MARKETPLACE_MANIFEST_PATH=
```

`hosty core start` reads these defaults directly when `launch.env` has not been written yet.
`hosty config list`, `hosty config set`, and `hosty config reset` create or rewrite
`~/.hosty/config/launch.env` with the managed settings.

`HOSTY_DATA_ROOT` defines the Hosty state root used by Core. `HOSTY_CORE_PORT` and `HOSTY_SHELL_PORT` define the local ports for installed CLI launches. Public origins are unset by default; configure `HOSTY_CORE_PUBLIC_ORIGIN` and `HOSTY_SHELL_PUBLIC_ORIGIN` only when the browser-facing origin differs from the local launch port or must be explicit for deployment.

Which first-party apps Core preinstalls — and where their manifests live — is decided by the release-owned distribution list (`distribution-apps.0.1`, embedded in the Core binary; a source tree's repo-root `distribution-apps.json` wins) merged with the operator's `hosty setup` choices. See `docs/ideas/generic-bootstrap.md`.

`HOSTY_SHELL_MANIFEST_PATH`, `HOSTY_COLLECTOR_MANIFEST_PATH`, and `HOSTY_MARKETPLACE_MANIFEST_PATH` are **deprecated** explicit overrides: empty (the default) means the distribution list decides; a non-empty value is injected into Core's environment and honored with a deprecation warning when it differs from the list. Values equal to the old pre-distribution default URLs that an earlier CLI materialized into `launch.env` are scrubbed on load — they were never operator intent. `HOSTY_SHELL_BOOTSTRAP_RUNTIME` still selects the runtime profile Core uses when installing or reconciling `hosty.shell`.

`HOSTY_RUNTIME_PUBLIC_HOST` (optional, default `127.0.0.1`) is the host Core advertises and dials for a runtime app's published loopback port. It defaults to the IPv4 loopback literal on purpose: docker publishes these ports on `127.0.0.1` only, and on hosts where `localhost` resolves to `::1` first (Windows, dual-stack Linux) .NET's `HttpClient` stalls on the unbound `::1` until the request times out, so telemetry and health reads silently return empty. Override it only for a deployment that publishes runtime-app ports on a different address.

Legacy `HOST_DATA_ROOT_HOST`, `HOSTY_CORE_DATA_ROOT`, `HOST_CORE_PUBLIC_ORIGIN`, `HOST_SHELL_PUBLIC_ORIGIN`, and `HOST_PUBLIC_ORIGIN` settings are not read.

## Core Bootstrap

`hosty start` and `hosty core start` start the installed Core executable by default. If `~/.hosty/core/bin/hosty-core` is missing, the CLI downloads the platform Core artifact from the rolling release, verifies `SHA256SUMS` when available, installs it into `core/bin`, and starts it.

Start does not check for newer Core builds when Core is already installed. Freshness checks and replacement are owned by `hosty update`.

After Core starts, Core reconciles the distribution list against the operator's bootstrap choices and preinstalls the enabled entries (Shell and Marketplace by default; Telemetry opt-in). First installation of an entry uses the manifest's default runtime unless the entry carries Core-owned policy (the Shell); later startup reconciliation preserves the installed runtime and autostart choices. Marketplace catalog configuration remains an ordinary app setting; Core has no catalog-source setting or Marketplace proxy.

## Choosing preinstalled apps

```bash
hosty setup                          # interactive checklist
hosty setup --list                   # show the distribution list and current selection
hosty setup --with hosty.telemetry   # enable an app without prompting
hosty setup --without hosty.marketplace --yes
```

`hosty setup` writes only the operator's intent into `{data root}/core/bootstrap-choices.json` (`bootstrap-choices.0.1`); manifest locations are never persisted and always resolve from the current release's distribution list. An explicit setup run pins every presented entry, so a later release flipping a default does not override a confirmed selection. Core's own telemetry producers follow the telemetry app itself (installed = active), so there is no observability flag to keep in step. Choices apply on the next Core start; setup warns when Core is currently running. Uninstalling a distribution-installed app records `enabled=false` automatically, so the next boot does not reinstall it.

`hosty open` opens `HOSTY_SHELL_PUBLIC_ORIGIN` when it is configured. Otherwise it opens the local Shell URL derived from `HOSTY_SHELL_PORT`.

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

`hosty update` updates the CLI executable first. If that succeeds, it checks the current platform Core artifact, installs it when missing, or replaces the installed Core executable when a newer artifact is available. A running Core process uses the updated executable after the next restart.

The CLI ships as a single Native AOT executable, so the running process holds no separate managed assemblies and never lazily loads code from its own file. `hosty update` can therefore replace the on-disk executable and continue straight into the Core and Shell checks without any dependency preloading.

On Windows, if the installed Core executable already exists, `hosty update` first makes a best-effort Core stop request before replacing the executable because a running `.exe` is normally locked by the process.

Shell remains a Core-managed runtime app. Core startup reconciles `hosty.shell` against the configured Shell manifest when the installed runtime matches `HOSTY_SHELL_BOOTSTRAP_RUNTIME`. `hosty update` still asks the running Core for Shell update planning when Core is reachable so operators can inspect pending Shell changes explicitly.

## Control Discovery

Core writes a local control discovery document under the run directory. CLI commands read that file and call `/control/v1` with `X-Hosty-Control-Secret`.

If Core rejects a control request with HTTP 401, the CLI treats the discovery as stale or mismatched and exits with a friendly error instead of throwing an unhandled exception. Verify the active Core with `hosty core status`; if no matching Core is running, remove the stale `~/.hosty/core/run/control.json` file and start Core again.

## Uninstall

`hosty uninstall` requests Core shutdown when local control discovery is available, then removes Hosty-owned state while preserving the CLI executable directory.

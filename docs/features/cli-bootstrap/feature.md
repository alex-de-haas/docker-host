# CLI Bootstrap

Created: 2026-05-13
Updated: 2026-09-01

## Description

The Hosty CLI is exposed as `hosty`. It installs and updates the local CLI executable, bootstraps the installed Core executable, discovers the Core control API, and manages runtime apps through `hosty apps`. The CLI is not a configuration store: a client addresses an instance by its data root alone and discovers everything else from the instance itself (see [core-runtime-parameters](../core-runtime-parameters/feature.md)).

## Commands

```bash
hosty install
hosty update
hosty uninstall
hosty core start
hosty core start --port 7171
hosty core start --project apps/core/src/Haas.Hosty.Core/Haas.Hosty.Core.csproj
hosty core stop
hosty core settings list
hosty auth setup-token
hosty auth recovery-token
hosty apps list
hosty apps install apps/demo-app --runtime dev
```

## Root Selection

Every command addresses one Hosty environment — a data root. Resolution order:

1. the global `--data-root <path>` flag (accepted before or after the command name),
2. `HOSTY_DATA_ROOT`,
3. `HOSTY_HOME` (the legacy override; Core still honors it too),
4. the hardcoded per-platform default `~/.hosty`.

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

There is no launch config file and no `hosty config` command. The listen port is a per-environment
value in the instance's own settings store (`hosty core settings set HOSTY_CORE_PORT <port>`, effective
on the next start; `hosty core start --port` overrides it for a single run). `HOSTY_CORE_PUBLIC_ORIGIN`
is a plain environment variable Core reads; the CLI neither stores nor injects it.

A legacy `~/.hosty/config/launch.env` is migrated read-and-delete on the CLI's first contact: a
non-default `HOSTY_CORE_PORT` is folded into the target root's settings store, a non-default
`HOSTY_DATA_ROOT` produces a notice pointing at `--data-root`/`HOSTY_DATA_ROOT` (the pointer cannot
live inside the root it points to), a set `HOSTY_CORE_PUBLIC_ORIGIN` is echoed as an
export-it-yourself notice, and the file is deleted.

Which first-party apps a brand-new host is seeded with — and where their manifests and feeds live — comes from the release-owned distribution catalog (`distribution-apps.0.1`, embedded in the Core binary; a source tree's repo-root `distribution-apps.json` wins). Seeding happens once; afterwards `hosty setup` installs and uninstalls catalog entries as ordinary lifecycle operations against a running Core. See [removable-system-apps](../removable-system-apps/feature.md).

The per-app manifest-path overrides `HOSTY_SHELL_MANIFEST_PATH`, `HOSTY_COLLECTOR_MANIFEST_PATH`, and `HOSTY_MARKETPLACE_MANIFEST_PATH` are not CLI concerns: manifest locations come from the distribution catalog, and `hosty setup` decides which apps are installed. Core still honors these as raw ambient environment variables during its own deprecation window, so an air-gapped fork can still export one directly for the Core process, but the CLI neither persists nor injects them.

A system app's runtime profile is likewise a normal per-app choice — the manifest's `defaultRuntime` on first install (`docker` for Shell, Telemetry, and Marketplace), switchable afterwards with `hosty apps switch-runtime`, and preserved across reconciles and updates like any other app. Core honors `HOSTY_SHELL_BOOTSTRAP_RUNTIME` and `HOSTY_COLLECTOR_BOOTSTRAP_RUNTIME` as **ambient dev/fork-only overrides** (the CLI never sets them): unset, the runtime is the manifest default; a source tree or air-gapped fork can export one to pin a non-default profile at first install. This is the mechanism the `npm run dev` orchestrator uses to run Shell from the working tree's `dev` localCommand profile.

`HOSTY_RUNTIME_PUBLIC_HOST` (optional, default `127.0.0.1`) is the host Core advertises and dials for a runtime app's published loopback port. It defaults to the IPv4 loopback literal on purpose: docker publishes these ports on `127.0.0.1` only, and on hosts where `localhost` resolves to `::1` first (Windows, dual-stack Linux) .NET's `HttpClient` stalls on the unbound `::1` until the request times out, so telemetry and health reads silently return empty. Override it only for a deployment that publishes runtime-app ports on a different address.

Legacy `HOST_DATA_ROOT_HOST`, `HOSTY_CORE_DATA_ROOT`, `HOST_CORE_PUBLIC_ORIGIN`, `HOST_SHELL_PUBLIC_ORIGIN`, and `HOST_PUBLIC_ORIGIN` settings are not read.

## Core Bootstrap

`hosty start` and `hosty core start` start the installed Core executable by default. If `~/.hosty/core/bin/hosty-core` is missing, the CLI downloads the platform Core artifact from the rolling release, verifies `SHA256SUMS` when available, installs it into `core/bin`, and starts it.

One Core process runs per data root. `core start` preflights the root's `control.json`: a live Core with no conflicting intent is reported as already running; a conflicting `--port`/`--url` is refused by naming the live instance (root, PID, endpoint). Core enforces the same rule itself with a per-root file lock, so a direct `dotnet run` second start is refused identically.

Start does not check for newer Core builds when Core is already installed. Freshness checks and replacement are owned by `hosty update`.

On a brand-new host, Core seeds the distribution catalog's default entries once (Shell and Marketplace by default; Telemetry opt-in) and records that it did. Later starts install nothing at all, so an app the operator removed stays removed. Installation uses the manifest's default runtime; the installed runtime and autostart choices are the operator's from then on. Marketplace catalog configuration remains an ordinary app setting; Core has no catalog-source setting or Marketplace proxy.

## Installing and removing first-party apps

```bash
hosty setup                          # interactive checklist of the catalog
hosty setup --list                   # show the catalog and what is installed
hosty setup --with hosty.telemetry   # install an app without prompting
hosty setup --without hosty.marketplace --yes
hosty setup --with hosty.shell       # reinstall a removed Shell
```

The checkboxes are the host's actual installed state: ticking an entry installs it, unticking an installed entry uninstalls it. Both are real lifecycle operations against a running Core — an install is `POST /control/v1/core/bootstrap/{appId}/install` (Core resolves the manifest or feed from the catalog, so no location reaches the CLI), an uninstall is the ordinary app remove. There is no intent file: `hosty setup` requires Core to be running and fails with a `hosty core start` hint when it is not. Uninstalls keep app data unless `--delete-data` is passed, so a reinstall picks up where it left off. Core's own telemetry producers follow the telemetry app itself (installed = active), so there is no observability flag to keep in step.

`hosty open` asks the running Core for Shell's origin (resolved from Shell's own app record) and opens it; a host without Shell installed has nothing to open and the command says so.

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

Shell remains a Core-managed runtime app. Core startup reconciles `hosty.shell` against the configured Shell manifest, preserving the installed runtime profile (the manifest default on first install, or whatever the operator later switched to with `hosty apps switch-runtime`). `hosty update` still asks the running Core for Shell update planning when Core is reachable so operators can inspect pending Shell changes explicitly.

## Control Discovery

Core writes a local control discovery document under the run directory. CLI commands read that file and call `/control/v1` with `X-Hosty-Control-Secret`.

If Core rejects a control request with HTTP 401, the CLI treats the discovery as stale or mismatched and exits with a friendly error instead of throwing an unhandled exception. Verify the active Core with `hosty core status`; if no matching Core is running, remove the stale `~/.hosty/core/run/control.json` file and start Core again.

## Uninstall

`hosty uninstall` requests Core shutdown when local control discovery is available, then removes Hosty-owned state while preserving the CLI executable directory. The resolved root is the data root it cleans; an external root is addressed with `--data-root` like any other command.

## Testing Expectations

- Root resolution order (flag → `HOSTY_DATA_ROOT` → `HOSTY_HOME` → default) and the global
  `--data-root` extraction, including the `--data-root=<path>` form.
- The launch.env migration: fold-in of a non-default port, the non-default-root and public-origin
  notices, and the delete (plus the file surviving a failed fold).
- `core start` preflight: refusal of a conflicting second start naming the live instance; the
  idempotent already-running report through discovery.
- `hosty core settings` round-trips (list/get/set/reset) over `/control/v1/settings`, including the
  down-Core failure mode.
- Uninstall against both the default root and an explicitly addressed external root.

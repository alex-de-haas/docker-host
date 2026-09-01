# Core Runtime Parameters — Two Launch Flags, Everything Else Lives Inside

Created: 2026-09-01
Updated: 2026-09-01

Core's launch surface is two process parameters — the data root and the port — with hardcoded
defaults. Everything else an operator tunes lives in the instance's own settings store. There is no
`launch.env` and no `hosty config`: the CLI launches and updates Core but is not a configuration
store. A client addresses an instance by its data root alone and discovers everything else from the
instance itself (`{root}/core/run/control.json`).

## The Two Parameters

- **Data root** — the instance's identity; it says where everything else lives, so it cannot be a
  setting. Resolution (identical in the CLI and in Core): the `--data-root` flag →
  `HOSTY_DATA_ROOT` → `HOSTY_HOME` (legacy override) → the hardcoded per-platform default
  `~/.hosty`. The CLI accepts `--data-root` globally, on any command; Core parses it off its own
  argv, so a direct `dotnet run -- --data-root …` behaves the same.
- **Port** — a per-environment value. Core resolves it at startup: the `--port` flag →
  `HOSTY_CORE_PORT` → the port of an explicit `HOSTY_CORE_URL`/`ASPNETCORE_URLS` → the root's
  stored value → 7070. A flag or env var affects that run only; persisting a change goes through
  settings (`hosty core settings set HOSTY_CORE_PORT <port>`), and takes effect on the next start.
  The CLI does not compute or own the port: `hosty core start` passes only the data root (plus
  `--port`/`--url` as this-run overrides when given) and discovers the live endpoint from
  `control.json`.

`HOSTY_CORE_PUBLIC_ORIGIN` is not a launch parameter either: it is a live setting in the same store,
with the environment variable surviving as a baseline the stored value wins over. See
[core-public-origin](../core-public-origin/feature.md).

## Port in the Settings Store

`{root}/core/settings.json` carries an additive `Server` group (same `core-settings.0.1` schema)
holding `HOSTY_CORE_PORT` and `HOSTY_CORE_PUBLIC_ORIGIN`. The admin surface (`/api/core/settings`)
lists the port as a "Listen port" row whose description states that a change applies on the next start;
validation is 1–65535. At startup Core reads the stored value directly from the file, leniently — an
absent file, foreign schema version, or unparsable value falls back to the default. The two keys share
the group but not the precedence: a flag or env var outranks the stored port for one run, while the
stored public origin outranks its environment variable (see
[core-public-origin](../core-public-origin/feature.md)).

## Per-Root Exclusivity

One Core process runs per data root, enforced by Core itself before the listener binds: the entry
point opens `{root}/core/run/core.lock` with `FileShare.None` and holds it for the process lifetime.
Ports do not guard this — a second start against a live root with a different port would bind
happily and then share the root's databases, settings and instance identity — so the lock refuses a
second start on ANY port, and the refusal names the live instance (root, PID and endpoint from the
root's `control.json`) instead of surfacing a bare error. A discovery file naming a dead PID is
never presented as the live instance. There is no stale-lock recovery to perform: the OS releases
the lock when the holder dies, and the leftover lock file is simply reopened.

`hosty core start` preflights the same rule for a friendlier failure: a live discovery with no
conflicting intent reports the running Core (idempotent start); a conflicting `--port`/`--url` is
refused naming the live instance. Direct starts that bypass the CLI hit Core's own lock.

## Instance Identity on Docker Resources

Each non-default root stores a GUID at `{root}/core/instance-id`, generated at first start under
the root lock — stable across folder moves. The default root uses the reserved empty id. The id
scopes docker resources:

- non-default instances label containers with `hosty.instance=<id>` and use instance-scoped
  container and network names (`hosty-<scope>-<app>-<service>`, `hosty-<scope>-<app>-net`, where
  `<scope>` is the id's first 12 chars);
- the default instance stamps no label and keeps today's unscoped names — existing hosts migrate
  with zero container churn, and containers that predate the label read back as the default
  instance's empty id.

Adoption, owned-container removal, the running-apps reconcile probe, and docker-stats attribution
all require the container's instance to match the running Core's (`docker ps` cannot filter on
"label absent", so the instance is a post-filter on the printed label value). Instances therefore
cannot adopt, remove, reconcile or double-report each other's containers — a dev Core pointed at a
second root can no longer touch the live host's apps.

## Settings over the Control Plane

`GET`/`PUT /control/v1/settings` serve the same rows and apply the same validation as the admin
`/api/core/settings` (the two surfaces share the build and apply code), gated by the loopback
control secret. `hosty core settings list|get|set|reset <KEY>` is the CLI over it — on a headless
host this is the only way to edit a Core setting, and the recovery path for a value that broke the
UI. A down instance fails with the ordinary "Core is not running" error.

## launch.env Migration

On first contact the CLI migrates a legacy `{root}/config/launch.env` read-and-delete: a
non-default `HOSTY_CORE_PORT` is folded into the target root's settings store (merging into an
existing `settings.json` without disturbing other groups), a non-default `HOSTY_DATA_ROOT` becomes
a notice pointing at `--data-root`/`HOSTY_DATA_ROOT` (the pointer cannot live inside the root it
points to), a set `HOSTY_CORE_PUBLIC_ORIGIN` is echoed as a notice pointing at
`hosty core settings set`, and the
file is deleted. If the fold itself fails, the file is left in place with instructions.

## Testing Expectations

- Root and port resolution order on both sides: CLI (flag → env → legacy env → default) and Core
  (flag → env → explicit URL → stored → default), including argv parsing of both option forms and
  invalid-port rejection.
- The per-root lock: acquire, refuse-on-any-port, the refusal naming a live instance from
  `control.json`, a dead recorded PID not presented as live, and reacquisition after release.
- Instance identity: default root's reserved empty id, first-start generation, stability across
  calls, and the stored id read back.
- Cross-instance isolation in the docker adapter: adoption and owned-removal refuse a container of
  another instance in both directions, the reconcile probe and stats owner map filter to the own
  instance, and the default instance's names/labels stay byte-for-byte legacy.
- The settings store: server-port round-trip and validation through `CoreSettingsService`, the
  lenient startup read, and a full HTTP round-trip over `/control/v1/settings` including the
  control-secret gate.
- CLI: the global `--data-root` extraction, the launch.env migration cases, the refused conflicting
  start, and `hosty core settings` get/set/reset against the control plane.

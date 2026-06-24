# Feature: External Host-Path Mounts

## Goal

Let a runtime app declare that it needs large, operator-owned host folders that live **outside** app data — for example media catalog roots — and let the operator bind concrete host paths into those folders after install. The binds must be injected into both the `docker` and `localCommand` runtimes under a stable contract, survive update / restart / runtime-switch / app removal, and never be backed up or deleted by Hosty. This unblocks the `docker` runtime profile for apps that previously only worked under `dev`/`localCommand` because they read operator host paths directly.

## Non-goals

- Named docker volumes or non-host-path storage kinds (`kind` is `host-path` only).
- Operator-overridable read/write mode — the manifest's `mode` is authoritative.
- Merging several host paths into one mount point. Each configured path is one bind / one filesystem.
- Remap of stored container paths when an app switches runtime (the app re-scans; see Edge Cases).
- Supporting a remote docker daemon whose filesystem differs from Core's host.

## Current Behavior

Before this feature Core mounted only the single primary app data directory (`data.enabled`), injected as `HOSTY_APP_DATA_DIR` and bind-mounted under docker. Apps that needed external operator folders had no contract, so they could only run under `localCommand`/`dev` by reading operator host paths out of band. The `docker` profile was deferred for those apps.

## Behavior

A manifest declares external-mount **slots**. The slot describes what the app can accept; the operator later binds concrete host paths to each slot.

```jsonc
"externalMounts": {
  "catalogRoots": {
    "kind": "host-path",   // only "host-path" is supported
    "multiple": true,       // allow more than one host path in the slot
    "mode": "rw",           // "rw" (default) or "ro"; authoritative
    "service": "api",       // optional: bind only into this service (omit = all services)
    "required": true         // optional: Core blocks start until configured
  }
}
```

The operator configures paths after install (`POST /api/apps/{appId}/mounts`, admin-only; `/control/v1/apps/{appId}/mounts` for the CLI). Each path is given a stable **label**; Core exposes it at the deterministic container path `/mnt/{key}/{label}` so a given path keeps the same container path even when sibling paths are added or removed.

For each slot that has configured paths, Core injects `HOSTY_MOUNT_{KEY}` (key uppercased, non-alphanumerics → `_`) with the active bindings comma-joined as `label=path` and sorted by label:

- Under `docker`: container paths, each path bind-mounted (`-v host:/mnt/{key}/{label}[:ro]`):
  `HOSTY_MOUNT_CATALOGROOTS=anime=/mnt/catalogRoots/anime,movies-4k=/mnt/catalogRoots/movies-4k`
- Under `localCommand`/`dev`: the operator host paths directly (no container):
  `HOSTY_MOUNT_CATALOGROOTS=anime=/srv/anime,movies-4k=/srv/movies-4k`

The app reads the variable, splits on `,`, and splits each entry on the **first** `=` into `label` and `path` — the contract is identical across runtimes. The label is each bind's stable key; a consumer that must address a specific mount across apps (e.g. pair a catalog root with a sibling app's downloads mount on the same host path) matches on the label. A host path may itself contain `=`, so always split on the first `=` only (labels match `^[a-z0-9][a-z0-9._-]{0,62}$` and never contain `=`).

## User/API Scenarios

- An operator installs a media app whose manifest declares a required `catalogRoots` slot. Start is blocked with `app_mount_required_unconfigured` until the operator configures at least one path.
- The operator binds `/srv/movies-4k` (label `movies-4k`) and `/srv/anime` (label `anime`). Under docker the app sees `anime=/mnt/catalogRoots/anime,movies-4k=/mnt/catalogRoots/movies-4k`; the binds are read-write so the app can hardlink within each root.
- The app is updated to a new version. The configured paths persist; no reconfiguration is needed.
- The operator removes the app. The external media folders are untouched.
- The operator tries to bind a path inside the Hosty data root or a system path (`/etc`, `/proc`, …). Core rejects it (`app_mount_path_in_data_root` / `app_mount_path_forbidden`).

## Technical Design

- **Manifest** (`RuntimeAppManifest.ExternalMounts`): validated in `AppManifestService.Select` — key matches `^[A-Za-z][A-Za-z0-9_-]{0,62}$` (camelCase allowed), `kind` is `host-path`, `mode` is `ro`/`rw`, `service` (if set) names a declared service.
- **App record**: slots are denormalized onto `AppRecord.MountSlots` on every (re)build, like `RuntimeProfiles`. Operator bindings (`AppRecord.Mounts`, `AppMountBinding(Key, Label, HostPath)`) are preserved from the previous record across update / runtime-switch, like settings; bindings whose slot the manifest no longer declares are pruned.
- **Resolution** (`RuntimeMountPlanner`, pure): slots × bindings → `RuntimeMount(Key, Label, HostPath, ContainerPath, ReadOnly, Service)` with container path `/mnt/{key}/{label}`, sorted by `(key, label)`. Computed in `CreateRuntimeContextAsync` and carried on `RuntimeLifecycleContext.Mounts`.
- **Injection**: the docker adapter appends `-v host:container[:ro]` and the `HOSTY_MOUNT_{KEY}` env per service (filtered by the slot's `service`); the localCommand adapter injects the same env with host paths. Read/write comes from the slot mode.
- **Start gate** (`EnsureMountsReadyForStart`): a required slot must have a binding; each configured host path is re-checked against the path policy and must exist as a directory — Core fails fast rather than letting docker bind a missing path (which would silently create an empty root-owned directory).
- **Config validation** (`ConfigureMountsAsync`): host path must be absolute and normalized, must not contain `:` on non-Windows (would break `-v`), must not be inside `paths.DataRoot` or a denied system root (`/etc`, `/proc`, `/sys`, `/dev`, `/boot`, `/run`, `/var/run`), checked on both the path and its symlink-resolved target. Labels match `^[a-z0-9][a-z0-9._-]{0,62}$`, are unique per slot, and a non-`multiple` slot accepts at most one path.

## Data Model / API Changes

- Manifest: new optional `externalMounts` object.
- `AppRecord`: new `MountSlots` (denormalized declarations) and `Mounts` (operator bindings).
- `AppSummary`: new `mounts` array (`key`, `mode`, `multiple`, `required`, `service`, `bindings[]` with `label`, `hostPath`, `containerPath`).
- Endpoints: `POST /api/apps/{appId}/mounts` (admin session + CSRF) and `POST /control/v1/apps/{appId}/mounts` (control secret), body `{ "mounts": [{ "key", "label", "hostPath" }] }` (replace-all semantics).
- Runtime environment: new `HOSTY_MOUNT_{KEY}` per configured slot (comma-joined `label=path` entries).

## Clients

- **Shell**: an "External storage" panel on the Installed Apps page (shown only when the app declares `externalMounts`) lets an admin add/edit/remove labelled host paths per slot and saves them via the configure endpoint.
- **CLI**: `hosty apps mounts <app-id>` lists slots and bindings; `hosty apps mounts set <app-id> --mount <key>=<label>=<host-path> [--mount ...]` replaces the bindings; `hosty apps mounts clear <app-id>` removes them. Both call the control endpoint.

## Edge Cases

- **Runtime switch** (`docker` ↔ `localCommand`): bindings persist, but the injected paths change (container vs host). An app that persisted absolute container paths must re-scan after a switch.
- **Manifest drops a slot**: orphaned operator bindings are pruned on the next record rebuild and are ignored during resolution before then.
- **Missing host path at config time**: allowed (network/removable drives) — existence is enforced at start, not at save.
- **Symlinked host path**: both the operator path and its resolved target are checked against the path policy. Full TOCTOU defense is out of scope.
- **Remote docker daemon**: bind sources resolve on the daemon host. Core assumes a local daemon (it shells the local `docker` CLI and binds ports to `127.0.0.1`).

## Security

Binding an arbitrary host path read-write into a container is an operator-trust action, gated to admin sessions. Core enforces that paths are not inside the Hosty data root (so an app cannot mount `core/`, `backups/`, or another app's data) and not inside a small denylist of system roots, and re-validates at start. The Shell surfaces an external-storage section with a trust note. Beyond these guards, external storage is the operator's responsibility by design.

## Testing

- Manifest validation: accepts a valid slot (kind/mode defaults), rejects bad mode, unsupported kind, unknown service, invalid key.
- `RuntimeMountPlanner`: resolution and label-stable container paths, docker vs local env, read-only `-v` suffix, service filtering, required-slot gating.
- Lifecycle: slots denormalized on install and surfaced in the summary; bindings persisted with container paths; rejection of a path inside the data root, unknown slot, invalid label, and a second path on a non-`multiple` slot; bindings survive update; start throws on required-unconfigured and on a missing source directory; configured mounts resolve into the runtime context.

## Decision

Operator bindings are stored on the app record (preserved like settings), separate from the Core-managed `data` storage mapping, because their lifecycle differs — external mounts are never created, backed up, or deleted by Hosty. Container paths are derived from operator labels rather than indexes or hashes so they stay stable and human-readable across reconfiguration.

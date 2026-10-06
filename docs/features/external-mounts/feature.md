---
created: 2026-06-16
updated: 2026-10-05
summary: Apps declare external mount slots and operators bind host folders to them, injected as HOSTY_MOUNT_{KEY} and never backed up or deleted.
components: [apps/core, apps/cli, apps/shell]
---

# External Host-Path Mounts

A runtime app can declare that it needs large, operator-owned host folders that live **outside** its
data, such as media catalog roots. The operator binds concrete host paths to those declarations after
install. Core injects the bindings into both the `docker` and `localCommand` runtimes under one
contract, keeps them across update, restart, runtime switch and removal, and never backs them up or
deletes them. [Global mounts](../global-mounts/feature.md) extend this with a host-level library of
named folders that bindings can reference.

## Behavior

A manifest declares external-mount **slots**: what the app can accept.

```jsonc
"externalMounts": {
  "catalogRoots": {
    "kind": "host-path",   // the only supported kind
    "multiple": true,       // more than one host path in the slot
    "mode": "rw",           // "rw" (default) or "ro"; authoritative
    "service": "api",       // optional: bind only into this service
    "required": true         // optional: start is blocked until configured
  }
}
```

The operator binds paths after install through the app's Mounts tab in Shell, the CLI or the API.
Each binding has a stable **label**, and Core exposes it at the container path `/mnt/{key}/{label}`,
so a path keeps its container path when sibling paths are added or removed. A binding can also
reference a global mount by name instead of naming a host path.

For each slot with bindings, Core injects `HOSTY_MOUNT_{KEY}` (key uppercased, other characters
replaced by `_`) with the bindings as comma-joined `label=path` entries sorted by label:

- under `docker`, container paths, each bind-mounted with `-v host:/mnt/{key}/{label}[:ro]`:
  `HOSTY_MOUNT_CATALOGROOTS=anime=/mnt/catalogRoots/anime,movies-4k=/mnt/catalogRoots/movies-4k`;
- under `localCommand`, the host paths directly:
  `HOSTY_MOUNT_CATALOGROOTS=anime=/srv/anime,movies-4k=/srv/movies-4k`.

The app splits the variable on `,` and each entry on the **first** `=` into label and path. Labels
match `^[a-z0-9][a-z0-9._-]{0,62}$` and never contain `=`; a consumer that must address a specific
binding across apps matches on the label.

Only host paths are supported: no named Docker volumes, no operator override of `mode`, one bind
per configured path, and no remapping of stored container paths when the app switches runtime.

## API And Clients

- `POST /api/apps/{appId}/mounts` (administrator session and CSRF) and
  `POST /control/v1/apps/{appId}/mounts` (control channel) replace all bindings with
  `{ "mounts": [{ "key", "label", "hostPath" }] }`. `PUT /api/apps/{appId}/mounts/shared/{name}`
  manages bindings to a global mount.
- When an app, rather than the administrator directly, requests a binding to an arbitrary host path,
  Core refuses with `app_mount_confirmation_required`: the path must be confirmed in Core first.
  Binding an already approved global mount keeps the simple flow.
- `AppSummary.mounts` lists each slot (`key`, `mode`, `multiple`, `required`, `service`) with its
  bindings (`label`, `hostPath`, `containerPath`).
- CLI: `hosty apps mounts <app-id>` lists slots and bindings;
  `hosty apps mounts set <app-id> --mount <key>=<label>=<host-path> [--ref <key>=<global-mount-name>]`
  replaces them; `hosty apps mounts clear <app-id>` removes them.

## Implementation

- **Manifest** (`RuntimeAppManifest.ExternalMounts`), validated in `AppManifestService.Select`: the
  key matches `^[A-Za-z][A-Za-z0-9_-]{0,62}$`, `kind` is `host-path`, `mode` is `ro` or `rw`, and
  `service`, when set, names a declared service.
- **App record**: slots are denormalized onto `AppRecord.MountSlots` on every rebuild; operator
  bindings (`AppRecord.Mounts`) carry over across update and runtime switch, and bindings whose slot
  the manifest no longer declares are ignored and pruned. Hosty never deletes an operator mount.
- **Resolution** (`RuntimeMountPlanner`): slots and bindings become `RuntimeMount` entries with
  container path `/mnt/{key}/{label}`, sorted by key and label, filtered per service. The docker
  adapter adds the `-v` arguments and the environment; the `localCommand` adapter adds the
  environment with host paths.
- **Path policy** (`MountPathPolicy`, shared with global mounts): a host path is absolute, contains
  no `:` or `,`, is not the filesystem root, is neither inside nor a parent of the Hosty data root,
  and on non-Windows hosts is outside `/etc`, `/proc`, `/sys`, `/dev`, `/boot`, `/run` and
  `/var/run`. Both the path and its symlink-resolved target are checked. `HostPathAuthority`
  additionally refuses a mount that exposes any app's source directory (`app_mount_path_is_source`).
  Labels are unique per slot, and a slot without `multiple` accepts one path.
- **Start gate** (`EnsureMountsReadyForStart`): a required slot must have a binding
  (`app_mount_required_unconfigured`), and every bound path is re-checked against the policy and
  must exist as a directory (`app_mount_source_missing`). Core fails fast rather than letting
  Docker create an empty root-owned directory for a missing path.

## Edge Cases

- A runtime switch keeps the bindings but changes the injected paths between container and host; an
  app that stored absolute container paths must re-scan.
- A path that does not exist yet can be saved, for example a removable drive; existence is enforced
  at start.
- Bind sources resolve on the Docker daemon's host; Core assumes a local daemon.

## Security

Binding a host path read-write into an app is an operator-trust action. Direct configuration
requires an administrator session, and an app-requested arbitrary path requires Core confirmation.
The path policy keeps Hosty's own data, system roots and application source directories out of
reach, and is re-validated at every start. Beyond these guards, external storage is the operator's
responsibility.

## Testing Expectations

- Manifest validation accepts a valid slot with default kind and mode, and rejects a bad mode, an
  unsupported kind, an unknown service and an invalid key.
- `RuntimeMountPlanner`: label-stable container paths, docker versus local environment, the
  read-only `-v` suffix, service filtering and required-slot gating.
- Lifecycle: slots surface in the summary; bindings persist with container paths and survive
  update; a path inside or above the data root, a system root, an app source directory, an unknown
  slot, an invalid label and a second path in a single-path slot are rejected; start fails for a
  required unconfigured slot and for a missing directory; an app-requested arbitrary path requires
  confirmation.

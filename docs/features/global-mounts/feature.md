# Global (Shared) Host-Path Mounts

Created: 2026-06-30
Updated: 2026-08-04

## Goal

Let an operator register large, operator-owned host folders **once** at the host level (a
"shared mounts" library) and attach them to any runtime app by reference, instead of re-typing
the same host path into every app. Editing a library entry's path updates every app that
references it on the next start. This builds directly on per-app [external mounts](../external-mounts.md)
— the manifest slot stays the opt-in point and the source of all binding authority; only the
**source of the host path** changes from inline text to a reference into the shared library.

## Non-goals

- Auto-mounting a shared folder into apps that did not declare a matching `externalMounts` slot.
  Global mounts never bypass the manifest — an app still only receives a mount it opted into.
- Operator-overridable read/write mode. The manifest slot's `mode` stays authoritative; a library
  entry may carry an additional cap but can never widen what the slot allows.
- Replacing inline host-path bindings. Inline ("local") bindings keep working unchanged; the
  library is the default, inline is the escape hatch. No migration of existing bindings.
- Named docker volumes / non-host-path kinds (unchanged from external mounts).

## Behavior

A host-level **shared mounts library** holds named host folders:

```jsonc
// core/global-mounts.json
{
  "schemaVersion": 1,
  "mounts": [
    { "name": "media",       "hostPath": "/srv/media",        "maxMode": "rw", "description": "Media catalog root" },
    { "name": "anime",       "hostPath": "/srv/anime",        "maxMode": "ro" },
    { "name": "backups-ext", "hostPath": "/mnt/ext/backups",  "maxMode": "rw" }
  ]
}
```

`name` matches `^[a-z0-9][a-z0-9._-]{0,62}$` — the **same pattern as a mount label**, so the name
doubles as the container-path label and is filesystem-safe. Names are unique.

A per-app binding can now reference a library entry instead of carrying an inline path. For each
slot the operator picks, per row, a **source**:

- **Global** — references a library entry by `name`. The binding's label is forced to the entry's
  `name` (not editable), and the host path is resolved live from the library. Container path is
  the deterministic `/mnt/{key}/{name}`, so a given shared folder lands at the same container path
  across every app that references it — apps can coordinate on the shared host path by matching the
  name.
- **Local** — an inline absolute host path with an operator-chosen label, exactly as today.

The injected contract is unchanged: `HOSTY_MOUNT_{KEY}` (`label=path` comma-joined) plus the docker
`-v host:/mnt/{key}/{label}[:ro]` bind. For a global binding the host path is whatever the library
entry currently resolves to at start time.

## User/API Scenarios

- An operator opens **Settings → Shared mounts** and registers `/srv/media` as `media` (rw)
  through the **Add mount** dialog. Core validates the path against the mount path policy and
  stores it.
- In an app's **Settings → Mounts** tab the operator adds a binding to the `catalogRoots` slot,
  picks source **Global** and entry `media`; the path field shows `/srv/media` read-only. A second
  app references the same `media` entry — both see `/mnt/catalogRoots/media`.
- The operator moves the library and edits `media` to `/srv/media2`. Both apps pick up the new path
  on their next start; no per-app reconfiguration.
- The operator tries to delete `media` while two apps reference it. Core rejects with
  `global_mount_in_use` (count surfaced) until the apps are detached (or `force` is passed, which
  leaves the now-orphaned bindings inert).
- The operator edits `media` to a path inside the Hosty data root. Core rejects it at registration
  with the same policy errors as inline paths. If a previously-valid library path later becomes
  missing, the referencing app fails fast at start (`app_mount_*`), not silently.

## Technical Design

### Store and model

- **`GlobalMountStore(CoreDataPaths paths)`** — host-level JSON store modelled on
  `UserDirectoryStore` (`JsonStorage.ReadAsync`/`WriteAsync` to `core/global-mounts.json`,
  `restrictToOwner: true`), registered singleton in `HostyCoreApplication`. Mutations serialize
  through the memoize + temp-rename idiom used by the other stores.
- **`GlobalMount(string Name, string HostPath, string? Description, string? MaxMode)`** wrapped in
  `GlobalMountState(int SchemaVersion, IReadOnlyList<GlobalMount> Mounts)`.
- **`AppMountBinding`** gains an optional reference field:
  `AppMountBinding(string Key, string Label, string HostPath, string? GlobalMountName = null)`.
  - `GlobalMountName == null` → inline binding (today's behaviour, untouched).
  - `GlobalMountName != null` → reference. `Label` is forced equal to `GlobalMountName`; `HostPath`
    holds the last-resolved path as a display cache, but the library is the source of truth and the
    path is re-resolved at start.
  - Additive and nullable, like `AppRecord.ArtifactLocks` — **no `AppStateDocument.SchemaVersion`
    bump**. `RetainedAppConfig.Mounts` carries the new field for free.

### Validation (split by lifecycle)

- **Extract `MountPathPolicy`** out of `CoreLifecycleService` (`NormalizeAndValidateMountHostPath`
  + `EnsureMountPathAllowed`: absolute, normalized, no `:`/`,`, not inside `paths.DataRoot`, not in
  the system denylist, checked on the path and its symlink-resolved target). Both the registry and
  inline config call it — one policy, two callers.
- **Registration** (`GlobalMountService.UpsertAsync`): run `MountPathPolicy` on the host path;
  validate `name` shape + uniqueness; `maxMode` is `ro`/`rw` (default `rw`). Existence is **not**
  required at registration (network/removable drives), matching inline paths — but it *is* reported:
  every response carries `hostPathExists` (`MountPathPolicy.HostPathExists`, resolved per read, never
  cached), so the CLI and Shell flag a path that will fail the start gate. Advisory only; the write
  always succeeds. This is what turns a typo'd path from a start-time failure into a visible one.
- **Per-app config** (`ValidateMountBindings`): for a ref input, the named entry must exist in the
  library and the slot must be declared; `Label` is set to the name (operator cannot override);
  `multiple`/label-uniqueness still apply, so the same global entry can be attached at most once per
  slot and a non-`multiple` slot still accepts one binding. For inline input, the existing path
  policy runs as today.
- **Start gate** (`EnsureMountsReadyForStart`): dereference refs first, then re-run `MountPathPolicy`
  and the existing must-exist-as-directory check on the resolved path. Required-slot gating is
  unchanged. A ref to a deleted entry is inert (skipped in resolution); if that leaves a required
  slot unconfigured, start fails with a clear code (`app_mount_global_missing`).

### Resolution

`CreateRuntimeContextAsync` materializes ref bindings before calling the **pure**
`RuntimeMountPlanner.Resolve(slots, bindings)`: a thin Core step swaps each ref binding's `HostPath`
for the current library value (skipping refs whose entry no longer exists). The planner and its
tests stay untouched.

### Mode precedence

`slot.Mode` remains the authoritative cap and still drives `RuntimeMount.ReadOnly`. The library
entry's `MaxMode` is an optional additional cap: effective read-only =
`slot.Mode == "ro" || entry.MaxMode == "ro"`. Default `MaxMode = "rw"`, so the slot wins and nothing
changes unless an operator deliberately restricts a shared folder to read-only library-wide.

## Data Model / API Changes

- New `core/global-mounts.json` (`GlobalMountState`, `GlobalMount`).
- `AppMountBinding`: new optional `GlobalMountName`.
- `AppMountBindingInput`: new optional `globalMountName` (global rows send `key` + `globalMountName`;
  local rows send `key` + `label` + `hostPath`).
- `AppMountBindingSummary`: new `source` (`"global"`/`"local"`) and `globalMountName` so clients can
  render the source and badge.
- Endpoints (admin session + CSRF, with `/control/v1` mirrors on the control secret for CLI):
  - `GET /api/global-mounts` → entries with a computed `usedBy` count (scan of all apps' `Mounts`) and
    `hostPathExists` (advisory presence of the host path; see Validation).
  - `POST /api/global-mounts` → upsert by `name` (`{ name, hostPath, mode?, description? }`).
  - `DELETE /api/global-mounts/{name}` → delete; `409 global_mount_in_use` when `usedBy > 0` unless
    `?force=true`.
- All new DTOs registered in `CoreJsonSerializerContext` (Native AOT).

## Clients

### Shell

- **Shared mounts section** on the host **Settings** page (`/settings?tab=mounts`, admin-only): a
  table of `Name · Host path · Mode · Used by · actions` with an **Add mount** button in the
  section header. Add and edit each open a modal dialog (`name`, `mode ro/rw`, `host path`,
  optional `description`); the name identifies the entry in Core, so the edit dialog shows it
  read-only. A save rejected by Core surfaces inline in the dialog; deleting an in-use entry
  surfaces Core's rejection above the table and arms the same trash button for a force delete.
  The table flags a `ro` entry with a lock icon and a registered path that does not currently
  exist with an advisory warning icon. The library list is loaded into shell state so the per-app
  picker can reuse it.
- **Consolidated per-app Settings dialog.** Per-app configuration lives in one tabbed dialog:
  **App settings** (non-public-origin settings), **Public origins** (when the app has
  public-origin-capable endpoints), **Mounts** (when the app declares `externalMounts`). Each tab
  is hidden when its data is absent; if exactly one tab qualifies it renders without tab chrome;
  if none qualify the menu item is not shown. Deep-links open a named tab via
  `OpenPanelOptions.settingsTab` (`"app" | "publicOrigins" | "mounts"`). The actions menu has a
  single `Settings` item; `Backups`, `Logs`, `Observability`, `Update`, `Remove` stay separate
  (lifecycle, not configuration).
- **Per-binding source toggle** in the Mounts tab: a `Source` select (`Global`/`Local`). Global →
  the `Label` field becomes a two-line picker over the library (name above, path below) and the
  `Path` field is read-only; already-attached entries are hidden/disabled in the picker for a
  `multiple` slot. Local → two editable inputs (label + path).

### CLI

- `hosty storage list` — list library entries with `usedBy`; a host path that is not present is marked
  `(missing)`.
- `hosty storage add <name> <host-path> [--mode ro|rw] [--description <text>]` — upsert. Still exits 0
  when the path is absent, printing a warning (the drive may not be attached yet).
- `hosty storage rm <name> [--force]` — delete (refuses when in use without `--force`).
- `hosty apps mounts set <app-id> --ref <key>=<name> [--mount <key>=<label>=<host-path>] …` — the
  existing `--mount` (inline) gains a sibling `--ref` (global) form; replace-all semantics
  unchanged.

## Edge Cases

- **Delete an in-use entry** → blocked by default (`usedBy > 0`); `force` leaves orphaned ref
  bindings, which are inert (pruned in resolution like a dropped slot).
- **Library path edited to forbidden/missing** → caught at the next start via deref + path policy +
  existence check; the app fails fast, bindings persist.
- **Ref to a deleted entry** → inert; a required slot with only that binding fails start with
  `app_mount_global_missing`.
- **Runtime switch** (`docker` ↔ `localCommand`) → as with inline mounts the injected path differs
  (container vs host); for a global binding the host path comes from the library at resolve time.
- **`multiple` slot** → the same global entry may be attached at most once per slot; the picker
  hides already-chosen entries.
- **Remote docker daemon** → unchanged non-goal; bind sources resolve on the daemon host.

## Security

Registering a shared host path is an operator-trust action gated to admin sessions, validated by
the same `MountPathPolicy` as inline mounts (no data-root, no system denylist, symlink target
checked) and re-validated at start. The library lives at host level under `core/` and is never
backed up or deleted by app lifecycle. Because global mounts still require a manifest-declared slot,
the least-privilege invariant — an app only sees what it declared — is preserved; the library only
changes how the operator supplies the path, not what the app is allowed to receive.

## Decision

- **Reference by name, resolved live.** The whole value of the feature is a single source of truth —
  edit once, all referencing apps follow — so a binding stores the entry name and Core resolves the
  path at start; the stored `HostPath` is only a display cache.
- **Manifest slot stays the authority.** Global mounts supply the path but never bypass the slot, so
  `mode`/`service`/`required`/container-path-key and the "only what it declared" isolation invariant
  all carry over untouched. (The alternative — operator attaches any host path to any app regardless
  of manifest — was rejected for dismantling those guarantees.)
- **Name is the canonical label.** A global binding's label is fixed to the entry name (not
  editable) so the container path `/mnt/{key}/{name}` is stable and identical across apps, enabling
  cross-app coordination on the same host path, and so the operator can't create confusing per-app
  aliases for the same shared folder.
- **Inline kept as an escape hatch.** Local bindings remain valid, so the change is additive with no
  migration; the library is the default path source, inline is for one-offs.

## Testing Expectations

- `GlobalMountStore`/service: upsert + path policy at registration, name validation/uniqueness,
  `maxMode` default, `usedBy` count, delete blocked while in use and allowed with force.
- Binding: ref persists across update / runtime-switch (like inline); ref `Label` forced to name;
  same global entry rejected twice on one slot; non-`multiple` slot still one binding.
- Resolution/start: ref dereferences into the runtime context; start fails on a deleted/missing
  global for a required slot; mode precedence (a `ro` library entry forces read-only even when the
  slot is `rw`).
- Shell: Settings tab visibility by manifest data, source toggle global/local, Shared mounts CRUD
  through the add/edit dialogs, in-use delete rejection + force delete.
- CLI: `storage` commands and `apps mounts set --ref`.

# Manual Port Assignment

Status: Implemented 2026-07-18 (unit-tested; not yet exercised against a live Core)
Created: 2026-07-18

Extends [automatic-runtime-app-ports.md](../features/automatic-runtime-app-ports.md). Folds into that
document once shipped.

## Motivation

The Reassign dialog promises "Pick a new local host port for this endpoint" and then gives no choice:
Core binds port 0, takes whatever ephemeral port the OS hands back, and reports it afterwards. An
operator who needs a *specific* port — a firewall rule, a router port-forward, an external reverse
proxy, a bookmark, parity with a docker-compose setup they are migrating from — has no supported path
from the UI.

## Current behavior (verified against the code)

**Reassignment is automatic-only.** `POST /api/apps/{id}/ports/reassign` takes
`ReassignPortRequest(Service, PortKey, Digest)` — no port field — and calls
`RuntimePortHelper.AllocateLoopbackPort(reserved)`, which binds port 0 and accepts the OS's pick
(`RuntimePortAllocator.cs:99`). The exclusion set spans other installed apps' loopback ports, the
Core/Shell ports, this app's other assignments, and the old port.

**Only automatic ports may be reassigned.** `RequireRemappableAssignment` throws
`reassign_not_remappable` unless the assignment is `Source == Automatic && Remappable`
(`CoreLifecycleService.cs:934`).

**A manual pin already exists — as a setting.** `TryResolvePinnedHostPort` checks an operator override
*before* the manifest's explicit port and before the install-time reservation
(`RuntimePortHelper.cs:43`). The key is `HOSTY_PORT_{KEY}`, in a service-scoped form
(`HOSTY_PORT_{SERVICE}_{KEY}`) and an app-scoped form (`RuntimePortHelper.cs:96,180`).

**That override already carries the right semantics.** `ClassifySource` maps "has host-port override" to
`(Operator, Remappable: false)` (`RuntimePortAllocator.cs:201`), so a pinned port is automatically
excluded from auto-reassignment. The model already understands "the operator chose this one."

**The override is writable today, unvalidated.** `MergeSettings` accepts arbitrary keys, minting an
`AppSettingValue` for unknown ones (`CoreLifecycleService.cs:4490`), so `POST /api/apps/{id}/configure`
can already write `HOSTY_PORT_HTTP`. Nothing validates it — contrast `ValidatePublicOriginSettings`,
which does guard its own keys. A typo, an out-of-range number, or a port another app already holds is
accepted and stored.

### The gap

The reservation pass that reclassifies assignments and reprojects endpoint URLs,
`RuntimePortAllocator.AssignAndPersistAsync`, is called from exactly one place: **install**
(`CoreLifecycleService.cs:274`, "Reserve host ports now — after settings … are final").
`ConfigureAsync` merges settings and returns; it never re-allocates (`CoreLifecycleService.cs:324`).

So setting `HOSTY_PORT_HTTP` today updates `Settings` while `PortAssignments` and the endpoint URL stay
stale. The UI keeps showing the old port, and the reservation excluded from other apps' allocation is
still the old one. The capability exists but the record disagrees with it.

## Decisions

### 1. A manual port is an operator override, not a field on the automatic assignment

Write the existing `HOSTY_PORT_*` setting rather than adding `DesiredPort` to an assignment that stays
`Source = Automatic`.

Rationale: the override path already exists, is already honoured first at resolution, and already
classifies the assignment as `Operator`/non-remappable. An explicitly chosen port that remained
`Automatic` would stay eligible for a later reallocation — Core could silently move it, which defeats
the point of choosing it.

### 2. One entry point, not two

The Reassign dialog becomes the single place a local port is decided, with two modes:

- **Automatic** — Core picks (today's behavior). Clears any override.
- **Manual** — the operator types a port. Writes the override.

Leaving the manual port only in the app-settings form would give two divergent ways to set one value —
the same two-sources-of-truth problem the Cloudflare/public-origin surfaces already have. The settings
key stays the storage; the dialog becomes its UI.

### 3. Configure must re-reserve, not only install

Whichever path writes the override must also refresh the assignment (source, host port, endpoint URL)
in the same operation. Otherwise the UI lies about the current port until the next install.

## Technical design

### Core

1. **Extend the reassign contract** rather than adding a parallel endpoint, so the digest staleness
   guard and the restart-impact reporting stay in one place:

   ```
   ReassignPortRequest(string Service, string PortKey, string Digest,
                       string Mode /* "automatic" | "manual" */, int? Port)
   ```

   `Mode = "automatic"` with no port reproduces today's behavior **and clears the override**.
   `Mode = "manual"` validates `Port`, writes the service-scoped override, and pins the assignment.

2. **Relax the remappable guard for the manual path.** `RequireRemappableAssignment` must keep
   rejecting *automatic* reassignment of a pinned port, but an already-pinned port has to remain
   editable — otherwise a manual port becomes a one-way door. Manifest-declared and host-network ports
   stay rejected in both modes.

3. **Validate the port** (new; `ValidatePublicOriginSettings` is the precedent):
   - `1..65535`, integer → `port_out_of_range`
   - `< 1024` → `port_privileged` (Core does not run as root; binding would fail at start)
   - already in the reserved set → `port_reserved` naming the holder (other app, Core, Shell, or this
     app's own other endpoint)
   - not bindable right now → `port_in_use`, via `RuntimePortHelper.IsLoopbackTcpPortAvailable`

4. **Persist as one unit**, under the allocator gate like `ReassignAsync` does: settings (override
   set/cleared), the assignment (`HostPort`, `Source`, `Remappable`, `AssignedAt`), and the reprojected
   endpoint URL.

5. **Restart impact is unchanged.** Reassignment never restarts anything as a side effect; the result
   keeps reporting the owning app (if running) plus running dependents.

6. **Always write the service-scoped key** (`HOSTY_PORT_{SERVICE}_{KEY}`). The app-scoped form cannot
   express a port key like `http` shared by two services, and stays supported only for reading.

### Shell

1. Dialog gains an Automatic/Manual toggle and a number input prefilled with the current port.
2. Structured Core errors render inline against the input (`port_in_use` etc.), so a conflict is
   explained rather than dumped as a generic failure.
3. Fix the description — it currently claims a choice the dialog does not offer.
4. Surface pinned-ness on the endpoint row, so an operator can tell a chosen port from an assigned one
   and understand why auto-reassign no longer applies.

## Scenarios

- Operator pins `8080` for a router port-forward → override written, assignment becomes
  `Operator`/non-remappable, endpoint URL updates, restart reported if running.
- Operator pins a port another app reserved → rejected as `port_reserved` naming that app; nothing is
  written.
- Operator pins a port some unrelated process holds → rejected as `port_in_use`.
- Operator switches a pinned endpoint back to Automatic → override cleared, fresh automatic port
  allocated, assignment returns to `Automatic`/remappable.
- A manifest-declared or host-network port → both modes rejected, as today.

## Testing

- Unit: validation matrix (range, privileged, reserved-by-other-app, in-use, happy path).
- Unit: manual write reclassifies to `Operator`/non-remappable and reprojects the endpoint URL.
- Unit: automatic mode clears the override and returns the assignment to `Automatic`/remappable.
- Unit: an already-pinned port can be re-pinned but not auto-reassigned.
- Regression: install-time reservation and existing reassign behavior unchanged when `Mode` is absent
  (older Shell against newer Core).

## Resolved (agreed 2026-07-18)

1. **Privileged ports** — reject outright. Core does not run as root, so a `< 1024` pin would only fail
   later at start; failing it at the point of choice is the honest answer.
2. **Wire compatibility** — an absent `Mode` means `"automatic"`, preserving today's payload so an older
   Shell keeps working against a newer Core.
3. **Naming** — no preference expressed; the dialog talks about a "Local port" with Automatic/Manual
   modes and does not surface the raw `HOSTY_PORT_*` key, which stays an implementation detail of
   storage.

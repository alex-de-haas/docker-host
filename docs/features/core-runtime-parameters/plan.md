# Core Runtime Parameters — Two Launch Flags, Everything Else Lives Inside

Status: Draft
Created: 2026-09-01
Updated: 2026-09-01

## Goal

Reduce Core's launch surface to two process parameters — the data root and the port — with
hardcoded defaults, move every other operator-tunable value into Core's own settings store, and
retire `launch.env`. The CLI keeps launching and updating Core, but stops being a configuration
store: a client addresses an instance by its data root alone and discovers everything else from the
instance itself.

## The Model

- **Core is the application; a data root is an environment.** One machine may carry several roots:
  the installed host, an agent-built test environment (scaffolded users, apps and data for one
  verification), the planned dev mode running Core from source. Launch parameters exist only to
  point a process at a non-default environment.
- **The data root cannot be a setting**, because it says where settings live — it is the instance's
  identity. Hardcoded default (`$HOME/.hosty`, per-platform equivalents), overridable per start.
- **The port is a per-environment value**: default 7070 at first start, persisted in the
  environment's own store, overridable for a single run with a start flag. Persisting a change goes
  through settings, not through the flag.
- **The public origin is not a launch parameter.** Its move into the settings store is
  [core-public-origin](../core-public-origin/plan.md); this plan supplies the CLI path that makes
  that move recoverable on a headless host.

## Decisions (owner, 2026-09-01)

1. **Multiple instances stay supported.** No machine-wide lock, no single-instance rule. Agent test
   environments and the dev mode are wanted workflows. What must hold instead: **instances cannot
   touch each other's containers** — the failure this project already paid for once (a dev Core
   adopting and destroying the live host's containers) becomes impossible, not forbidden.
2. **`launch.env` is removed.** Discovery stays per-root: `{root}/core/run/control.json` already
   carries endpoint, PID and ownership nonce; a client needs only the root, and the default root is
   hardcoded. Whoever creates a secondary environment knows its path and addresses it explicitly.
3. **Core behavior settings become reachable from the CLI** over the loopback control plane. Today
   `/api/core/settings` requires an admin browser session and Shell is optional — on a headless
   host no Core setting is editable at all.
4. **Merging CLI and Core into one binary is deferred** — parked in
   [core-single-binary](../core-single-binary/plan.md) until the trade-offs are worked through.
   Nothing here depends on that decision.
5. **Boot-time startup via an OS service unit is deferred** — parked in
   [core-service-unit](../core-service-unit/plan.md).

## Target Behavior

A diff against [cli-bootstrap.md](../cli-bootstrap.md).

- `hosty core start [--data-root PATH] [--port N]`. Root resolution: flag → `HOSTY_DATA_ROOT` →
  hardcoded default. Port resolution: flag → the root's stored value → 7070. A flag affects that
  run only.
- No `launch.env`, and no `hosty config` over it. The CLI's client commands accept the same
  `--data-root` (and env var) to select an environment, then read its `control.json` for the
  endpoint.
- **One process per root, enforced.** Ports do not guard this: a second start against a live root
  with a different `--port` would bind happily and then share the root's databases, settings and
  instance identity — container labels isolate roots from each other, not a root from itself. A
  start therefore takes a per-root exclusive lock (an OS file lock held for the process lifetime;
  the discovery file's PID answers for a stale lock after a hard kill), and a refused start —
  whether it lost the lock or the port — fails by **naming the live instance**: root, PID and
  endpoint from its discovery file, not a bare bind error.
- Docker resources carry the instance: an instance id stored in the root at first start, a
  `hosty.instance` label on containers, instance-scoped container names, and every `docker ps`
  filter scoped to the instance. The default root keeps today's unscoped names, so existing hosts
  migrate with zero container churn.
- `hosty core settings list|get|set|reset <KEY>` over a new `/control/v1/settings` surface,
  mirroring the groups `/api/core/settings` serves (auth lifetimes, ingress, updates, users,
  OAuth — and the public origin once core-public-origin lands). This is also the recovery path
  core-public-origin needs: `hosty core settings reset HOSTY_CORE_PUBLIC_ORIGIN` on a host whose
  UI a wrong origin broke.

## Open Questions

1. **Migration for hosts carrying `launch.env`.** Honor the legacy file as a read-only fallback for
   a release or two, or fold its values into the per-root store on first contact and delete it? A
   non-default root recorded there is the case that matters — the file is the only thing that
   remembers it.
2. **Instance id derivation.** A GUID written into the root at first start (stable if the folder
   moves) versus a path hash (no state, but a moved root becomes a different instance). And how the
   default root's legacy unscoped naming is expressed — an empty id, or a reserved one.
3. **Does a best-effort instance registry ship here?** Each start could record its root under the
   default root, giving `hosty core instances` an answer to "what runs on this machine"; liveness
   comes from each root's own `control.json` PID. Convenience, not a requirement — v1 or later?

## Deliverables

- [ ] Answer open questions 1–3.
- [ ] Hardcoded default data root; `--data-root`/`--port` start flags; port persisted in the
      per-root settings store with flag-wins-for-the-run semantics.
- [ ] `launch.env` retired: the CLI stops reading and writing it; `hosty config` removed or reduced
      accordingly; migration per question 1.
- [ ] Per-root exclusivity: an exclusive lock held for the process lifetime, stale-lock recovery via
      the discovery file's PID, and a refused second start — same root on **any** port — that names
      the live instance (root, PID) instead of binding or failing with a bare bind error.
- [ ] Instance identity on docker resources: id in the root, `hosty.instance` label, instance-scoped
      names and `ps` filters; the default root keeps unscoped names (zero-churn migration).
- [ ] `hosty core settings list|get|set|reset` over `/control/v1/settings`, with the same validation
      the admin endpoint applies.
- [ ] Tests: root/port resolution order; the collision message; a second start on a live root with
      a **different** free port is refused; adoption/recreate never crosses
      instances (a second-root Core must not match a default-root container); a settings round-trip
      over the control plane.
- [ ] Platform minor bump.
- [ ] Docs: `feature.md` for this folder; [cli-bootstrap.md](../cli-bootstrap.md) updated (and
      migrated into a feature folder per the lazy-migration rule); index regenerated.

## Deliberately Not Doing

- **A machine-wide instance lock.** Considered and rejected 2026-09-01: it would kill the agent-test
  and dev-mode workflows for a rule no current scenario needs. Container-level isolation replaces
  it.
- **Deciding the single-binary question here.** See
  [core-single-binary](../core-single-binary/plan.md).
- **Boot-time supervision.** See [core-service-unit](../core-service-unit/plan.md).

## Links

- [core-public-origin](../core-public-origin/plan.md) — the third launch setting's move into the
  store; its recovery path is this plan's settings CLI.
- [cli-bootstrap.md](../cli-bootstrap.md) — the `launch.env` world this plan retires.
- [core-single-binary](../core-single-binary/plan.md),
  [core-service-unit](../core-service-unit/plan.md) — the two deferred decisions split out of this
  one.

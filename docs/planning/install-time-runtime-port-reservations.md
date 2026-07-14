# Install-Time Runtime Port Reservations

Status: Ready
Created: 2026-07-14
Updated: 2026-07-14

Approved for implementation on 2026-07-14; Phase 1 (persistent model + migration) in progress.

## Goal

Assign and persist every runtime app host port during installation so a stopped, never-started app already
has stable local endpoint URLs. Prevent collisions with running or stopped installed apps, system/launch
ports, and current OS listeners while preserving the existing runtime environment contract.

## Scope

- Add a Core-owned, service-scoped persistent port-assignment model to installed app records.
- Allocate ports during install apply even when autostart and start-on-install are disabled.
- Include normal loopback HTTP ports, Docker port publishing, local-command ports, raw L4 exposure, and
  fixed host-network ports in one collision view.
- Preserve assignments across start, stop, restart, Core restart, update, runtime switch, and compatible
  live-source manifest changes.
- Project endpoint URLs immediately and expose whether an endpoint is assigned, running, or unavailable.
- Add an explicit impact-aware port-reassignment workflow for automatic remappable assignments.
- Migrate existing installed apps without changing usable stored ports.
- Update Shell, tests, and current feature documentation.

## Out of Scope

- Changing the `app.0.1` manifest schema.
- Reserving ports by holding sockets while apps are stopped.
- Guaranteeing that an unrelated OS process cannot take a logically reserved port after installation.
- Automatically changing an assigned port without administrator confirmation.
- Automatically restarting dependent applications after reassignment.
- A user-configurable automatic port range in the first version.
- Remapping fixed host-network service ports.

## Current Behavior

- Fresh install records have endpoint contracts with `url: null`.
- Docker and local-command adapters call `RuntimePortHelper.ResolveHostPort` at start.
- Automatic allocation briefly binds loopback port `0`, closes the listener, and remembers only 64 recent
  allocations in process memory.
- The endpoint URL written after a successful start is the only durable sticky automatic assignment.
- `HOSTY_PORT_<KEY>` is app-scoped, so it cannot independently represent repeated service-local keys such as
  `api.http` and `web.http`.
- A stopped app's free stored port is not excluded from allocations after Core loses the recent-memory set.
- Shell displays `not assigned` for an app that has never started.

## Target Behavior

- Install apply resolves all selected-runtime host ports and persists them before returning `installed`.
- Every endpoint backed by an assigned port has a local URL immediately, including stopped apps.
- Allocation considers all installed app assignments, Core/Shell launch ports, fixed system-app assignments,
  explicit manifest/operator ports, and matching OS bind scopes/transports.
- Runtime adapters consume the persisted assignment and continue injecting `HOSTY_PORT_<KEY>` and the
  single-port `PORT` compatibility variable.
- Endpoint status distinguishes `assigned`, `running`, and `unavailable`; a stopped assigned endpoint is not
  presented as reachable.
- A stolen assignment blocks start with a structured error and an explicit Reassign action.
- Reassign shows the old/new port and affected dependent apps before apply. It updates durable assignment and
  endpoint projections but does not restart consumers silently.
- Uninstall releases the logical reservation. Retained configuration stores the old automatic assignment as
  a reuse preference only.

## Acceptance Criteria

- [ ] Installing a single-service app with start disabled returns a non-null endpoint URL.
- [ ] The assignment survives Core restart and is used unchanged on first start.
- [ ] Two installed stopped apps cannot receive the same port in the same transport/bind collision domain.
- [ ] Parallel install/update operations cannot persist duplicate assignments.
- [ ] Allocation excludes current Core/Shell launch ports, system app ports, explicit ports, stored stopped-app
  assignments, and ports occupied by unrelated OS listeners.
- [ ] A multi-service app whose services both declare `http` receives distinct stable assignments keyed by
  service and port.
- [ ] Docker and local-command runtimes consume persisted assignments and retain current `PORT` /
  `HOSTY_PORT_*` behavior.
- [ ] App-scoped `HOSTY_PORT_<KEY>` overrides remain supported when unambiguous; a service-scoped
  `HOSTY_PORT_<SERVICE>_<KEY>` override pins one service when a key is shared, and only an ambiguous
  app-scoped override with no service-scoped disambiguation fails with a clear validation error.
- [ ] Update/runtime switch preserves compatible assignments and allocates added ports before committing the
  new contract.
- [ ] Removed declarations stop reserving their ports only after the reviewed contract change commits.
- [ ] Live-source port additions are reserved and persisted before the changed runtime launches.
- [ ] Raw TCP/UDP and fixed host-network ports participate in transport/bind-aware collision diagnostics.
- [ ] A fixed host-network port is never offered automatic reassignment.
- [ ] An external process taking an assigned port causes a structured unavailable error without silently
  changing the endpoint URL.
- [ ] Reassign is limited to automatic remappable assignments and reports every dependent app that may contain
  the old local URL.
- [ ] Uninstall releases reservations; reinstall with retained data reuses the prior port only when currently
  free in both Hosty and the OS.
- [ ] Existing installed apps import stored endpoint ports without changing usable URLs.
- [ ] Shell shows `Assigned · App stopped`, disables Open while stopped, and keeps Public origins configuration
  available.
- [ ] Existing lifecycle, update, runtime-switch, dependency, system-app bootstrap, raw-port, and host-network
  tests continue to pass.

## Deliverables

- [ ] Persistent `AppPortAssignment` model and backward-compatible app-record serialization.
- [ ] Core-wide allocation coordinator and transport/bind-aware OS probes.
- [ ] Install/update/runtime-switch/live-source assignment planning and persistence.
- [ ] Runtime adapter migration from start-time allocation to persisted assignment consumption.
- [ ] Endpoint availability/status API projection.
- [ ] Existing-app migration and retained-port preference handling.
- [ ] Reassignment plan/apply API with dependency-impact reporting.
- [ ] Shell stopped-endpoint and reassignment UI.
- [ ] Core unit/lifecycle/concurrency/migration tests.
- [ ] Shell rendering and interaction tests.
- [ ] Updated feature/API/local-development documentation.

## Technical Design

### Persistent Assignment Model

Add an optional `PortAssignments` collection to `AppRecord`. Each `AppPortAssignment` contains:

- service key;
- service-local port key;
- host port;
- transport (`tcp` or `udp`);
- bind scope (`loopback`, `host`, or `host-network`);
- source (`automatic`, `manifest`, `operator`, or `host-network`);
- whether the declaration is remappable;
- last assigned timestamp.

The identity is `(service, portKey, transport, bindScope)`, where `portKey` is the service-local port key
(not the numeric host port). `AppEndpointContract.Url` becomes a projection of the assignment plus endpoint
protocol; it is not the reservation source. Missing `PortAssignments` remains valid serialized legacy state
and is migrated before lifecycle use.

Endpoint summaries add an availability value:

- `assigned` — a durable target exists but its service is stopped;
- `running` — the owning service is running/healthy enough to open;
- `unavailable` — the persisted target failed preflight or runtime binding.

The app/service runtime state remains authoritative; a non-null URL alone no longer implies reachability.

### Allocation Coordination

Introduce one Core-wide asynchronous allocation coordinator used by install, update apply, runtime switch,
live-source contract adoption, migration, reassignment, and remove. While holding it, Core:

1. loads assignments for every installed app;
2. adds Core/Shell launch ports and system bootstrap overrides to the exclusion view;
3. preserves matching assignments owned by the app being changed;
4. validates new explicit/operator/fixed declarations;
5. probes the actual transport and bind scope;
6. requests an OS-selected high dynamic port for each automatic declaration while excluding all logical
   assignments selected in the same operation;
7. persists the complete app record before releasing the coordinator.

Unchanged assignments for a currently running app are recognized as self-owned and are not rejected merely
because that app is listening. New or changed assignments must pass the OS probe immediately before commit.
Apply revalidates any explicit port reported during a prior review.

The initial automatic pool continues to use OS ephemeral allocation rather than introducing a configured
range. TCP and UDP use matching probes. A host-scope declaration conflicts with any narrower assignment in
the same transport/port; compatible TCP and UDP assignments may share a number.

### Resolution Precedence And Compatibility

For each declaration, resolution order is:

1. service-scoped `HOSTY_PORT_<SERVICE>_<KEY>` operator override for the exact service/port key;
2. app-level `HOSTY_PORT_<KEY>` operator override when the key is unambiguous across services;
3. explicit manifest `localPort` / `hostPort` or fixed host-network container port;
4. compatible persisted assignment for the same service-scoped identity;
5. retained prior-port preference when reinstalling and still free;
6. new automatic allocation.

The app-facing environment remains service-local. Each adapter receives its service's assignment and emits
the same variable names it emits today. The service-scoped `HOSTY_PORT_<SERVICE>_<KEY>` form is added so an
operator can pin a single service whose port key (such as `http`) is shared by another service in the same
app. The legacy app-scoped `HOSTY_PORT_<KEY>` form stays supported for the common single-service case; it is
rejected with `runtime_port_override_ambiguous` only when one key maps to multiple independently published
services and no service-scoped override disambiguates them, rather than silently assigning the same port
twice.

### Lifecycle Integration

- Install builds endpoint/assignment contracts, allocates during apply, writes the installed record, then
  optionally starts it.
- Start preflights persisted assignments and never allocates implicitly. Binding failure records stopped /
  failed state with a structured assignment identity.
- Update and runtime switch compute assignment additions/removals in their reviewed plan. Compatible
  identities retain ports; new identities allocate during apply under the coordinator.
- Live-source contract adoption performs the same reservation step before launching the changed manifest.
- Remove deletes the installed record/reservations only after normal uninstall confirmation. When data is
  retained, automatic assignments are copied to retained config as non-binding preferences.

### Existing-App Migration

A startup migration runs before autostart reconciliation:

- derive assignments from stored endpoint URLs by `(service, port)` and preserve their numbers;
- incorporate explicit manifest ports and Core-reserved `HOSTY_PORT_*` settings;
- allocate only declarations whose legacy endpoint URL is missing;
- persist the additive assignment collection and endpoint projection;
- never silently change an existing stored URL because its port is currently busy.

If legacy records conflict, running/self-owned assignments win, then the earliest installed record is kept.
Other records retain their URL but become `unavailable` and require the normal explicit Reassign action.
Migration is idempotent and safe to resume after partial completion.

### Reassignment Workflow

Add host-admin/CSRF-protected plan/apply endpoints for one assignment. Plan returns:

- assignment identity and old port;
- newly allocated candidate port;
- direct endpoint URL changes;
- installed dependents whose injected local URL may be stale;
- whether the owning app or dependents are running;
- a digest binding apply to current app/dependency state.

Apply revalidates the digest and candidate under the allocation coordinator, persists the assignment and
endpoint URLs, and returns `restartRequiredAppIds`. Shell offers explicit restart actions after success; it
does not restart any app as a side effect of reassignment.

## Risks

- An external process can bind a logically reserved stopped-app port after installation. Start preflight and
  explicit reassignment contain this without pretending the reservation is a kernel lease.
- Incorrect migration identity could swap multi-service ports. Match service and port keys first and require
  deterministic fallbacks/tests for legacy endpoint-only records.
- A lifecycle path that bypasses the allocation coordinator can reintroduce duplicate assignments. Centralize
  all assignment mutations and assert uniqueness before every app-record commit.
- Bind probes can disagree with Docker/process behavior. Test IPv4/IPv6, TCP/UDP, loopback/host scope, and
  preserve runtime binding failures as the final authority.
- Reassignment can invalidate bookmarks and injected dependency URLs. Make impact visible and require explicit
  restarts.

## Open Questions

None.

## Implementation Phases

### Phase 1 — Persistent Model And Migration

- [ ] Add assignment/status models and serialization.
- [ ] Implement existing-record migration and endpoint projection.
- [ ] Add migration and backward-compatibility tests.

### Phase 2 — Coordinated Allocation And Runtime Consumption

- [ ] Add the global coordinator, collision view, and bind probes.
- [ ] Allocate during install/update/switch/live-source apply.
- [ ] Move Docker/local-command/raw/host-network adapters to persisted assignments.
- [ ] Add concurrency and lifecycle regression tests.

### Phase 3 — Reassignment And Shell UX

- [ ] Add reassignment plan/apply and dependency-impact reporting.
- [ ] Render assigned stopped endpoints and unavailable conflicts in Shell.
- [ ] Add Reassign/restart affordances and Shell tests.

### Phase 4 — Documentation And End-To-End Verification

- [ ] Update current feature/API/local-development documentation.
- [ ] Validate a never-started app through Core-managed install, public-origin configuration, first start, and
  Core restart.

## Verification

- `npm run core:build`
- `npm run core:test`
- `npm run shell:lint`
- `npm run shell:test`
- `npm run shell:build`
- `npm run check-versions`
- `npm run ci`
- Core-managed Demo App install with start disabled; verify assigned endpoint before first start.
- Parallel install smoke test with multiple stopped apps and repeated service-local port keys.
- OS-listener conflict plus explicit Reassign smoke test, including a running dependent app.
- Docker and local-command first-start verification using the install-time assignment.

## Links

- [Install-Time Runtime Port Reservations Idea](../ideas/install-time-runtime-port-reservations.md)
- [Automatic Runtime App Ports](../features/automatic-runtime-app-ports.md)
- [Cross-App Dependencies](../features/cross-app-dependencies.md)
- [Raw L4 Ports](../features/raw-ports.md)
- [Host Networking](../features/host-networking.md)
- [One-Click Cloudflare Public Ingress Plan](one-click-cloudflare-public-ingress.md)

## Notes

- The user approved all remaining product recommendations on 2026-07-14.
- This plan must be explicitly approved and moved to `Ready` before implementation begins.
- Version changes are evaluated once only when the eventual pull request is prepared for merge.

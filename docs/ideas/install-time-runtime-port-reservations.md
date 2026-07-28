# Install-Time Runtime Port Reservations

Status: Promoted
Created: 2026-07-14
Updated: 2026-07-14

## Motivation

A newly installed runtime app has no assigned host port until its first successful start. When automatic
start is disabled, Shell therefore cannot show a usable local endpoint or configure a Cloudflare public
origin without first starting the app. Port selection also remembers only a small process-local set of
recent allocations, so it does not reserve the free-but-sticky ports of installed stopped apps.

Installation should allocate and persist every required host port immediately. An administrator should be
able to install an app without starting it, expand the app card, see its assigned endpoints, and configure
public origins without knowing whether a port has already been selected.

## Current Behavior

- `BuildAppRecord` creates endpoint contracts with `url: null` for a new installation.
- Runtime adapters call `RuntimePortHelper.ResolveHostPort` during start.
- An automatic port is selected by briefly binding an OS-assigned loopback port, then closing the listener.
- Core remembers only the 64 most recent allocations in process memory to avoid close start-time races.
- After a successful start, the endpoint URL becomes the persistent source for sticky reuse.
- A `HOSTY_PORT_<KEY>` setting or manifest `localPort` / `hostPort` can pin a port, but app-scoped keys cannot
  represent two services that both use a service-local key such as `http`.

The current mechanism avoids many start-time collisions, but it is not an installation-time reservation
registry and cannot describe a never-started app's endpoint.

## Target Behavior

- Install plan/apply assigns every host-published runtime port before the app record is reported installed,
  whether or not `startOnInstall` or autostart is enabled.
- Allocation excludes assignments held by all installed apps, including stopped apps and system apps, and
  checks the operating system before choosing a port.
- Shell shows the resulting local endpoint URL immediately with an `Assigned · App stopped` state. Opening
  is disabled while the service is stopped, but configuration actions such as Public origins are available.
- Start uses the persisted assignment rather than allocating a new port. Existing `HOSTY_PORT_<KEY>` and
  single-port `PORT` environment behavior stays unchanged from the app's perspective.
- Update/runtime-switch apply preserves matching assignments, releases removed declarations, and assigns
  added declarations before changing the installed contract.
- Uninstall releases all logical reservations. Keeping app data does not keep a port unavailable forever;
  a later reinstall may reuse it only if it is still available.
- Explicit manifest or operator-selected ports participate in the same collision checks and fail before
  runtime mutation when they conflict with another installed app or an OS listener.

All host-published declarations are included, not only endpoints marked `public: true`. The `public` flag
controls ingress eligibility and warnings; it does not control local port assignment.

## Possible Approaches

### Approach A — Persist service-scoped assignments in each app record (recommended)

Add an optional Core-owned assignment collection to `AppRecord`, keyed by app, runtime service, port key,
and transport/exposure mode. A Core-wide allocation critical section scans assignments in all installed app
records, probes OS availability, chooses a free automatic port, persists the app record, and only then
releases the lock. Endpoint URLs are projections of these assignments rather than the reservation source.

Runtime adapters consume the same assignment collection and continue injecting their existing environment
variables. This avoids a manifest schema change and correctly distinguishes repeated service-local keys such
as `api.http` and `web.http`.

Pros:

- The app record remains the durable source of truth and survives Core restarts.
- No second reservation database can drift from installed-app state.
- Existing endpoints, environment variables, and manifest contracts remain compatible.

Cons:

- Allocation across separate app records requires a Core-wide lock and disciplined install/update/remove
  ordering.
- Endpoint URL can no longer imply that a service has successfully started; API/UI state must say whether
  an endpoint is merely assigned or actually running.

### Approach B — Maintain a global port-reservations file

Store all owner/service/port mappings in a separate Core document and update it transactionally.

Pros:

- Uniqueness and allocation are centralized explicitly.

Cons:

- Installation state and reservation state can diverge after a crash or partial write.
- Reconciliation, uninstall cleanup, backup/restore, and migration become a second state machine.

### Approach C — Keep sockets open for stopped apps

Hold a listener for every assigned port until the corresponding runtime starts.

Pros:

- Prevents external processes from taking a reserved port while Core remains alive.

Cons:

- Does not survive Core downtime, complicates handoff to Docker/process runtimes, consumes resources, and
  makes stopped apps appear to have listeners. This is not recommended.

## Technical Design

The assignment identity must include at least service key, port key, network transport, and exposure mode.
The numeric port alone is insufficient because TCP and UDP have different collision domains, and raw L4 or
host-network declarations may bind more broadly than ordinary loopback HTTP ports.

During install/update apply, Core should:

1. Enter one allocation critical section shared by all app lifecycle operations that can change ports.
2. Load the current installed assignments, including stopped apps.
3. Preserve compatible assignments from the existing app record or retained endpoint state.
4. Validate explicit ports and probe the bind addresses/transports that the runtime will use.
5. Ask the OS for an available high dynamic port for each automatic assignment, excluding every logical
   reservation selected in steps 2–4.
6. Persist the assignments and projected endpoint URLs atomically with the app record.
7. Release removed reservations only when the reviewed app-record change commits.

The existing OS-selected ephemeral allocation policy can remain the initial automatic pool; persistence and
cross-app exclusion are the missing guarantees. A configurable numeric pool is not required for the first
version.

A logical reservation cannot prevent an unrelated process from binding the port after installation. Start
must therefore preflight the persisted assignment. It must not silently select a different port because
running dependent apps may already have received the original local endpoint URL. On conflict, Core reports
`Assigned port unavailable` and Shell offers an explicit **Reassign port** action that explains which
dependent apps need restart.

## Existing Feature Conflicts

- [Automatic runtime app ports](../features/automatic-runtime-app-ports.md) currently states that assignment
  happens on first successful start and that no new persistent model is needed. This idea intentionally
  replaces both decisions while preserving runtime environment compatibility.
- Stored endpoint URLs currently double as proof of a successful start. Install-time URLs require endpoint
  availability/running state to be represented separately in Core summaries and Shell.
- Cross-app dependencies currently consume the dependency's stored local endpoint URL. They can benefit from
  install-time assignment, but a deliberate reassignment must surface and restart affected consumers rather
  than silently giving them stale environment values.
- System-app bootstrap ports and app-level `HOSTY_PORT_<KEY>` overrides must be imported into the same
  collision view so user apps never receive those numbers.
- Live source manifests can add a port during start without a normal update apply. Core must reserve and
  persist such additions before launching the changed runtime contract.

## Risks

- OS availability is a point-in-time probe, not a kernel-level lease; an external process can still take a
  logically reserved stopped-app port.
- Incorrect identity matching during update could swap ports between services or release a still-used port.
- Parallel installs or an install racing an update can duplicate assignments unless every allocation path
  shares the same critical section.
- IPv4/IPv6 and TCP/UDP probing must match the adapter's actual bind behavior or produce false availability.
- A port reassignment can invalidate direct bookmarks and dependency environment values even though a
  Cloudflare public hostname remains stable.

## Decisions from Discussion

- **Unavailable assignments never change silently.** Start fails with a clear conflict and Shell offers an
  explicit impact-aware Reassign action listing dependent apps that will need restart.
- **A retained port is a preference, not a reservation.** Uninstall releases the assignment; reinstall with
  retained data reuses the old number only when both Hosty and the OS report it free.
- **Host-network ports are fixed reservations.** They participate in collision diagnostics but cannot use the
  automatic reassignment path reserved for remappable declarations.
- **The manifest contract remains unchanged.** Assignment state is Core-owned and service-scoped.
- **Operators can override a shared port key per service.** The existing app-scoped `HOSTY_PORT_<KEY>` stays
  supported for single-service apps; a new service-scoped `HOSTY_PORT_<SERVICE>_<KEY>` form disambiguates a
  key such as `http` that two services share, so a manifest edit is not required to pin one of them.

## Open Questions

None.

## Verification Requirements

- Install with automatic start disabled assigns endpoint URLs and survives a Core restart.
- Two stopped apps never receive the same service port.
- Allocation excludes a port held by an OS process and every explicit/system-app reservation.
- Parallel installs cannot duplicate assignments.
- Multi-service apps with repeated `http` keys receive distinct stable assignments.
- Local-command and Docker starts consume their install-time assignments and retain existing `PORT` /
  `HOSTY_PORT_*` behavior.
- Update, runtime switch, live-source contract adoption, uninstall, reinstall, TCP/UDP, raw L4, and host
  networking have explicit regression coverage.
- Shell shows an assigned stopped endpoint, allows Public origins configuration, and distinguishes
  `App stopped` from a port or ingress failure.
- Existing apps migrate from stored endpoint URLs without changing their current ports.

## Current Recommendation

Use Approach A. Persist service-scoped assignments in the app record, serialize all allocation-changing
lifecycle operations, and project endpoint URLs immediately during installation. Keep the current OS-driven
automatic port selection, but make installed state—not a process-local recent set—the authoritative
exclusion list.

Treat this as a platform prerequisite for one-click Cloudflare ingress. Once installed apps always have
stable local targets, Cloudflare publication can synchronize immediately and no longer needs a `Pending app
start` branch. The idea was promoted after the user approved all remaining recommendations on 2026-07-14.

## Links

- [Automatic runtime app ports](../features/automatic-runtime-app-ports.md) — current first-start allocation
  behavior that this idea would extend.
- [Install-Time Runtime Port Reservations Plan](../planning/install-time-runtime-port-reservations.md) —
  implementation source of truth.
- [One-Click Cloudflare Public Ingress](one-click-cloudflare-ingress.md) — consumer of install-time endpoint
  URLs for immediate public-origin configuration.
- [Cross-app dependencies](../features/cross-app-dependencies/feature.md) — current local endpoint injection behavior
  affected by deliberate reassignment.
- [Raw L4 ports](../features/raw-ports.md) — transport and bind-scope considerations.
- [Host networking](../features/host-networking.md) — fixed host namespace ports that need collision
  diagnostics.

## Notes

- This idea does not change `app.0.1` manifest syntax.
- Until implemented, the feature document remains authoritative: new automatic ports are assigned on first
  successful start, not installation.

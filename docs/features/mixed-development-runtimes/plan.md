# Mixed Development Runtimes

Status: In Progress
Created: 2026-09-17
Updated: 2026-09-17

## Goal

Support development profiles that combine editable services and image-based dependencies, and
run editable source inside Docker when its operating-system environment is part of the app.
The motivating cases are Torrent Engine (source inside its VPN-isolated Linux container) and
Telemetry (local backend/UI with the third-party OpenTelemetry collector remaining in Docker).

## Baseline Before Implementation

The [runtime artifact model](../runtime-artifact-model/feature.md) accepts development only for
`localCommand`, requires every service's execution type to match its profile, and rejects prebuilt
services inside development profiles. Lifecycle adapters currently operate on an app context.
Changing validation alone cannot provide mixed dependency ordering, addressing or supervision.

Telemetry currently runs all three services in Docker. Its backend reads logs/traces written by
the collector through shared app data, uses `http://collector:9464/metrics`, and binds a configured
query port. Its manifest, backend and UI live in three sibling monorepo directories. Torrent's
container entrypoint configures OpenVPN and a default-deny firewall before starting the engine.

## Target Behavior

### Profile And Service Contract

- Preserve existing homogeneous manifests and reviewed runtime behavior.
- Add an explicit mixed profile type. Services in that profile declare their execution type;
  dispatch uses the resolved service type rather than assuming a single app-wide adapter.
- Keep `development: true` on the profile as the operator's choice of development workflow.
  Permit image-based dependency services alongside editable source services, and require at least
  one editable source service. A development profile does not make every service's artifact live.
- Allow Docker development services to opt into an explicit source mount/command recipe; ordinary
  Docker services continue executing their image without a source mount. Do not infer source mounts
  from a profile name or mount the checkout into every container.
- Keep existing prebuilt-folder restrictions outside this scope. New profiles need no per-service
  repositories: use the existing app-level managed checkout or selected source override.

### Docker Source Execution

- Declare a development environment image or a Dockerfile/build context contained in the authorized
  checkout. Resolve image dependencies to recorded digests; build local development environments
  with Core-owned tags and reuse the Docker build cache. Ordinary source edits do not require an
  image rebuild. Rebuild environment changes through an explicit reviewed action.
- Bind only the declared source root/subdirectory into the container, with explicit access mode
  and container working directory. Resolve real paths and reject traversal/symlink escapes.
  Preserve operator files on start, stop, failed setup and runtime switch.
- Run setup/watch commands inside the container. Separate container-specific build outputs and
  dependency caches from host outputs (for example Linux node_modules and .NET bin/obj).
  Document ownership/permissions and cleanup without deleting source or app data.
- Preserve declared capabilities, devices, mounts and entrypoint behavior. Do not implicitly grant
  privileged mode, host networking or the Docker socket to a development service.
- Live manifest adoption may update source recipes under existing policy; changes to image/build
  inputs, privileges, mounts or network exposure require review. Development does not authorize
  silent replacement of the collector or expansion of host access.

### Mixed Lifecycle, Networking And Storage

- Resolve the complete service dependency graph before startup; start in dependency order across
  adapters, stop in reverse order, and retain per-service ownership for logs, health, readiness,
  crash reconciliation and removal. On failure, clean up resources created by that operation and
  report partial failures without losing source/data or pretending the whole app is healthy.
- Reserve ports before starting any service. Generate peer addresses for the consuming service:
  Docker service DNS within the container network; assigned loopback ports for host consumers;
  explicit host-reachable bindings for container-to-host edges. Never reuse container-only names
  such as `collector` in a local process or assume container loopback reaches the host.
- Preserve existing loopback publication for declared Docker ports; cross-runtime edges use those
  reservations. Any wider exposure must be explicit. Cover Docker Desktop and native Linux routing.
- Map a single app data directory to the appropriate host/container paths per service. Keep data
  and external-mount permissions independent of source mounts and runtime choice.
- Reuse runtime-switch review/apply and failed-switch semantics from
  [source workflows](../runtime-source-workflows/feature.md). Hot reload is owned by the app's
  command and does not restart unrelated dependency containers; an explicit app restart may
  restart the full dependency graph.

### Concrete App Adoption

- Telemetry gets a `dev` profile: collector retains its third-party Docker image; backend uses
  `dotnet watch` (or `dotnet run` when watching is disabled); UI uses its Next.js development command.
  Wire host-assigned ports, collector metrics URL and shared logs/traces/store paths. Preserve
  `provides: otlp-collector`, gateway identity and existing ingestion from other apps.
- Declare the monorepo source/manifest location and permitted sibling service roots explicitly;
  source inspection must include the backend and UI without granting unrelated repository files
  to discard operations. Support both managed checkout and operator source override.
- Provide a container-source integration fixture in this repository for platform coverage.
  Adopt the feature in the external Torrent Engine repository as a companion PR: a development
  environment containing the .NET SDK plus its existing VPN tools, source watch/run inside the
  container, and unchanged VPN firewall/entrypoint guarantees. Do not substitute an unrestricted
  host process or disable the VPN gate for convenience.
- Shell/CLI expose the selected development profile and each service's actual execution/artifact
  type, distinguishing editable backend/UI from the image-based collector. Source counts remain
  source counts; they do not describe changes inside third-party images.

## Deliverables

- [x] Finalize the additive manifest contract, examples, validation of all declared profiles and
      schema compatibility behavior; update the repository-owned Hosty app skill references.
- [x] Implement per-service dispatch and dependency orchestration, including health/log aggregation,
      startup cleanup, shutdown, runtime switching and persisted-state reconciliation.
- [x] Implement reviewed Docker development environment preparation, scoped source mounts,
      container-side setup/watch commands and isolated caches/build outputs.
- [x] Implement consumer-aware peer addresses and service-specific data mappings; cover required
      reservation changes jointly with [port allocation work](../automatic-runtime-app-ports/plan.md).
- [x] Make mixed source/image locking and update behavior explicit, including live manifest adoption
      and reviewed changes to dependency images, environment recipes and privileges.
- [x] Add Telemetry's mixed dev profile and monorepo source scope; verify metrics/logs/traces ingestion,
      signed backend reads, backend/UI source reload, and data retention across profile switches through Core.
- [ ] Verify the mixed Telemetry UI embedded in Shell on macOS and Windows, including identity,
      Windows source/data paths, local process lifecycle and collector routing. The isolated macOS
      test verifies API and reload behavior, not browser embedding.
- [ ] Verify native Linux routing when a Linux host is available; no such host is currently available.
- [x] Add Shell/CLI service execution/artifact details and keep ordinary app profile selection intact.
- [x] Add the container-source fixture and implement the external Torrent Engine companion changes;
      validate the manifest, SDK build, source reload and closed-firewall direct-egress refusal through Core.
- [x] Verify a controlled Torrent transfer through a working VPN, tunnel-drop isolation and automatic recovery.
- [x] Prepare platform and companion changes for review with verification evidence and remaining acceptance explicit.
- [ ] Complete regression/security/platform verification, update affected feature documents, remove
      this plan and regenerate the docs index when all deliverables are complete.

## Delivery And Decisions

One platform feature PR contains the complete Core contract and Telemetry adoption; Torrent Engine
uses a companion PR in its own repository after the minimum Core version is established. The owner approved this scope in chat on 2026-09-17.
Keep unrelated artifact delivery and assistant authority work in their existing owning plans.

The owner requested paired PRs and explicitly authorized resolving reviews and merging on
2026-09-17 before the remaining platform acceptance. This is an owner-approved exception to
waiting for all platform acceptance in the feature PR. The owner intends to test
Telemetry runtime switching on the Windows production host. macOS is the development host;
no native Linux host is available. Windows/embedded UI and IPv6 checks are not reported as
passed, and this plan remains open until its remaining acceptance deliverables are satisfied.

The initial implementation targets local Docker engines, including Docker Desktop. Remote engines
cannot bind the host checkout and must fail with a clear unsupported-development error rather than
silently mount a different path. Multi-repository apps, automatic Git pull/branch switching,
arbitrary host mounts and new assistant mutation authority are outside this feature.

Implementation bumps the platform and Telemetry minor versions (plus Shell for its shipped UI
changes); Torrent versions independently. Current implementation versions: platform 0.103.1 → 0.104.0, Shell 0.76.0 → 0.77.0,
Telemetry 0.9.2 → 0.10.0, and companion Torrent Engine 0.8.0 → 0.9.0.

## Verification

- Test legacy profiles unchanged, mixed profile validation, dependency cycles and invalid/unselected
  service recipes. Cover artifact locks and reviewed changes under development profiles.
- Test startup/cancellation failures at every adapter boundary, dependency order, stale containers
  and processes, health aggregation and deterministic stop/remove behavior.
- Test path containment, symlink escapes, source/data retention, cache isolation and no implicit
  host socket/privileged access. Exercise port collisions and both host/container address directions.
- Use Core-managed Telemetry on macOS/Docker Desktop and Linux: send a sample log, trace and metric,
  inspect all three in embedded Shell, edit backend/UI and verify the collector remains running
  during source reload. Switch back to the existing Docker profile without losing app data.
- Use a controlled test torrent and VPN configuration for Torrent acceptance. Verify source edits
  take effect inside the container and tunnel failure does not permit non-VPN torrent traffic.
- Run relevant Core/backend/UI/Shell suites, manifest/version/index checks and production builds.

## Verification Evidence (2026-09-17)

- `dotnet test apps/core/tests/Haas.Hosty.Core.Tests --no-restore`: 1943 passed, 4 opt-in fixtures skipped.
- A final filtered Core run including the three real Docker fixtures and affected unit tests: 136 passed.
  Docker source edits take effect without rebuilding; Telemetry ingests all three signals, authenticates
  reads, reloads backend/UI without restarting the collector and retains data across stopped profile
  switches; Torrent runs/reloads source behind a closed firewall and refuses direct TCP egress.
- `node scripts/check-core-aot.mjs`: macOS ARM64 Native AOT publish passed with no new trim/AOT warnings.
- CLI: 218 tests passed; Telemetry backend: 116; Telemetry UI: 10; Shell: 162; Torrent: 90.
- Shell and Telemetry UI production builds with Webpack passed. Default Turbopack build failed locally with
  `TurbopackInternalError`; Webpack was used for build verification. Shell changed-file lint and
  Telemetry UI lint passed. Version consistency and docs-index checks passed.
- Torrent SDK Docker image builds; entrypoint shell syntax passes; production MSBuild still resolves
  `PublishAot=true`. Missing NuGet vulnerability-feed access produced NU1900 warnings during tests.
- Working VPN acceptance on macOS/Docker Desktop passed with the operator-provided read-only VPN mount:
  `Torrent_DevelopmentTransfersThroughVpnAndFailsClosedOnTunnelLoss` received 1,359,872 bytes and verified
  five pieces of the official Debian 13.7.0 netinst torrent. Tunnel loss paused transfer and blocked fresh
  connections; an established TCP canary and bridge packet capture showed zero direct egress. Restoring
  the VPN automatically resumed payload transfer. The test-only final egress guard first caught 55 packets
  permitted by the old broad established-connection rule; the companion entrypoint now limits bridge
  replies to the control API and keeps existing peer connections bound to the tunnel.
- Reproduce the opt-in VPN test with `HOSTY_TEST_TORRENT_SOURCE=<checkout>`,
  `HOSTY_TEST_TORRENT_VPN=<authorized-profile-folder>` and
  `HOSTY_TEST_TORRENT_METADATA=<legal-test.torrent>`. It installs a test-only packet observer in the
  disposable SDK container, uses temporary downloads and removes that container/data afterward.
  Production containers and the mounted VPN files are not modified.
- Windows, native Linux and embedded Shell acceptance remain unchecked. IPv6-enabled VPN isolation and
  collector-egress acceptance remain in Torrent Engine's VPN isolation plan. The installed production
  Torrent image has not been updated with the firewall correction.

## Review Verification (2026-09-17)

- Core full suite: 1952 passed, four opt-in Docker/VPN fixtures skipped by default.
- The Core-managed mixed Telemetry integration fixture was rerun with real Docker and passed.
- Telemetry backend: 120 passed; Shell: 162 passed; changed-file ESLint and Webpack build passed.
- Native AOT publish for macOS ARM64, version consistency, docs index and whitespace checks passed.
- Added regression coverage for unchanged build-image locks on reviewed updates, new-port
  reservations on update/runtime switch, legacy inactive profiles, exact-file source scopes,
  inactive command review, empty lock results, LAN-hostname peer discovery and backend port selection.
- The previously recorded Windows/native Linux/embedded UI and IPv6 limits still apply.

## Windows Operator Acceptance

1. Update Core/CLI to 0.104.0 or later, Shell to 0.77.0 or later, and the installed
   Telemetry manifest/images to 0.10.0. Wait for both Telemetry image releases before
   applying its update; the third-party collector image remains 0.155.0.
2. Ensure the Core process account can run Git, the .NET 10 SDK, Node.js/npm and local
   Docker with Linux containers, and can access the selected checkout and app-data folder.
   Telemetry's source root is the whole Hosty checkout, not `apps/telemetry`.
3. Select that checkout (or provision the managed source checkout), stop Telemetry,
   review the switch to `dev` and start it. Confirm collector runs in Docker while
   backend/UI run locally. Ingestion is interrupted while the collector is stopped.
4. Open Metrics, Structured logs and Traces through Shell. Confirm authenticated
   reads and new ingestion, then edit a backend/UI source file and confirm reload
   without restarting the collector. Restore the test edit afterward.
5. Stop Telemetry, review the switch back to `docker`, and start it. Confirm the
   existing data is retained and all three services and ingestion recover.
6. Record any failing step with per-service health/logs. This is operator acceptance,
   not evidence already obtained by the automated macOS fixture.

---
status: In Progress
created: 2026-10-20
updated: 2026-10-20
summary: Ship Docker and Local as ordinary Harness production runtime profiles, declare Docker as the manifest default, and integrate installation, switching and recovery with Core.
components: [apps/harness, apps/core]
---

# Harness Docker And Local Production Runtimes

## Goal And Owner Direction

Owner clarification, 2026-10-20: Harness exposes two ordinary production runtime profiles,
**Docker** and **Local**. Docker is the manifest default. Local is an equally supported production
runtime that a user can select at installation or later through Core's normal runtime controls.
Host access is a reason to choose Local, not a separate permission mode or a restriction on its use.

The user selects a runtime for the installed application. There is no new per-conversation runtime
selector or privileged-task workflow in this feature. Core owns the selected runtime and any
platform-wide rules for remembering the user's preferred production runtime.

Development profiles remain a separate concern, identified by `development: true`. The existing
`dev` profile and the broader development-mode redesign are outside this change. Neither Docker nor
Local is marked as a development profile. See [vision decision 49](../../vision.md).

## Current Behavior And Remaining Gap

Baseline inspected at `66b186f14c3326bf9d52da47bc2f14628ca48c59`:

- Harness's manifest declares production `local` with `type: localCommand`, development `dev`,
  and `defaultRuntime: local`. It has no production Docker profile.
- The manifest contract already supports `defaultRuntime` and a profile's `default: true`.
  `AppManifestService` gives an explicit selected runtime precedence over the manifest default.
- Core persists `SelectedRuntime` when installing or applying a runtime switch. Updates ordinarily
  resolve against that selected profile. The full preference behavior around development/Return
  belongs to the platform runtime-selection work and is not reimplemented by Harness.
- Harness separately offers Native/Shared Docker agent execution in its own settings and stores
  execution mode in conversations. That internal setting is not a Core application runtime profile.
- The [shared worker](feature.md) already supports Codex and Claude, managed workspaces, provider
  state, scoped MCP transport and recovery. The
  [acceptance report](../../reviews/2026-10-15-shared-docker-agent-acceptance.md) verifies the native
  coordinator plus containerized agents; it does not verify the requested production Docker profile.

The remaining work is to package and integrate the production profiles with Core's existing
lifecycle, then verify both as complete application runtimes. Reuse the worker implementation and
its established contracts.

## Target Behavior

### Production Profiles And Default — D9

Declare these production profiles in the Harness manifest:

| Key | User-facing name | Execution type | Development | Manifest default |
| --- | --- | --- | --- | --- |
| `docker` | Docker | `docker` | false/omitted | Yes |
| `local` | Local | `localCommand` | false/omitted | No |

Set `defaultRuntime: docker` and keep any profile-level default declaration consistent. Preserve
the existing development profile separately. Fresh installation without a user override selects
Docker. Local remains available through the same installation and runtime-switch controls.

Use Core's persisted selection for subsequent starts and updates. A new manifest default does not
replace a user's selected production profile. Consume the common platform contract for remembering
that preference across development-mode transitions; any missing generic behavior belongs to its
owning workstream. Harness adds no parallel preferred-runtime store or special confirmation policy.

Normal Core lifecycle behavior applies to both profiles. A failed start reports the selected
runtime's error so the user can repair it or choose another profile. This requires integration with
existing error reporting, not a new runtime-switching policy.

### Production Packaging And Lifecycle — D10/D13

The Docker profile supplies the application services, published images, endpoints, health checks,
storage targets and commands needed to run Harness through Core. The Local profile supplies the
equivalent supported host execution. Both expose the same application identity, settings, assistant
and translation interfaces.

The Docker profile runs the trusted coordinator in an application container. Core owns worker
container creation, execution and cleanup through a constrained coordinator-only API. The coordinator
receives neither a Docker socket nor unrestricted Docker command authority. Today's trusted native coordinator
launches the shared agent worker with Docker control; declaring a Docker profile requires a supported
placement and lifecycle contract for that coordinator and worker. Reuse their existing separation
and Core-managed ownership. The worker remains one shared agent execution resource, not a pool of
per-conversation containers.

The present manifest validator permits mixed local/Docker profiles only with `development: true`.
Do not mark the production profile as development to accommodate the old topology. D10 owns a
supported Docker service/transport design and identifies any required Core integration explicitly.

Use the normal Core install, start, stop, restart, update and runtime-switch paths. Coordinate
worker shutdown and leases with those operations, including switching away from a running profile.
Preserve data and source through failures and recovery according to the existing runtime and worker
contracts. Worker image preparation and readiness become part of the production runtime setup.
Use the existing image versioning/publication pipeline and verify the resulting artifacts.

### Settings, Providers And Existing Conversations — D11

Make the installed runtime profile authoritative for execution. Reconcile or retire the competing
Harness Native/Shared Docker setting and legacy per-conversation execution fields so they cannot
silently contradict the selected application runtime. The UI shows the selected application profile;
it does not add a chat-level choice.

Preserve existing data, provider connections and chat history when switching Docker to Local or
Local to Docker. Specify the mapping of native/Docker provider homes, path references and session
metadata before implementation. Verify supported Codex and Claude conversations can continue after
the switch and subsequent restart, including credential renewal and selected host-login handling.
Expose concrete provider compatibility problems through ordinary application diagnostics.

Do not introduce a blanket requirement to create a new chat just to select another application
runtime. Account changes and provider-specific resume constraints retain their existing semantics.
Include translation and its credential consumers in the production-profile compatibility checks.

### Complete Operation In Both Production Profiles — D12–D14

Run the supported Harness journeys in both Docker and Local: ordinary login, provider setup, chat,
workspace preparation, editing, tests/builds, Git/PR operations, app MCP tools, sandbox preview and
explicit live activation/Return. Reuse each operation owner's authority and confirmation contract.

Retain the shared worker's established admission, resource accounting, stop and recovery behavior.
Verify its integration with the Docker application profile, including detached processes,
coordinator restart, daemon loss and interrupted cleanup. Use the existing shared-source and
credential boundary described in feature.md; per-session isolation remains separately planned.

App sandboxes and their data have their own lifecycle. This production-runtime change does not
redesign development profiles or their Enter/Return controls.

## Ownership And Open Design Points

- **This plan:** Harness's two production profiles, Docker packaging, integration with Core lifecycle,
  reconciliation of old agent-mode settings, data/provider compatibility and complete acceptance.
- **Core runtime-selection work:** general user-preference persistence, production selection across
  development transitions and common runtime controls. Confirm the current contract when implementing
  D9 and add cross-feature regression coverage without duplicating that work.
- **Development Controls and workspace activation:** development profiles, live source/data trials
  and Return. **Containment:** stricter per-session and restricted-user boundaries.

The owner approved implementation on 2026-10-20. The implementation contracts are:

- The manifest declares the coordinator service and its versioned worker image. Core verifies the
  installed assistant, reviewed source authority, active worker lease and exact container ownership.
  It derives source/storage mounts, resource limits and network placement. Agent stdin/stdout uses
  a streaming coordinator-to-Core transport; arbitrary Docker operations are not exposed.
- Core mounts only the coordinator's own data/cache at their canonical host paths. This preserves
  durable provider-history links and conversation working directories across Local/Docker switches.
  Shared source roots are mounted into the worker by Core, not into the coordinator.
- Startup profile configuration is authoritative. Legacy execution-mode fields are reconciled when
  sessions load; the old setting cannot change execution. Managed credentials and durable histories
  remain shared across profiles. Host-login references require their explicitly imported portable
  credential in Docker; compatibility errors preserve the connection and history.
- Local uses host processes. The separate development profile retains its current development
  workflow. Existing stopped worker generations must be reconciled before changing execution.

## Deliverables

The completed initial shared-worker milestone used D1–D8; those IDs remain retired. D9–D15 continue
the production-runtime work after the owner's clarification. The separate Containment plan's
former D11–D13 are not reopened.

- [x] D9. Declare Docker and Local as ordinary production profiles with Docker as the manifest default; integrate with Core installation/selection, retain the separate dev profile and consume the platform's persisted user-choice contract.
- [ ] D10. Settle and implement the supported production Docker service/transport topology, packaging, storage, health checks and image delivery through Core; maintain Local as an equally supported production runtime.
- [x] D11. Reconcile internal agent-mode settings and conversation metadata with the selected application profile; preserve data, provider connections, history, translation and supported Codex/Claude resume across Docker/Local switches.
- [ ] D12. Verify and fix complete operation in both production profiles through managed workspace, Git/PR, app MCP, sandbox and live-activation journeys, reusing existing platform authority.
- [x] D13. Integrate and verify shared-worker admission, resources, stop/restart and recovery with application lifecycle and profile switching, including exact ownership, retained leases and independently checked cleanup.
- [ ] D14. Pass the production-profile acceptance matrix below on the declared supported host, verify image delivery and record sanitized results with explicit platform limitations.
- [ ] D15. Update shared-runtime and affected Harness/provider documentation, record version outcomes, regenerate the index and remove this plan after D9–D14 pass.

## Verified Implementation Progress

- D9 passes manifest selection, fresh Core-managed Docker installation, Docker/Local switching,
  restart and update planning that retains explicit Local selection. Development stays separate.
- D11 passes real Codex and Claude chats and translations through Docker -> Local -> Docker,
  preserving remembered content and provider session IDs. Tests use existing authorizations only
  after explicit owner approval; renewed credentials return to the unchanged source authorization.
  Host-login import/account compatibility also has unit coverage.
- Platform 0.146.0 and Harness 0.62.0 implement the coordinator/worker contract. Coordinator and
  worker images build locally for linux/arm64 and linux/amd64. Registry publication is not performed.
  Core 0.146.0 is required for the new Docker worker API and canonical storage placement.
- The exact Core project and test project build without warnings or errors. Full Core verification
  passes 3,800 tests, with five opt-in integration skips and zero failures. The full Harness suite passes 893
  tests across 98 files; lint passes. Image builds also compile the settings UI.
- Real acceptance verifies normal Core setup/password login, Shell embedding, preserved workspace
  history, and both profiles' workspace MCP, temporary file editing, Git diff and .NET build.
- Real Docker acceptance verifies both provider binaries, actual Claude SDK initialization after
  idle stdin, bounded resources, coordinator crash with a surviving detached writer, and Core Stop
  terminating/removing that worker. Unit coverage verifies ownership, leases, daemon failures,
  missing images, scoped mounts, child-budget refusal and retained recovery state.
- An isolated Demo App activation reaches healthy development services; explicit Return restores
  its original production selection and stopped state. Source/data remain intact until test Finish.
- Both production profiles pass an actual Demo App MCP get_my_app_role call. Container provider URLs
  route Core-issued loopback and hosty.localhost origins through the host gateway.
- Acceptance fixed the container port, system CA certificates, translation HOME under a numeric UID,
  and a released workspace lease identifier incorrectly blocking profile changes. A workspace lease
  ID is retained for reuse; a persisted worker generation still requires recovery before switching
  execution. The final image is applied through Core's reviewed update plan, not an assumed restart.
- The separately enabled production integration test passes, including a second run with sandbox
  acceptance in both profiles. Finish removes the child Core data, containers, networks and volumes;
  independent inventory confirms absence. The original Core/Harness lifecycle remains unchanged.
- Docker and Local both plan and prepare a Demo App sandbox from a registered worktree, create a
  separate test user, reach ready, resolve the preview and pass the private browser's page assertions
  and screenshot. Exported evidence is fresh. Startup takes 44.8 seconds in Docker and 41.7 seconds
  in Local with 2 GiB memory, 1 CPU and 256 PIDs allocated to each sandbox's app services.
- Both profiles pass sandbox restart, stop and dispose; independent Docker inventory confirms resource
  removal. The unbounded Workspaces app is temporarily stopped only with explicit owner authorization
  and restored through normal Core lifecycle after each check; its final state is running and healthy.

- D13 passes 20 production failure/recovery checks through Docker -> Local -> Docker. Real Codex
  turns cover admission, cancellation, active coordinator crashes and durable provider-session resume.
  Docker checks cover unavailable images/pull failure, connection loss before dispatch and during
  Stop, exhausted child capacity, refused removal and a lost reply after actual removal. Detached
  writers, generation identity, retained leases, explicit recovery and final cleanup are observed.
- Local checks cover missing CLI/provider setup, operation while Docker is unavailable, independent
  concurrent chats, same-chat admission, cancellation and active coordinator crash without message
  replay. Source activity remains retained when native descendant termination is unproven.
- The failure runner uses a private Unix Docker proxy for the disposable Core. Connection/image/
  removal faults reach the real production coordinator and Core API; the shared engine process is
  not restarted and host images remain present. The proxy's three transport/fault tests pass. A failed
  fixture Finish is recovered through the original owner and recorded request identity; independent
  inventory confirms removal of its data, containers, networks, volumes and native processes.

- Exact diagnostic assertions exposed and fixed Core worker errors being masked as generic gateway
  errors. The final coordinator image passes the complete matrix in 5 minutes 37 seconds, including
  the resource-budget reason and typed uncertain-Stop errors. Three new regression tests pass; the
  full Harness suite passes 893 tests across 98 files and lint passes. Final arm64/amd64 coordinator
  builds succeed. Independent Finish checks confirm no retained fixture data or processes, and
  Workspaces remains running and healthy.

D10 and D14 retain registry delivery/publication verification. D12 retains separately authorized
Git/PR publication. D15 retains final plan closure after those deliverables pass. Unverified native
Linux and Windows hosts are not advertised as accepted.

## Verification And Delivery

Keep one feature branch and PR. Settle D10/D11's contracts first, then implement profiles and
compatibility, run both-runtime acceptance and update the reality documents. The initial host
acceptance target remains macOS arm64 with Docker Desktop Linux containers; retain arm64/amd64
image checks without presenting them as native Linux or Windows host acceptance.

Use a registered workspace and Core-managed test environment with separate users/data. Verify
ordinary setup/password login and Core/Harness/Shell URLs, then Finish through the owning lifecycle.

| Scenario | Required evidence |
| --- | --- |
| Manifest and install | Docker and Local are production profiles, dev is separate, and an installation with no user override selects Docker. |
| User selection | Install with Local or switch to it through Core, restart and update; the selected production profile is preserved under the platform contract. Repeat for Docker. |
| Complete application | Both profiles expose working settings, assistant and translation interfaces with ordinary identity and provider setup. |
| Runtime switch | Docker → Local → Docker preserves data, provider connections and history; supported Codex/Claude conversations resume after switching and restarting. |
| Launch diagnostics | Missing daemon/image, pull failure, provider setup and workspace authority problems report the relevant runtime/application error through existing controls. |
| Development journey | Both profiles prepare/edit/test/build a workspace, inspect a diff, perform separately authorized Git/PR work and use a separate app sandbox. |
| Lifecycle and recovery | Start, stop, restart, update and switch settle worker ownership; cancellation, detached writers, coordinator crash and Docker loss retain recoverable state. |
| Existing worker contract | Shared admission, resource accounting, bindings and cleanup retain the behavior documented in feature.md. |
| Artifact delivery | Validate the exact candidate build and image/version consistency; check clean registry delivery using the supported publication workflow and preserve existing host images. |

Run affected Harness manifest/settings/session/runtime/provider tests, `npm run harness:lint`,
`npm run harness:build-web`, and the Docker checks in `scripts/check-harness-worker.mjs`.
Run affected Core tests/builds when its integration changes. Check
`node scripts/check-versions.mjs`, `node scripts/docs-index.mjs --check` and `git diff --check`.
Keep real-provider/browser results distinct from mocks and name any failed or skipped acceptance.
Publication and live adoption follow existing repository authority and release rules.

Implementation bumps Harness and Platform under AGENTS.md. Unverified acceptance remains unchecked;
publication, real provider access and live adoption require their existing authority.

---
created: 2026-10-14
updated: 2026-10-14
summary: Independent app sandboxes and parent-managed child Core environments with separate data, shared Docker, lifecycle recovery and Harness, Shell and Workspaces controls.
components: [apps/core, apps/harness, apps/shell, apps/workspaces, apps/demo-app, packages/app-sdk]
---

# Core Sandbox Instances

Core exposes single-app sandbox instances and parent-managed child Core environments as independent services. A caller can select a registered worktree
or an installed application's reviewed Docker artifact without creating a workspace, assistant
session or worktree implicitly. Workspace/session/job identifiers are optional display context;
they do not grant authority. The [plan](plan.md) tracks incomplete integrated runtime acceptance
and remaining implementation work. Both local runtime journeys have passed on macOS Docker Desktop;
the broader shipping checklist remains open.

## Current API And Ownership

Administrator routes use `/api/sandbox-instances`; app routes use
`/api/internal/apps/{callerAppId}/sandbox-instances`. The app service identity identifies the calling
installation, and a separate app-bound interactive grant or explicitly approved background grant
identifies the authorizing real administrator. A service token alone is insufficient. Requests
recheck current app permissions, installation, user authority and background scope.

`apps.sandboxes.read` and `apps.sandboxes.manage` grant access to the caller's own instances.
`apps.sandboxes.inspect` and `apps.sandboxes.operate` separately permit authorized operator-app
inspection and control. Preview viewers gain neither management nor inventory access. A background
scope pins the target app, execution input digest, source kind, allowed actions and upper limits.

| Route suffix | Operation |
| --- | --- |
| `/plans`, `/plans/{id}/approve` | Resolve inputs and obtain explicit operator review when required |
| instance collection | Prepare an instance or list authorized instances |
| `/{id}` | Read current state and persisted operation results |
| `/{id}/diagnostics` | Read bounded, sanitized app-service log tails |
| `/{id}/operations/{kind}` | Start, stop, restart, reset or dispose |
| `/{id}/users`, `/{id}/users/delete` | Create/update or delete a temporary app persona |
| `/{id}/seeds` | Stage bounded synthetic fixture files |
| `/{id}/viewers` | Set real Core preview viewers |
| `/{id}/preview` | Resolve a real-user or explicitly selected persona launch |
| `/{id}/browser-runs`, `/browser-runs/cancel` | Run or cancel private browser verification |
| `/{id}/browser-runs/{jobId}`, `/evidence/clear` | Export or explicitly clear a retained report |

Approval is an operator browser action. An app cannot approve its own execution recipe. Inputs
resolve to reviewed Docker manifests and immutable local image IDs; unsupported dependencies,
external mounts, privileges and host fallbacks are rejected. Worktree consumers are persisted
separately from ordinary short-lived activity leases and protect source cleanup until disposal.

Mutations carry caller-persisted request UUIDs and expected revisions. Reusing a UUID with different
arguments is rejected. Lifecycle HTTP responses can contain an accepted `running` operation;
clients inspect its journal until a terminal result. An HTTP disconnect does not cancel accepted
start/stop/reset/dispose work. Recovery keeps interrupted outcomes unknown and revokes access;
it does not infer successful deletion from an unavailable Docker daemon. A resource with only a
creation intent and no persisted engine ID blocks cleanup even when its name and labels match;
Core does not automatically adopt that ambiguous resource.

## Data And Identity

Instance metadata lives below `core/sandboxes`; mutable files live below `sandboxes/{instanceId}`
in the selected Core data root. Data, seed staging, dependency/build caches, logs and evidence use
separate instance-owned directories. Preparation starts with empty app data. An explicit reset
applies a staged seed, rotates the data revision and recreates fixture personas with new IDs.
Fixture references such as `{{sandbox.user.admin}}` expand to that reset's scoped user ID.

Technical stop/restart retains personas and data. Finish/dispose first revokes access, verifies
that owned consumers are stopped, then deletes temporary folders and realm state and releases the
source consumer. A minimal operation receipt remains for disposal replay. Source worktrees and
explicitly exported reports are outside instance cleanup. Expired plans are pruned; retained plans, owners, allocation receipts and operation journals have
explicit admission ceilings. Disposal and replay remain available at those ceilings.

Sandbox users are separate from the global Core directory. Their declared app roles/permissions do
not imply Core administration; a sandbox administrator has no `hostRole`. Runtime service and user
grants bind the instance, generation and data revision. Every runtime identity check revalidates
current authority, user revision and realm; ordinary installed-app grants do not authorize a
sandbox. The SDK resolves sandbox identity before ordinary app/global identity handling.

A real operator signs in through normal Core email/password authentication and receives a
preview grant for that exact instance. Selecting a test persona requires a one-use confirmation on
Core bound to the real browser session, persona revision and PKCE redirect. It does not replace the
operator's Core account. Core-user and sandbox-user directory entries remain explicitly typed.

## Docker Adapter And Local Origins

The implemented adapter targets local macOS Docker Desktop. App services, the trusted relay, the
private browser worker and the agent are separate execution containers. Core does not place the
agent inside the app container and does not give app services a Docker socket.

App networks use internal bridges with isolated gateway mode and disabled IPv6. App services have
no outer network attachment. The trusted relay provides fixed runtime-auth method/path forwarding,
registered preview HTTP/HMR routing and a separate browser-only listener. The preview listener binds
only to host loopback. Instance/data-revision hostnames separate browser storage; restart retains
the data revision while reset rotates it. Unknown origins and arbitrary proxy targets are rejected.

Creation applies non-root execution, a read-only root filesystem, dropped capabilities,
no-new-privileges, bounded tmpfs/PIDs/CPU/RAM and log rotation. Source mounts are read-only; app build
and dependency outputs use Core-owned instance caches. Demo App provides reviewed source and
artifact recipes with prepared local dependencies. Online dependency acquisition is a separate
preparation step, not an app-network capability.

Default app limits are 4 GiB RAM, 2 CPUs and 512 PIDs across its services. The relay reserves
256 MiB; the private browser reserves 1.5 GiB. Admission includes existing running container limits,
agent reservation, at least 2 GiB VM headroom, and host/VM free disk checks. Unknown existing memory
reservations are refused. A policy under `core/sandboxes/runtime.json` pins the trusted relay/browser
images and allows at most two concurrent instances.

Data/cache/evidence sizes are observed in supervisor passes with a five-second delay between
passes; Docker and filesystem latency can extend the interval. These are soft disk quotas, not hard
filesystem allocation limits. Storage violations revoke access and stop known consumers even during
long setup. Instance metrics report sampled Docker memory/CPU and a sampled aggregate memory peak;
this value is not a cgroup lifetime peak. The Core side reserves 10 GiB of the coordinated 30 GiB mutable budget for the separately managed
agent/worktrees and limits sandbox storage to 20 GiB. The experiment coordinator monitors and stops
its agent at 2 GiB state or 8 GiB worktree use. A supported production worker coordinator and the
remaining interruption matrix stay tracked under D5 and the containment plan.

## Private Browser Verification

Core accepts a bounded list of navigation, locator, fill, assertion and screenshot actions. It
provisions a one-use sandbox login credential and passes it only through private container stdin.
The worker exposes no CDP/HTTP control endpoint, arbitrary script evaluation, host file access or
storage-state export. Chromium's own sandbox is enabled with the pinned reviewed seccomp profile;
upstream provenance and the appended `chroot` rule are recorded beside that profile.

Each job uses a fresh browser context, the selected instance's restricted proxy and a five-minute
deadline. Job grants expire and are revoked on completion/cancellation; user or generation changes
also invalidate them. Orphaned jobs become unknown during recovery, including a crash before the
browser resource was recorded. Cancelling a job leaves the application lifecycle separate.

Reports contain bounded screenshots, assertion outcomes and sanitized post-login diagnostics.
They bind source revision, input digest, generation, data revision and persona revision. Changed
inputs mark exported evidence stale. Source changes during verification produce an unknown result.
Three reports are retained per instance until explicit evidence cleanup or disposal.

## Integrations And Verification Boundary

The server-only SDK `SandboxClient` supports interactive and background authority. Harness adapts
these actions to its attachment/session rules and retains mutation identities. Shell displays
instances, lifecycle progress, sampled resources, bounded service log tails, preview and persona
links. Workspaces filters instances by optional workspace context. These integrations use the independent Core service.

The Core-managed QA fixture in `scripts/experiments/sandbox-core` has no Harness/workspace API.
Its `verify.py` uses normal password login and app PKCE, then exercises artifact allocation,
synthetic users/data, reset, replay and disposal. `--background` adds a digest-bound grant and
revocation; `--runtime` adds Docker start and a private browser smoke test. A background dispatch
is also verified after logout under its separate digest-bound grant.
The fixture is not a production scheduler.

The [API checkpoint](2026-10-14-core-api-evidence.json) is retained as the earlier preparation-only
baseline. The subsequent [runtime evidence](2026-10-14-core-runtime-evidence.json) records:

- A real Codex turn through Harness in a separate 4 GiB agent container: source edit, tests, lint,
  production build, private browser verification and HMR in a held-open real-operator browser.
- A fresh Core with no development directory: an unrelated Core-managed QA client runs a pinned
  artifact interactively and again after logout using an approved background grant. Both runs
  reset synthetic personas/data, export browser results and dispose completely.
- An installed Demo App beside two sandbox instances, with separate writable app data and root/
  nested dependency caches. A real browser write affects only its selected sandbox.
- Direct and Shell-embedded preview, explicit persona confirmation preserving the operator's
  Core account, read-only persona assertions, Workspaces filtering and service logs through
  Harness and Shell. An actual agent edit updates the held-open page without a navigation.
- Network denial against host/Core/sibling/internet canaries, restricted relay paths, actual
  PID/tmpfs/OOM failures, soft disk-quota stopping, concurrency refusal, pinned-image stability
  after a mutable tag change, configuration-drift refusal and recovery.
- Graceful and abrupt Core restart adoption preserving generations/data/users; browser cancellation
  and worker death produce failed reports while leaving the app available. Agent and app stop
  independently. Finish replay confirms removal of users, temporary folders, containers and networks;
  exported reports and source remain separate.

Docker Desktop uses the owner-approved 20 GiB setting (20,939,583,488 bytes reported). The temporary
1 GiB Workspaces ceiling is restored after acceptance; the operator's Core is not restarted.
During the 101-second successful agent turn, 21 samples at approximately five-second intervals
show agent/app working-set maxima of 1.34/0.96 GiB, with a simultaneous combined maximum of
2.30 GiB. Cgroup charged-memory maxima are 1.59/1.20 GiB, with a simultaneous maximum of 2.79 GiB.
The agent cgroup lifetime peak is 2.50 GiB including earlier dependency/build preparation; it is
not an agent-turn-only peak. The agent has zero OOM events. The separate intentional OOM probe
is not part of that measurement. These are one-fixture observations, not general capacity limits.

Artifact start-to-ready measures 3.25–4.27 seconds in the final independent runs. Source startup
with empty instance caches measures 40.8–45.7 seconds; an earlier warm repeat measures 9.3 seconds.
The coordinator's held-open-page edit reaches HMR in 1.93 seconds; the real agent's subsequent edit
also preserves navigation. Image construction and VM startup are excluded from start-to-ready.

Acceptance exposed and fixed Docker configuration normalization, immutable image pinning, relay
HTTP/WebSocket handling, SDK identity lock contention, concurrent Harness cancellation, explicit
profile-over-runtime data/cache selection and Demo App's Core-provided data-directory precedence.
These fixes have protocol/unit regressions as well as the recorded runtime probes.

Current limitations include local HTTP origins only, no automatic remote publication, no generic
online package installation, and no sandbox adaptation of Demo App's MCP surface. The broader
containerized-agent transport remains owned by the containment feature; the sandbox plan retains
its own integrated development acceptance. See the unchecked deliverables for remaining work.

## Parent-Managed Child Core Environments

The independent `/api/core-environments` API creates an entire test Core on the same host and Docker
engine. App callers use `/api/internal/apps/{appId}/core-environments`, with a service credential,
a current administrator's app grant, and the explicit `core.environments.read/manage` permissions.
Single-app background grants do not authorize whole-Core environments. Ownership remains bound to
the calling installation and administrator; Harness additionally associates records with its session.

Each environment receives a unique Core instance ID, allocated port and local hostname, a root below
`environments/{id}`, and a private registry record below `core/environments`. It has its own users,
keys, connections, app registry, app data and caches. Parent credentials and provider connections are
not copied. No workspace is required. Optional registered worktrees are retained as persistent
consumers until Finish; they remain outside the temporary root.

`current` copies the parent's prepared executable closure; `release` copies its installed native
Core binary; `source` builds an absolute selected Core project into a child-owned output directory.
A source restart builds before stopping the previous process, preserving it on compilation failure.
The empty distribution catalog suppresses automatic Shell installation and its fixed-port collision.
Explicitly installed apps still follow their ordinary port and permission contracts.

Collection create/list, status, `/{id}/operations/{start|stop|restart|finish}`, `/{id}/setup` and
`/{id}/api` support the complete local lifecycle. Create and lifecycle operations use persisted
request UUIDs, input fingerprints and expected revisions. Reconnect repeats the original request or
reads its journal; it does not guess a successful outcome. Admission permits two unfinished direct
children per Core. This is a count limit, not a global recursive CPU/RAM/disk budget.

Setup uses ordinary Core bootstrap and password login with explicitly supplied test credentials.
The resulting child session stays private in the parent-owned child root. The JSON API transport
uses that child account, supports bounded relative `/api/` requests, and rejects redirects/streaming.
Normal Core authorization and installation review remain in effect: an administrator API request
does not bypass an app-install confirmation. API writes retain the called endpoint's replay rules.
An operator signs into the child Core normally; Harness lists Core and running app preview links.

Stop preserves users and data. Normal parent shutdown stops owned children and their apps;
`keep-apps` preserves them for adoption. Parent SIGKILL does not immediately stop children: the
replacement parent reconciles persisted PID/start identities and child control discovery. Interrupted
operations retain an explicit failed outcome for inspection and a deliberate retry. Finish uses a
bounded graceful stop, verified-process fallback and an exclusive Core root lock before cleanup.
It also traverses recorded descendants, removes containers/networks/volumes bearing the full owned
instance label, deletes the temporary root, and releases worktree consumers. Failed cleanup retains
the root and a retryable error. A finished operation receipt remains for replay. Borrowed source,
external mount targets, exported evidence and shared Docker images remain outside deletion.

This is the approved trusted-Core development model. The child receives the shared local Docker
endpoint and normal internet access; it is not a hostile-code isolation boundary. Modified Core code
can control Docker on this host. Existing single-app offline sandboxes retain the narrower contract
above. Explicit mount/connection/app-install approvals remain ordinary child Core operations.

The [manager acceptance](../../reviews/2026-10-14-child-core-manager.md) verifies two app-bearing
children, normal browser login, source and native release launch, a nested child, worktree retention,
keep-apps adoption, parent crash reconciliation and broken-child Finish. It supersedes the earlier
experiment's missing-manager limitation. Local image locks now preserve immutable local image IDs
for adoption; Docker source cache volumes carry full instance ownership labels; Demo health checks
use the writable app-data log directory.

The [Core and Demo source acceptance](../../reviews/2026-10-14-core-source-agent-acceptance.md)
verifies a real Harness agent changing both components in its session-owned worktree. The manager
builds that exact Core project in source mode; Demo consumes the changed authenticated directory
API in a normal browser session, and hot reload preserves the child identity. Finish removes the
child process, root and labeled Docker resources while preserving borrowed source. The temporary
API marker is an exported test fixture, not a shipped Core response field.

## Shell And Workspaces Controls

Workspaces shows a separate **Sandbox environments** section for the selected workspace. Create
sandbox selects one to sixteen active worktrees and starts a fresh child Core. The default copies
the current Core build; **Build Core from a worktree** selects an attached tree and a relative project
path. Core validates workspace membership and current source authority, rejects escaping/symlinked
project paths, and retains the selected trees until Finish. A sandbox created by the owning operator
for an assistant workspace retains that assistant's ownership and session association. External
workspaces create operator-owned environments.

The Shell dashboard lists all child environments visible to its administrator and links back to
Workspaces. Both surfaces show observed lifecycle state, including source builds in progress, and
running applications with runtime/health status. They offer normal child-account setup, Open Core,
installation-bound Open preview links, Start/Stop and explicit permanent deletion. A fresh child
starts empty: application installation/configuration uses the child Core's existing APIs and review
flow or Harness. Attaching source does not silently install or start those applications.

The public API adds `POST /api/core-environments/from-workspace` and
`GET /api/core-environments/{id}/apps`. The latter projects only app identity, display/version,
runtime/health and an installation-bound launch destination from the child's ordinary app inventory.
Unavailable or unauthenticated child inventory is explicit, never reported as a healthy empty list.
The existing Core launch contract verifies the selected installation/surface and performs ordinary
child login and app authorization; it does not transfer the parent identity.

The shared `@hosty-sdk/app/sandbox/react` panel takes a host-provided authenticated transport.
Shell and Workspaces request the optional `core.environments.inspect` and
`core.environments.operate` permissions. These operator permissions are separate from Harness's
caller-owned `core.environments.read/manage`. Creation from a workspace additionally requires
`apps.workspaces.read`. Workspaces forwards only bounded UI routes with a live administrator app
identity and its service credential; it does not expose arbitrary child API transport. Mutation
routes check same-origin JSON requests. Parent browser cookies are not forwarded.

The panel polls while visible, prevents overlapping polls and ignores superseded observations.
It persists lifecycle request UUIDs in tab session storage before sending and offers the same-request
retry after an uncertain response or page reload. Account passwords never enter replay storage.
Delete requires explicit confirmation and invokes Finish. Cleanup failure remains visible and
retryable; the UI removes a row only after observing `finished`. Worktree source and shared folders
are preserved. The older single-app panel remains separately labelled **Individual app sandboxes**.

The [UI acceptance](../../reviews/2026-10-14-sandbox-ui-acceptance.md) verifies current/source Core
creation inside Shell-embedded Workspaces, visible build progress, ordinary child-account setup,
Demo app health and identity through Open preview, Shell inventory, Stop/Start and confirmed Finish
from both surfaces. Independent checks confirm removed roots/listeners/Docker resources and retained
workspace source with released sandbox consumers.

## Testing Expectations

Verify embedded Workspaces creation in current/source mode, normal child login and application preview,
Shell inventory, deletion from both surfaces, source retention, and removal of owned runtime resources.
Cover operator grant denial/revocation, private source selection, in-flight status and same-request UI retry.

Run Core tests and a NativeAOT build, SDK tests/build, Harness tests/lint/web build, and affected
Demo App, Shell and Workspaces checks. Verify versions and the generated docs index. Preserve
regressions for replay, ownership, scope-first identity, grant revocation, source-consumer retention,
fixture reset, interrupted operations, orphan browser jobs and session-bound persona confirmation.

Shipping acceptance requires real Docker tests on the supported host: installed app plus two
isolated instances, offline network denial, creation limits, crash/cleanup recovery, normal Core
and scoped-persona login, direct/embedded preview, source edit/HMR, private browser verification and
simultaneous app/agent resource sampling. Test worktree and independent artifact flows separately.
Use a dedicated Core data root and normal setup/password login; in-process seeded identities are
not evidence of successful browser authentication. Keep every unmet case in the plan.

Child Core coverage also checks source-build failure before stop, full-journal Finish, corrupted discovery,
cross-owner denial, ordinary permission approval, borrowed-source preservation and descendant cleanup.
The separate [real-agent acceptance](../../reviews/2026-10-14-child-core-agent-acceptance.md) uses
Codex through the actual Harness adapter, with the agent creating, configuring, installing into and
finishing its child. It verifies ordinary browser password login and install confirmation, a worktree
edit, authenticated Demo identity, held-open hot reload, tests/build and independent cleanup.
Docker source generated files use service-specific writable overlays while source remains read-only.
Windows and Linux child-process launch are not verified by the macOS acceptance.

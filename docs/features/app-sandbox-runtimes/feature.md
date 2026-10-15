---
created: 2026-10-14
updated: 2026-10-15
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

Technical stop/restart retains personas and data. Start after stop and explicit restart remove the
previous generation before runtime admission inventories container capacity; stopped containers are
not counted again as part of the new generation. Finish/dispose first revokes access, verifies
that owned consumers are stopped, then deletes temporary folders and realm state and releases the
source consumer. A minimal operation receipt remains for disposal replay. An interrupted prepare resumes from its unfinished journal on the original request ID, including after reconciliation marks it stopped or unknown; later lifecycle operations and disposal are never revived by that replay. A retried disposal records running again before cleanup begins, so asynchronous observers do not confuse the preceding failed/unknown attempt with the current attempt. Source worktrees and
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

The repository retains acceptance summaries, screenshots and experiment scripts. Raw measurement
JSON, log archives and experimental source patches are local run outputs and are not versioned.

The 2026-10-14 runtime acceptance extends the earlier preparation-only API checkpoint and records:

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

## Fresh Login And HMR Verification

The [2026-10-15 acceptance](../../reviews/2026-10-15-sandbox-login-hmr-acceptance.md) reproduces
consumed callback parameters returning after HMR and verifies the SDK cleanup synchronization fix.
Fresh password login works through Shell embedding and direct Demo launch; source edits update the
open page without restoring `code`/`state`, and navigation/reload stay authenticated. Finish removes
the child process, three app containers, one network, six cache volumes and temporary root while
retaining source. The report distinguishes container measurements from incomplete native Harness
peak capture and records separate hash-only navigation behavior. D9 remains open for wider acceptance.

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
App-authorized source projects must remain inside an attached worktree owned by that session,
without symlinks; this is checked again before start/restart. Direct operator source selection
retains its explicit host-path authority. Child generations use the existing Core build retention:
active processes and runners, the latest two ready outputs and latest failed diagnostic output
are retained. Failed preparation no longer pins outputs to the long-lived parent. Unmarked legacy
outputs are not guessed to be safe to delete; Finish removes them with their owned root.
The empty distribution catalog suppresses automatic Shell installation and its fixed-port collision.
Explicitly installed apps still follow their ordinary port and permission contracts.

Operator inspection/control spans applications belonging to the same administrator, but never
exposes or mutates another administrator's child Core. App callers additionally require their own
installation ownership. Unowned build generations use nonpositive PID markers, which never count
as live processes on any supported operating system.

Collection create/list, status, `/{id}/operations/{start|stop|restart|finish}`, `/{id}/setup` and
`/{id}/api` support the complete local lifecycle. Create and lifecycle operations use persisted
request UUIDs, input fingerprints and expected revisions. Reconnect repeats the original request or
reads its journal; it does not guess a successful outcome. Admission permits two unfinished
descendants across the root environment tree. A root-owned
file lock serializes allocation across parent/child processes, including after restart. Nested
creation consumes the same count as direct creation; failed/stopped environments retain capacity
until Finish. The same tree also reserves an aggregate **8 GiB app-container memory, 4 CPUs,
1,024 PIDs and 20 GiB owned disk**. A default child reserves 4 GiB/2 CPUs/512 PIDs/10 GiB;
`limits` on create can select a different share within the pool. Descendants, stopped children and
failed cleanup retain their reservations. Independent primary Core installations are outside this pool.

Within a managed child, Docker app admission holds a persistent allocation lock, inventories existing
containers, and refuses unknown/unbounded capacity before network/build/container creation.
Concurrent app starts wait for the allocation lock through the bounded pull/build/start window;
cancellation releases the wait, and an exhausted deadline returns an explicit admission-busy error. Each app
receives 2 GiB/1 CPU/256 PIDs by default, divided across its selected services; the environment's
`applicationMemoryBytes`, `applicationCpus` and `applicationPids` configure that share. Docker enforces
memory plus equal swap ceiling, CPU and PID limits from creation. Verified adoption requires matching
limits. Existing offline app sandboxes and their browser/probe overhead also use the child's budget.
Legacy containers without verified ceilings require recreation rather than silent adoption.

Resource observations report container working memory, native Core RSS and owned disk usage separately.
Owned disk includes regular files without following symlinks, labelled container writable layers and
named volumes; descendant roots have their own reservation. Every 15 seconds the parent observes usage,
stops an environment that exceeds its soft disk quota, and retains its data and reservation. Docker
unavailability produces an explicit unknown observation. Container logs are bounded to three 10 MiB
files. Borrowed mounts, shared images/BuildKit cache and native Core/source-build/local-command processes
are not hard-capped by these Docker limits. Native RSS is measured; this is not a total host-memory or
hard filesystem quota. Selected child builds require Core 0.133.0 or newer for this resource contract.

Setup uses ordinary Core bootstrap and password login with explicitly supplied test credentials.
The resulting child session stays private in the parent-owned child root. The JSON API transport
uses that child account, supports bounded relative `/api/` requests, and rejects redirects/streaming.
Normal Core authorization and installation review remain in effect: an administrator API request
does not bypass an app-install confirmation. API writes retain the called endpoint's replay rules.
An operator signs into the child Core normally; Harness lists Core and running app preview links.

Stop preserves users and data. Normal parent shutdown stops owned children and their apps;
`keep-apps` preserves them for adoption. Parent SIGKILL does not immediately stop children: the
replacement parent reconciles persisted PID/start identities and child control discovery. Interrupted
operations retain an explicit failed outcome for inspection and a deliberate retry using the **same
request UUID and original arguments**. Successful or superseded operations do not rerun. Shell and
Workspaces preserve a failed Finish request across refresh while it remains the latest journal
operation. A newer operation supersedes that saved replay; the panel clears it and allows a fresh
delete request against the current revision instead of leaving all controls blocked.
Offline single-app plans inside a managed child default to 2 GiB, 0.5 CPU and 128 PIDs,
leaving room for their relay, capacity probes and one browser within the default child budget.
The plan persists these effective limits before approval. Explicit limits and primary-Core defaults
remain unchanged. Parent reconciliation stops incompatible pre-0.133 child processes and their
containers; a stop failure remains visible and retains the reservation for retry.

Finish closes the managed root and descendants to new starts. It journals the cleanup-owner inventory
and a root-deletion checkpoint outside the deleted tree, so interruption after removal of the identity
file remains recoverable; a changed identity still blocks deletion. Finish uses a
bounded graceful stop, verified-process fallback and an exclusive Core root lock before cleanup.
It also traverses recorded descendants, removes containers/networks/volumes bearing the full owned
instance label, deletes the temporary root, and releases worktree consumers. Fresh Docker inventories must confirm resource removal. Dependency networks carry full instance/app
ownership labels. App start preserves upgrade compatibility by reusing an unlabelled legacy network
at its exact derived name, including on non-default roots, without deleting its endpoints. A conflicting
owner label is refused. Failed app startup removes only a network created by that invocation;
adopted labelled and legacy networks are retained during partial-start cleanup. Finish still reports legacy unlabelled networks as an explicit repair error
rather than deleting them by name or silently omitting them. Failed cleanup retains the root and a retryable error. A finished operation receipt remains for replay. Borrowed source,
external mount targets, exported evidence and shared Docker images remain outside deletion.

This is the approved trusted-Core development model. The child receives the shared local Docker
endpoint and normal internet access; it is not a hostile-code isolation boundary. Modified Core code
can control Docker on this host. Existing single-app offline sandboxes retain the narrower contract
above. Explicit mount/connection/app-install approvals remain ordinary child Core operations.

The [recovery and quota acceptance](../../reviews/2026-10-14-sandbox-recovery-and-quotas.md) verifies
published Media/Transcode artifacts, product-created Docker ceilings, actual Docker Desktop loss,
explicit app recovery, same-request Finish and parent SIGKILL during root deletion. It also checks
soft-disk stopping, old-Core refusal, complete fixture cleanup and full original media hashes.

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

## Media Dependency Acceptance

The [read-only Media acceptance](../../reviews/2026-10-14-read-only-media-sandbox-acceptance.md) exercises a fresh child through a real Harness agent and normal password login. Media Server 0.92.0 and its dedicated Transcode Engine use ordinary installation review, child dependency resolution and shared-mount bindings. Both containers receive kernel-enforced read-only access to the original media folder; the mode survives provider replacement.

The companion Media implementation requires Transcode Engine 0.14.0+ for recoverable exports, using its `idempotentTranscodes` capability. [Transcode Engine PR 50](https://github.com/alex-de-haas/transcode-engine/pull/50) adds stable submission IDs and durable outcomes; [Media Server PR 338](https://github.com/alex-de-haas/media-server/pull/338) retains the exact request for recovery. The fixture recipe helper gives every preparation and service its own Docker alias and records the complete cleanup inventory before tagging. Recipe directories derived from app IDs must remain beneath the selected output directory. Copied navigation assets must remain inside both their source checkout and their recipe destination. The dated acceptance report preserves its original pre-review baseline; the linked PRs record the additional regression checks.

The browser creates a read-only catalog, scans 31 files, manually identifies one source through the normal API, and starts a full-length H.264 export to a separate writable mount. Independent probe/decode and authenticated download succeed. Media source count stays unchanged. A second Media Server remux completes after provider restart without restarting Media Server; it retains a timestamp warning also present in the original AVI.

The agent removes exports and finishes both test children. Independent checks confirm removed child processes, ports, containers and roots; all 118 source-file SHA-256 hashes and filesystem observations match. External folders survive Core Finish, then the fixture removes its own output and helper resources. Source worktrees survive.

Automatic TMDb enrichment and torrent ingestion are outside this setup. Measured fixture limits and memory do not implement aggregate child admission quotas; the broader permission, revocation and platform matrix remains in the plan.

## Trusted Child Core Consent

Delegated child creation requires explicit operator consent in addition to the initiating app's
`core.environments.manage` permission and current administrator authority. Harness exposes
`environment_consent` with the exact `environment_create` arguments. Core returns its normal
confirmation page; the page defaults to this run and offers a saved permission for matching launches.
Preparing or visiting the page does not allocate or start a child. After approval, the caller retries
the original creation UUID. Direct operator launches, including the workspace UI action, retain
ordinary operator authority and do not grant permission for unrelated later launches by that app.

Consent uses the existing background-grant store. A scope pins the owner authorization revision,
calling installation, current/release/source mode, Core target, trust-contract version and resource
ceilings. A one-run scope additionally pins the normalized creation request. Saved source consent
trusts ordinary edits in the chosen Core project/worktree, while current/release consent pins the
prepared binary closure, including native libraries, configuration and other copied runtime files.
The regenerated retention marker and skipped directory links are outside that copied closure.
Another target or increased resource ceiling requires review. Worktree
ownership and source path checks still apply independently. A single-app sandbox grant cannot
launch a whole Core; the separate `core-environment` scope can issue normal short-lived background
credentials for its reviewed actions. Consent includes only the caller's currently granted
read/manage actions; a manage-only caller does not receive read authority.

Operator-created children persist explicit operator approval, including when they retain an
assistant workspace owner. Legacy app-owned records without that marker or consent require review
before delegated start/restart, setup or child API access. The original creation request attaches
approved consent without replacing the child; operator authority and Stop/Finish remain available.

The shared Shell/Workspaces panel shows effective consent and supports revocation. Shell also lists
saved permissions when no environment remains. Effective access and saved permissions report a
changed or unavailable binary target instead of an active launch permission, while preserving
revocation and ordinary operator lifecycle controls. Grant labels reuse the validated sandbox name
without adding a prefix that exceeds the grant's name limit. Revocation prevents new delegated creation,
start/restart, setup and child API transport. The operator retains inspection, Stop and Finish.
Finish retires one-run consent; saved consent remains an explicit operator policy until revoked.
The original creation request still returns the finished receipt after one-run consent is retired,
without recreating data or processes. Exact successful or superseded Start/Restart replays also
return their existing journal after launch consent is revoked or its target changes; new commands
and retryable failures require live consent before preparing or changing the journal. Caller
identity, ownership and request fingerprint checks still apply to terminal replays.
Approval audit records identify the initiating app as their resource and retain the request, caller,
operation and one-run/saved choice under the reviewed metadata schema. A prepared generation is
journaled before post-build consent revalidation, so rejected launches release its parent ownership
and retention keeps only the latest failure diagnostics instead of accumulating orphan builds.
After reviewing a changed target or renewed permission, replaying the original creation request
updates the active child's consent without replacing its identity, data or lifecycle journal.
Renewal shares the child's command gate and re-reads its latest state after an in-flight operation.
Revocation alone neither stops a running child nor retracts its own accounts or credentials.
The child remains a trusted Core with ordinary administrator rights, internet and shared Docker;
its normal app-installation and shared-mount review are not replaced by parent-side policy.

The [2026-10-15 trusted-Core acceptance](../../reviews/2026-10-15-trusted-core-consent-acceptance.md) verifies one-run/saved consent, revocation, dedicated Redis dependencies, shared mount limits, ordinary roles, nested cleanup and Linux-in-Docker interrupted Finish. It records the measured resource envelope and remaining host-coverage limits.

The [offline daemon acceptance](../../reviews/2026-10-15-offline-sandbox-daemon-acceptance.md) verifies interrupted prepare, actual Docker loss, revoked preview with retained data, observable failed cleanup, same-UUID disposal after coordinator death, browser recovery and complete resource removal on macOS. D5 retains production worker-monitor integration; this bounded run does not establish the entire D9 host and measurement matrix.

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
Regression coverage rejects app source paths outside attached session worktrees, path-prefix and
symlink escapes, and a project replaced by a link before start. Exercise concurrent parent/child
allocation against one root budget, reconstruction after restart, and capacity release after Finish.
Build retention tests cover repeated failures, live process/runner references and unused preparation.
Recovery tests cover a partially written allocation identity, same-request Finish after Docker loss or
parent restart, partial root deletion, superseded replay, and refusal to reopen a closing root. Quota
tests cover aggregate sibling/nested reservations, unknown Docker, unbounded existing containers,
per-service division, soft-disk stop and preservation of borrowed data. UI tests retain the original
Finish request after failure and refresh.
The local review acceptance runs a real child plus grandchild, rejects a third allocation at either
level, performs three child restarts with two retained ready generations, and verifies that Finish
removes the subtree and restores both capacity slots.
The separate [real-agent acceptance](../../reviews/2026-10-14-child-core-agent-acceptance.md) uses
Codex through the actual Harness adapter, with the agent creating, configuring, installing into and
finishing its child. It verifies ordinary browser password login and install confirmation, a worktree
edit, authenticated Demo identity, held-open hot reload, tests/build and independent cleanup.
Docker source generated files use service-specific writable overlays while source remains read-only.
Windows and Linux child-process launch are not verified by the macOS acceptance.

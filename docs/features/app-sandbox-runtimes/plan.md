---
status: In Progress
created: 2026-09-25
updated: 2026-10-14
summary: Managed same-host test Core environments with separate roots and identities, shared Docker, dedicated app dependencies, and approved internet and mounts.
components: [apps/core, apps/harness, apps/shell, apps/workspaces, packages/app-sdk]
---

# Independent Sandbox Instances In Core

## Owner Direction And Scope

On 2026-10-13 the owner returned this feature to active planning for the
[November 5 local demonstration](../hosty-delivery-readiness/plan.md). The owner subsequently
approved the local network/resource profile and sandbox-user design, clarifying that finishing a
sandbox deletes its temporary users and resources. The owner authorized implementation; the plan is In Progress. The October 1/9/10 deferrals did not ship a sandbox; the baseline scope is recorded below, qualified by the 2026-10-14 owner revision:

- Sandbox instances are an independent Core capability available to any app with reviewed rights.
  Workspace, worktree and Harness-session bindings are optional integrations, not prerequisites.
  The normal installed applications remain running. A development workspace can group instances
  for relevant apps; an independent QA app can test a selected version without a development task.
- Use full Docker execution from reviewed source or a pinned app artifact. For source development, reuse the implemented
  [Mixed Development Runtimes](../mixed-development-runtimes/feature.md) and its
  [remaining acceptance plan](../mixed-development-runtimes/plan.md). Native `localCommand` is not
  an alternative backend for this protected sandbox mode.
- Every app instance receives its own new data directory. Empty data behaves like a fresh install;
  an authorized agent may prepare synthetic fixtures there. Production app data, snapshots and credentials are not inherited. Explicit shared-mount/provider
  bindings follow the 2026-10-14 revision below. Former D7 remains retired; it is not reused.
- The real Core remains the identity provider. Operators and explicitly permitted viewers use
  their real Core accounts. The owner's later 2026-10-13 approval adds a Core-managed identity
  realm per sandbox instance: agents can create test users and vary their roles/permissions there
  without creating global Core accounts. This revises the real-users-only testing proposal while
  retaining real-operator preview. Sandbox authentication must not become a global login bypass.
- Test users and temporary resources live only as long as their sandbox. Technical stop/restart
  preserves them; Finish sandbox disposes them together. Source worktrees have a separate lifetime.
- Operator preview and Playwright testing serve both independent and workspace flows. Local preview is
  required first; access to a sandbox on a production host is an optional later delivery outcome.
- A final live-data trial is an explicit operator-controlled installed-app development/runtime
  switch, owned by [Development Controls](../app-development-controls/plan.md). Passing tests,
  merging a PR or starting a sandbox never performs that switch automatically.

The eventual goal is to run source-capable apps this way, with declared or agent-prepared Docker
recipes. Source availability alone does not prove a compatible build, watch command or safe test
dependency graph. Start with one representative app; report unsupported workloads and missing
recipes honestly. There is no promise to infer a working sandbox for arbitrary source without setup.

## Extensible Permissions (Owner Revision, 2026-10-14)

The later environment refinement below supersedes the initial shared-installed-provider delivery
choice. Internet and reusable consent remain required; dedicated dependency instances are now the
preferred first target. Shared installed providers remain deferred under D14, not silently approved.

The owner defines sandbox as a development/test environment that reduces accidental damage to
installed applications, with separate app data and identities. It is not a malware-analysis
containment guarantee. Internet and useful integrations are required product capabilities; the
verified offline Demo App recipe is one selectable profile, not the architecture's ceiling.
Operators can choose a separate Hosty staging installation when they need a stronger operational
separation. This direction supersedes blanket dependency/mount/Core-capability bans below outside
the offline profile. [feature.md](feature.md) still describes the offline implementation; D13-D17
track the extension, without presenting new permissions as already available.

### Keep Data Ownership Simple

Keep the published `appId` as the application/manifest identity, and use the already distinct,
Core-generated `runtimeInstanceId` for each execution's mutable resources. Never manufacture a
new marketplace app or route instance state through the installed app's data folder. Instance
credentials, provider allocations, cache namespaces and cleanup ownership must include the execution
identity, not just `appId`. Mutable data stays under `sandboxes/<runtimeInstanceId>/`, outside `apps/`.
Changing an identifier alone does not isolate a shared database; its provider must allocate and
actually restrict a separate database/user or equivalent namespace.

### Reuse Permission Review And Persist Operator Choices

Reuse Core-owned permission review, revocable grants, existing dependency declarations and the
shared-mount library. Extend them with an execution target and an explicit sandbox policy; avoid a
parallel identity system, generic policy language or a service-mesh project. A manifest/request
states what an app needs and an optional explanation; it cannot grant that access to itself.

An operator can approve one run or save a policy for a defined app/caller scope: for example,
internet allowed, a selected transcode endpoint allowed, a selected database forbidden, and the
shared media folder read-only. Matching later runs proceed autonomously. Prompt for a requested
expansion beyond the saved policy, not each restart or ordinary source edit. Reuse existing
revision/digest checks for materially changed executable contracts and targets. Report effective
access and revocation in the existing instance view. User roles inside the sandbox and permissions
of its running service are separate: a test user's `admin` role is not a Core administrator grant.

| Capability | Target behavior |
| --- | --- |
| Internet | Explicit, persistently approvable outbound internet access. Keep offline available. Do not constrain the product to HTTP/HTTPS or make domain-by-domain approval/custom TLS interception prerequisites. Support browser and setup traffic according to the selected policy and report any first-profile protocol limits. |
| Dependency | Bind a declared endpoint to an explicit installed provider, another sandbox instance, or a newly created test provider. Missing/unapproved bindings never silently select production. Multiple service containers already work; grouping multiple app instances must remain independent of workspaces. |
| Shared mount | Bind a declared slot to a registered shared folder, with an operator-approved access mode. Default this exception to read-only and enforce Docker mount mode; an agent's promise is not enforcement. A write grant is a distinct explicit expansion. Never infer permission to mount installed-app data. |
| Core API | Permit selected operations through existing authority checks and an instance-aware service identity. Include a sandbox app creating child sandboxes when explicitly granted; role labels alone grant nothing. Children remain visible to the operator, retain the authorizing owner, and count toward the same quotas. |

Internet access can reach public origins of installed apps. The owner accepts this reachability;
Core must not claim that an internet-enabled profile makes every production endpoint unreachable.
Normal endpoint authentication still applies and sandbox credentials never become ordinary
installed-app/user credentials. A provider denied by policy must not receive an implicit binding or
delegated grant. Where a provider has an unauthenticated public API, network reachability can still
allow calls; do not describe a missing binding as an enforced denial of that API.

The existing [dependency contract](../cross-app-dependencies/feature.md) supplies discovery, not
universal app-to-app authorization. Reuse a provider that explicitly supports sandbox clients and
scoped resources, or make the operator's trusted shared-provider choice clear. An unchanged
Transcode Engine can be shared when its job inputs, outputs and available operations are acceptable.
A shared MongoDB server requires a separate sandbox database and appropriately restricted
credentials; a unique ID by itself is insufficient. Otherwise start a separate test provider.
Keep these resource contracts provider-specific and small; do not make a universal database
provisioner or the entire [cross-app auth proposal](../cross-app-auth/plan.md) a prerequisite for
internet or read-only media access. Any reused peer-introspection contract must retain instance
identity instead of treating a sandbox as its installed application's `appId`.

Finish removes owned child instances and verified sandbox-only provider allocations, detaches
shared bindings and deletes local temporary data/users/caches. It never stops/deletes the shared
installed provider or removes the operator's shared folder. Interrupted remote cleanup remains
visible and retryable. Deleting a sandbox cannot undo effects already requested from a shared or
external service; the UI must describe the granted access without promising transaction rollback.

### Delivery Order And Acceptance

Implement D13 internet and reusable consent first, then D15 read-only shared mounts. The later
environment refinement selects dedicated dependency instances for D14 and scoped Core data for
D18/D19; shared installed providers are deferred. Add D16 child creation through the same Core API. Reuse ordinary Docker connectivity and the existing auth/mount primitives where
they satisfy the selected policy. Retain only relay duties needed by that profile; extend the
Core method/path boundary from granted capabilities rather than adding permanent ad-hoc exceptions.
Do not add a transparent HTTP firewall, a mandatory domain allowlist, a new global user catalog or
nested Docker daemons as prerequisites.

D17 acceptance covers an external API and normal DNS/TLS, remembered permission without repeated
prompts, revocation, a real read-only media mount that refuses write/delete, a separate
transcode-like provider and database instance, environment-owned Core resources, and child
creation allowed/denied under aggregate quotas. Verify Finish preserves shared resources and
installed app data, and can retry cleanup of owned resources. Extend private-browser networking
with the same declared capabilities so verification does not remain artificially offline while
the app itself has internet. The earlier offline network-denial tests remain valid for offline.

## Environment Scope (Later Owner Discussion, 2026-10-14)

The owner's final clarification selects separate Core processes on the same machine with a shared
Docker daemon, individual data roots, ports and local browser origins. Core is trusted software;
instance names and ownership checks prevent accidental interference in normal operation, not a
security boundary against a modified Core holding Docker authority. Operators needing a physical
boundary use a separate development host themselves. A VM or a Docker API broker is not required
by this selected profile. The owner explicitly authorized a local experiment on October 14 and subsequently approved implementation of the child Core manager, the experiment fixes, and verification through Harness.

This replaces the earlier proposal to namespace every Core store/API by a token claim. It also
replaces bespoke per-app sandbox role assignments: each test Core uses the normal Core user,
role, app-assignment and service-authority model in its own stores. The implemented single-app
offline sandbox remains the verified baseline until the new environment lifecycle is delivered.

### One Test Core, Several Apps

A test environment owns a fresh Core data root and one or more app/dependency installations.
Published app IDs stay unchanged; the Core instance ID distinguishes identical apps on one daemon.
Ordinary API behavior operates on this Core's own users, keys, sessions, workspaces and app records.
Do not copy production credentials, provider connections, sessions or app data into the new root.
Internet and approved shared mounts remain supported target capabilities. Dependencies are separate
installations in the test Core; shared installed providers remain deferred under D14.

Core can run a selected release or a reviewed source checkout using existing Dev Mode. A task that
changes a Core API can rebuild/restart its test Core without replacing the primary Core. The agent
remains outside that process. Borrowed source and explicitly shared directories have independent
ownership; Finish must not delete them. Test-only repositories must not inherit production Git
credentials or shared Git metadata merely because their working files are temporary.

### Instance Names And Local Preview

Existing non-default roots already persist `core/instance-id`, prefix Docker names with its short
scope, stamp `hosty.instance`, and derive instance-specific local browser origins. Reuse this
foundation, verify identical app/service IDs concurrently, and expose parent/environment identity
in management metadata. Do not infer ownership only from a human-readable prefix. Keep existing
default-instance names compatible; decide whether an explicit sandbox marker adds value when the
parent-managed launcher is introduced. Names are diagnostics, not Docker authorization.

### Parent Lifecycle And Cleanup

The main Core owns a durable registry of test environment roots, process-start identities, endpoints
and resources. A child process does not automatically die when its parent exits, and Docker
containers are owned by the daemon rather than the Core process tree. The existing detached CLI
launcher therefore cannot by itself provide parent-coupled teardown.

For an ordinary parent stop, close admission, request graceful stops of child Cores concurrently,
wait with a bounded timeout, then reconcile owned processes and containers before stopping the
parent. Do not delete test data merely on a technical stop/restart: Finish is the explicit disposal
operation. A Core-only restart should retain/adopt environments when requested, consistently with
existing `--keep-apps` behavior. After a parent crash, reconcile the durable registry on startup;
do not claim immediate cleanup after SIGKILL without an independently surviving supervisor.

Cleanup must also work when the child Core is broken. The parent verifies ownership and process
start identity before a fallback stop, removes only this environment's Docker resources, then
deletes its owned root. Borrowed source, shared mounts and exported evidence remain intact.
Interrupted cleanup stays visible/retryable. D19/D21 own product implementation, not the experiment.

### Approved Manager Contract (2026-10-14)

The independent `/api/core-environments` API owns create/list/status/start/stop/restart/Finish.
App clients use installation credentials plus a live administrator grant; an older single-app
background grant does not silently authorize a whole Core. Harness exposes the same operations,
with optional session/workspace context rather than a mandatory workspace dependency.
A fresh environment has its own Core identity, root, API port and normal password setup. It starts
with an explicit empty distribution catalog, avoiding automatic Shell installation on port 7171.
No parent user, connection, app database or credential store is copied. The current prepared Core
is the default launch target; explicit source and installed-release selections remain available.
Source restarts build before stopping the old child. Startup verifies process identity and readiness.
Operation UUIDs and fingerprints survive reconnects; partial cleanup remains observable and retryable.
Ordinary parent shutdown stops children concurrently; keep-apps retains them for verified adoption.
Finish also reconciles labelled Docker resources and recorded local runners if a child is broken.
The owner confirmed that unrelated container stops during the experiment were their parallel work.

### Immediate Experiment (Approved)

D20 verifies two fresh same-host source Core processes with the shared Docker daemon and the same
Demo App artifact. Measure process readiness separately from source build, Core RSS separately
from Docker memory, unique container/network names, separate data/origins/users, ordinary stop,
`--keep-apps` restart/adoption, abrupt child death and an explicit coordinating stop of both Cores.
Record the absence of automatic parent teardown as a limitation rather than presenting an external
test coordinator as a shipped Core API. Run applicable tests before launch and remove only the
experiment's runtime resources afterwards. No commit or publication is authorized.

## Ownership And Existing Foundation

Owner clarification, 2026-10-13: this capability must also support independent QA, recurring tests
and performance experiments without code changes. Core owns the sandbox API, registry, reviewed
execution inputs, lifecycle, temporary identities/data, quotas, preview and cleanup. Harness,
Workspaces and independent apps are clients of the same service. Neither an assistant provider
role nor an active conversation is required to call it. The proposed contract is not shipped yet.

The caller owns scheduling, scenario selection, result aggregation and any later optimization or
source-edit workflow. This plan makes one independent QA run possible and verifies background
authorization; it does not implement a scheduler or an autonomous optimizer. Harness job scheduling
remains with [Bridge D11](../ai-agent-bridge/plan.md#step-11--durable-jobs-and-notifications), and
exploratory evaluation remains with [Agent app evaluations](../agent-app-evaluations/plan.md).
These clients are not prerequisites for the Core capability. Agent and app instances may reuse lifecycle
primitives, but sandbox delivery does not require per-session agent containers or a universal
instance framework first.

Owner clarification, 2026-10-13: the agent execution container and the application's sandbox
runtime container are separate. The agent edits the authorized worktree and prepares selected
fixtures; app services execute in their own instance containers with separate data and limits.
Sharing selected source does not imply sharing a process namespace, provider home or Docker
control. Core or its trusted launcher creates the containers; neither the agent nor the app
receives the Docker socket.
An app's development/watch process may compile source in its own environment. Placement of other
build/test commands remains a measured choice, independent of this runtime separation.

The [Harness experiment](../../reviews/2026-10-13-harness-container-experiment.md) built and tested
Demo App inside the agent worker without starting an app server. Its 2.36 GiB cgroup peak is not a
measurement of a running sandbox or a two-container development loop. D4/D5/D8/D10 remain open
for source reload, separate app resources, browser verification and operator access respectively.

[Session workspaces](../assistant-session-workspaces/feature.md) own source/worktree allocation,
Git and consumer-aware cleanup. [PR lifecycle](../assistant-pr-lifecycle/feature.md) owns commits,
push, PRs, CI/review observations and completion. [Development sessions](../assistant-development-sessions/plan.md)
owns development-journey acceptance, and [App Authoring](../app-authoring/plan.md) consumes the same flow
for newly created apps. [Containment](../assistant-runtime-containment/plan.md) owns the agent's
host boundary; this feature owns the boundary when a selected application executes in a sandbox.
[Bridge D11](../ai-agent-bridge/plan.md#step-11--durable-jobs-and-notifications) owns later durable
job/delegation orchestration, and [Feedback](../app-feedback-inbox/plan.md) owns observations.

Current reusable pieces and gaps:

- Docker source profiles support an environment image or a reviewed Dockerfile/build context,
  scoped source mounts, setup/command recipes, cache volumes and the app's watch command.
- Core runtime context currently derives data/cache/dependency URLs from the installed app.
  Docker names have Core/app/service identity, without the required sandbox-instance identity.
  Selecting a worktree alone does not create separate data, auth or concurrent runtime resources.
- [Local Browser Origins](../local-browser-origins/feature.md) supplies local names and real Core
  sign-in mechanisms. Extend resolution to instances rather than assuming existing app-level
  routing and credentials already distinguish them.
- The [Workspaces viewer](../workspaces-app/feature.md) currently inspects source and publication.
  The instance inventory, preview controls and verification evidence described here are new work.

Keep one real Core on the host. Tests must use designated synthetic resources and must not adopt
or restart the operator's live applications as a shortcut to demonstrating instance isolation.

## Proposed Core Integration Contract

These are approved implementation requirements, not shipped APIs. The first acceptance target is
Demo App on local macOS/Docker Desktop,
driven by one contained Harness agent. Exercise an installed app and two additional instances
under the **same** test Core. The earlier disposable Core fixture does not prove that coexistence.
Represent multiple service containers from the start; one combined Next.js process is only a
fixture, not a restriction on the instance model. Expand host/stack support only after verification.
Also exercise the same API from a non-Harness app without a workspace, worktree or assistant
session. This is a required independence check, not a later optional extension.

### Identity And Persistence (D1, D2, D5)

| Identity | Proposed meaning |
| --- | --- |
| `coreInstanceId` | Existing Core installation/data-root identity. Preserve the current Docker `hosty.instance` label with this meaning. |
| `ownerUserId`, `callerAppId` + `callerInstallation`, `authorityRef` | Real authorizing owner, creating app installation when applicable, and interactive/background authority reference. Core derives these from verified credentials, not caller-supplied ownership fields. |
| `workspaceId` | Optional development grouping using the existing logical workspace. It grants no sandbox authority by itself. |
| `worktreeId` | Existing `DevelopmentWorkspace.id`, required only for a worktree source reference; preserve legacy workspace/Git API naming while new contracts name it explicitly. |
| `appId` + `installation` | Target app identity and installation, independent of the calling app and any workspace. Preserve published identity and reject stale bindings after reinstall. |
| `sourceRef` | Reviewed worktree reference or immutable app artifact/recipe reference; Core resolves inputs and ownership without arbitrary caller-supplied host paths. |
| `runtimeInstanceId` | New Core-generated opaque ID for an additional app instance, with or without workspace context; requests never silently repurpose a previous one. |
| `identityRealm`, `sandboxUserId` | Explicit principal kind and a test-user ID namespaced to one runtime instance/data revision. Never resolved through the global Core user directory by ID or email. |
| `revision` | Compare-and-swap version for lifecycle/configuration operations. A source edit does not pretend to be an authorized configuration change. |
| `generation` | Execution identity changed when containers are recreated; service credentials and adoption checks bind to it. |
| `dataRevision`, `sourceObservation` | Seed/reset identity and artifact digest or observed HEAD plus dirty-content fingerprint, according to source kind. Evidence does not imply mutable source/data stayed frozen. |

Persist an instance registry and operation journal owned by Core, outside container mounts. Each
record contains the verified owner/caller/authority, exact target/source reference, optional
workspace/session/job correlation, reviewed manifest/profile
digest, resolved image/build inputs, effective settings/dependencies/limits, data and cache resource
references, preview ACL, desired/observed state, services, ports, generation and cleanup blockers.
Store signing material separately; UI projections expose no service/user tokens or source secrets.
Do not migrate Git allocation or add a second workspace registry.

Introduce an explicit execution target in the runtime context: installed app or sandbox instance.
Reuse Docker source/service orchestration, but resolve every path, artifact lock, port, network,
credential, health/log query and cleanup action against that target. Creating a modified `AppRecord`
and calling installed-app start is insufficient: downstream app-keyed lookups can still reach live
resources. Keep installed-app endpoints, artifact locks and source overrides unchanged. Existing
Docker names and keep-apps adoption remain compatible; new instance resources have additional full
instance/generation ownership labels. Names alone never authorize adoption or deletion.

Contract review precedes mutation. Resolve the manifest from the reviewed source reference and record
a digest of execution-affecting inputs. Core rechecks authorization, digest and contained paths at
apply time. Changed commands, image/build recipes, mounts, dependencies, environment, ports or
privileges require a refreshed review; ordinary application edits continue through the source mount.
Sandbox authority does not grant `apps.sources.full` or bypass installed-app source-override approval.

### Execution Inputs And Optional Workspace Integration (D1, D2, D4, D12)

Support two explicit source kinds through the same lifecycle:

- `worktree`: use the registered app/worktree binding and existing source authorization. Hold
  the source consumer lease while the instance exists; edits and HMR use that selected source.
- `appArtifact`: select a Core-resolved, reviewed version with an immutable manifest/recipe and
  image digest, or an immutable source bundle built through the reviewed offline recipe. Allocate
  fresh instance data and temporary outputs without allocating a workspace/worktree. Pin inputs;
  never follow a mutable image tag or installed-app source override silently on a later run.

Artifact acquisition reuses the existing reviewed supply path. Reading the selected runtime recipe
does not authorize copying production settings, credentials, data or app grants. The first artifact
acceptance uses the prepared Demo App version; arbitrary source providers and host paths are not
added to the API. A caller requesting code edits still needs a separate authorized source workflow.

Workspace integration supplies a source reference and optional grouping, then consumes the general
instance API. Validate any supplied workspace/source linkage; omission must not create a hidden
workspace or bypass worktree rights. Source consumer coordination applies only when that source
kind needs it. An artifact lease protects its pinned inputs independently of Git allocation.
Workspace, session and job IDs are correlation context, never ownership or authorization evidence.

### Integration Points And Compatibility

| Current code/contract | Required change in this feature |
| --- | --- |
| `DevelopmentWorkspaceModels` / `DevelopmentWorkspaceService` | Optional integration: validate worktree/app bindings and register source consumers; do not own the sandbox registry or require workspace allocation for artifact runs. |
| `CoreLifecycleService` / `RuntimeLifecycleContext` | Resolve installed and sandbox execution targets explicitly without redirecting installed state. |
| Docker adapter in `RuntimeAppManifest.cs`, `DockerSourceRuntime`, `RuntimeServiceDiscovery` | Scope resources, source caches, locks and dependency addresses to the instance; apply limits at creation. |
| `AppServiceTokenService`, `AppIdentityService`, `AppSessionGrantStore`, auth/directory/delegation endpoints | Add instance-scoped principals and grants; existing app-ID-only credentials must not authorize a sandbox. |
| Background grant store, issuance, dispatch and SDK clients | Add a closed sandbox scope for authorized independent clients; current installed-app lifecycle scopes do not grant sandbox access. |
| `LocalBrowserOrigins`, launch/navigation and SDK browser/server auth | Resolve the exact instance endpoint, callback and user grant; retain installed-app behavior. |
| Harness `sessions/development.ts` and `sessions/manager.ts` | Add scoped sandbox tools and durable operation recovery to the existing session/workspace flow. |
| Workspace inspection and Workspaces UI | Add authorized instance observations and Open preview. The existing `apps.workspaces.read` grant remains read-only. |

Installed targets use their existing protocol. Instance support is an explicit capability: an older
SDK/app that cannot carry or validate the target receives an actionable compatibility error, never
a fallback installed-app token. Start SDK adoption with Demo App; record the supported contract
version in readiness. Scope additional app/SDK adoption through D4/D9 rather than promising all
existing apps work unchanged.

## Runtime Instance And Development Loop

### Completed Bounded Two-Container Experiment (2026-10-13)

The owner authorized and the experiment completed Harness-driven edits with the agent and Demo
App in separate containers, synthetic app data, real browser hot reload and resource measurements.
It used a disposable Core data root and ordinary Core-managed runtime/authentication, preserving
the live Core/apps. Existing source override supplied the fixture, not a concurrent-instance
registry. This bounded research covered D3-D5/D10 and Containment D9 without approving product
implementation; its commands, adaptations, failures and cleanup remain in the dated report.

The [dated result](../../reviews/2026-10-13-two-container-development-experiment.md) records two
Harness-driven edits visible through browser hot reload, synthetic seed access, four passing
tests/lint and independent stop/restart. The corrected app restart reached HTTP readiness in
9.53 seconds. The measured development loop uses separate containers and a disposable Core,
not a shipped workspace-instance registry. Port binding, Next type metadata and nested dependency
cache isolation required fixture corrections. The app's limits were applied after creation, so
limits from initial startup remain unverified. D4/D5 retain generalized recipe, cache, resource
and readiness acceptance; D2/D8/D10 retain instance authority and full browser integration.

Keep app identity, installed-app identity, workspace, worktree/source state, runtime profile and
sandbox instance/generation distinct. Core owns the sandbox record under verified caller/owner
authority; a workspace may group it. A Harness session supplies development context, while an
independent client supplies its own authorized run context. Closing a tab must not delete source
or stop an operator's preview implicitly. Neither path requires the other client to be running.

Each instance records its owner/caller and access policy, target/source and optional context, source state,
reviewed execution contract, service graph, data seed revision, effective grants, ports/origin and
observed health. It gets separate data, caches, scratch, logs, service names, network resources and
credentials. Runtime identity is independent of display names and never obtained by rewriting an
app's published ID to bypass authorization.

For interactive development, prepare/reuse a dev environment image, mount the selected worktree
and run the stack's watch command in Docker. Current Docker development semantics rebuild the
environment after reviewed recipe/dependency revision changes; ordinary source edits use the mount.
Do not require a full app-image rebuild on each edit. Keep Linux dependencies/build outputs in
instance-scoped caches where needed. Check file watching, browser HMR/WebSockets and restart behavior
on the actual host. A static/frozen-source run is also useful for reproducible final verification.

A sandbox workflow may group several app instances and service containers. Resolve each dependency
to an explicit test provider/mock or an operator-approved installed provider under D14. A missing
binding never falls back to production. Settings and credentials remain explicitly instance-bound;
they are not a blind copy of the installed application configuration.

## Test Data And Agent Access

Proposed layout under the selected Core data root (D3):

```text
core/sandboxes/instances/<runtimeInstanceId>/    # Core-only record, operations, resolved contract
core/development/trees/<worktreeId>/             # Existing source; never copied into app data
sandboxes/<runtimeInstanceId>/
  data/                                        # Empty or synthetic app state
  seeds/<seedRevision>/                         # Synthetic fixture inputs
  cache/<recipeDigest>/                        # Disposable instance-specific cache
  logs/                                        # Bounded runtime logs
  evidence/                                    # Access-controlled verification artifacts
```

Core allocates and validates these paths; the caller supplies IDs, never an arbitrary host path.
Service-specific database volumes and Docker source overlay volumes carry the same ownership.
Give app services only their declared data/cache subpaths, the selected source and necessary
scratch. A shared source worktree is not shared writable dependency output: isolate root and nested
`node_modules`, framework output and other declared caches from the agent and every other instance.
Use `volume-nocopy`, validate mountpoints/symlinks, initialize ownership narrowly and check generated
metadata before starting a read-only source recipe. Do not solve setup failure by mounting the
entire worktree writable. Explicit source-write recipes require separate review.

Cache reuse is within one instance and compatible recipe/lockfile/toolchain revision. Retain it on
ordinary stop/restart; dependency or recipe changes select a new namespace or an explicit rebuild.
No shared writable cache or automatic copy of installed-app caches. Image/build-layer reuse is a
separate optimization, never a route to production secrets. Do not delete daemon-wide caches/images
when disposing one instance.

Core exposes a bounded seed file API to authorized clients. For initial agent seeding, Harness
adapts it instead of changing mounts in a running shared agent container. The caller submits
relative files to the selected instance's seed
staging area; Core validates size, path and symlink containment, records a revision, then applies it
while the app is stopped. Reject writes to instance metadata, logs, evidence, caches and other data
roots. A later direct seed mount must remain individually authorized, not expose all sandbox data.
The file API carries a synthetic-data declaration, not a claim to detect whether arbitrary bytes
are real data. This workflow exposes no production-data export or import operation.

Support empty startup and reproducible synthetic seed recipes. Prepare seeds before start, or stop
and reset through a defined application-aware procedure; do not assume copying files over a live
SQLite/database directory is valid. Database services need separate test volumes and may need a
seed command or API instead of file generation. Per-user fixture records can reference real Core
user IDs while all application business data remains synthetic.

Stop retains data while verification or operator inspection is still open. Reset returns to empty
or a selected synthetic user/data seed. **Finish sandbox** invokes dispose and deletes its test
users, credentials and all owned temporary data, seeds, caches, logs and verification artifacts.
This includes Core-only realm records, seed staging and service volumes, not just the visible data
folder. There is no persistent sandbox-user catalog or automatic archive after completion.
An explicitly exported report belongs to its chosen destination, outside the sandbox lifecycle.
Source edits/worktrees and the shared agent's own state are separate resources; disposal does not
delete them. There is no automatic data promotion, production snapshot import or writeback on PR merge.

### Lifecycle And Recovery (D5)

Keep desired state separate from observations: `prepared`, `starting`, `ready`, `unhealthy`,
`stopping`, `stopped`, `resetting`, `disposing`, `disposed`, with explicit `failed`/`unknown`
operation outcomes. Return the operation ID while work proceeds; accepted start is not ready.
Reserve ports and acquire durable instance/input consumers before any setup or container start;
acquire a worktree consumer only for a worktree source reference.
Readiness requires the declared health checks and correct published HTTP endpoint for preview,
including port/environment agreement. A timeout exposes the failed service and bounded logs.

| Operation | Required semantics |
| --- | --- |
| Prepare/start | Validate the reviewed target, allocate empty state, start the service graph in dependency order, and record resource IDs before reporting ready. Duplicate request IDs return the original operation/result. |
| Stop | Temporarily stop the instance's services in reverse order and verify termination. Retain its source binding, test users, data, seeds, caches and evidence for resumption; an idle agent or closed browser does not trigger stop. |
| Restart/rebuild | Preserve data, revalidate the recipe, reconcile or recreate owned services and report the new generation. Never restart Core or the installed app as a side effect. |
| Reset | Require an explicit empty/seed choice and expected revision; stop and verify all data consumers first, revoke grants, change data revision, and apply the fixture. Default leaves the app stopped; a subsequent start is explicit. |
| Finish sandbox / dispose | Revoke access first, stop/verify all owned consumers, then delete the test realm, credentials, temporary folders/volumes, caches, logs, evidence and owned app/relay/browser resources. Release networks, preview routes and port reservations. Keep only a minimal Core disposal receipt for audit/replay; release source references only after cleanup is proven. Never remove the worktree itself. |

Finish is an explicit lifecycle action available through the authorized Core API and client controls,
not a synonym for a process exit, completed browser job or ended agent turn. An automated run may
request disposal when its authorized workflow is finished; keep the sandbox available when an
operator preview is still expected. Finishing a sandbox group applies disposal to each of its
instances and reports partial cleanup rather than hiding a remaining instance.

If termination or deletion fails, access stays revoked and the instance remains `disposing` with
a failed/unknown operation and visible cleanup blockers. Retry the journaled operation after
reconciliation; report `disposed` only after all recorded owned resources are gone. Never silently
leave an active user realm or treat a successful Docker stop as complete cleanup. The disposal
receipt contains resource/request IDs, authorizing actor and outcome, not retained test accounts,
credential hashes, fixtures or raw evidence. Shared images and source resources are not disposable
instance resources. Close/remove managed browser contexts; revoke operator-browser grants and
retire the origin without claiming that Core can erase storage in an offline operator browser.

Serialize mutations per instance and coordinate input cleanup with allocation. Every undisposed
instance retains its worktree or artifact reference, including when stopped; users see the blocker
and dispose it before cleaning that input. Runtime/build/browser leases represent active consumers separately from
that persistent reference. On Core restart, reconcile exact Docker labels/IDs, ports, mounts and
generation before adoption. Unknown ownership or unreachable Docker retains blockers and reports
unknown; do not guess that a cancelled RPC, old lease or missing agent proves it is safe to delete.
Disabling an owner, revoking source authority or uninstalling/reinstalling the bound app removes
preview/control authority immediately and schedules an observed stop; preserve data and report any
stop failure rather than silently adopting the new installation.

Set CPU, memory, PID, writable scratch and startup/time limits at container creation, including
setup/build execution. The prototype's later `docker update` is not sufficient. Proposed Demo App
starting ceiling: 2 CPUs, 4 GiB and 512 PIDs for the app instance, apportioned across its services;
the agent has its own separate budget. Treat these as test defaults, not measured minimums or a
per-service allowance to multiply. Bound build concurrency and storage/log growth, report limit/OOM
failures, and record aggregate reservations before allowing simultaneous instances.

## Real Operators, Sandbox Users And Instance Authority

Use two explicit principal kinds under the same Core. A real Core user can authorize sandbox
management directly or through an app, and preview an authorized instance. A sandbox user is a
test identity owned by one instance, used
only to exercise that app's user-visible behavior. The second kind is the owner's 2026-10-13
alternative to a manually provisioned ordinary Core test account. It adds identity scope and SDK
work; a second Docker container or an extra field on a global administrator is not sufficient.

### Real Operator Access

Keep ordinary Core password sign-in and current account checks. The sandbox's real owner can preview;
the operator can explicitly add existing Core users as viewers. Other administrators use an
explicit audited administrative action. Preview membership grants no source inspection, lifecycle
control or Git authority. Real operator credentials remain outside the agent and browser runner.
Do not add a global user-selector login, default administrator/password or unauthenticated session
creation. An unguessable preview URL is a locator, not an access grant.

An operator's normal app preview carries their real identity, bound to the instance. Explicit
"Preview as sandbox user" may select a test persona through the same scoped launch mechanism as
the runner; record both the real authorizing actor and the simulated subject. It never impersonates
a real Core user or silently changes the operator's global session. Closing that preview does not
log out the operator from Core.

### Sandbox User Realm (D2, D3, D6)

Initially the realm is **one runtime instance**, not the whole workspace. Adjacent instances in the
same workspace do not share users, sessions or grants automatically. A multi-app shared test realm
would require a separately reviewed target set; it is not implicit in workspace membership.

The test directory is temporary instance-owned storage, not a permanent Core user catalog. Core
stores it, credential hashes and session records in its instance metadata area, outside app/agent
writable mounts, and removes them on Finish sandbox. Each test user has an opaque scoped ID, display fields,
enabled state, role/permission scenario, revision and fixture key. Fixture keys allow repeatable
seed data references without turning an ID/email collision into a global-account match. The app
gets a scoped directory projection; global Core user management never lists these as host users.
A fixture can combine test-user creation with synthetic business records referring to returned IDs.
Directory responses distinguish sandbox subjects from explicitly permitted real viewers and never
merge them by email; they expose no unrelated real users.

Core exposes bounded create/list/update/disable/delete APIs; Harness adapts them as tools. Use the
caller's reviewed
sandbox-management authority, instance ownership and request journal. Creation can select any
role scenario supported by the app, including an administrator, and future permission combinations.
No per-role escalation approval is needed inside an already authorized test realm. Unknown roles
or permission names do not invent application behavior; validate them against the app contract or
mark the scenario unsupported. Keep simulation claims extensible without building a general Core
user-permission system as a prerequisite.

Sandbox roles control the tested app only. The outer authorization ceiling is immutable: test
users have no Core administration, source/Git, provider, installed-app, other-instance or sandbox
lifecycle authority. Even a test permission named `*` or `core.admin` cannot enlarge that ceiling.
Every Core entry point that requires a real actor rejects a sandbox principal **before** checking
its role. Sandbox user-management APIs also require real-owner or properly delegated app authority; an app's
test administrator cannot grant itself host or instance-management rights.

Today `AppSessionValidationResult.HostRole`, SDK administrator checks and Demo App role bootstrap
use `host.admin`. Do not put that value into an unqualified host-role field for a synthetic user.
Add typed realm/target metadata and a scoped effective-role/permission resolver. App-local gates
can then test a sandbox administrator; host-management gates require a real Core principal.
Update Demo App/SDK call sites together, including directory and MCP paths. Older consumers that
cannot distinguish these contexts are unsupported rather than receiving a downgraded legacy token.

### Credentials, Login And Revocation

Bind every app/user credential to its principal kind, Core/app installation, runtime instance,
generation, data revision and subject revision. Use distinct token/session types and storage so a
sandbox token cannot be parsed as a global Core session or ordinary installed-app grant. Resolve
scope before roles; never fall back by app ID, email or a stripped token field. Service credentials
retain their separate app execution principal and do not acquire the test user's simulated rights.

Provide a Core-owned sandbox authentication endpoint/UI on a dedicated local auth origin, separate
from both global Core login and the app's origin. The relay maps it only to the selected instance's
realm. Reuse password hashing, rate limiting, one-use codes and PKCE, with sandbox-specific session
storage/cookies and exact callback origins. Sandbox login produces only an instance app grant; it
never sets a global Core session cookie. The regular Core login rejects sandbox credentials even
when the submitted email matches a real administrator.

The authorized coordinator can provision short-lived login credentials for a selected sandbox
user. The fixed browser bootstrap completes that realm's login/code-exchange flow; it does not
forge a global identity, skip app authorization or return a global session. The detailed runner
handoff below replaces operator test-password entry. Normal operator login and Shell embedding
still require their own real-Core browser acceptance; a successful sandbox login is not its proof.

Technical stop/restart retains test users and data while the sandbox exists; a generation change
requires fresh credentials. Disable/delete
or role/permission changes revoke affected sessions and increment the subject revision. Reset
revokes the realm's grants and restores its user/data fixture together under a new data revision.
Publish readiness only when both restore steps succeed, retaining recovery state on partial failure.
Finish/dispose revokes realm access immediately and deletes the realm as part of verified cleanup;
no disabled test-user archive is retained. IDs/grants from a previous reset are not revived
even when fixture keys are reused. Source HMR preserves the realm unless a fixture/policy changes.
While the sandbox exists, audit records identify the real authorizing owner, caller/authority and optional run/session,
instance and test subject, so test activity is not attributed to a nonexistent global administrator.
Finish deletes detailed sandbox artifacts; the minimal Core disposal receipt does not preserve
the temporary directory or affect real Core accounts.

## Operator Preview And Workspace UI

Give each instance a Core-resolved browser origin separate from the installed app and other
instances. Proposed local shape:
`http://s-<runtimeInstanceId>.d-<dataRevision>.i-<coreInstanceId>.hosty.localhost:<port>`.
Use a validated endpoint label as well when several public endpoints need distinct hosts. Core
allocates names and loopback ports; clients receive an authoritative Open result instead of
constructing a URL. No public DNS or per-instance Cloudflare operation is involved. Show a readable
app and caller/run name, optional workspace and a clear Sandbox marker; the URL's opaque ID is not the UI label.

Reserve the port while the instance exists; if restart finds a foreign listener, report a conflict
instead of reassigning silently. Ordinary restart/HMR retains the origin. Reset changes the data
revision and origin so cookies, local storage, IndexedDB and service workers cannot restore an old
fixture's client state; revoke the old origin's callbacks and grants. Disposed origins do not resolve
to another target. Validate Host/Origin, CORS, cookie scope, exact callback registration, HMR
WebSockets and the dev server's allowed-origin settings. A different port alone does not isolate
cookies. Browser origin, Docker transport and authentication must agree without exposing Core's
cookie or allowing sibling hosts to act as Core. Core-to-browser and container-to-Core addresses
remain separate concerns.

Provide a sandbox inventory independent of workspace discovery. Shell shows all authorized
instances, with optional workspace/caller/run grouping; Workspaces filters that projection for
its linked instances and exposes Open preview. Show app, caller and optional workspace, input revision or
dirty state, data mode, health, resource use, observation time and readiness failures. Put lifecycle
and log controls in Harness/Shell initially. Workspaces remains a read-only viewer with navigation
to those controls; its existing inspection permission does not acquire mutation authority.
An operator can inspect the current preview while the agent works, without receiving the agent's
credentials or starting another agent. Direct preview and Shell embedding both select the exact
instance; neither resolves back to the installed application's usual URL.

Local preview is the November demonstration gate. For a remote production host, evaluate a
preconfigured ingress namespace/proxy or an explicit private operator-access route before requiring
per-instance DNS/tunnel publication. Decide TLS/origin registration, login, routing, HMR, quotas,
expiration and cleanup before enabling it. No automatic public exposure or guaranteed Cloudflare
publication time is assumed. D11 owns this optional investigation and any approved resulting work.

## Core API And Client Flows (D2, D3, D6, D12)

Expose general sandbox routes backed by one Core service, independently of development sessions:

- Administrator routes: `/api/sandbox-instances`, with normal administrator session
  and CSRF for browser mutations.
- App routes: `/api/internal/apps/{callerAppId}/sandbox-instances`, with verified calling
  installation, reviewed sandbox permission and interactive user or explicit background authority.
  They require no assistant role, Harness session, workspace or worktree for artifact input.
- Harness session tools adapt these operations and validate their own session/app attachments.
  Optional session route wrappers must call the same service, not define a second lifecycle/API.
- App inspection uses a reviewed sandbox-read permission and instance access; workspace inspection
  is only a filtered integration. Viewer membership authorizes preview only, not the control inventory.

Permission names such as `apps.sandboxes.manage` and `apps.sandboxes.read` are proposed additions,
not current capabilities. Source preparation retains its existing grant; neither source permission
nor a session ID alone authorizes container creation. New rights require normal manifest permission
review and remain intersected with caller installation, target/input rights, owner and instance ACL.
Possessing `manage` does not expose another client's instances, enlarge quotas or grant source edits.
The agent receives only a session-bound Harness tool credential, never Harness's service
token, the operator's Core cookie, host paths to Core state or Docker control.

For unattended calls, extend [Continuous App Access](../continuous-app-access/feature.md) with a
closed `sandbox` scope. Existing `core` scopes cover a fixed set of installed-app actions; generic
APIs currently reject background credentials. Reusing an installed-app `start` grant or an app
service token alone would bypass that boundary. D2/D12 own the new sandbox-specific scope and dispatch.
Pin the real owner, consuming app installation, target installation, reviewed input/recipe set,
explicit allowed actions and resource ceilings. Bind creation to this authority and existing-instance
calls to the owned instance; no cross-app wildcard, role-name or run-ID shortcut. Source access
remains separately checked for worktree inputs. Use existing Core-owned grant review/revocation and
short-lived credential issuance; app credentials cannot create their own background authority.

Normal logout may leave an explicitly approved background grant usable under its existing policy;
expiry, revocation, disabled owner or replaced consuming/target installation denies new work and
triggers Core reconciliation of affected instances. Revoke access and stop verified consumers;
report failures and retain cleanup blockers. Core can finish disposal under its own cleanup authority
after client authority expires, without continuing tests or resurrecting the grant. A caller process
exit alone does not establish revocation or completion. Require explicit export/Finish in the run
contract; repeated runs remain subject to aggregate quotas and cannot orphan unlimited instances.

| Core operation / corresponding Harness tool | Inputs and result |
| --- | --- |
| Plan / `sandbox_plan` | Target app/installation, typed `sourceRef`, profile and synthetic-data/dependency/limit policy; optional workspace/session/job context. Return the normalized execution contract, review digest and blockers; no runtime is started. |
| Prepare / `sandbox_prepare` | Durable `requestId` and approved contract digest. Revalidate target/input/caller authority and review, allocate a stopped instance and return its ID/revision. Empty is the default data mode. |
| Seed / `sandbox_seed` | Instance ID, expected revision, bounded relative files and request ID. Stage a versioned synthetic fixture; return its revision without writing over running data. |
| Users / `sandbox_users_<operation>` | Instance ID, request ID and expected user/instance revision; create/list/update/disable/delete scoped test users and role/permission scenarios. Return scoped IDs and fixture references, never global-user mutations. |
| Start/restart/reset/stop/dispose / `sandbox_<operation>` | Instance ID, expected revision, request ID and operation-specific seed/rebuild options. Return a durable operation ID and observed progress. |
| List/status/logs / `sandbox_list`, `sandbox_status`, `sandbox_logs` | Only authorized instances; include bounded service logs, health, cleanup blockers and timestamped resource samples without secrets. |
| Open / `sandbox_preview` | Resolve an authorized exact-instance standalone/embedded destination and readiness. It returns navigation metadata, not reusable authentication in a URL. |
| Browser run/status/cancel / `sandbox_browser_<operation>` | Instance ID, expected generation/data revision, sandbox user ID and bounded declarative scenario. Authorize the caller's interactive/background authority and selected test persona; return job IDs and sanitized evidence, never credentials or a browser-debugging endpoint. |
| Evidence read/export | Instance/job ID and artifact ID under read/export authority; return bounded sanitized results for explicit caller storage before Finish. Never expose credentials or arbitrary host paths. |

Use a fingerprinted request journal as in managed workspace operations: same ID and arguments
recover the original outcome; changed arguments under the same ID fail. Core revalidates the acting
user, calling installation, owner and effective interactive/background grant on reads and mutation
dispatch. A timed-out request is unknown until the original operation is queried; clients must not
generate a new request ID and duplicate the instance. Bound logs/error outputs and redact
credentials. Persist associations/operation IDs so
client restarts resume observation rather than repeating creation. Scope replay IDs to the verified
caller/authority so one application cannot recover another application's result by guessing an ID.

Development sequence: attach app → prepare the existing Core worktree → plan/review the Docker
contract → prepare empty instance → optionally stage and apply a seed → start → wait for actual
readiness → return preview → edit and hot reload → record tests/browser evidence. Harness checks
that the app belongs to the session and the worktree belongs to its owner before forwarding;
Core independently validates supplied source/context and authority. The originating agent's idle
result releases its activity lease but does not release the instance's source reference or stop the preview.

Independent QA sequence: an authorized app selects a pinned version/recipe → plans and prepares
an instance without workspace/session IDs → creates test users and fixtures → starts and observes
readiness → runs checks or performance measurements → explicitly exports results → finishes the
sandbox. The next run gets new users/data and a new instance. It need not edit code, create a branch
or involve Harness. Record input/fixture digests, environment, limits and measurement method for
comparisons. Quotas and one-heavy-job admission apply across all clients, including background runs.
Actual scheduling, retry cadence and performance analysis belong to the caller, not Core sandbox APIs.

Container reachability for the session MCP endpoint, provider home, Git metadata and stop/recovery
belongs to [Containment D11-D13](../assistant-runtime-containment/plan.md). This feature adds sandbox
tools to that supported transport; replace experiment-specific bridging with the supported scoped
contract. Reuse existing approval/tool-policy checks, and surface denied or unsupported operations
without falling back to shell Docker commands.

## Execution Boundary

Containerized execution, instance-owned data/caches and explicit mount modes remain the baseline.
Do not supply unrelated app data, Core auth/run state or a Docker socket to the app or agent.
App and agent containers remain separate. Retain the existing non-root, resource-limit and owned
cleanup mechanisms; the owner revision does not require removing those working defaults.

The selected policy determines internet, provider, mount and Core API access. The verified offline
profile below retains its closed network and fixed relay. Internet-enabled and shared-provider
profiles under D13-D16 may reach approved external/shared services; they make narrower isolation
claims. Preserve caller identity when forwarding Core requests and check effective grants at Core.
Do not introduce a second authentication stack in the relay or silently change profiles when
required capabilities are unsupported. Test sinks/mocks are useful choices, not mandatory replacements
for every real integration. Real production app data remains separate from instance-owned data;
explicit shared-folder access has its own approved mode and cleanup ownership.

## Playwright And Evidence

Use Playwright as the first browser-runner candidate (the owner's spoken "playthrow" reference),
with a separate context, explicit real-Core authorization and access to the selected sandbox graph.
Run repeatable actions and assertions, inspect the resulting UI/backend state, and retain screenshots,
console/network failures and traces with pass/fail/unknown outcomes. Verify both direct operator
preview and Core/Shell embedding. Browser contexts separate browser state; they do not isolate the
backend or grant narrower Core permissions automatically.

Treat saved authentication state and traces as access-controlled artifacts; do not place credentials
in the agent's shared worktrees. See [Playwright authentication](https://playwright.dev/docs/auth).
Record the actual artifact digest or source state including dirty edits, environment/image and fixture revision.
For final reproducibility, freeze input or invalidate evidence after any change during hot reload.
A prior green test does not cover later source edits. Cancellation and interrupted runs remain
unknown/failed, and no test result authorizes commit, publication, merge or live-data runtime selection.

[Agent app evaluations](../agent-app-evaluations/plan.md) retains later exploratory multi-agent
comparison. Deterministic browser verification here does not wait for that feature.

## Deliverables

IDs D1-D6/D8-D9 retain their responsibilities with the explicit owner revisions above. D7
(production-derived snapshot import) is retired by the 2026-10-13 decision. New IDs begin at D10.
The owner approved the network/resource choices and sandbox-user design on 2026-10-13, including
the clarification that Finish deletes the realm and all owned temporary resources. This approval
sets the plan to Ready. The subsequent owner instruction makes this an independent Core capability
and adds D12 for non-Harness/background use. Implementation and verified local acceptance are
recorded below; unchecked items retain the remaining work.

- [x] D1. Bind independent Core sandbox instances to their verified owner/caller, target app and reviewed worktree or artifact input; integrate optional workspace context and observed state, preserve installed runtimes and bind evidence to exact inputs.
- [x] D2. Implement the reviewed execution-target model, instance identity/ownership, separate sandbox-user realms, real-operator and generic app authority, scoped background grants, routing and dependency resolution; include scope-first checks, grant/SDK compatibility and credential handoff.
- [x] D3. Implement Core-owned empty/synthetic user/data fixtures, bounded seed staging/application, per-instance caches, settings/environment and explicit test dependencies/mocks; prohibit production-data/credential inheritance.
- [x] D4. Reuse full Docker source development and verify the selected offline Demo App recipe, source/watch/HMR, root/nested cache separation, isolated networks, relay and Core-access boundaries on the selected support matrix; report unsupported recipes without host fallback.
- [ ] D5. Implement journaled concurrent creation, true readiness, stop/restart/reset and Finish/dispose that deletes all instance-owned test users and temporary resources; include creation-time CPU/RAM/PID limits, monitored disk quotas, admission budgets, crash reconciliation and verified cleanup without changing installed-app resources or deleting source.
- [x] D6. Expose independent authorized Core APIs and client/SDK contracts with replay/reconnect, test-user management, persona launch and evidence export; adapt Harness tools and workspace views, and show all authorized instances in Shell with optional context and lifecycle/resource/cleanup observations.
- [x] D8. Integrate the trusted Playwright runner with sandbox-realm login by selected test users, private expiring credential/grant handling, role/permission scenarios, source/fixture-bound sanitized evidence and truthful pass/fail/unknown outcomes; verify real-operator login separately.
- [ ] D9. Verify the acceptance cases below, document shipped guarantees in feature.md and reconcile dependent plans; keep any unfinished deliverables explicitly tracked.
- [x] D10. Implement and verify instance-specific local preview origins, real-user login, access controls, embedded/direct navigation and HMR; provide operator Open preview links.
- [ ] D11. Investigate optional remote operator preview without per-instance publication as a prerequisite; record the chosen ingress/private-access contract and implement/verify it only after explicit scope approval, or explicitly retire it if abandoned.
- [x] D12. Verify a Core-managed non-Harness app using interactive and explicitly authorized background access to run a complete QA lifecycle from a pinned Demo App artifact, without workspace/worktree/session allocation or code edits; cover cross-client denial, grant revocation, quotas, replay, exported results and complete disposal.

### Permission Extension (Owner Revision, 2026-10-14)

Earlier checked items retain their verified offline scope; the following IDs own the added behavior.

- [ ] D13. Add an internet-enabled sandbox profile and reusable operator consent using existing Core permission/review primitives; persist scoped policy, expose effective access/revocation, and avoid repeated prompts within an unchanged grant.
- [ ] D14. Resolve dependencies to dedicated instances within one sandbox environment and manage their grouped lifecycle with separate data/credentials; forbid implicit main-environment fallback. Keep optional shared installed providers explicitly deferred pending a concrete provider contract and renewed scope approval.
- [ ] D15. Bind declared sandbox mount slots to operator-approved shared-library entries, enforce read-only/read-write limits using existing Docker mount planning, and preserve external folders during reset/disposal.
- [ ] D16. Reuse ordinary user/service permissions for APIs inside a test Core and define owned child-environment creation through the independent sandbox API; retain parent accounting, explicit grants and cleanup without inventing sandbox-specific roles.
- [ ] D17. Verify internet/browser permissions, dedicated dependency instances, environment-scoped users and Core APIs, shared mounts and child lifecycles; document supported semantics, main-environment compatibility and cleanup, with shared installed-provider tests only when that deferred scope is approved.
- [x] D18. Isolate Core API state using a dedicated same-host Core process and fresh data root per environment; support release/source selection, normal users and permissions, independent local origins, and Core-plus-app development without mutating the primary installation.
- [x] D19. Track and dispose each test Core root and its owned processes, app containers, networks, caches and temporary data; stop writers before deletion, preserve borrowed source/shared mounts/exports, and verify crash/interrupted-cleanup recovery with a broken child Core.

### Same-Host Core Environments (Owner Decision, 2026-10-14)

D20 evidence: [review and measurement summary](../../reviews/2026-10-14-same-host-core-experiment.md).
The checked experiment records both passing checks and concrete limitations. The subsequent [manager acceptance](../../reviews/2026-10-14-child-core-manager.md) closes D18/D19/D21 on the selected local host.


- [x] D20. Run and document the approved shared-Docker, two-Core experiment with duplicate app IDs, independent users/data/origins, lifecycle and crash behavior, process/container memory, and owned-resource cleanup.
- [x] D21. Implement the parent Core environment registry, authorized create/list/status/stop/restart/Finish APIs, bounded graceful child shutdown, fallback cleanup and restart/crash reconciliation; integrate Harness and local operator preview while preserving the existing verified baseline.
- [x] D22. Verify a real model-driven Harness agent creating and setting up a child Core, changing Demo App in its reviewed worktree, installing and starting the Docker source runtime through ordinary Core approval, checking it in a browser, and finishing the environment with independently verified cleanup. Preserve sanitized evidence and fix regressions exposed by the run.
- [x] D23. Verify a real Harness agent editing both Core and Demo App in its session worktree, building a source-mode child Core from that project, consuming the changed Core API in Demo through normal browser authentication, running affected checks, and finishing with independently verified complete cleanup. Preserve sanitized evidence and repair any regressions exposed by the run.
- [x] D24. Integrate child Core environments into Workspaces and Shell: create/start from validated workspace worktrees with optional source Core selection, ordinary test-account setup, observed app status and authenticated preview links, replayable lifecycle controls and explicit complete Finish. Verify the real embedded browser journey, permission denial, source retention and cleanup, then document the shipped UI.

D23 evidence: [Core and Demo source acceptance](../../reviews/2026-10-14-core-source-agent-acceptance.md) verifies a real model building the changed child Core project and consuming its new API in Demo before full Finish cleanup.

### Remaining Acceptance After The 2026-10-14 Runtime Run

The [runtime acceptance summary](feature.md#integrations-and-verification-boundary) supersedes
the earlier API-only checkpoint for local runtime acceptance. Worktree/Harness
and independent artifact/background journeys both passed, including real Core password login,
scoped personas, HMR, private browser reports and complete instance disposal. Checked deliverables
are bounded to the selected macOS Docker Desktop/offline Demo App recipe. They do not claim a
production containerized-agent backend or a broader host/recipe support matrix.

- D5: complete the actual Docker-daemon loss/recovery and interruption-during-create/dispose matrix.
  Unit/fake-runtime tests cover ambiguous creation identities, unavailable cleanup, replay and
  revocation-before-delete; the real run covers abrupt Core loss with ready containers, configuration
  drift, worker death, OOM/PID/tmpfs/storage failure and disposal replay. Those are different cases.
  Connect the 2 GiB agent-state/8 GiB worktree monitor to an approved production worker coordinator.
  Core enforces its 20 GiB sandbox share; the experiment enforced the remaining 10 GiB independently.
  The production worker owner remains [Containment D11-D13](../assistant-runtime-containment/plan.md),
  whose Draft backend has not been authorized by the bounded experiment.
- D9: repeat the interrupted-operation cases above, capture separate host Core/Harness/browser costs
  during the same load window, and compose the Git/PR/CI/review journey once publication is explicitly
  authorized. This task creates no commits or PRs. Component tests and the two requested runtime
  journeys are recorded, but they do not close this broader cross-feature shipping checklist.
- D11: the remote proposal below is investigated but has no deployment approval or runtime evidence.
- D13-D17 remain open for reusable network/mount consent, dedicated dependency resolution,
  recursive resource accounting, and their combined acceptance. Ordinary internet connectivity and
  nested child creation are available through the trusted child Core, but are not substitutes for
  those policy and accounting deliverables. D18/D19/D21 are verified by the
  [manager acceptance](../../reviews/2026-10-14-child-core-manager.md): empty first-boot distribution,
  source/native launch, immutable local-image adoption, normal auth, Harness previews, parent
  reconciliation, worktree retention, failed-cleanup retry and broken-child/descendant Finish.
  Demo's writable log path and explicit healthchecks also pass. The separate
  [real-agent acceptance](../../reviews/2026-10-14-child-core-agent-acceptance.md) closes D22:
  a real Harness/Codex agent creates the child, approves installation in the browser, changes and
  tests Demo in its worktree, verifies authenticated preview/HMR, and finishes all child resources.
  It also verifies ordinary source runtime cache ownership, generated-file overlays and ports.


The owner-approved 20 GiB Docker Desktop setting is applied. The temporary 1 GiB Workspaces limit
is restored after the run. Main acceptance and independent QA each use isolated source Core data
roots; the operator's live Core remains unchanged. Temporary sandbox resources, agent container and
copied agent authentication are removed; source worktrees and explicitly exported reports remain.

### Optional Remote Preview Proposal (D11)

The proposed contract uses one operator-provisioned preview namespace and one fixed ingress into a
Core-owned dispatcher. Allocate a single-level opaque hostname per instance/data revision under that
namespace, route only registered live instances, and deny unknown/stale hosts. Require TLS, an exact
Core login callback allowlist, viewer authorization and WebSocket/HMR forwarding; Finish removes the
local route immediately. Cloudflare wildcard ingress matching and wildcard DNS provide relevant
primitives, but wildcard DNS alone does not establish certificate coverage or Hosty authorization.
See [tunnel configuration](https://developers.cloudflare.com/tunnel/features/locally-managed-tunnels/configuration-file/)
and [wildcard DNS](https://developers.cloudflare.com/dns/manage-dns-records/reference/wildcard-dns-records/).

This is a design proposal, not an assertion that the current local HTTP relay supports remote use.
A deployment must choose its DNS/TLS scope and operator access policy explicitly; a private access
route is an alternative when public namespace ownership is unavailable. Existing installed-app
Cloudflare publication must remain separate. No per-instance DNS readiness guarantee, automatic
public exposure, tunnel creation or remote implementation is included in this checkpoint.

## Implementation Sequence

Phases are implementation order within one feature/branch/PR, not separate feature releases or
duplicate deliverables. Check a D item only after its complete acceptance passes across the phases.

| Phase | Work and exit condition | Deliverables |
| --- | --- | --- |
| 1. Core model and authorization contract | First probe the approved network/relay boundary, then add an independent registry/API, worktree/artifact input resolution, reviewed-contract digest, caller/owner and interactive/background authorization, and journal contracts with denied/stale/replay cases. Installed-app behavior is unchanged. No unprotected instance is exposed while auth is incomplete. | D1, D2, D4, D5, D12 |
| 2. Docker lifecycle and storage | Implement isolated data/seeds/caches, naming/ports, graph dependencies, creation-time limits, readiness and recovery for worktree and pinned artifact inputs. Run installed Demo App plus two instances under one test Core; writes/reset/stop/dispose affect only their target. | D3-D5, D12 |
| 3. Real operators, sandbox users and local preview | Add typed realm principals/grants, SDK role resolution, directory/ACL checks and direct/embedded launch. Real operator/viewer access and sandbox administrator/member/denied scenarios pass without cross-realm authority, including fresh login followed by HMR. | D2, D3, D10 |
| 4. Client and operator surfaces | Add general client/SDK operations and a non-Harness QA client fixture; adapt Harness tools, workspace links, instance cards and Open preview. Integrate the contained-agent transport for the development journey without making it a Core API dependency. | D1, D3, D6, D12; Containment D11-D13 |
| 5. End-to-end acceptance and evidence | Verify agent edit → tests → hot reload → Playwright → operator preview and independent QA → export → dispose without source changes. Cover input/evidence staleness, lifecycles, background authority, resource budgets and the development journey's existing authorized PR flow. Update reality docs and dependent plans from results. | D4, D5, D8-D10, D12 |

The first four phases deliver the requested integrated local loop; phase 5 is required before
calling the feature verified. D11 is optional remote work and stays explicitly tracked until
approved and completed or explicitly abandoned. Its optional priority does not authorize deleting
it or declaring the whole plan complete. Feedback, redesign, per-session agent allocation and Core/
Harness self-hosted sandbox testing are not prerequisites. Existing owning plans retain their work.

Product changes follow artifact versioning: platform minor for the new Core contract; independent
Harness, SDK and changed runtime-app versions according to their actual changes, with manifest/
package versions kept in sync. The implementation bumps the affected artifact versions; see feature.md for the current contract. Do not create
commits, publish or merge merely because the implementation plan describes that eventual workflow.

## Approved Local Demo Profile

On 2026-10-13 the owner accepted the network and resource profile and then approved agent-managed
sandbox users and roles instead of a manually provisioned global test account. Users and temporary
resources survive technical stop/restart but are deleted on Finish sandbox. The owner authorized implementation; the plan is In Progress. Engine probes and
failure tests remain required verification. Docker VM reconfiguration still requires separate
coordination because existing applications use that daemon.

### Network: Offline App Instances And A Fixed Relay (D2, D4, D5)

This section specifies the verified offline profile only. The 2026-10-14 owner revision and
D13-D17 add separately granted connectivity; these restrictions are not universal sandbox rules.

Use a separate Docker bridge for each app instance, created with `--internal` and
`com.docker.network.bridge.gateway_mode_ipv4=isolated`; disable IPv6 for this first profile.
Only that instance's services and its Core-owned relay join it. The application has no external
network attachment, host-network mode, host-gateway mapping, default egress, raw-socket/network-admin
capabilities or Docker socket. Do not join the agent to this network. Cross-app dependencies require
explicit target routing, rather than joining every workspace app to one permissive bridge.

An ordinary internal bridge still has a host-facing address. Docker documents that the `isolated`
gateway mode removes it; this is why `internal` alone is insufficient for the chosen boundary.
See [Docker gateway modes](https://docs.docker.com/engine/network/port-publishing/#gateway-modes).
Verify raw IP, DNS, IPv6 and Docker Desktop host aliases in the implementation probe; unsupported
behavior refuses startup rather than switching to a normal internet-connected bridge.

One small trusted relay per instance is the only component attached to both its isolated network
and an outer transport network. It runs pinned Core-owned code/configuration, non-root, without
source mounts, Docker access or administrator credentials. Disable IP forwarding in its network
namespace, drop capabilities and enable no-new-privileges. It forwards application traffic, never
acts as a router or an unrestricted HTTP/CONNECT proxy. This adds infrastructure containers; the
agent and application remain separate execution containers.

The relay has separate listeners with fixed destinations:

- **App → Core:** only method/path pairs for instance code exchange, revalidation and its typed
  sandbox/authorized-viewer directory. Preserve the instance's service credential; never substitute a stronger
  relay credential. Deny installed-app lifecycle, secret/delegation/admin routes and other targets.
- **Operator → preview:** publish only the relay's preview listener on `127.0.0.1`. Forward HTTP and
  the selected app's HMR WebSocket to recorded service endpoints, checking the registered Host and
  Origin. Do not publish app/database ports directly. Core probes this same route for readiness.
- **Browser runner → selected origins:** a separate internal test network/listener permits the
  selected preview and its Core-owned sandbox auth origin/login/PKCE pages/assets. Ordinary real
  operator acceptance separately permits the real Core and exact Shell origins/required paths;
  a test persona gains no Shell or global Core session. Keep the listener inaccessible from the app network. Preserve
  the actual browser origins through a fixed upstream proxy mapping, so real Core cookie/origin
  checks still run; configure Chromium's managed-localhost proxy routing explicitly and verify it
  rather than assuming loopback names traverse the proxy. Reject all other destinations, redirects,
  CONNECT requests and path escapes.

The first profile uses local HTTP managed origins, so it needs no general TLS interception or
generic HTTPS tunnel. Inspect the registered target and normalized route on every hop; model-supplied
URLs, Host headers or request bodies cannot select another upstream. Deny external DNS forwarding
from workload networks. Browser interception can add diagnostics but is not the network boundary.
The normal operator browser is outside this container boundary; local preview does not sandbox
the operator's entire browsing session. Validate app CSP/origin behavior separately.

Keep dependency installation out of the live network path. Before the demo, the operator prepares
one reviewed, digest-pinned Demo App environment/dependency image for the selected lockfile and
toolchain. Initial acquisition of trusted images/bundles is an explicit preparation operation, not
an agent-controlled online install or evidence of sandbox isolation. All agent-edited source builds,
setup and runtime commands in the protected app profile then use the prepared dependencies offline;
build steps use network disabled. No online package lifecycle scripts run on unreviewed worktree
changes. A new dependency/lockfile, remote font or missing artifact produces `dependencies_not_prepared`
and requires a refreshed reviewed bundle; it never opens internet access automatically. D4 records
online package acquisition as unsupported in this profile rather than implementing a package proxy
as a demo prerequisite.

The agent still needs its provider connection and the scoped Harness endpoint. Their independently
enforced transport is owned by Containment D12, and receives no route through the app relay. This
profile does not claim that offline app networking proves provider/agent egress confinement.

### Playwright: Scoped Test Personas, Trusted Runner, Short Jobs (D2, D8, D10)

An authorized caller creates a small synthetic user fixture through Core (via Harness for agents),
for example an administrator, an ordinary member and a read-only/disabled account. For each browser scenario it supplies only
the target instance and sandbox user ID. Core verifies the calling app, real owner's current rights
and interactive or explicitly scoped background authority
before a trusted coordinator provisions a short-lived sandbox login credential for that subject.
An arbitrary role label, subject ID or app token cannot authorize this management step.

There is no operator-entered test password or global test-account setup in the default path.
Keep the generated credential in coordinator memory only until login or job expiry, at most
**10 minutes**, and invalidate it after the initial login. Send it only over the runner's private
control channel; never include it in transcripts, source, container arguments or shared mounts.
Use a login credential separate from the user's stable identity, so provisioning a job does not
silently reset the password or sessions of another preview. Each job gets a fresh browser context
and completes the instance's sandbox login plus PKCE/app code exchange. All resultant sessions are
sandbox-scoped. These are real persisted test identities within their realm, not fabricated global
Core users or caller-supplied unverified identity headers.

Real operator preview retains normal Core password login and explicit instance access. Verify it
separately, including embedding: the outer Shell uses the real operator session; the inner sandbox
app may use an explicitly selected test persona without passing that identity back as Shell's user.
An independent sandbox-login result never counts as proof that ordinary Core sign-in works.

Run a pinned Playwright/Chromium worker in its own restricted container, attached only to the
isolated browser-test network, with Chromium's own sandbox enabled. Core's trusted coordinator
controls it through a private channel, such as managed container stdio; clients and agents receive
no Docker or browser-debugging port. Use a bounded declarative
action API (navigate within the selected target, locate/click/fill, assert, screenshot), not arbitrary
agent-supplied Node.js/host shell code. The application can run page JavaScript normally, but agent
actions cannot inspect the login context, export cookies/storage, read local files or navigate Core
administration. Restrict downloads/uploads, new windows and target-changing redirects explicitly.

Keep login and authorization recording off. After the trusted routine completes, expose only
app-page actions and sanitized results. Browser state stays inside the private worker and is
destroyed at job end; never export `storageState` into a worktree. Revoke the job's sandbox session
and app grants on completion/failure, and always on reset/dispose/generation change, subject update
or owner/viewer revocation.
Cap the job grant at **10 minutes** and the job itself at **5 minutes**; expiration must be enforced
server-side even if the worker disappears. Retry requires a newly authorized job and credential,
not reuse of the operator's browser session.

Record screenshots, assertions and bounded/redacted console/network summaries. Raw traces, when
enabled after login, remain operator-only access-controlled artifacts; do not give their cookies,
headers or callback URLs to the agent. Playwright notes that saved auth state can impersonate its
account: [authentication guidance](https://playwright.dev/docs/auth). Disable service workers for
the first deterministic runner recipe; route interception alone can miss their traffic
([network guidance](https://playwright.dev/docs/network#missing-network-events-and-service-workers)).
Manual reset/storage and ordinary browser acceptance still cover the actual app behavior.

### Concrete Local Limits And Retention (D3, D5, D8)

These are conservative initial ceilings, not measured minimums. CPU/memory/PID limits apply at
creation; do not disable the OOM killer. Set memory-plus-swap equal to memory to avoid unbounded
swap use ([Docker resource limits](https://docs.docker.com/engine/containers/resource_constraints/)).
Distribute the app budget across all of its services; never multiply it by the service count.

| Resource | Default limit |
| --- | --- |
| Shared agent and its build/test descendants | 2 CPUs, 4 GiB RAM, 512 PIDs; coordinated with Containment D11-D13 |
| One app instance, all services/setup combined | 2 CPUs, 4 GiB RAM, 512 PIDs |
| One Playwright worker | 1 CPU, 1.5 GiB RAM, 256 PIDs; one job at a time |
| One trusted relay | 0.25 CPU, 256 MiB RAM, 64 PIDs |
| Writable scratch | App/agent 256 MiB each, browser 512 MiB including shared memory, relay 32 MiB; within their RAM ceilings |
| Concurrency | One active agent, one build/test job, one browser job; default one running app instance, configurable maximum two for coexistence acceptance; no queue |
| Timers | HTTP readiness 120 seconds after setup; setup/build/test command 10 minutes; browser action 30 seconds, browser job 5 minutes; stop grace 10 seconds then verified termination |
| Synthetic data / seed staging | 512 MiB data and 32 MiB seeds per instance; seed upload at most 1 MiB per file and 1,000 files, subject to the smaller total |
| Test identities | At most 50 users per instance, 100 role/permission entries per user and 16 KiB per user record; one active automated persona/job by default |
| App dependency/build caches | 4 GiB total per instance across root/nested caches and retained recipe namespaces |
| Agent writable data / prepared worktrees | 2 GiB agent state and 8 GiB total worktree outputs; retain source on refusal, no automatic source cleanup |
| Container stdout/stderr | Docker local log rotation: 10 MiB × 3 files per container, including helpers |
| Verification artifacts | 100 MiB per run, 250 MiB per instance; at most three retained runs; refuse new capture until explicit cleanup if full |
| Retained instances / managed mutable storage | At most five undisposed instances; 30 GiB total across these sandbox/agent data, caches, worktree outputs and evidence |

Before the approved reconfiguration, Docker reported **8,214,323,200 bytes (about 7.65 GiB)**
on this host (2026-10-13). The 2026-10-14 runtime run uses engine 29.8.2 and
**20,939,583,488 bytes**, after the owner-approved 20 GiB Docker Desktop setting. The one-instance app/agent/browser/relay ceilings sum to **9.75 GiB** before VM headroom and
existing workloads. With two apps, one agent, one browser, two relays, a 1 GiB Workspaces ceiling
and 2 GiB headroom, the reservation is **17 GiB** (8 + 4 + 1.5 + 0.5 + 1 + 2). The previous
16 GiB recommendation omitted that overlap. The corrected **20 GiB Docker VM RAM** setting is approved and applied. Retain at least 2 GiB VM headroom beyond all reservations.
Count a running bounded agent once: its actual container ceiling replaces the pending agent
reservation in the trusted runtime policy. Include every existing workload and active browser;
sandbox ownership labels do not make browser memory part of the app's 4 GiB ceiling.
Independent QA without an agent reserves only its actual app/relay/browser components; all clients
still share the same host admission budget and concurrency ceiling.
The owner approved the corrected 20 GiB setting and temporary Workspaces limit on 2026-10-14;
the resulting engine budget is recorded above. If capacity
is insufficient, return `resource_budget_exceeded` with the needed budget; never start and hope
all processes stay at their earlier idle values. Raising Docker Desktop's VM setting/restarting it
must be coordinated separately with the operator's running applications.

Memory/PID/tmpfs limits and bounded seed/evidence ingestion are enforced limits. Persistent data,
bind mounts and ordinary named-volume sizes are **monitored soft quotas** in this minimal macOS
profile: measure every 5 seconds, warn at 80%, stop the responsible writer/job at the threshold and
report `storage_budget_exceeded`. Overshoot between samples is possible; this is not protection
against a deliberately disk-filling workload. Do not imply `--storage-opt size` limits host bind
mounts or all named volumes; Docker's container-filesystem support is storage-driver dependent
([run reference](https://docs.docker.com/reference/cli/docker/container/run/#storage-opt)).
Require at least 20 GiB free on the host data filesystem and Docker VM disk before admitting work;
pause new work and stop demo-owned writers below 10 GiB. If capacity cannot be observed, refuse
admission. Shared image layers/daemon build cache and pre-existing Git repositories are outside the
30 GiB mutable-data total, so monitor their containing disks too; never run a global prune.

No automatic age-based stop or deletion. Technical stop preserves test users and preview state;
reset explicitly replaces the selected user/data fixture. Finish/dispose performs complete owned
resource cleanup, including users, seed staging, data, caches, logs and raw or redacted evidence.
Do not require a second operator cleanup action to remove those resources. A report survives only
if explicitly exported before finishing; Core retains only the minimal audit/replay disposal receipt.
Rotation may discard older console log chunks as declared above, but neither a full quota nor an
expired agent session means the sandbox is finished or deletes source, fixtures or test results.
Soft disk quotas are an explicit local-demo limitation recorded under D5. Unattended workloads
requiring hard protection from disk exhaustion are outside this profile's supported guarantees.

### First Recipe And Approval Boundary

Select Demo App on local macOS/Docker Desktop with its backend/frontend service graph and prepared
Linux dependencies, plus a pinned artifact of that app for the independent QA acceptance. Define
an additive `hosty-sandbox-v1` capability covering instance/realm identity,
scoped role/permission resolution, auth, origins and directory behavior; update the TypeScript SDK
and Demo App together.
Keep the manifest schema version unchanged. Freeze the reviewed recipe, lockfile and toolchain
digest, declare root/nested writable output overlays, and prepare required generated type metadata
through the trusted fixture setup. Unsupported apps/SDKs receive an explicit compatibility error.

The network/resource choices and temporary sandbox identities are approved. The first implementation
gate proves isolated-network denial, the relay's
allowed Core/preview paths, sandbox-user login, real-operator login and creation-time limits on the
actual engine. If a gate fails, preserve
the failure and revise the design before claiming support; no permissive fallback is authorized.
Other hosts/recipes, hard persistent-volume quotas and a general package proxy are unsupported in
this profile; D4/D5 must document those limits. An expansion requires a reviewed profile rather than
an implicit fallback. Remote preview remains optional D11 with its separate scope approval.
The owner approved this contract and authorized implementation on 2026-10-13. Verification remains required before any deliverable is complete.

## Verification Before Shipping

- From a Core-managed app with no assistant role, allocate and run a pinned Demo App artifact using
  the general API without workspace/worktree/session IDs or hidden allocations. Create personas/data,
  run a browser check, export a result and Finish. Verify Shell preview and inventory still work.
- Repeat under an explicit background sandbox grant after the interactive browser is closed/logged
  out. Deny service-token-only calls, old installed-app lifecycle scopes, revoked/expired grants,
  unapproved targets/recipes and replaced caller installations. Another app with sandbox permission
  cannot read/control this instance or replay its operation IDs. Aggregate admission spans clients.
- Run the worktree adapter through the same lifecycle and verify source authorization/consumer
  protection. Omitting or forging workspace context cannot authorize an otherwise inaccessible source.
- Start the installed app plus two workspace instances of it. Empty data shows a fresh install;
  synthetic seeds produce the intended state. Writes/reset/dispose in one leave the others unchanged.
- Stop/restart preserves test users and fixtures. Finish deletes every recorded realm/session,
  credential, owned folder/volume/cache, seed staging area, log/evidence artifact, container,
  managed browser context, network and preview binding; source edits, real users and other instances
  remain intact. A later sandbox starts fresh and cannot reuse previous identities or grants.
  Verify an explicitly exported report survives without retaining a sandbox archive by default.
- Interrupt disposal during termination and deletion. Access must already be revoked, cleanup
  blockers remain visible, and retry/recovery uses the original operation ID without reporting
  `disposed` prematurely. Finishing a browser job or agent turn alone must not remove an operator preview.
- Demonstrate source edit → reload → operator preview and Playwright assertions; change dependencies
  and exercise the reviewed rebuild. Old evidence is stale after any source/fixture change.
- Repeat app startup after agent installs/tests have populated root and nested dependency caches;
  app setup must not write/delete the agent's outputs through a shared source mount. Validate port
  agreement, required generated framework metadata and actual HTTP readiness, not lifecycle status alone.
- Sign in through the real Core; test authorized and denied viewers, revoked accounts/access,
  iframe/direct links, callbacks, stale URLs and cross-instance/production token reuse.
- Check fresh login → HMR → navigation: consumed authorization callback code/state must remain
  removed from the URL. The two-container fixture observed callback parameters resurfacing after
  its first hot reload; the later cookie-authenticated repeat is not proof that this case is fixed.
- Probe mount/path/symlink escape, production dependency fallback, external effects and forbidden
  Core endpoints; inspect actual effects rather than trusting an agent's textual refusal.
- Before the integrated run, probe the actual isolated network: deny direct internet/IP/DNS/IPv6,
  bridge/host aliases, controlled host-service canaries, other instances and the agent; allow only
  the intended services and fixed relay paths. Verify no relay packet forwarding, open CONNECT,
  encoded-path/Host/redirect bypass or cross-listener access. Verify local HTTP/HMR and the browser's
  Core origin through the relay, including proxy bypass handling and Shell embedding.
- Create administrator/member/read-only/disabled personas through Harness, seed business records
  with their scoped IDs and log in through the sandbox realm. Verify app-level roles/permissions
  and that even the administrator cannot control Core, workspaces, providers, the installed app or
  another sandbox. Use duplicate real/test emails and deliberate ID/token-type collisions; no
  fallback to the global directory is allowed. Test unknown role/permission handling explicitly.
- Verify job expiry, subject/role revocation, reset/dispose and worker death; stale user IDs and
  grants must not revive after fixture restoration. Check that the agent cannot export credentials,
  control a browser debugging port or execute arbitrary runner code. Verify saved evidence excludes
  login secrets. Ordinary Core operator login and real-user allowed/denied preview are separate cases.
- Exercise admission failure with the current VM budget, hard memory/PID/tmpfs failures, seed and
  artifact ingestion limits, log rotation and soft storage thresholds. Record overshoot and stop
  latency honestly; preserve source/data and require explicit cleanup before resumption.
- Test build/start/cleanup failure, memory limits, detached work, Core recovery and active-consumer
  retention. A stopped browser tab or cancelled RPC does not establish released resources.
- Repeat prepare/start/reset after a lost response with the same request ID; refuse changed input,
  stale revision, stale installation, foreign workspace and changed execution-contract digests.
  Race prepare against source cleanup and two starts against port reservations; preserve resources
  with unknown ownership. Verify stop after owner/source revocation and recovery after Docker failure.
- Stop the agent while the app remains available, then stop the app while the agent can still use
  its workspace. Keep a preview through Harness/Core restart with verified adoption, and deny old
  generation credentials after replacement. Reset changes browser storage origin; no production
  cookie, service token, directory grant or delegated/MCP identity works by app ID alone.
- Inspect Docker mounts/labels/limits at creation, not only after startup. Test memory/PID exhaustion,
  failed setup, nested-cache collisions and bounded disk/log growth. Record cold image/build/setup
  separately from warm start-to-HTTP-ready, source edit-to-HMR and observed browser update time.
- Sample agent and all app service containers during idle, dependency setup, edit/HMR, tests,
  production build and browser checks. Report working set and cgroup peak separately, with sampling
  interval and OOM counters; report simultaneous aggregate samples rather than summing lifetime
  peaks. Measure Harness/Core/browser host cost separately and avoid double-counting the Docker VM.
  The experiment's roughly 594 MiB idle per container and 1.63 GiB corrected app cgroup peak are
  fixture observations, not capacity guarantees or general launch limits.
- Complete an authorized Git/PR/CI/review journey using existing owners; preserve source and any
  explicitly exported report, while Finish still removes the sandbox's own temporary artifacts.
  Verify that sandbox testing never starts a live-data trial automatically.
- This document describes intended product behavior. The dated bounded experiment is evidence for
  its fixture only; run affected builds/tests and full real Core/Shell acceptance during implementation.

Implementation verification includes `npm run core:build`, `npm run core:test`, SDK build/tests,
Harness lint/tests/web build, and lint/tests/builds for changed Demo App, Workspaces and Shell code.
Run CLI checks if its contract changes, plus `node scripts/check-versions.mjs` and docs validation.
Use a separate test Core data root with normal setup/password login and a genuine installed-app
baseline. Never restart the operator's Core merely to execute these tests. The implementation requires the affected product builds/tests, index/link validation and
`git diff --check`; the independent API probe does not replace Docker/browser acceptance.

## References

- [Docker Development](../mixed-development-runtimes/feature.md) and [remaining acceptance](../mixed-development-runtimes/plan.md).
- [Local Browser Origins](../local-browser-origins/feature.md) and [Cloudflare ingress](../cloudflare-ingress/feature.md).
- [Docker Engine security](https://docs.docker.com/engine/security/).
- [Playwright isolation](https://playwright.dev/docs/browser-contexts) and [traces](https://playwright.dev/docs/trace-viewer).

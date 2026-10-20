---
status: In Progress
created: 2026-09-25
updated: 2026-10-20
summary: Remaining host and recipe acceptance plus optional remote preview after verified local release, cold-engine and agent workflows.
components: [apps/core, apps/harness, apps/shell, packages/app-sdk]
---

# Independent Sandbox Instances In Core

## Current Baseline And Approved Next Step

PR #590 merged on 2026-10-14 at `eb9768017de3ec3cfb037c1d6c5e23b4ce13c8aa`.
[feature.md](feature.md) describes the shipped APIs, their verification and limits.
This plan separates remaining work from the earlier design iterations; it does not reopen
the implemented child Core manager, user model, Harness tools or Shell/Harness controls.

The owner now authorizes the Media Server plus dedicated Transcode Engine scenario, through
Harness and a normal authenticated browser, including resource measurements and complete
test-environment cleanup. The chosen external input is `/Users/haas/dev-media`, read-only.
No production app data, credentials or provider connections are inherited. This instruction
approved the bounded D25 milestone below; its read-only Media implementation and repeat acceptance
are complete. The owner separately authorized PRs for the Media implementation, this plan/report
and the linked Transcode Engine recovery fix. Remote deployment and changes to the operator's
primary Core installation are outside that publication request.

## Approved Continuation (2026-10-15)

PR #594 merged at `c5d37752356b3a2713a9a89435bb21ca060591c3`, completing D26.
The owner approved continuing the following sequence on 2026-10-15:

1. Verify the published artifacts and reproduce D9's fresh password login, source edit, HMR,
   navigation and preview journey through Harness and Shell, then Finish with independent cleanup.
2. Implement D13/D15's one-run or saved consent, reviewed target/caller scope, effective access,
   expansion review and revocation using the existing permission and mount mechanisms.
3. Complete D14/D16/D17's dedicated dependencies, ordinary user/service authority and owned nested
   lifecycle, including a separate database provider and no implicit primary-environment fallback.
4. Complete the remaining D5/D9 local fault and supported-host acceptance where a real isolated
   target is available. Record unavailable host cases explicitly; unit tests do not establish them.

Use a fresh registered workspace from merged main and separate test Core data roots. Retain the
operator's primary Core version, source and data. Keep raw logs and evidence outside Git.
The owner selected macOS plus Linux in Docker for this continuation; no Windows test host is
available. Keep native Windows acceptance explicitly unverified.
Remote preview D11 remains deferred. The production agent backend remains separately owned by
[Shared Docker Agent Runtime](../assistant-shared-docker-runtime/feature.md); the 2026-10-15 acceptance uses its supported shared worker. Its implementation and local
verification are complete; it does not approve the stricter per-session containment scope.

## Approved D9 Integrated Run (2026-10-15)

The original integrated run authorized a real Harness Docker agent to edit Demo in a Core-owned
worktree, create a child Core, verify separate application containers in the browser and publish
a test PR through Core with CI/review. It used Core 0.135.0, Harness/worker 0.53.0 and Demo 0.17.1
at `b996226e2c1574d6a34f0c0743147d54a3d98844`, preserving the primary Core. It also covered
recovery, simultaneous resources and Finish. The later owner-authorized merge/publications are
recorded below; this historical authorization is not a standing grant for new publication.

The source-build run reproduced hidden user-installed Docker CLI plugins in the child private HOME
and a legacy-builder refusal of `COPY --chmod`. PR #599 ships the scoped discovery correction,
preserves parent credential privacy and retains child-owned Docker settings with owner-only modes.
The released correction is reverified by D27.

## Approved Local D9 Closure (2026-10-15)

PR #599 merged at `70133a4dbcd4d3b91c3d46693c797162238b3d54`. Core/CLI 0.135.1 and
Demo App 0.17.2 are published; Harness/worker remains 0.53.0. The owner now approves
closing the local acceptance portion: reconcile inherited checks against exact tests and
reports, execute uncovered local cases, measure a controlled cold preparation and warm
repeat through Harness and a real browser, and independently verify complete disposal.

D27 passed in the [local acceptance report](../../reviews/2026-10-15-sandbox-d9-local-acceptance.md),
including the exact test ledger and measurement boundaries. D28 below closes the cold-engine image
import/extraction and uncached build/start measurement gap. D9 retains additional host/architecture/recipe
scope; macOS arm64 and Linux in Docker do not establish native Linux/Windows or amd64-worker
support. D11 remote preview remains deferred. The two execution profiles keep separate
expectations: offline sandbox network/persona restrictions do not apply to trusted child Core.

Use a separate registered coordinator worktree and fresh test data/credential/cache roots.
Keep raw JSON, credentials and logs outside Git. Preserve the primary Core and other workloads.
Measure downloaded release artifacts, image preparation, dependency setup, HTTP readiness,
HMR and warm restart as distinct intervals. Capture native preparation descendants from the
start; distinguish fresh fixture/build caches from an already-running Docker VM and shared
image layers. Do not prune shared Docker resources to manufacture a cold result.

## Approved Cold-Engine Acceptance (2026-10-15)

The owner approves a disposable Docker engine with its own empty image/build/data store,
complete Harness agent and browser acceptance, separate cold/warm timing and resource accounting,
and full fixture teardown. Existing Docker containers, caches and configuration remain untouched.
A bounded Linux container hosts the independent daemon, released Linux arm64 Core, Harness and
browser; it does not establish native Linux-host or Windows support. Record transfer/unpack,
uncached dependency/build, HTTP readiness, browser, warm replay and cleanup as distinct stages.
Keep wider D9 platform/recipe acceptance and optional D11 open. No commit or publication is part
of this experiment request.

D28 passed in the [cold-engine acceptance report](../../reviews/2026-10-15-sandbox-d9-cold-engine-acceptance.md): real
Harness agent, normal browser login/HMR, uncached image preparation, cold/warm readiness, enclosing
engine/build/native memory and complete disposal. All existing Docker inventory and primary Core
process identity were preserved. This closes the local cold-engine gap, not the wider D9 matrix.

## Latest Verified Checkpoint (2026-10-15)

The [fresh-login/HMR report](../../reviews/2026-10-15-sandbox-login-hmr-acceptance.md) records the
published release check, reproduced callback regression, SDK fix, fresh embedded/direct browser
repeats, container measurements and complete child/fixture cleanup. Native Harness peak capture
was incomplete in that run; native Linux-host and Windows execution were not tested. The subsequent
[D9 Git acceptance](../../reviews/2026-10-15-sandbox-d9-git-acceptance.md) verifies the composed real-agent
Git/PR/CI/review journey, independent Finish and simultaneous one-workload Core/Harness/browser
measurements. It also corrects child Buildx discovery and private Docker-config replacement. D9 stays
unchecked for the remaining items below; the report distinguishes released artifacts from the fix candidate.

The owner confirmed on 2026-10-15 that reusable consent authorizes a **trusted child Core as a
whole**, for the initiating installation and selected launch mode/target. Its administrator keeps
ordinary Core rights. Installation and shared-mount review inside the child reuse normal Core
mechanisms; the parent does not impose another per-app, network or mount permission layer.

D13 reuses the existing Core confirmation page and revocable background-grant store. One-run
consent binds the exact creation request; saved consent pins caller installation, owner authorization,
mode, launch target and resource ceilings. Source consent trusts ordinary edits within the selected
Core worktree/project, not a particular commit. A different project/worktree or prepared binary,
changed trust contract or increased ceiling needs review. A technical restart does not.

The real Harness/browser pass verifies one-run retirement, saved autonomous creation, ordinary
child login, live UI revocation and same-ID consent renewal after a changed Core build. Focused
HTTP tests additionally cover account/installation revisions, changed contracts/projects and ceilings.

Revocation blocks new delegated creation, start/restart, setup and child API transport. It does not
retract credentials already issued by a trusted child or automatically stop its processes. The
operator can still inspect, Stop and Finish; the UI must explain this distinction. This is the
chosen trusted-process boundary, not a claim of containment against modified Core code.

## Approved Recovery And Aggregate Budget Work (2026-10-14)

After merging Engine #50, Media #338 and docker-host #593, the owner authorizes a fresh
Harness/browser acceptance of published Media 0.92.0 and Engine 0.14.0, followed by D5's
Docker failure/interrupted Finish recovery and D16's aggregate environment budgets.
Use a separate coordinator Core and `/Users/haas/dev-media` read-only. Keep source and
external folders outside owned cleanup. No primary Core upgrade or automatic live-data
switch is part of this work.

The acceptance must distinguish restart adoption from creation of duplicate resources,
retain the original operation ID after a lost response or interruption, expose incomplete
cleanup, and independently verify all owned processes, ports, containers, networks, volumes
and temporary roots are removed after Finish succeeds. Quotas must apply before runtime
creation and cover sibling/nested environments rather than multiplying a budget per service;
measure enforcement and preserve explicit soft-disk and host-process limitations.
The existing broad D5/D16 items stay open until their own required checks pass. D9 retains
its unrelated login/HMR and cross-platform cases; this release recheck does not close them.

## Environment Scope (Later Owner Discussion, 2026-10-14)

Two existing execution modes must not be conflated:

- The original single-app `/api/sandbox-instances` runtime has the verified offline Demo recipe,
  private relay/browser, sandbox personas and its own resource policy.
- `/api/core-environments` manages a trusted child Core on the same machine and Docker daemon.
  Its fresh data root owns normal users, connections, app instances and caches. Internet and
  ordinary Core APIs already work here. Modified child Core code is trusted under the owner's
  shared-Docker model; introducing a VM, Docker broker or token-namespaced Core is not a prerequisite.

Continue useful multi-app testing with the child Core. D13 tracks reusable operator policy,
not adding internet connectivity that this mode already has. D16 retains aggregate resource
accounting and permission acceptance; nested creation and the root-wide two-descendant count
limit already exist. Count limits are not CPU/RAM/disk quotas.

## Approved Consent Policy Requirements (D13)

Reuse Core-owned permission review, revocable grants, existing dependency declarations and the
shared-mount library. Extend them with an execution target and an explicit sandbox policy; avoid a
parallel identity system, generic policy language or a service-mesh project. A manifest/request
states what an app needs and an optional explanation; it cannot grant that access to itself.

An operator can approve one run or save a policy for a defined app/caller scope. Matching later
runs proceed autonomously. Prompt for a requested expansion beyond the saved policy, not each
restart or ordinary source edit. Reuse mandatory revision/digest checks when executable contracts
or targets materially change; saved consent does not silently authorize a changed provider or
contract. Report effective access and revocation in the existing instance view. User roles inside
the sandbox and permissions of its running service remain separate: a test user's `admin` role
is not a grant of authority over the parent Core.

Keep the existing offline single-app profile available separately. Trusted child Core consent
explicitly includes ordinary outbound networking for child apps, builds and browser checks; it
is not a new internet permission or a promise to filter public origins. Ordinary endpoint
authentication still applies.
Shared mounts require an explicit registered-folder binding and enforced access mode; read-write
is a separate expansion beyond read-only. Dedicated dependency installations remain the selected
D14 scope; shared installed providers require renewed approval of a concrete provider contract.
Consent never implies access to installed-app data or copied production credentials.

Verify one-run versus saved choices, isolation between app/caller scopes, autonomous matching runs,
requested expansions, target/contract revision revalidation, effective-access display and revocation.
Technical restart and ordinary source edits within the reviewed contract must not repeatedly prompt.

## Proposed Core Integration Contract

The independent APIs are already delivered; clients do not require a workspace or an agent session.
Workspace/worktree bindings retain borrowed source until Finish. Harness and Shell
use the same Core lifecycle. A fresh child is empty: attaching worktrees does not install apps.
Reuse normal child installation review, dependency discovery and shared-mount registration for
the next scenario. Add narrowly scoped fixes only when the runtime check demonstrates a gap.

## Real Operators, Sandbox Users And Instance Authority

Child Core uses ordinary password setup/login, users, roles, service credentials and app review
in its own stores. Never copy the parent's users, service tokens, Git connections or browser
cookies. Browser evidence must use normal login; test-only identity injection is not acceptance.
Stop/restart preserves test state; Finish removes owned temporary state. Source and explicitly
shared folders have separate ownership and survive Finish.

## Approved Media Scenario (D25)

1. Start a separate test coordinator Core from the merged implementation and install Harness.
   Through Harness create/setup one child Core with a fresh account and no workspace requirement.
2. Install actual Media Server and Transcode Engine artifacts using reviewed repository/tag
   recipes and registry-digest locks; verify immutable image IDs and record source revisions. Preserve app identities and ordinary installation review.
   Use allocated ports so the fixture does not reserve production fixed ports. Any recipe
   adaptations, missing optional integrations or unverified behavior are explicit in the report.
3. Register the selected media folder in the child's shared-mount library with maximum mode `ro`.
   Bind that library entry to both app slots. Inspect actual Docker mounts and prove attempted
   writes are refused. Do not weaken the mount to satisfy an application's write assumption.
4. Give the test a separate disposable writable output folder. Input media is never an output
   target. If a short sample is needed, derive it into this test output area through read-only
   input access. External output is fixture-owned, not implicitly deleted by Core Finish;
   the fixture explicitly removes it after verifying that Finish preserves external mounts.
5. Verify Media Server browser login, catalog/file observation and communication with the child
   Transcode Engine. Run a real encode with readable output. Do not count a health response or
   an accepted job as a completed encode. Exercise dependency stop/restart and recovery.
6. Sample parent/child Core and Harness process RSS separately from container working set and
   charged memory. Include the actual agent/browser workers when used; record baseline, load,
   peak, time-to-ready, job duration and owned disk growth. Report sampling/fixture limits.
7. Finish through Harness; independently verify child process, app containers, networks, owned
   volumes/root/users/data/caches and port removal. Check input hashes and shared-folder survival,
   then remove the fixture's writable output, worker/browser and coordinator resources. Keep only
   exported sanitized reports/screenshots/scripts, not raw logs or credential-bearing JSON in Git.

Media Server currently declares Torrent Engine required and TMDb configuration required. This
scenario must expose those dependencies honestly: it does not test torrent ingestion, production
metadata credentials or external identification without an appropriate isolated test setup.
Transcode input/output mount labels must refer to the dedicated child provider, never silently
fall back to the main installation. No shared production provider is authorized.

## External-Client Usability Alignment (2026-10-18)

Preserved owner guidance from 2026-10-16: the supported service should make source/artifact selection,
preparation, readiness, preview/logs, retries and Finish easy to discover, with reusable operation IDs
and actionable recipe, permission, quota and setup errors. Return observable state and ready preview
destinations instead of making clients infer ports or success from acceptance. The built-in assistant
is the normal constrained client; privileged external clients prefer the same API without a claim
that Core exclusively mediates their OS/Git actions. Existing D6/D9 acceptance retains this scope;
[external development D7-D12](../external-development-workspaces/plan.md#deliverables) owns the Draft
direct-client adapters and reconciliation. Current shipped child Core architecture, statuses and
checked deliverables remain unchanged; the obsolete single-Core realm proposal is not restored.

## Deliverables

Stable IDs are retained. D7 (production-derived snapshot import) remains retired.
The checked items below record the verified scope merged in #590; expanded requirements remain open.

- [x] D1. Bind independent Core sandbox instances to their verified owner/caller, target app and reviewed worktree or artifact input; integrate optional workspace context and observed state, preserve installed runtimes and bind evidence to exact inputs.
- [x] D2. Implement the reviewed execution-target model, instance identity/ownership, separate sandbox-user realms, real-operator and generic app authority, scoped background grants, routing and dependency resolution; include scope-first checks, grant/SDK compatibility and credential handoff.
- [x] D3. Implement Core-owned empty/synthetic user/data fixtures, bounded seed staging/application, per-instance caches, settings/environment and explicit test dependencies/mocks; prohibit production-data/credential inheritance.
- [x] D4. Reuse full Docker source development and verify the selected offline Demo App recipe, source/watch/HMR, root/nested cache separation, isolated networks, relay and Core-access boundaries on the selected support matrix; report unsupported recipes without host fallback.
- [x] D6. Expose independent authorized Core APIs and client/SDK contracts with replay/reconnect, test-user management, persona launch and evidence export; adapt Harness tools and workspace views, and show all authorized instances in Shell with optional context and lifecycle/resource/cleanup observations.
- [x] D8. Integrate the trusted Playwright runner with sandbox-realm login by selected test users, private expiring credential/grant handling, role/permission scenarios, source/fixture-bound sanitized evidence and truthful pass/fail/unknown outcomes; verify real-operator login separately.
- [x] D10. Implement and verify instance-specific local preview origins, real-user login, access controls, embedded/direct navigation and HMR; provide operator Open preview links. The fresh-login callback regression is verified in the 2026-10-15 SDK fix; D9 retains the wider acceptance matrix.
- [x] D12. Verify a Core-managed non-Harness app using interactive and explicitly authorized background access to run a complete QA lifecycle from a pinned Demo App artifact, without workspace/worktree/session allocation or code edits; cover cross-client denial, grant revocation, quotas, replay, exported results and complete disposal.
- [x] D18. Isolate Core API state using a dedicated same-host Core process and fresh data root per environment; support release/source selection, normal users and permissions, independent local origins, and Core-plus-app development without mutating the primary installation.
- [x] D19. Track and dispose each test Core root and its owned processes, app containers, networks, caches and temporary data; stop writers before deletion, preserve borrowed source/shared mounts/exports, and verify crash/interrupted-cleanup recovery with a broken child Core.
- [x] D20. Run and document the approved shared-Docker, two-Core experiment with duplicate app IDs, independent users/data/origins, lifecycle and crash behavior, process/container memory, and owned-resource cleanup.
- [x] D21. Implement the parent Core environment registry, authorized create/list/status/stop/restart/Finish APIs, bounded graceful child shutdown, fallback cleanup and restart/crash reconciliation; integrate Harness and local operator preview while preserving the existing verified baseline.
- [x] D22. Verify a real model-driven Harness agent creating and setting up a child Core, changing Demo App in its reviewed worktree, installing and starting the Docker source runtime through ordinary Core approval, checking it in a browser, and finishing the environment with independently verified cleanup. Preserve sanitized evidence and fix regressions exposed by the run.
- [x] D23. Verify a real Harness agent editing both Core and Demo App in its session worktree, building a source-mode child Core from that project, consuming the changed Core API in Demo through normal browser authentication, running affected checks, and finishing with independently verified complete cleanup. Preserve sanitized evidence and repair any regressions exposed by the run.
- [x] D24. Integrate child Core environments into the operator UI: validate workspace/source inputs, ordinary test-account setup, observed app status, authenticated previews and replayable lifecycle/Finish controls; verify browser permissions, source retention and cleanup. The original Workspaces creation form and standalone app are retired on 2026-10-20; Harness agent tools retain creation/setup and Shell retains inspection and lifecycle controls. See the [retirement record](../workspaces-app/feature.md).

### Current Recovery Delivery

- [x] D26. Recheck the published Media/Transcode pair through a real Harness agent and browser; implement and verify child-Core Docker loss/recovery, same-request interrupted Finish, complete owned-resource deletion, aggregate sibling/nested reservations, Docker admission limits and soft-disk observation. Preserve the original media folder and document measured limits.

### Remaining Reliability And Acceptance

- [x] D5. Connect the agent/worktree resource monitor through the supported shared Harness worker, preserving CPU/RAM/PID and soft-disk policy. Active Core-owned leases prevent double-counting its sandbox reservation. The [shared-worker acceptance](../../reviews/2026-10-15-shared-docker-agent-acceptance.md) verifies busy admission, detached cancellation, coordinator loss, retained leases and explicit recovery; the earlier offline daemon acceptance covers actual Docker loss and same-UUID interrupted disposal. Stricter per-session containment remains unapproved.
- [ ] D9. Verify remaining native Linux-host/Windows, Linux amd64 worker and additional recipe guarantees before claiming them. Linux in Docker is the selected available target, not proof of native-host support. D27 records the local negative/race ledger and D28 closes cold-engine import/extraction/build/start and engine/build memory acceptance. The composed real-agent Demo → child Core → browser → commit/push/PR/CI/review → Finish journey passed in the D9 Git report. Prior reports cover both providers, direct/embedded HMR, dedicated Demo/Media dependencies and Docker-loss recovery; retain their profile-specific limits.
- [x] D27. Record the macOS arm64/Linux-in-Docker released-baseline acceptance: map inherited cases to exact tests and dated evidence, run local protocol/replay cases, measure fresh client OCI transfer and dependency preparation with simultaneous native/container sampling, verify ordinary Harness/browser behavior and independently prove full owned-resource cleanup. Its cold-engine measurement gap is subsequently verified by D28; wider host/recipe acceptance remains in D9.
- [x] D28. Verify cold image import/extraction, uncached source-image/dependency preparation and first HTTP readiness on an independent empty Docker engine. Run the real Harness agent and authenticated browser/HMR journey, measure warm restart with retained images/caches and enclosing engine/build/native memory, verify same-ID Finish and full fixture teardown, and prove existing containers/caches and primary Core remain unchanged. The cold-engine report records the Linux arm64/DinD, Autonomous-mode and temporary-recipe boundaries.
- [ ] D11. Decide and separately approve optional remote preview ingress/private access, then implement and verify it, or explicitly retire it if the owner abandons it. Local delivery does not wait for it.

### Permission Extension (Owner Revision, 2026-10-14)

- [x] D13. Complete one-run or saved, revocable consent for a trusted child Core, scoped to caller installation, owner, selected mode/target and resource ceilings. Verify request replay, changed targets/contracts, autonomous matching runs, effective-access display and revocation through Harness and browser. Keep ordinary child networking and internal Core rights; do not add parent per-app policy.
- [x] D14. Resolve dependencies to dedicated installations within one test Core and manage their grouped lifecycle with separate data/credentials and no implicit main-environment fallback. Keep shared installed providers deferred pending a concrete provider contract and renewed scope approval.
- [x] D15. Complete sandbox integration/acceptance for declared mount slots bound to approved shared-library entries, enforced read-only/read-write limits, reuse/revocation and preservation of external folders during reset/Finish; reuse the existing mount planner rather than a second permission system.
- [x] D16. Complete ordinary user/service permission acceptance for child APIs and owned nested creation, using D26’s aggregate resource accounting and cleanup. Preserve the existing root-wide two-descendant admission bound and normal roles; do not invent sandbox-specific roles.
- [x] D17. Verify the combined permission/dependency/mount/Core-API/child lifecycle contract, including a separate database provider, revocation, main-environment compatibility and cleanup. Shared installed-provider tests apply only after their deferred scope is approved.

### Same-Host Core Environments (Owner Decision, 2026-10-14)

D18-D24 above are delivered on the recorded local macOS host. D14-D17 acceptance now covers the
owner-selected macOS host and Linux in Docker: dedicated database recovery, ordinary roles,
read-only/read-write mount caps, nested lifecycle and complete grouped cleanup. Linux uses an
actual native-AOT Core and shared Docker, including interrupted Finish replay. Native Linux-host
and Windows acceptance remain unverified under D9; container tests do not establish those cases.

- [x] D25. Implement read-only Media catalogs and explicit separate transcode exports, then verify through a real Harness agent/browser: catalog scan, normal manual identification, full UI encode, dedicated provider restart and a new job, export removal, resource measurement, full source hashes and complete child/fixture cleanup.

The [read-only Media acceptance report](../../reviews/2026-10-14-read-only-media-sandbox-acceptance.md) records the passing replacement for the earlier writable-catalog failure. Automatic TMDb enrichment and torrent ingestion remain outside this test configuration. That representative case alone did not complete D14/D15/D17; the later trusted-Core acceptance covers their broader dedicated-provider, revocation and mount matrix.

## Implementation Sequence

| Order | Scope | Exit condition |
| --- | --- | --- |
| 1 | D9 local development journey | Published baseline, fresh login/HMR/navigation and complete cleanup verified |
| 2 | D13/D15 | Reusable consent, scoped expansion review and mount revocation verified |
| 3 | D14/D16/D17 | Dedicated dependencies, database, ordinary authority and nested lifecycle verified |
| 4 | Remaining D9 | D28 closes local cold-engine preparation; supported-host/recipe acceptance remains explicit |
| Optional | D11 | Separately approved remote preview, without per-instance publication becoming a local prerequisite |

Do not check a broad deliverable merely because D25 covers one representative case. The production
shared agent backend remains [Shared Docker Agent Runtime](../assistant-shared-docker-runtime/feature.md), not a
new sandbox dependency or a claim implied by the experiment wrapper. Source Docker platform
acceptance remains with [Mixed Development Runtimes](../mixed-development-runtimes/plan.md).
Final live-data trials remain explicit operator actions under
[Development Controls](../app-development-controls/plan.md). A merge never performs that switch.

## Approved Local Demo Profile

The following existing ceilings belong to the original offline profile. They are not automatically
inherited by a child Core's ordinary app installations. D25 records actual limits and total observed
cost; D16 owns aggregate child budgeting. Inspect current Docker capacity before each fixture and
do not assume the previously configured 20 GiB remains in effect.

### Concrete Local Limits And Retention (D3, D5, D8)

These are conservative initial ceilings, not measured minimums. CPU/memory/PID limits apply at
creation; do not disable the OOM killer. Set memory-plus-swap equal to memory to avoid unbounded
swap use ([Docker resource limits](https://docs.docker.com/engine/containers/resource_constraints/)).
Distribute the app budget across all of its services; never multiply it by the service count.

| Resource | Default limit |
| --- | --- |
| Shared agent and its build/test descendants | 2 CPUs, 4 GiB RAM, 512 PIDs; coordinated with Shared Runtime D6 |
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


## Inherited Acceptance Matrix (D9)

This is the approved matrix retained from the earlier plan, not a new claim that every case
has passed. Compose the existing evidence and close remaining cases under D9. Cases involving
sandbox realms, the private relay and blanket network denial apply to the original offline
`/api/sandbox-instances` profile; the trusted child-Core mode uses normal child identity and the approved
internet/dependency policy above, not those obsolete restrictions on its Core API.

The [two-container experiment](../../reviews/2026-10-13-two-container-development-experiment.md)
records the original fresh-login callback regression. The
[2026-10-15 acceptance](../../reviews/2026-10-15-sandbox-login-hmr-acceptance.md) reproduces it on
merged main and verifies the SDK fix in fresh embedded/direct contexts, including HMR/navigation
and complete child cleanup. D9 retains the remaining matrix and measurement limitations.

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
  The original experiment's roughly 594 MiB idle per container and 1.63 GiB corrected app cgroup peak are
  fixture observations, not capacity guarantees or general launch limits.
- Complete an authorized Git/PR/CI/review journey using existing owners; preserve source and any
  explicitly exported report, while Finish still removes the sandbox's own temporary artifacts.
  Verify that sandbox testing never starts a live-data trial automatically.
- This document describes intended product behavior. The dated bounded experiment is evidence for
  its fixture only; run affected builds/tests and full real Core/Shell acceptance during implementation.

Implementation verification includes `npm run core:build`, `npm run core:test`, SDK build/tests,
Harness lint/tests/web build, and lint/tests/builds for changed Demo App and Shell code.
Run CLI checks if its contract changes, plus `node scripts/check-versions.mjs` and docs validation.
Use a separate test Core data root with normal setup/password login and a genuine installed-app
baseline. Never restart the operator's Core merely to execute these tests. The implementation requires the affected product builds/tests, index/link validation and
`git diff --check`; the independent API probe does not replace Docker/browser acceptance.

The [2026-10-15 trusted-Core acceptance](../../reviews/2026-10-15-trusted-core-consent-acceptance.md) records the completed D13–D17 checks and bounded macOS/Linux-in-Docker measurements.

The [offline daemon acceptance](../../reviews/2026-10-15-offline-sandbox-daemon-acceptance.md) records the prepare/dispose fixes, actual Docker loss/recovery, same-UUID interrupted cleanup, browser repeat, memory snapshots and complete fixture removal. Shell is restored to its original configuration. D5 is now complete through the [shared-worker acceptance](../../reviews/2026-10-15-shared-docker-agent-acceptance.md).

## D9 Coverage Reconciliation

| Acceptance group | Current evidence | Remaining boundary owned by D9 |
| --- | --- | --- |
| Real worker source/tests/Git/PR/CI/review and independent child Finish | [D9 Git report](../../reviews/2026-10-15-sandbox-d9-git-acceptance.md), exact candidate commits | Completed for the selected macOS arm64 Demo journey; PR #599 subsequently merged and its Core/Demo publications were verified |
| Shared worker, both providers, detached-work recovery | [Shared worker](../../reviews/2026-10-15-shared-docker-agent-acceptance.md) plus D9 SIGKILL repeat | No per-session containment or cross-workspace isolation claim |
| Fresh identity, direct/embedded HMR and navigation | [Fresh login](../../reviews/2026-10-15-sandbox-login-hmr-acceptance.md), direct repeat in D9 | No fresh embedded repeat on every later recipe; bind evidence to its actual inputs |
| Dedicated dependencies, mounts, consent and nested lifecycle | [Trusted Core](../../reviews/2026-10-15-trusted-core-consent-acceptance.md), Media reports and the D27 ledger | Profile-specific cases are reconciled; further recipe/host claims need their own acceptance |
| Docker loss, interrupted Finish and same-ID recovery | [Offline daemon](../../reviews/2026-10-15-offline-sandbox-daemon-acceptance.md) | D9 did not repeat daemon loss; confirm any additional claimed failure combination explicitly |
| Simultaneous resources and cold engine | D27 records client transfer; [D28](../../reviews/2026-10-15-sandbox-d9-cold-engine-acceptance.md) measures empty-engine import/extraction, uncached build/start and warm repeat, including all native/engine/build workload memory | One Linux arm64/DinD workload with prepared tooling and an already-running host VM; broader host/recipe claims remain unverified |
| Host and architecture support | macOS arm64 plus Linux arm64 containers; CI unit/AOT coverage | Native Linux-host, Windows Docker and local amd64-worker acceptance remain unverified |

Dependent umbrella plans now link the composed journey rather than listing it as wholly missing.
Their app-creation, provider-switching, feedback, broader merge/release and redesign deliverables retain their
own approval and verification requirements. These links do not close or approve those Draft plans.

## Local Coverage Ledger (D27)

The [local acceptance report](../../reviews/2026-10-15-sandbox-d9-local-acceptance.md#coverage-ledger) maps L01-L22 to exact tests, dated live evidence and profile-specific boundaries.
D27 passed on the merged release: 209 unique Core cases, 18 Harness tests and six Demo tests;
real agent/browser source build, HMR, concurrent replay, independent QA, quota inventory and both
Finishes passed. [D28](../../reviews/2026-10-15-sandbox-d9-cold-engine-acceptance.md) subsequently verifies
cold-engine image import/extraction, uncached build/start and engine/build memory. Broader D9
host/recipe guarantees and optional D11 remain unchecked.

## Verification And Completion

- Build the exact Core target before launch; run affected Core/environment/mount/dependency tests.
  Runtime fixes require their owning app/component tests and version change. Documentation-only
  updates need no version bump. Run the documentation index, version validation and diff checks.
- Use normal Core-managed app lifecycle and ordinary password login. Capture actual browser state,
  dependency URL ownership, terminal job outcome and output readability, not only accepted requests.
- Keep the source media unchanged and prove kernel-enforced mount mode. Results, temporary accounts,
  sessions, configs and raw evidence must not leak into the main installation or repository.
- Preserve interrupted operations with their original request UUIDs. Finish is not successful while
  any owned writer/resource remains; external shared mounts and borrowed source must survive it.
- Keep D9's additional host/architecture/recipe acceptance and optional D11 explicit until their own checks pass. D28 records the bounded local cold-engine result. D13-D17 and D25
  are verified in the linked reports. Update feature.md and regenerate docs/root.md with the work.

## References

- [Current implementation and prior acceptance](feature.md)
- [Child Core manager acceptance](../../reviews/2026-10-14-child-core-manager.md)
- [Real agent child Core acceptance](../../reviews/2026-10-14-child-core-agent-acceptance.md)
- [Core and Demo source acceptance](../../reviews/2026-10-14-core-source-agent-acceptance.md)
- [Shell and Workspaces acceptance](../../reviews/2026-10-14-sandbox-ui-acceptance.md)
- [External workspace PR observation](../../reviews/2026-10-14-external-workspace-pr-observation.md)
- [Local delivery readiness](../hosty-delivery-readiness/plan.md)

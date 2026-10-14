---
status: In Progress
created: 2026-09-25
updated: 2026-10-14
summary: Remaining sandbox reliability, reusable permissions, aggregate quotas and broader acceptance after PR 590 and verified read-only Media integration.
components: [apps/core, apps/harness, apps/shell, apps/workspaces, packages/app-sdk]
---

# Independent Sandbox Instances In Core

## Current Baseline And Approved Next Step

PR #590 merged on 2026-10-14 at `eb9768017de3ec3cfb037c1d6c5e23b4ce13c8aa`.
[feature.md](feature.md) describes the shipped APIs, their verification and limits.
This plan separates remaining work from the earlier design iterations; it does not reopen
the implemented child Core manager, user model, Harness tools or Shell/Workspaces controls.

The owner now authorizes the Media Server plus dedicated Transcode Engine scenario, through
Harness and a normal authenticated browser, including resource measurements and complete
test-environment cleanup. The chosen external input is `/Users/haas/dev-media`, read-only.
No production app data, credentials or provider connections are inherited. This instruction
approved the bounded D25 milestone below; its read-only Media implementation and repeat acceptance
are complete. The owner separately authorized PRs for the Media implementation, this plan/report
and the linked Transcode Engine recovery fix. Remote deployment and changes to the operator's
primary Core installation are outside that publication request.

## Environment Scope (Later Owner Discussion, 2026-10-14)

Two existing execution modes must not be conflated:

- The original single-app `/api/sandboxes` runtime has the verified offline Demo recipe,
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

Keep offline available alongside explicitly and persistently approvable outbound internet access.
Do not constrain the product to HTTP/HTTPS or make domain-by-domain approval/custom TLS interception
prerequisites. Apply the selected policy to browser and setup traffic and report any first-profile
protocol limits. Internet can reach installed apps' public origins; ordinary endpoint authentication
still applies, and missing dependency bindings do not deny an unauthenticated public API.

Shared mounts require an explicit registered-folder binding and enforced access mode; read-write
is a separate expansion beyond read-only. Dedicated dependency installations remain the selected
D14 scope; shared installed providers require renewed approval of a concrete provider contract.
Consent never implies access to installed-app data or copied production credentials.

Verify one-run versus saved choices, isolation between app/caller scopes, autonomous matching runs,
requested expansions, target/contract revision revalidation, effective-access display and revocation.
Technical restart and ordinary source edits within the reviewed contract must not repeatedly prompt.

## Proposed Core Integration Contract

The independent APIs are already delivered; clients do not require a workspace or an agent session.
Workspace/worktree bindings retain borrowed source until Finish. Harness, Shell and Workspaces
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

## Deliverables

Stable IDs are retained. D7 (production-derived snapshot import) remains retired.
The checked items below record the verified scope merged in #590; expanded requirements remain open.

- [x] D1. Bind independent Core sandbox instances to their verified owner/caller, target app and reviewed worktree or artifact input; integrate optional workspace context and observed state, preserve installed runtimes and bind evidence to exact inputs.
- [x] D2. Implement the reviewed execution-target model, instance identity/ownership, separate sandbox-user realms, real-operator and generic app authority, scoped background grants, routing and dependency resolution; include scope-first checks, grant/SDK compatibility and credential handoff.
- [x] D3. Implement Core-owned empty/synthetic user/data fixtures, bounded seed staging/application, per-instance caches, settings/environment and explicit test dependencies/mocks; prohibit production-data/credential inheritance.
- [x] D4. Reuse full Docker source development and verify the selected offline Demo App recipe, source/watch/HMR, root/nested cache separation, isolated networks, relay and Core-access boundaries on the selected support matrix; report unsupported recipes without host fallback.
- [x] D6. Expose independent authorized Core APIs and client/SDK contracts with replay/reconnect, test-user management, persona launch and evidence export; adapt Harness tools and workspace views, and show all authorized instances in Shell with optional context and lifecycle/resource/cleanup observations.
- [x] D8. Integrate the trusted Playwright runner with sandbox-realm login by selected test users, private expiring credential/grant handling, role/permission scenarios, source/fixture-bound sanitized evidence and truthful pass/fail/unknown outcomes; verify real-operator login separately.
- [x] D10. Implement and verify instance-specific local preview origins, real-user login, access controls, embedded/direct navigation and HMR; provide operator Open preview links.
- [x] D12. Verify a Core-managed non-Harness app using interactive and explicitly authorized background access to run a complete QA lifecycle from a pinned Demo App artifact, without workspace/worktree/session allocation or code edits; cover cross-client denial, grant revocation, quotas, replay, exported results and complete disposal.
- [x] D18. Isolate Core API state using a dedicated same-host Core process and fresh data root per environment; support release/source selection, normal users and permissions, independent local origins, and Core-plus-app development without mutating the primary installation.
- [x] D19. Track and dispose each test Core root and its owned processes, app containers, networks, caches and temporary data; stop writers before deletion, preserve borrowed source/shared mounts/exports, and verify crash/interrupted-cleanup recovery with a broken child Core.
- [x] D20. Run and document the approved shared-Docker, two-Core experiment with duplicate app IDs, independent users/data/origins, lifecycle and crash behavior, process/container memory, and owned-resource cleanup.
- [x] D21. Implement the parent Core environment registry, authorized create/list/status/stop/restart/Finish APIs, bounded graceful child shutdown, fallback cleanup and restart/crash reconciliation; integrate Harness and local operator preview while preserving the existing verified baseline.
- [x] D22. Verify a real model-driven Harness agent creating and setting up a child Core, changing Demo App in its reviewed worktree, installing and starting the Docker source runtime through ordinary Core approval, checking it in a browser, and finishing the environment with independently verified cleanup. Preserve sanitized evidence and fix regressions exposed by the run.
- [x] D23. Verify a real Harness agent editing both Core and Demo App in its session worktree, building a source-mode child Core from that project, consuming the changed Core API in Demo through normal browser authentication, running affected checks, and finishing with independently verified complete cleanup. Preserve sanitized evidence and repair any regressions exposed by the run.
- [x] D24. Integrate child Core environments into Workspaces and Shell: create/start from validated workspace worktrees with optional source Core selection, ordinary test-account setup, observed app status and authenticated preview links, replayable lifecycle controls and explicit complete Finish. Verify the real embedded browser journey, permission denial, source retention and cleanup, then document the shipped UI.

### Remaining Reliability And Acceptance

- [ ] D5. Complete real Docker-daemon loss/recovery and interruption-during-create/dispose acceptance, keeping journal/replay and cleanup failures observable. Preserve the existing offline CPU/RAM/PID and soft-disk policy; connect its remaining agent/worktree monitor only through the separately approved production worker coordinator.
- [ ] D9. Complete the integrated acceptance matrix and simultaneous Core/Harness/agent/app/browser measurements, compose the authorized Git/PR/CI/review journey, reconcile dependent plans and document only verified host/recipe guarantees.
- [ ] D11. Decide and separately approve optional remote preview ingress/private access, then implement and verify it, or explicitly retire it if the owner abandons it. Local delivery does not wait for it.

### Permission Extension (Owner Revision, 2026-10-14)

- [ ] D13. Add one-run or saved, revocable operator consent scoped to app/caller and reviewed targets, with mandatory revision/digest revalidation for changed executable contracts/targets; follow the approved consent-policy requirements above, expose effective access, avoid repeated prompts within an unchanged scope and cover browser/setup traffic. Ordinary child Core internet is existing behavior, not evidence that this policy is delivered.
- [ ] D14. Resolve dependencies to dedicated installations within one test Core and manage their grouped lifecycle with separate data/credentials and no implicit main-environment fallback. Keep shared installed providers deferred pending a concrete provider contract and renewed scope approval.
- [ ] D15. Complete sandbox integration/acceptance for declared mount slots bound to approved shared-library entries, enforced read-only/read-write limits, reuse/revocation and preservation of external folders during reset/Finish; reuse the existing mount planner rather than a second permission system.
- [ ] D16. Complete ordinary user/service permission acceptance for child APIs and owned nested creation, including aggregate resource accounting and cleanup. Preserve the existing root-wide two-descendant admission bound and normal roles; do not invent sandbox-specific roles.
- [ ] D17. Verify the combined permission/dependency/mount/Core-API/child lifecycle contract, including a separate database provider, revocation, main-environment compatibility and cleanup. Shared installed-provider tests apply only after their deferred scope is approved.

### Same-Host Core Environments (Owner Decision, 2026-10-14)

D18-D24 above are delivered on the recorded local macOS host. Linux and Windows child-process
acceptance is not implied by unit tests or Linux Docker CI and remains within D9/D17's support matrix.

- [x] D25. Implement read-only Media catalogs and explicit separate transcode exports, then verify through a real Harness agent/browser: catalog scan, normal manual identification, full UI encode, dedicated provider restart and a new job, export removal, resource measurement, full source hashes and complete child/fixture cleanup.

The [read-only Media acceptance report](../../reviews/2026-10-14-read-only-media-sandbox-acceptance.md) records the passing replacement for the earlier writable-catalog failure. Automatic TMDb enrichment and torrent ingestion remain outside this test configuration. D14/D15/D17 retain their broader provider, revocation and mount matrix; this representative case does not complete them.

## Implementation Sequence

| Order | Scope | Exit condition |
| --- | --- | --- |
| 1 | Remaining D5/D16 | Real interrupted operations and aggregate resource accounting verified; production agent integration stays with its owning feature |
| 2 | Remaining D13-D17/D9 | Reusable policies and broader combined acceptance, including database and supported-host cases |
| Optional | D11 | Separately approved remote preview, without per-instance publication becoming a local prerequisite |

Do not check a broad deliverable merely because D25 covers one representative case. The production
shared agent backend remains [Containment D11-D13](../assistant-runtime-containment/plan.md), not a
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
- Keep D5's daemon-loss matrix, D9's cross-feature/platform acceptance, D11 and incomplete D13-D17
  explicit until their own checks pass. Update feature.md with verified behavior, check D25 only
  after its full runtime acceptance, and regenerate docs/root.md in the same working change.

## References

- [Current implementation and prior acceptance](feature.md)
- [Child Core manager acceptance](../../reviews/2026-10-14-child-core-manager.md)
- [Real agent child Core acceptance](../../reviews/2026-10-14-child-core-agent-acceptance.md)
- [Core and Demo source acceptance](../../reviews/2026-10-14-core-source-agent-acceptance.md)
- [Shell and Workspaces acceptance](../../reviews/2026-10-14-sandbox-ui-acceptance.md)
- [External workspace PR observation](../../reviews/2026-10-14-external-workspace-pr-observation.md)
- [Local delivery readiness](../hosty-delivery-readiness/plan.md)

---
status: Draft
created: 2026-10-13
updated: 2026-10-30
summary: Local demo priorities through November 5 for host-contained agents, workspace Docker sandboxes, app creation, Git review, optional feedback and gradual redesign.
components: [apps/core, apps/harness, apps/shell]
---

# Hosty Delivery Readiness

## Goal And Owner Decisions

Target a local demonstration by **2026-11-05**: create or change an app from Shell, prepare its
workspace, run it as a separate Docker sandbox with test data, inspect it as a real Core user,
verify it with Playwright and carry the source through commit/push/PR/CI/review. Preserve work
and the ability to continue after a reload or restart. Capacity depends on the available token
budget; the date is a target, not evidence that every linked plan fits into the available time.

Owner clarification, 2026-10-13:

- Protect the host first. Prefer one shared agent container with dedicated app data and the
  explicitly shared worktree area. Per-session containers remain a measured option, not a
  prerequisite. Cross-workspace source visibility is an accepted first-slice limitation, not
  proof of session isolation or permission to expose unrelated host files/credentials.
- Demonstrate one active agent, without building a queue. Preserve an extension path to parallel
  agents; 3/5-session measurements are secondary experiments rather than initial product gates.
- Sandboxes are an independent Core API available to authorized apps. The development journey
  links instances to workspaces; independent QA can run a pinned app version without worktrees,
  code edits or Harness sessions. They run beside installed apps with their own empty/synthetic
  data and the real Core, using reviewed Docker source or artifact inputs.
  Operators use real Core accounts. The owner approved agent-managed test-user realms with
  roles/permissions scoped to one sandbox instance; these are not global Core users. Technical
  stop/restart preserves them; Finish sandbox deletes the realm and all owned temporary resources
  while preserving source worktrees.
- No production-data import into sandboxes. A final trial against real app data is a separate,
  explicit operator action through installed-app development/runtime selection.
- Local browser access is required. Production-host preview is desirable but is not a demo gate.
- The Git/PR/CI/review workflow is included. Marketplace publication remains separate.
- Feedback collection and manual one-session dispatch are optional additions. Redesign is incremental as the
  owner finishes the mockups; existing functionality must remain accessible throughout.

This document owns priorities and readiness decisions; linked plans own implementation and tests.
These are planning decisions, not authorization to run experiments against live data, create Git
commits or start every implementation. Open technical questions keep this and affected designs
Draft. Containment remains Draft; the owner subsequently approved Sandbox and its independent
Core API boundary, so its owning plan is Ready.

## Public First-Install Journey (2026-10-21)

The owner requested a short installation path for people trying Hosty after the demonstration:
install CLI from the README script, run `hosty init` to install missing Core and select distribution
apps, then register the administrator in the browser once the apps are ready. Fresh Core/Shell
ports are automatic. Dashboard creation allocates a separate child environment and reuses the
initialization services with its own application selection and identity.

The [Hosty initialization plan](../hosty-initialization/plan.md) owns implementation and first-install
acceptance. This readiness document consumes its result and keeps the existing demonstration
scope separate; it adds no duplicate deliverables or claim that the new journey has shipped.

## Verified Sandbox Progress (2026-10-15)

After PR #595, the owner requested supported Harness execution in one shared Docker container.
The [shared runtime](../assistant-shared-docker-runtime/feature.md) records verified runtime
delivery, with both providers and selected-account authorization import verified. The 2026-10-20
[production-runtime feature](../assistant-shared-docker-runtime/feature.md) adds Docker and Local as
ordinary application runtime profiles, declares Docker as the manifest default and integrates
packaging, switching and acceptance with Core. Per-session containment remains a separate Draft
scope and does not gate that delivery.

Sandbox now ships independent single-app instances and trusted child Core environments, Harness
lifecycle tools, Shell/Harness previews, separate data/caches and interrupted-Finish recovery.
See [current behavior](../app-sandbox-runtimes/feature.md), rather than treating the original
September/October design gaps below as unimplemented platform foundations. The
[fresh-login/HMR acceptance](../../reviews/2026-10-15-sandbox-login-hmr-acceptance.md) verifies the
latest SDK correction and complete child cleanup. The
[trusted-Core acceptance](../../reviews/2026-10-15-trusted-core-consent-acceptance.md) verifies saved
consent and dedicated dependency/mount scenarios; the
[offline daemon acceptance](../../reviews/2026-10-15-offline-sandbox-daemon-acceptance.md) verifies
actual Docker-loss and interrupted cleanup recovery. The [D9 Git acceptance](../../reviews/2026-10-15-sandbox-d9-git-acceptance.md) composes the real shared-worker
Demo change, child Core/browser, Core commit/push/PR, CI/review correction, crash recovery and Finish,
with simultaneous workload measurements. PR #599 is merged and Core/CLI 0.135.1 plus Demo 0.17.2 are published. The
[local D9 acceptance](../../reviews/2026-10-15-sandbox-d9-local-acceptance.md) records the local test ledger,
client-transfer/dependency measurements and disposal. The [cold-engine acceptance](../../reviews/2026-10-15-sandbox-d9-cold-engine-acceptance.md)
closes the local empty-engine import/extraction, uncached build/start, warm-repeat and full memory
measurement gap as Sandbox D28, preserving existing workloads. Additional host/architecture/recipe
guarantees remain open under D9.
Stricter per-session agent containment, app authoring, feedback and redesign retain their separate approval and scope.
This checkpoint does not approve implementation of this Draft umbrella.

## Existing Foundation And Actual Gaps

| Area | Reuse | Remaining work for this journey |
| --- | --- | --- |
| Docker Development | [Mixed Development Runtimes](../mixed-development-runtimes/feature.md): Docker source mount, image/build recipe, watch command and cache volumes | Workspace/source and child ownership now ship; complete relevant [remaining platform acceptance](../mixed-development-runtimes/plan.md) |
| Workspaces | [Session workspaces](../assistant-session-workspaces/feature.md) and [Harness workspace UI](../harness-development-ui/feature.md) | Child runtime status and preview controls ship; complete the remaining integrated acceptance without introducing a second orchestrator |
| Git and review | [PR lifecycle](../assistant-pr-lifecycle/feature.md): commits, push, draft/ready PRs, CI/review observation and completion | The shared-worker test PR journey is verified in Sandbox D9; merge/release and broader development-session acceptance retain their separate scope |
| App creation | [Local app creation](../app-prototype-workspaces/feature.md), [Development Controls](../app-development-controls/plan.md), [App Authoring](../app-authoring/plan.md) | Local creation/continuation, recovery, Accept/Use locally and existing-remote PR flow verified on 2026-10-18; broader integration/adaptation and release/catalog delivery retain their own plans |
| Agent boundary | [Shared Docker Agent Runtime](../assistant-shared-docker-runtime/feature.md) and [Containment](../assistant-runtime-containment/plan.md) | Shared worker implementation and both-provider local acceptance complete; stricter session isolation retains its separate Draft plan |
| Sandbox | [App Sandbox](../app-sandbox-runtimes/plan.md) | D27/D28 record verified local and cold-engine stages; native Linux/Windows, Linux amd64 worker and additional recipe acceptance remain under D9 |
| Feedback | [App Feedback Inbox](../app-feedback-inbox/feature.md) and shipped [Overlay](../hosty-overlay/feature.md) | Durable annotated reports, intake, administrator triage and manual one-session dispatch |
| Redesign | [Design System](../design-system/plan.md), Ink and Signal | Apply foundations and prepared screens with functional parity; mockups are not a complete inventory of capabilities |

Docker Development is implemented foundation, not sandbox delivery: changing source does not
create a second runtime identity or separate app data. Some earlier plan tables predate shipped
workspaces and publication; their age is not evidence those foundations need rebuilding.

## Working Architecture

In the development journey a session owns a workspace, which groups repository worktrees and their
app bindings. It can link several Core sandbox instances, each with its own data/cache, service graph,
credentials, ports, preview origin and lifecycle. Core records owner/caller authority independently
of that optional context. An authorized QA app can create an instance from a pinned artifact with no
workspace or chat. One app can have installed and sandbox instances concurrently; one instance may
contain several service containers.

The agent worker and application sandbox services run in separate containers (owner confirmation,
2026-10-13). The worker holds its own agent state and authorized worktrees; each app runtime has
its own empty/synthetic data and limits. Source and selected seed access connect them, without
sharing agent credentials or Docker control. General build/test placement is still a design choice;
the completed experiments placed those subprocesses inside the agent worker.

Approved division: **Core** owns the independent API, records, authorization, resource allocation,
identity, lifecycle and cleanup. **Harness and other authorized apps** consume it; **Shell** shows
authorized instances and **Workspaces** filters those linked to a workspace. Show app, caller/run,
optional workspace, input revision, health, preview, logs and authorized lifecycle actions. Sandbox
D2/D6/D12 own implementation, including explicit background authority for unattended calls. Current
background installed-app lifecycle grants do not cover these new operations. Scheduling and QA
analysis belong to the consuming app; no nightly scheduler is added to this delivery plan.

Reuse Docker development environment images/builds plus a source mount and the app's watch
command. Rebuild the environment when the reviewed recipe/dependencies change; do not require a
full image rebuild for every source edit. Test file watching and browser hot reload separately.
Frozen source evidence is needed for repeatable test results even when the preview uses live edits.

The agent may seed only the selected instance's data folder through a scoped mount or write API.
An empty folder means a fresh app installation. Source, test data and disposable caches have
separate lifetimes. Builds and browser execution must respect the same host-protection goal.
Core-mediated operations avoid granting the agent the Docker socket or broad host execution.

Real Core authentication identifies the viewer; it must not automatically give a sandbox instance
all of the production app's grants. Instance-bound credentials, discovery and authorization remain
required even with the same user and app ID. Normal operator preview and automated browser access
need explicit instance access; neither an unguessable URL nor a synthetic login is the boundary.

## Priority And Checkpoints

| Priority | Outcome | Acceptance owner |
| --- | --- | --- |
| P0 | One working agent container protects the host; comparative measurements explain whether session containers are worth adding | [Shared Docker Agent Runtime](../assistant-shared-docker-runtime/feature.md); local acceptance complete, eventual comparisons remain in Containment D9 |
| P0 | Workspace Docker instances run separately with empty/seeded data, real Core login and local preview | [Sandbox](../app-sandbox-runtimes/plan.md), D1-D6/D10 |
| P0 | Agent edits, tests through Playwright, operator inspects, then commit/push/PR/CI/review work through the existing publication path | [Sandbox D8-D9](../app-sandbox-runtimes/plan.md), [Development Sessions D1-D2](../assistant-development-sessions/plan.md), [PR lifecycle](../assistant-pr-lifecycle/feature.md) |
| P0 | Create a new app from Shell and continue building it through the same workspace/sandbox flow | [Prototype Workspaces](../app-prototype-workspaces/feature.md), [App Authoring](../app-authoring/plan.md) |
| P1 | Apply finished tokens, typography, logos and prepared layouts without losing actions or state | [Design System](../design-system/plan.md) |
| Optional | Collect durable feedback, review batches and send selected work to one session | [Feedback Inbox](../app-feedback-inbox/feature.md) |
| Optional | Open a sandbox running on a production host through an explicit remote-preview route | [Sandbox D11](../app-sandbox-runtimes/plan.md) |

Proposed checkpoints, to adjust after the first experiments rather than treating them as estimates:

- **October 13-16:** validate the shared runner, Docker source reload and the instance/identity
  design; pick the demonstration app and set measured resource/startup budgets.
- **October 17-25:** complete an approved workspace-instance slice with seed data, local operator
  preview and browser verification; integrate the existing Git/review path.
- **October 26-November 1:** exercise creation from Shell and the complete journey; apply ready
  visual foundations. Decide whether any optional work fits the remaining budget.
- **November 2-4:** regression checks, recovery cases and demo rehearsal. Avoid adding optional
  scope while a required path still fails. **November 5:** target demonstration.

One feature's approval does not approve the others. Repository rules still require one complete
approved feature per PR, not one PR per checkpoint. Partial milestones do not close broader plans;
any necessary scope transfer must be explicit and preserve outstanding deliverable ownership.

## Experiments Before Committing To Details

| Experiment | What to measure or prove |
| --- | --- |
| Native vs shared vs session container | Same provider/workload; cached container start, agent readiness, first tool action, resume; separate image download and model latency |
| Resource cost | One active agent first; incremental idle/peak RAM, CPU, disk/cache growth; separate Docker VM/engine, agent, app build and browser costs; optional 3/5-session scaling |
| Dev loop | Same source image/build recipe and mounted worktree; edit → server reload → browser update; dependency/recipe change → reviewed rebuild; WebSocket reconnect and errors |
| Data and host boundary | Installed app plus two sandbox instances; empty/seeded startup; reads/writes, symlinks, credentials, APIs and network cannot reach production data or unrelated host paths |
| Identity and preview | Real Core login, allowed/denied viewers, separate origins and instance-bound credentials; revocation, expired sessions, direct link, iframe, redirect and HMR behavior |
| Playwright | Seed → act → assert backend/UI state → keep screenshots/trace and pass/fail/unknown bound to source/fixture revisions; source edits invalidate old evidence |
| Recovery and Git | Cancel, detached writer, restart, retry and cleanup; source retained; commit/push/draft PR, CI/review feedback and exact-revision evidence remain connected |
| Optional feedback | Accumulate several comments; navigate/reload/close/reopen, fail a save/upload, retry submit; preserve draft and evidence; select/dismiss/edit and send to one session without duplicate dispatch |
| Design parity | Inventory existing actions before applying the mockup; exercise every preserved action, draft, selection, approval, empty/error state and supported responsive layout afterward |

Containment D9 owns reproducible measurements: pinned versions, host/engine configuration, raw
samples, about 30 cached starts with median/indicative p95, and a bounded idle/repeated-run check.
The [first standalone Docker experiment](../../reviews/2026-10-13-agent-container-experiment.md)
passed edit/test/resume and host-path refusal probes: repeat readiness was 0.135 s median and
settled idle used about 467-475 MiB. It does not establish integrated behavior, concurrency cost or
production limits. Keep explicit limits for subsequent load experiments;
[Docker does not set CPU/RAM limits by default](https://docs.docker.com/engine/containers/resource_constraints/).
Use synthetic fixtures and designated test resources, without changing live deployments.

The [second experiment through Harness](../../reviews/2026-10-13-harness-container-experiment.md)
validated a real Demo App workspace edit, tests and production builds in an isolated Core instance.
Its peak reached 2.36 GiB by cgroup accounting, despite agent-only idle near 0.5 GiB. Budget build
and browser processes explicitly; the experimental bridge/mount recipe is not the shipped backend.

The owner subsequently authorized the
[two-container development experiment](../../reviews/2026-10-13-two-container-development-experiment.md).
Harness edits updated the open Demo App browser through HMR; the app ran in its own Core-managed
container with synthetic data. Tests/lint and independent stop/restart passed after correcting the
port, generated TypeScript metadata and nested dependency-cache recipe. Main sampled peaks were
927 MiB for the worker and 876 MiB for the app; corrected app setup reached 900 MiB. The app's
cgroup peak reached 1.75 GiB with cache accounting. This validates the bounded local loop, not a
production workspace-instance backend; its full report retains the failures and remaining boundaries.

### Recorded Results And Next Decisions (2026-10-13)

The three dated reports above retain configuration, commands, raw evidence, limits and cleanup
results. They cover different workloads, so their peaks are not an isolation-topology comparison.

| Observation | Recorded result | Interpretation |
| --- | --- | --- |
| Standalone cached startup | First observed readiness 0.636 s; 29 repeat starts median 0.135 s, indicative p95 0.140 s | Image/engine already available; excludes model response and cold VM/image download |
| Standalone idle | 467-475 MiB settled medians | Small synthetic task, not a build/browser budget |
| Harness application journey | Core workspace preparation/status, source change, 21 tests, lint, Turbopack and webpack builds passed | Experimental transport; no application server or sandbox was started |
| Harness worker memory | 486 MiB initial idle, 609 MiB final idle; 2.14 GiB sampled build maximum, 2.36 GiB cgroup lifetime peak | Agent plus build descendants; tested 4 GiB / 2 CPU limits, no OOM |
| Harness coordinator | About 270 MiB host process RSS, measured separately | Excludes Core and Docker VM; cannot be added as an exact physical-memory total |
| Filesystem and cleanup | Configured outside paths/socket inaccessible; test workers stopped/removed and temporary auth copies removed | Live Core/apps preserved; network confinement and container escape resistance were not established |

Next work, in priority order, remains owned by existing deliverables rather than a new parallel
implementation checklist:

1. **Implement and verify the approved instance and preview contract.** Use the experiment to
   validate source/data/cache bindings, runtime identity, authentication, origins and lifecycle.
   The [Core integration proposal](../app-sandbox-runtimes/feature.md#parent-managed-child-core-environments)
   now specifies execution targets, storage, scoped principals, Harness operations and a
   [five-phase sequence](../app-sandbox-runtimes/feature.md#parent-managed-child-core-environments). The
   [local demo profile](../app-sandbox-runtimes/feature.md#parent-managed-child-core-environments)
   selects offline isolated app networks with a fixed relay and concrete hard resource limits/
   monitored disk quotas, now accepted by the owner. The approved identity design lets Harness
   create sandbox-only test users/roles while preserving real-operator preview. It replaces the
   manually provisioned global test account. The Sandbox plan is In Progress following approval with
   the clarification that Finish deletes all owned temporary users/data/caches/artifacts, whereas
   technical stop/restart preserves them. Source worktrees have a separate lifetime.
   The API also accepts pinned artifact inputs and callers outside Harness; Sandbox D12 verifies a
   complete QA/export/dispose run without workspace allocation under explicit background authority.
   Then verify normal operator login and Playwright against that contract, including denied access
   and stale evidence after edits. Owners: Sandbox D2/D6/D8/D10 and this plan's D2. A standalone
   browser result is insufficient; no fake identity or installed-app credential reuse fills the gap.
2. **Use the verified shared worker.** The [Shared Docker Agent Runtime](../assistant-shared-docker-runtime/feature.md)
   implements the trusted coordinator, both provider transports, read-only Git metadata, selected
   credentials and stop/recovery contract. Separate agent/app execution is verified locally.
   Use the verified [production-runtime integration](../assistant-shared-docker-runtime/feature.md):
   Docker as the manifest default, equally supported Local, and ordinary Core install/switch/update.
   Per-session containers and concurrency comparisons retain their separate Draft scope.
3. **Complete the demonstration journey.** Compose sandbox/browser evidence with the existing
   Git/PR/CI/review path and creation from Shell, then apply ready visual references with parity
   checks. Existing feature owners retain implementation; this plan's D3 collects acceptance.

The [2026-10-14 runtime acceptance summary](../app-sandbox-runtimes/feature.md#parent-managed-child-core-environments)
records completion of the two local Core sandbox journeys: real Harness/worktree edits and
independent artifact QA after logout under scoped background authority. Separate agent/app
containers, local preview/HMR, temporary users/data, private browser results, failure checks and
cleanup passed. The owning Sandbox plan retains D9/D11 for its remaining cross-feature/host and optional remote acceptance. The supported shared-runtime backend now replaces the earlier experimental worker for this local journey. No Git publication,
production data trial or remote deployment is implied by these results.

Local preview should extend [Local Browser Origins](../local-browser-origins/feature.md), including
instance-specific naming and authorization. It need not provision DNS for every preview. For remote
preview, investigate an already configured ingress namespace/proxy and private operator access
before assuming per-instance publication is necessary. Compatibility, authentication, TLS, routing
and propagation behavior require a separate spike; no Cloudflare timing guarantee is assumed.

## Optional Feedback Direction

The October 30 owner direction makes a **feedback report** one coherent submission containing
related SDK annotations. Core owns submitted reports, evidence and current app/runtime context.
Harness supplies a global Feedback page and a workspace-details section; no separate app is required.
Keep reports together during selection and dispatch. SDK drafts persist locally in IndexedDB with
text/images, visible saving/saved/failed states and recovery across navigation/reload/reopening.
Retain the draft until confirmed acceptance; retry the same submission identity without duplicates.
Server-side draft autosave and cross-device draft synchronization are not required.

Workspace dispatch proposes the currently visible chat after review and an optional instruction.
Global selection defaults to a new session and normally a new development workspace; an explicit
existing-workspace/chat alternative remains available. Preserve observed origin apart from work
destination. Core snapshots its available current runtime/version/workspace context at first
submission acceptance; missing fields and a modest update-time mismatch are acceptable. Exact served
build correlation is not required and context never implies resolution. The owning
[Feedback feature](../app-feedback-inbox/feature.md) implements this manually reviewed flow.

The owner narrowed the first delivery to manual selection and dispatch to one session. Busy-chat
sending is refused without a queue and preserves the selected reports/instruction. Address all
excludes already processed and accepted/running reports. Processing is linked to each report's
exact prompt/run outcome, with no separate Closed state. Retain evidence for manual Send again
with new explanations and attempt history. A report has zero or one current workspace binding;
reassignment preserves the observation/version snapshot. On workspace deletion, delete currently
processed reports/evidence and detach all others intact into the global inbox. PR state and app
rollout do not gate processing or trigger deletion. Only administrators inspect reports and outcomes;
ordinary reporters receive no post-submission view, status or notifications. Browser screenshots
use the selected Screen Capture API with explicit user permission, without DOM-renderer workarounds.

Submission or approval alone starts no agent. Automatic pickup/routing and possible reporter access
are [exploratory](../../ideas.md#i18-feedback-follow-up-and-automated-handling); tasks remain separate.
The feedback feature adds neither a queue nor orchestration to the one-agent demonstration.

## Remaining Questions

1. Which local host/engine and representative app are used, and what RAM/startup/build budgets pass?
2. Which providers and existing login/resume modes must work in the demonstration?
3. What exact runner data, worktree/Git metadata and per-instance seed paths are mounted or brokered?
4. Does implementation of the approved Core instance/realm contract pass real-operator preview,
   agent-created scoped roles and complete temporary-resource cleanup under failure/recovery?
5. How do apps declare or obtain a compatible Docker development recipe? Which source stacks,
   databases and dependencies are supported first, and how are unsupported cases explained?
6. Where do the workspace instance list and local preview links live, and who may inspect each?
7. How are browser credentials supplied, source revisions captured during hot reload, and running
   consumers stopped before cleanup? Auth files/traces must not become shared agent secrets.
8. Which finished design screens are available, and which optional feedback/remote-preview tasks
   fit only after the required flow works?

The deadline, one-agent demonstration, host-first isolation, synthetic app data, real Core operator
access and inclusion of Git/PR review are decisions above, not unanswered questions. Network and
resource defaults, scoped sandbox users, their lifetime and the independent Core API boundary are
agreed in the Ready Sandbox plan.
The remaining questions concern verification and other owning features; this umbrella remains Draft.

## Deliverables

- [ ] D1. Complete the approved milestone inputs with the host/provider matrix and measured budgets; preserve the recorded deadline, priorities and linked feature ownership.
- [ ] D2. Review Containment and Sandbox experiment evidence, confirm the shared-runner baseline or an explicitly justified alternative, and settle instance/auth/source contracts in the owning plans before implementation approval.
- [ ] D3. Assemble the owning features' acceptance results into one readiness decision for creation, sandbox preview/testing and Git review, keeping every failed or unverified requirement open under its owner.

## Verification

- Planning-only changes: run `node scripts/docs-index.mjs --fix`,
  `node scripts/docs-index.mjs --check` and `git diff --check`.
- Implementation uses each owner's builds/tests, versioning and real Core/Shell/provider acceptance.
  A standalone preview, historical review or mocked agent does not establish the complete journey.
- No runtime tests, benchmark, deployment, commit or PR is performed by this planning revision.
- Documentation-only version outcome: no version change.

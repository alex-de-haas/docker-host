---
status: Draft
created: 2026-09-26
updated: 2026-10-15
summary: Remaining per-session execution isolation, scoped access and verified shutdown; the shared Docker worker is implemented and verified separately.
components: [apps/harness, apps/core]
---

# Agent Host And Session Containment

## Scope And Owner Direction

The 2026-10-15 owner request starts the shared-worker delivery under the separate
[Shared Docker Agent Runtime](../assistant-shared-docker-runtime/feature.md).
This plan remains Draft for the stricter per-session scope. Former D11-D13 are transferred and
retired here without being completed; historical references still identify that original scope.
The shared feature records the approved two-provider/selected-login contract and verified
implementation boundaries. The older experiment authorizations below describe their original dates, not a current
prohibition on the newly requested shared-worker work.

Owner revision, 2026-10-13: protect the host first and prefer one shared administrator agent
container for the [November demonstration](../hosty-delivery-readiness/plan.md). Return this plan
to Draft for active design; implementation is not approved. Compare performance/resource cost
against per-session containers before deciding whether the stricter topology belongs in that
milestone. One active agent, with no queue implementation, is enough for the demonstration.

The initial shared runner may access dedicated agent app data, explicitly shared worktrees and
selected sandbox seed directories. It must not reach unrelated host folders, the whole Core data
root, production app data, the Docker socket or unrestricted host control. Cross-workspace source
visibility is an accepted limitation within this shared administrator boundary. Keeping the trusted
coordinator and broad service credentials outside model-accessible execution remains necessary.

This revises the sequencing in [vision decisions 26 and 32](../../vision.md), recorded by decision
35. It does not turn a shared container into session isolation. The eventual per-session target
below remains tracked by D1-D10; shared-host delivery now belongs to the linked shared-runtime
plan, with eventual mode comparisons under D9. Common host-control restrictions also apply to the shared runner. Neither the shared runner nor
its performance results satisfy ordinary-user acceptance under decision 28.

## Approved Bounded Experiment (2026-10-13)

The owner explicitly requested a single-agent Docker experiment: restrict host filesystem mounts
to dedicated agent data and a worktree, verify real agent operation, and measure startup/resources.
This approves that research portion of D9 only, not the broader Draft implementation. Run Codex
0.160.0 (the Harness pin) on the available local Docker Desktop/ARM64 engine with a disposable
synthetic linked worktree, 2 CPU / 2 GiB limits, non-root execution and no Docker socket. Measure
container start, app-server readiness, real edit/test turns, resume, idle/working resource use and
filesystem refusal probes. Keep provider auth out of the image/evidence and remove its temporary
copy afterward. Use existing ChatGPT authentication; do not create an API key or modify live Core.
The Docker bridge permits provider traffic; this test does not establish network confinement or
Core/Shell integration. Retain a dated report and repeatable recipe. D9 stays open for the wider
matrix, comparison and integration acceptance; no production backend deliverable is completed.

The [dated experiment report](../../reviews/2026-10-13-agent-container-experiment.md) records a
successful standalone edit/test/resume and host-path refusal check. Repeat local thread readiness
was 0.135 s median; settled idle used about 467-475 MiB, with a 698 MiB cgroup peak after resume.
These are synthetic local observations, not integrated Harness acceptance or a session-topology
decision. The report includes raw evidence, reproduction steps and the untested boundaries.

The owner subsequently authorized a second bounded experiment through Harness: prepare a real
application workspace, change source, build and test it, and measure loaded memory. Use an isolated
local Core/Harness data root, the existing Demo App source, ordinary administrator setup/login and
Core-owned session worktrees. An experimental command wrapper may transport the existing Codex
adapter into Docker, with a narrow session workspace bridge where required. Keep trusted Core
credentials outside the agent container, preserve the live host, and create no commits or PRs.
Record transport adaptations and integration gaps separately from measured application results.
This extends the research authorization under D9; the product implementation remains Draft.

The [Harness/real-app report](../../reviews/2026-10-13-harness-container-experiment.md) records
successful Core-owned workspace operations, a real Demo App patch, 21 passing tests, lint, and
Turbopack/webpack builds through an experimental Docker command transport. Initial idle was
486 MiB; the first build reached 2.14 GiB sampled working set and the cgroup lifetime peak was
2.36 GiB under a 4 GiB ceiling. Harness coordination used about 270 MiB host RSS separately.
Loopback MCP bridging, host/container path mapping and narrow Git metadata access required
experiment-specific adapters. The supported implementation is recorded in the shared-runtime feature; D9 still owns controlled
comparisons, build worker-count tuning, concurrent work, long runs and browser/runtime overhead.

Owner clarification after these experiments, 2026-10-13: the agent worker and the application
sandbox are separate containers. Both experiments ran commands inside the agent worker; the
second included npm, tests and compilers, but started no application server or sandbox runtime.
Its 2.36 GiB peak therefore describes the worker plus its build subprocesses, not an agent/app
runtime pair. This does not settle where builds belong in the product: worker-local builds,
the application's development environment and a separate build worker remain options to compare
under D9. Moving a compiler changes resource ownership, not necessarily total host memory demand.
Keep 4 GiB as the tested experimental ceiling for this build workload, not a universal requirement.

The owner then authorized and completed the
[separate-container development experiment](../../reviews/2026-10-13-two-container-development-experiment.md).
Harness source edits hot-reloaded in a separate Core-managed Demo App container; synthetic seed
visibility, normal browser login, tests/lint and independent container stop/restart passed after
fixture corrections. Main sampled worker/app peaks were 927/876 MiB; corrected app setup reached
900 MiB. Cgroup peaks were 1.05 GiB for the worker and 1.75 GiB for the first app lifetime, with
different cache accounting. These are development-loop observations, not production-build budgets.

The fixture needed explicit port/type metadata and separate root/nested dependency caches; an
agent-created Vitest cache otherwise prevented app restart through the read-only source mount.
It uses a disposable Core installation, not concurrent sandbox identities in one Core. App
runtime/preview acceptance remains under [Sandbox D4/D5/D8/D10](../app-sandbox-runtimes/plan.md),
and D9 retains controlled comparisons/long-run costs. The bounded research does not approve the
broader Draft backend or complete those deliverables.

The [2026-10-14 Core sandbox runtime acceptance summary](../app-sandbox-runtimes/feature.md#integrations-and-verification-boundary)
adds a real contained Codex/Harness edit/test/build turn beside independent app containers, real
operator HMR and private browser verification. Sampled agent/app cgroup maxima are 1.59/1.20 GiB;
the simultaneous maximum is 2.79 GiB. Agent lifetime peak is 2.50 GiB, including earlier preparation,
with zero OOM events under 4 GiB. Sandbox resources and the copied agent login are removed after
export. The transport is still experimental; these results do not approve or deliver the Draft
production worker backend, per-session isolation or unrestricted agent network confinement.

## Shared Host Boundary First

The [Shared Docker Agent Runtime](../assistant-shared-docker-runtime/feature.md) owns the initial
coordinator/worker split, common worktree and Git bindings, provider-state handling, single-workload
admission and stop/recovery implementation. Its first mode deliberately shares source visibility
within the administrator boundary. This plan owns the additional isolation required before claiming
that separate sessions or users cannot reach one another's source, credentials or running commands.
Per-session comparisons may reuse shared-runtime measurements but cannot substitute for tests of
the stricter mode. Revoking a Core token alone does not prove operating-system access has ended.

## Current Behavior

- [Harness](../ai-gateway/feature.md) ships local and dev `localCommand` profiles. Claude and Codex
  execute as native processes; there is no shipped session container backend.
- [Normal / Autonomous](../assistant-session-autonomy/feature.md) controls native approval behavior.
  Autonomous deliberately permits broad native process access. Neither chat mode nor an assigned
  working directory establishes a session filesystem boundary.
- [Session workspaces](../assistant-session-workspaces/feature.md) supply registered worktrees and
  cooperative directory instructions. Core validates its own API calls, but these checks do not
  prevent a native process from reaching paths or credentials available to its OS account.
- The host prompt still directs general lifecycle actions unavailable through the delegated MCP
  connection to the local hosty CLI. Existing Core development/publication operations have their own
  authorization; they do not make that broad local control channel session-scoped.
- Cancellation and a subsequent permission change do not prove that detached commands have stopped.

## Eventual Per-Session Target Behavior

This stricter target remains unbuilt after a shared-host milestone; do not check its deliverables
merely because the shared runner passes host-containment tests.

### Session Execution Boundary

Bind every isolated execution to a trusted owner/principal, assistant installation, conversation,
workspace where applicable, execution generation and effective grant revision. A model-supplied
session ID or cwd is not authority. Runs without a source workspace receive no source mounts.

Separate the trusted coordinator and its credentials from model-accessible execution. Sessions may
share infrastructure only where that does not expose another session's files, native home, credentials,
processes or control interface. One container with every workspace mounted is not an acceptable
session boundary. Decide container-per-session versus shorter-lived executions before implementation;
resume, provider switching and cleanup must preserve the same ownership rules.

An isolated mode is the default for deployments covered by the approved support matrix. Retaining
host-native execution is an explicit administrator choice, clearly identified in the UI. Failure to
start or enforce an isolated run must not silently fall back to host-native execution. The separate
ordinary-user profile never inherits that fallback or administrator Autonomous permissions.

### Files, Git And Native Tools

Expose only the session's authorized worktrees as source roots. Exclude original checkouts, sibling
workspaces and their common parent. Resolve canonical paths, symlinks and changed bindings through
trusted Core records. A source-capable app without a supported isolated binding cannot receive a
claim of protected native execution; define support for no-Git sources explicitly.

Linked worktrees refer to administrative directories outside their checkout and share Git objects
and refs. Mounting only the checkout does not supply complete Git access; mounting the common store
can expose other workspaces. Choose isolated metadata or Core-mediated operations while preserving
authorized diff, local commit and publication. Local commit and remote publication remain distinct
authorities; source write access alone grants neither credentials nor remote destinations.

Enforce read and write boundaries for file/search tools, shell commands, scripts, package hooks and
subagents. Permission UI consumes this capability; it does not implement the boundary. Run project
commands without Edit source must leave source read-only. Caches, build outputs and scratch space
have explicit access and lifetime rules. The older native experiment's shared temporary-directory
exception is not evidence of isolation between sessions in the container backend. Verify canonical
protected roots even when the host stores them under temporary paths.

User/project native settings cannot expand the effective grant or bypass Hosty's visible permission
policy. Load useful source instructions without treating them as permission configuration. Verify
native paths that skip approval callbacks, including file reads, search, WebFetch and subagents;
callback coverage alone is insufficient. Unsupported capabilities stay unavailable in isolated mode.
Normal and Autonomous select confirmation behavior inside the same enforced boundary; Autonomous
does not remove mounts, network restrictions or Core authorization checks.

### Credentials, Network And Core Access

Core or the trusted execution launcher refuses mounts and overrides exposing the Docker socket,
Core control/run directories, the whole data root, other sessions or equivalent host-control paths.
Do not give the agent a control credential that can recreate those mounts through another API.

Give each execution only its required provider connection and scoped Core/app authority. Managed
native homes, environment variables, caches and logs must not expose other users' or connections'
secrets. Decide how existing-host-login connections work without mounting an unrestricted host home.

Enforce network policy for native processes and in-process tools, not just Bash. Model transport,
permitted MCP targets and any explicitly authorized package/network access are separate destinations.
Block alternate paths to host control, unrelated services and credentials. The MCP-only ordinary-user
profile is accepted in its own plan, including denial of arbitrary HTTP and native operator tools.

Route authorized lifecycle and source/publication requests through Core's scoped operations, consuming
[execution authorization](../assistant-execution-authorization/plan.md) and the operation owner's
app/action checks. Do not distribute broad UI credentials, expand every delegated token or use an
unrestricted local CLI as a substitute. Agent isolation does not isolate an app subsequently started
through Core's host-native runtime; [App Sandbox](../app-sandbox-runtimes/plan.md) owns that boundary.

### Shutdown Contract

Own the complete execution process tree and expose a verifiable stopped/quiescent acknowledgement,
including detached child commands, before reporting that old filesystem access is gone. Permission
revocation blocks subsequent dispatch but does not retroactively undo an already-dispatched operation.

[Workspace lifecycle controls](../workspace-lifecycle-controls/plan.md) owns close/revoke coordination,
operator controls and safe worktree release. It consumes the backend's stop acknowledgement and mount
release result; this plan implements those runtime primitives, not another workspace close workflow.
Unknown process or mount state must retain a blocker and source. A cancelled RPC, closed chat tab or
deleted directory is not proof of termination. Live unmount is not assumed.

## Ownership And Dependencies

| Owner | Responsibility |
| --- | --- |
| This plan | Session execution placement, filesystem/network/credential enforcement, native policy integration, runtime stop and mount-release evidence |
| [Approval Rules](../assistant-approval-rules/plan.md) | Grant choices, scope/lifetime, confirmation policy, revocation UI and decision audit |
| [Execution Authorization](../assistant-execution-authorization/plan.md) | Trusted execution registration and Core credentials scoped to the actor, workspace and operations |
| [Workspace Lifecycle Controls](../workspace-lifecycle-controls/plan.md) | Coordinated close, access revocation, cancellation and safe physical cleanup |
| [App Development Controls](../app-development-controls/plan.md), [PR Lifecycle](../assistant-pr-lifecycle/feature.md) | Operation-specific lifecycle/runtime-switch and source publication authority |
| [Isolated User Sessions](../user-agent-sessions/plan.md) | Non-admin MCP-only profile, user-bound calls, history and profile acceptance |
| [Agent Providers](../agent-provider-interface/plan.md) | Shared invocation contract and caller authority; tool-executing runs consume this boundary |
| [App Sandbox](../app-sandbox-runtimes/plan.md) | Applications under test, isolated runtime/data and browser verification |

This work does not gate the shipped Workspaces viewer or instruction-based worktree workflow.
Current administrator host-native risk remains as described in the
[Bridge](../ai-agent-bridge/feature.md#accepted-risk) and session autonomy feature. Administrator-only
access does not prevent untrusted app data or logs from steering an administrator's own agent.
The Harness rename and assistant-provider permission model have shipped and are not pending phases.

## Historical Evidence And Transfer

The [Codex spike](../../reviews/2026-09-16-assistant-development-permissions-spike.md),
[Claude spike](../../reviews/2026-09-16-assistant-development-permissions-claude-spike.md) and
[pinned-version verification](../../reviews/2026-09-16-assistant-development-permissions-verification.md)
remain dated archives. They supply regression scenarios, not current-version acceptance: settings
bypassing callbacks, unguarded sensitive reads, temporary-path differences, implicit cwd roots and a
model-tool writer surviving interrupt/unsubscribe. The experiments used older CLI/SDK versions;
rerun supported cases against the versions selected for implementation and retain evidence.

The 2026-10-10 transfer retires Approval Rules D1-D4 and D7-D10 there without marking them complete:

| Former Approval Rules work | Remaining owner |
| --- | --- |
| D1 original sources / worktree Git metadata | Containment D4 |
| D2 experiments and supported enforcement | Containment D9; Core authority stays with its operation owners |
| D3 immediate process revocation | Containment D10 runtime primitive; Workspace Lifecycle Controls D2-D3 coordination and acceptance |
| D4 canonical protected paths / temporary storage | Containment D4/D8/D9 |
| D7 native filesystem, command, network and credentials | Containment D5/D8 |
| D8 app/action authority, Git destinations and audit | App Development Controls D2-D3/D6; Execution Authorization D1-D3; PR Lifecycle; Approval Rules D15 for permission decisions |
| D9 settings bypass and D10 sensitive reads / all tool paths | Containment D8/D9 |

D1-D10 retain the stricter session target and its historical transfers. D9 also owns the new
shared/native/per-session comparison. Former D11-D13 transferred to the now-completed shared-runtime milestone as
described below; no prior deliverable is marked complete, and those IDs remain retired.

## Deliverables

- [ ] D1. Specify and implement the isolated session execution backend, trusted coordinator contract and container image with pinned adapters/toolchains; integrate build and release without assuming a shared Harness container is the boundary.
- [ ] D2. Define the supported-host rollout and isolated default, explicit administrator host-native opt-in, active-mode/capability UI and refusal of silent fallback.
- [ ] D3. Enforce the never-mount and host-control restrictions at trusted launch, including manifests, overrides and equivalent paths, with refusal tests.
- [ ] D4. Implement verified session/workspace source bindings and the selected Git metadata strategy; cover authorized multi-worktree access, no-Git support decisions, stale roots and exclusion of originals/siblings.
- [ ] D5. Implement session-scoped provider homes and credential delivery, including an explicit existing-host-login policy and isolation of environments, caches and retained secrets.
- [ ] D6. Integrate existing or separately approved scoped Core lifecycle/development/publication operations and update the host prompt; verify granted and refused actions without a privileged host CLI fallback.
- [ ] D7. Document shipped isolation and limitations in feature.md and affected Harness/Bridge reality docs, remove this plan and regenerate the index after all deliverables pass.
- [ ] D8. Enforce effective filesystem, command, network and native-settings policy across file/search tools, shell, scripts, subagents and in-process fetches; support independent edit/command grants and refuse unsupported capability or stale-thread reuse.
- [ ] D9. Compare native, shared-container and per-session execution using reproducible synthetic fixtures and measured startup/resource costs; run mode-specific acceptance on the selected OS/adapter matrix, carry forward historical regression cases, and record actual effects, audit coverage and unsupported cases.
- [ ] D10. Implement ownership and verified termination of all execution descendants plus mount-release acknowledgements for Workspace Lifecycle Controls; cover detached writers, cancellation, restart/recovery and unknown state without claiming API revocation alone removes OS access.

### Transferred Shared-Host Milestone (2026-10-15)

Former D11 (worker/backend) maps to Shared Runtime D1-D2/D6; former D12 (bindings/access) maps
to D3-D5; former D13 (acceptance/documentation) maps to D7-D8. These IDs are retired here, not
completed. The [shared feature](../assistant-shared-docker-runtime/feature.md) and
[acceptance report](../../reviews/2026-10-15-shared-docker-agent-acceptance.md) record completion of that milestone
without approving this per-session design.

## Open Questions

1. After the shared runtime ships, which measured startup/RAM and source-privacy requirements
   justify adding the stricter per-session mode? Shared transport/login/bindings belong to its plan.
2. For the eventual session mode, which trusted component launches it, and is a container retained
   per session or replaced per execution? How are concurrency, resume and recovery represented?
3. Which platforms/container engine are supported first, and what network enforcement works for
   native tools, model transport and MCP on each? Coordinate research with App Sandbox.
4. Which stricter Git metadata and no-Git binding strategy excludes originals/siblings in the
   eventual session mode, beyond the shared-runtime source boundary?
5. Can provider credentials remain in a broker, and how are native login state and existing host
   connections supported without exposing broader homes or cross-session state?
6. How do active grant changes trigger a new execution generation, and which acknowledgement proves
   process termination and mount release before cleanup, including the effects of shared-worker stop?

## Verification

- Launch through Core/Harness with real identity on each supported host. Verify the actual execution
  placement, mode shown in the UI, provider-backed Claude/Codex turns and refusal of host fallback.
- For the stricter session mode, use two simultaneous sessions, including different users in the
  later ordinary-user acceptance.
  Inspect mounts/processes and attempt file, shell, search, symlink and network access to synthetic
  originals, siblings, secrets and control endpoints. Prove external denial, not a model's refusal.
- Exercise multiple authorized worktrees, Git metadata/refs, no-Git or unsupported sources, package
  setup, declared caches/scratch and protected host paths under temporary directories. Confirm
  independent edit/command grants and separately authorized local commit/publication.
- Reproduce historical settings/callback/read and detached-writer probes on the selected pinned
  versions; test subagents, in-process requests, native resume and changed grant revisions. Retain
  deterministic results plus real provider development-loop evidence; mocks alone do not prove OS isolation.
- Verify Normal confirmations, explicitly unprompted rules and Autonomous inside the same boundary.
  Disabled MCP tools and Core app/action/resource denials still hold in every confirmation mode.
- Revoke during active writes, interrupt, restart and recover the coordinator. Confirm descendants
  actually stop and mounts release; unknown consumers block cleanup through the lifecycle owner.
- Check permission-decision audit separately from operation outcomes and runtime stop evidence;
  retain no credentials or synthetic secret content in ordinary audit records.

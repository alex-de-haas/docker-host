---
status: On Hold
created: 2026-09-26
updated: 2026-10-10
summary: Deferred isolation of agent session executions, including workspace access, credentials, network boundaries and verified process shutdown.
components: [apps/harness, apps/core]
---

# Agent Session Containment

## Scope And Owner Direction

The owner approved this planning revision on 2026-10-10, without implementation. This plan remains
On Hold. It owns the execution boundary for individual agent sessions, replacing the original
proposal to make a Docker profile for the whole Harness app the isolation boundary. Packaging a
shared Harness server in Docker may be useful deployment work, but does not isolate its sessions.

[Vision decisions 26, 28 and 32](../../vision.md) require an eventual isolated execution to expose
only the owning workspace's authorized worktrees and to support a separately verified MCP-only
ordinary-user profile. A container backend is the intended direction; its topology, supported hosts
and rollout still need design and explicit implementation approval.

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

## Target Behavior

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

D1-D7 below retain their original themes, adjusted to session execution rather than whole-Harness
packaging. New work uses D8-D10; no retired Approval Rules ID is reused.

## Deliverables

- [ ] D1. Specify and implement the isolated session execution backend, trusted coordinator contract and container image with pinned adapters/toolchains; integrate build and release without assuming a shared Harness container is the boundary.
- [ ] D2. Define the supported-host rollout and isolated default, explicit administrator host-native opt-in, active-mode/capability UI and refusal of silent fallback.
- [ ] D3. Enforce the never-mount and host-control restrictions at trusted launch, including manifests, overrides and equivalent paths, with refusal tests.
- [ ] D4. Implement verified session/workspace source bindings and the selected Git metadata strategy; cover authorized multi-worktree access, no-Git support decisions, stale roots and exclusion of originals/siblings.
- [ ] D5. Implement session-scoped provider homes and credential delivery, including an explicit existing-host-login policy and isolation of environments, caches and retained secrets.
- [ ] D6. Integrate existing or separately approved scoped Core lifecycle/development/publication operations and update the host prompt; verify granted and refused actions without a privileged host CLI fallback.
- [ ] D7. Document shipped isolation and limitations in feature.md and affected Harness/Bridge reality docs, remove this plan and regenerate the index after all deliverables pass.
- [ ] D8. Enforce effective filesystem, command, network and native-settings policy across file/search tools, shell, scripts, subagents and in-process fetches; support independent edit/command grants and refuse unsupported capability or stale-thread reuse.
- [ ] D9. Run reproducible synthetic-fixture experiments and end-to-end acceptance on the selected OS/adapter matrix; carry forward historical regression cases, verify actual effects and audit coverage, and record unsupported cases before implementation approval and release.
- [ ] D10. Implement ownership and verified termination of all execution descendants plus mount-release acknowledgements for Workspace Lifecycle Controls; cover detached writers, cancellation, restart/recovery and unknown state without claiming API revocation alone removes OS access.

## Open Questions

1. Which trusted component launches sessions, and is one container kept for the session or replaced
   per execution? How are concurrency, resume, provider switching and recovery represented?
2. Which platforms/container engine are supported first, and what network enforcement works for
   native tools, model transport and MCP on each? Coordinate research with App Sandbox.
3. Which Git metadata strategy and no-Git source binding preserve useful development without
   exposing originals, sibling worktrees or shared administrative state?
4. Can provider credentials remain in a broker, and how are native login state and existing host
   connections supported without exposing broader homes or cross-session state?
5. How do active grant changes trigger a new execution generation, and which acknowledgement proves
   process termination and mount release before lifecycle cleanup?

## Verification

- Launch through Core/Harness with real identity on each supported host. Verify the actual execution
  placement, mode shown in the UI, provider-backed Claude/Codex turns and refusal of host fallback.
- Use two simultaneous sessions, including different users in the later ordinary-user acceptance.
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

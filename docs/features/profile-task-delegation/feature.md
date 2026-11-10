---
created: 2026-11-04
updated: 2026-11-10
summary: Harness task trees select saved profiles or scoped configurations, retain execution history and coordinate optional source access through Core.
components: [apps/harness, apps/core, packages/app-sdk, packages/app-sdk-dotnet]
---

# Profile-Based Task Delegation

Harness coordinates a tree of ordinary tasks through the existing version-one task interfaces.
The previously unused task schema is replaced in place, as explicitly approved in
[vision decision 70](../../vision.md); legacy task-store migration is outside this release.
Profiles supply reusable instructions, skills and model selections. A manager is a profile, without
a separate agent identity, team registry or permission role.

## Selection And Sessions

Harness `task_executor_options` exposes descriptions, revisioned selections and known availability. Manual assignment
retains a saved-profile selection. Core’s provider-neutral `task_options` remains a distinct
mediated operation; the session-owned directory does not shadow its name. `task_prepare_executor` validates the current directory revision
before selecting an existing profile. A fallback requires a name, rationale, instructions and
installed skill IDs; it inherits the coordinating session's connection and model. The retained
configuration belongs to that owner, root and coordinator. It creates no catalog profile.

Acceptance snapshots configuration before native execution. Renaming or deleting the saved profile
does not rewrite an admitted session's attribution. Distinct tasks and retries use separate sessions;
two tasks can use the same profile concurrently. Each attempt retains its explicit result and
conversation reference. Uncertain native termination prevents a replacement attempt.

## Starting In Chat

Ordinary chat work runs in its independent session, with an authorized workspace for source edits.
Multiple steps and Autonomous mode do not trigger task creation. Tasks start only on an explicit
user request or when the selected profile explicitly requires them. A manager profile's name alone
does not impose task orchestration.

Pre-tree version-one task records without `rootTaskRef` are retained verbatim in `legacyTasks`
on the next store write and excluded from tree execution, listing and reconciliation. They are
not converted into executable trees; their presence does not block new root creation.

`task_adopt` persists one root before delegation and binds the originating conversation to its first
attempt. Repeated requests recover the same root. A declined proposal leaves an unstarted Draft;
a fresh proposal reuses it. An adoption configuration cannot be assigned to a child.

Normal chats require a separate owner action in Decisions. Approval applies at a confirmed native
boundary and persists Autonomous on the same session; completion does not restore Normal. Decline
continues ordinary chat without task execution. Already-Autonomous chats need no mode question.
A retry of an adopted root uses a fresh session with the retained configuration.

New assigned task sessions start in Autonomous. Explicit MCP Ask/Disabled preferences, current Core
grants and repository instructions still apply. Neither a task prompt nor a profile grants additional
source, lifecycle, publication or settings authority.

## Delegation And Results

`task_delegate` creates an armed direct child with a retained request, selection and rationale.
Parentage is immutable and distinct from prerequisites. Prerequisites identify accepted outcomes;
cycles, stale graph revisions and completion with unresolved required children are rejected.
`task_plan` stores a revisioned plan independently of the immutable admitted objective.

Children require direct-parent review of an exact `resultRef`. Requesting changes records feedback
and arms a new attempt on the same task. Retry and reassignment retain prior attempts, ancestry and
root accounting. A result is explicit `task_result` evidence followed by confirmed native exit;
an ordinary final chat response alone does not complete a task. Mandatory human intervention uses
`task_request_input`; unsuccessful terminal evidence uses `task_fail`. Neither can satisfy a successful
child dependency. [Basic Tasks](../basic-tasks/feature.md) owns the completion barriers and recoverable
removal contract.

`task_wait` records monotonic child task revisions and an any/all wait. These observations and
outbox identities distinguish separate attempts even when native receipt counters restart. Durable child outbox and parent
inbox records preserve early, duplicate and late results. Worker parking confirms native stop,
releases capacity and resumes the original checkpoint under the same task attempt. Recovery retains
the original native command and does not invent a replacement manager. Missing checkpoints and
unknown exits remain recovery conditions.

## Optional Workspace Context

Universal task records contain no workspace input. Harness retains an optional execution-source
context and Core validates its binding. `task_bind_workspace` selects an authorized workspace or
prepares source through the existing broker. Workspace-free tasks allocate no checkout.

Late binding coordinates safe boundaries for active execution and associates every retained root,
child and retry session. Historical association records navigation context; it does not claim that
an earlier session used source. Source revocation, detach and missing history remain visible.
Unknown stops retain source leases. A replacement coordinator observes the retained source operation
before continuing it. Missing original boundaries appear as recovery items in Decisions.

Cooperative read/write claims cover normalized repository-relative prefixes in the selected
workspace. Dot segments are normalized before claims are stored and compared. Internal symbolic aliases,
including dangling links and existing ancestors of new paths, conservatively take exclusive access. Claims are shared across roots. Overlapping writes, broad changes, Git operations and
lockfiles serialize; disjoint claims can run concurrently. Claims are acquired with execution
capacity and released only after confirmed native stop. They coordinate agents and do not sandbox
arbitrary filesystem access.

Workspace details show linked root tasks and associated execution sessions, using immutable profile
names or task-specific/chat labels as executor attribution. Human ownership remains separate.
Pagination preserves all authorized sessions; other users' metadata does not expose private chats.
The global Tasks layout retains its existing presentation.

## Limits And Recovery

Settings → Tasks configures defaults; each root has retained, editable limits. Defaults are four
simultaneous native executions including the coordinator, delegation depth three, fifty descendants
and two retries per task. A root pause fences new work and parks active execution. Resume verifies
the original checkpoints before clearing the owner pause. Stop cannot be reversed by Resume.

Optional active-time limits use monotonic Worker segment counters and retain overshoot. Parked wait
time does not consume active execution time. Unknown usage remains visible; monetary caps are
rejected because no exact provider-independent enforcement is available. Replays and reassignment
do not reset counts. Agents cannot modify owner limits or grant their own mode approval.

Independent recovery phases keep a pending permission in one phase from blocking executor polling.
Concurrent foreground/recovery delegation shares its in-flight request. Persistent requests and
revision checks remain authoritative after process restart. Each new operation uses a fresh UUID;
only recovery of the same operation retains its UUID and exact input. Core validates current installation,
user grants, root generation, coordinator epoch and exact task execution on outgoing operations.
No browser bearer credential is persisted for background work.

## Verified Scope

The 2026-11-04 macOS arm64 verification covers deliverables D1-D8 of the completed implementation
plan. The task and executor interface versions and HTTP routes remain at v1.

- `npm run harness:test`: 2,229 tests in 212 files pass.
- `npm run harness:lint` and `npm run harness:build-web`: pass; lint retains one existing task-list
  effect-cleanup warning.
- `npm run sdk:test` and `npm run sdk:dotnet:test`: 781 TypeScript and 75 .NET tests pass.
- The exact Core project builds; the affected mediation, catalog, Decisions and direct-environment
  tests pass (34 tests). After integrating current main, the expanded selection including public-origin
  regressions passes (95 tests). Existing compiler/package warnings remain.
- `npm run test:integration -- tasks`, with `HOSTY_TASKS_BROWSER=1`, passes the five-minute parked
  restart, native protocol, optional workspace, single-Worker delegation, unrelated-ID SDK
  executor and Chromium journeys. `sessions` and `worker` suites also pass. Task acceptance uses
  per-invocation Docker tags so concurrent builds cannot replace its fixture implementation.
- Real Codex and Claude complete a text-only parent/child objective with saved profiles, exact
  child review, explicit results and same-native-session continuation after API/Worker restart.
  Normal approval persists Autonomous; decline retains an unstarted root. Claude also completes
  the empty-directory one-off case without creating a saved profile. The final Claude restart
  case uses a unique request namespace and explicit tool rediscovery after waiting.
- Review regression checks reproduce and fix retry selection-revision mismatches, external-provider
  execution admission and child failure delivery across attempts: 91 affected Harness tests and
  37 affected Core tests pass.
- Core-backed browser checks cover root-task navigation, profile attribution after rename,
  history reload, task/Decisions review and preserved drafts under stream updates. Unit tests
  additionally cover all history pages, revoked access, completed analysis association and
  replacement-manager recovery.

Live-model evidence is a bounded text-only smoke test, not an end-to-end application-development
benchmark. A model can stop without submitting an explicit result; such attempts remain failed.
Windows and other operating systems are not part of this local verification. Parent Finish confirms
cleanup of scripted test children and the separate configured-model sandbox. Ordinary app data and
the registered source worktree are retained.

Artifact versions are Platform 0.174.0, Harness 0.91.0, TypeScript SDK 0.44.0 and .NET SDK 0.14.0.

## Testing Expectations

- Run both SDK suites, Core mediation/catalog/source tests, Harness task/Worker/adapter tests,
  TypeScript checks and the production web build.
- The heavyweight `tasks` integration suite is optional under the
  [explicit selection policy](../ci-feedback-loop/feature.md#local-integration-checks), including
  when delegation changes. Run affected `sessions`/`worker` checks under the ordinary integration
  policy. Selected managed runs use separate users, data and dependencies and verify actual child
  readiness and parent Finish resource removal.
- Exercise real configured Codex and Claude separately from scripted fixtures: profile discovery,
  delegation, exact child review, explicit final result, Normal consent/decline, native checkpoint
  restart and same-attempt continuation.
- Cover empty directories, one-off roles, immutable snapshots, fresh attempts, graph limits,
  cancellation, lost replies, unknown exits, grant revocation, source rebinding and writer overlap.
- Verify Decisions and workspace attribution through Core-backed browser identity, including
  retained drafts, pagination, reconnect and private history boundaries.

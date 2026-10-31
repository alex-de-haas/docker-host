---
status: In Progress
created: 2026-10-30
updated: 2026-10-31
summary: Canonical Core MCP capabilities, explicit Core and Harness ownership, client migration and feature-based tool settings.
components: [apps/core, apps/harness]
---

# Core MCP Capability Boundaries

## Goal And Owner Direction

Expose platform capabilities through Core's own supported MCP contract so an authorized client can
operate them without installing Harness or creating an assistant conversation. Harness consumes
those capabilities and owns its conversations, execution adapters and presentation.

On 2026-10-30 the owner requested a substantial review of the Core/Harness boundary, specifically
environment lifecycle and tasks, and accepted the proposed feature-based grouping with a separate
Applications group. The owner then selected provider-owned task storage with unified MCP access, preserving decision 62.
[Vision decision 67](../../vision.md) records this direction. On 2026-10-31 the owner explicitly
approved the complete bounded contract, authorization and migration design below and requested
implementation. D1 is complete. Implementation started on 2026-10-31 with the canonical catalog
and authority metadata.
See vision decision 69; approval does not authorize a live runtime switch or publication.

The later owner clarification selects a common Core-owned history schema and API/MCP access for
sharing, search and future indexing, while keeping original data with its provider. The separate
[Conversation History](../conversation-history/plan.md) plan owns that domain contract and adapters;
this plan incorporates its tools into the canonical catalog without duplicating deliverables.
Qdrant is the named future integration, explicitly deferred for now. See vision decision 68.

## Verified Baseline

Source baseline: `9d932d89a50c4c9ac525a6bed2802918c664ce36`, inspected on 2026-10-30 in a
Core-registered external workspace. The local host reports Core 0.164.0 and Harness 0.80.0.
The settings screen shows 37 Core tools and 74 Harness development tools; source enumeration at
this baseline agrees. These are catalog counts, not evidence that every caller can execute them.

| Capability | Current implementation and exposure | Proposed responsibility |
| --- | --- | --- |
| Host, apps, logs and audit | Core services and Core MCP | Core API/MCP; clients render results. |
| Workspaces and Git | Core services; direct external MCP plus separate Harness tools and session routes | One canonical platform tool contract, with explicit caller adapters and optional client context. |
| Pull requests and publication | Core PublicationService; session-scoped Core HTTP routes and Harness MCP | Core API/MCP independent of a Harness conversation; existing publication rules remain authoritative. |
| App creation and local source | Core services reached through Harness's development adapter | Core capability contract; Harness may provide creation UI and workflow assistance. |
| Runtime selection, dev mode and activation | Core services, direct MCP operations and Harness wrappers | Core owns execution and recovery; Harness coordinates the safe end of its own active writers. |
| Child Core environments | Core storage, processes, consent, lifecycle, setup and child API access; Harness publishes ten MCP wrappers | Core MCP over the existing services. Optional chat associations do not become prerequisites for lifecycle. |
| Workspace work lifecycle | Core workflow state and Harness turn-exit/lease coordination | Core owns shared resource state; Harness owns its native-turn completion and lease release evidence. |
| Chat context | Harness's selected app metadata and conversation revision | Harness; this is private conversation state, not a Core environment resource. |
| Tasks | Core wire contract and provider routing; Harness stores tasks and supplies a task executor and seven tools | Providers retain storage/execution; Core exposes a standard provider-qualified task MCP adapter. Profiles remain application-owned. |

Evidence in the implementation:

- [Core MCP](../../../apps/core/src/Haas.Hosty.Core/McpEndpoints.cs) maps 14 tools to installed-app
  permissions in `ToolPermission`. Other registered Core tools do not automatically become callable
  by an assistant-specific credential. The
  [external workspace authorization](../../../apps/core/src/Haas.Hosty.Core/ExternalWorkspaceMcpAuthorization.cs)
  explicitly requires a direct OAuth/manual Core credential, rejecting app/delegated credentials.
  Therefore pointing Harness at the current direct tools is not a complete migration.
- [Environment endpoints](../../../apps/core/src/Haas.Hosty.Core/CoreEnvironmentEndpoints.cs) already
  serve operator and app callers over Core HTTP. [CoreEnvironmentService](../../../apps/core/src/Haas.Hosty.Core/CoreEnvironmentService.cs)
  owns records, observation and lifecycle; no environment MCP registration exists at this baseline.
- [Harness development tools](../../../apps/harness/src/sessions/development.ts) compose environment,
  task, context and source/publication tools into one `hosty:development` provider. The
  [session manager](../../../apps/harness/src/sessions/manager.ts) requires an active turn, stores
  environment associations and recovery observations, and filters environment listing to that chat.
  Those client behaviors currently limit access to a general Core service.
- [Publication endpoints](../../../apps/core/src/Haas.Hosty.Core/PublicationEndpoints.cs) require
  an app/session path and WorkspaceAuthorization. The publication engine is already in Core;
  direct-client support is an adapter/authority gap, not a reason to build another engine.
- [TaskService](../../../apps/harness/src/tasks/service.ts) reads and writes its local TaskStore for
  `task_list/get/create/edit/action`. `task_result` reports against the bound Harness execution.
  The current MCP tools do not provide a universal task-provider selector.

The engineering conclusion is that transport exposure, resource ownership and client workflow have
been combined in the Development tools catalog. There is no fundamental runtime or protocol obstacle
to exposing the existing platform services in Core MCP. Caller identity, scope mapping, recovery and
compatibility still need deliberate implementation; moving tool definitions alone is insufficient.

## Target Behavior Against Current Core MCP

Use one canonical catalog for platform operations, with stable tool identity, explicit feature
metadata, schemas, annotations and results. Keep Core neutral to installed app IDs and client routes.
Existing HTTP endpoints, MCP adapters and supported CLI paths call the same domain services.
Harness may inject optional context and maintain UI observations, but does not define a second
platform operation or authoritative lifecycle journal. Direct clients need no synthetic Harness
installation, conversation or service credential.

Resolve each actual caller into an authenticated administrator/user and, where applicable, an
installed app or direct grant. Preserve the application AND initiating-user permission rule and
separate source, lifecycle, Core restart, environment and publication authority. An existing
workspace grant must not silently gain environment control or remote publication. Revocation and
current source/provider checks apply at dispatch and recovery. Catalog availability is distinct
from executable authority.

Environment lifecycle uses stable Core resource IDs and operation receipts. Preserve existing
owner/consent boundaries unless an explicitly approved migration changes them. Chat/task/workspace
references are attribution and selected context, not fabricated credentials. Keep passwords and
child API bodies out of recovery journals; preserve isolation of users, data and provider credentials.
Full `environment_api` control needs a clearly bounded grant and review, not an accidental extension
of a read or start/stop permission. Reuse Core's existing readiness and cleanup mechanisms.

Client migration must preserve resource IDs, retained operations and unfinished work. Keep original
request IDs after unknown outcomes, and do not replay completed mutations during migration.
Harness still owns native execution and releases writer leases only after confirmed stop; Core
resource operations must not infer process termination from a disconnected chat.

Moving a tool between providers changes its policy identity. Define explicit old-to-new mappings
for semantically equivalent tools and separate mappings for changed scopes/schemas. Preserve explicit
Disabled decisions; never silently carry Run unprompted across a broader operation. Resolve conflicting
old rules deterministically and visibly. Remove redundant catalog entries only with a documented
compatibility outcome for saved settings and external consumers.

## Session Contracts And Independent Operations

On 2026-10-30 the owner asked whether Core's missing session abstraction explains the MCP split,
and proposed examining a common interface without moving session implementation into Core. This
section records the investigation and design boundary. After the explanation, the owner accepted
separate conversation, provider-native session and execution-run identities and requested a record
of the remaining decisions. This approves the responsibility split, not a Core transcript store or
implementation of the unresolved contracts.

Core already has partial session knowledge:

- [WorkspaceOwner](../../../apps/core/src/Haas.Hosty.Core/DevelopmentWorkspaceModels.cs) qualifies a
  session with its application installation and user. For external work, the historical SessionId
  field carries a logical external task ID; that is not evidence of an existing conversation.
- [WorkspaceSessionBinding](../../../apps/core/src/Haas.Hosty.Core/WorkspaceParticipation.cs) records
  attachment, title, activity, sequence and lease metadata. [Activity reports](../../../apps/core/src/Haas.Hosty.Core/WorkspaceSessionActivity.cs)
  distinguish running/waiting/unknown state and require exact stop acknowledgement before releasing
  execution claims. Core stores resource-facing observations, not the conversation transcript.
- [AssistantSessionAuthority](../../../apps/core/src/Haas.Hosty.Core/AssistantSessionAuthority.cs)
  validates the ID's format and current app/user authority. It does not look up or establish a
  provider session's existence or ownership; the provider remains responsible for its private record.
- [Environment context](../../../apps/core/src/Haas.Hosty.Core/EnvironmentPrimitives.cs) contains
  optional session/workspace/job references. [Task execution receipts](../../../apps/core/src/Haas.Hosty.Core/SharedTaskContract.cs)
  contain an optional private session link. The [assistant SDK contract](../../../packages/app-sdk/src/assistant.ts)
  supports a handoff with conversation ID and UI destination, not general session discovery/lifecycle.

The gap is a coherent, independently consumable contract across these partial representations.
The existing [Agent Provider D2-D3](../agent-provider-interface/plan.md#deliverables) already owns
session/run identity, public invocation, inventories and recovery design. Refine that contract and
consume it here instead of creating a competing session provider or reimplementing a model runner.
Its proposed execution inventory is not a shipped Core session registry.

Keep distinct identities for a user conversation, a provider-native resumable session and one
execution run/attempt. Authentication sessions are a fourth, unrelated concept. A conversation can
span multiple runs; native continuation remains tied to its provider/account. None is interchangeable
with a task, workspace, operation request ID or external allocation key. These technical identities
do not require three separate user-facing objects: a chat can remain the conversation surface while
its execution bindings change.

Native resume and reconstruction from retained context are different recovery modes. Losing a native
session need not require losing the user conversation, but visible transcript text alone does not
promise a complete checkpoint. Define retained structured messages/tool outcomes, instruction and
summary coverage, attachment/resource references and reconciliation of uncertain operations before
claiming reconstruction support. Completed tool effects are historical evidence, never requests to
execute again. Current fallback behavior and the proposed recovery contract must remain distinguishable.
[Agent Provider D2](../agent-provider-interface/plan.md#deliverables) owns the public contract;
[Durable Agent Jobs D7](../durable-agent-jobs/plan.md#deliverables) already owns the shared Harness
continuation/context implementation, including ordinary chats. This plan consumes those results.
[Vision decision 61](../../vision.md) remains in force: same-provider/account recovery does not reopen
in-chat provider switching or portable native state. Recovery mode, context guarantees and user
presentation remain decisions under Q2 below.

D1 should specify a qualified session reference (provider application, installation, declared
interface and opaque session ID), a separate execution reference, and optional associations with
workspaces/tasks. Identity and authority come from the authenticated caller, never supplied user
fields or possession of the reference. Define disclosed status, freshness, unknown/unavailable
outcomes, declared control capabilities and confirmed stop evidence through the owning provider.
Core may retain resource associations and observations needed for safe lifecycle. Private messages,
model context, credentials and provider-native continuation state stay with their owning application.
Discovery/status access must not imply transcript access. Core owns the common history exchange
schema under [Conversation History](../conversation-history/plan.md), while providers retain the
source records and their richer native representation. The history API/MCP supplies separately
authorized reads, sharing and search; this extends the minimal-reference direction without moving
private storage or native continuation state into Core.

Do not make that session contract a prerequisite for independent platform operations. Environment
start/stop uses an environment ID, current authority and replay/revision controls; Git uses its
workspace/worktree and head/replay checks; task operations use a qualified task/provider and revision.
Optional session/run context supplies attribution and consumer coordination. An operation that
requires stopping a resource consumer still needs evidence from that consumer's owner, even when
no chat exists. A disconnected provider or missing heartbeat is not confirmed termination.

Harness's development MCP currently requires an active turn in SessionManager before dispatch.
This is a client adapter restriction, not proof that Core resources inherently require a chat.
Core direct MCP and external workspaces already demonstrate sessionless resource access. D2/D3 must
preserve that property while consuming approved session/run contracts where actually needed.

## Independent Environment Lifecycle (Accepted Direction, 2026-10-30)

The owner confirms environment creation, deployment, readiness, access mediation, start/stop/restart
and Finish as Core responsibilities. The existing Core service is the engine; the missing work is
its independent MCP contract and client migration. Harness selects context, submits authorized
requests and presents observations. Neither a Harness installation nor an active chat/agent run is
a prerequisite for an environment operation. Closing or stopping a chat is not itself an environment
Stop or Finish command.

Environment identity and lifetime remain independent of conversations, provider sessions, runs,
tasks and workspaces. Associations identify purpose and consumers; they are not transferable access
grants. Multiple authorized agents may be consumers, but current caller/installation ownership does
not automatically provide cross-application access. Q3 must settle that access model, and Q4 must
settle explicit cleanup/consumer coordination. Preserve existing resource IDs, operation receipts and
consent until an approved migration defines their treatment. External Development D7-D8 own the
direct-client authority and adapter work; this plan owns canonical exposure and Harness migration.

## Task Ownership Decision (2026-10-30)

The owner selected **provider-owned storage with unified MCP access**. Preserve
[vision decision 62](../../vision.md), [Basic Tasks](../basic-tasks/feature.md),
[Task Workspace Coordination](../shared-tasks/plan.md) and
[Harness Work Orchestration](../harness-work-orchestration/plan.md). No task store or model runner
moves into Core; no data migration to a Core task collection is proposed.

Core supplies typed MCP operations over the common task/provider contract: discover providers,
list/read/create/edit tasks, apply lifecycle actions and discover executor choices. Select the
provider through its qualified installation/interface identity, never a hard-coded Harness ID.
Preserve opaque task numbers, revisions, request replay, owner/assignee visibility and current
application/user access. Empty provider discovery is a valid state; do not install or select Harness
automatically. If a provider is absent or stopped, report unavailability rather than presenting a
stale Core-owned copy of its task collection. Other providers remain independently usable.

This is a narrow, intentional extension of the present Core MCP control-plane-only rule: a typed
adapter for a platform-defined provider contract. It is not permission to proxy arbitrary app APIs,
accept arbitrary destination URLs or move app business logic into Core. Update the owning feature
and code comments with the shipped contract. D6 owns this adapter; task stores, executor engines,
hierarchy and workspace-coordination deliverables remain with their existing owners.

The bound `task_result` operation reports against the actual executor/session identity. Keep that
client/executor integration distinct from ordinary task CRUD; generic task authority cannot report
an arbitrary execution's success or replace confirmed native stop. A universal report endpoint,
if needed, must use the common executor contract and authenticated execution identity.

## Feature-Based Settings

Retain two visible group headings with independently expandable rows beneath them; neither heading
is an additional accordion. The accepted initial labels are Hosty tools and Applications. Platform
rows are Host & Core, App management, Logs & audit, Workspaces, Git & pull requests, App creation,
Runtime & development, Test environments, Tasks and Work lifecycle. Tasks identifies the common
Core adapter and the selected data provider. Context remains Harness-owned; do not label private
conversation tools as Core. Applications retains one row per discovered application, with its own
tools; the Harness entry includes its context/executor tools.

Use catalog feature metadata or an explicitly reviewed stable classification, not arbitrary prefix
matching or first-party application IDs. Preserve source identity separately from display grouping.
Show enabled/total counts and effective mixed states; section controls affect exactly that section.
Rename the global control to All enabled tools. Preserve unknown/new tools, incomplete catalogs,
unavailable providers, refresh conflicts, unsaved edits and existing access review semantics.

## Ownership And Existing Plans

- [Conversation History D1-D6](../conversation-history/plan.md#deliverables) owns the public history
  schema, provider extensions, API/MCP sharing/search adapters and indexing compatibility. Core MCP
  D1-D4 integrate its catalog/feature metadata and invocation policy; do not duplicate its history
  implementation. Include a History & search feature row in the Q6 inventory review. Qdrant is deferred.
- [External Development D7-D9](../external-development-workspaces/plan.md#deliverables) owns direct
  environment/publication authority and adapters. Its D10/D12 own the full external journey and
  factual reconciliation. Reuse those deliverables; do not duplicate their engines or acceptance.
- This plan owns canonical catalog and cross-client consistency, migration of Harness's platform
  tool exposure, the common task MCP adapter and feature grouping.
- [Assistant Approval Rules](../assistant-approval-rules/feature.md) remains the invocation-policy
  owner; [Execution Authorization](../assistant-execution-authorization/plan.md) and
  [Development Controls](../app-development-controls/plan.md) retain their separate unbuilt work.
- [Child Core environments](../app-sandbox-runtimes/feature.md),
  [PR lifecycle](../assistant-pr-lifecycle/feature.md) and
  [workspace lifecycle](../workspace-lifecycle-controls/feature.md) retain domain semantics.

## Candidate Platform Contract For Owner Review (2026-10-30)

The owner approved this 2026-10-30 candidate on 2026-10-31, including Q1-Q6 and the
[history contract](../conversation-history/plan.md#candidate-v1-contract-for-owner-review-2026-10-30).
It is the implementation baseline; the historical candidate heading remains a stable link target.
Approval completes D1, not the implementation deliverables below.

### Q1: Qualified References And Provider-Resolved Status

Use `{appId, installationId, key}` for ProviderRef, matching the current task-provider identity.
ConversationRef, NativeSessionRef and RunRef each add an opaque `id` in a separately typed object.
All references are local to the connected Core. Reinstallation changes installationId; no URLs,
paths, native credentials or supplied user IDs determine identity. Revisions are decimal strings.
Reuse history's ConversationRef; do not overload a workspace task/allocation ID as a conversation.

Add the reviewed `agent-sessions` interface, version 1, for minimal execution observation/control.
It can be implemented by current Harness and later independent provider apps without extracting
all agent runners first. Required capability `session.read`; optional `session.list`, `run.cancel`,
`run.events`, `session.resume` and `session.reconstruct`. An execution provider need not provide
conversation history, and a history provider need not expose an execution interface.

Core resolves status on demand through the provider. Persist only references/last observations
needed by resources and operation receipts; no global native-session store or transcript copy.
List results carry per-provider availability/coverage; an offline provider is not an empty list.
Use these Core HTTP/JSON routes and canonical MCP names:

| Route under /api/agent-sessions/v1 | MCP tool | Result |
| --- | --- | --- |
| GET /providers | agent_session_providers | Accessible declared providers and capabilities. |
| POST /sessions/query | agent_session_list | Explicit ProviderRef, optional ConversationRef filter, cursor and bounded metadata. |
| POST /sessions/get | agent_session_get | NativeSessionRef, revision, optional ConversationRef, active RunRefs and capabilities. |
| POST /runs/get | agent_run_get | RunRef, revision, state, observedAt, freshness and stopConfirmed. |
| POST /runs/cancel | agent_run_cancel | RunRef, UUID requestId, expectedRevision; accepted/completed receipt, never assumed termination. |
| POST /runs/subscriptions | no additional MCP tool | Subject-bound SSE metadata subscription with retained cursor; no private text. |

Run state is `queued|running|waiting_for_input|succeeded|failed|cancelled|unknown`.
Freshness is `current|last_known|unavailable`; stopConfirmed is true only after the owning executor
confirms its native consumers exited. Terminal text/state, a missing heartbeat, provider outage or
cancel acceptance cannot release resource claims. Cancel is idempotent with original request ID;
replay rechecks current authority. Use the shared provider-forwarding credential described in the
history plan, scoped to this interface and operation. `session.resume/reconstruct` advertises native
capabilities; performing them remains the conversation/executor owner's command, not history CRUD.

Installed clients need `providers.agent-sessions` plus `core.agent-sessions.read` or
`core.agent-sessions.control`. Direct clients need `mcp:agent-sessions-read`, additionally
`mcp:agent-sessions-control` for cancel, with mcp:read as transport floor. Require the originating
user and provider access; sharing conversation text never grants execution control. The provider
must validate the caller's resource/execution ownership independently. Page default 50/max 200.
The existing administrator boundary for privileged native execution remains unchanged.

### Q2: Resume Automatically, Reconstruct Explicitly

Attempt native resume automatically only for the exact provider installation and connection/account,
using its retained native-session ID and current operation receipt. If the last dispatch outcome is
unknown, reconcile first; never start another run merely because a connection disappeared.

If resume is definitively unavailable, preserve the same chat and expose an explicit Restore context
action. It prepares a reviewable recovery description with included history/summary ranges,
unavailable attachments and native-state gaps; applying it creates a new native session under the
same provider/account, records the old/new binding and resumes in the existing conversation.
No silent cross-provider/account switch and no automatic reconstruction after failure.

Reconstruction requires confirmed previous execution stop and a provider-declared context-import
capability. Preserve the conversation instruction snapshot, latest user request and attributed
structured journal/summary coverage; revalidate current resources, attachments and tool authority.
Do not reinstate historical approvals or execute recorded tool calls. An uncertain external effect
must be reconciled to its original operation before related work resumes. Unsupported import,
missing stop evidence or insufficient required context returns an explicit blocker with chat intact.

Bound the recovery input to the smaller of 32,768 tokens and half the provider-reported input window,
reserving the remainder for tools/output/current instructions. If exact usage is unavailable use a
provider-approved conservative estimator and mark it estimated; without a safe budget do not import.
Keep the latest user request/current constraints first, then recent complete turns, a versioned
summary and retrievable earlier references. The preview states omissions; do not label a partial
reconstruction native-equivalent. Agent Provider D2 owns public semantics; Durable Agent Jobs D7
owns Harness implementation. Environment/history adapters do not wait for that implementation.

### Q3: Environment And Publication Authority

Use the existing Core environment service and resource IDs. The code already has two app-authority
paths: legacy `core.environments.read/manage` for creator-installation requests, and management
`core.environments.inspect/operate` for the current administrator across creating apps. Reuse that
distinction rather than introducing a per-chat ACL or changing legacy grants silently.

| Operation | Installed-app authority | Direct Core authority, plus mcp:read |
| --- | --- | --- |
| List/status/observe own-user environments | core.environments.inspect | mcp:environments-read |
| Create/start/stop/restart/Finish own-user environments | core.environments.operate | mcp:environments-manage + mcp:environments-read |
| Set up test identity or invoke the child's full JSON API | New core.environments.api, with inspect/operate as applicable | mcp:environment-api + mcp:environments-manage + mcp:environments-read |
| Source-mode child build/worktree mounts | Above AND current source/workspace authority | Above AND mcp:workspaces |
| Read publication connections/status/checks/reviews | Existing source authority and the user's provider visibility | mcp:workspaces + mcp:publication-read |
| Push/create/link/ready/update/review-resolution/merge publication | Existing source authority plus new core.publications.write and current user/provider authority | Above + mcp:publication-write |

An environment belongs to the initiating administrator; creator app/principal stays immutable audit
metadata. Under the new canonical path, that user's independently authorized clients/agents can
use it without acquiring the creator app's identity. Other users, including other administrators,
do not gain that user's environment through these tools. Cross-user environment sharing is outside
v1. IDs, original actor/fingerprints and retained operations do not change during migration.

Legacy scoped routes retain their creator/consent constraints and replay identity. Broader inspect/
operate is available only after its existing separate review. Old manage does not turn into operate
or the new arbitrary-API permission. Previously admitted legacy operations can be recovered through
the exact legacy adapter with current equivalent authority; do not manufacture new operations.
The canonical create path preserves trusted-child policy/target/limits checks. Direct grant review
explicitly authorizes the same operator scope; existing one-run/saved app consent remains enforced
where that caller path requires it. Standing authority does not require another prompt for every
read/start; invocation policy still decides Ask versus Run unprompted.

Canonical environment tools remain `environment_consent`, `environment_create`, `environment_list`,
`environment_status`, `environment_start`, `environment_stop`, `environment_restart`,
`environment_finish`, `environment_setup` and `environment_api`. Create keeps current/release/source,
label, UUID requestId, optional registered worktree IDs, limits and initialization. Context contains
optional qualified conversation/session/run/task/workspace references; no active Harness turn is
required. Source project selection must resolve inside an authorized registered worktree. Start,
Stop, Restart and Finish keep environmentId, UUID requestId and expectedRevision; operation status
is returned in environment_status with the original receipt ID and actual process identity/readiness.

Keep `/api/core-environments` and its existing operation routes; add direct credential dispatch to
the same services rather than a second environment engine. `environment_api` accepts only a relative
ordinary child `/api/` JSON path and current child login, never parent credentials, arbitrary origins
or redirects. Sensitive setup/login bodies are neither MCP-policy migration evidence nor durable
replay payloads; existing child-state recovery semantics remain. Shared Docker/trusted Core and
separate test accounts/data remain explicit properties, not claims of hostile-code isolation.

Publication's canonical entry addresses workspace/worktree and an explicitly selected user's source
connection, never a synthetic assistant session. Read may discover available connection choices;
mutation must use an explicit connection ID or the already selected workspace binding, with current
repository permission. Preserve expected Git head, review revision, original requestId and existing
branch/merge/CI checks. A publication-write scope cannot bypass repository rules or the user's
commit/push/merge instruction. A direct credential is never converted into an app service token.

### Q4: Independent Lifetimes And Consumer Coordination

No automatic environment Stop/Finish on chat close, agent completion, task completion or detach.
Workspaces, environments and conversations retain separate IDs/lifetimes. Owner-requested Finish
removes only environment-owned processes/data; never source worktrees or the original conversation.

Register active managed consumers by opaque consumerId, authenticated owner, optional RunRef and
resource ID. A consumer record is usage evidence, not a transferable grant. Stop/Restart/Finish
reject with `resource_in_use` and authorized consumer references while external agent/native claims
are active or unknown. Core-managed child services are the target of lifecycle, not separate vetoes.
The client can explicitly cancel each supported run, observe stopConfirmed, release its own claim
and retry the original resource operation if it was not admitted. An admitted/pending operation
retains its UUID and is observed/replayed unchanged. No timeout, disconnect or chat deletion counts
as confirmed consumer termination, and no new generic force flag bypasses the check.

Expose POST /api/core-environments/{id}/consumers/register and /consumers/release as
`environment_consumer_register` and `environment_consumer_release`, plus the authorized consumer
list in environment_status. Both require environment-manage/operate and the current owning user.
Register takes consumerId (UUID), requestId, expectedEnvironmentRevision and optional RunRef;
Core binds principalId itself and validates ownership of a supplied run. The record contains
consumerId, environmentId, principalId, optional run, revision, observedAt and
`active|stopping|released|unknown` state. Admit registration atomically against lifecycle state;
starting Stop/Restart/Finish and adding a claim cannot race. A consumer must obtain admission
before starting native use. Registering a claim does not create a run or acquire source authority.

Release takes consumerId, requestId, expectedRevision and stopEvidence. A provider-managed claim
requires provider-confirmed stop; a direct native consumer must submit its owner's explicit stopped
attestation after its local processes exit. The latter is audited caller evidence, not proof that
Core controls every OS process. Other clients cannot release that principal's claim. Reconnect with
the same live principal can reconcile it; credentials or principals that are no longer authorized
cannot release it. If its principal can no longer authenticate, the environment-owning administrator
uses POST /consumers/reconcile (`environment_consumer_reconcile`) with the same management authority,
consumerId, requestId, expectedRevision and an explicit operator-confirmed-stop attestation containing
observedAt and reason. For provider-managed consumers Core still obtains native stop confirmation;
for direct native consumers it records the owner's attestation after the owner verifies termination.
This recovery has its own audit receipt and Ask-by-default invocation policy. It is not automatic
on revocation or timeout and does not claim Core independently proved an external process exited.

Create no automatic TTL cleanup policy in v1. Existing separately authorized workspace/retention
cleanup may still invoke Finish through its own workflow after the same consumer checks. A removed
chat detaches references after reconciliation; resource records remain recoverable through Core.
Native clients that bypass registration are not evidence of safe stop; existing privileged external
OS capabilities are not constrained by this MCP contract.

### Q5: Provider-Qualified Task Adapter

Reuse `HostyTaskProviderRef`, `HostyTaskRef`, revision/request DTOs and the six-state task model
unchanged. Add `task_providers`; keep task_options/list/get/create/edit/action names, with explicit
provider on list/create/options and qualified taskRef on get/edit/action. One selected provider can
be saved by the consumer, but Core never chooses the first of several. Missing selection returns
`provider_selection_required`; unavailable providers are explicit, not empty task collections.
No Core task database and no public profile configuration are introduced.

Expose `/api/tasks/v1/providers` and POST `/options`, `/list`, `/get`, `/create`, `/edit`, `/action`
with the same DTOs through ordinary API and MCP. Use current provider discovery/introspection and
the versioned mediated invocation credential; require current user access to provider and executor.
Installed apps need `providers.tasks` and `core.tasks.read`; mutations additionally need `core.tasks.write`;
dispatching/cancelling executor work additionally needs `core.tasks.execute` and applicable
`providers.task-executor`. Direct scopes are `mcp:tasks-read`, `mcp:tasks-write` and
`mcp:tasks-execute` respectively, all with mcp:read. Ready/start that dispatches or a cancel of an
active attempt uses execute; pure Draft editing does not. Existing direct provider-v1 callers keep
their reviewed contract, without silently upgrading that authority into new Core scopes.

`task_result` remains a bound executor/Harness tool. It uses the authenticated execution ID and
original task attempt; generic task-write permission cannot submit another run's outcome. Existing
human complete/review actions remain governed by the provider's ownership/assignee rules and
resultInputRevision. This is separate from native stop confirmation.

### Q6: Canonical Catalog, Settings And Migration

Every tool has a stable Core operation ID, explicit feature key, schema version, server-owned
required-authority descriptor and read/destructive/replay annotations. The classifier below is an
explicit reviewed table, not runtime name-prefix matching. Core's packaged catalog is authoritative;
applications cannot assert a Core feature or gain rights by supplying display metadata.

Preserve existing direct Core tool names. Move platform wrappers to Core using the mapping below;
keep unique meaningful environment/task/PR/workflow names. Harness injects optional current context
as a client adapter and supplies its private context/task_result tools under Applications. Core
metadata/session tools and history tools are defined above and in the history plan. API/MCP schemas
are shared DTO definitions with typed outputs and bounded error results; annotations are not access
control. Source/write/head/replay guards remain the existing domain services' responsibility.
For the remaining moved tools, preserve the existing source/workspace authority and source-owner
checks, including source inventory, merge-upstream, execution selection, activation and workflow
operations. Direct callers use mcp:workspaces; installed callers retain the reviewed workspace/source
permissions of the same domain services. App creation additionally requires existing apps.install
for installed callers or new mcp:app-create for direct callers; app-local ordinary use additionally
requires apps.lifecycle or mcp:lifecycle. Local creation/status/guide cannot imply remote repository
publication, whose read/write scopes above remain separate. Creation returns registered workspace
and explicit client-provided navigation metadata; remove the legacy internal assumption that the
creator has an assistant conversation route. Existing 37 direct tools retain their exact authority;
new names cannot reach privileged service methods through a generic read fallback.
Sensitive read-only families still require their explicit history/session/task/environment scopes;
`mcp:read` or a readOnly annotation alone cannot dispatch them. Missing authority mappings fail
closed. Harness performs migration of its own legacy policy records; Core never discovers an app
by a hard-coded Harness ID or lets another app claim its old provider identity.

Old routes/names remain supported v1 compatibility adapters without a second domain implementation.
New clients receive only canonical catalog entries; old configured clients can resolve the legacy
adapter explicitly. Preserve legacy session filters, response shape and caller boundaries there.
Do not schedule alias removal in this feature: a future versioned removal requires its own reviewed
migration, rather than making compatibility depend on an undocumented date.

Policy migration is transactional and versioned. Match identities using the reviewed old provider,
installation/tool identity and operation mapping, never display text. Preserve Disabled across any
alias path; for conflicting equivalent rules use Disabled > Ask > Run unprompted. Carry Run only
when authority, resource scope and semantics are unchanged; broadened list/cross-chat/resource
operations become Ask and still require their new grants. Existing direct Core settings retain
identity. Unknown/new tools default to Ask; new provider installations do not inherit old authority.
Retain old policy records and a migration receipt for recovery, preserve unsaved edits during refresh,
and verify both legacy and canonical paths enforce the resulting decision. Do not replay tool calls
or resource mutations as part of settings migration.

Settings show headings Hosty tools and Applications, without an extra accordion. Core feature rows
are Host & Core, App management, Logs & audit, Workspaces, Git & pull requests, App creation,
Runtime & development, Test environments, Agent sessions, History & search, Tasks and Work lifecycle.
Applications has one row per declared application provider, including Harness's private tools.
All enabled tools is the global control; row counters and mixed state use actual available entries.
Disabled providers and incomplete catalogs retain their saved rules and visible unavailable state.

### Exact Catalog Baseline And Alias Map

The source baseline contains 37 registered Core tools and 74 Harness development tools.
Every name is accounted for below. This table records semantic operation mapping; legacy argument,
result, session-filter and authorization adapters remain explicit implementations. New history,
agent-session and task_providers tools are specified in their contract tables, not hidden aliases.

| Existing Core feature | Canonical names retained |
| --- | --- |
| Host & Core | `get_host_status`, `restart_core`, `get_core_operation`, `get_core_development` |
| App management | `list_apps`, `get_app`, `start_app`, `stop_app`, `restart_app`, `plan_app_update`, `apply_app_update` |
| Logs & audit | `tail_app_logs`, `search_audit` |
| Workspaces | `prepare_workspace`, `list_workspaces`, `get_workspace`, `rename_workspace`, `acquire_workspace_lease`, `release_workspace_lease`, `delete_workspace` |
| Git & pull requests | `get_workspace_diff`, `refresh_workspace`, `commit_workspace`, `merge_workspace_target`, `abort_workspace_merge`, `record_workspace_pull_requests` |
| App creation | `get_app_development_guide` |
| Runtime & development | `get_app_dev_mode`, `plan_app_dev_mode`, `apply_app_dev_mode`, `get_app_execution_targets`, `select_app_execution_target`, `get_app_execution_selection`, `select_workspace_execution`, `get_workspace_execution_selection`, `configure_workspace_runtime`, `workspace_activation` |

| Legacy Harness tool | Canonical operation / owner | Feature |
| --- | --- | --- |
| `delete_workspace` | Core: `delete_workspace` | Workspaces |
| `workspace_inventory` | Core: `list_workspaces` | Workspaces |
| `participants` | Core: `get_workspace_participants` | Workspaces |
| `commit_review` | Core: `get_workspace_commit_review` | Git & pull requests |
| `execution_select` | Core: `select_app_execution_target` | Runtime & development |
| `execution_status` | Core: `get_app_execution_selection` | Runtime & development |
| `rename` | Core: `rename_workspace` | Workspaces |
| `activation_plan` | Core: `workspace_activation (kind=plan)` | Runtime & development |
| `activation_apply` | Core: `workspace_activation (kind=apply)` | Runtime & development |
| `activation_status` | Core: `workspace_activation (kind=status)` | Runtime & development |
| `activation_list` | Core: `workspace_activation (kind=list)` | Runtime & development |
| `activation_cancel` | Core: `workspace_activation (kind=cancel)` | Runtime & development |
| `activation_resume` | Core: `workspace_activation (kind=resume)` | Runtime & development |
| `activation_return` | Core: `workspace_activation (kind=return)` | Runtime & development |
| `app_dev_status` | Core: `get_app_dev_mode` | Runtime & development |
| `app_dev_plan` | Core: `plan_app_dev_mode` | Runtime & development |
| `app_dev_apply` | Core: `apply_app_dev_mode` | Runtime & development |
| `merge_upstream` | Core: `merge_workspace_upstream` | Git & pull requests |
| `remote_status` | Core: `remote_status` | Git & pull requests |
| `remote_connect` | Core: `remote_connect` | Git & pull requests |
| `remote_fetch` | Core: `remote_fetch` | Git & pull requests |
| `remote_push_base` | Core: `remote_push_base` | Git & pull requests |
| `pr_push` | Core: `pr_push` | Git & pull requests |
| `app_local_status` | Core: `app_local_status` | App creation |
| `app_creation_guide` | Core: `app_creation_guide` | App creation |
| `app_create` | Core: `app_create` | App creation |
| `app_creation_status` | Core: `app_creation_status` | App creation |
| `app_creation_capabilities` | Core: `app_creation_capabilities` | App creation |
| `workflow_status` | Core: `workflow_status` | Work lifecycle |
| `workflow_complete` | Core: `workflow_complete` | Work lifecycle |
| `workflow_resume` | Core: `workflow_resume` | Work lifecycle |
| `workflow_pause` | Core: `workflow_pause` | Work lifecycle |
| `list` | Core: `list_workspaces` | Workspaces |
| `prepare` | Core: `prepare_workspace` | Workspaces |
| `status` | Core: `get_workspace` | Workspaces |
| `diff` | Core: `get_workspace_diff` | Git & pull requests |
| `commit` | Core: `commit_workspace` | Git & pull requests |
| `refresh` | Core: `refresh_workspace` | Git & pull requests |
| `merge` | Core: `merge_workspace_target` | Git & pull requests |
| `abort_merge` | Core: `abort_workspace_merge` | Git & pull requests |
| `references` | Core: `record_workspace_pull_requests` | Git & pull requests |
| `pr_resolve_review` | Core: `pr_resolve_review` | Git & pull requests |
| `pr_commit` | Core: `pr_commit` | Git & pull requests |
| `pr_list` | Core: `pr_list` | Git & pull requests |
| `pr_connections` | Core: `pr_connections` | Git & pull requests |
| `pr_status` | Core: `pr_status` | Git & pull requests |
| `pr_configure` | Core: `pr_configure` | Git & pull requests |
| `pr_publish` | Core: `pr_publish` | Git & pull requests |
| `pr_link` | Core: `pr_link` | Git & pull requests |
| `pr_ready` | Core: `pr_ready` | Git & pull requests |
| `pr_merge` | Core: `pr_merge` | Git & pull requests |
| `pr_complete` | Core: `pr_complete` | Git & pull requests |
| `pr_corrective` | Core: `pr_corrective` | Git & pull requests |
| `task_options` | Core: `task_options` | Tasks |
| `task_list` | Core: `task_list` | Tasks |
| `task_get` | Core: `task_get` | Tasks |
| `task_create` | Core: `task_create` | Tasks |
| `task_edit` | Core: `task_edit` | Tasks |
| `task_action` | Core: `task_action` | Tasks |
| `task_result` | Harness: `task_result` | Applications / owning Harness installation |
| `context_list` | Harness: `context_list` | Applications / owning Harness installation |
| `context_search` | Harness: `context_search` | Applications / owning Harness installation |
| `context_add` | Harness: `context_add` | Applications / owning Harness installation |
| `context_remove` | Harness: `context_remove` | Applications / owning Harness installation |
| `environment_consent` | Core: `environment_consent` | Test environments |
| `environment_create` | Core: `environment_create` | Test environments |
| `environment_list` | Core: `environment_list` | Test environments |
| `environment_status` | Core: `environment_status` | Test environments |
| `environment_start` | Core: `environment_start` | Test environments |
| `environment_stop` | Core: `environment_stop` | Test environments |
| `environment_restart` | Core: `environment_restart` | Test environments |
| `environment_finish` | Core: `environment_finish` | Test environments |
| `environment_setup` | Core: `environment_setup` | Test environments |
| `environment_api` | Core: `environment_api` | Test environments |

The local app creation/local-source and PR/workflow operation names retained here gain explicit
workspace/task allocation inputs for direct callers, using the existing domain request types.
Legacy inferred session inputs are injected only by the legacy client adapter. A mapping is not
permission to drop required actor, branch/head, task attempt or source-connection checks.
`list` retains its original session filter on the legacy surface; canonical list_workspaces uses
explicit filters and current collection authority. `merge` maps to target-branch merge, while
`merge_upstream` maps to a distinct merge_workspace_upstream operation: it uses the reviewed upstream
and preserves its explicit unrelated-history option. Do not collapse these operations or silently
widen the migrated Run-unprompted policy. The source service already distinguishes both kinds.

## Deliverables

- [x] D1. Review and approve the candidate Q1-Q6 contract with its existing feature owners, including the canonical tool/feature inventory, common identities, optional qualified session/run context, environment access/lifetime rules, caller and permission matrix, old-to-new mappings and provider-qualified task adapter contract; preserve the accepted responsibility split and provider storage decision without duplicating recovery implementation.
- [ ] D2. Implement common Core catalog metadata and caller dispatch for approved platform tools, composing existing domain services and External Development D7-D9; verify equivalent supported operations for a direct client and an independently named authorized application without requiring Harness sessions.
  - Implementation started on 2026-10-31: the existing 37 Core tools share an explicit feature and
    authority catalog, versioned MCP metadata, the existing installed-app permission mapping and
    an unmapped-tool invocation guard. New domain adapters and independent-app parity remain
    unchecked under D2; the settings UI and Harness wrappers have not yet migrated.
- [ ] D6. Implement provider-qualified task MCP discovery and operations over the existing common contract, retaining provider-owned records and executor identity; verify independent providers, absent providers, current user/app access, replay, revisions and explicit result/stop semantics without a Harness conversation.
- [ ] D3. Migrate Harness to the canonical platform contracts and retain only its client/executor/context responsibilities; migrate settings, associations and retained operations without losing Disabled choices, granting broader authority, replaying mutations or dropping safe writer handover.
- [ ] D4. Implement the accepted two-group settings layout and feature rows, with precise section controls, actual provider ownership, effective counts and unknown/unavailable catalog handling.
- [ ] D5. Verify Core-only, Harness and independent-application journeys, permission/revocation/recovery behavior and settings migration; document the shipped boundaries and remaining explicitly owned work, then remove this plan and regenerate the index when every deliverable is complete.

## Sequence And Open Decisions

The owner explicitly accepted Q1-Q6 and the linked history/direct-client contracts on 2026-10-31
and requested development. D1 is complete. Implement D2-D6 using this approved baseline; no remaining
contract question blocks those deliverables. Source implementation began on 2026-10-31;
the plan is In Progress.
Provider extraction and broader durable-job work retain their separate Draft status; minimal
reference/status adapters do not wait for a new runner deployment. Each feature retains one branch/
PR and its linked acceptance work; another feature's unfinished deliverables are not completed here.

## Verification

Initial implementation verification (2026-10-31): Core Debug build passed; the MCP and background-grant
filter passed 94 tests. Existing unrelated compiler/analyzer warnings remain. The Core
catalog metadata, empty-registry behavior and unmapped invocation denial are covered through the
in-process HTTP pipeline; this is not a completed managed-sandbox or UI acceptance. D2-D6 remain
unchecked until their complete implementation and owning acceptance pass. Platform version is
0.166.0, above the observed integration target's 0.165.1; the channel declaration matches.
`npm run core:aot` passed on osx-arm64 with no new trim/AOT warnings; its isolated native smoke
reached readiness in 1,049 ms and removed its temporary Core/output afterward. This smoke covers
native startup and anonymous endpoint refusal, not authenticated MCP or the full sandbox journey.
Version consistency, docs-index validation against the preparation baseline and whitespace checks
passed. No commits or live runtime switch were performed.

Documentation-only work runs `node scripts/docs-index.mjs --fix`,
`node scripts/docs-index.mjs --check --base <integration-target-commit>` and `git diff --check`; it needs no runtime
deployment or version bump. This workspace was validated against its prepared main target commit
`9d932d89a50c4c9ac525a6bed2802918c664ce36`; managed repositories need not contain `origin/main`.
Implementation bumps each changed release artifact under repository rules.

Later acceptance must exercise actual Core MCP calls with no standard apps installed, an unrelated
third-party app ID and Harness. Include read-only, missing, wrong and revoked grants, incomplete
catalogs, cross-user/installation substitutions, source access changes and task-provider absence.
Prove denied tools remain denied after catalog migration and feature-level controls never alter an
unselected section. Keep access review and invocation preference independent.

Use a Core-managed child with separate test users/data and normal setup/login for lifecycle and
browser checks. Cover environment create/start/status/stop/restart/finish, lost replies and original
request recovery, readiness and resource removal. Cover Git/PR operations through their owning
external acceptance matrix. Observe private task/session access and executor stop confirmation under
the chosen task design. Run affected Core/Harness tests, exact builds and local integration suites;
record commands, results and platform limits honestly.

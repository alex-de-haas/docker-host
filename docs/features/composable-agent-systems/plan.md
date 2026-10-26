---
status: Draft
created: 2026-10-25
updated: 2026-10-26
summary: Map reusable capabilities for shared tasks, agent participants, decisions and artifact handoffs, with explicit workspace choices, existing owners and memory deferred.
components: [apps/core, apps/harness, apps/plans, packages/app-sdk]
---

# Composable Human And Agent Work

## Goal And Authority

Identify the smallest reusable platform capabilities that let applications compose human and agent
work for an individual or a team. The owner requested this Draft on 2026-10-25, following
[vision decisions 54-56](../../vision.md). The 2026-10-26 clarification narrows the investigation
without approving an implementation. This is a cross-feature investigation and coordination plan;
it authorizes no implementation, experiment, installation, publication or runtime change.

Core remains the application-neutral platform described in
[Core Extension Model](../core-extension-model/feature.md). A capability may consist of a Core
discovery/authority contract and an ordinary application that implements it. Core stays usable
without a particular assistant, task manager, plan source or orchestration application installed.

This plan owns the composition questions, gap ownership and investigation sequence. Existing plans
retain their deliverables, statuses and approval boundaries. It does not revive the retired Core
Extension Model implementation umbrella or duplicate the development-session integration plan.
There is no new feature.md because the proposed composition has not shipped.

## Intended Change

The existing building blocks support authorized applications, tools, conversations, source work,
previews and publication. Extend their composition so users can configure specialized agents,
delegate bounded work, exchange versioned results and involve people at selected decision points.
The same mechanisms should support a small individual setup and richer team workflows.

A persistent agent participant, its configuration/profile, an execution provider, a conversation
and a single run are distinct concepts.
Business roles such as analyst, designer and QA describe responsibilities; they do not become
Core permission roles. People may author skills, configure agents, execute tasks, review outputs or
make final decisions. Those assignments do not imply shared private conversations or credentials.

The development journey below is one acceptance example. Applications may compose different stages,
parallel work, explicit handoffs, event reactions or scheduled work without requiring that journey,
a workspace, a prose plan or an organization hierarchy for every request.

The owner prefers investigating shared task records and persistent agent participants in Core,
with replaceable execution and app-owned orchestration. Task trees and agent organization charts
are independent. A task-provider implementation remains a comparison option, not the default
assumption of this Draft. Basic artifacts and explicit context handoffs are in scope; learned
long-term memory is excluded and remains an [idea](../../ideas.md#i1-memory-as-a-replaceable-provider).

## Capability And Ownership Map

Baseline: repository main at `559e9156bcde07a1e5b47afba39e950d24846b18`; related documents and
question/approval code were rechecked on 2026-10-26. Candidate behavior below is unimplemented.
Existing behavior is linked to its feature document; remaining work is linked to its owning plan.
This inventory is not evidence that a complete autonomous team or a common public API exists.

| Building block | Existing basis | Missing contract or composition question | Owner of the underlying work |
| --- | --- | --- | --- |
| Identity and delegated authority | Core [human accounts](../user-management/feature.md), app identity, reviewed permissions and [background delegation](../continuous-app-access/feature.md). [Workspace membership](../workspace-sessions/feature.md) supports administrator sharing. | A durable agent participant visible across apps, separately from its profile, runtime and initiating human; assignment, attribution and current access must agree. | Existing authority stays with [Agent Providers D3](../agent-provider-interface/plan.md#deliverables) and [Execution Authorization D1-D3](../assistant-execution-authorization/plan.md#deliverables). [Agent Participants](../agent-participants/plan.md) owns the shared identity design; [ordinary-user sessions](../user-agent-sessions/plan.md) remain On Hold and are not this identity feature. |
| Shared tasks and assignments | Plans supplies document/deliverable views; session and worker run records cover their own execution. There is no general Core task contract. | Compare a small Core-owned task record with provider-owned storage under the same observable contract. Include child tasks, participants, resource links and executor-owned extension data. | [Shared Tasks](../shared-tasks/plan.md) owns the common record, executor binding and workspace relationship. Reconcile [Plan Provider](../plan-provider-interface/plan.md) read/progress semantics, [Default Applications](../default-applications/plan.md) selection and Agent Providers invocation; do not turn any existing plan into a second task registry. |
| Skills and standing instructions | [App skill files](../app-provided-skills/feature.md), Harness instructions and local instruction settings exist. Full package delivery has exploratory native-client/bind-mount evidence. | Shared packages, sources, current-content import/update behavior and effective selection. Specify the selected Core pool, profile/default selection and current-file delivery; distinguish always-applied rules from optional skill activation. | [Shared Skills D1-D6](../agent-skills/plan.md#deliverables). [Harness Work Orchestration D1](../harness-work-orchestration/plan.md#deliverables) owns app profiles; package and selection semantics stay there. |
| Discoverable execution providers | Confirmed assistant/speech interfaces and [MCP discovery](../agent-mcp-directory/feature.md); the Harness Worker has a concrete private application API. | A public app-facing model/agent contract with capability/model selection, bounded input/output, caller authority and independently provided execution. Assistant handoff is not that contract. | [Agent Providers D1-D6](../agent-provider-interface/plan.md#deliverables); [Worker acceptance](../assistant-shared-docker-runtime/plan.md) retains its separate scope. |
| Durable invocations | [Worker journals](../assistant-shared-docker-runtime/feature.md), run identities, result/event reads, cancellation and interrupted-run recovery; Core resource operations have replay receipts. | A consuming app must distinguish accepted work, waiting, failure, interruption and completion, reconcile uncertain outcomes and retrieve results without replaying effects. A finished run need not mean its business result was accepted. | Agent Providers D2 owns invocation semantics. [Shared History D1-D4](../assistant-shared-history/plan.md#deliverables) owns conversation recovery/context, not a cross-app task registry. |
| Events and subscriptions | The [Core event bus](../core-event-bus/feature.md) and [workspace observation](../workspace-event-observation/feature.md) deliver refresh hints with state resynchronization. | Durable authorized delivery, cursors, duplicates, retention gaps and app-produced facts where required. Event reception and an authorized command are distinct. | [Notifications D6](../notifications/plan.md#deliverables) owns durable domain-event subscriptions; D7 owns its first delivery-channel consumer. Cross-feature orchestration use is investigated here without expanding those deliverables implicitly. |
| Background jobs and coordination | Background sessions survive a closed tab; PR state has its own observer; explicit background grants exist. | General scheduling, accepted job ownership, retries, concurrency, time/cost budgets and escalation. Neither background sessions nor the Autonomous approval mode supplies a general runner. | [Durable Agent Jobs D1-D6](../durable-agent-jobs/plan.md#deliverables), transferred from Bridge D11 on 2026-10-26. The runner remains an app or authorized client; this plan does not create another scheduler. |
| Authoritative materials and results | Plans reads repository/workspace Markdown; Harness has [session attachments](../assistant-attachments/feature.md); Core exposes source, publication and preview references. These do not form a durable shared artifact catalog. | A minimal described, versioned result and handoff contract, readable source references, authorized search and preservation beyond temporary resources. | [Plan Provider D1-D4](../plan-provider-interface/plan.md#deliverables) owns plan semantics; [Object Links](../object-links/plan.md) owns navigation. [Shared Artifacts I3](../../ideas.md#i3-shared-artifacts-external-references-and-configurable-storage) supplies related ideas. [Shared Artifacts](../shared-artifacts/plan.md) owns minimal result persistence and explicit handoffs; shared-history work retains conversation ownership. |
| Human decisions and shared participation | Core trusted confirmations and Harness question/approval waits exist; [background sessions](../agent-background-sessions/feature.md) notify the initiating operator. Some pending permissions are denied on restart. | Persistent addressed decision requests, an aggregated inbox and response-driven continuation after the native process ends. The existing session card is insufficient. | [Approval Rules](../assistant-approval-rules/plan.md) retains execution-permission semantics; Durable Agent Jobs, Agent Providers and Shared History retain their runner/continuation/context scope. [Shared Decisions](../shared-decisions/plan.md) owns the record; Harness Work Orchestration owns its inbox and routing. |
| Source and test environments | [Workspaces](../assistant-session-workspaces/feature.md), [shared sessions](../workspace-sessions/feature.md), leases, [sandbox/child Core](../app-sandbox-runtimes/feature.md) and [PR lifecycle](../assistant-pr-lifecycle/feature.md) exist independently. | Make reuse the explicit normal path while permitting deliberate independent workspaces, such as an unrelated bugfix and PR. Prevent accidental duplicate allocation without imposing one workspace on every task tree. | [Sandbox remaining acceptance](../app-sandbox-runtimes/plan.md), [Development Sessions D1-D2](../assistant-development-sessions/plan.md#deliverables), [External Development](../external-development-workspaces/plan.md) and [Containment](../assistant-runtime-containment/plan.md) retain scope. Shared Tasks owns task bindings; Harness Work Orchestration coordinates writers without another workspace backend. |
| Evidence and limits | Core audit, resource observations and app-specific operation/run records exist. Child environments have resource ceilings. | Correlate assignments, input/skill revisions, runs, decisions and outputs across owners; distinguish process/container limits from model usage and aggregate workflow budgets. | [Application Resource Policy](../app-resource-policy/plan.md) owns runtime caps; Agent Providers owns invocation limits; Durable Agent Jobs owns job/retry budgets. Cross-owner evidence requirements belong to D3/D4 below. |

## Composition Boundaries To Resolve

### Shared Tasks And Persistent Participants

The preferred candidate gives Core the common task record, current assignments, typed relationships,
authorized reads and state events. Other apps can create work independently of Documents and see
the same child tasks, responsible participants and results. Documents is the intended evolution of
the current Plans consumer, not a claim that this baseline already implements that product.

Keep the common shape small: identity/revision, description, creator/owner, responsible participant,
executor binding, shared lifecycle view and input/result references. The originating app, execution
app and related target apps are different relationships. Compare namespaced, schema-versioned
parameters with executor-owned extra state; another app can inspect shared fields without knowing
private orchestration details. A task may span several runs and a successful run is not acceptance
of its result. Default selection applies to new work, not existing bound references.

Compare provider-owned task storage against the same create/read/observe contract before settling
storage and API details. A common model does not require a common database, but Core ownership can
preserve task history and links when an executor disappears. Orphaned assignments, cancellation,
concurrent updates and late results need explicit behavior in either design. Core records authorized
transitions; applications define decomposition, business checks and completion evidence.

A persistent agent participant is a candidate Core identity with a responsible human, display
identity and explicit permissions. Applications can assign work and attribute comments to it;
its identity need not change with its model/provider. Distinguish that participant from its app-owned
profile and from an ephemeral invocation. Ordinary invocation need not create an account. Do not
simulate a human login with a fabricated email/password or infer execution authority from a role.
An orchestrator's agent hierarchy refers to participants but remains independent of task parentage.

### Agent Configuration And Skills

Investigate a configuration assembled from a provider reference, standing role instructions,
selected skill revisions and execution defaults. Effective tool/source access comes from current
grants, independently of those instructions. A model connection is not automatically a role or a
separate user identity.

The owner's first priority is the common skill pool and delivery, reusable before a team coordinator
exists. Candidate profiles may combine analyst/design guidance, repository conventions and
application-specific skills such as .NET, Next.js or React. Establish who selects or changes those
sets and how a run records its effective configuration.

Shared Skills' 2026-10-26 decision selects one administrator-managed Core pool, app-owned profile
references/defaults and delivery of current installed files. Decision 59 removes session pinning
and historical package retention; deletion stops delivery without blocking creation/resume. Model/provider
connections do not select separate sets. Native filesystem/bind-mount delivery remains; clients
control rediscovery and export/migration contracts are still Draft. Git changes are
detected for manual apply; app packages update with the app. Multiple full app packages replace the
single-file contract. Package editing, personal pools and automatic Git updates are outside the first
slice. Decision 60 also excludes manual uploads: Git and app packages are the initial sources,
private Git reuses Source connections and migrated consumers do not repeat content-digest acceptance
on updates. Harness Work Orchestration owns profiles/instructions, not another package pool.
The selected [package/catalog contract](../agent-skills/plan.md#selected-package-and-catalog-contract-2026-10-26)
defines agent.skills key/path declarations, source/skill records and stable profile references
without historical revision bindings or a new Node.js/skills CLI dependency. API validation, runtime publication and migration acceptance remain with that owner.

### Commands, Events And Rules

An event reports a fact, a command requests work, and a rule decides whether a fact warrants a
command. For example, a plan provider can report acceptance of revision 7; a coordinator can request
implementation against that revision using the selected executor and authority.

Compare explicit calls, application events, webhooks/hooks and schedules as ways to initiate the
same bounded operation. An interested app such as Documents should observe authorized task
changes without repeatedly polling each task. Subscriptions need current access checks, producer
authority, revisions, recovery positions and explicit gaps. A UI can reconcile current state; an
automation that depends on a transition needs durable delivery and idempotent consumption. Commit
the source change and its pending event consistently under their owner. Notifications to people
are a consumer of these facts, not the event contract itself.

Do not select a transport, universal event schema, visual workflow editor
or general event-sourcing rewrite in this Draft. Existing refresh streams remain useful where
re-reading durable state is sufficient; transition-dependent consumers need the durable contract.

The integration examples must explain accepted-command identity, receiver-owned state, duplicate
delivery, a lost response, cancellation, stale inputs and permission changes. Retrying a delivery
does not guarantee exactly-once external effects. Sender and receiver must reconcile the existing
operation before deciding whether another execution is appropriate.

### Workspace Reuse And Explicit Independent Work

Prefer passing an existing workspace binding when delegating related source work. Investigate
inherited bindings or an explicit execution scope so concurrent requests can atomically resolve
one authorized allocation. The exact scope/key and task-reparenting semantics remain open. A retry
or a child task must not accidentally create a different workspace or silently replace the binding.

The owner explicitly withdrew a blanket one-workspace-per-task-tree restriction on 2026-10-26.
An unrelated defect discovered during feature work may need its own workspace, target branch and
PR. The coordinator can ask a person whether to prioritize it or treat it as a hotfix, then request
an explicit independent binding within current authority. Keep its discovery/task relationship and
resource choice observable; whether it is a child or related root is a workflow choice. Do not
assume cherry-pick support or mix unrelated changes merely to preserve a single workspace.

Core can enforce chosen bindings, idempotent allocation, current membership and lifecycle rules;
the orchestrator coordinates writers and integration. Several private sessions may share a workspace.
Shared source does not imply shared transcripts, safe concurrent edits to one file or extra access.
No workspace is required for ordinary tasks. Tasks, sessions, workspaces and sandboxes retain
independent lifetimes; task completion alone does not delete source or temporary resources.

### Basic Artifacts And Explicit Context Handoffs

Include a small shared-artifact capability in the current investigation. Typical outputs are a
review summary, report, prepared documents or a reusable script; people may also contribute input
materials. Explore identity/version, name, description/type, author, origin task/run, access scope
and content or an authoritative content reference. Basic save, find/list and read through an
app API and agent tools should support handoffs; storage placement and the exact MCP surface remain
open. Navigation-only Object Links and session-local attachments do not already supply this contract.

An initial handoff can be a bounded summary plus references to the exact output versions and any
unresolved work. A coordinating agent reads the permitted results and continues without inheriting
the child's entire conversation. Shared context means explicitly selected materials for a task,
workspace or handoff; session context remains owned by that session. A workspace groups sessions
but does not establish a parent/child conversation model or a common transcript.

Keep source identity separate from location. A repository document reference needs repository,
relative path and revision; a workspace working copy is a distinct version context. An app-owned
document uses its owner's identity/version. Preserve the approved input when resolving a working
copy rather than silently replacing it with changed content. Reading, navigation and injection
into model context remain distinct authorized operations.

Retained results must survive their producing process and the relevant workspace/sandbox cleanup.
A temporary path alone is not durable storage. Verify saved bytes or a deliberately retained source
before reporting a successful export, and retain unavailable-source outcomes. Keep first-slice
permissions and a clear retention contract; defer elaborate session/workspace/global artifact tiers,
automatic promotion, indexing engines and storage-provider selection until a concrete need exists.
An agent or configured workflow selects useful outputs to save; no blanket capture of every file,
log or conversation is selected. Saving or finding a script does not authorize executing it.

Long-term learned memory is outside this plan and is not a prerequisite for artifacts, context or
skills. [Memory I1](../../ideas.md#i1-memory-as-a-replaceable-provider) retains the later possibility
of remembering preferences or recurring decisions. No automatic extraction, preference learning or
silent reuse of earlier permission decisions is included. Standing instructions and explicit skills
remain available without a memory service.

### Decision Requests And Resumable Waiting

Investigate a persistent shared decision request, preferably a Core record, that can be presented
outside its originating session. It identifies the requesting participant, authorized respondent,
question/response shape, related task/session/material versions and attributed resolution. An
ordinary application can provide a Decisions tab alongside tasks or artifacts, or another client
can present the same request. Packaging remains open; dismissing a notification does not resolve it.

A participant's responsible human is a candidate default recipient. Project/role routing and
escalation belong to the coordinator; the actual recipient and authority are explicit in the
request. A personal setup may route all decisions to its owner; a team may route QA questions to
its human QA reviewer. This neither imports an organization chart into Core nor shares private
session history. Review materials must be sufficient and separately accessible to the respondent.

Persist the wait and continuation before presenting the question. A quick answer can reach the
live execution; after a configurable resource-wait period, park the work and release only confirmed
stopped consumers. Preserve the question and recoverable context/checkpoint. A saved answer produces
a durable continuation request consumed by the owning executor/runner, which revalidates authority
and resumes natively where supported or reconstructs from recorded context. Hidden model state is
not promised portable. Pending decisions must not disappear through ordinary idle-session retention.

The resource-wait period is distinct from decision expiry; silence grants no consent. An answer
arriving during parking, repeated delivery, restart or a stopped executor must not lose the answer
or start competing continuations. Persist unresolved continuation outcomes and make failure visible.
Cancelled work must not revive after a late answer. Changes to reviewed inputs can invalidate a
decision. Only dependent work waits; unrelated tasks may continue under the coordinator's policy.

Questions, business acceptance and execution-permission requests can share an inbox while retaining
their owning enforcement rules. Current Harness permission waits can expire or be denied on restart;
this proposal does not make those old grants transferable or replayable. Acceptance of a plan does
not silently authorize commits, merge, deployment, broader access or spending.

### Ownership Boundary

Core remains neutral about business roles, organization charts, task decomposition and orchestration
code. Common task/participant/decision records are preferred investigation candidates, not shipped
models. Providers retain execution and session context; source owners retain their documents.
[Shared Artifacts](../shared-artifacts/plan.md) now owns the basic artifact contract and its storage decision. Existing event, provider, source,
approval, history and job plans retain their deliverables; the umbrella coordinates their seams.

## Separate Owners And Initial Packaging (2026-10-26)

The owner requested separate Draft plans for the missing blocks. Initial organization UI and policy
are proposed inside Harness, avoiding a dependency on new cross-app UI composition. A separate
Organization app and its name remain open. Shared APIs must remain consumable independently.

| Priority | Owning plan | Boundary |
| --- | --- | --- |
| 1 | [Shared Skills](../agent-skills/plan.md) | Existing owner of packages, sources, delivery and effective selection; profile/default selections and current-content delivery are specified there. |
| 2 | [Agent Participants](../agent-participants/plan.md) | New persistent identity, attribution and responsible-human contract; app profiles are separate. |
| 3 | [Agent Providers](../agent-provider-interface/plan.md) | Existing public invocation owner; models, runs and capabilities, not scheduling. |
| 4 | [Shared Tasks](../shared-tasks/plan.md) | New common records, assignments, child visibility, executor and workspace bindings. |
| 5 | [Notifications D6](../notifications/plan.md#deliverables) | Existing durable-event owner; design alongside tasks rather than a second bus. |
| 6 | [Shared Artifacts](../shared-artifacts/plan.md) | New minimal described/versioned results and explicit context handoffs. |
| 7 | [Shared Decisions](../shared-decisions/plan.md) | New addressed requests, resolution and durable continuation handoff. |
| Execution foundation | [Durable Agent Jobs](../durable-agent-jobs/plan.md) | Former Bridge D11; build with invocation/events, then integrate parked decisions. |
| Composition | [Harness Work Orchestration](../harness-work-orchestration/plan.md) | App profiles, optional hierarchy, coordination and first joined UI/journey. |

These are priorities, not a strictly serial build order. Shared History retains session context;
resource, permission, provider and notification plans keep their own deliverables and status.
The new plans are Draft. This umbrella retains only cross-feature boundary review and integration
examples; assigning owners does not complete their implementation or the umbrella's open questions.

The first joined case is Documents -> one shared task -> one Harness agent -> one artifact and
decision -> parked continuation -> an observable result in Documents. The Harness plan owns that
application acceptance; the umbrella compares it with non-development and individual compositions.

## Proposed Investigation Order

This order prioritizes design work, not implementation approval or a delivery date. Existing feature
owners can progress independently within their authorized scope.

| Order | Investigation | Exit evidence and dependencies |
| --- | --- | --- |
| 1 | Shared skills and common identities | Keep the skill pool as the owner's first priority. Alongside it, distinguish task, participant, profile and invocation identities so later contracts do not confuse them. Apply Shared Skills' selected Core-pool/profile/session boundary and resolve its remaining export/migration details. |
| 2 | One task, one executor and authorized observation | Compare Core-owned and provider-owned tasks with the same consumer example. Connect Agent Providers invocation and Notifications D6 observation; explain accepted requests, assignments, state changes and recovery before adding a team hierarchy. |
| 3 | Minimal artifacts and a handoff | Specify a summary plus described/versioned output references, basic discovery/read/save and a clear lifetime. Reconcile Plan Provider, Object Links and existing source/attachment contracts. No learned memory or artifact tier system is required. |
| 4 | Durable decisions and continuation | Compose addressed decision records with Agent Providers, Shared History and Durable Agent Jobs. Compare quick response with overnight parking, restart, lost/repeated events and resource release. Keep permission approvals under their current authority owners. |
| 5 | Shared work and deliberate exceptions | Review all compositions and variations below, including ordinary workspace reuse, a separate bugfix workspace/PR and artifacts consumed after cleanup. Reconcile the separate Draft owners and propose bounded contracts for explicit approval. |

Authority, retention and failure behavior are reviewed from the first consumer, not deferred to the
last step. These are investigation priorities, not a requirement to complete every feature in one
release. Non-development work does not depend on Git or sandboxes. Administrator-only acceptance
does not complete ordinary-user access or agent-participant authorization. Existing owners can
progress independently within their approved scope.

## Example Compositions For Design Review

### Development With Iterative Acceptance

A person supplies an idea and use cases. An analyst prepares a plan while a designer supplies
mockups and a concise explanation. The person reviews both; the agents reconcile requested changes
before the approved revision becomes eligible for implementation. A developer implements it,
functional and visual QA compare the result with the accepted inputs, and the operator receives
a sandbox preview and evidence for final acceptance.

The same test environment and prepared data can be reused during corrections. A human QA specialist
may configure the QA agents, own project-specific scenarios and accept their work. PR creation,
review and merge follow the repository and configured publication authority; merge and production
deployment remain separate actions. Export useful evidence before Finish. This is a configurable
example, with optional stages and chosen participants, rather than a prescribed platform pipeline.

Documents initially creates one task with an approved input reference. The responsible participant
may create visible child tasks and assign other participants. Delegation normally passes the chosen
workspace; each worker may have its own session. A reviewer returns a summary and versioned reports
for the coordinator to consume, rather than requiring shared conversation history.

Design-review variations:

- Two agents concurrently request the inherited workspace: recover one allocation, without silent
  duplicate creation. An intentional unrelated bugfix instead receives an explicit independent
  workspace and PR; a decision can settle urgency or hotfix targeting before execution.
- A QA question reaches its human reviewer while that person is asleep. Park only dependent work;
  after a response and executor restart, consume the decision and continue from retained state.
- A useful script and report remain discoverable by an authorized later task after the original
  workspace closes. Their origin, version and applicable execution requirements remain visible.

### Recurring Research With Editorial Review

A schedule or explicit request starts research over selected sources. A writer produces a report;
a reviewer checks evidence and a person accepts it or requests changes. Results retain source and
revision references, while incomplete research and budget exhaustion stay visible. This composition
uses no Git repository, development workspace or application sandbox.

### Small Individual Setup

One user selects skills for one agent and invokes it directly. It can return an answer or an artifact
without creating a team, organization chart, shared workspace or recurring job. Optional additional
roles and automation must not make this basic composition depend on unused applications.

## Deliverables

- [ ] D1. Review the capability map against the three example compositions and their variations, including an independent consumer/provider example; agree the minimum shared boundaries and optional app-owned behavior without requiring new implementation for this investigation.
- [ ] D2. Review the assigned owners and cross-feature boundaries for shared tasks/executor bindings, persistent participants, role/project skills, artifacts/context and decisions. Compare compatible composition alternatives; detailed contracts and implementation remain in the linked owner plans.
- [ ] D3. Produce integration-level request/result and handoff examples covering actor authority, revisions, observable child tasks, inherited versus explicit workspace bindings, artifact preservation, quick versus parked decision waits, duplicate/lost delivery and restart recovery.
- [ ] D4. Define acceptance evidence for the three compositions and their variations, including concurrent workspace requests, an independent bugfix/PR, overnight decisions, post-cleanup artifact reuse, stale input/approval handling, cancellation, failure/budget reporting and the app-neutral Core baseline; distinguish verified primitives from assumptions.
- [ ] D5. Reconcile investigation order and dependency/ownership with existing plans, keep learned memory outside this scope, present a bounded proposal for explicit owner approval and route selected implementation work to its owning plan without implicit status changes.

## Open Questions

- Which task, participant and decision fields need a Core-owned contract? Compare the preferred
  Core records with provider-owned tasks using the same cross-app read/observe example. What
  remains possible when the executor is unavailable or removed?
- How do participant identity, responsible-human routing and execution credentials fit existing
  users/app grants without simulating a human account? How do app-owned profiles reference the common skill pool
  and deliver current selected packages through native exports without mixing profiles?
- What binding/allocation scope prevents accidental workspace duplication while allowing a
  deliberate independent bugfix? How do reparenting, reassignment and existing consumers affect it?
- What is the minimum artifact ownership, description/version, storage, retention and save/read/find
  contract? How do authoritative document revisions resolve into workspaces without changing the
  reviewed input? Defer lifetime tiers and semantic indexing; learned memory is excluded.
- Which transitions need durable subscriptions and which views can reconcile current state? How
  do app-produced events fit Notifications D6 without a duplicate event implementation?
- How are waits registered, parked and resumed for each executor capability? Define response/parking
  races, decision expiry, stale resolutions, respondent access and missing continuation owners.
- Which task/decision/artifact views should the first consuming app combine? Packaging and business
  orchestration remain open, with independent clients and providers as design cases.

## Verification And Completion Boundary

For this documentation change, run `node scripts/docs-index.mjs --fix`,
`node scripts/docs-index.mjs --check` and `git diff --check`. Review relative links, current owners,
Draft/On Hold boundaries and stable deliverable IDs. No build or runtime deployment is required.

For the proposed investigation, review the examples against duplicates, lost responses, restart
while waiting for a person, revoked access, changed skill/input revisions, partial failures and
exhausted budgets. Confirm that a receipt proves acceptance of a request rather than completion,
and that a successful model run is distinct from independently verified work. Confirm empty-registry
Core use and an unrelated third-party application identity remain supported design cases.

Review duplicate workspace allocation separately from intentional independent work; task-tree
relationships alone must not force one workspace or grant source access. Cover a decision response
during parking, an executor unavailable at response time, revoked respondent rights and late answers
after cancellation. Verify proposed artifact lifetimes against cleanup, unavailable originals and
cross-user search/read denials. Check every example remains useful with no memory service installed.

Any future runtime experiments need their own approved scope and the existing managed-workspace
and sandbox workflow. This Draft does not claim live provider, browser, remote-preview, security
isolation or autonomous-team acceptance. Completed foundational implementation remains documented
by its feature owner; this umbrella must not absorb their unfinished deliverables to claim completion.

## References

- [Platform vision](../../vision.md) decisions 52-56 and
  [collaboration/QA ideas](../../ideas.md#i14-collaboration-and-qa-as-optional-compositions).
- [Paperclip delegation](https://docs.paperclip.ing/guides/org/delegation/),
  [execution policies](https://docs.paperclip.ing/guides/power/execution-policy/) and
  [heartbeats/routines](https://docs.paperclip.ing/guides/projects-workflow/routines/) are research
  references for role-based work, review and activation. They do not select Paperclip integration,
  its organization model or its protocols for Hosty.
- [Paperclip Decisions](https://docs.paperclip.ing/guides/day-to-day/decisions/) is a reference for
  aggregated human attention, version-sensitive choices and response-triggered wakeups.
- At Paperclip commit `1fbbef45a8d399771add7a27a04b12f3a20e264c`, its
  [live-event service](https://github.com/paperclipai/paperclip/blob/1fbbef45a8d399771add7a27a04b12f3a20e264c/server/src/services/live-events.ts)
  uses a process-local emitter, and its
  [UI reconnect path](https://github.com/paperclipai/paperclip/blob/1fbbef45a8d399771add7a27a04b12f3a20e264c/ui/src/context/LiveUpdatesProvider.tsx#L2158-L2178)
  reconciles queries because that stream does not replay events. This inspected path is a reference
  for UI convergence, not proof of durable Hosty automation. Study existing approaches before choosing
  new transports; no Paperclip code is copied or integration selected by this documentation change.

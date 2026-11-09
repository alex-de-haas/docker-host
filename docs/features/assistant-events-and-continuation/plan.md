---
status: Draft
created: 2026-10-29
updated: 2026-11-07
summary: Bind application activities and delegated results to assistant conversations with authorized events, observable continuation and recoverable context.
components: [apps/core, apps/harness, apps/desktop, apps/shell, packages/app-sdk, packages/app-sdk-dotnet]
---

# Assistant Events And Session Continuation

## Goal And Approval Boundary

Let a compatible assistant continue the correct conversation when an application reports a relevant
event or a delegated task returns a result. An interactive activity fixture and a parent awaiting delegated
work are the two initial runtime acceptance examples. Neither needs continuous model calls while
waiting. A Dependabot review routine is an additional contract-design example: it can create work
when no recipient conversation exists yet, then resume that work after CI or a human decision.

On 2026-10-29 the owner requested this separate Hosty plan, links to existing owners and an update to
the independent Hosty Chess plan. This is documentation-only authorization. The plan remains Draft;
no implementation, provider execution, commit, publication or live activation is approved here.
It scopes the assistant-facing connection between existing capabilities, not a second event bus,
task system, transcript store or scheduler.

On 2026-11-07 the owner withdrew the independent Hosty Chess application plan. This platform plan
retains its generic interactive-activity and delegated-result contracts. Interactive acceptance uses
a bounded domain fixture; shipping a standalone chess application is no longer a dependency.

## Local Delegated-Result Transfer (2026-11-04)

[Profile-Based Task Delegation](../profile-task-delegation/feature.md) receives the first same-Harness
task-child result producer, parent wait, local outbox/inbox and bound continuation from D3/D5, with
early/duplicate/late-result and restart acceptance. It reuses current session command/parking/resume
primitives. This local consumer does not need the general cross-application notification transport
and does not build a second session engine. Its Ready C4/C6 contracts specify transactional
result delivery and typed task barriers, including busy/parked parents and coordinator replacement;
the owner has requested documentation readiness only, not implementation.

D3/D5 here retain the public event-to-session adapter and independently provided delegated results
over the negotiated durable transport. Notifications D6 and broader session recovery remain
prerequisites for those remaining consumers. The transfer neither ships them nor selects a second
delivery path for the same result; all paths must preserve correlation and deduplication.

## Current Baseline And Proposed Change

The baseline is repository main at `fee7bece4b6b50810c929a7ea6daee8e31c56664`; the inspected local Core
reports 0.163.0. Existing behavior and proposed additions are distinct:

| Existing behavior | Addition proposed here |
| --- | --- |
| [Desktop assistant panels](../desktop-shell/feature.md) open an empty app-context draft and retain the conversation for that window. Opening does not start inference. | An explicit, durable binding from an application activity to a selected assistant conversation, independent of a window's lifetime. |
| [App context](../assistant-app-context/feature.md) supplies selected application metadata; it is not tool authority. | Versioned activity references and authorized state retrieval, such as one user's particular interactive activity. |
| [Assistant handoffs](../provider-consumption/feature.md) accept app-originated draft preparation; provider-originated v1 handoffs remain draft-only. | A separately negotiated event-input and continuation capability with explicit activation policy. Existing draft behavior stays compatible. |
| [Basic Tasks](../basic-tasks/feature.md) persists task dispatch and explicit execution results. | An authorized result can reach a registered parent wait and cause one eligible continuation in its existing conversation. |
| [Core event bus](../core-event-bus/feature.md) carries ephemeral refresh hints. | Consumption of the durable delivery owned by Notifications D6, with receipts and recovery rather than relying on an open browser stream. |

A provider's native subagent mechanism remains provider-owned. Its final result can already be an
input to its parent within that runtime. Hosty must not also inject the same completion through this
contract. Cross-application delegation needs the explicit correlation and delivery described below;
it does not require importing a child's entire transcript or implementing a full organization tree.

## Ownership And Dependencies

| Owner | Responsibility retained there | Seam owned by this plan |
| --- | --- | --- |
| [Notifications D6](../notifications/plan.md#deliverables) | Authorized durable producers/subscriptions, retention, replay cursors, gaps and at-least-once delivery. | Assistant event vocabulary, recipient bindings and consumption/continuation receipts. |
| [Durable Agent Jobs D7](../durable-agent-jobs/plan.md#deliverables) | Idempotent Harness session commands, provider/account-bound continuation and bounded recoverable context, including ordinary chats. | Map an eligible inbound event to that common session command, once, with visible provenance. |
| [Durable Agent Jobs D1-D5](../durable-agent-jobs/plan.md#deliverables) | General jobs, scheduling, retry policy and parked waits. | An interactive activity can use a session without acquiring a job or schedule; durable job waits consume the same event contract. |
| [Action Summary D4](../assistant-action-summary/plan.md#deliverables) | Correlated native invocation evidence in the existing Harness journal. | Link external receipt/causation IDs to existing run evidence without a second transcript. |
| [Agent Providers D2-D5](../agent-provider-interface/plan.md#deliverables) | Public engine invocation, native capability mapping and independent provider applications. | Assistant capability negotiation above that engine boundary; public engine extraction is not required for the first internal Harness adapter. |
| [Profile-Based Task Delegation](../profile-task-delegation/feature.md) and [Harness Work Orchestration D7](../harness-work-orchestration/plan.md#deliverables) | Flat task decomposition/routing and the first local wait consumer; richer selected material access stays with D7. | Cross-application result-to-parent exchange over the negotiated transport, preserving the existing local correlation contract. |
| [Shared Decisions](../shared-decisions/feature.md#durable-native-waiting) | Addressed question/response records and consistent publication of their resolution. | A resolved-decision event can satisfy its correlated wait; event delivery is not approval or proof of resumed execution. |
| [Panel System](../sdk-panel-system/feature.md) and [UI Composition](../sdk-ui-composition/feature.md) | Verified provider presentation, retained frames and navigation. | Connect a selected activity to its assistant presentation; browser view/presentation IDs are not domain identity. |

Cross-links do not approve or complete another owner's deliverables. Notifications D6 and Durable
Agent Jobs D7 remain prerequisites, not work silently absorbed here. Agree their delivery sequence
or an explicit scope transfer before Ready; do not split their features into partial PRs to bypass
the repository's one-feature/one-PR rule. Full scheduling, hierarchy, shared profiles, learned memory,
cross-provider session migration and a generic agent chat network are outside this plan.

## Domain Independence And Implementation Priority (2026-10-29)

The owner clarifies that events can originate from unrelated domains. Interactive actions, delegated results,
PR changes and decision answers are examples, not a closed event catalog or a required workflow.
The common contract uses an authenticated source, versioned event type, subject/resource reference,
opaque revision where relevant, stable event identity and causation/correlation. The producer owns
its payload schema and domain validation; a GitHub head SHA, game ID or task state is not a mandatory
field in every event. Schema/version negotiation and bounded payloads still apply to new types.

Subscription/routine filters must be compatible with the selected source schema and current access.
Do not encode Dependabot, PR status, an interactive action or a first-party app identity into Core's generic
delivery/admission policy. Native transports such as webhooks, periodic observation and direct app
publication feed the same contract. A consumer can target an existing activity binding or an
application-owned routine activation that creates work; no universal live-chat prerequisite exists.

[Harness Pull Request Inbox](../harness-pull-request-inbox/feature.md) owns repository discovery
derived automatically from installed applications and its independent browsing surface. Its view is independently useful without durable events,
routines or decisions. The owner now selects that PR browsing feature first, with a detailed page
and compact list-only panel. Its technical plan is Ready under the owner's 2026-10-29 instruction;
implementation remains unstarted. This does not select live PR automation or replace this plan's two
initial acceptance examples; the first live event producer still needs its own scope decision. D1 must compare a minimal
non-PR producer/consumer exchange alongside the PR example so the design remains domain-neutral.

## Three Separate Operations

1. **Deliver a fact.** Authenticate its source, persist its identity and route it to an authorized
   binding. Delivery can happen while the recipient is offline and does not itself call a model.
2. **Admit continuation.** The assistant app checks binding policy, current access, session state,
   correlation, revision and budget. It can queue, park, reject or start one bounded turn.
3. **Observe execution and effects.** The assistant adapts the accepted input to its native provider;
   domain tools validate any proposed action independently. A finished turn is not proof of a valid
   domain action, an accepted business result or a completed user goal.

Core supplies generic discovery, authority and the linked durable-domain-event infrastructure. It
does not select prompts, own conversations, run model loops or infer a recipient from a first-party
app name. Assistant apps own bindings to their private conversations, event inboxes, admission and
session adaptation. Domain apps own facts, object revisions and effects.

Preserve the owner direction that agent messages flow directly between authorized consumers and
providers, not through a Core chat relay. Durable domain envelopes carry bounded facts, correlation
and protected resource/result references. Private prompts, transcripts, native state and arbitrary
agent-to-agent messages stay with their owners and are fetched or sent directly under explicit
access. Source validation is independent of content: authenticated app text is still external input,
not a system instruction or a new user authorization.

## Activity And Conversation Binding

Proposed identity fields are design vocabulary, not implemented SDK types or accepted permissions:

| Concept | Required meaning |
| --- | --- |
| Activity reference | Core identity, source application installation, app-owned activity type/ID and owner resolved under authenticated access. A game ID alone is insufficient. |
| Assistant reference | Discovered provider installation and advertised compatible capability/version; IDs remain opaque. |
| Binding | Assistant-owned opaque handle connecting one activity and an authorized user to a private conversation, with revision, permitted event types, activation policy and lifecycle. |
| Native session/run | Private provider/account-bound execution identities, distinct from the conversation, binding and task. |
| Wait reference | Persisted expected source/task/attempt/result relationship, continuation owner and cancellation generation. |

Creating or attaching a binding requires destination-session access. An app cannot send to an arbitrary
conversation by guessing its ID or supplying a user ID. Shared task/workspace membership, a profile,
an administrator role or app-context metadata does not grant private transcript access. Do not expose
more recipient metadata than the producer needs. Revalidate access on binding, delivery, context
read, admission and effect; uninstall/reinstall invalidates old installation references.

Opening an assistant panel may prepare context and a draft, but stays inference-free. A deliberate
Start/Play action can authorize a bounded recurring response to specified activity events. Its
scope, pause/stop control and limits are visible. Record this authorization once and reuse it within
its scope; do not ask again for every authorized activity turn. Merely receiving an event is never that authority.

Proposed v1 binds one activity to one selected conversation; reopening and multiple views resolve the
same binding. Switching the focused app, starting a new match or selecting another provider must not
silently retarget an existing run. Close, pause, detach and delete have distinct documented meanings.
The first implementation may support only interactive authority. Any continuation after that authority
expires parks for reauthorization; unattended use needs the existing background-grant contract.

## Event Envelope, Receipts And Recovery

Specify a versioned envelope with a stable producer event ID, authenticated source installation,
event type, activity/resource reference and revision, occurrence time, correlation/causation IDs,
and bounded facts or protected result references. Destination binding and subscription are authorized
routing records, not a producer-selected arbitrary session. Event names such as `activity.turn_ready`
and `task.execution_settled` below are illustrative, not registered platform contracts.

Use the owning application's transaction/outbox boundary, or an equally explicit recovery protocol,
to keep accepted state and pending publication consistent. After delivery, persist the assistant
inbox receipt before acknowledging the transport. Deduplicate by authenticated source plus event
identity, and reuse one stable continuation-command ID for that receipt. Reconcile uncertain command
acceptance with D7 instead of starting a second run. Transport retry does not authorize inference retry.

Expose distinct evidence for source accepted/pending publication, delivered, durably received,
queued or parked, incorporated into context, continuation accepted/running, and its terminal/unknown
outcome. Link a domain-effect receipt separately. Delivery acknowledgements must not say that the
agent answered or that the requested effect happened. Bound retention and preserve enough correlation
to recover accepted work; the exact storage and expiry policy must be settled before Ready.

Ordering is per binding/resource where needed, not a promise of global order. Re-read authoritative
state on revision gaps and before effects. A retention gap requires explicit reconciliation or a
visible unresolved outcome; it must not silently discard a child result. State invalidations may
coalesce only when their meaning permits it. Answers, terminal results and distinct user actions
cannot be collapsed as generic refresh hints. Use at-least-once delivery and idempotent effects;
do not promise exactly-once model execution across a provider with uncertain start evidence.

## Continuation Policy And Context

| Recipient state | Proposed default |
| --- | --- |
| Idle with an active matching authorization | Admit one bounded turn after revision/correlation and budget checks. |
| Running | Queue for the next safe turn boundary; do not silently interrupt or start a competing run. Native steering is an optional later capability, outside initial acceptance. |
| Waiting for this delegated result | Durably satisfy that wait and enqueue its continuation. A wait is registered before dispatch so a fast child cannot win the registration race. |
| Waiting for human approval or a different answer | Retain unrelated input without treating it as an answer or bypassing the wait. |
| Paused, cancelled, detached or ended | Record/suppress according to policy; no automatic revival. Late results remain attributable. |
| Offline, expired authority, unavailable provider or exhausted budget | Preserve pending/unknown state and expose a usable recovery action; no silent provider/account substitution. |

Map an event to an attributed application observation or other supported native input. Use a tool
result only when it satisfies a real pending tool invocation with matching identity; never fabricate
a historical tool call or impersonate the user. The model eventually receives supported input, but
the durable event, permission to run and native message are separate records.

The domain app is authoritative for the activity/task; the assistant owns the visible conversation and
model context. Supply a compact current snapshot and references for history retrieval. D7 owns recent
turns, versioned summaries with coverage and authorized retrieval of earlier evidence; no domain-owned
second transcript or fixed replay of the whole conversation is needed. Stored history does not mean
every turn fits the model window. Native resume is bound to the same provider/account; unsupported
resume uses an explicitly supported same-provider reconstruction path or reports unsupported.
Recovered text must not replay old tool effects, permissions or previously consumed results.

Use one admitted turn at a time per conversation and bounded input/output, elapsed time, tool actions,
inference and automatic wake counts. Preserve causation across apps to prevent event feedback loops:
an agent's own domain action is not a new user-action trigger. Define aggregate delegation budgets and
failure escalation with the orchestration owner. Manual resume reuses the pending receipt where safe;
a new attempt requires settled evidence or explicit reconciliation of unknown effects.

## Example: Interactive Activity And Conversation In One Assistant

Use a bounded interactive fixture to verify the platform contract without delivering a separate
application. Its domain state and action rules are authoritative; the assistant owns the conversation.

1. The user opens the fixture and chooses a compatible assistant panel. Starting the activity creates
   its authorized binding. The provider retains its own model/profile selection.
2. Activation records scoped permission for assistant reactions. An assistant-first activity can
   publish its initial event without fabricating a user action.
3. The fixture atomically saves a user action and publication intent with a new state revision.
   The bound assistant receives the event, reads current state and continues the same conversation.
4. The agent requests a domain action with expected revision, stable request ID and trusted
   binding/turn authority. The fixture validates it and atomically saves the effect and receipt;
   re-delivery returns the recorded outcome.
5. A question in the same assistant panel can read current state/history but cannot authorize a
   domain mutation. The adapter supplies trustworthy turn purpose independently of prompt text.
6. Reopening restores the activity and existing conversation without inference. Pause prevents new
   automatic reactions; ending the activity fences late actions while retaining authorized discussion.

The fixture creates no provider task per interaction, chooses no model credentials and copies no
assistant transcript. A committed effect survives missing commentary. Invalid or unresolved actions
remain visible without silently substituting an action or starting another inference attempt.

## Example: A Delegated Result Continues Its Parent

1. An authorized coordinator records a wait with a stable delegation correlation and dispatch identity,
   then creates/starts one task through existing task-provider/executor contracts. Correlate the returned
   provider-qualified task and attempt; reconcile a lost response before any second dispatch.
2. The child produces its explicit result and execution-stop evidence. The task owner publishes a
   durable fact consistent with that state. Distinguish execution failure/cancellation/unknown from
   business review acceptance; `Done` is not a universal event for every possible result.
3. The parent inbox accepts the event only for the registered task/attempt/wait. It retrieves the
   selected authorized result and artifacts, not the child's private chat, and satisfies the wait once.
4. The assistant continues the existing parent session with the attributed result or failure. If the
   parent is busy, cancelled, offline or awaiting another approval, apply the policy above. A late child
   cannot revive it. Failure may lead to a bounded retry or a question under the coordinator's policy;
   the event transport does not invent that policy.

This proves one explicit delegation without requiring automatic decomposition, a reporting hierarchy,
shared profiles or Paperclip integration. Native subagent results use either native delivery or an
explicit adapter projection with shared correlation, never both independently.

## Design Consumer: Repository Events And Dependabot Routines

Owner clarification, 2026-10-29: a separate Harness view aggregates active PRs from repositories
of installed applications, including stopped apps and PRs created outside Hosty. Derive membership
from current source records and deduplicate shared repositories; no favorites or manual enrollment. A configurable routine could review Dependabot
updates and either recommend merge, request a human decision or merge within an explicitly configured
policy. [Harness Pull Request Inbox](../harness-pull-request-inbox/feature.md), developed from
[I18](../../ideas.md#i18-active-pull-request-inbox-and-repository-observation), owns repository
discovery and the independent view; [Durable Agent Jobs](../durable-agent-jobs/plan.md) owns routine
activation/execution and [Shared Decisions](../shared-decisions/feature.md) owns addressed answers.
This example does not create a live subscription, grant merge rights or add PR implementation to D6.

Distinguish two authorized event consumers in D1: an existing activity/session binding and a configured
routine activation owned by an application. A routine is durable configuration, not an always-running
model or a new Core agent principal. Its runner owns creating a job/conversation when needed and
binding subsequent inputs to that work. It consumes this contract's receipt/correlation semantics
and D7 recovery; the event bus must not require producers to invent a conversation ID or make Core
create the assistant session. Register routine subscriptions through the common authorized consumer
contract; deliver only to matching authorized consumers, not every installed app or agent.

Proposed flow:

1. A repository observer discovers a PR or a relevant head/check/review change using the selected
   authorized connection. It persists observations and emits stable facts independently of any UI.
   Refreshing unchanged state emits no new work trigger. Initial discovery and newly installed app
   repositories need an explicit automation backfill policy so deriving membership does not launch
   a backlog. App/source changes reconcile the set; shared-repository apps do not duplicate events.
2. Within the installed-app repository scope, the routine filters verified author identity and update/check
   conditions. Author/login metadata comes from the provider; a title claiming Dependabot is not proof.
   A PR opening can register interest while CI is pending. Deterministic state changes can advance
   waiting work without invoking the model on every check update.
3. The runner creates or recovers one logical review for the routine configuration, repository, PR
   and exact head revision. Delivery retry and repeated qualifying observations reuse that work;
   attempts and explicit reanalysis remain separate identities. A new head invalidates the old
   recommendation and requires new analysis under policy. Retain causation and avoid merge-event loops.
4. The agent returns a revision-bound recommendation and evidence. In ask-first mode it creates a
   decision with PR/head, summary and requested action. The answer is durable and can resume the same
   work later; silence and notification dismissal are not answers. In automatic mode a configured
   rule authorizes the bounded action without a fresh question for every matching PR.
5. Before merge, re-read the current head, required CI/review/protection state and current authority.
   Neither green CI nor a generated recommendation grants merge rights. A yes for an older head is
   stale; an explicit no does not merge. Record a stable mutation request and reconcile an uncertain
   response before retry. Preserve repository merge policy and do not override protection rules.

The [existing publication observer](../assistant-pr-lifecycle/feature.md) handles registered
publication/reference observations; at the inspected baseline its timer is 30 seconds. That is not
a discovery feed for every open PR in the repositories of installed applications. The owner selects
a shared Core PR scheduler/cache, integrated with existing publication observation; its supported API
and integration are owned by the PR plan. Core's generic delivery layer does not encode Dependabot
policy or choose an assistant.

Transport stays below this event contract. The
[selected PR polling policy](../harness-pull-request-inbox/plan.md#selected-adaptive-polling-policy)
uses adaptive polling and a shared cache, without webhooks in this version. Live authorized
repository/PR stream subscriptions request minute discovery and quiet-PR refresh, with 10-second
refresh for active PRs. Without relevant subscriptions, discovery and per-PR reads return to the
five-minute baseline. A compact row, full page or backend/workspace watcher uses the same rule;
unrelated SSE traffic and stored workspace references are not demand. Background consumers need a
live scoped subscription to retain the faster cadence with panels closed. Track only accessible
installed-app repositories through existing owner-scoped connections. These are budget-constrained
PR-observer defaults, not generic event guarantees or live timer changes during planning. The PR plan
owns stream lifetime, conditional requests, budget/backoff and reconciliation; later routines reuse
observations instead of creating agent pollers.
The PR plan also fixes a shared invalidation input so a later webhook receiver for public origins
can reuse the same cache and UI stream; that receiver is not implemented by the browsing feature.
This choice does not restrict how unrelated applications produce events, and it does not implement
durable event publication or routine execution as part of the PR browsing feature.

## Decisions-First Compatibility Boundary (2026-11-03)

[Shared Decisions](../shared-decisions/feature.md#harness-presentation) implements
its addressed response path before general subscriptions: a fixed originating installation consumes
an atomic response outbox, saves a receipt and reconciles one continuation command. That is a narrow
owner-command handoff, not this plan's activity binding or arbitrary application-event ingress.

D1-D3 here must reuse the same decision/resolution/wait IDs and source receipts when adding general
event transport, with one selected delivery path per response. They retain general source/schema
negotiation, routing, budget, busy-session and delegated-result semantics. Notifications D6 remains
their durable-subscription prerequisite. This bounded delivery neither completes these deliverables nor
changes the two initial runtime examples or grants event-triggered execution authority.

## Deliverables

- [ ] D1. Specify and approve the versioned assistant capability, activity/binding/wait references, authorized operations, lifecycle, event vocabulary and receipt states; reconcile ownership with Notifications D6, Durable Agent Jobs D7 and public provider invocation, including direct-message versus domain-event boundaries and event targets for both existing-session continuation and application-owned routine activation before a conversation exists. Review the Dependabot and a minimal non-PR example against domain-neutral source/schema/filter contracts without absorbing PR discovery/UI or runner implementation, and leave implementation priority explicit.
- [ ] D2. After Ready approval and the delivery prerequisite, implement assistant-specific routing and durable inbox consumption over Notifications D6, including authorized subscriptions, source/outbox recovery, deduplication, cursor gaps and observable delivery/continuation receipts; do not reimplement the shared transport.
- [ ] D3. Implement the remaining cross-application Harness event-to-session adapter over common session primitives, the transferred local child-result consumer and existing journal, with idle/busy/waiting/paused/cancelled policy, trusted turn purpose, current authority, budgets, same-provider recovery and uncertain-start reconciliation; do not duplicate the session engine.
- [ ] D4. Add the versioned public SDK/provider contract and optional discovery capability, plus activity attach/reopen/pause/stop presentation in existing assistant panels; retain draft-only v1 handoffs and inference-free opening, support unsupported-provider outcomes and installation changes, and verify an unrelated third-party assistant fixture.
- [ ] D5. Integrate independently provided delegated-task results and parent waits over the public event contract, reusing the transferred same-Harness consumer correlation; verify early completion, failure/cancellation, required-review distinctions and selected-result visibility without duplicate delivery. Task decomposition remains with its owner.
- [ ] D6. Verify the two end-to-end examples with the interactive-activity fixture and one real assistant configuration, plus contract fixtures for a separately implemented assistant; cover attribution, turn-only mutation authority, restart, lost/duplicate/out-of-order input, busy sessions, revoked access and late results without duplicate domain effects.
- [ ] D7. Document verified capabilities, compatibility limits, retention and operator recovery in feature.md; reconcile linked owners without completing their outstanding scope, remove this plan only after all deliverables pass and regenerate the documentation index.

## Sequence And Decisions Before Ready

First resolve D1 with the shared delivery and session owners. Existing notification, task and panel
behavior must remain independently usable. After separately approved prerequisites are available,
build one idle-session continuation, then recovery/busy behavior and the two consuming examples.
Keep D1-D7 on one feature branch/PR, including the bounded interactive acceptance fixture. These are proposed
implementation phases, not authorization to begin them during planning.

Decisions still needed:

- Choose the capability/version and concrete API shape, binding owner storage and exact access scope;
  decide whether supported assistant operations extend the current category or use a distinct one.
- Set the initial active-authority policy, pause/detach/end semantics, idle/busy defaults, wait retention,
  event limits, deduplication lifetime, wake/cost budgets and behavior after retention gaps.
- Specify how the native adapter supplies trusted binding/turn purpose to tools, so a discussion turn
  cannot spend a domain-action authorization. Identify native resume/reconstruction and run-reconciliation
  capabilities for each actual provider; advertising an assistant panel alone is insufficient.
- Agree delivery of Notifications D6 and common session recovery D7 without requiring unrelated
  notification channels, scheduling UI or hierarchy, and reconcile their existing feature scopes
  explicitly if necessary. No silent transfer or partial completion is selected by this document.
- Define the routine-activation target alongside session bindings: who retains the subscription,
  how new job/session creation is recovered, which revisions deduplicate a trigger, and how updated
  input invalidates a pending decision. The runner owns creation; the producer cannot address an
  arbitrary private conversation.
- Select the first real assistant/model/account and authorized test setup. Harness is a candidate;
  its current administrator execution boundary remains until its owning user-session feature changes.

## Verification

This Draft change needs documentation/index/link and whitespace checks only. It supplies no runtime
acceptance evidence, creates no test sandbox and changes no artifact versions.

D1 design verification also traces the Dependabot example from a new PR with no conversation
through deferred CI eligibility, one routine activation, decision persistence and an exact-head
merge request. Cover initial backfill, duplicate events, new commits, missing checks, a no answer,
expired authority and an uncertain merge response. Compare a non-PR application event with no
repository, PR number or GitHub fields, including an unknown/incompatible schema. Runtime PR
discovery and inbox acceptance belong to [their own plan](../harness-pull-request-inbox/feature.md);
merge-policy execution needs separately scoped work. These examples do not claim implementation
or select the first live event producer.

Implementation acceptance must cover:

- Two activity events and a state-aware discussion in the same conversation, including assistant-first
  activation, safe reopen and a discussion-only mutation denied beside an authorized domain action.
- One child task success and one failure reaching the correct parent wait; a native subagent completion
  is not injected twice, and required business review is not inferred from execution completion.
- Interrupt source persistence/publication, inbox append/ack and session command acceptance. Recover
  original IDs after lost replies; never equate transport retries with a new inference attempt.
- Busy-parent input, fast-child/wait registration, concurrent browser views, cancelled or paused
  sessions, late results, stale activity revisions, retention gaps, provider restart and unknown stop state.
- Current-user and destination-session denial, forged source/user IDs, cross-installation replay,
  revoked grants, changed provider/account, unavailable result references and external input that
  attempts to elevate itself into a user/system instruction.
- Demonstrate bounded automatic reactions and no periodic model invocation while waiting. Show
  pending delivery, parked continuation and unavailable native capability distinctly in the UI.
- Exercise an empty Core app registry and an independently named compatible provider fixture. Record
  the real-provider capability matrix separately; fixtures do not prove native provider support.
- Use a registered worktree and managed child Core with normal setup/login, separate data and explicitly
  authorized provider access. Run affected contract/unit/integration/build checks, record commands and
  results, export useful sanitized evidence and Finish the sandbox through its owner. Never copy live
  credentials, change live source selection or grant publication authority for this acceptance.

## Related Direction

This scopes the event/interactive-activity part of [I6](../../ideas.md#i6-events-schedules-and-optional-automation-applications),
[I10](../../ideas.md#i10-interactive-sessions-that-wait-for-user-actions) and
[I11](../../ideas.md#i11-application-provided-roles-instructions-and-interaction-profiles).
[Native subagents I9](../../ideas.md#i9-native-subagents-visibility-and-delegation-controls) remains a
separate capability investigation. [Composable Human And Agent Work](../composable-agent-systems/plan.md)
retains its broader composition scope; none of these references changes approval status.

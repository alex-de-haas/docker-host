---
status: Draft
created: 2026-10-26
updated: 2026-10-26
summary: Participant bindings and optional task coordination, hierarchy, decisions and artifacts in Harness, reusing independent agent profiles.
components: [apps/harness, apps/documents]
---

# Harness Work Orchestration

## Goal And Packaging

Provide the first human-and-agent work composition inside Harness so it can be used without first
building cross-application UI composition. The owner proposed this packaging on 2026-10-26;
the working name Hosty Organization and eventual separate application remain undecided.
[Vision decision 56](../../vision.md) records the Draft direction, not implementation approval.

Harness currently supplies conversations, provider connections, background work and development
surfaces. It does not implement the shared tasks, persistent participants or general runner proposed
here. This plan owns application behavior and integration, not those underlying platform blocks.

## Target Behavior

Reuse [Shared Agent Profiles](../agent-profiles/feature.md) for connection/model/effort choices,
role instructions and explicit skill sets. Bind configurations to persistent participants where
needed, separately from credentials, session history and authority. Reuse its controlled editor in
a joined personalized-agent form. Profiles do not require a project, app or workspace binding.

Core's [skill library](../agent-skills/feature.md) owns complete Git/app packages and current-content
exports. New packages remain unselected; missing IDs do not block delivery/resume. No separate
package pool, package editing, historical pinning or repeated digest approval belongs here.

Let a user assign work directly or let a configured coordinator break it into visible child tasks.
Agent reporting hierarchy and task parentage are independent. Human participants can configure roles,
perform stages, review outputs and receive addressed decisions. One person with one agent remains a
valid setup; no organization chart or fixed analyst/design/development/QA pipeline is mandatory.

Keep workflow-specific state in Harness keyed by shared task IDs. Use shared APIs to create tasks,
record assignments and publish results. A runner handles durable execution and waits; organization
policy chooses when to delegate, integrate, retry within granted limits or request human review.
Source delegation passes the selected workspace; an unrelated bugfix can receive an explicitly
independent workspace and PR. Coordinate writers and integration; shared source is not file isolation.

Provide coherent Agents, Tasks, Decisions and Artifacts views within Harness, with navigation to
existing sessions, workspaces and previews. Decisions aggregates authorized questions and records
answers against reviewed inputs; artifacts exposes the shared catalog's permitted results. Final
tab names and layout remain open. Reuse existing panels where useful, but a new widget/composition
framework is not a dependency. Core must not know these routes or treat Harness's app ID as authority.

## Independent Profile Feature (2026-10-26)

The owner approved and independently delivered [Shared Agent Profiles](../agent-profiles/feature.md) as a standalone feature with
Harness chat as its first consumer. It owns configuration, storage/API, shared editing, explicit
skills, simple deletion and pre-start selection. A later personalized-agent form can compose that
editor directly with participant fields; a mandatory separate profile setup step is not selected.
The owner leaves Organization packaging open. This plan retains personalized participant binding,
hierarchy, task routing and the complete orchestration experience, and remains Draft.

## First Cross-App Composition

1. Plans/Documents creates one shared task with a pinned approved input through the public contract.
2. The selected Harness executor accepts it and starts one configured agent via the common invocation
   and job contracts. Documents observes task events without reading Harness's private storage.
3. The agent saves an artifact and addresses one question to a person. Only dependent work waits.
4. The person answers in the Decisions view, including after an overnight pause and executor restart.
5. Execution continues and publishes its result; Documents sees the shared outcome and result links.

Verify this before optional hierarchy/fan-out. Then add a reviewer consuming summary plus artifact
references, explicit independent bugfix work and a non-development task. A separate Organization app
is not required for first acceptance, but the contracts must remain consumable by another app.

## Dependencies And Ownership

[Shared Skills](../agent-skills/feature.md), [Agent Participants](../agent-participants/plan.md),
[Agent Providers](../agent-provider-interface/plan.md), [Shared Tasks](../shared-tasks/plan.md),
[Notifications D6](../notifications/plan.md#deliverables), [Artifacts](../shared-artifacts/plan.md),
[Decisions](../shared-decisions/plan.md) and [Durable Jobs](../durable-agent-jobs/plan.md) own their
contracts and implementations. This plan owns their first joined application journey and UI.

[Plan Provider](../plan-provider-interface/plan.md) keeps document semantics and source identity;
this integration does not require moving documents into Harness. [Shared History](../assistant-shared-history/plan.md)
owns session recovery. Existing workspace/sandbox/publication APIs remain optional resource providers.
Ordinary-user chat/isolation prerequisites retain their current status; an admin-only demo does not
prove team access. Memory, UI framework extraction and full Paperclip parity are excluded.

## Deliverables

- [ ] D1. Define persistent participant bindings, hierarchy and human-review routing using Shared Agent Profiles; retain configuration/identity/permission boundaries and describe reuse in one personalized-agent editor.
- [ ] D2. Specify and integrate, after Ready approval, the first Documents-to-Harness single-task journey using shared APIs, one artifact, one addressed decision, parked continuation and result observation.
- [ ] D3. Implement the selected Harness task/decision/artifact and personalized-agent presentation over shared contracts, reusing the profile editor and existing session/workspace views, including accessible review materials and current authorization.
- [ ] D4. Implement optional task decomposition and hierarchy-driven delegation with visible assignments, explicit handoffs, bounded fan-out and workspace reuse/independent-work policy through the common runner and resource APIs.
- [ ] D5. Verify the first journey and optional hierarchy cases, a human QA reviewer, separate bugfix/PR, a non-development task and an independent API consumer; prove no private-store coupling or first-party-ID privilege.
- [ ] D6. Record shipped application behavior and limits in feature.md, reconcile the umbrella and underlying owners without marking their unfinished deliverables complete, and regenerate the index.

## Proposed Sequence

Work through D1 with skills and participant contracts. Deliver D2-D3 as the smallest joined experience
before D4; keep all implementation on the feature branch under the repository's one-PR-per-feature
rule. Accept D5 only with the applicable authority and runtime prerequisites, not from UI mockups.

## Open Questions

- Which views belong in existing Harness navigation, and which can reuse available panels?
- How do routing, overlapping work, child cancellation and acceptance aggregation behave?
- When would a separate application provide enough value to justify UI composition/extraction?

## Verification

For this Draft, validate documents and links. Future acceptance uses real Core identity and managed
preview URLs, with separate users/data and dependencies in a Core-managed sandbox. Check Documents
observes running/waiting/completed states after reconnect, the overnight question resumes once, and
another client can inspect authorized tasks/results without Harness internals. Verify cancellation,
stale review materials, revoked access and preserved source/results after temporary resource cleanup.

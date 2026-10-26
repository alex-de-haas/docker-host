---
status: Draft
created: 2026-10-26
updated: 2026-10-26
summary: Compose shared work capabilities in Harness with agent profiles, optional hierarchy, task coordination and one tasks, decisions and artifacts experience.
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

Configure app-owned agent profiles with role instructions, provider/model preferences, skill references
and execution defaults. Bind a profile to a persistent participant when needed; keep it separate from
provider credentials and native sessions. Shared Skills' 2026-10-26 decision gives Core one
administrator-managed package pool and gives Harness its profiles/instructions and selected references.
Resolve selected skill IDs to current installed packages, independently of model/provider connection.
Use an assistant default before profiles are configured. Do not pin conversations to old package
revisions or retain deleted skills; missing selections do not block creation/resume. Native clients
control when updated files are loaded. Profile customization does not edit/fork skill packages,
create personal libraries or rewrite instructions already loaded in a session.
The [selected skills contract](../agent-skills/plan.md#selected-package-and-catalog-contract-2026-10-26)
uses stable skill IDs in profiles and current content in execution exports, following vision decision 59.
New app packages appear in the common catalog without being automatically added to profiles.
Decision 60 limits initial sources to Git/app packages and removes repeated content-digest acceptance
on updates; there is no manual upload flow. Shared Skills delivers the assistant-default and generic
selection contract without requiring this plan's full profile UI.

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

[Shared Skills](../agent-skills/plan.md), [Agent Participants](../agent-participants/plan.md),
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

- [ ] D1. Define app-owned profile revisions, participant bindings, hierarchy and human-review routing; specify the selected Core-pool/profile-reference/current-content boundary with Shared Skills, preserving administrative package management and distinguishing configuration from permission.
- [ ] D2. Specify and integrate, after Ready approval, the first Documents-to-Harness single-task journey using shared APIs, one artifact, one addressed decision, parked continuation and result observation.
- [ ] D3. Implement the selected Harness profile/task/decision/artifact presentation over shared contracts and existing session/workspace views, including accessible review materials and current authorization.
- [ ] D4. Implement optional task decomposition and hierarchy-driven delegation with visible assignments, explicit handoffs, bounded fan-out and workspace reuse/independent-work policy through the common runner and resource APIs.
- [ ] D5. Verify the first journey and optional hierarchy cases, a human QA reviewer, separate bugfix/PR, a non-development task and an independent API consumer; prove no private-store coupling or first-party-ID privilege.
- [ ] D6. Record shipped application behavior and limits in feature.md, reconcile the umbrella and underlying owners without marking their unfinished deliverables complete, and regenerate the index.

## Proposed Sequence

Work through D1 with skills and participant contracts. Deliver D2-D3 as the smallest joined experience
before D4; keep all implementation on the feature branch under the repository's one-PR-per-feature
rule. Accept D5 only with the applicable authority and runtime prerequisites, not from UI mockups.

## Open Questions

- Which initial roles and profile fields are useful without prescribing a business workflow?
- How are profile/default references represented in the API and native export layout without mixing simultaneous profiles? Consumers receive current installed packages; deleted references are omitted and native reload behavior is observed rather than enforced.
- Which views belong in existing Harness navigation, and which can reuse available panels?
- How do routing, overlapping work, child cancellation and acceptance aggregation behave?
- When would a separate application provide enough value to justify UI composition/extraction?

## Verification

For this Draft, validate documents and links. Future acceptance uses real Core identity and managed
preview URLs, with separate users/data and dependencies in a Core-managed sandbox. Check Documents
observes running/waiting/completed states after reconnect, the overnight question resumes once, and
another client can inspect authorized tasks/results without Harness internals. Verify cancellation,
stale review materials, revoked access and preserved source/results after temporary resource cleanup.

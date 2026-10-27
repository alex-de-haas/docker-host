---
status: Draft
created: 2026-10-26
updated: 2026-10-27
summary: Minimal described and versioned work artifacts with authorized save, discovery and reads, durable references and explicit agent handoffs.
components: [apps/core, apps/harness, apps/documents, packages/app-sdk, packages/app-sdk-dotnet]
---

# Shared Work Artifacts And Handoffs

## Goal And Baseline

Preserve useful results so another session, agent or person can find and consume them. Current
session attachments and repository documents do not form a shared artifact catalog.
[Ideas I3](../../ideas.md#i3-shared-artifacts-external-references-and-configurable-storage) supplies
the broader possibilities; this Draft selects only basic artifacts under
[vision decisions 55-56](../../vision.md), without approving implementation.

## Deferred After Basic Tasks (2026-10-27)

The owner leaves this artifact store/catalog and handoff feature for later. The Ready
[Basic Tasks](../basic-tasks/feature.md) plan stores task result text and optional references to existing
materials; it creates no artifact service and completes none of D1-D4 here. This plan remains Draft.

## Target Behavior

Explore a small record with identity/version, name, description/type, author, origin task/run,
access scope and stored content or an authoritative versioned reference. Typical outputs are reports,
prepared documents and useful scripts; humans can add input materials. Decide record/storage ownership
explicitly rather than assuming every artifact's bytes belong in Core. Qualify task references by
their provider, and attribute outputs to existing users/apps with an optional opaque executor option.
No separate agent principal or shared Harness profile is required. The task-provider decision does
not select artifact storage; artifacts can be optional task resources without making them mandatory
for creating or executing a task.

Provide authorized save, find/list and read operations for apps and agents. A handoff contains a
bounded summary, exact output references and unresolved work. It does not share an entire conversation.
Session context stays session-owned; shared context consists of explicitly selected materials.
The 2026-10-27 owner decision moves cross-session context needs here from the retired switching
plan. D2-D4 cover a handoff containing the goal, constraints, decisions and rationale,
summary coverage, exact input/output revisions, unresolved questions and expected next step.
Attribute selected excerpts and generated summaries, expose missing/stale evidence, and revalidate
access when saving, discovering, reading or consuming them. A workspace membership or administrator
role alone does not disclose another conversation. Imported action descriptions remain historical
evidence and cannot be treated as executable tool calls or a grant to repeat them.
Skills remain instructions/packages under their existing owner. Learned memory is excluded.

Keep source identity separate from location: repository identity/path/revision or an owning app's
document ID/version can resolve into a workspace without silently replacing the approved input.
Object Links handles navigation, not byte retrieval or model-context injection.

Confirm retained content before acknowledging a successful save/export. Work that should survive
cleanup must not depend only on a temporary workspace/sandbox path. Define deletion, unavailable
originals and references held by pending tasks/decisions. Search metadata must respect current access.
Finding a script does not authorize execution; record its prerequisites without executing it on read.

## Dependencies And Boundaries

[Basic Tasks](../basic-tasks/feature.md), [Decisions](../shared-decisions/plan.md) and
[Harness Work Orchestration](../harness-work-orchestration/plan.md) consume references.
[Plan Provider](../plan-provider-interface/plan.md) owns document/progress semantics;
[Object Links](../object-links/plan.md) owns navigation;
[Durable Agent Jobs D7](../durable-agent-jobs/plan.md#deliverables) owns session continuation/context
assembly over the existing journal; [Harness Work Orchestration D7](../harness-work-orchestration/plan.md#deliverables)
owns the consuming session/material visibility rules.
This feature is distinct from [Runtime Artifacts](../runtime-artifact-model/feature.md), which
describes runnable application artifacts, and from release/publication packages.

No session/workspace/global tier hierarchy, automatic promotion, semantic index, external-storage
provider ecosystem or memory extraction is selected. An agent or configured workflow chooses useful
outputs; no blanket capture of every file, log or transcript is required.

## Deliverables

- [ ] D1. Select minimal record/content ownership and define identity, versions, provenance, description, authoritative references and a clear retention/deletion contract.
- [ ] D2. Define access-controlled save/find/read and the attributed goal/decisions/summary-plus-versioned-references handoff shape, coverage and unresolved next steps; reconcile document revision/location resolution, Object Links and session context without duplicating their owners.
- [ ] D3. After explicit Ready approval, implement the minimal persistence/API/SDK and agent surface with verified saves, permission-filtered discovery, explicit context selection and unavailable/stale-content outcomes.
- [ ] D4. Verify a producer-to-reviewer handoff and later reuse after temporary resource cleanup, including different provider sessions, version changes, revoked/private metadata and attachment access, historical actions without replay and script reads without execution; document the contract in feature.md.

## Proposed Sequence

Resolve D1-D2 before finalizing task/decision material references. Deliver a report or script handed
between two sessions before adding advanced search or storage integrations. The initial source may
be chosen for this slice without selecting a universal storage-provider system.

## Open Questions

- Which records and bytes are Core-owned, app-owned or referenced, and who enforces retention?
- Which revisions must remain immutable, and what does deleting a referenced artifact mean?
- Which filters and metadata provide useful discovery without a semantic index?
- How can an authorized reader resolve content after a workspace closes or the source app disappears?

## Verification

For this Draft, validate documents and links. Future acceptance proves saved content remains readable
after producing-process and sandbox cleanup, old input versions are not silently replaced, permission
revocation applies to discovery and reads, and a missing original is explicit. No memory service or
shared private transcript is required for any acceptance scenario. Verify that the receiving agent
can distinguish current source from an earlier handoff and can retrieve authorized cited evidence
without gaining access to the originating conversation.

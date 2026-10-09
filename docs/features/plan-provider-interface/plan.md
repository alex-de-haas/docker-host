---
status: Draft
created: 2026-10-08
updated: 2026-10-09
summary: Early ideas for an optional plan-provider interface across Markdown specification-driven plans, task trackers and checklists, with possible MCP tools.
components: [apps/plans, apps/harness, apps/core, packages/app-sdk]
---

# Plan Provider Interface

## Idea And Status

An intentionally early idea sketch requested by the owner on 2026-10-08. Defer this work until after
the [Workspaces app](../workspaces-app/feature.md). No protocol, permission, schema or implementation is
approved. See [platform vision decision 23](../../vision.md).

Today [Hosty Plans](../plan-tracking/feature.md) reads source documents with `apps.sources.read`
and interprets the repository's Markdown format. That permission makes it an API consumer, not a
plan provider. A future explicit interface could let it supply plan information to other apps.

Hosty Plans would be one implementation, specializing in specification-driven development with
`feature.md`, `plan.md`, stable deliverable IDs and distinct tracked-branch/workspace versions.
Other implementations could adapt Jira structures, a task manager or checklists. They would own
their source semantics; Core would not learn to parse Markdown or interpret Jira workflows.

## Candidate Minimum

Start from a concrete consumer: a session or workspace UI showing an explicitly linked plan's
title, current state, progress and an Open plan action. Explore a small read contract for identity,
description, stable item IDs and descriptions, states, available progress, version/context and a
provider-owned destination. Counts need a defined meaning; unknown progress is valid and providers
must not imply that all task systems share the same completion rules.

A plan reference retains its provider and opaque plan identity, plus version context where needed.
Changing a default provider cannot redirect an existing Jira plan to a Markdown implementation.
Associations are explicit; a shared repository or folder does not establish a session-to-plan link.
The source remains authoritative rather than a copied checklist in Core or Harness.

MCP is a candidate way for agents to discover/read plans and, separately, perform supported updates.
It does not itself define the common meaning of a plan or progress. A UI can benefit from a small
typed contract while an agent uses provider-specific tools. Decide whether one surface suffices
before inventing parallel APIs. Reuse the existing
[MCP directory](../agent-mcp-directory/feature.md) and
[provider consumption](../provider-consumption/feature.md) boundaries as appropriate.

Agents remain free to edit authorized Markdown directly and follow repository instructions. No
mandatory plan API, workflow engine, automatic execution or replacement of the existing documentation
discipline is proposed. Write operations must preserve source-specific verification/completion rules.

## Deferred Association Ideas (Owner Clarification, 2026-10-09)

A future session may attach several plans for one workspace, or a reviewed Start implementation
action may create a session and request its workspace. No mandatory plan association belongs to
the initial Workspaces app. Keep explicit provider-bound references as one candidate.

PR descriptions may cite document paths and deliverable IDs. They can supply attributed related-plan
hints, but do not prove current canonical progress, verified deliverable completion or target-branch
integration. Explore this within D1/D2 using both explicit references and PR-derived hints; preserve
source-of-truth/version semantics instead of parsing an arbitrary description as authoritative state.

## Deliverables

- [ ] D1. Compare the Markdown implementation with at least one task-tracker/checklist example and specify the first real consuming UI scenario.
- [ ] D2. Draft the smallest read contract, provider-bound references, version semantics and unknown-progress behavior without imposing one workflow on every source.
- [ ] D3. Explore Hosty Plans as the specification-driven Markdown provider and the consuming assistant/workspace integration, keeping source data authoritative.
- [ ] D4. Decide the MCP/tool surface and whether any updates belong in scope, with explicit permissions and source-specific completion semantics.

## Open Questions And Verification

Is a plan best represented as a set of deliverables, an ordered task list or a provider-defined
hierarchy? How much common state is useful without losing native meaning? How are revisions,
workspace variants, deleted plans and stale links represented? Does UI interoperability justify
a formal provider contract, or are MCP tools and ordinary links sufficient for the first use case?

Resolve these using concrete examples and a small consumer prototype before promoting the plan.
Any implementation proposal must cover independent providers, direct source edits, unavailable
providers, permission revocation and stable references after default changes. Creation of this
Draft does not complete its exploratory deliverables.

---
status: Draft
created: 2026-11-16
updated: 2026-11-16
summary: Extend shared conversation history with temporal recall, bounded surrounding context and match-centered excerpts without a second transcript store.
components: [apps/core, apps/harness, packages/app-sdk, packages/app-sdk-dotnet]
---

# Temporal And Contextual Conversation Recall

## Goal And Baseline

Extend the [shipped history contract](feature.md) so any authorized consumer can answer queries such
as "what did we discuss yesterday?" and recover the messages around a keyword match. The owner
requested this shared design on 2026-11-16 for [Personal Assistant](../personal-assistant/plan.md).
This Draft authorizes no implementation or indexing deployment.

At `7a428feedf5da2a42d367cc09cb2bdf86a39d211`, history queries expose provider/conversation/kind
selection, opaque paging and source-backed lexical search. Search uses 1-16 normalized literal
terms, all matched within an entry; results sort by updated time and snippets take the first 500
characters. Creation/modification timestamps exist, but the query schemas have no date filters,
date-only search or context-around-entry operation. Current source authority, coverage, export
consent and deletion rules remain the foundation.

## Proposed Contract Changes

Add capability-negotiated temporal search/read and surrounding-entry retrieval to the existing
provider interface, Core API/MCP mediation and SDKs. D1 selects additive v1 fields/capabilities or
a version increment based on the actual validators. Older providers continue existing reads;
unsupported filters return an explicit capability outcome, never silently broaden disclosure.

- Proposed `createdFrom` inclusive and `createdBefore` exclusive UTC bounds select original
  message occurrence. Modification-time filters, if included, use separate fields and semantics.
- The consumer resolves "yesterday" or "last Tuesday" in the authenticated user's selected
  timezone and retains the resolved interval. DST and midnight yield real local-day boundaries;
  later timezone changes cannot reinterpret an already accepted query/cursor.
- Support date-only queries and optional keyword-plus-date queries under the new capability.
  Do not stringify a date as a lexical term or fetch every conversation to filter in Harness UI.
- Offer stable chronological ordering for browsing and an explicit search order. A cursor binds
  source snapshot, bounds, filters, order and page limits; edits invalidate/reconcile as declared.
- A bounded around-entry read accepts an authorized qualified anchor/revision and requested
  before/after counts or bounded range. The provider checks every returned neighbor separately;
  a selected-entry share never discloses adjacent private messages or hidden entry counts.
- Return match-centered bounded excerpts with entry references, revision, original/modified time
  and truncation/coverage. Exact content remains available through current entry reads.
- Apply final result limits after searching the eligible corpus; a source scan budget or missing
  source is explicit partial coverage, not a successful complete "no match." Avoid recency-only
  preselection that makes older relevant conversations unreachable.

Source providers retain storage and may add bounded indexes over their own data. Core retains
metadata/routing, not a message payload database. An external semantic index is optional, separately
consented and outside this delivery. [Persistent Memory](../persistent-memory/plan.md) stores useful
retained knowledge; this feature retrieves original history and does not infer memories or decisions.
Conversation compaction changes active model input, not human history or source search membership.

## Recall Consumer Behavior

Personal Assistant first resolves explicit reply/task references, then searches a selected interval
and terms, reads the exact hit and permitted neighbors, and returns evidence links. A date can
identify several conversations; present candidates when ambiguity matters. Report complete-empty,
partial, unsupported, unavailable and access-denied outcomes distinctly. A discussion proves what
was said, not that a proposal was approved or remains the current policy.

A derived snapshot must retain source revisions, and sharing changes must invalidate it before
disclosure. Existing exports/checkpoints/purge remain the only authorized path to a retained external
history corpus. Recall and context assembly do not create export authority.

## Deliverables

- [ ] D1. Specify temporal filters, chronology, date-only search, match excerpts, bounded neighbors and capability/version compatibility; settle source time semantics and query/coverage limits before explicit Ready approval.
- [ ] D2. Extend common Core wire/API/MCP and both SDKs with exact query-bound credentials/cursors and unsupported-capability behavior, preserving existing unfiltered clients and source authority.
- [ ] D3. Extend Harness source queries and bounded indexing/paging with created-time selection, match-centered excerpts and authorized neighboring entries, independent of model compaction.
- [ ] D4. Verify temporal/keyword recall and interoperability with an independent provider, including DST, edits, old-topic coverage, source failure, revocation, selected-entry shares and snapshot expiry.
- [ ] D5. Update feature.md with verified behavior and limits, reconcile recall consumers, remove this plan and regenerate the index with required implementation versions.

## Decisions Before Ready

Select exact capability names and additive/versioned wire shape. Set maximum interval/page/neighbor
and scan-work bounds, ordering options and a safe gap response. Determine which source projections
preserve original occurrence time and how providers represent unavailable historical timestamps.
No inferred source timestamp may be presented as an exact original message time.

## Verification

Documentation now: index, relative-link and whitespace checks only. Later run affected Core history
and SDK contract tests, Harness source/query tests and a managed authenticated API/UI journey.
Test midnight and DST in Europe/Amsterdam, a changed user timezone, date-only/keyword queries,
creation versus later edits, matching text beyond the former snippet prefix and one old relevant
conversation behind 100 recent unrelated ones. Test duplicate timestamps with stable pagination.

Exercise denied neighbors around a shared hit, source disappearance mid-query, modified/deleted
entries, expired snapshots, bounded scans, partial provider coverage and retention gaps. Old clients
and providers must retain their declared behavior. Verify no second source corpus, hidden automatic
export, paid inference or mandatory embedding service is introduced. Run the heavyweight tasks suite
only under the explicit selection required by repository policy.

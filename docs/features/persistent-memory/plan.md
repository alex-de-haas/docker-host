---
status: Draft
created: 2026-11-16
updated: 2026-11-16
summary: Reusable provider-owned personal memory with provenance, scoped recall, corrections, forgetting and source-aware retention.
components: [apps/core, apps/harness, packages/app-sdk, packages/app-sdk-dotnet]
---

# Persistent Memory And Recall

## Goal And Scope

Let an authorized consumer retain useful user facts, preferences and confirmed decisions across
conversations and retrieve the relevant subset without reconstructing everything from service
calls or replaying complete transcripts. [Personal Assistant](../personal-assistant/plan.md) is the
first consumer; ordinary chats, other applications and task coordinators can use the same contract.

The owner requested this design on 2026-11-16 as part of personal-assistant planning. It promotes
the bounded personal-memory slice of [idea I1](../../ideas.md#i1-memory-as-a-replaceable-provider).
This is a Draft: no implementation, automatic history extraction, provider installation or Ready
approval is implied. Existing Composable Work examples remain usable without memory.

Shared memory initially means one person's authorized knowledge reused across their interactions
and selected task handoffs. It does not mean a global multi-user database visible to all agents.
Household/team sharing, general document ingestion, automatic self-refinement and a universal
knowledge graph remain outside this initial contract. They are not hidden acceptance prerequisites.

## Ownership And Proposed Architecture

Use an optional replaceable provider to own memory records, storage and retrieval. Core supplies
common discovery, qualified references and current user/app authority through established provider
patterns. Core does not store the memory text, select a default by app name, or require a database
or embedding engine to run. A compatible consumer can operate without Harness installed.

Recommended first implementation: one provider with revisioned structured records and bounded
lexical retrieval, plus an inspectable/exportable representation. SQLite/FTS inside that provider
is a candidate baseline, not a selected production dependency. Compare it with human-editable
Markdown and a provider with hybrid retrieval before Ready. Packaging as a new runtime app versus
an additional interface on an existing app is an explicit decision; neither authorizes deployment.
The public contract must not depend on that packaging choice or expose database-specific queries.

| Concern | Owner |
| --- | --- |
| Memory record meaning, lifecycle, provider contract and first implementation | This plan |
| Source conversations, exact entries, temporal/keyword search and export consent | [Conversation History](../conversation-history/feature.md) and its [recall extension](../conversation-history/plan.md) |
| Per-interaction assembly, source budgets, summary coverage and recoverable context | [Durable Agent Jobs D7](../durable-agent-jobs/plan.md#deliverables) |
| Personal-assistant behavior, memory views and selected worker handoffs | [Personal Assistant](../personal-assistant/plan.md) |
| Generic cross-app durable notifications | [Notifications D6](../notifications/plan.md#deliverables); source reads/revision checks remain usable without a general event bus |
| Reusable procedures and instruction packages | Existing [Skills](../agent-skills/feature.md), not memory records |

## Record Contract

Proposed fields are design vocabulary; finalize exact schemas and capability/version negotiation
under D1. Every memory carries:

- Provider-qualified identity and optimistic revision, authenticated owner and permitted scope.
- Kind: preference, fact, confirmed decision or derived summary. Preserve proposal/uncertain
  status where applicable; model confidence alone cannot promote it to a confirmed decision.
- Bounded content and subject/topic labels; applicability to a person, project, app or activity
  without requiring a Project container or retaining a workspace process.
- Origin: explicit user assertion, user confirmation or derived source material, with source
  entry/resource references and revisions where applicable. Attribution is authenticated metadata.
- Created/updated timestamps, optional validity interval, supersedes/superseded-by relationship
  and current lifecycle state. Historical truth and present applicability are distinct.
- Retention basis, source-dependence, optional expiry and deletion generation. These distinguish
  independently authored knowledge from a revocable derived copy.

Never store credentials or grant/approval authority in memory. A preference may influence wording
or suggest a default; it cannot authorize a tool, override a current instruction or establish a
current mutable service state. Recalled text is contextual data even if it resembles instructions.

## Operations And Consistency

Specify bounded create, get, query/list, revise/supersede and forget operations. Mutations retain
stable request IDs and input digests; revision checks reject competing new writes. Recovery of
the same uncertain request returns its prior disposition without creating another memory.

Queries select the current actor's allowed scopes, kinds, topics, applicability and optional time
filters. Return bounded records or excerpts, source/revision references, freshness/applicability,
coverage and an opaque cursor. Inspecting one fact can retrieve its exact origin lazily through
the source owner's authorized read path. Providers may expose additional search capabilities;
unsupported filters cannot be silently ignored.

An optional compact memory pack includes a small pinned preference set and query-selected relevant
facts, its selection/policy revision and source revisions. Bound its bytes/tokens and exclude
superseded, expired or inaccessible records. Consumers cache only under an explicit current-access
and invalidation policy. A change notification invalidates a cache; a fresh read establishes truth.
An unavailable provider produces a visible degraded state, not a fabricated empty memory pack or
a fallback to another user's/default provider.

Saving and forgetting operate independently of a model call. Content writes, revision changes and
receipts settle before acknowledgment. Define the first provider's process/host-crash durability,
backup and restore behavior, bounded journals and corruption isolation. A failed search index
cannot erase source records; indexes are rebuildable only from currently permitted records.

## Learning, Correction And Forgetting

Explicit "remember this" is the recommended first policy. Save the requested fact under the user's
existing authority without repeatedly asking for the same permission. Source-linked summaries
must preserve their source policy. Do not infer approval for bulk history ingestion from a request
to remember one independently authored preference.

Automatic extraction is a distinct optional policy. If selected later, start with inspectable
suggestions from bounded source windows; the user can confirm, edit or reject them. It must use
the same mutation, provenance and deletion checks, with separate compute budgets. Automatic changes
to durable memory or agent instructions are not selected by this Draft's existence.

A correction creates an explicit supersession; it does not leave two conflicting records as equally
current. Query results disclose unresolved contradictions and allow the user to resolve them.
Fresh explicit instructions govern the current request even before a memory correction settles.
Generalizing a one-task exception into a permanent preference requires evidence of that intent.

Forgetting removes content from source records and every active retrieval/index/cache projection,
including selected context not yet disclosed. Content-free receipts/tombstones may retain the
minimum identity needed to prevent replay. Check deletion generation in the same transaction as
a delayed extraction/save so old history cannot silently recreate a forgotten fact. Deletion does
not claim to retract information already delivered externally or a tool effect already performed.
Backup restore must reconcile deletion generations before serving recovered content.

Forgetting memory is distinct from deleting the independently retained original conversation. An
explicit historical query may still retrieve that original discussion, marked as historical and
not current memory, unless its source was separately deleted or revoked. Forgetting prevents
automatic re-extraction/reinsertion from old evidence; a deliberate later save needs a new current
request and cannot be a replay of a pre-deletion command. Already-dispatched model/worker contexts
cannot be retroactively erased. Before a new reply, summary or handoff is disclosed, check current
deletion/supersession state and omit or qualify stale content according to the request. User controls
must explain these distinct memory, history and active-execution lifetimes.

## History, Derived Copies And Source Authority

Permanent memory has an independent lifetime from an ordinary chat, but not independent authority.
Define two cases explicitly:

- A user-authored standalone preference may remain after its incidental conversation expires,
  under its declared memory retention policy and with origin unavailable rather than fabricated.
- A retained summary/copy derived from protected history follows the source/export selection,
  retention and revocation rules. Reading or sharing history alone does not authorize a derived
  corpus. Use the existing exact consumer/corpus export consent and checkpoint/purge contract.

Source edits, deletion, sharing expiry and access loss invalidate dependent content. Mixed-source
records track each dependency and are invalidated/redacted or recomputed under current access.
A derived copy cannot be relabeled as independent user-authored knowledge to retain revoked data.
Do not keep unrelated private transcripts inside a memory record. Handoffs reference only the
selected permitted facts; ordinary task/workspace membership is not broad memory access.

## Storage And Retrieval Comparison

| Candidate | Strength | Cost/limit to measure |
| --- | --- | --- |
| Structured records plus lexical search | Precise correction, scoping and small operational footprint; useful for preferences and known topics. | Paraphrases and multilingual recall may need query expansion or a semantic capability. |
| Human-readable Markdown with an index | Inspectable outside the assistant and portable. | Concurrent revisioned writes, structured provenance, deletion and indexing consistency still need an authoritative service. |
| Hybrid lexical/semantic provider | Candidate improvement for paraphrases and broad episodic retrieval. | Embedding cost, model/version changes, stale derived copies, ranking quality and permissions. |
| Temporal graph | Explicit relationships and validity can express evolving facts. | Additional ingestion/inference complexity; adopt only if simpler records fail relevant evaluations. |

Study [Letta memory](https://docs.letta.com/configuration/memory) as a separation of durable knowledge
from conversation context, not proof its storage implementation is required. The dated user reports
and limits collected in [Personal Assistant research](../personal-assistant/plan.md#research-and-design-rationale)
motivate older-topic recall, correction and compaction tests. They do not establish a winning engine.
The intended future Qdrant history integration in I2 remains deferred; this plan does not quietly
enable it. Compare explicit memory plus source-backed history before choosing embeddings or graphs.

## Deliverables

- [ ] D1. Resolve the shared record/operation/access contract, packaging and first storage/retrieval implementation; compare the candidates against concrete recall/correction cases and record policy decisions before explicit Ready approval.
- [ ] D2. Implement the selected provider's bounded revisioned store, mutation receipts, concurrency, durability and source-independent memory lifecycle with corruption and restore handling.
- [ ] D3. Add generic Core discovery/authority and TypeScript/.NET SDK contracts plus the selected agent-facing exposure, with negotiated capabilities and independently named providers; keep memory payloads outside Core.
- [ ] D4. Implement scoped recall and compact memory packs, provenance/supersession, permitted caching, source/export invalidation and forget/purge fencing; preserve explicit coverage and unavailable-provider outcomes.
- [ ] D5. Supply the provider's list/origin/edit/supersede/forget controls and explicit-save policy, with a defined boundary for optional extraction; expose reusable operations to Personal Assistant without duplicating its UI.
- [ ] D6. Verify independent consumer/provider interoperability, cross-user and source revocation, correction/deletion races, restart/restore and recall quality/cost against the selected baseline; do not claim learning from retrieval alone.
- [ ] D7. Document verified behavior, storage/retention and limitations in feature.md, reconcile I1 and consuming plans, remove this plan after all deliverables pass and regenerate the index with implementation versions.

## Sequence And Open Questions

Specify D1 first, implement provider and mediation as one coherent feature, then lifecycle/retrieval
and user controls before integrated acceptance. No runtime work starts while Draft. Personal
Assistant requires this memory consumer for its complete acceptance; other Hosty features do not.

- Choose a provider package and initial backend from measured tradeoffs; define storage quotas,
  memory-pack size, retention defaults and exact access scope before Ready.
- Set the boundary between explicit independent facts and source-dependent derived records,
  including deletion of the incidental originating chat and mixed-source summaries.
- Decide whether the first agent-facing surface uses direct provider MCP or a reviewed generic
  Core adapter. Existing history mediation is not automatic approval for a new memory facade.
- Select a minimal multilingual recall policy and thresholds for adding hybrid retrieval. Set
  target precision/recall and stale-fact limits on realistic examples rather than vendor claims.
- Automatic extraction stays disabled unless separately selected; if selected, specify source
  eligibility, consent, confirmation, budgets and race behavior before moving its work into scope.

## Verification

This Draft needs docs/index/link and whitespace validation only. Later tests cover exact mutation
replay, competing corrections, source edits/revocation, access loss during a query, offline providers,
forgotten facts after restart/restore, delayed extraction after deletion, bounded corrupt records,
explicit historical reads after memory-forget, and late worker/summary output based on a previously
dispatched context. Distinguish protected active memory from separately retained original history.
Use an empty Core registry, unrelated provider IDs and a consumer without Harness. Verify memory
never grants authority and private/shared scopes cannot be inferred from workspace membership.

Evaluate multi-day tasks with changing preferences, paraphrases, multilingual input and irrelevant
history. Measure useful recall, unsupported claims, obsolete-fact use, repeated questions, external
reads avoided, response latency, input tokens and total cost. Compare an explicit-memory baseline
with any semantic extension under the same source corpus and authorization. Real provider/browser
acceptance uses the managed sandbox workflow only when implementation and verification are approved.

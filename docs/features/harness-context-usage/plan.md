---
status: Draft
created: 2026-10-23
updated: 2026-11-03
summary: Context estimates by source, MCP server and tool, with correlated LLM-call tokens, timing and cache observations.
components: [apps/harness]
---

# Context Token Accounting By Source

## Goal And Owner Direction

Extend the [current context indicator](feature.md) so an operator can identify expensive
instructions, MCP definitions and tool results before deciding what to shorten. The owner selected
Ollama and requested tokens, time and cache observations for each observable LLM call, correlated
with tools; the [detailed timeline](../assistant-timeline-analysis/plan.md) remains separate.
On 2026-11-03 the owner prioritizes MCP-server and individual-tool detail and requests an assessment
of a small useful first implementation. This is planning, not Ready or implementation approval.

## Approved Scope Split (2026-11-03)

The owner approved a separate [Claude MCP Context Detail feature](../claude-mcp-context-detail/feature.md)
and its implementation is complete. It owns only preserving the existing Claude MCP-definition estimates and
showing server/tool detail with loaded/deferred/unknown state. That portion of D3/D5 transfers
there. Remaining D1-D8 below stay Draft and unchecked, including all per-call tokens/time/cache,
other source categories, instruction preview and Ollama/Codex accounting. Reuse the new optional
snapshot field when designing the broader contract; no deliverable is silently completed or lost.

## Ollama Scope Split (2026-11-03)

The owner approved the separate [Ollama MCP Context Detail feature](../ollama-mcp-context-detail/feature.md),
and its implementation is complete. Only a bounded local estimate of MCP definitions, request-specific sent/catalog inclusion and reuse
of the detail panel transfer from D3/D5/D6. Exact model/template tokenization, all other source
categories, result attribution, per-call tokens/time/cache, compaction accounting and broader Ollama
verification remain here, Draft and unchecked. The local estimate must never be presented as a
provider-reported count or as model-exact tokenization.

## Refreshed Baseline

Reviewed main at `cc8831fbac0c3b2dc6887ae050f31fadc0a311d2` on 2026-11-03. The previous planning
workspace is unavailable; this Draft restates the retained scope in a new registered workspace.
Earlier unpublished D1-D8 identities are retained. Current main changes the implementation order:

- Ollama is already implemented in [Provider Connections](../ai-gateway-providers/feature.md).
  Independent provider applications remain Draft in [Agent Providers](../agent-provider-interface/plan.md).
  Implementing another Ollama engine is not work in this plan.
- Claude currently calls `getContextUsage({ detail: "summary" })`, but normalization keeps only
  total/window/time. The SDK exposes MCP tool counts and optional message-type breakdowns; preserve
  supported fields before adding a separate tokenizer. The repository pins SDK 0.3.296; locally
  available 0.3.288 declarations already contain these fields. Verify actual 0.3.296 responses in
  the implementation fixture; declarations alone are not live-provider evidence.
- Codex currently supplies the last context usage observation. Its adapter does not expose a
  native per-source context breakdown. Do not infer one from a thread/turn aggregate.
- Ollama owns the final message/tool arrays. It initially offers local tools and service names;
  `discover_tools` selects at most eight MCP definitions for subsequent requests. Counting its
  entire discovered catalog as occupied context would overstate usage. Its existing byte-based
  budget estimate is a safety heuristic, not model-exact tokenization.
- Native tool events now carry correlated IDs and bounded results. Reuse them. The displayed
  result is capped and transformed, so its token size need not match what a native provider saw.
- Ollama currently reads input/output counts but its terminal result includes only the final
  model step. Intermediate steps and compaction calls are not a complete consumption ledger;
  duration/cache fields are not preserved. This is an explicit D4/D6 acceptance case.
- [Conversation History](../conversation-history/feature.md) already has provider-owned storage
  and optional projections. Account [Limits](../harness-provider-usage-limits/feature.md) are a
  separate shipped feature. Neither replaces context or invocation accounting.

## Three Separate Measurements

| View | Meaning | Must not imply |
| --- | --- | --- |
| Current context | Latest provider observation or controlled request snapshot | Exact next-request usage or cumulative spending |
| Context sources | Contributions from loaded definitions, instructions, messages and results; potential catalog size shown separately | Every available MCP tool is loaded; estimates sum exactly to the provider total |
| Invocation usage | Reported input/output/cache and elapsed time for each observable request/attempt, with explicit aggregate fallback | A tool has an independently measured share of the entire LLM bill |

An ordinary MCP call does not itself consume LLM tokens. Its generated arguments are output, and
its result can become input on subsequent requests. Repeated inclusion consumes input repeatedly;
current context counts the retained occurrence once. An MCP service that internally calls an LLM
can report a separate child usage record, but that usage is not observable merely from tools/call.

## MCP And Tool Detail

Expand the existing context indicator into a detail panel with categories, then MCP servers, then
individual tools. Sort by measured/estimated size and show method, coverage and observation time.
Provide independent views for the last context snapshot and accumulated observed invocation data.

For each server/tool, retain:

- Opaque source/server identity and original tool name; map generated aliases using adapter
  bindings rather than parsing names heuristically. Include schema/catalog revision.
- Definition size: model-visible name, description and input schema, after adapter transformation.
  Server instructions and discovery summaries are separate sources; do not attribute their whole
  size to every tool or silently omit them from server totals.
- Inclusion: loaded, deferred, available, excluded or unknown, qualified by snapshot/request.
  Omitted native `isLoaded` means unknown. Catalog potential has a separate subtotal.
- Argument and result contributions where observed, with tool-call ID, truncation/transformation
  and retention scope. An SDK context breakdown by tool type is not individual-call attribution.
  Historical transcript sizes are labeled historical, never presented as currently retained after
  compaction. Keep unresolved origins visible rather than assigning them to the closest event.
- Call counts, outcomes and observed duration when supported; replay does not add calls. Linking
  a tool to an LLM invocation does not distribute the invocation's whole usage across those tools.

Other categories include platform/app/profile instructions, applicable repository instructions,
skill listing versus loaded skill content, user and assistant messages, attachments, explicit
retrieval, local tools and summaries. Count each occurrence under one source; an MCP-returned file
can have a file-origin reference without being counted again under both files and MCP results.
Images/binary data need model-aware measurements or explicit unavailability, not a text conversion.

## Measurement And Interface Decisions

Use a small pure TypeScript accounting module with versioned serializable types, validation and
aggregation, isolated from Harness events, UI, Core clients and vendor SDKs. The initial producer
can live beside the current adapters; avoid a package/public SDK release merely to introduce types.
[Agent Providers D2-D4](../agent-provider-interface/plan.md#deliverables) owns their public projection
and extraction into shared provider code. It must not make other consumers depend on Harness.
Core remains application-neutral discovery, identity, grants, resources and lifecycle.

The producer owns provenance and model serialization; the consuming application owns presentation.
Carry schema version, producer/model identity, optional tokenizer/template revision, observation
time, context revision and qualified session/run/turn/request/attempt references where available.
Require neither a Harness conversation nor a workspace. Capabilities declare source and invocation
granularity, method and unavailable reasons. Use nullable measurements: absent is not zero.

Prefer provider diagnostics, then a verified matching local tokenizer and template, then a clearly
labeled local estimate. Count exactly the supplied text only when tokenization is known; that does
not make server-added prompt overhead exact. Do not apply an OpenAI tokenizer as ground truth for
Claude or every Ollama model. Cache estimates by model/tokenizer/source revision, invalidate on
changes, and do not run paid inference just to count tokens. Expose residual/unattributed overhead
and coverage instead of proportionally scaling source counts to force agreement with a total.

### Provider Mapping

- **Claude:** preserve `categories`, `mcpTools` (`serverName`, `name`, `tokens`, optional `isLoaded`),
  memory/skill fields and optional `messageBreakdown` from summary diagnostics. Use category `kind`
  to separate used, free, buffer and deferred rows; do not classify by localized names. Newer
  category IDs and per-server instruction diagnostics require SDK 0.3.304 and are not assumed in
  the pinned release. Default to summary without token-count network requests. Full diagnostics
  are outside the first delivery. Keep current timeout/coalescing/teardown behavior.
- **Ollama:** snapshot the actual selected tools and messages at each `client.chat` call, including
  compaction. Preserve origin/occurrence information through rendering and summarization. Collect
  reported prompt/output/cache counts and provider durations when present, alongside locally
  measured elapsed time; missing fields remain unavailable. Report source attribution as estimated
  unless the actual model tokenizer/template is verified. Never subtract cached input from the
  occupied context merely because inference reused it.
- **Codex:** retain the current native total and distinguish turn/session usage from request usage.
  Use controlled MCP catalog/source estimates with inclusion unknown unless the adapter has
  evidence. Do not label cumulative thread usage or a turn duration as a single model request.
  No full native transcript scraping or hypothetical SDK field is required for initial coverage.

Primary references checked 2026-11-03:
[Claude context diagnostics](https://code.claude.com/docs/en/agent-sdk/typescript#sdkcontrolgetcontextusageresponse),
[Claude usage scopes](https://code.claude.com/docs/en/agent-sdk/cost-tracking),
[Ollama chat response](https://docs.ollama.com/api/chat), and
[MCP tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools).

## Invocation Records And Storage

Each observable model request/attempt has a stable record with purpose (main, compaction or another
reported auxiliary purpose), start/end/elapsed time, outcome, input/output tokens, cache read/write
observations, their inclusion semantics, and optional provider timing phases. Capture failures and
cancelled partial calls as such. TTFT is optional and must define which first event it measures.
Retry attempts are real consumption; transport replay is not. Preserve provider request IDs when
available and distinguish observed time from native execution time.

Connect generated tool-call IDs, consumed tool-result IDs and explicitly reported nested calls.
Normalize repeated Claude usage reports by native message/request identity. Keep native aggregate
records scoped and marked inclusive or exclusive of children; never sum an inclusive parent again
with its children. Unknown coverage stays unknown. Future providers expose the same capability;
unobservable internal requests remain a documented gap, not fabricated records.

Persist bounded measurement metadata in the existing journal/SSE and retain the latest breakdown
and usage summary in receipts, compatible with older sessions. Do not duplicate prompts, raw tool
results or credentials. Reuse conversation access and deletion/retention behavior, without choosing
a new universal retention period. Snapshots and receipt aggregates must identify their covered event
range so reconnect/expired replay cannot count them twice. Background accounting follows execution
events; opening details must not create a polling loop or a second execution pipeline.

## Deliverables

- [ ] D1. Define and validate portable source, snapshot, measurement, invocation, timing/cache and tool-link types, with capability/coverage semantics and the provider-plan handoff.
- [ ] D2. Capture provenance at controlled assembly boundaries for instructions, skills, MCP server/tool definitions, messages/results, attachments and summaries, preserving revisions, inclusion and truncation without duplicate attribution.
- [ ] D3. Extend Claude diagnostics beyond the separately owned MCP-definition detail and normalize Codex observations, with model-aware local estimation fallback and explicit unavailable/unknown detail; retain current meter behavior and diagnostic limits.
- [ ] D4. Collect tokens, timing and cache per observable LLM request/attempt from the outset, correlate tools/results, normalize native aggregates and auxiliary calls, and persist/replay bounded records without duplicate usage.
- [ ] D5. Extend the separately owned MCP panel with other source categories, broader cross-provider server/tool attribution and catalog views beyond the separate Claude/Ollama definition slices, largest contributors, measurement quality and instruction-draft estimates; keep accumulated invocation usage separate from current context.
- [ ] D6. Extend the shipped Ollama adapter beyond the separately owned local MCP-definition estimates: integrate final request assembly, intermediate steps and compaction with the common measurements; validate cache/duration mapping and missing data using pinned fixtures and an authorized real-server smoke check, without implementing another engine.
- [ ] D7. Verify accounting invariants, adapter coverage, access/privacy, bounded overhead and reconnect/receipt compatibility; document actual provider evidence and unresolved capability gaps.
- [ ] D8. Update feature.md with verified behavior, reconcile consuming plans, remove this completed plan, regenerate the index and apply the required implementation version change.

## Order And Scope Recommendation

The separately approved Claude and Ollama MCP definition details are implemented. It does not complete any remaining
D1-D8 here. Design D1 around that observation and extend source assembly for D2/D3/D6;
collect D4 invocation metadata as each producer is extended. Complete D5's broader views and D7
verification before D8. Codex exposes its coverage limits throughout. Each feature uses one
branch/PR under repository rules; this explicit owner-approved split keeps the rest tracked here.

Provider extraction proceeds under its own plan and is not required for this diagnostic. Align
measurement types now; move producers with the three selected independent provider apps later.
Reuse [Action Summary D4](../assistant-action-summary/plan.md#deliverables) for general invocation
normalization instead of duplicating its pipeline. History projection and sharing use the shipped
contract. No timeline, automatic compaction-policy change, prompt rewriting, new Core token service,
mandatory shared profile or in-conversation provider switching is introduced here.

## Readiness And Verification

The owner approved only the separate Claude and Ollama MCP definition slices. This broader scope still requires
explicit approval before Ready. Native runtime field coverage is an acceptance check with explicit fallback,
not permission to invent unavailable attribution. A small Claude-first increment is worthwhile now;
full cross-provider accounting is a larger feature and should not be presented as a few-hour change.

- Verify loaded/deferred/unknown definitions, identical names on two servers, alias mapping, tool
  schema changes, server instructions and unavailable catalogs. Excluded tools add no occupied
  context. Source subtotals and residuals must not manufacture exact agreement.
- Verify non-ASCII/code/JSON estimates, repeated content occurrences, skill listing versus content,
  transformed/truncated results, compaction and model changes. Old current-context contributions
  are replaced, while cumulative consumption remains retained.
- Verify Ollama steps plus compaction, cache hit/miss/absent/zero, interrupted streams, attempts,
  native aggregates, auxiliary usage, inclusive subagents and many tools from one LLM response.
- Verify replay, receipt fallback and retention boundaries; no doubling after reconnect. Keep
  bounded metadata, session isolation and secret absence. Verify UI keyboard/narrow-width behavior
  and old sessions lacking a breakdown.
- For implementation, run affected Harness adapter/session/worker/UI tests, lint and web build;
  run the worker integration suite and relevant Ollama suite through the managed test workflow.
  Use fixtures without paid calls; distinguish them from authorized real-provider observations.
- For this documentation update, run `node scripts/docs-index.mjs --fix`,
  `node scripts/docs-index.mjs --check --base HEAD` and `git diff --check`. No runtime deployment,
  version bump or implementation completion is implied by these document checks.

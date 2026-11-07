---
created: 2026-11-06
updated: 2026-11-06
summary: Transcript-derived MCP call counts and conservative outcomes separated from context and definition estimates.
components: [apps/harness]
---

# Recorded MCP Call Diagnostics

The Harness context dialog starts with recorded MCP calls grouped by server and tool, with counts
for completed, failed/refused, cancelled and unknown outcomes. It opens from the composer even when
no native context measurement exists. Native context totals remain independent of call counts.
Definition estimates stay in a collapsed disclosure; they describe definitions, not tokens consumed
by calls. Existing Claude and Ollama inclusion labels retain their provider-specific meanings.

## Identity, Correlation And Coverage

The browser projects the loaded conversation's existing tool events. Explicit recorded MCP metadata
takes precedence over legacy names; invalid explicit metadata is not replaced by an inferred alias.
Legacy names are accepted only when their server/tool identity is valid. Ordinary tools, approval
names, script contents and orphan results create no MCP call records.

Durable event sequences count once on replay. Results attach only to a unique preceding call ID
inside its recorded user-turn boundary. Reused ambiguous IDs, conflicting results, missing IDs and
unmatched results retain an unknown outcome. A missing result does not establish that work is still
running, and a completed record does not prove semantic operation success.

Counts cover only the loaded transcript. A provider can omit refused proposals, native code/batch
calls or subagent activity. No recorded calls does not establish that a tool was unused or consumed
no tokens. Connecting, reconnecting and disconnected states qualify the available records.

## Context And Delivery

Codex local-source observations explicitly report unknown schema loading and unavailable actual
per-MCP token attribution. Available definition sizes remain local estimates, separate from the
provider's native context observation. Catalog truncation cannot hide a server whose calls are
recorded in the transcript.

Aggregation runs only while the dialog is open and reuses the existing conversation event stream.
Conversation changes reset the dialog and activity view. Compaction can clear the current context
measurement without clearing recorded calls. This diagnostic adds no provider request, discovery,
polling, persistent accounting store or invocation ledger.

The [context indicator](../harness-context-usage/feature.md) owns the native meter and existing
provider measurements. Broader source/token/timing/cache accounting remains in its separate
[Draft plan](../harness-context-usage/plan.md); this diagnostic completes none of D1-D8 there.

## Testing Expectations

- Unit coverage checks replay deduplication, explicit/legacy identities, invalid metadata, large
  catalogs, turn boundaries, ambiguous/repeated IDs, missing/conflicting outcomes and nested tools.
- UI coverage checks counts without a context reading, provider labels, collapsed definitions,
  unavailable attribution and retention of the native meter's percentage and responsive behavior.
- Browser acceptance uses normal Core password login and a managed child with disposable users/data.
  Controlled event-stream fixtures check recorded outcomes, replay, reload, conversation isolation,
  compaction, unavailable catalogs, keyboard focus and narrow layouts without model inference.
  Controlled frames do not establish backend persistence or live-provider measurement accuracy.
- Core/Shell launch and iframe identity use actual managed preview URLs; the direct embedded composer
  flag alone does not establish Shell embedding. Finish the owned environment after verification.
- Run the full Harness suite after the production web build, backend/web lint and type checks,
  Worker integration, version consistency, documentation/index validation and diff checks.

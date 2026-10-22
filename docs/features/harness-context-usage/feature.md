---
created: 2026-10-22
updated: 2026-10-22
summary: Current context-window usage for Claude and Codex conversations, with durable replay and a compact composer indicator.
components: [apps/harness]
---

# Harness Context Usage

Harness shows the latest context observation near the composer controls in both the full-page
chat and the embedded assistant. The indicator displays used tokens, the provider-reported
window and its percentage, with a compact progress bar. It has no category breakdown.

## Provider Measurements

- Codex reads `thread/tokenUsage/updated` for the active thread and turn. The count comes from
  `tokenUsage.last.totalTokens`, and the limit from `modelContextWindow`. Cumulative session
  usage is not used. Cached input and reasoning output are already included in the reported
  total, so they are not added again.
- Claude uses `getContextUsage({ detail: "summary" })` from the installed Agent SDK. It reads
  `totalTokens` and `maxTokens`; the latter may be the provider's compaction limit. Reads follow
  initialization, distinct main-session assistant messages, compaction and turn completion.
  Subagent messages do not trigger readings for the main session.
- Both readings are marked as estimates of current context. They describe the latest observation,
  rather than an exact prediction of the next request or cumulative billed tokens.

Claude reads run alongside message processing, coalesce concurrent requests and discard readings
superseded by a newer request. A final bounded read precedes the result event because worker
teardown follows that event. Each diagnostic times out after 1.5 seconds. Failures clear the
reading without failing the conversation; a timed-out request disables further diagnostics for
that native run to avoid accumulating unresolved control requests. Teardown cancels the local
wait and ignores late replies. Summary reads do not request detailed token-count API calculations.

Compaction clears the previous observation and subsequent readings replace it. A saved model
selection also clears the indicator until another observation arrives. Counts may decrease.
A valid zero is shown as zero; absent or invalid measurements are shown as **Not available**.
A known count without a valid limit remains visible without a percentage or bar. Counts above
the reported limit retain their real percentage while the visual bar stops at 100%.

## Persistence And Delivery

The common `context_usage` event carries either an unavailable value or a snapshot containing
`usedTokens`, nullable `maxTokens`, `estimated` and `observedAt`. Native sessions persist these
events in the existing session journal. The existing authenticated SSE stream delivers live
changes and replays them on reload or reconnect; no polling endpoint or additional connection
is used.

Workers retain the latest context frame in the run receipt as well as the event journal.
When detailed replay expires, the client restores that frame before the synthetic final text
and terminal receipt advance the coordinator cursor. Older receipts and sessions without
context data remain readable without migration.

The browser keeps the latest snapshot for the attached session, rejects older sequence numbers
and callbacks from another session, and excludes diagnostic events from the visible transcript.
Switching conversations clears the previous reading. While disconnected, the last reading
remains visible; the tooltip identifies it as the last measurement and includes its timestamp.

The indicator has an accessible label and meter value, and its explanation is available on
keyboard focus as well as hover. It uses the existing theme and shared shadcn progress/tooltip
components.

See [Hosty Harness](../ai-gateway/feature.md) for the conversation surface and
[Assistant Shared Docker Runtime](../assistant-shared-docker-runtime/feature.md) for execution and recovery.

## Testing Expectations

- Normalization tests distinguish current and cumulative counts, avoid double-counting cached
  or reasoning tokens, and cover invalid values, missing windows, zero and over-limit readings.
- Adapter tests cover Codex thread/turn isolation and compaction, and Claude summary sampling,
  subagent exclusion, coalescing, diagnostic failures, timeouts and teardown.
- Session tests cover durable SSE delivery, reconnect, reload, model reset, cancelled-run
  callbacks and conversation isolation. Worker recovery tests retain the context observation
  after detailed replay expires, with and without final text, for success and failure.
- The worker Docker fixture exercises the real Claude summary control without submitting a prompt.
- UI tests cover estimates, unknown counts, missing limits, percentages above 100%, keyboard
  tooltip access, replay ordering and exclusion from the transcript.
- Run `npm run harness:test`, `npm run harness:lint`, `npm run harness:build-web`,
  `npm run test:integration -- worker`, `node scripts/check-versions.mjs`,
  `node scripts/docs-index.mjs --check` and `git diff --check`.
  Build the web export before the full test suite; gateway tests serve its static pages.
- Browser verification of Hosty login and embedding requires a supported Core-managed sandbox.
  The external workspace MCP client used for this implementation exposes no sandbox lifecycle
  adapter, so that runtime/browser check is not claimed. Isolated worker Docker tests use no
  provider credentials and do not establish real-provider context accuracy.

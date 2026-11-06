---
created: 2026-10-22
updated: 2026-11-04
summary: Current context usage for Claude, Codex and Ollama, with MCP definition detail, durable replay and a compact composer indicator.
components: [apps/harness]
---

# Harness Context Usage

Harness shows the latest context observation as a compact circular indicator immediately after
the provider selector in the composer, in both the full-page chat and the embedded assistant.
The ring contains a stacked-pages icon and the percentage sits beside it with a `used` suffix.
The suffix hides below a 640 CSS px composer width while the icon and percentage stay visible.
The neutral ring fills with context usage, turns warning-colored at 80% and destructive at 100%.
The adjacent account-limit ring uses an hourglass and measures remaining allowance instead.
The shared tooltip exposes used tokens, the provider-reported window, percentage, estimate status
and measurement time, and remains available on keyboard focus. Claude observations with MCP metadata
open a [server/tool detail dialog](../claude-mcp-context-detail/feature.md). Ollama uses the same dialog
with explicitly labeled [local estimates and sent/catalog inclusion](../ollama-mcp-context-detail/feature.md).
Codex adds [local estimates of Hosty instructions and MCP definitions](../codex-local-context-detail/feature.md)
with explicit unknown inclusion, alongside its unchanged native total. Other context categories have no drill-down.

## Provider Measurements

- Codex reads `thread/tokenUsage/updated` for the active thread and turn. The count comes from
  `tokenUsage.last.totalTokens`, and the limit from `modelContextWindow`. Cumulative session
  usage is not used. Cached input and reasoning output are already included in the reported
  total, so they are not added again.
- Claude uses `getContextUsage({ detail: "summary" })` from the installed Agent SDK. It reads
  `totalTokens` and `maxTokens`; the latter may be the provider's compaction limit. Reads follow
  initialization, distinct main-session assistant messages, compaction and turn completion.
  Subagent messages do not trigger readings for the main session.
- Ollama reads the reported `prompt_eval_count` for the latest ordinary chat request and the
  configured `num_ctx` window. The total is provider-reported; its optional MCP definition detail
  is a separate local estimate. Missing or invalid prompt counts clear the observation, while zero
  remains valid. Auxiliary compaction calls do not replace the ordinary-request snapshot.
- Claude and Codex readings are marked as estimates of current context. They describe the latest observation,
  rather than an exact prediction of the next request or cumulative billed tokens.

Claude reads run alongside message processing, coalesce concurrent requests and discard readings
superseded by a newer request. A final bounded read precedes the result event because worker
teardown follows that event. Each diagnostic times out after 1.5 seconds. Failures clear the
reading without failing the conversation; a timed-out request disables further diagnostics for
that native run to avoid accumulating unresolved control requests. Teardown cancels the local
wait and ignores late replies. Summary reads do not request detailed token-count API calculations.

Compaction clears the previous observation and subsequent readings replace it. Changing the selected
model, including switching to or from the provider default, clears the indicator until another
observation arrives. Changing only reasoning effort, returning to default effort, or saving the
same selection preserves the last observation and its timestamp through reconnect and reload.
The next provider measurement replaces it normally. Counts may decrease.
A valid zero is shown as zero; absent or invalid measurements are shown as **Not available**.
A known count without a valid limit remains available in the tooltip without a percentage or
filled ring. Counts above the reported limit retain their real percentage while the visual ring
stops at 100%.

## Persistence And Delivery

The common `context_usage` event carries either an unavailable value or a snapshot containing
`usedTokens`, nullable `maxTokens`, `estimated` and `observedAt`, plus optional bounded MCP definition
metadata described in [Claude MCP Context Detail](../claude-mcp-context-detail/feature.md) and
[Ollama MCP Context Detail](../ollama-mcp-context-detail/feature.md), and optional local source metadata
described in [Codex Local Context Detail](../codex-local-context-detail/feature.md). Native sessions persist these
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
keyboard focus as well as hover. The decorative SVG ring uses the existing theme and the
explanation uses the shared shadcn tooltip.

See [Hosty Harness](../ai-gateway/feature.md) for the conversation surface and
[Assistant Shared Docker Runtime](../assistant-shared-docker-runtime/feature.md) for execution and recovery.


The adjacent [Limits control](../harness-provider-usage-limits/feature.md) describes account quota
and credits. It does not change this context meter or use billed tokens as account allowance.

## Testing Expectations

- Normalization tests distinguish current and cumulative counts, avoid double-counting cached
  or reasoning tokens, and cover invalid values, missing windows, zero and over-limit readings.
- Adapter tests cover Codex thread/turn isolation and compaction, and Claude summary sampling,
  subagent exclusion, coalescing, diagnostic failures, timeouts and teardown.
- Session tests cover durable SSE delivery, reconnect, reload, effort-only/default/no-op preservation, actual-model invalidation, cancelled-run
  callbacks and conversation isolation. Settings teardown retires the old native run only after
  a successful stop; late callbacks cannot clear context or replace native identity, while a failed
  stop preserves the selection and live callback authority. Worker recovery tests retain the context observation
  after detailed replay expires, with and without final text, for success and failure.
- The worker Docker fixture exercises the real Claude summary control without submitting a prompt.
- UI tests cover the stacked-pages circular indicator, used label, warning thresholds, estimates, unknown counts,
  missing limits, percentages above 100%, keyboard tooltip access, replay ordering and exclusion
  from the transcript. Check full-page and embedded composers at desktop and narrow widths.
- Run `npm run harness:test`, `npm run harness:lint`, `npm run harness:build-web`,
  `npm run test:integration -- worker`, `node scripts/check-versions.mjs`,
  `node scripts/docs-index.mjs --check` and `git diff --check`.
  Build the web export before the full test suite; gateway tests serve its static pages.
- Browser verification of Hosty login and embedding requires a supported Core-managed sandbox.
  Isolated Worker and Ollama HTTP fixtures use no provider credentials and do not establish
  real-provider context accuracy. Keep native totals distinct from local source estimates.

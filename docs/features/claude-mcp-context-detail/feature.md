---
created: 2026-11-03
updated: 2026-11-04
summary: Claude context diagnostics expose estimated MCP definition tokens by server and tool, with loaded, deferred and unknown inclusion states.
components: [apps/harness]
---

# Claude MCP Context Detail

## Behavior

The [context indicator](../harness-context-usage/feature.md) opens an MCP detail dialog when its
latest observation includes Claude MCP metadata. Click, Enter or Space opens the dialog; Escape
closes it and returns focus to the indicator. The existing total, tooltip and observation timestamp
remain available. Opening the dialog makes no network request.

Servers expand into individual tool names and token estimates, ordered by definition size. Server
subtotals separate loaded, deferred and unknown inclusion. A missing native loaded flag stays
unknown. Deferred definitions are available on demand; their size is not added to loaded usage.
Same-named tools on different servers remain distinct, and zero is a valid measurement.

The numbers describe tool definitions only. They exclude tool results and server instructions and
are not billed usage or exact next-request sizes. Definition estimates need not sum to the overall
context observation. The UI marks estimates and the last measurement time, including disconnected
state. Long names wrap, the body scrolls at constrained heights and the close control remains
visible. Missing metadata retains the existing meter/tooltip; an explicitly empty list reports that
no definitions were reported. Invalid or capped rows produce a partial-detail notice.

## Measurement And Delivery

The adapter preserves `mcpTools` from its existing
`getContextUsage({ detail: "summary" })` call. This uses native local estimates and last-response
usage, without the full diagnostic's per-category token-count calls. The diagnostic schedule,
1.5-second timeout, coalescing, teardown and compaction invalidation are unchanged.

Claude's optional `ContextUsage.mcp` field contains version 1, method `provider-estimate`, tool rows and
an omitted-entry count. The shared format also supports [Ollama local estimates](../ollama-mcp-context-detail/feature.md)
with a named estimator and separate available-catalog inclusion; Claude's method remains unchanged. Each row contains only server/name/token count and loaded/deferred/unknown
inclusion. The pure metadata module has no runtime dependency on vendor SDKs, Core or UI.
It keeps at most 256 rows and 256 characters per name; rejects malformed, duplicate and unsafe-total
rows; and discards other SDK fields. The browser rebuilds the validated optional detail without
hiding a valid total when detail is malformed. No schemas, prompts, arguments or results are copied.

The existing session journal, authenticated SSE replay and Worker receipt snapshot carry the detail.
Older snapshots without it remain readable. Resetting context or changing conversations removes
its dialog; later observations replace the snapshot rather than accumulating historical definitions.
No extra polling, database or Core API is introduced.

## Scope And Verification Evidence

The owner approved this feature's separate Ready plan and implementation on 2026-11-03. Its three
deliverables cover bounded metadata/delivery, accessible drill-down, and verified documentation and
versioning. The completed plan is retired under the repository workflow. The remaining
[Context Token Accounting Draft](../harness-context-usage/plan.md) retains other source categories,
per-call tokens/time/cache, result attribution, instruction previews and Ollama/Codex accounting.
[Agent Providers](../agent-provider-interface/plan.md) retains public contract and extraction work.
Harness advances from **0.86.2 to 0.87.0**, including its Worker package; Core and SDK versions do not change.

Verification on macOS with Docker Desktop Linux arm64:

- `npm run harness:test` passes 2,110 tests across 199 files after integrating main
  `206a3289` on 2026-11-04. This includes both providers and strict inclusion validation.
- `npm run harness:build-web` and `npm run harness:lint` pass after the final code edit. Lint retains
  one pre-existing `tasks.tsx` hook-cleanup warning.
- `npm run test:integration -- worker` passes after the final edit/version synchronization. The
  real pinned Claude SDK 0.3.296 connects to an in-process MCP fixture and exposes its server/tool
  estimates through summary diagnostics with networking disabled and no model prompt or credentials.
  On 2026-11-04 the rebuilt Worker passes native lifecycle tests, but the control test encounters
  Docker disk exhaustion (ENOSPC). The same control test passes with `/tmp` and
  `/run/hosty-execution` mounted as tmpfs; no unrelated Docker resources are deleted.
- An isolated Core-managed child (Core 0.169.3) runs the built Docker app. Normal password login
  and app authorization work. A synthetic context observation seeded only into its idle test chat
  verifies production UI replay after reload, server/tool sorting, zero/unknown/deferred values,
  long names, a 390 × 844 viewport, Enter/Escape and focus restoration. It is UI-fixture evidence,
  not measured token accuracy in a paid conversation. The older child reports unsupported unrelated
  Decisions permissions; none are granted or needed for this check.
- Finish succeeds after browser/fixture consumers stop: the child process and owned data/resources
  are removed. Production app selection and data are unchanged.
- Version consistency, documentation index/links and whitespace checks pass. Windows and live
  paid-provider token accuracy are not exercised by this bounded change.

## Testing Expectations

- Keep loaded/deferred/unknown, missing/empty, zero, invalid enum/count/name, duplicate server/tool
  identity, bounded rows and aggregate overflow covered. Optional invalid detail must preserve a
  valid total and cannot leak unrelated SDK fields.
- Keep native summary-only diagnostics, subagent exclusion and final snapshot ordering covered;
  verify the pinned real SDK's MCP fixture without paid inference.
- Retain session isolation, reset/compaction, SSE replay and expired Worker receipt coverage with
  MCP detail present as well as older observations without it.
- Verify sorting, separated subtotals, partial/empty states, keyboard opening/closing and focus,
  long names and narrow-screen scrolling. Opening detail must not fetch or poll.
- Run affected Harness tests, production web build/lint and Worker integration, plus
  `node scripts/check-versions.mjs`, `node scripts/docs-index.mjs --check --base HEAD` and
  `git diff --check`. Use a Core-managed test environment and ordinary identity for browser checks.

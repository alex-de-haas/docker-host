---
created: 2026-11-03
updated: 2026-11-04
summary: Ollama context detail shows local MCP definition estimates by server and tool, distinguishing sent definitions from the available catalog.
components: [apps/harness]
---

# Ollama MCP Context Detail

## Behavior

The [context indicator](../harness-context-usage/feature.md) opens the shared MCP detail dialog for
Ollama observations. It groups definitions by their original server and tool names, orders them by
estimated size, and separates Sent in request from Available, not sent. The latter is catalog
potential and contributes nothing to the sent subtotal. Same-named tools on different servers remain
distinct. The panel retains timestamp, disconnected state, partial-detail notices, keyboard focus
handling and narrow-screen scrolling from [Claude MCP detail](../claude-mcp-context-detail/feature.md).

The panel explicitly labels the method **Local estimate** and explains the heuristic: the UTF-8
byte length of each serialized JSON tool definition divided by four, rounded up. It includes the
actual wire alias, transformed/truncated description and input schema. This rough size comparison
has no model tokenizer or prompt-template awareness. Rows and subtotals carry approximation marks;
they are not scaled to match the overall context total. No model call is made to obtain the estimate.

The overall meter keeps Ollama's reported prompt count and configured context window. Its count
is not replaced by the local estimate. A valid reported zero is retained; an absent, negative or
fractional prompt count clears the stale observation. Failed requests do not invent a measurement.
These observations describe the last measured ordinary request, not cumulative spending or a
prediction of the next request.

## Snapshot And Delivery

The adapter snapshots the actual tool array and authorized catalog before each ordinary chat call,
using explicit alias bindings for attribution. A discovery call replaces the selection for the next
request; it cannot retroactively mark a tool sent in the preceding request. Auxiliary compaction
calls do not overwrite this ordinary-request snapshot. The existing byte/2 budget guard is unchanged.

The portable optional MCP payload keeps version 1, a local-estimate method, the named estimator
utf8-json-div4-v1, bounded rows and an omitted count. Loaded means sent for this producer; available
means a catalog definition was not sent. The UI uses the producer-specific explanations. Claude's
existing provider-estimate observations remain compatible. The common validator caps metadata at
256 rows and 256 characters per name, rejects invalid/duplicate/unsafe entries, and accepts local
measurements only with the supported estimator identifier. Sent definitions take precedence over
catalog copies and are retained first when applying the detail limit.

Only original server/tool identity, estimated count and inclusion are persisted. Schemas,
descriptions, prompts, arguments, results and credentials are not copied into telemetry. The existing
session journal, authenticated SSE replay and Worker receipts carry the optional payload. Invalid
optional metadata cannot hide a valid total; old sessions without detail remain readable. Opening
the dialog performs no fetch or polling.

## Scope

The owner approved the small Ready plan and implementation on 2026-11-03. All three deliverables
(metadata, presentation and verification/documentation) are complete; the completed plan is retired
under the repository workflow. This feature shares the
Harness 0.88.0 release with Claude MCP detail; Core and SDK versions are unchanged.
The [main accounting Draft](../harness-context-usage/plan.md) retains exact model/template
tokenization, other source categories and local tools, argument/result attribution, per-call
tokens/time/cache and full compaction accounting. [Agent Providers](../agent-provider-interface/plan.md)
retains public provider contracts and extraction. Core receives no accounting service or app-specific
behavior from this feature.

## Verification Evidence

Verified on 2026-11-03 on macOS arm64 with Docker Desktop. Tests, build/lint and managed
Ollama integration also pass on 2026-11-04 after integrating main `206a3289`:

- The affected adapter/context/session/receipt/UI run passes 103 tests across eight files.
  The final full `npm run harness:test` run passes 2,110 tests across 199 files.
- `npm run harness:build-web` and `npm run harness:lint` pass after the last product-code edit.
  Lint retains one pre-existing `tasks.tsx` hook-cleanup warning.
- `npm run test:integration -- worker` passes, including the pinned real Claude SDK summary
  diagnostic, preserving provider-estimate compatibility without a model prompt. The 2026-11-04
  repeat requires tmpfs for its temporary directories because the Docker disk is full; the
  same native control test passes without networking or credentials.
- `HOSTY_OLLAMA_ACCEPTANCE=1 npm run test:integration -- harness-local` passes with the real
  adapter, an HTTP Ollama fixture and a Core-managed child. The test now answers through the
  current shared Decisions API and calls the authorized Harness MCP `context_list` tool; it does
  not rely on a removed workspace alias or grant an optional Core MCP offer. Request-specific
  estimates, sent/catalog separation, tool correlation and restart persistence pass.
- Normal browser password login, persisted detail, source labels, sorting, Enter/Escape and focus
  restoration pass. At 390 × 844 the dialog fits within the viewport and its body scrolls without
  horizontal overflow. The HTTP fixture has stopped by the browser review, so the provider's
  availability warning is expected; the review inspects the last persisted observation.
- The managed local runtime reports a 25.445-second cold start, 1.947-second warm restart and
  23.266-second missing-output recovery. After the browser closes, Finish confirms child resource
  removal; the parent fixture confirms its processes, port, temporary source, credentials and
  snapshots are removed. The 2026-11-04 repeat reports 30.402 seconds cold, 2.070 seconds warm
  and 23.919 seconds for missing-output recovery, and confirms the same cleanup. Production data
  and runtime selection are unchanged.
- Documentation/index/link, version consistency and whitespace checks pass. Windows and real-model
  tokenizer accuracy are not exercised; exact tokenization remains in the main Draft.

## Testing Expectations

- Verify actual request selection before and after discovery, selection replacement, aliases,
  transformed schemas/descriptions, equal names on different servers, Unicode, empty catalogs and
  bounded detail. Keep sent and available subtotals independent; never normalize to the native total.
- Verify known/missing estimator metadata, invalid counts, old Claude observations, zero and missing
  native usage, reset, session isolation and replay. Auxiliary compaction must not replace the
  ordinary-request snapshot. Persist only the allowlisted measurement fields.
- Verify the visible Local estimate explanation, native total without a local approximation marker,
  approximate source rows, sent/available labels, sorting, keyboard focus and narrow widths.
- Run Harness tests, web build/lint, Worker Docker integration and
  `HOSTY_OLLAMA_ACCEPTANCE=1 npm run test:integration -- harness-local`. The latter uses a synthetic
  HTTP Ollama fixture through normal Core identity, real adapter requests, MCP discovery and restart.
  It verifies data flow and the stated heuristic, not tokenizer accuracy for a real model.
- Use a Core-managed isolated environment for browser checks, then Finish it through its owner.
  Check documentation/index links, version consistency and whitespace before publication.

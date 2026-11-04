---
created: 2026-11-04
updated: 2026-11-04
summary: Local Codex estimates for Hosty instructions and MCP definitions by server and tool, separate from the native context total.
components: [apps/harness]
---

# Codex Local Context Detail

The context indicator opens a local estimate dialog for Codex observations. The ring, percentage,
used tokens, window and native observation time retain their existing meaning. Local source
estimates are independent metadata; they are never added to or scaled against the native total.
No diagnostic opens an LLM request, requires an API key or sends text to a token-counting service.

## Sources And Meaning

Hosty instruction rows cover the platform introduction, runtime instructions and saved operator
block. The operator block contains the workflow, settings and profile text already assembled for
that session; legacy snapshots remain a single block. Provenance travels beside the unchanged
prompt and is accepted only when the blocks reproduce it. The UI labels these rows as text
provided by Hosty. Wrappers, separators, native instructions and retention after compaction are
outside the estimate. Reconfiguring MCP retains the estimates of instructions already supplied.

The MCP section groups definitions by native server identity and original tool name. It estimates
JSON containing name, description and input schema. Generated aliases, endpoints, credentials,
annotations, server instructions and tool results do not enter this definition count. Servers and
tools are sorted by estimated size, with a separate subtotal for each server. Every Codex tool row
says available catalog with inclusion unknown: catalog discovery establishes neither current
loading nor exclusion. Other providers retain their existing inclusion labels and estimators.

The producer uses pinned js-tiktoken 1.0.21 and bundled o200k_base ranks. It counts bounded chunks
of at most 1,024 UTF-16 code units without splitting surrogate pairs. This bounds pathological BPE
work but adds approximation at chunk boundaries. Special-token-like text is encoded literally.
The versioned estimator is `o200k-base-chunks-1024-v1`; it is a proxy for comparison, not a verified
match for the selected Codex model or its request template. All source counts visibly use ≈ and
an explicit local-estimate explanation. The tokenizer stays on the backend, outside the UI bundle.

## Collection And Lifecycle

The adapter reads `mcpServerStatus/list` once after starting or resuming the native thread, using
that thread ID and `toolsAndAuthOnly`. The pinned Codex 0.162.1 protocol supports both fields.
MCP replacement starts a resumed native process and collects a fresh catalog. Opening the dialog
performs no discovery or polling. Within-run catalog changes are not automatically tracked.

Collection shares a five-second deadline, with at most eight pages of 32 servers and 256 examined
tool definitions. Each counted source is limited to 128 KiB UTF-8; MCP tokenization has a 512 KiB
aggregate input budget. Oversized or invalid entries are omitted instead of represented as zero.
The producer yields between definitions and the tokenizer is initialized once per worker process.
The snapshot retains counts, so repeated observations do not re-tokenize unchanged sources.

The UI exposes pending, observed, partial or unavailable catalog coverage with collection time.
Omitted-entry counts cover observed entries only; unvisited pages can make coverage partial without
an exact omitted count. Failed diagnostics leave the native total usable. A valid native observation
is required to display this detail; there is no invented initial total. Fast turns with a native
observation wait for the bounded diagnostic before emitting the terminal result, because worker
completion closes the native process. Stop ignores late replies; compaction clears the entire
current observation and cannot be undone by late catalog completion.

Versioned source and MCP metadata use a dependency-free TypeScript contract. Event payloads
contain source IDs, server/tool names, counts, method and coverage/time only: no prompt text,
descriptions, schemas, URL or credential fields. The browser validates and rebuilds the allowlist;
malformed optional detail does not hide a valid native total. Worker receipts, journal replay and
session reload retain the optional metadata. Old observations without it retain the simple meter.
Core has no tokenizer, provider-specific API or application dependency from this feature.

The owner-approved slice completed D1-D5: local estimator/provenance, native collection/lifecycle,
UI, verification and documentation/versioning. Harness and its worker release are 0.89.0.
The [main accounting plan](../harness-context-usage/plan.md) retains repository instructions,
skills, arguments/results, full history, server instructions, exact model/template tokenization,
editor previews and per-invocation tokens/time/cache. Provider extraction and timeline remain with
[Agent Providers](../agent-provider-interface/plan.md) and
[Timeline Analysis](../assistant-timeline-analysis/plan.md).

## Testing Expectations

- Estimator and contract tests cover Unicode, JSON, literal special tokens, bounds, invalid and
  duplicate metadata, original tool identities, pagination, partial/unavailable collection and
  absence of content from measurement payloads.
- Adapter tests preserve native totals/timestamps, thread/turn isolation, timeout, compaction,
  stop and MCP replacement; delayed catalog completion precedes worker-style terminal teardown.
- Worker and session tests cover instruction provenance validation, durable events, snapshots and
  replay. UI tests cover old observations, unavailable catalogs, local labels, native meter
  stability, disconnected state, keyboard dismissal and reset.
- Run `npm run harness:test`, `npm run harness:lint` and `npm run harness:build-web`.
  Run `npm run test:integration -- worker`; its native controls include real pinned Codex and
  disposable stdio MCP discovery without credentials or a model turn. On hosts with constrained
  Docker writable layers, both native commands also support disposable `/tmp` and
  `/run/hosty-execution` tmpfs mounts; this does not require pruning unrelated resources.
- Run `HOSTY_CONTEXT_BROWSER=1 npm run test:integration -- harness-local` with Playwright available
  (or its module path in `HOSTY_CONTEXT_PLAYWRIGHT_MODULE`). The parent-managed child Core checks
  normal password login, production API/worker/static assets, keyboard and mobile dark dialog
  behavior, unavailable catalog and compaction. Only diagnostic SSE is synthetic; this is not
  evidence of model-exact token counts or live inference. The suite also checks warm restart and
  missing-output recovery, then confirms parent Finish removes child resources.

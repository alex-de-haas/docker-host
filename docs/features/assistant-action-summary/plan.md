---
status: Draft
created: 2026-09-26
updated: 2026-10-27
summary: Correlated native invocation evidence and readable summaries of the tools and MCP calls used during a session.
components: [apps/harness]
---

# Assistant Action Summary

Part of [shared assistant development sessions](../assistant-development-sessions/plan.md).
The umbrella's common invariants apply; this feature has independent scope and requires its own Ready approval.

## Target Behavior

Owner follow-up, 2026-09-25: alongside source diffs, show a readable summary of the tools and MCP
calls used during the session. This also applies to operational conversations without source edits.
An operator should be able to see what the agent inspected, changed, tested or published without
reading every tool event. Example: inspected Media Server logs; changed four files; ran two test
commands, one initially failed and was retried successfully; opened a PR.

Provide two levels: a compact overview grouped by app/repository and action kind, with expandable
invocations showing the agent, tool/MCP server, purpose when supplied, observed status, relevant
target and bounded result. Link to source diffs, test evidence and PRs when explicit identifiers
support that association. A requested action or claimed intention is not proof of its effect.
Do not infer a file change's author or a successful test solely from a nearby tool name/event.

AHP's chat model provides tool-call lifecycle, names, optional intentions and input, MCP contributor
identity and results. Use those primitives for client presentation. Hosty owns aggregation and any
optional model-written narrative; AHP does not create a reliable session summary on its own. Native
adapter and controlled MCP-boundary observations must first provide stable invocation/turn ids,
provider attribution and terminal results. D4 inventories current native adapter and worker
evidence before filling any remaining correlation or persistence gaps; older observations do not establish that every gap is still present.

Derive counts and outcomes from recorded events; distinguish pending, denied/cancelled, failed,
successful and unknown/incomplete invocations. Link retry attempts to a logical operation where
that identity exists; do not double-count replayed events or present retries as unrelated achievements.
Record producer-observed timing only when available rather than inventing tool durations. A tool's
success is not independently verified runtime health, CI success or satisfaction of the user's goal.

If a model produces the readable narrative, label it as generated and retain links to its supporting
events plus the last included event revision. Refresh after new work and recovery without
replacing the underlying history. Show coverage gaps: external-agent reports are reported evidence,
not a complete trace of that agent's local tool calls. Both internal providers must expose comparable
coverage or clearly identify unavailable fields.

Use the existing authorization/audit ownership in assistant approval rules; this is a session view,
not another Core audit system. Redact sensitive arguments/results before persistence or model/client
exposure, bound retained output and keep access aligned with the underlying session/evidence. Decide
retention and detail limits before implementation. Summaries cannot authorize calls or replace merge,
test and Complete gates that use actual evidence.

Owner decision, 2026-10-27: this plan receives the former Shared History D1 event-foundation work
as D4. Extend the existing native adapters and Harness journal once, with stable session/turn/call
IDs, provider/account attribution, schema compatibility and observed terminal evidence. Missing
legacy results stay unknown. Domain event identities remain independent of wire cursors and SDK
DTOs; duplicate delivery and append-before-ack recovery must not inflate the journal. Reuse that
stream for summaries, timeline analysis and AHP; no second adapter pipeline or transcript is added.
[Agent Providers D2](../agent-provider-interface/plan.md#deliverables) owns its public invocation
projection; [Durable Agent Jobs D7](../durable-agent-jobs/plan.md#deliverables) owns session command
and continuation recovery. These transfers remain Draft and do not claim new runtime behavior.
Timeline analysis requires independent approval in [its own plan](../assistant-timeline-analysis/plan.md) and does not gate this feature.

## Deliverables

- [ ] D1. Implement deterministic action counts/outcomes and evidence links over the shared invocation stream.
- [ ] D2. Implement compact and expanded summary UI with coverage, retry and provider attribution.
- [ ] D3. Implement optional generated narrative with event coverage and redaction/retention rules.
- [ ] D4. Inventory and complete normalized native invocation/turn IDs, provider/account attribution, terminal evidence and durable ingestion in the existing Harness journal; verify legacy schema recovery, unknown outcomes and duplicate/replayed events for both providers independently, without coupling persistence to AHP or requiring the summary UI.

## Open Questions

- Which invocation fields and results can each adapter reliably expose, what output is retained or
  redacted, and which action-summary details are deterministic versus generated? How are partial traces,
  timing, retry groups and associations with changed files represented without overclaiming?

## Verification

- In separate sessions for each internal provider, exercise a successful MCP read, a rejected operation,
  a failing test followed by a successful retry, and a call interrupted by restart. Verify accurate
  per-call outcomes and grouped counts after reconnect/replay; unknown completion stays unknown.
  Expand the summary to its evidence, check that new work invalidates its coverage marker, secrets
  are omitted, and external reports are not presented as a complete observed invocation trace.

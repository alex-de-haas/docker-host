# Assistant Action Summary

Status: Draft
Created: 2026-09-26
Updated: 2026-09-26

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
provider attribution and terminal results. At this baseline, Gateway's normalized `tool_use` event
does not carry a correlated per-call completion, so a complete result summary requires adapter work.

Derive counts and outcomes from recorded events; distinguish pending, denied/cancelled, failed,
successful and unknown/incomplete invocations. Link retry attempts to a logical operation where
that identity exists; do not double-count replayed events or present retries as unrelated achievements.
Record producer-observed timing only when available rather than inventing tool durations. A tool's
success is not independently verified runtime health, CI success or satisfaction of the user's goal.

If a model produces the readable narrative, label it as generated and retain links to its supporting
events plus the last included event revision. Refresh after new work and provider switches without
replacing the underlying history. Show coverage gaps: external-agent reports are reported evidence,
not a complete trace of that agent's local tool calls. Both internal providers must expose comparable
coverage or clearly identify unavailable fields.

Use the existing authorization/audit ownership in assistant approval rules; this is a session view,
not another Core audit system. Redact sensitive arguments/results before persistence or model/client
exposure, bound retained output and keep access aligned with the underlying session/evidence. Decide
retention and detail limits before implementation. Summaries cannot authorize calls or replace merge,
test and Complete gates that use actual evidence.

The [shared-history feature](../assistant-shared-history/plan.md) owns normalized invocation IDs,
terminal states and durable event ingestion. This feature owns their aggregation and presentation;
it does not build a second adapter event pipeline. Timeline analysis requires independent approval in
[its own plan](../assistant-timeline-analysis/plan.md) and does not gate this feature.

## Deliverables

- [ ] Implement deterministic action counts/outcomes and evidence links over the shared invocation stream.
- [ ] Implement compact and expanded summary UI with coverage, retry and provider attribution.
- [ ] Implement optional generated narrative with event coverage and redaction/retention rules.

## Open Questions

- Which invocation fields and results can each adapter reliably expose, what output is retained or
  redacted, and which action-summary details are deterministic versus generated? How are partial traces,
  timing, retry groups and associations with changed files represented without overclaiming?

## Verification

- In a session using both internal agents, exercise a successful MCP read, a rejected operation,
  a failing test followed by a successful retry, and a call interrupted by restart. Verify accurate
  per-call outcomes and grouped counts after reconnect/replay; unknown completion stays unknown.
  Expand the summary to its evidence, check that new work invalidates its coverage marker, secrets
  are omitted, and external reports are not presented as a complete observed invocation trace.

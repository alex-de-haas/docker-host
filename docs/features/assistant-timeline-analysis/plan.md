# Assistant Timeline And Tool Analysis

Status: Draft
Created: 2026-09-26
Updated: 2026-09-26

Part of [shared assistant development sessions](../assistant-development-sessions/plan.md).
The umbrella's common invariants apply; this feature has independent scope and requires its own Ready approval.

## Target Behavior

Exploratory owner direction, 2026-09-25: extend the action summary with a timeline to understand how
agents work, improve their instructions and identify useful new MCP tools. This is a later analysis
capability built on observed events, not a requirement to automate instruction changes or tool creation.

Show turns and attributed actions over time: request accepted, provider execution, streamed response,
tool/MCP start and completion, retries, approval/user-input waits, cancellation and interruption.
Represent concurrent calls as overlapping spans, not a falsely sequential list. Use producer-measured
durations and event ordering where available; mark missing timing and clock uncertainty rather than
summing parallel durations into session elapsed time. Idle gaps remain unclassified unless their
cause is observed. An adapter-reported reasoning activity may be labelled as such, but silence is not
proof of thinking and this feature neither needs nor promises access to private model reasoning.

Allow filtering by agent/connection, app/repository, tool/MCP server, outcome and turn. Expand a span
to the same evidence used by the action summary. Initially inspect one session; aggregate authorized
sessions to compare call frequency, observed latency, errors, retries and recurring command sequences.
Retain coverage indicators and distinguish invocation attempts from deduplicated logical operations.
Normalize commands for grouping without retaining credentials or conflating different targets.

For possible alternatives to shell/CLI/direct HTTP calls, record the tool catalogue/capability and
permission revisions actually available to the agent at dispatch, plus the relevant instruction
revision. Distinguish advertised tools from tools loaded/discoverable at that point, and unknown
availability from confirmed availability. A similar MCP name alone does not establish equivalent
behavior: arguments, target, permissions and results matter. Present an evidence-linked suggestion
such as "this log-reading command may have an available MCP equivalent", not an automatic finding
that the agent bypassed a rule. Disabled, unavailable, unsuitable or unauthorized tools can justify
a direct command. External-agent activity outside observed channels remains a coverage gap.

Identify repeated pairs/sequences as candidates for a composite MCP operation, with representative
traces, frequency, failures and time spent. Repetition can reflect required verification, dependency
ordering or retries; reducing call count alone is not an improvement. A proposed combined tool must
preserve authorization, useful intermediate results and partial-failure semantics. Keep analysis
advisory: an administrator may revise instructions or request a new tool through normal development.
Do not execute captured commands during analysis or install generated tools automatically.

Store or reference the applicable agent/model, instructions and tool-schema revisions for comparisons.
Evaluate proposed changes on comparable tasks using correctness, checks passed, elapsed time and
retries as well as call count; a before/after chart is not proof that instructions caused a change.
Reuse the session event stream and existing telemetry/audit references instead of a conflicting
second execution log. Timing coverage, aggregation scope, retention and UI remain open design work.

## Deliverables

- [ ] Implement observed timeline spans, overlapping execution, filters and explicit timing/coverage gaps.
- [ ] Implement authorized session aggregation with instruction/tool catalogue and permission revisions.
- [ ] Implement evidence-linked MCP-equivalence and composite-tool suggestions with comparable-task evaluation.

## Open Questions

- Which timeline phases and monotonic timings are observable for each provider, and how much
  tool-discovery/permission/instruction history is available? Define aggregation/retention scope, command
  grouping, MCP-equivalence evidence and comparison criteria before building optimization UI.

## Verification

- Timeline analysis preserves concurrent call overlap, separates approval waits from observed
  execution, and leaves unexplained gaps unclassified. Reconnect/replay must not inflate statistics.
  Compare an available equivalent MCP tool with disabled, undiscovered, incompatible and unknown
  cases; surface qualified suggestions without declaring an unsupported bypass. Repeated command
  pairs produce inspectable candidates, not automatic tool creation, and missing external calls do
  not masquerade as zero usage. Instruction-version comparisons retain their evidence and scope.

---
status: Draft
created: 2026-09-26
updated: 2026-09-26
summary: Use agents as bounded exploratory app testers whose findings are reproduced and triaged independently.
components: [apps/harness]
---

# Synthetic Agent App Evaluations

Part of [shared assistant development sessions](../assistant-development-sessions/plan.md).
The umbrella's common invariants apply; this feature has independent scope and requires its own Ready approval.

## Goal And Dependencies

Use agents as bounded exploratory app testers and feedback producers, followed by independent
reproduction/triage and controlled comparisons. This is later work over
[sandbox runtimes](../app-sandbox-runtimes/plan.md), [feedback intake](../app-feedback-inbox/plan.md)
and the shared invocation stream. It does not gate deterministic browser testing or sandbox launch.

## Target Behavior

Later, let several agents explore independently with specified goals, roles and budgets. Use separate
seeded sandbox instances by default; share one deliberately only for multi-user/concurrency tests.
Attach observations to the existing feedback inbox with synthetic-agent attribution, app/page,
source revision, model/instructions, reproduction steps and evidence. Another agent may reproduce,
deduplicate and assess observations; administrator triage remains authoritative and no automatic
merge or instruction rewriting follows from an evaluator's opinion.

Variant comparison uses equivalent fixtures/tasks, recorded models/tools/settings, repeated runs
and balanced order without exposing previous judgments. Measure observable completion, errors,
steps, latency and cost separately from subjective critiques. Similar agents can have correlated
biases: report results as synthetic evaluations and hypotheses for human validation, not human
preference, conversion or a substitute for real-user A/B testing.

## Deliverables

- [ ] D1. Implement bounded exploratory jobs with synthetic roles, reproducible seeds and per-run
  resource/cost limits.
- [ ] D2. Submit evidence-linked synthetic observations to the feedback inbox with independent reproduction
  and administrator triage.
- [ ] D3. Implement controlled multi-agent/variant comparisons with model/instruction provenance and repeated
  measurements.

## Open Questions

- Which human-validated tasks, budgets and rubric provide a useful baseline?
- Which repeat count, model diversity and order balancing are appropriate before reporting comparisons?

## Verification

Run independent seeded scenarios and an explicitly shared multi-user case. Verify evidence provenance,
partial/failed runs, budget termination and retention. Compare variants with equivalent inputs and
report observable outcomes separately from model preferences; no automatic merge or instruction changes.

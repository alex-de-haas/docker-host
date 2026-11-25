---
created: 2026-11-03
updated: 2026-11-25
summary: Recovery of an admitted Harness turn through its original provider, including durable intent, physical closure and loss of contact.
components: [apps/harness]
---

# Interrupted Harness Session Recovery

Harness keeps the user's accepted input and its immutable command identity in the conversation database. When delivery is interrupted, the reconciliation worker queries the original provider. If that attempt exists, the saved snapshot supplies its outcome. A missing attempt can be admitted by replaying its exact saved bytes while the original authority remains valid. A revoked grant leaves the input available for its owner.

A Stop remains associated with the exact run through a disconnect. A confirmed physical stop retires pending approvals for that turn. Historical tool outcomes retain their own certainty. A finished run keeps its terminal result when a later Stop arrives. Losing contact preserves the last observed phase and records that the current observation is stale. The chat's transcript remains readable from Harness storage during a provider outage.

The [provider and Harness execution contract](../agent-execution-reliability/feature.md) covers durable delivery, cross-process ownership, scoped removal and platform limits. The [incident inventory](../../reviews/2026-11-25-provider-harness-reliability.md) records the earlier operator-attested recovery behavior and the production failures that motivated the change.

## Testing Expectations

- Stop at a pending approval, interrupt delivery before and after the request is committed, and verify that the provider applies one stop to the original attempt. A different user, session or installation cannot finish the old request.
- Restart Harness with all browser sessions closed. Recover acknowledged output exactly once. Verify that an interrupted stream retains the latest observed execution phase and saved transcript.
- Stop an already completed attempt and an attempt with an unresolved historical effect. Compare its physical state, native result, decision controls and the state shown in the conversation and navigation.
- Verify the isolated Windows storage case tracked in the [recovery plan](plan.md).

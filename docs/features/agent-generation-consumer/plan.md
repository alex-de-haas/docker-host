---
status: Draft
created: 2026-11-12
updated: 2026-11-12
summary: Select and deliver a real second application's model or agent generation feature over the independent provider API.
components: [apps, packages/app-sdk, packages/app-sdk-dotnet]
---

# Agent Generation Consumer

## Goal And Owner Direction

On 2026-11-12 the owner limits the first delivery to [independent agent-provider extraction](../agent-provider-interface/plan.md)
and explicitly tracks the older general generation/structured-result and second real application
integration here. This preserves the unfinished product scope without blocking provider extraction.
This Draft does not authorize implementing an unspecified application feature.

## Target Behavior

Choose a real application and a concrete bounded prompt-to-result journey. Evaluate the extracted
execution API against simple no-tools generation, optional tool use, model selection, validated JSON
results, streaming and cancellation. Extend only the missing compatible surface; do not invent a
second protocol or duplicate provider extraction, Core authority or native session ownership.

A test fixture, speech transcription or existing translation call is not the new product feature.
The consuming app never receives provider account secrets. Ordinary Core app/user permissions and
explicit capability refusal apply; no hidden model/provider/cloud fallback is allowed.

## Deliverables

- [ ] D1. Select the real application and user journey, define required input/output/JSON schema, budgets and success criteria, and obtain Ready approval.
- [ ] D2. Compare the extracted execution API with the chosen model/agent generation requirements and specify only missing compatible capabilities, including no-tools isolation and final structured-result validation.
- [ ] D3. Implement the selected consuming-app feature and any approved SDK/provider extensions without Harness dependencies or provider credentials in the consumer.
- [ ] D4. Verify prompt-to-result behavior across declared provider/model capabilities, invalid/unsupported results, cancellation, retries and permission denials; publish current behavior and remove this plan when complete.

## Open Questions

- Which application and user workflow should receive this feature?
- Which providers, models and output guarantees does that workflow require?

## Verification

Before implementation, record the chosen app and explicit acceptance examples. Run its affected
unit/build/integration checks and the relevant provider-contract tests. Documentation-only planning
uses docs-index/link validation. Follow each changed artifact's version policy when implementation ships.

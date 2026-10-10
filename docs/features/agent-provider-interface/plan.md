---
status: Draft
created: 2026-10-10
updated: 2026-10-10
summary: Explore a shared app-facing interface for independently provided agents and models, including multi-model providers and structured results.
components: [apps/core, apps/harness, packages/app-sdk, packages/app-sdk-dotnet]
---

# Agent And Model Provider Interface

## Owner Direction

On 2026-10-10 the owner retained and broadened AI Agent Bridge D10: agents are a future independently
provided capability that other apps can invoke with a defined prompt and consume as JSON or another
declared result. One provider can expose several models; an Ollama-backed provider exposing its
available local models is a concrete example to evaluate. See [vision decision 29](../../vision.md).

Prefer an established API shape where it fits. An Ollama-style or compatible model API is a candidate,
not a selected protocol. This Draft owns the interface investigation and agent-provider extraction;
it does not authorize implementation or preserve the old `/api/ai/generate` design as a requirement.

## Current Baseline And Intended Change

[Provider consumption](../provider-consumption/feature.md) already supplies confirmed speech-to-text
and assistant categories, discovery, app permissions and short-lived credentials. Assistant calls
create user-attributed handoffs; they do not provide a general prompt-to-JSON result API. Agent
connections still live inside Harness. `providers.agent` is a reserved design name, not an accepted
Core permission or an implemented execution contract.

Extend that foundation so an app can discover a suitable provider, select a supported model or
agent capability, submit its bounded request and receive a defined result without owning vendor
credentials. Harness can consume the same provider capability; model execution need not be coupled
to its conversation UI. Core remains registry, identity and permission authority, not the model loop.
Specialized speech, image-generation and other provider contracts can coexist with this interface.
The working speech provider is precedent for discovery and authority, not completion of this work.

For contract design, distinguish three concepts without prescribing their final product names:

- **Provider:** the installed capability and its transport. It may expose one or several models or
  configured agents, including local and hosted backends.
- **Model invocation:** input and requested output; a tool-call proposal is not itself tool execution.
- **Agent invocation:** a provider-owned loop that may call authorized tools before producing a result.
  Its tool authority, run budget, state, cancellation and side effects must be explicit.

A common interface may cover both invocation forms, but compatibility cannot silently give a simple
generation request an operator agent's permissions. Moving agents out of Harness must preserve the
current ownership of conversations and confirmations or explicitly specify its replacement.

## Questions The Contract Must Resolve

- Compare established API candidates using model enumeration/selection, capabilities, text and
  schema-constrained JSON results, streaming, errors, cancellation and compatibility/versioning.
  Decide which can be standard and which require a small Hosty-specific envelope. Do not claim that
  an API-compatible endpoint supports every capability.
- Define explicit provider/model selection versus capability-based routing, changed/removed models,
  unavailable capabilities and local-only requirements. No silent cloud or different-model fallback.
- Separate app-only inference from user-attributed agent actions. Reuse reviewed provider grants;
  decide when an acting user's current authority is required and how each delegated tool call is
  narrowed. A provider's own installation permissions cannot elevate the requesting app or user.
- Decide whether calls are stateless, resumable or asynchronous, how results/artifacts are retrieved,
  and how retries avoid duplicate side effects. General scheduled work remains Bridge D11's scope.
- Bound input/output, time, tool iterations and cost; make retention, external data transfer and
  structured-result validation explicit. Provider credentials remain outside app/model-visible data.
- Determine extraction/migration boundaries for existing Harness connections and sessions. AHP's
  client conversation interface and assistant handoffs have different consumers and are not assumed
  to supply this invocation contract.

## Deliverables

- [ ] D1. Select a real consuming-app scenario and compare established API candidates against the owner direction; record the model/agent distinction, selected compatibility scope and unresolved decisions.
- [ ] D2. Specify discovery, model/capability selection, invocation/results, structured-output validation, streaming/cancellation, retry semantics and versioning, including unsupported-capability behavior.
- [ ] D3. Specify provider extraction and caller/user authority, credential handling, tool execution policy, resource/data limits and the migration of existing Harness consumers.
- [ ] D4. After explicit Ready approval, implement the chosen Core/SDK contract and an independently installable provider, including multiple-model discovery and selection.
- [ ] D5. Integrate one real app's prompt-to-result feature and prove the same consumer contract against a second provider implementation or conformance fixture; exercise permissions, failures and structured results.
- [ ] D6. Record verified behavior and compatibility limits in feature.md, reconcile Harness/provider docs, delete this plan and regenerate the index.

## Dependencies And Boundaries

- [Core extension boundaries](../core-extension-model/feature.md) describe the existing role and grant
  mechanisms. This plan alone owns the proposed `providers.agent` API; existing provider permissions
  remain the implementation baseline.
- [Isolated user sessions](../user-agent-sessions/plan.md) own direct non-admin conversations and their
  isolation gate. An app's bounded inference feature does not by itself require or enable that chat.
- Agent execution with tools consumes [session containment](../assistant-runtime-containment/plan.md)
  and the applicable [approval policy](../assistant-approval-rules/plan.md). No administrator credential
  or native-tool fallback can stand in for a missing user-safe execution mode.
- [Durable jobs](../ai-agent-bridge/plan.md#step-11--durable-jobs-and-notifications) own scheduled runs;
  this interface defines the invocation they consume, not another scheduler.

## Verification

Before approval, retain a candidate comparison and example request/result exchanges for one consumer,
a provider with multiple models and both no-tools and explicitly authorized tool execution. Before
shipping, exercise real Core-managed discovery and grants, model selection/removal, invalid JSON,
unsupported capabilities, local-only refusal, cancellation, retries, revocation and cross-user
denials. Show that the consumer never receives provider secrets and that a generation call cannot
silently start privileged work. A speech transcription or assistant handoff alone does not close D5.

---
status: Draft
created: 2026-10-10
updated: 2026-10-29
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

## Harness Worker Service Precursor

Owner direction, 2026-10-20: the
[Harness worker-service implementation](../assistant-shared-docker-runtime/feature.md) replaces Core's
special agent execution proxy with an ordinary Harness service and a direct application API.
Its remaining acceptance plan owns Windows verification and live provider coverage. The implementation owns its concrete HTTP/SSE run/event/cancellation contract and clean Harness
update and an independently hosted endpoint fixture. Core-owned workspaces require no migration. It does not implement `providers.agent`, choose a
public model API or ship an independently installable provider. The owner selected simple HTTP JSON
and SSE for that refactor on 2026-10-20; ACP/A2A/OpenAI-compatible protocol adoption is deferred to
this investigation, while AHP remains in its external-client plan. Worker model/effort selectors
are connection-scoped execution options, not a new Core provider discovery or routing mechanism.

D1-D3 here must consume that concrete contract and its evidence when comparing standards and
designing extraction. Keep provider invocation independent of Harness's private database,
container names and host paths. Specify discovery, cross-app caller/user authority and resource
binding/transfer for a separately deployed provider; sibling networking alone supplies none of
those guarantees. A compatible model-generation API must be evaluated against stateful agent
runs, approvals, tool events, cancellation, resume and artifacts. The worker-service work does
not complete any deliverable in this plan or change its Draft status.

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

## Workspace Permission Propagation (Owner Decision, 2026-10-29)

Consume [Workspace Permissions And Deletion](../external-workspace-access-continuity/feature.md)
in D2-D3. An application allowed to use workspace operations can use the full collection when the
initiating user also has those rights. Preserve that user through provider/agent handoffs; a provider
cannot substitute its service administrator or elevate the initiator. Workspace IDs select work
context, not a resource allowlist. No additional per-agent or per-workspace consent is required.
Keep credentials and private transcripts separate. Changing a provider/session/grant does not
change workspace ownership or collection authority. Support collection operations with no primary
workspace. Public provider invocation remains owned here; the permission contract lives in that plan.

## Independent Agent Applications: Design Assessment (2026-10-28)

The owner wants to develop Harness from its own conversations without a Harness restart or source
workspace switch terminating the executing agent. The owner explicitly rejects routing agent
messages through Core: Core supplies discovery, authority and connection references; consumers
communicate directly with the selected provider.

The code inspected for this assessment is repository main at
`ed268a4c8685c95255b27bde0948a3e7d69bfa64` (Harness 0.74.9). The worker already has durable run
acceptance, event replay and separate observer detachment, but remains a service in Harness's app
manifest. Moving that service into another directory alone does not establish an independent lifetime.

### Proposed Responsibility Split

- Core: generic installed-provider discovery, scoped caller/user grants and authorized resource
  references. An authorized execution-session inventory or discovery links are candidates, not an
  approved Core chat database. Reuse provider consumption rather than creating a first-party exception.
- Agent provider app: native agent processes, provider credentials, tool execution, run/session state,
  retained events, pending decisions and confirmed process termination.
- Harness: conversations, composition, user interaction and a consumer-side mapping to provider
  session/run references. After restart, reconcile current provider state and replay from a cursor.
- Other apps: invoke the same provider contract without requiring Harness to be installed.

Keep a Harness conversation, a provider-native session, one execution run/attempt and an application
task as distinct identities. Associate execution references with the originating installation, caller,
user and workspace authority; a label or URL alone grants no access. Native session continuation is
provider/account-bound. Cross-provider context transfer is not an initial requirement.

Owner decision, 2026-10-28: the target is three independently installed provider applications:
Codex, Ollama and Claude Code. The earlier suggestion of a combined Codex/Claude provider is
superseded. Each app owns its engine/session lifecycle and provider-specific configuration. Shared
libraries may implement protocol validation and common mechanisms; they must not introduce a shared
execution service that couples provider lifetimes. An Ollama app can expose several models without
installing one application per model. Core treats provider application IDs as opaque and discovers
their declared interfaces; it must not branch on these vendor names.
See [vision decision 65](../../vision.md).

The Ollama engine is Hosty-owned and calls Ollama directly. Its initial Harness integration belongs
to [Ollama Agent Adapter And Connections](../ai-gateway-providers/feature.md); it is designed for extraction
but does not implement independent application hosting or the public provider contract. The owner
clarifies that the initial adapter calls the existing host Ollama server by a configurable URL;
it does not install/start that server, download models or allocate model storage in Worker.
An independent provider app can remain a client of an external inference endpoint. Whether a later
distribution also offers a managed inference server is a separate packaging decision, not a
requirement for agent-provider extraction. The initial adapter does not mandate a new dedicated
engine daemon or a change from Docker to native execution.
This plan's D3-D4 own extraction/migration of all three apps, and D5 owns actual cross-provider acceptance. Provider updates can initially wait for active work to
finish. Rolling process generations are not needed to demonstrate independence from Harness.
A provider crash still interrupts native execution; retained state does not promise live recovery.

### Protocol Assessment

| Candidate | Useful fit | Limit for this proposal |
| --- | --- | --- |
| Existing Worker HTTP JSON/SSE, versioned for public use | Closest to current run acceptance, cancellation and replay; small adaptation surface | Must define public authority, discovery, resource binding, compatibility and independent ownership |
| Agent Host Protocol (AHP) | Rich agent-client state, session projection, sequence-based reconnect and snapshots | Does not supply Hosty grants, workspace ownership or process supervision; keep the external-client work separate |
| Agent Client Protocol (ACP) | Adapter boundary for coding agents, including tools, permissions and session interaction | Stable v1 is primarily stdio; network transport and v2 maturity must be checked when adopting |
| Agent2Agent (A2A) | Cross-system task submission, artifacts and asynchronous status | Task interoperability alone does not establish the stronger event replay and duplicate-effect guarantees needed here |
| Ollama / OpenAI-compatible inference API | Model discovery and model/tool-call generation | Does not execute the agent loop or own approvals, workspaces and native sessions |

Working recommendation: extend the existing HTTP JSON/SSE contract into a narrow, versioned Hosty
provider interface, retaining native adapters underneath. This is a proposal, not a protocol approval.
D1-D3 still require example exchanges and a concrete second consumer/provider compatibility check.
AHP remains a candidate client interface; ACP can be added as an agent adapter; A2A can serve remote
delegation without forcing all three boundaries to use the same protocol.

### Provider Candidates And Scope

Codex app-server and Claude Agent SDK are the immediate compatibility targets because Harness already
uses them. Gemini CLI's ACP mode, OpenCode's server/ACP interfaces and Copilot SDK are subsequent
candidates, each requiring an explicit capability mapping. Local Ollama models use the selected
Hosty-owned engine; Codex is not an Ollama runtime dependency. Remote
managed agents and A2A endpoints are another category; they must not imply access to local files.

Expose supported operations rather than promising identical behavior across providers: model
enumeration, tools, permissions/questions, cancellation, same-provider resume, structured results,
image input and reasoning controls can differ. Unavailable capabilities need explicit errors.

### Extraction Work And Priority

The difficult work is ownership and recovery, not the transport. The worker currently depends on
Harness for credential access and coordinated execution; sessions also own MCP mediation, permission
responses and workspace activity. D3 must remove mandatory callbacks to a restarting Harness or define
how execution safely parks until the consumer returns. Reconnect needs ordered replay or a snapshot,
stable request IDs, retained pending decisions, cancellation receipts and explicit terminal outcomes.
Do not re-execute historical tool calls or uncertain mutations during recovery.

A workspace controls source ownership, not the lifetime of child processes. The extraction must retain
process containment and cleanup responsibilities; it does not resolve orphaned application processes
by itself. Coordinate with [runtime containment](../assistant-runtime-containment/plan.md).
Core inventory must also reconcile the existing boundary in
[development sessions](../assistant-development-sessions/plan.md): private assistant conversations
remain owned by their application.

This is a medium-to-large cross-component change, not a prerequisite for the shipped
[basic task workflow](../basic-tasks/feature.md). The recommended near-term scope is reliable
workspace/sandbox development plus the independently designed Ollama engine in
[provider connections](../ai-gateway-providers/feature.md). Schedule extraction before advanced
multi-agent orchestration, or bring it forward if developing Harness from uninterrupted in-app agents
takes priority over the delivery-readiness milestone. No delivery date or implementation approval is
inferred from this discussion.

### Primary References

Reviewed on 2026-10-28; verify moving specifications again before implementation.

- [AHP specification](https://microsoft.github.io/agent-host-protocol/) and
  [reconnect lifecycle](https://microsoft.github.io/agent-host-protocol/specification/lifecycle).
- [ACP v1 overview](https://agentclientprotocol.com/protocol/v1/overview) and
  [transports](https://agentclientprotocol.com/protocol/v1/transports).
- [A2A specification](https://a2a-protocol.org/latest/specification/).
- [Codex as a platform](https://developers.openai.com/blog/codex-as-a-platform) and
  [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview).
- [Gemini CLI ACP](https://geminicli.com/docs/cli/acp-mode/),
  [OpenCode SDK](https://docs.opencode.ai/docs/sdk/) and
  [Copilot session persistence](https://docs.github.com/en/copilot/how-tos/copilot-sdk/features/session-persistence).
- [Ollama tool calling](https://docs.ollama.com/capabilities/tool-calling) and
  [Codex integration](https://docs.ollama.com/integrations/codex).

This assessment and the subsequent owner engine/packaging decision do not complete D1-D6 or change Draft status. The public protocol, extraction authority/migration and acceptance details still require approval.

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
  and how retries avoid duplicate side effects. General scheduled work belongs to [Durable Agent Jobs](../durable-agent-jobs/plan.md).
- Bound input/output, time, tool iterations and cost; make retention, external data transfer and
  structured-result validation explicit. Provider credentials remain outside app/model-visible data.
- Determine extraction/migration boundaries for existing Harness connections and sessions. AHP's
  client conversation interface and assistant handoffs have different consumers and are not assumed
  to supply this invocation contract.

## Deliverables

- [ ] D1. Select a real consuming-app scenario and compare established API candidates against the owner direction; record the model/agent distinction, selected compatibility scope and unresolved decisions.
- [ ] D2. Specify discovery, model/capability selection, invocation/results, structured-output validation, streaming/cancellation, retry semantics and versioning, including correlated turn/tool outcomes, provider/account-bound resume or reconstruction and explicit unsupported-capability behavior.
- [ ] D3. Specify separate Codex, Ollama and Claude Code provider applications, caller/user authority, credential handling, tool/resource policy, session inventories and migration of existing Harness consumers without required Harness callbacks during execution.
- [ ] D4. After explicit Ready approval, implement the chosen Core/SDK contract and separately installable Codex, Ollama and Claude Code providers, with independent lifecycle/state and declared model/capability selection.
- [ ] D5. Integrate Harness and one real app's prompt-to-result feature; prove the same consumer contract across the three providers' declared capabilities, including Harness restart/reconnect, pending decisions, replay, permissions, failures and structured results.
- [ ] D6. Record verified behavior and compatibility limits in feature.md, reconcile Harness/provider docs, delete this plan and regenerate the index.

## Composable Work Coordination (2026-10-26)

This plan remains the sole owner of the public model/agent invocation contract. Under
[vision decision 62](../../vision.md), task execution belongs to an app with optional opaque executor
choices; Harness profiles remain internal configuration, separate from provider connections and runs.
There is no shared agent-principal prerequisite or portable Harness-profile contract. D2-D3 must
define bounded context/skill references, provider-qualified task/resource correlation and declared
resume/reconstruction capabilities without assuming shared host paths or private Harness storage.
[Artifacts](../shared-artifacts/plan.md) owns retained result references and
[Decisions](../shared-decisions/plan.md) owns addressed questions; neither reference grants access.

[Durable Agent Jobs](../durable-agent-jobs/plan.md) consumes invocation/results and owns repeated
execution and parked continuation. [Basic Tasks](../basic-tasks/feature.md)
owns the first manual/API task journey; Harness Work Orchestration retains the richer composition. Its business acceptance does not duplicate D5's provider
compatibility/independence acceptance. Task-provider storage, executor enumeration and task dispatch
belong to [Basic Tasks](../basic-tasks/feature.md). Its first Harness executor can use the existing
internal runtime without waiting for this provider extraction. Existing D1-D6 remain unchecked and Draft.

## Recovery Contract Coordination (2026-10-27)

With in-session provider switching retired, D2 retains the public invocation/recovery contract.
Expose native capability limits and stable invocation/attempt/tool correlation without treating
one provider's session ID or hidden state as portable. Historical input evidence is not a tool
request to replay. [Action Summary D4](../assistant-action-summary/plan.md#deliverables) owns the
existing Harness journal's correlated event foundation; [Durable Agent Jobs D7](../durable-agent-jobs/plan.md#deliverables)
owns common session commands, same-provider continuation and bounded context. Reuse these as the
Harness adapter's implementation, without requiring independent providers to share its storage.

## Optional Usage Reporting Coordination (2026-10-28)

[Harness Provider Usage Limits](../harness-provider-usage-limits/feature.md) owns optional account quota,
credit balance and API rate-limit observations in the existing Harness connections and UI. It
covers the existing local Ollama adapter's not-applicable quota and Ollama Cloud conformance fixtures, not this public
provider API. D2 here must preserve an optional usage-reporting capability, distinct from invocation
cost, context capacity and connection readiness. A provider without it remains usable.

D4 here includes binding that optional capability when the independently installed provider exposes
it, preserving local not-applicable quota and adding cloud balance observations when cloud support is introduced.
Reuse the observation semantics and verified provider contracts; this coordination neither selects
an invocation standard nor makes billing access mandatory. Existing D1-D6 remain unchecked and Draft.

## Assistant Events Above Engine Invocation (2026-10-29)

[Assistant Events And Session Continuation](../assistant-events-and-continuation/plan.md) owns
application-activity bindings and authorized inbound facts that can continue a selected assistant
conversation. It consumes the native invocation/recovery capability here and common Harness session
commands from Durable Agent Jobs D7; it does not extract engines or implement this plan's D1-D6.
The first internal Harness adapter can precede independently installed providers.

Keep the boundaries explicit: an assistant presentation capability does not establish native resume,
trusted turn-purpose propagation or event-triggered execution support. Negotiate those capabilities
and return unsupported outcomes. Preserve direct consumer/provider agent messaging; Core's durable
domain envelopes carry bounded facts and protected result references, not a centralized private-chat
relay. Native subagent results must have one continuation owner and must not be injected twice.

## Dependencies And Boundaries

- [Core extension boundaries](../core-extension-model/feature.md) describe the existing role and grant
  mechanisms. This plan alone owns the proposed `providers.agent` API; existing provider permissions
  remain the implementation baseline.
- [Isolated user sessions](../user-agent-sessions/plan.md) own direct non-admin conversations and their
  isolation gate. An app's bounded inference feature does not by itself require or enable that chat.
- Agent execution with tools consumes [session containment](../assistant-runtime-containment/plan.md)
  and the applicable [approval policy](../assistant-approval-rules/plan.md). No administrator credential
  or native-tool fallback can stand in for a missing user-safe execution mode.
- [Durable jobs](../durable-agent-jobs/plan.md) own scheduled runs;
  this interface defines the invocation they consume, not another scheduler.

## Verification

Before approval, retain a candidate comparison and example request/result exchanges for one consumer,
a provider with multiple models and both no-tools and explicitly authorized tool execution. Before
shipping, exercise real Core-managed discovery and grants, model selection/removal, invalid JSON,
unsupported capabilities, local-only refusal, cancellation, retries, revocation and cross-user
denials. Show that the consumer never receives provider secrets and that a generation call cannot
silently start privileged work. A speech transcription or assistant handoff alone does not close D5.

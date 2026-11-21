---
status: Draft
created: 2026-11-18
updated: 2026-11-18
summary: Let a user send additional input to a running agent through a discovered provider capability, with an explicit choice to queue a later turn.
components: [apps/core, apps/harness, apps/codex-provider, apps/claude-code-provider, apps/ollama-provider, packages/agent-provider-runtime, packages/app-sdk, packages/app-sdk-dotnet]
---

# Input During An Active Agent Run

An agent is checking a failure and posts an observation. The user replies “look at the import step.”
When the selected execution accepts follow-ups, Harness forwards that message to the active run
immediately. The agent can use it as soon as its runtime incorporates it. The user can also
deliberately leave a message for the next turn. This applies to ordinary Harness chat and the
personal assistant. A consumer with its own UI can use the same public provider contract.

## Current Behavior And Evidence

At repository base `7a428feedf5d`, the public `agent` interface supports starting or resuming a run,
cancelling it and answering an identified Decision. A public session owns at most one active run.
The ordinary Harness composer enqueues sends while busy. Queue rows have persistent identities,
ordered delivery and editable waiting content. Task attempts reject ordinary queued messages.
[Agent Provider Interface](../agent-provider-interface/feature.md) · [Harness Message Queue](../harness-message-queue/feature.md)

Codex App Server documents `turn/steer` for adding user input to a live turn. The client supplies
the thread, expected active turn and input. Success identifies the turn. A stale target or missing
active turn can be rejected. `turn/interrupt` requests cancellation. This protocol describes how
the agent runtime accepts input. It gives no deadline for a reply or for a tool already underway
to yield. [Codex App Server, Steer an active turn](https://developers.openai.com/codex/app-server/#steer-an-active-turn)

Hosty's Codex provider pins CLI 0.167.0 at this base. Its adapter currently uses turn start and
interrupt, and waits for completion before sending another turn. The Claude adapter has a streamed
input transport with turn-scoped bookkeeping. The Ollama adapter serializes calls through its
turn loop. Treat their effective capabilities as unverified until each supported path has evidence
with its actual adapter, runtime version, configuration and execution phase. A model name alone
cannot establish this behavior.

## Contract And Composer

- Extend existing capability discovery and the typed SDKs with optional support for user input
  on a running session/run. Indicate accepted input types and applicable configuration or model
  restrictions. The provider validates current eligibility on each send. An absent capability
  retains existing behavior. Text is the proposed first supported form.
- Bind each submission to the authenticated user, consumer, provider installation, session and
  expected active run. Use the existing command identity and receipt machinery. The provider
  maps that run to its exact native turn and serializes concurrent submissions in admitted order.
  Replaying the same identity and payload recovers its disposition. Changed content conflicts.
- The proposed composer default is **Auto**. An idle session starts or resumes an ordinary turn.
  During a running turn Auto sends eligible input immediately to that turn. **Queue for next turn**
  uses the ordinary ordered queue even on a capable provider. Show the chosen behavior before
  submission, with a per-message override. Remembering a user's preferred mode is a design
  choice. Stop remains a separate action.
- With a known unsupported provider, Auto labels the send as queued wherever queuing is available.
  Keep the current queue's edit, reorder and pause behavior. A user can deliberately steer past a
  waiting row when the destination is clear. If preserving the user's intended order requires an
  earlier row or upload to settle, show that dependency. Keep the submitted text or attachment
  intact if the selected operation cannot accept it. Frozen or uncertain submissions are locked.
- Treat a run that ended between display and send as a distinct rejected destination. Keep the
  message and offer an ordinary next-turn send after confirmed non-admission. If acknowledgment
  is lost after native handoff, reconcile the original identity. Where the native service cannot
  prove the outcome, show it as unknown and prevent automatic resend, requeue or retargeting.
- Record Harness receipt, provider/native acceptance, and later incorporation when observable.
  Use a shared input identity to correlate the timeline with replayed native events and any
  replies. Several inputs may contribute to one assistant answer. Show only the stage supported
  by evidence. Preserve the original run and its in-flight tools, budgets and policies.
- Use the existing Core operation-authorization path and the provider's current actor/run checks.
  Ordinary text cannot resolve a pending approval or stand in for a Decision response. Exclude
  task-attempt editing from initial scope to preserve immutable task briefs. An event or worker
  result can wake its own consumer through the existing event contract.

## Ownership And Decisions Before Ready

This Draft owns the optional operation, authorization and SDK exposure, native adapters and the
ordinary Harness composer action. Durable Agent Jobs D7 owns shared command correlation, context
and recovery. The queue remains the owner of next-turn delivery. Personal Assistant owns topic
routing and any choice to use another execution for an independent request. Reuse their existing
records and locks. The design needs one additional way to deliver user input.

Before Ready, settle the wire shape and capability/version negotiation, the smallest observable
receipt for the pinned Codex adapter, eligible busy states, multi-client ordering, and Auto's
behavior for attachments, paused queues and pending Decisions. Select the first adapter with a
verified active-turn path. Record unsupported configurations explicitly.

## Deliverables

- [ ] D1. Specify optional capability discovery, allowed inputs/states, exact target and actor checks, command replay and evidence of native acceptance. Select the initial provider and send-policy defaults before Ready.
- [ ] D2. Extend the public agent contract, Core authorization mapping, SDKs and selected provider adapter. Expose accurate capabilities on older, unsupported and unrelated providers.
- [ ] D3. Connect the existing Harness command and composer paths to Auto and Queue for next turn. Preserve local drafts, attachments, ordering, explicit Stop, Decision routing and recovery after uncertain delivery.
- [ ] D4. Verify active-turn delivery, unsupported fallback, native evidence, replay and UI behavior. Document shipped support and limits in feature.md and update the index after acceptance.

## Verification

Hold a run active in a controllable adapter fixture and send two corrections during a slow tool
call. Observe ordered input at the same native turn before it ends, no new run start or stop,
and correct transcript entries even if only one combined reply arrives. Repeat against the
selected pinned runtime before advertising native support. Measure submission-to-acceptance and
time to an answer separately. A fast HTTP acknowledgment alone cannot demonstrate incorporation.

Exercise forced queue, missing/unsupported input types, stale turn IDs, a terminal-turn race,
two clients, a dropped acknowledgment after native submission and process restart. Verify a
known rejection preserves the input, unknown native admission cannot trigger a second send, and a late message
cannot reach a new turn, another user's run or a pending approval. Confirm fallback against an
unrelated provider that omits the capability. Validate this Draft with the repository doc checks.

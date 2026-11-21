---
status: Draft
created: 2026-11-16
updated: 2026-11-21
summary: Generic provider admission for responsive short interactions, explicit capacity classes and capability-checked execution limits.
components: [apps/harness, apps/codex-provider, apps/claude-code-provider, apps/ollama-provider, packages/agent-provider-runtime, packages/app-sdk, packages/app-sdk-dotnet]
---

# Agent Invocation Admission And Limits

## Goal And Baseline

Keep authorized short interactions responsive while independent task executions use the same agent
provider, and make requested run restrictions match actual provider enforcement. This is a shared
provider capability requested for planning with [Personal Assistant](../personal-assistant/plan.md)
on 2026-11-16, not an assistant-specific scheduler or implementation approval.

The [public agent interface](../agent-provider-interface/feature.md) already owns exact-byte run
admission, provider sessions, cancellation, receipts and native execution. At baseline
`7a428feedf5da2a42d367cc09cb2bdf86a39d211`, the shared runtime defaults to four occupied sessions;
unknown-stop runs and reserved continuations also consume capacity. A new session or another
connection within that provider does not establish an independent capacity pool.

Codex does not currently support `nativeTools.none`; native subagent restrictions also have different
enforceable/observed coverage across providers. Current adapters reject requested hard output-token
and tool-call limits, while duration is supported. Harness does not yet expose/pass all supported
native-tool/subagent choices in its normal configuration construction. Do not promise strict
coordination-only execution or hard budgets from role prompts and an advertised schema alone.

## Owner Question On Capacity (2026-11-17)

The owner asked why a provider admits only four occupied sessions and whether Hosty needs this cap.
Observed at the baseline: the shared runtime reads `AGENT_MAX_CONCURRENCY` with a default of four,
introduced by the 2026-11-16 provider extraction, and the provider manifests do not expose it. The
former Harness worker allowed 32 native runs or one Docker run. Harness task scheduling no longer
checks provider capacity, and the provider contract rejects a run at capacity without an implicit
queue or retry. No document records why four was chosen.

A cap can protect host memory/CPU and account rate limits, but its value and configurability were
not an owner decision. Before Ready, decide whether a provider-wide cap is needed, its default, how
the owner changes it and what a consumer does when it is reached. Evaluate the simplest candidate
first. Measure the existing ceiling and a configurable ceiling under the same workload. Consider
reserving capacity if contention causes unacceptable delays for direct user messages.

## Ownership

This plan owns negotiated provider admission/capacity classes, configuration plumbing and truthful
limit enforcement, plus safe retirement of short-run native state. Extend existing runtime/SDK contracts; do not create another provider launcher,
native process supervisor, queue database or Core inference loop. It is a separate Draft extension
to avoid silently adding unapproved work to the in-progress provider extraction plan.

[Durable Agent Jobs D7](../durable-agent-jobs/plan.md#deliverables) owns common Harness input receipts,
execution-segment mapping and bounded context assembly. Its general runner owns schedules/retries.
Task delegation owns root fan-out and retry limits. [Runtime Containment](../assistant-runtime-containment/plan.md)
owns stronger filesystem/network/process isolation; tool selection here is not OS isolation.
Personal Assistant supplies a consumer and latency acceptance case, not a privileged Core identity.

## Proposed Admission Policy

Negotiate supported workload/admission classes and who may request them. A provider-owned policy
can reserve bounded interactive capacity while admitting background work fairly. Class names and
counts are design proposals, not fixed wire fields. Selection must follow authenticated consumer
policy; an agent cannot gain priority by writing "urgent" or calling itself an assistant.

Use measured time to the first useful reply and background throughput to decide whether extra
admission rules are justified. If the simple ceiling fails under contention, compare a protected
allowance, weighted admission and genuinely separate provider capacity. For the selected policy,
explain how idle capacity is used and how an operator can inspect occupancy. Classify a direct user
message separately from an automatic summary using the authenticated input source. Keep unknown
stops and existing continuation reservations accounted for when evaluating any option.

Return explicit admitted, queued, saturated, unsupported and authority-unavailable outcomes with
recoverable request identity. A queued command retains its input/configuration and can be withdrawn
before execution; uncertain starts reconcile through existing receipts. Provider restart retains
the original admission outcome and ownership. Unknown stop still consumes its protective capacity.
Never force-stop a run, discard a reservation or bypass grants merely to satisfy a latency target.

Each provider session admits one active run. A foreground conversation may continue its compatible
session across turns and use the optional active-input capability for follow-ups to its current
run. Count additional executions against capacity only when a consumer actually starts them.
Keep isolated helpers separate from other tasks' native histories. [Active Run Input](../active-run-input/plan.md)

## Limits And Configuration

Represent enforceable, observed-only and unavailable controls separately. Validate requested
native-tool, subagent and limit settings before provider admission; unsupported strict settings
fail visibly. Extend common Harness configuration plumbing for already supported settings before
inventing new adapter behavior. An admitted MCP/workflow subset complements native restrictions: an agent with native tools
disabled can still perform implementation or lifecycle effects through broad MCP access. Preserve
the exact selection in admission and recovery and enforce it at dispatch. No per-profile principal
or independent profile permission system
is introduced; effective application/user/MCP policy remains authoritative.

Input size can be bounded by the common context assembler. Duration uses verified cancellation and
stop evidence; signal dispatch alone is not proof of stopped tools. Output/tool-call restrictions
may be enforced only where the actual execution path supports them. If partial output crosses a
limit, define terminal/unknown state and preserve any already-executed effects. Monetary usage
estimates remain observations unless exact enforcement can be demonstrated; current task monetary
cap limitations are not removed by this proposal.

Bound aggregate queued work and model/tool attempts, including summaries, retries and background
memory work. Persist only necessary operational metadata, not extra prompt/credential copies.
Expose requested versus effective settings and source of enforcement in diagnostics.

## Provider-Owned Retirement

Since the original assessment, [provider run retirement](../agent-provider-interface/feature.md)
supports an owner-confirmed chat deletion after verified native exit. It fences the native
session and retains its journal, unresolved effects and authorized history replay. Reuse the
existing receipt and fencing behavior where applicable. Automatic retirement and storage limits
for short assistant runs still require a retention policy. One fresh session
per short interaction therefore needs an explicit common lifecycle extension, not consumer-side
deletion of provider-private files.

Define capability-negotiated retire/inspect operations with retained request IDs and stop evidence.
Retire only confirmed-stopped sessions with no unresolved effects, Decisions, checkpoint consumers
or active attachments; unsupported or blocked cases remain visible. Provider policy bounds native
history, attachment and journal storage while retaining content-free replay fences for the declared
command-identity lifetime. An expired identity must be rejected rather than accepted as fresh work.
Specify which receipts survive retirement and how consumers resolve their original disposition.

Retirement removes provider execution state under its owner's contract, not Harness timeline,
memory, source workspaces or task outcomes. Confirm necessary result/attachment handoff before
removing the only copy. Recovery resumes a partially accepted retirement operation; it never
restarts native execution. Providers may retain a supported warm helper independently of user
content, without silently resuming a prior context. Define quotas and unsupported-provider fallback
before claiming bounded long-term operation.

## Deliverables

- [ ] D1. Compare the actual provider capability/capacity matrix, choose admission/fairness and first compatible short-invocation policy, define schemas and limitations, and obtain explicit Ready approval.
- [ ] D2. Extend common provider/SDK admission capabilities, receipts and configuration validation for the selected classes/limits, including safe-retirement receipts/capabilities, preserving old clients and unrelated provider implementations.
- [ ] D3. Implement the selected capacity and recoverable admission policy in the existing provider runtime, preserving parked/unknown execution accounting and cancellation semantics; add provider-owned safe retirement and bounded native/attachment/receipt retention without deleting consumer history.
- [ ] D4. Connect shared Harness invocation configuration to supported native-tool/subagent/limit settings, admitted MCP/workflow subsets and admission choices; preserve ordinary chat/task defaults and explicit unsupported outcomes.
- [ ] D5. Verify saturation, restart, fairness, authority, admitted tool subsets, real limit enforcement, context separation and retirement/storage growth with provider fixtures and approved real-provider cases; report interactive latency and background throughput together.
- [ ] D6. Document actual behavior/limits in feature.md, reconcile provider/context/assistant consumers, remove this plan only after verification and regenerate the index with implementation versions.

## Decisions Before Ready

Answer the [owner's capacity question](#owner-question-on-capacity-2026-11-17) first. Then choose the
initial compatible providers and the capacity policy. Set reservation and borrowing rules only
if the comparison supports a reservation. Decide which
strict limits are required for the first consumer and which remain explicitly unsupported; do not
make all-provider parity a hidden requirement. Select the contract's compatibility strategy and
whether queued admission stays consumer-owned or provider-owned with a common receipt; exactly one
layer owns dispatch of a queued invocation. Set retirement eligibility, native-storage quotas, replay-fence lifetime and attachment handoff rules. Set deadlines, queue bounds and starvation thresholds
from measured acceptance, not unverified instantaneous-response promises.

## Verification

This Draft requires documentation/index/link and whitespace checks only. Later compare ordinary
serial chat with independent short calls under an occupied provider, including all capacity used
by workers, parked reservations and an unknown-stop run. Measure acceptance and first useful answer
separately, p50/p95 latency, background throughput, queue depth, cancellations and full cost.

Test forged priority, unsupported settings, reconnect/lost admission, restart with pending work,
queued withdrawal, automatic-summary bursts, starvation, multiple consumers/accounts, clean new contexts, repeated short-run retirement and late output
after duration expiry. Verify settings at actual native boundaries; a model obeying a prompt is
not enforcement evidence. Keep Core usable with an empty registry and unrelated provider IDs.
Use normal identity and managed sandbox acceptance when implementation is approved; this Draft
does not authorize provider configuration changes or paid/live trials.

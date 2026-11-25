---
created: 2026-11-25
updated: 2026-11-25
summary: Provider-owned attempts, durable chat delivery and server-owned removal in the agent v2 execution protocol.
components: [apps/core, apps/harness, packages/agent-provider-runtime, packages/app-sdk, packages/app-sdk-dotnet]
---

# Agent execution reliability

A provider owns an attempt until it produces a physical closure receipt. Harness owns the conversation and its transcript. Core binds the caller, actor, provider installation and exact command bytes. The [incident review](../../reviews/2026-11-25-provider-harness-reliability.md) traces the earlier contradictory stop messages, lost acknowledgements, stalled history and inconsistent workspace counts to the individual operations that produced them.

## Commands and admission

An attempt uses an immutable run UUID. Repeating Start with the same identity and input returns the saved outcome. A changed body conflicts even after a newer run starts. The provider commits admission, control receipts, execution transitions and outgoing public history in its execution database. A detached supervisor claims its attempt under an OS-released lock and contacts the adapter. Its identity, input and stop intent survive an HTTP service restart. An unconfirmed native dispatch is subject to the adapter's reconciliation rules. An arbitrary external command with a lost acknowledgement cannot safely be issued a second time.

Stop addresses the run and carries a stable request UUID. A newer snapshot revision cannot invalidate the user's decision. A Stop that wins the admission race suppresses a later Start for the same owner and run. Physical closure, native result and the outcome of an earlier tool are separate fields. An unanswered permission prompt becomes obsolete when the turn closes. A previously completed turn retains its result.

Harness persists the original Core authorization reference and the exact prepared mutation. Recovery checks the original attempt under the exact provider installation and replays permitted bytes under the original authority. Core checks current grants for further private reads and ordinary execution. Closing an existing run and observing its limited closure metadata use the originating installation's service credential. The user's next sign-in is required when a new action genuinely needs renewed authority.

## Execution and platform profiles

The production HTTP process wakes an independent supervisor for work due in its indexed store. The supervisor owns native admission and lifecycle observation. The packaged Local runner holds its bundle generation while it runs. Build and runtime readers prevent garbage collection of an active generation. This matters when an older supervisor outlives the HTTP service that accepted its command.

Workspace-capable native execution requires a supported writer scope before a provider can acquire mutable source. Windows uses a Job Object and Linux requires a delegated cgroup v2 subtree and the supported process launcher. Native macOS currently lacks a qualified workspace-writer scope. Providers on that profile support standalone work and reject a mutable worktree at admission. Kernel or administrator prerequisites for a profile are visible in the provider capabilities. Platform qualification and outstanding scope work are tracked in the [release plan](plan.md).

## Delivery and status

The provider retains each positioned public observation for its destination installation. A bounded read can return current state while an older interval still needs backfill. Harness commits the materialized conversation, pending event data and its contiguous receive position to the chat database before acknowledging delivery. Duplicate records and retries keep the same source identity. New attempts in a chat with at least 64 MiB awaiting durable delivery are deferred until its consumer acknowledges. Other chats retain their own admission budget. A disconnected tab can immediately read already committed messages. Provider cleanup may reclaim acknowledged delivery while preserving current state and replay anchors.

Harness publishes one attempt summary for the conversation header, workspace participants and navigation counts. Contact freshness, transcript gaps and execution phase have different meanings. Losing contact preserves the last known phase and its observation time. Status refresh on its own cannot mark a run failed. An early native child result retains its source identity while its parent relationship is pending.

## Stop and removal

A confirmed chat deletion records the selected chat and its cleanup references before retiring it from navigation. Cleanup continues server-side through browser disconnects and Harness restarts. The owning service addresses the original attempt. A replacement installation has its own authority. Chat removal, provider delivery cleanup and removal of a Core-owned workspace are independently observable. The original native account can retain its own SDK transcript.

After verified closure, the provider can discard an individual run's delivery copy for its original installation. Harness records local erasure separately from a provider that is temporarily unreachable or has been replaced. A minimal receipt fences subsequent retries.

Core persists a confirmed workspace deletion with its exact selection. The operation handles active claims and supported app or Core Return transitions. Physical deletion depends on verified resource release. Other chats and unselected sources retain their independent ownership.

## Data and deployment

The execution contract is v2 and keeps the structured `agent-event.1` envelope. Core discards incompatible providers during contract selection. New execution and conversation stores start in their own generation. Old active writers require quiescence. Legacy data does not participate in v2 discovery or automatic execution. The cutover preserves separate account settings and secret references. A scoped rehearsal can use disposable test data independently of the user's working chats.

## Testing Expectations

- Exercise dropped and reordered submissions, duplicate Stop, generation changes, concurrent owners and service loss on either side of admission. Count native dispatches and check the durable public outcome.
- Stop a real pending approval. Restart Harness and the provider independently. Verify closure and continuation using the original user and installation. Revoke private read access and check the limited cleanup endpoint.
- Run three chats for two users while Harness is offline. Deliver native terminal results, introduce disjoint history gaps and reconnect actual browsers. Compare final content, ownership, ordering and duplicate counts. Check status on all surfaces during the outage.
- Exercise confirmed deletion of a working chat and dirty workspace with a lost HTTP reply, browser closure, resource lock, authority loss and self-hosted Return. Verify logical removal, cleanup evidence and retained unrelated data.
- Build the selected Local and Docker artifacts. Exercise incomplete and in-use build generations. Qualify writer scope closure on the actual OS, including a detached child holding an external resource.

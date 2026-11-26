---
created: 2026-11-25
updated: 2026-11-26
summary: Provider-owned attempts, durable chat delivery and server-owned removal in the agent v2 execution protocol.
components: [apps/core, apps/harness, packages/agent-provider-runtime, packages/app-sdk, packages/app-sdk-dotnet]
---

# Agent execution reliability

The provider observes the exit of each agent and owns the cleanup of its descendants. A confirmed agent exit frees the conversation for its next turn. Harness owns the conversation and its transcript. Core binds the caller, actor, provider installation and exact command bytes. The [incident review](../../reviews/2026-11-25-provider-harness-reliability.md) traces the earlier contradictory stop messages, lost acknowledgements, stalled history and inconsistent workspace counts to the individual operations that produced them.

## Commands and admission

An attempt uses an immutable run UUID. Repeating Start with the same identity and input returns the saved outcome. A changed body conflicts even after a newer run starts. The provider commits admission, control receipts, execution transitions and outgoing public history in its execution database. A detached supervisor claims its attempt under an OS-released lock and contacts the adapter. Its identity, input and stop intent survive an HTTP service restart. An unconfirmed native dispatch is subject to the adapter's reconciliation rules. An arbitrary external command with a lost acknowledgement cannot safely be issued a second time.

Stop addresses the run and carries a stable request UUID. A newer snapshot revision cannot invalidate the user's decision. A Stop that wins the admission race suppresses a later Start for the same owner and run. The run records the native agent's exit, verified writer closure and the outcomes of its tools separately. An open approval becomes obsolete when the provider accepts Stop. If the database cannot commit a validated command, the HTTP service returns a retryable storage error. It attempts to stop the original single-attempt supervisor when it still owns that exact process handle and generation. A database outage before authorization and generation can be checked yields a retryable error. Harness retains the original command for replay after recovery. Tests cover SQLITE_FULL, an unreadable ownership database and two independent live inference streams during a failed Stop commit. A previously completed turn retains its result.

Harness persists the original Core authorization reference and the exact prepared mutation. Recovery checks the original attempt under the exact provider installation and replays permitted bytes under the original authority. Core checks current grants for further private reads and ordinary execution. Closing an existing run and observing its limited closure metadata use the originating installation's service credential. If Core recorded the authorization but Harness lost its reply, the original consumer can recover it by the actor, provider, session, run and exact command bytes. A fresh sign-in can renew a revoked original grant for the same unadmitted Start. The previous bearer stays invalid and an already admitted attempt keeps its original authority.

## Execution and platform profiles

The native account, skill directory and process tracker use the same typed adapter wrapper. It forwards every run method and binds it to its original instance. Adding an optional run method requires updating that wrapper. An explicit Stop observes primary exit, and the adapter returns a separate completion for output and cleanup. The shared Codex profile attempts its credential handoff before the next turn can use it. A handoff error is recorded in the provider's diagnostics and preserves the confirmed process exit.

The production HTTP process wakes an independent supervisor for work due in its indexed store. The supervisor owns native admission and lifecycle observation. The packaged Local runner holds its bundle generation while it runs. Build and runtime readers prevent garbage collection of an active generation. This matters when an older supervisor outlives the HTTP service that accepted its command.

First-party providers on macOS and Linux advertise ordinary editing through `workspace.edit`. An authorized chat can edit its selected worktree with its existing account and tool permissions. A successful Windows Job Object probe also enables ordinary editing on Windows. The optional `scope.workspace-writers` capability advertises verified process containment. Windows assigns a named Job Object at launch. On qualified Linux hosts, the provider uses a delegated cgroup v2 and verifies that the cgroup is empty, including descendants that created a separate process group. An operation requiring this guarantee can request it explicitly.

A confirmed agent exit closes the run slot. The provider continues cleanup of known descendants using the available OS mechanism. On native macOS a command that started a separate process group can outlive its agent. Files written before Stop stay in the workspace. A packaged macOS Codex test recorded a real file write by an owned descendant after the public Stop event and before the OS group closure receipt. A subsequent turn edited the same worktree through the same provider session. The provider reports verified writer closure separately through `writerScopeClosed`. An exclusive environment consumer must observe a qualified open scope at registration and a closed scope for the original execution before release. The Windows Job Object and Linux cgroup qualification each captures the original agent's exit code, compares the entire output of a successful native command and independently acquires a SQLite lock after killing both the attempt owner and its receipt writer. The detached descendant held the lock before recovery.

## Delivery and status

The provider retains each positioned public observation for its destination installation. A bounded read can return current state while an older interval still needs backfill. Harness commits the materialized conversation, pending event data and its contiguous receive position to the chat database before acknowledging delivery. Duplicate records and retries keep the same source identity. A final response that fits the native journal but exceeds the size of one public event is delivered as ordered parts under its original message ID. A completed sequence replaces the streamed draft. Codex decodes split UTF-8 sequences before framing RPC messages. After an explicit Stop the supervisor drains already registered results for the original run in the background. A forced stop that cuts the output pipe retains the known exit and records the incomplete drain. The consumer can reconstruct it from its persisted transcript after restart. New attempts in a chat with at least 64 MiB awaiting durable delivery are deferred until its consumer acknowledges. Other chats retain their own admission budget. A disconnected tab can immediately read already committed messages. Provider cleanup reclaims acknowledged delivery while preserving current state and replay anchors. The admission threshold permits an existing attempt to finish while its consumer is offline. In a storage test, 1,032 output blocks and state observations accumulated 69,717,245 unacknowledged bytes in one chat. Another chat could commit immediately. All output hashes survived, duplicate acknowledgement reduced outstanding bytes to zero, and SQLite retained freed pages for reuse. The native journal separately enforces a 64 MiB total per attempt and a 1 MiB frame limit. At that boundary it preserves the previously committed frames, records the failure and stops the attempt. A packaged provider test keeps an inference stream open through an HTTP restart with more than 64 MiB of unacknowledged public output. The Stop endpoint closes the stream. A new Start waits until the consumer reads all 65 messages and acknowledges their original positions. Its retry then starts one inference. The two limits apply to different representations of the data.

Harness publishes one attempt summary for the conversation header, workspace participants and navigation counts. Contact freshness, transcript gaps and execution phase have different meanings. Losing contact preserves the last known phase and its observation time. Status refresh on its own cannot mark a run failed. An early native child result retains its source identity while its parent relationship is pending. In a managed browser test, three silent but running chats stayed current through 45 seconds of idle workspace observations. Loss and restoration of contact with one attempt updated all three views together. Two disjoint history gaps recovered in reverse order while new messages remained visible. The complete transcripts contained each expected message once. The installation's compact status snapshot can already show a terminal run while its positioned tool output is still arriving. A reinstall test reads two distinct marked tool results from the provider's committed delivery and from the browser's authenticated chat stream. After the provider's data is wiped and the operator starts a fresh native context, the same results are still readable in the original chat and are absent from the fresh model input.

## Stop and removal

A confirmed chat deletion records the selected chat and its cleanup references before retiring it from navigation. Cleanup continues server-side through browser disconnects and Harness restarts. The owning service addresses the original attempt. A replacement installation has its own authority. Chat removal, provider delivery cleanup and removal of a Core-owned workspace are independently observable. The original native account can retain its own SDK transcript.

After verified closure, the provider can discard an individual run's delivery copy for its original installation. Harness records local erasure separately from a provider that is temporarily unreachable or has been replaced. A minimal receipt fences subsequent retries.

Core persists a confirmed workspace deletion with its exact selection. The operation handles active claims and supported app or Core Return transitions. Core verifies its consumers, mounts, Git worktree and directory when removing a selected workspace. Recreating the same logical workspace allocates a new physical path and Git branch. A descendant retaining the old working directory or an open file descriptor can finish against the old allocation. Disk space for an unlinked open file becomes available when that descriptor closes. Other chats and unselected sources retain their independent ownership. In managed Core acceptance, a single confirmation replaced the active self-hosted Core, stopped its selected child instance and removed the selected source. The operator account survived and replay returned the same operation. A separate browser-disconnect run verified on disk that the two selected owner chats disappeared and a third chat and a different user's chat remained.

## Data and deployment

The execution contract is v2 and keeps the structured `agent-event.1` envelope. Core discards incompatible providers during contract selection. New execution and conversation stores start in their own generation. Old active writers require quiescence. Legacy data does not participate in v2 discovery or automatic execution. The cutover preserves separate account settings and secret references. A managed rehearsal starts the packaged Docker Harness and Local Codex Provider against disposable v1-shaped stores. The packages refuse an active writer, an unreleased lease, a reserved continuation and contradictory terminal receipts. After the independent test process exits and the legacy receipts agree, the packages start with empty v2 chat history. An existing Core-backed connection and unrelated files survive. Restarting both services and repeating the same request ID preserves the run and native spawn identities. The rehearsal uses a scripted Codex peer and synthetic legacy inventory.

Harness recognizes a v1 retirement record after the corresponding conversation is removed.
A pending legacy cancellation can stay in the offline journal when its run has confirmed
native exit or was retired. The original observations, cancellation state and tool outcomes
stay intact. An unresolved observation identifies its run in the startup error.

For an archived conversation whose retained Harness projection lacks confirmation, an
operator can verify the original provider evidence offline. Stop Harness and any services
still writing v1 data through Core, and keep a verified backup. Select the archived v1
conversation record and its provider app directory for each blocked run. If the original
provider session file was moved out of the active inventory, include its archived path
under that provider's `data/diagnostic-quarantine`. The evidence file uses absolute paths.
Keep the archived conversation record with its companion provider execution file when present.

```json
{
  "version": 1,
  "records": [
    {
      "archivedRecord": "/absolute/archive/conversation/record.json",
      "providerRoot": "/absolute/hosty/apps/provider-app-id",
      "archivedProviderSession": "/absolute/hosty/apps/provider-app-id/data/diagnostic-quarantine/old-session.json"
    }
  ]
}
```

On the host, use a source checkout containing the recovery command with dependencies
installed by `npm ci`. Run the command from its repository root as the OS user that owns the
Harness coordinator files. That user needs read access to the selected evidence.

```sh
npm run recover:legacy-cutover --workspace @haas/hosty-harness -- \
  --data-dir /absolute/hosty/apps/hosty.harness/data \
  --evidence /absolute/archive/cutover-evidence.json
```

The command takes the coordinator ownership lock and checks the archived observation against
the provider installation, run, session and generation. It requires the provider's terminal
journal receipt and sealed native exit receipts for that generation. If the provider was
reinstalled, an exact retained provider session record must establish the original installation.
The archive's selected execution file must agree with the recorded attempt. Outstanding commands
can remain in its archive only when they cancel that same run. A retained admitted continuation
is allowed when it identifies the same provider run whose native exit is verified. An active
conversation still has to pass the ordinary writer checks. A successful verification
creates the v2 store marker while preserving the original evidence. Start Harness through Core
afterward.

## Testing Expectations

- Exercise dropped and reordered submissions, duplicate Stop, generation changes, concurrent owners and service loss on either side of admission. Count native dispatches and check the durable public outcome.
- Stop an agent with a pending approval and a live background child. Verify immediate chat continuation, eventual cleanup of the owned group and the separate proof for exclusive reuse. Restart Harness and the provider independently. Verify closure and continuation using the original user and installation. Revoke private read access and check the limited cleanup endpoint.
- Run three chats for two users while Harness is offline. Deliver native terminal results, introduce disjoint history gaps and reconnect actual browsers. Compare final content, ownership, ordering and duplicate counts. Check status on all surfaces during the outage.
- Exercise confirmed deletion of a working chat and dirty workspace with a lost HTTP reply, browser closure, resource lock, authority loss and self-hosted Return. Verify logical removal, cleanup evidence and retained unrelated data.
- Build the selected Local and Docker artifacts. Exercise incomplete and in-use build generations. Qualify writer scope closure on the actual OS, including a detached child holding an external resource.
- Verify cutover with retired and archived v1 runs, including a pending cancellation for an
  already closed run. Assert that unrelated or incomplete evidence blocks cutover and keeps
  the original journal intact.

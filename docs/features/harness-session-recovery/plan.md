---
status: Blocked
created: 2026-11-24
updated: 2026-11-24
summary: Keep unrelated chats running when provider storage fails and offer one truthful recovery notice with an available next action.
components: [apps/harness, packages/agent-provider-runtime]
---

# Recover from provider storage failures

## Observed failure

On production Windows, Codex Provider 0.8.1 returned `storage_uncertain` during the first
send in a fresh Harness 0.108.3 chat. Harness retained the original send and Stop requests.
The fresh provider session had no admitted native run in its retained aggregate. A temporary
aggregate for a different session remained from a write roughly two and a half minutes before the error.
The underlying I/O exception is absent from the runtime log.

The provider loads every aggregate when counting occupied slots. The same enumeration runs
during native maintenance. A fenced session can interrupt unrelated admission or maintenance.
A cache miss during run lookup can also return another session's storage error. A separate
failure mode occurs when the authoritative aggregate has been committed and publication of its
history to SQLite fails.

Harness can repeat the same refusal in the conversation notice, recovery lookup and transcript.
Stop pauses the queue and labels the response stopped before a provider confirms the stop.
[#852](https://github.com/alex-de-haas/docker-host/pull/852) removes false warnings for healthy
admission and already-running executions. It preserves the distinction between healthy
admission and the confirmed storage failure addressed here.

## Target behavior

A provider handles the affected session independently. It retains the exact run and durable
request identities and counts a potentially occupied slot while its state is uncertain. Other
sessions can send, receive updates and stop subject to ordinary capacity. A lookup for the
affected run keeps its real uncertainty visible. An unrelated lookup does not inherit that
failure.

If authoritative state was committed and only the history projection failed, the provider
retries publication from the saved outbox. It reports whether a send or Stop was accepted from
authoritative state. When the authoritative write itself is uncertain, recovery verifies the
retained record and request before allowing further writes. A status check never resends
input, repeats commands or supplies an exit confirmation.

Harness displays one current notice for the failed admission or Stop. It gives the operator a
**Check status** action and processes the result in the same notice. Harness restores normal
activity when evidence arrives, presents a safe action for an explicitly unadmitted request
or a recoverable execution, and keeps the exact original request when the outcome is still
unknown. The notice explains when only provider recovery can proceed. The queue stays paused
until the user can safely act, and it reports a confirmed stop only after that confirmation.
Drafts, attachments and other sessions remain available.

## Deliverables

- [x] D1. Isolate an affected aggregate in admission capacity, native maintenance and run lookup. Preserve its storage fence, occupied capacity and attempted identity. Log the failed persistence stage and sanitized error code without logging message or attachment contents.
- [x] D2. Reconcile history publication failures from the authoritative durable outbox and provide a scoped status and supported recovery path for the affected execution. Preserve exact request IDs, ownership and execution evidence across retries or restarts.
- [x] D3. Consolidate duplicate recovery and Stop messages into one Harness notice with a working status action and truthful queue and activity state. Preserve original send and Stop requests and enable follow-up actions only when their prerequisites are established.
- [ ] D4. Verify the production failure shape on an isolated Windows Core and update the shipped behavior and verification expectations in the recovery and provider documentation.

## Verification

- Inject a write or rename failure for one populated provider aggregate, then send the first
  message in a separate chat with an attachment. Verify that the new run starts and an independent
  run can still stream and stop. Verify that the fenced run stays reserved and its own reads report
  the correct uncertainty.
- Inject an SQLite publication failure after an aggregate commit. Verify exact replay without
  duplicate history, a duplicate admission or a duplicate command. Compare the result before and
  after provider restart.
- Exercise a retained send with no provider run, a failing Stop and a retained accepted run.
  Check that the user sees one notice, can check the status without sending a new message and sees
  the actual state of each action. Keep drafts and attachments intact across reload.
- Run affected Harness and provider tests and builds, then the managed `agent-providers` suite.
  Exercise the warning and follow-up in the authenticated Harness UI on the isolated Windows host.

The managed macOS suite passes and cleans up its child Core. The Windows acceptance scenario
is included in that suite and uses a disposable Core, but needs execution on a Windows test host.
The configured Windows SSH target is production and was used for diagnosis only.

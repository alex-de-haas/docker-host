---
status: Blocked
created: 2026-11-24
updated: 2026-11-25
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

The incident release loaded every aggregate when counting occupied slots. The same enumeration ran
during native maintenance. A fenced session could interrupt unrelated admission or maintenance.
A cache miss during run lookup could also return another session's storage error. A separate
failure mode occurred when the authoritative aggregate has been committed and publication of its
history to SQLite fails.

Harness could repeat the same refusal in the conversation notice, recovery lookup and transcript.
Stop paused the queue and labelled the response stopped before a provider confirmed it.
[#852](https://github.com/alex-de-haas/docker-host/pull/852) removes false warnings for healthy
admission and already-running executions. It preserves the distinction between healthy
admission and the confirmed storage failure addressed here.

## Target behavior

A provider handles the affected session independently. It retains the exact run and durable
request identities and counts a potentially occupied slot while its state is uncertain. Other
sessions can send, receive updates and stop subject to ordinary capacity. A lookup for the
affected run keeps its real uncertainty visible. An unrelated lookup does not inherit that
failure.

The [v2 execution contract](../agent-execution-reliability/feature.md) replaces the aggregate and outgoing history writes with a single SQLite transaction. An uncommitted Stop remains the original request to retry after storage recovers. Harness retains the last committed snapshot and reports Stop when the provider confirms agent exit. Its reconciliation worker operates while every browser is closed. Drafts, attachments and other sessions remain available.

## Deliverables

- [x] D1. Isolate an affected aggregate in admission capacity, native maintenance and run lookup. Preserve its storage fence, occupied capacity and attempted identity. Log the failed persistence stage and sanitized error code without logging message or attachment contents.
- [x] D2. Reconcile history publication failures from the authoritative durable outbox and provide a scoped status and supported recovery path for the affected execution. Preserve exact request IDs, ownership and execution evidence across retries or restarts.
- [x] D3. Consolidate duplicate recovery and Stop messages into one Harness notice with a working status action and truthful queue and activity state. Preserve original send and Stop requests and enable follow-up actions only when their prerequisites are established.
- [ ] D4. Verify the production failure shape on an isolated Windows Core and update the shipped behavior and verification expectations in the recovery and provider documentation.

## Verification

- On an isolated Windows Core with the packaged Local provider, keep two admitted chats active and fail a Stop commit for one run. Check the exact request outcome, the sibling's progress and the absence of a native cancellation before durable admission.
- Exercise a store read failure, restore storage, and verify automatic replay of the same request, one native Stop, one terminal transcript item and retained attachments. Repeat around a provider restart.
- Open the authenticated Harness UI and verify one current status after recovery. Record the Windows, provider, Harness and Core versions. Keep the original Windows aggregate incident distinct from the v2 reproduction.

The isolated macOS managed suite and provider-level SQLite failure tests cover parts of this scenario. The authenticated Windows Core and browser case in D4 still requires separate evidence.
The configured Windows SSH target is production and was used for diagnosis only.

---
created: 2026-10-28
updated: 2026-10-28
summary: Dashboard receives actor-owned sandbox inventories over the shared Core SSE stream, with no healthy-stream inventory polling.
components: [apps/core, apps/shell]
---

# Sandbox Live Updates

## Delivery

Dashboard loads both inventories on entry and requests `topics=sandboxes` on its existing
[Core event stream](../core-event-bus/feature.md). Core acknowledges `sandboxes: 1` and sends
`sandbox.snapshot` with complete `environments` and `instances` arrays. This also happens on
reconnect, so a missed transition does not require replay. Each array has the same actor-owned
projection as its ordinary HTTP inventory. Partial read failures carry a null array and an error;
they preserve previously displayed resources instead of claiming the inventory is empty.

Core emits new snapshots after successful environment/instance journal writes and instance
removal. Writes signal only interested administrator subscriptions belonging to the owner.
Each stream coalesces a drained event batch, projects current state and suppresses unchanged
serialized data. A per-subscription revision survives the shared bounded queue dropping hints;
normal stream draining and keep-alives reconcile that revision. Failed projections retry through
the same path. No durable event log or second browser connection is introduced.

The subscription requires an administrator and, for delegated callers, both
`core.environments.inspect` and `apps.sandboxes.inspect`, in addition to the event route's ordinary
permissions. Authority is checked again after projection and before data delivery. Core uses
normal user/installation grants; runtime app identifiers confer no special privileges.

Runtime observation is independent of Dashboard HTTP reads. The child Core supervisor checks
process state with its existing fifteen-second resource observation; individual app sandbox
supervision retains its existing cadence. A process exit is persisted and delivered even when
no browser is reading an inventory.

## Shell Behavior

Supported healthy streams have no periodic inventory GETs, including empty inventories. Streamed
state supersedes in-flight older HTTP responses. Explicit Refresh and lifecycle actions can still
read current state; a missing app row does not complete a pending disposal until its exact durable
receipt is verified. A failed receipt read retries with capped backoff only while that exact operation
is pending, even when no further stream event arrives. Expanded rows and unsaved account forms retain their state across snapshots.

Hidden Dashboard consumers release sandbox interest. Visibility return and reconnection obtain a
complete current snapshot. Older Core versions or failed connections use a visible-only five-second
fallback. Capability negotiation is per topic: a Core lacking sandbox snapshots can still stream
resource measurements on the shared connection. An acknowledged stream missing its first snapshot
gets one bounded HTTP recovery read after fifteen seconds.

Expanded running child rows separately refresh their app and initialization details every five
seconds while visible; collapsed rows perform no such reads. Sandbox inventory snapshots do not
trigger these detail requests. This consumer-specific behavior preserves child app/setup freshness
without an empty Dashboard paying for it.

## Testing Expectations

- Verify both inventory permissions, owner isolation, current role/session/permission checks,
  external creation/lifecycle/removal and reconnection through the real Shell BFF.
- Preserve correct recovery after shared queue overflow and failed inventory reads, including
  no false empty state or premature completion of a pending operation.
- Verify two idle minutes without inventory reads, older/mixed capabilities, network loss,
  visibility cleanup, late HTTP responses and expanded-only detail requests.
- Observe child process exit without any inventory request. Run Core/Shell builds, affected tests,
  Native AOT validation and the managed Shell integration suite; Finish its owned test resources.

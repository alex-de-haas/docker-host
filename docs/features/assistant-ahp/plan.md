# AHP Session Protocol Foundation

Status: Draft
Created: 2026-09-26
Updated: 2026-09-26

## Goal And Priority

Owner decision, 2026-09-26: adopt Agent Host Protocol first, then build the broader session
infrastructure around its verified contracts. This is the first implementation priority within
the [session roadmap](../assistant-development-sessions/plan.md). First prove the fit with the
existing Codex/Claude adapters; then make AHP the primary session/client protocol. Prioritization
does not mark this Draft Ready or authorize implementation before the remaining design is approved.

Own the canonical session/chat event foundation, invocation normalization, AHP server contract and
web-client cutover. [Provider switching](../assistant-shared-history/plan.md) builds on it with
multi-executor context reconciliation. Workspaces, PR lifecycle, summaries, feedback and native UI
consume the same session identities/state, rather than creating another custom conversation protocol.

The official AHP Swift client is the selected dependency for
[Harness Swift](../hosty-harness-swift/plan.md). No separate REST/SSE native MVP is planned.
Existing HTTP APIs remain appropriate for Core lifecycle and Hosty-specific operations; AHP-first
does not mean reimplementing every app/Core API as a protocol method.

## Protocol Contract

Use AHP for discovery, shared session/chat state, history access, changesets, turn control and
confirmation/reconnection where the pinned capabilities support them. Hosty still implements Git,
permissions, runtime selection and completion semantics. AHP authentication does not implicitly
authorize workspace, publication or Core mutation operations.

AHP session state has one required `provider` identity (the creation request may omit it).
For Hosty's same-session executor switching, use a stable Hosty orchestration provider as the
proposed server mapping. This follows our chosen session semantics, not a protocol mandate that
every host use this architecture. Provider/account execution IDs remain internal and separate.
The spike verifies how custom-agent selection maps to the executor and whether generic client
pickers render it. `Message.origin` identifies the initiating/steering actor; `Message.agent`
selects a custom agent, not arbitrary native-provider migration. Preserve assistant response
attribution through turn/execution metadata as necessary and test its actual client presentation.

The inspected session/chat channels are Stable; changeset is Release candidate. Changesets expose
file views plus server-defined invokable operations (including create-pr examples). Hosty owns
Git/PR semantics even when those operations are surfaced through the standard mechanism. Pin
protocol/SDK versions and tolerate unsupported optional channels.

Choose SDK/protocol versions, map Gateway events to stable turn/tool identities, snapshots and
sequence cursors, and verify disconnect/replay behavior. A reconnect must not duplicate messages or
mutations; in-progress state must be reconstructible or honestly marked interrupted. Keep existing
REST/SSE behavior during a reviewed transition; do not assume a transport replacement is sufficient.

Web and the planned [dedicated Swift client](../hosty-harness-swift/plan.md) operate the same
server-resident agents and workspaces. The native plan owns phone navigation, app delivery and its
client acceptance; this plan owns the server contract and interoperability. No generic Swift Shell
side-panel implementation is required by this direction. Client
disconnect should not cancel server work; approvals can remain pending and be answered after
reconnection. Server crash recovery is a separate contract, not an automatic AHP guarantee. Scope
session ids and credentials to an environment so local and remote hosts cannot be confused.


## Invocation And Persistence Foundation

Implement correlated invocation IDs and observed terminal states once in the native adapters and
durable shared event contract. AHP projection and the separate action-summary feature consume this
same stream. Gateway's current `HarnessEvent.tool_use` lacks a per-call ID/completion pair; a turn
result is insufficient. Sequence the adapter foundation with the AHP spike before either client
summaries or timeline analytics. Missing native evidence remains explicitly incomplete.


Use one durable canonical event/state mapping and an AHP projection/reducer boundary; define
persistence and schema upgrades explicitly, because adopting a wire protocol does not itself
provide durable execution. Exercise each existing provider independently before adding switching.
Choose the stable Hosty provider identity now to avoid remapping public session IDs later.

## Transition And Completion Gate

Inventory the current web/Shell and external session API consumers. During cutover, REST/SSE may
temporarily adapt the same canonical state; do not add an independent transcript or permanent
second implementation of conversation features. Verify session/history, attachments, streaming,
questions/approvals, cancellation, authentication, disconnect/replay and restart recovery before
retiring each replaced route. Define consumer/version compatibility and the removal milestone.
Existing sessions need only follow the separately approved fresh-install/rename retention policy;
do not invent a migration requirement for old Gateway state the owner chose to discard.

## Deliverables

- [ ] Inventory current session consumers and validate a pinned AHP/official SDK spike for both
  providers, authentication, attribution, snapshots/replay and pending user input.
- [ ] Implement the canonical durable session/event mapping and correlated tool IDs/terminal states
  used by AHP and action summaries, with explicit partial native trace coverage.
- [ ] Implement the AHP server, Hosty provider mapping and permission-checked session operations;
  verify optional channel support and Hosty action exposure without widening existing grants.
- [ ] Move web/Shell session interaction to AHP and implement only the transitional compatibility
  routes required by the selected consumer policy; retire replaced routes at the verified cutover.
- [ ] Validate a minimal official Swift SDK client against the host contract, including reconnect
  and approvals, so the native product can build on proven protocol primitives.
- [ ] Verify full current-session capability parity and recovery, document shipped behavior and
  the supported protocol/SDK revisions, and hand stable contracts to the dependent features.

## Sequence And Open Questions

One feature PR after Ready: capability spike, shared event/adapters, server/client transition,
then parity and interoperability acceptance. Provider switching, source workspaces, PR lifecycle,
timeline and synthetic evaluation retain separate plans and do not gate this foundation.

- Which protocol and official TypeScript/Swift SDK revisions meet the required capability matrix?
- Which session state/persistence mapping and auth/discovery route fit existing Hosty credentials?
- Which generic-client custom-agent controls can expose Hosty's executors without misattribution?
- Which existing consumers need a compatibility window, and what verifies safe route retirement?
- Which changeset operations are usable now versus optional, given their release-candidate status?

## Verification

For both native providers, create/list/read a session, stream a turn, attach supported content,
answer questions, approve/deny tools and cancel. Disconnect and reconnect with pending input;
verify complete history, current state, no duplicate mutations and revoked-access denial. Restart
the host and either reconstruct in-progress work or report interruption accurately. Verify stable
call IDs, per-call terminal evidence and explicit unknown completion. Compare current web behavior
with the AHP client and run the minimal official Swift client against the same server.

## Sources

Reference pages rechecked 2026-09-26; pin the selected implementation versions before shipping:

- [AHP session model](https://microsoft.github.io/agent-host-protocol/reference/session.html)
- [AHP chat/history model](https://microsoft.github.io/agent-host-protocol/reference/chat.html)
- [AHP changesets](https://microsoft.github.io/agent-host-protocol/reference/changeset.html)
- [AHP connection lifecycle](https://microsoft.github.io/agent-host-protocol/specification/lifecycle.html)

- [Inspected upstream
  snapshot](https://github.com/microsoft/agent-host-protocol/tree/296b25e7b698a4a84a0ee5a28d9573e70048a0bf)

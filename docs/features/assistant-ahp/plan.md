# AHP Client Interface For Hosty Sessions

Status: Draft
Created: 2026-09-26
Updated: 2026-09-26

## Goal And Owner Direction

Owner revision, 2026-09-26: preserve Hosty's existing session implementation as the foundation and
evaluate AHP as a replaceable external client interface. This supersedes the earlier AHP-first
internal-foundation/web-cutover direction. Run a bounded integration spike before committing to
protocol adoption; other Hosty session features do not depend on adopting AHP.

Hosty's SessionManager and SessionStore remain responsible for sessions, execution and persistence.
The existing `record.json` and append-only `events.ndjson` are the starting point, extended for
product requirements rather than replaced with upstream protocol state. The
[shared-history feature](../assistant-shared-history/plan.md) owns required event improvements and
provider switching. This plan owns only the AHP projection, inbound command adapter, connection
authorization and external-client interoperability. It remains Draft pending scope approval.

## Architecture And Ownership

Both client paths call the same Hosty application services:

```text
Existing web/Shell -- REST/SSE -----------+
                                         +-- Hosty session services -- native agent adapters
Swift / other clients -- AHP adapter ----+            |
                                               Hosty session store
```

AHP is client-to-host communication; clients do not exchange authoritative state peer to peer.
Keep one source of truth in Hosty. The AHP module derives snapshots/actions from Hosty records and
events and maps inbound requests to existing permission-checked commands. It may retain protocol
cursors/replay caches or durable mapping metadata, but not an independently editable transcript.
Hosty storage, provider execution and PR/workspace models must not depend on upstream SDK DTOs or
reducers. A pinned protocol upgrade should change the boundary module and its tests, not force a
rewrite of the product state. Do not promise current persistence already supplies every required
recovery guarantee; close observed gaps in Hosty once, for both client paths.

Preserve the existing REST/SSE web interface. Both transports reflect the same updates and observe
the same action identities, access checks and pending decisions. Moving the web client to AHP is
an optional later decision based on demonstrated benefit, with no retirement milestone in this
scope. AHP failure/disablement must leave normal web session operations usable.

## First Supported Surface And Extensions

Start with the pinned stable session discovery/chat/tool-confirmation/reconnect surface. Inventory
required root commands and their version-specific guarantees instead of assuming every root API
is stable. The spike proves session reads, message streaming, questions/approvals, cancellation
and multi-client consistency with both existing native providers.

AHP session state carries one provider identity. Propose a stable Hosty provider on the wire;
Codex/Claude execution and account identity remain Hosty facts. Test custom-agent selection and
attribution as a mapping, not native-provider context migration. `Message.origin` describes the
initiating actor and `Message.agent` selects a custom agent; neither alone establishes attribution
for every assistant response. Unsupported generic-client controls should be reported explicitly.

Changesets are release-candidate in the inspected reference. Defer their projection to the
[workspace feature](../assistant-session-workspaces/plan.md), preserving existing Hosty diffs in
the meantime. The channel supports server-defined operations as well as file views, but
[PR lifecycle](../assistant-pr-lifecycle/plan.md) still owns what Publish/Merge/Complete mean.
Expose later Hosty capabilities through supported metadata/operations or scoped Hosty APIs;
do not promise generic clients understand them or invent protocol commands without a contract.

## Authentication, Versions And Recovery

Authenticate access to the Hosty connection/session separately from AHP's protected-resource token
exchange for agents. Specify Hosty credential audience, scopes, per-session authorization, expiry
and revocation, including the WebSocket upgrade and subsequent reads/actions. A scoped token at
upgrade is a candidate to validate, not an existing accepted grant. Verify the configured ingress
(including Cloudflare where used) preserves the required connection/auth behavior. Bearer tokens
must not leak into URL logs, snapshots or transcript content.

Pin protocol and SDK versions and maintain fixtures/conformance checks against the selected
TypeScript SDK reducers/schemas. These validate the projection, not define Hosty's persisted model.
Keep Hosty event revisions distinct from AHP sequence/cursor semantics; specify deterministic
mapping, reconnect windows, unavailable replay and snapshot rebuild after adapter/host restart.
Pending or completed actions survive transport changes without duplicate execution. A protocol
resume operation does not prove the native process is still running or recoverable.

## Spike And Decision Criteria

1. Connect a minimal official Swift SDK client on iOS to Hosty through the configured ingress using
   Hosty authentication; verify transport support for the required custom headers/auth flow.
2. Interrupt connectivity (including airplane mode), reconnect and recover messages/current state
   without duplicate sends or side effects. Repeat across AHP-adapter restart.
3. Resolve a pending approval from the phone and observe it in the REST/SSE web UI; race the same
   decision from both clients and execute the action at most once.
4. Exercise both native providers; when Hosty switching is available, assess its presentation in a
   generic client such as ahpc. Switching itself remains owned by the Hosty shared-history plan.
5. Determine whether VS Code Agents can connect to a third-party AHP host by URL with Hosty auth.
   Record supported versions and observed limitations; documentation about VS Code's own agent host
   is not evidence that this arbitrary-host client scenario works.

Proceed with the client adapter when the selected Swift path meets auth, reconnect and approval
criteria with maintainable mapping. Lack of a usable generic client reduces optional integration
value but does not alone invalidate the native client. If critical SDK/transport constraints fail,
record the blocker and reconsider delivery with the owner while the current Hosty UI continues;
do not automatically replace the internal model or design another new protocol.

Evaluate hosting an upstream agent host as an alternative to native Hosty adapters before Ready.
Record how either approach preserves Hosty identity/MCP grants, authoritative session history,
provider switching, workspace ownership and restart behavior. Current proposal keeps the existing
Hosty executor integration; upstream-host examples are references, not an assumed drop-in runtime.

## Deliverables

- [ ] Complete the pinned Swift/ingress/reconnect/approval spike and document generic-client and
  upstream-host alternatives with evidence and a scoped adoption decision.
- [ ] Define the Hosty-to-AHP mapping and required internal event fields with the shared-history
  owner, keeping transport-specific types out of Hosty persistence/execution.
- [ ] Implement the authenticated AHP projection and inbound command adapter for the selected first
  surface over existing session services, with common permission and operation-identity checks.
- [ ] Implement protocol version negotiation, projection fixtures, replay/snapshot recovery and
  explicit missing/unsupported behavior while maintaining REST/SSE operation.
- [ ] Verify web/AHP coexistence and official Swift interoperability, then document the shipped
  capability matrix and supported SDK/protocol revisions.

## Open Questions

- Which pinned protocol/SDK revisions meet the concrete client capability and transport requirements?
- Which Hosty event additions are required for correct projection, and how are old records handled?
- What connection token and ingress behavior enforce audience, expiry and session access?
- What replay retention/cursor mapping survives adapter restart without a second transcript?
- What observed benefit justifies adopting AHP, and can a reusable upstream host preserve Hosty semantics?

## Verification

Run the spike scenarios, authorization/revocation tests and cross-transport races. Feed recorded
Hosty events through the adapter and pinned SDK reducers; compare reconstructed visible state and
pending calls without asserting SDK state as the internal data model. Verify incomplete native tool
evidence stays incomplete, unknown outcomes are not success, adapter disablement preserves web use,
and no duplicate transcript or independent workflow engine appears. No SDK execution or ingress
test has been performed for this documentation change.

## Sources

Reference pages rechecked 2026-09-26; pin the selected implementation versions before shipping:

- [AHP session model](https://microsoft.github.io/agent-host-protocol/reference/session.html)
- [AHP chat/history model](https://microsoft.github.io/agent-host-protocol/reference/chat.html)
- [AHP changesets](https://microsoft.github.io/agent-host-protocol/reference/changeset.html)
- [AHP connection lifecycle](https://microsoft.github.io/agent-host-protocol/specification/lifecycle.html)

- [Inspected upstream
  snapshot](https://github.com/microsoft/agent-host-protocol/tree/296b25e7b698a4a84a0ee5a28d9573e70048a0bf)
- [AHP protected-resource authentication](https://microsoft.github.io/agent-host-protocol/specification/authentication.html)
- [VS Code agent-host architecture](https://code.visualstudio.com/docs/agents/concepts/agent-host)

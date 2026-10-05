# Assistant MCP Approval Rules

Created: 2026-09-29
Updated: 2026-10-05

Harness owns a shared per-tool MCP policy for Claude and Codex. Its MCP access settings display the
provider's complete tool catalog with **Ask**, **Run unprompted** and **Disabled** controls. The policy
applies to writes as well as reads, including Core development/publication tools. Target access and application instruction review are available in the same Harness screen.
The access button opens Core's administrator confirmation for this assistant only, including the
exact instruction text; Harness itself cannot approve Core policy. Shell is not required. The page
refreshes after review and displays current access and approved instruction status. Local development
tools appear as a separate Core development group. Native filesystem/shell permissions are outside these MCP controls.

Refreshing tools does not require selecting or creating a conversation. Harness asks Core to read
catalogs for its permitted targets using the current administrator's active app identity. Core mediates
only initialization and tool listing and does not return its restricted discovery credential. This
creates no execution authority: actual tool calls still require a Core-authorized assistant session.

Rules are keyed by provider/tool and bound to installation/interface identity and tool definition.
Complete discovery prunes removed or changed tools. Unknown/new tools ask. The first complete catalog
migrates an existing read-only grant only for tools declaring readOnlyHint; later tool additions or
reinstallations do not inherit that automatic grant. Unavailable or incomplete discovery preserves
settings and refuses an unverified dispatch. Settings updates serialize with catalog migrations.

The local proxy owns the approval pause. Disabled tools are filtered out of discovery and refused at
call time; Ask creates one session-owned approval card in Normal mode; Run unprompted dispatches without a card.
An explicitly selected [Autonomous chat](../assistant-session-autonomy/feature.md) also runs Ask tools
unprompted, while preserving Disabled and all dispatch rechecks.
Native Claude MCP callbacks and marked Codex proxy entries delegate their approval to this broker.
MCP rules do not relax Core/app authority or repository protection. Native file/command policy is
selected separately by the chat autonomy control.
A native tool bypass is not evidence of bypassing this HTTP MCP gate.

Approval is bound to session, native-client generation, provider, RPC request identity and argument fingerprint. Another user's
session cannot approve it. Denial, a ninety-second timeout, disconnect or session cancellation stops
pending dispatch. Pending approval references are persisted; startup recovery denies them rather than
replaying a mutation. Duplicate RPC identities are refused with instructions to inspect the outcome;
A native client start or server reconfiguration cancels pending approvals and starts a fresh RPC
namespace, invalidating old dispatch guards. Core operations retain their independent idempotent request IDs. Refresh/reconfiguration rechecks the
provider identity, current policy and a freshly minted token before forwarding. Already-dispatched
provider operations are not rolled back by a later settings change.

Automatic decisions report `ai_action_auto_allowed` with session/tool and mode through the existing
Core audit route; explicit approvals report `ai_action_approved`. Audit reports contain no tool input
or credentials. Reporting remains best-effort, as with existing assistant lifecycle reports; Core's
managed publication operations separately retain durable request/outcome records.

## Testing Expectations

- Verify all three modes for reads and writes on real local MCP transport, no dispatch before allow,
  disabled stale calls, changed definitions, concurrent settings writes and incomplete discovery.
- Verify cross-session/user denial, duplicate request IDs, cancellation, expiration and restart denial.
- Verify native adapter configuration delegates only Hosty-managed proxies and leaves unrelated MCP
  servers' approval policy unchanged in Normal mode; no Core credential appears in native process arguments.
- Verify settings controls remain available for both adapters and represent confirmed server policy.
- Verify no-chat catalog refresh, direct and embedded Core review, read-only refresh after approval,
  instruction text/status and no mandatory Shell navigation.

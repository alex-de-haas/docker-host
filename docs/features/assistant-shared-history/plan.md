# Shared Assistant History And Provider Switching

Status: Draft
Created: 2026-09-26
Updated: 2026-09-26

Part of [shared assistant development sessions](../assistant-development-sessions/plan.md).
The umbrella invariants apply. This independently scoped feature follows the
[AHP foundation](../assistant-ahp/plan.md), which owns protocol, durable events and adapter tool
correlation. This feature owns cross-provider context assembly, execution cursors and switching.
It remains Draft pending its own Ready approval.

## Target Behavior

Gateway owns the durable shared conversation and exposes it through an AHP-compatible state model.
Avoid an independent second transcript that can diverge from what the UI and agents see. Keep
messages, visible tool results, attachments and decisions attributable to the user and selected
provider/account. Native hidden state is not a portable transcript or a prerequisite for switching.

Select an available connected agent for the next turn. Initially, finish or explicitly interrupt
the active turn before switching; do not silently replay pending tools/approvals on another provider.
Retain workspace and policy identity while revalidating the selected adapter's actual capabilities.
An unsupported permission boundary must fail explicitly rather than broadening access.

Maintain native execution identities separately from the Hosty session, bound to the exact provider
connection/account. Never give a Claude session id to Codex or reuse a native id under a different
account. Track which shared events each execution has consumed. On return, supply all missing
relevant events once; if reliable native resume plus context injection is unavailable, start a new
native execution from the shared history. Imported results are historical evidence, not tool calls
to execute again or fabricated provider-native messages.

For long histories, retain the full accessible transcript while building a bounded model context
from recent turns, a versioned summary and retrievable earlier material. Read current plan/source
files after another agent edits them. Mark summary coverage and stale source observations. The
Codex-plan -> Claude-review/amend -> Codex-implement loop must work across Gateway restart as well
as ordinary switching. Changing providers does not count as a new development session.

## Session Visibility

Define session ownership and visibility among administrators; an administrator role alone must not
silently decide whether every private conversation is shared. Evaluate private-by-default with
explicit sharing as a proposal, including attachments, AHP reads and external context import.
Feedback batch dispatch requires access to the destination session. Revalidate revoked membership
on reconnect, tool execution and attachment reads.

## Deliverables

- [ ] Implement provider/account execution cursors and safe native resume or recreation using the
  AHP foundation's durable conversation and attribution contract.
- [ ] Implement bounded context assembly, summary coverage and retrievable history/attachments
  so the returning provider receives intervening work without replaying actions.
- [ ] Implement internal provider switching and its web/client selection semantics, including
  finish/interrupt boundaries and revalidation of executor permissions.
- [ ] Implement the selected session sharing/visibility contract and verify cross-administrator
  access, attachment access, external context import and feedback destination eligibility.

## Open Questions

- Which adapters safely resume with additional context, and when must native execution be recreated?
- What attachment retention, model-context budget and summary policy preserve the complete visible history?
- What session sharing default and membership rules apply to multiple administrators?

## Verification

Codex plans, Claude reviews/amends and Codex implements in one visible session. Repeat after a
Harness restart and verify attribution, intervening context, no duplicated tool effects and no
cross-account native-session reuse. Revoke session access while another client is connected and
verify history, attachments and pending decisions follow current authorization. Provider changes
preserve existing registered workspace identity without requiring workspaces for ordinary Q&A.

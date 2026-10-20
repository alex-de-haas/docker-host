---
status: Draft
created: 2026-10-09
updated: 2026-10-20
summary: Deferred execution-scoped credentials for assistant and external-agent source operations, independently of the workspace viewer.
components: [apps/core, apps/harness]
---

# Assistant Execution Authorization

## Boundary

Read-only workspace inspection does not change the existing source mutation authorization contract.
This plan receives execution-scope D7 and the corresponding design portion of D5 from the session
workspace draft. External task IDs within one OAuth grant remain allocation labels, not isolation
boundaries. App/user-wide assistant credentials retain their existing checks. Neither is advertised
as a credential that is technically limited to one conversation.

The 2026-10-10 plan consolidation places the execution-credential portion of former Approval Rules
D8 here under D1-D3. Operation owners still decide app/action and Git destination authority;
permission UI cannot mint stronger credentials. Native filesystem/network isolation belongs to
Containment, not to this credential contract.

## Operator Profiles (Owner Clarification, 2026-10-16)

[Vision decision 47](../../vision.md) distinguishes a trusted host owner, who may use a privileged
external local agent, from restricted or remote operators using the built-in assistant. These are
target access profiles, not existing role names. D1 must define the actual allowed app/worktree and
operation sets, credential issuance and revocation before exposing narrower administrator access;
the current broad administrator role is not sufficient enforcement. D2-D3 implement and verify that
contract without giving the worker the trusted coordinator's authority. Execution containment owns
the filesystem/network boundary, and ordinary-user MCP-only sessions retain their separate plan.

An external agent's independent OS or provider permissions do not expand its Core grants. Core can
observe externally produced Git/PR facts without treating observation as authorization or claiming
that it executed those actions. Shared API convenience and factual reconciliation do not require
equal native privileges for internal and external clients.

## Deliverables

- [ ] D1. Specify trusted assistant/external execution registration and credentials bound to user, installation or principal, session, workspace, worktrees and permitted operations.
- [ ] D2. Implement and migrate execution-scoped source and publication authorization without exposing administrator UI credentials to agents or trusting a supplied session ID.
- [ ] D3. Verify cross-session substitution, grant revision, revocation, context changes and compatibility across assistants and external clients.

## Open Questions

- Which concrete privileges distinguish a trusted host owner from a restricted development operator, without assuming that a role label supplies enforcement?

- How does an external client register a trusted execution without inheriting operator authority?
- Which session service attests context for alternative assistants?

## Related Work

[Harness Development](../harness-development-ui/feature.md) owns the workspace UI;
[lifecycle controls](../workspace-lifecycle-controls/feature.md) owns coordinated closing;
[agent isolation](../assistant-runtime-containment/plan.md) owns the future session execution boundary;
[approval rules](../assistant-approval-rules/plan.md) owns permission choices, lifetime and decision audit.

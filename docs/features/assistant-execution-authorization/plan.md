---
status: Draft
created: 2026-10-09
updated: 2026-10-10
summary: Deferred execution-scoped credentials for assistant and external-agent source operations, independently of the workspace viewer.
components: [apps/core, apps/harness]
---

# Assistant Execution Authorization

## Boundary

The read-only Workspaces app does not change the existing source mutation authorization contract.
This plan receives execution-scope D7 and the corresponding design portion of D5 from the session
workspace draft. External task IDs within one OAuth grant remain allocation labels, not isolation
boundaries. App/user-wide assistant credentials retain their existing checks. Neither is advertised
as a credential that is technically limited to one conversation.

The 2026-10-10 plan consolidation places the execution-credential portion of former Approval Rules
D8 here under D1-D3. Operation owners still decide app/action and Git destination authority;
permission UI cannot mint stronger credentials. Native filesystem/network isolation belongs to
Containment, not to this credential contract.

## Deliverables

- [ ] D1. Specify trusted assistant/external execution registration and credentials bound to user, installation or principal, session, workspace, worktrees and permitted operations.
- [ ] D2. Implement and migrate execution-scoped source and publication authorization without exposing administrator UI credentials to agents or trusting a supplied session ID.
- [ ] D3. Verify cross-session substitution, grant revision, revocation, context changes and compatibility across assistants and external clients.

## Open Questions

- How does an external client register a trusted execution without inheriting operator authority?
- Which session service attests context for alternative assistants?

## Related Work

[Workspace inspection](../workspaces-app/feature.md) owns the read-only UI;
[lifecycle controls](../workspace-lifecycle-controls/plan.md) owns later closing;
[agent isolation](../assistant-runtime-containment/plan.md) owns the future session execution boundary;
[approval rules](../assistant-approval-rules/plan.md) owns permission choices, lifetime and decision audit.

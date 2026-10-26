---
status: Draft
created: 2026-10-26
updated: 2026-10-26
summary: Persistent agent participants with explicit access, attribution and responsible humans, separate from profiles, providers and executions.
components: [apps/core, apps/harness, packages/app-sdk, packages/app-sdk-dotnet]
---

# Persistent Agent Participants

## Goal And Baseline

Give applications a stable identity for an agent that can receive assignments and produce attributed
work. Core currently has human users, app identities and delegated credentials; Harness stores
provider connections and sessions. Those are not a shared nonhuman participant model.

The owner requested this separate Draft on 2026-10-26 under
[composable work](../composable-agent-systems/plan.md) and [vision decisions 55-56](../../vision.md).
Core ownership is the preferred design candidate. This is planning, not implementation approval.

## Target Behavior

- A persistent participant has a stable ID, display identity, lifecycle, responsible human and
  explicit access. Replacing its model or provider does not silently replace that identity.
- Shared tasks, artifacts and decisions can reference it; actions distinguish the participant,
  invoking application, execution and authorizing human/grant. Historical attribution survives
  disabling a participant without allowing further dispatch.
- A participant is not a human login, model connection, role profile, session or run. Direct
  invocation on behalf of a human remains possible without creating an agent participant.
- Reuse existing authorization mechanisms where they fit. Responsibility or a label such as QA
  grants no access. Define the credential/delegation boundary and current-rights checks explicitly;
  do not create fabricated human credentials or copy a supervisor's unrestricted credentials.
- Applications own organization charts, reporting relationships and reviewer-routing policies.
  A responsible human is a possible decision recipient, not an implicit hierarchy or transcript share.

## Dependencies And Ownership

[Agent Providers D3](../agent-provider-interface/plan.md#deliverables) owns invocation authority;
[Cross-App Auth D7](../cross-app-auth/plan.md#deliverables) owns general delegation design.
[Execution Authorization](../assistant-execution-authorization/plan.md) and
[ordinary-user sessions](../user-agent-sessions/plan.md) retain their execution/isolation boundaries.
This identity feature does not enable non-admin operator sessions or make native tools sandboxed.

[Harness Work Orchestration](../harness-work-orchestration/plan.md) owns initial profiles and hierarchy.
[Shared Tasks](../shared-tasks/plan.md), [Artifacts](../shared-artifacts/plan.md) and
[Decisions](../shared-decisions/plan.md) consume identity and access rather than defining competing users.

## Deliverables

- [ ] D1. Decide participant identity, responsible-human relationship, lifecycle and attribution fields; compare extending existing principals with a separate nonhuman principal and record compatibility/migration boundaries.
- [ ] D2. Define creation, access, delegation and disable/revoke behavior across apps, tasks and workspaces with the existing authority owners; specify credentials without simulated human logins or role-derived privileges.
- [ ] D3. After explicit Ready approval, implement the selected shared record and authorized API/SDK operations, including stable references, discoverability and historical attribution.
- [ ] D4. Verify a permitted and denied cross-app assignment/action, responsible-human changes, provider replacement and disabling during work; document the shipped contract and remaining limitations in feature.md.

## Proposed Sequence

Resolve D1-D2 with Shared Tasks and provider authority before publishing their field contracts.
Implement only after approval; use one participant in the first Harness composition before adding
an organization hierarchy. Existing skills and direct human-attributed invocation can progress independently.

## Open Questions

- Is the participant a new principal kind or an extension of current identity records?
- Which actor may create, share, administer or retire it, and may responsibility be transferred?
- How do participant rights intersect with the caller, grant and actual execution environment?
- What attribution remains after deletion or loss of access without leaking private history?

## Verification

For this Draft, run the documentation validator and link checks. Future acceptance covers two apps
with unrelated IDs, two humans with different access, no-agent Core use, revocation during dispatch,
workspace membership changes and preserved historical attribution. Test allowed operations alongside
denials; a new identity alone is not evidence of safe ordinary-user execution.

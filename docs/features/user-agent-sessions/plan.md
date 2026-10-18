---
status: On Hold
created: 2026-10-10
updated: 2026-10-10
summary: Deferred non-admin agent conversations with verified execution isolation and MCP calls limited to the acting user's current rights.
components: [apps/core, apps/harness]
---

# Isolated User Agent Sessions

## Owner Direction And Hold Condition

On 2026-10-10 the owner retained ordinary-user agent conversations as a later direction, conditional
on fully isolated agent execution. This replaces the permanent reading of vision decision 1;
[decision 28](../../vision.md) keeps the current administrator-only behavior until the boundary is
implemented and verified. This plan receives AI Agent Bridge D9. It is not approval to expose the
current operator harness to ordinary users.

Remain On Hold until the agent isolation work establishes a suitable execution boundary. A container
or an MCP-only tool list alone does not prove that boundary. Use
[agent session containment](../assistant-runtime-containment/plan.md) as the execution dependency;
this feature owns the ordinary-user profile and its acceptance, not a second container backend.
Containment owns session execution placement; a shared Harness container alone does not satisfy it.
Reuse [approval rules](../assistant-approval-rules/plan.md) for applicable permission controls,
without treating a confirmation as additional user authority.
[App Sandbox](../app-sandbox-runtimes/plan.md) isolates applications under test and is a different
capability.

## Goal And Target Behavior

An ordinary user can have a free-text agent conversation to work with assigned apps: for example,
find their tasks and request an authorized change. Each session belongs to that user. Every action
uses the user's current app and resource permissions; the model cannot choose a stronger identity.

Compared with the current [administrator-only Harness](../ai-gateway/feature.md):

- Run the user profile in the verified isolated environment, without shell, file, arbitrary HTTP,
  direct database or source-development tools. Deny access to host control channels, administrator
  credentials, production mounts and other users' session data outside the authorized MCP path.
- Give the model only permitted app MCP tools. A trusted component binds credentials to the acting
  user and target app; the receiving app validates identity, arguments and its own domain permissions
  at dispatch. Discovery and a valid token never substitute for resource authorization.
- Restrict execution networking to the required model transport and authorized Core/app MCP paths;
  model output and tool content cannot add destinations, credentials or capabilities.
- Keep conversations, attachments and any retained memory isolated by user. Decide whether durable
  memory belongs in the first slice; retaining the old idea is not a commitment to build memory first.
- Define confirmations for permitted writes separately from authorization. Confirmation cannot grant
  an administrator action or a resource the user cannot access. Reuse applicable MCP approval
  machinery without inheriting the operator's Autonomous/native-process permissions.

Delegated token exchange and app-owned MCP authorization already provide reusable building blocks.
Current Core MCP/operator credential restrictions remain unchanged until an approved contract says
otherwise. App-specific AI buttons and the feedback inbox remain independently useful.

## Deliverables

- [ ] D1. Specify the first ordinary-user scenario, supported isolated execution boundary, session/UI ownership, approval policy and first-slice memory decision; record evidence that the isolation prerequisite is met.
- [ ] D2. Define and implement user-bound session authority and per-call MCP credentials, including target/resource checks, expiry, revocation, assignment changes and refusal of administrator credential substitution.
- [ ] D3. Implement the MCP-only conversation flow in the approved execution environment with bounded runs, cancellation and user-isolated history; expose no native operator tools or indirect privileged bridges.
- [ ] D4. Reuse or extend MCP approval handling for the selected policy, bind decisions to the actual call, and handle changed schemas, oversized results and retries without duplicate side effects.
- [ ] D5. Verify allowed actions and cross-user/resource denials, prompt-injected calls, network/filesystem escapes, stale authorization, cancellation and restart behavior through Core-managed identity.
- [ ] D6. Document shipped behavior and boundaries in feature.md, update the Bridge and vision, remove this plan and regenerate the index.

## Open Questions

- Which isolated agent runtime and first app supply the smallest useful acceptance scenario?
- Can a contained existing adapter truly omit native tools, or does this need a dedicated MCP-only loop?
- Which permission changes take effect immediately, and how are already dispatched actions reported?
- Does the first release need durable memory beyond conversation history, and what are its deletion rules?
- Does this profile consume the future [agent provider interface](../agent-provider-interface/plan.md),
  or ship independently? Neither feature implicitly approves the other.

## Verification

Use two ordinary users with different assignments and app-local resource rights. Prove that allowed
reads and confirmed writes succeed, while cross-user calls, forged targets and privilege substitution
fail at execution. Revoke access between discovery, approval and dispatch. Exercise model/tool output
that requests host files, control sockets or unapproved network routes; verify denial outside the
model. Test retry/cancellation/restart behavior and absence of tokens in transcripts. Container startup
or a model declining an instruction is not isolation acceptance.

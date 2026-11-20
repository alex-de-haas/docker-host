---
created: 2026-11-20
updated: 2026-11-20
summary: An ordinary Harness chat delegates work to saved profiles, tracks child chats and resumes with their results.
components: [apps/harness, apps/core, packages/app-sdk, packages/agent-provider-runtime]
---

# Harness chat subagents

An operator can ask the current chat to give implementation to one saved profile and pass the completed work to a testing profile. Each assignment opens a full chat for the same owner, with the selected profile revision, its connection, model, instructions and skills. The parent stays open to operator messages while any number of admitted children work independently, subject to provider capacity. [Task delegation](../profile-task-delegation/feature.md) has its own task records and assignment workflow.

## Delegation and results

Harness enables the four tools when both Core and the selected [agent provider](../agent-provider-interface/feature.md) support the chat workflow. The agent lists profiles with `subagent_profiles`, sends a prompt with `subagent_spawn`, and uses `subagent_status` or `subagent_wait` to follow its own direct children. Core binds each call to the original provider, run, chat and owner. In autonomous mode child-chat tools can run without a prompt under the inherited policy. An explicit Ask or Disabled rule still applies. Task tools keep their own approval behavior. A repeated spawn with the same request ID and arguments returns the original child.

A wait can cover the first completed child or all selected children. If the result is already available, the tool returns it immediately. Otherwise Harness saves the wait so the parent can end its current turn. A confirmed outcome triggers a new turn when the parent is available. The parent receives the recorded result as a child response, with its origin intact. Its conversation retains the operator's original messages. Stopping the parent cancels pending waits. Each child can be opened and stopped independently.

Harness records the child, wait and delivery before retrying across interruptions. A cold restart can leave an outcome ready for delivery while Harness has no active credential for its owner. The owner's next authenticated visit allows Harness to resume the pending work. An unconfirmed native exit keeps the outcome open.

## Conversation and workspace

The parent transcript shows a compact expandable row with child counts and statuses. Expanding a child reveals the assignment, last known status, result and an **Open chat** link when its history is available. The child chat shows the full transcript and a **Parent chat** link. Native subagents use the same disclosure layout and report the observations their provider supplies.

A child joins its parent's [workspace](../workspace-sessions/feature.md) through Core. When an unbound parent delegates to a child that acquires a workspace, Harness also attaches the parent as soon as its active turn permits it. An existing parent association or an explicit detach takes precedence.

## Testing Expectations

- Exercise an ordinary chat with task delegation unavailable. Verify profile selection, the original prompt, final reply, and navigation through both chat links.
- Complete two children out of order. Verify waiting for any or all, duplicate request recovery, terminal-state evidence, and delivery to a busy parent after restart.
- Keep each operator's children private. Verify workspace attachment in both directions and preserve the owner's existing association.
- Run `HOSTY_SESSION_SUBAGENTS_BROWSER=1 npm run test:integration -- agent-providers` to exercise development followed by verification through a managed Core, an installed Harness, and the scripted native provider.

---
created: 2026-10-05
updated: 2026-10-29
summary: A per-chat Normal or Autonomous mode that controls whether native commands and file changes ask for approval.
components: [apps/core, apps/harness]
---

# Assistant Session Autonomy

Harness exposes **Normal** and **Autonomous** beneath the message composer, beside the provider
selector. The choice belongs to the chat and survives reopening and Harness restarts. Missing values
in older records mean Normal. Selecting a mode does not send a message or start a model.

Normal retains the existing native provider approval behavior and per-tool MCP rules. Autonomous
runs native commands and file changes without approval and treats default Ask as unprompted for enabled,
discovered MCP tools in that chat. Disabled tools remain unavailable; dispatch still rechecks tool
identity, definition, policy, cancellation, target grants and Core authorization. The setting is not
a repository sandbox: native access follows the Harness process permissions. Core API permissions
do not constrain arbitrary commands' direct filesystem or network access.

Only an authenticated administrator who owns the chat can set its mode through
`PUT /api/sessions/{id}/autonomy`. Provider handoff credentials cannot use that endpoint. A handoff
payload cannot set autonomy; new handoff conversations retain Normal, including operator immediate
handoffs. Prepared or queued handoffs and running/approval-waiting/question-waiting chats reject mode
changes. The composer disables sending while a change is being saved and shows confirmed state or
an error. Other open views refresh on the persisted `session_autonomy_changed` event.

A mode change stops an idle native client, unregisters its tool routes and cancels pending broker
requests. The next message resumes its native history with the selected mode. Codex receives explicit
sandbox and approval policy on start, resume and every turn: read-only/untrusted for Normal,
danger-full-access/never for Autonomous. Claude receives default or bypassPermissions respectively,
with the SDK's explicit bypass enablement only for Autonomous. MCP remains behind the Harness broker.
Changing mode does not select a different provider or credential.

Closing a tab does not stop a run. Stop interrupts the provider before a mode can be changed; a mode
change governs subsequent dispatch. Neither control promises termination of host processes that
have detached from the provider. Restoring Normal does not undo completed changes.

Agent context tools use the same Ask / Run unprompted / Disabled policy in both modes.
Autonomous runs enabled context operations without an extra attachment confirmation; current
user identity and session ownership are still checked. Source preparation is independent of
context selection and continues to use Core's source and participant authority.

## Core Tool Authority

Native approval mode and Core authorization are separate. MCP and workspace calls use the
assistant app's [active authorization](../app-activity-window/feature.md#assistant-activity-authorization),
with no additional approval for each conversation. Core checks the live authorizing sign-in, app
user access, installation identity and existing grants. Continuous sessions have no independent
hourly deadline. Normal and Autonomous neither add permissions nor extend principal lifetime.
Standard app recovery updates all live conversations of that actor while preserving runs and drafts.

Explicit per-tool Ask rules remain approval requirements in Autonomous mode. Run unprompted and
Disabled retain their selected behavior; autonomy does not override an explicit MCP approval choice.

## Testing Expectations

- Session/API tests cover Normal defaults, persistence, ownership, busy rejection, restart/resume,
  downgrade, provider credential refusal and ignored handoff autonomy fields.
- Protocol fixtures check actual Codex start/resume/turn parameters and Claude SDK options/callbacks;
  Normal is restored after Autonomous. These deterministic tests use no paid model calls and do not
  prove live provider command execution or cross-platform process termination.
- MCP tests cover unprompted default Ask and preserved explicit Ask in the selected chat, unaffected other chats, Disabled and policy
  revocation between authorization and dispatch.
- Component tests cover the selector, process-access description, running states, save failures and
  composer blocking during persistence.
- Core tests cover shared activity across chats, app expiry, normal renewal, browser-session
  expiry/idle/revocation and preserved permission/installation checks.

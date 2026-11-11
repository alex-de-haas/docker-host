---
created: 2026-09-22
updated: 2026-11-11
summary: The chat components Harness uses for messages, code blocks, attachments, the composer and collapsible activity.
components: [apps/harness]
---

# Hosty Harness Chat Components

The [Hosty Harness assistant](../ai-gateway/feature.md#shell-surface) uses Message Scroller,
Code Block, Attachment, Input Group and collapsible activity in its existing Radix/shadcn
interface. The app remains on its existing design tokens and Button implementation.

Shell's [operation feedback](../shell-operation-feedback/feature.md) can open a newly created session with an error draft. The authenticated session lookup precedes draft insertion; existing drafts are preserved, source provenance is visible, oversized errors carry a truncation notice, and nothing is automatically sent.

## Component Sources

`web/components.json` declares the ReUI `radix-vega` registry. Code Block is installed
from `@reui/code-block`; Message Scroller and Attachment use the shadcn components
referenced by ReUI's examples. These are local source files, with `@shadcn/react`
providing scroll behavior and Shiki providing syntax highlighting.
Imported components use the app's existing `cn` helper for Tailwind class merging.
Input Group, Collapsible and Radio Group are local shadcn primitives. Composer, context,
approval, question and activity compositions use Gateway's existing data and APIs; they
do not incorporate ReUI Pro block source.

The imported Code Block includes local compatibility adjustments: React lint fixes,
appropriate non-selectable region semantics, exact copying of an explicit code value,
clipboard failure feedback, and a scroll boundary that prevents code streaming from
moving the surrounding conversation. Registry updates require reviewing these changes.
Unknown highlight themes fall back to the matching light or dark default. Fold controls
use source line numbers even when the displayed numbering starts at an offset.

## Conversation Scrolling

The conversation follows new content while the reader is at the bottom. Scrolling up
pauses following; **Jump to latest message** resumes it. The scroller is keyed by
session ID, so another session gets its own initial scroll context. Hidden bookkeeping
events, hidden tools, and attachment events claimed by a message do not create empty rows.

The viewport keeps a thin scrollbar and a stable gutter during automatic and manual
scrolling. Following the bottom does not hide the scrollbar: changing its width reflows
messages and can trigger a resize/autoscroll loop even in an idle conversation.

## Message Formatting

Submitted user prompts and assistant replies use the same Markdown renderer. User bubbles retain
their visual alignment while rendering headings, emphasis, lists, block quotes, tables, inline code
and fenced code. Single line breaks remain visible. The composer and stored/sent message text retain
the original Markdown source; formatting also applies to messages restored from history.

Long submitted user prompts initially show a five-line prose-height preview. **Show more** reveals
the complete Markdown message and **Show less** restores the preview. Short prompts have no toggle.
The preview follows rendered wrapping when the panel width changes. Keyboard focus on a clipped
link or code control expands the message, keeping the focused control visible. Attachments remain
outside the preview and each message has its own expansion state.
Toggling a prompt pauses automatic following before its height changes; **Jump to latest message**
resumes following new content.

Raw HTML stays inert. Links use the existing allowed URL schemes and open separately; Markdown
image references remain links instead of fetching remote images. Uploaded attachments retain their
existing message association, including attachment-only prompts.

Reviewed feedback uses a compact [feedback card](../app-feedback-inbox/feature.md#feedback-cards-in-chat-history)
with counts and observation summaries. Details and the exact original request expand separately;
screenshots remain counts. Server-owned dispatch identity and authorized snapshots distinguish
these cards from ordinary Markdown messages, including messages restored from older history.

## Code Blocks

User and assistant Markdown fences, expanded tool input, command approvals, and fallback approval
JSON use a shared code block. It supports syntax highlighting, copy, optional wrapping,
and expansion beyond the initial 12 lines. Long lines scroll inside the block. Unknown
languages remain readable, and unfinished fences render during streaming.

Explicit copy values preserve commands and notation-like comments. Markdown extraction
removes the parser's closing newline. Existing markdown link/image restrictions remain
in force. File-change before/after views retain
their existing diff presentation and limits.

## Composer and App Context

One Input Group contains the full-width text field, selected attachments and a bottom
action row. A single leftmost **+** menu contains **Add app context**, **Attach files** and the
personal **Prompt suggestions** preference,
followed by the provider selector. Dictation sits immediately
before Send on the right. While the agent is running or waiting for approval/an answer, a separate
Stop action cancels the active run through the existing session cancellation API. Send remains
available to enqueue the next message.
Every SSE subscription finishes its persisted replay with the current session status, including
when no new persisted events exist, so reconnecting cannot leave Stop stuck after a completed turn.
The separate header Stop button is absent. History is retained, and the next message
can continue the conversation after cancellation. A bounded message stack above the composer holds
submitted snapshots while the next draft remains editable. The browser stages text and file blobs
before clearing the submitted draft; late acknowledgements preserve newer content. Enter and form
submission enqueue a message during a response, Shift+Enter inserts a newline, and IME composition
does not send. The legacy immediate messages API still rejects busy sessions with HTTP 409
(`session_busy`) and cannot overtake accepted queue entries.

Waiting rows expose Edit, Delete and accessible move controls. Edit reserves the row, restores its
text and attachments and stashes the existing draft. Save preserves position; Cancel restores the
original row. Another view can explicitly recover an interrupted reservation. Sending rows show
neutral inline progress; failed or uncertain rows retain their own Retry state. Queue advancement
pauses on Stop or execution failure and requires explicit Resume queue. An approval or question
holds the active turn; successful completion advances the eligible head. See
[Harness Message Queue](../harness-message-queue/feature.md) for storage, authority and recovery.

A confirmed workspace writer-admission refusal preserves the queued message and uploaded files for
review and corrected retry. The operator can recover or Return the app transition and intentionally
send again in the same chat without restarting Harness. A lost acknowledgement retains the original
send UUID; Retry checks
its serialized receipt before replaying that exact request. A receipt-read failure alone never
settles an uncertain send, and an unknown or already accepted request is never dispatched again.
Partial source lease admission retains its original lease until a retry admits the remaining
workspaces or native-exit recovery confirms that release is safe.

After a successful answer, the optional native prediction phase allows a new Send to preempt
collection and wait for native cleanup. A suggestion appears as its own literal-text card in the
conversation history. **Use suggestion** or Tab records Selected for draft and inserts an editable
draft when its original empty draft generation still applies. Escape or **Dismiss** records dismissal.
The original card and recorded choice survive reload and restart. Selection never sends automatically.
Typed content, IME, pending decisions, attachments, restored drafts and queue edits take precedence.
See [Contextual prompt suggestions](../assistant-prompt-suggestions/feature.md)
for provider availability, personal preference and freshness rules.

The app-context popover retains search, paging, the 16-app limit and revision-conflict
recovery. Selected chips inside the popover retain unavailable-app labels and individual draft-removal controls.
The chat header shows at most three overlapping context icons beside the status and an overflow
count; the empty stack is hidden. Session history rows show the same icons for their saved app context.
The separate attachment button and the stack's plus affordance are absent.
Changes during a running turn apply to the next message. Saving context temporarily
disables Send; context buttons do not submit the surrounding message form.
Busy notifications retain the active save state across renders and clear on unmount.
Clicking unused space in the action row focuses the message field, while interactive
controls and portaled context content retain their own focus. Addon click handlers can
cancel the default focus behavior.

The textarea supports [inline app mentions](../assistant-app-context/feature.md#inline-app-mentions):
`@` opens an accessible search above the field, and selection inserts a highlighted stable-id
reference while adding the app to session context. Mention association saves block Send and context/
provider changes; ordinary dictation can finish without losing its insertion. Deleting mention text
leaves context intact. The native textarea and its highlight layer retain selection, paste, IME and
undo/redo, with mention metadata saved alongside the local draft.

## Attachments

Selected files show their name, size, local image preview where applicable, and removal
action. Send moves their snapshot into the browser outbox, whose row distinguishes uploading,
saving to the server and sending to the agent. Transfer errors and Retry remain on that row; stable
upload identities reconcile lost replies. Files in the next draft remain removable while earlier
messages upload or wait. Editing a queued message restores its server snapshots and pending local
files without overwriting the stashed draft.
The composer attachment area is height-bounded and scrolls independently.

Transcript cards use attachment display names and sizes, associated with the message that names
them. Claimed upload events do not render a duplicate card. Stored cards do not fetch
remote images or imply a download action. Local preview object URLs are released when
the selection changes or unmounts. The underlying
[attachment API and limits](../assistant-attachments/feature.md) describe the retained legacy
upload endpoints and durable queue snapshots.

## Interactive Requests

Approval cards identify the action category, command/file/tool details and decision
state. Allow and Deny remain explicit actions; supported harnesses accept an optional
denial reason. Resolved cards retain the decision and its recorded reason.

Question cards use labeled radio groups for single choices, checkboxes for multiple
choices, and a free-text answer. A single choice and free text are mutually exclusive;
multiple choices can include additional free text. Submission requires every question
to have an answer. Resolved cards fold to one line like a tool call, with the recorded answers
first and each question's answer on expansion.

Both cards disable duplicate submissions while a request is pending or accepted, and
display request failures locally while preserving the operator's input for retry.
Accepted requests show a waiting state until the event stream confirms the result.

## Tool Activity

Adjacent visible tool calls form initially collapsed groups, labeled with the recorded
call count and tool names. Expanding a group exposes the existing tool rows and their
input details. The group's identity remains stable when another adjacent call arrives.
Messages, interactive requests and turn boundaries end a group; they retain their event
order. Group labels do not assert execution success, because a recorded call alone does
not establish its outcome.

Command and tool rows share the same icon, text and disclosure alignment. Each matched result
shows its own Completed, Failed, Cancelled or unavailable badge, including MCP failures. A group's
failure count remains one per uniquely matched failed call.

Available execution time appears in a separate clock badge. Codex supplies native command, MCP
and dynamic-tool durations; Claude supplies tool durations through its PostToolUse and
PostToolUseFailure hooks, excluding permission-prompt and hook time. Only a uniquely matched live
main-agent call receives hook timing; subagent timing is omitted when the SDK identities cannot
establish the corresponding parent call. Durations survive worker transport and transcript replay
and are bounded numeric metadata, never inferred from chat timestamps. Older calls, missing timing and
ambiguous or conflicting results show no fabricated duration.

## Current Activity

A compact status row below the latest content stays visible throughout a running turn, including
before the first response and during gaps after commentary. It shares the conversation scroller,
so scrolling up pauses following and Jump to latest returns to current work. Streaming text has
no separate spinner. The row announces changes politely and respects reduced-motion preferences.

The default label is **Working…**. Explicit provider reasoning signals show **Thinking…**, without
forwarding reasoning text; response deltas show **Writing response…**. Observed executing tools
show the action or app/tool name. File operations may include a bounded path; raw commands, MCP
arguments and result bodies are not included in the activity channel. Concurrent calls show the
most recently started active action and the additional active count. Repeated progress signals do
not change their start order or flood the stream.

Codex maps native item start/completion and turn identities. Claude maps thinking/text streaming
blocks, executing-tool progress and user tool-result blocks; an assistant tool proposal or the end
of a content block alone does not establish execution or completion. Calls without observable live
progress retain the generic working indicator. Completed-call heartbeats are ignored.

Approval/question waits take precedence over execution labels and use a waiting icon. Cancellation
shows **Stopping…** until resolved. Completion, failure, cancellation and abandonment clear current
activity; callbacks from a replaced run cannot restore it. A new turn starts with generic activity.

SessionManager publishes live-only `session_activity` snapshots with an instance epoch and revision.
Their negative sequence does not advance the persisted event cursor. Every SSE subscription includes
the current snapshot after journal replay, even with an up-to-date cursor. The client ignores older
revisions, clears activity when switching sessions, shows **Reconnecting…** after a transport failure,
and waits for the authoritative status after replay before showing observed execution again.
Terminal access failures remove the activity row. A quiet open stream is not treated as disconnected.

This state is transient, separate from recorded tool groups and the proposed durable invocation
history tracked by [Action Summary D4](../assistant-action-summary/plan.md#deliverables). It supplies
no percentage, ETA or claim that a tool succeeded. Harness 0.47.0 adds this behavior without Core or Shell API changes.

Verification on 2026-10-09 used a real Codex connection in the Core-managed Harness embedded in
Shell: a slow command, approval wait, completion, reload/reattach during execution and Stop. The
panel measured approximately 358 px; light and dark presentation had no activity-row overflow.
The owner approved deterministic Claude SDK coverage instead of a live Claude check because this
installation has only a Codex connection.

## Testing Expectations

- User prompt rendering covers Markdown structure, literal code and preserved line breaks, allowed
  links and inert HTML/image references, plus attachment-only turns and unchanged source text.
- Compact prompt coverage checks rendered overflow, width changes, independent expansion, keyboard
  focus recovery and attachments outside the preview without changing the stored prompt.
- Feedback-card coverage checks exact message identity, historical/live loading, session and focus
  recovery, unavailable-data fallback, collapsed details/original request and retained attachments.
- Verify aligned command/MCP rows, per-call failure badges and a separately labeled execution-time
  badge. Cover zero, missing, invalid and conflicting durations without deriving time from event
  timestamps. Exercise Codex result fields, Claude success/failure hooks and ambiguous child calls,
  then retain timing through worker journal reload and replay without exposing transport metadata.

Composer tests cover running/waiting states, Enter and submit guards, draft retention,
stop failure/retry, send failure, and completion before or after the HTTP response.
Gateway API tests verify that busy sends are rejected without transcript changes and
that sending resumes after cancellation. Workspace-fence tests cover initial and retained-send
refusals, same-session recovery after Return, partial repository admission with the original lease,
and preservation of unknown receipt outcomes without duplicate dispatch.

- Run `npm run harness:test`, including chat-rendering tests for unfinished code fences,
  inline code and URL policy, attachment errors, and transcript association after replay.
- Code Block regression tests cover theme fallback, unfolding with offset line numbers,
  and stream-completion announcements across repeated streams in React Strict Mode.
- Action-card tests cover denial reasons, single/multiple/free-text answers, failure and
  retry, duplicate-submission prevention and resolved replay. Activity tests cover event
  boundaries and stable expansion as calls arrive. Context tests cover save state,
  conflict refresh, listener changes/unmount and avoiding accidental message submission.
  Input Group tests cover textarea focus with hidden file inputs, custom click handlers,
  cancellation and portaled content.
- Activity tests cover provider lifecycle mappings, overlapping calls, late events, bounded display
  fields, snapshot/replay races, cursor isolation, reconnect/access failure, waits and cancellation.
  Page tests cover commentary/streaming gaps, revision reconciliation and switching sessions.
- Run `npm run harness:lint` and `npm run harness:build-web`.
- Check live streaming follow/pause/jump and switching sessions; code streaming must also
  respect manual transcript scrolling. Verify tool JSON, command copy, wrapping and expansion.
- At a narrow panel width, verify the transcript width stays constant during automatic
  scrolling and after it settles; an idle conversation must not flicker or reflow repeatedly.
- Check local image preview/removal, upload failure and retry without duplicate uploads,
  stored-name association, light/dark themes, and a 360 px panel without page overflow.
- Use browser API fixtures for deterministic failure/streaming cases and a Core-managed,
  authenticated app for runtime smoke checks. Shell embedding requires its own authenticated
  integration check; standalone rendering alone does not establish it.

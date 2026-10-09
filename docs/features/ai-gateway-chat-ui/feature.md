---
created: 2026-09-22
updated: 2026-10-09
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

## Code Blocks

Assistant markdown fences, expanded tool input, command approvals, and fallback approval
JSON use a shared code block. It supports syntax highlighting, copy, optional wrapping,
and expansion beyond the initial 12 lines. Long lines scroll inside the block. Unknown
languages remain readable, and unfinished fences render during streaming.

Explicit copy values preserve commands and notation-like comments. Markdown extraction
removes the parser's closing newline. Existing markdown link/image restrictions remain
in force. User messages remain plain text, and file-change before/after views retain
their existing diff presentation and limits.

## Composer and App Context

One Input Group contains the full-width text field, selected attachments and a bottom
action row. A single leftmost **+** menu contains **Add app context** and **Attach files**,
followed by the provider selector. Dictation sits immediately
before Send on the right. While the agent is running or waiting for approval/an answer, the same button
shows Stop and cancels the active run through the existing session cancellation API.
Every SSE subscription finishes its persisted replay with the current session status, including
when no new persisted events exist, so reconnecting cannot leave Stop stuck after a completed turn.
The separate header Stop button is absent. History is retained, and the next message
can continue the conversation after cancellation. The composer remains editable during
a response, but neither Enter nor form submission sends another message until the run
finishes or stops. Drafts are not queued or sent automatically. The messages API rejects
busy sessions with HTTP 409 (`session_busy`) before recording another user message.
When idle, Enter sends, Shift+Enter inserts a newline, and IME composition does not send.
This layout does not change provider locking or add model selection or starter prompts.

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
action. Uploads begin on Send. The active upload shows progress; a failed upload shows
an error and can be retried by sending again. Removal is disabled while sending.
Successfully stored files survive a failed send and are not uploaded a second time.
The composer attachment area is height-bounded and scrolls independently.

Transcript cards use stored file names and sizes, associated with the message that names
them. Claimed upload events do not render a duplicate card. Stored cards do not fetch
remote images or imply a download action. Local preview object URLs are released when
the selection changes or unmounts. The underlying
[attachment API and limits](../assistant-attachments/feature.md) are unchanged.

## Interactive Requests

Approval cards identify the action category, command/file/tool details and decision
state. Allow and Deny remain explicit actions; supported harnesses accept an optional
denial reason. Resolved cards retain the decision and its recorded reason.

Question cards use labeled radio groups for single choices, checkboxes for multiple
choices, and a free-text answer. A single choice and free text are mutually exclusive;
multiple choices can include additional free text. Submission requires every question
to have an answer. Resolved cards display the recorded answers.

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
history in [shared history](../assistant-shared-history/plan.md). It supplies no percentage, ETA or
claim that a tool succeeded. Harness 0.47.0 adds this behavior without Core or Shell API changes.

Verification on 2026-10-09 used a real Codex connection in the Core-managed Harness embedded in
Shell: a slow command, approval wait, completion, reload/reattach during execution and Stop. The
panel measured approximately 358 px; light and dark presentation had no activity-row overflow.
The owner approved deterministic Claude SDK coverage instead of a live Claude check because this
installation has only a Codex connection.

## Testing Expectations

Composer tests cover running/waiting states, Enter and submit guards, draft retention,
stop failure/retry, send failure, and completion before or after the HTTP response.
Gateway API tests verify that busy sends are rejected without transcript changes and
that sending resumes after cancellation.

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
- Check local image preview/removal, upload failure and retry without duplicate uploads,
  stored-name association, light/dark themes, and a 360 px panel without page overflow.
- Use browser API fixtures for deterministic failure/streaming cases and a Core-managed,
  authenticated app for runtime smoke checks. Shell embedding requires its own authenticated
  integration check; standalone rendering alone does not establish it.

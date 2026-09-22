# AI Gateway Chat Components

Created: 2026-09-22
Updated: 2026-09-22

The [AI Gateway assistant](../ai-gateway/feature.md#shell-surface) uses Message Scroller,
Code Block, Attachment, Input Group and collapsible activity in its existing Radix/shadcn
interface. The app remains on its existing design tokens and Button implementation.

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
action row. Attachment selection and app-context chips sit on the left; Send sits on the
right. Enter sends, Shift+Enter inserts a newline, and IME composition does not send.
This layout does not change provider locking or add model selection or starter prompts.

The app-context popover retains search, paging, the 16-app limit and revision-conflict
recovery. Selected chips retain unavailable-app labels and individual removal controls.
Changes during a running turn apply to the next message. Saving context temporarily
disables Send; context buttons do not submit the surrounding message form.
Busy notifications retain the active save state across renders and clear on unmount.
Clicking unused space in the action row focuses the message field, while interactive
controls and portaled context content retain their own focus. Addon click handlers can
cancel the default focus behavior.

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

## Testing Expectations

- Run `npm run ai-gateway:test`, including chat-rendering tests for unfinished code fences,
  inline code and URL policy, attachment errors, and transcript association after replay.
- Code Block regression tests cover theme fallback, unfolding with offset line numbers,
  and stream-completion announcements across repeated streams in React Strict Mode.
- Action-card tests cover denial reasons, single/multiple/free-text answers, failure and
  retry, duplicate-submission prevention and resolved replay. Activity tests cover event
  boundaries and stable expansion as calls arrive. Context tests cover save state,
  conflict refresh, listener changes/unmount and avoiding accidental message submission.
  Input Group tests cover textarea focus with hidden file inputs, custom click handlers,
  cancellation and portaled content.
- Run `npm run ai-gateway:lint` and `npm run ai-gateway:build-web`.
- Check live streaming follow/pause/jump and switching sessions; code streaming must also
  respect manual transcript scrolling. Verify tool JSON, command copy, wrapping and expansion.
- Check local image preview/removal, upload failure and retry without duplicate uploads,
  stored-name association, light/dark themes, and a 360 px panel without page overflow.
- Use browser API fixtures for deterministic failure/streaming cases and a Core-managed,
  authenticated app for runtime smoke checks. Shell embedding requires its own authenticated
  integration check; standalone rendering alone does not establish it.

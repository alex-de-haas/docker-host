---
created: 2026-11-09
updated: 2026-11-12
summary: Harness persists ordered messages, immutable attachments and edit reservations while keeping the composer available during background delivery.
components: [apps/harness]
---

# Harness Message Queue

Harness owns an ordered queue for each ordinary conversation. Send moves the submitted snapshot
into a stack above the composer; another message can be composed and queued while the agent works.
The queue uses the existing conversation store, session mutation lock and authenticated event
stream. It does not create a Core queue, Task or general background job.

## Composer And Queue Rows

The bounded stack shows each message as one compact row with a single-line, ellipsized text preview.
Attachments appear as a paperclip and count; their names are available on hover and to screen readers.
Edit and Delete appear on row hover or keyboard focus, and remain visible on devices without hover.
A handle at the left reorders eligible rows by mouse or touch drag, or by the Up and Down arrow keys.
Reordering preserves every queue identity and cannot cross a sending, unknown or editing row.
Escape, pointer cancellation and queue changes cancel an in-progress drag. Retry, edit recovery,
sending status and error details remain available inline. Narrow queues use recovery icons with
accessible labels and share remaining width between the message preview and its truncated status.
Current agent settings apply to waiting
messages without repeating that information on each row. Send and Stop remain
separate actions. Successful completion advances the head in order; an approval or question holds
the active turn. Stop and execution failure pause the queue, and Resume queue is explicit.

Before server acceptance, a local row distinguishes saving/uploading from delivery to the agent.
The browser stages submitted text and file blobs in IndexedDB before clearing their composer
snapshot. Its sequence and serialized uploader preserve submission order when an earlier message
contains slower uploads. Draft changes are tracked per conversation: switching away, typing in
another conversation and returning does not leave an unchanged submitted draft available to send
again. An intentional edit in the original conversation preserves its newer draft, including when
the replacement text matches the submitted text. When browser storage is unavailable, the composer
retains the submitted draft until the server accepts it.

A local failure exposes Recover draft only before an enqueue attempt or after a known rejection
that proves non-admission. Recovery moves the original text, attachment references and file blobs
into Saved drafts and removes the local row in one IndexedDB transaction, allowing later messages
to continue without replacing the current composer. A full Saved drafts allowance or failed storage
transaction preserves the local row. Once enqueue was attempted, unknown replies, authentication
failures, conflicting identities and corrupt queue evidence retain their original Retry path.

Server rows distinguish queued, editing, sending, failed and unknown outcomes. Sending and unknown
rows remain locked against editing, deletion and reordering. Retry reconciles an uncertain attempt;
only confirmed non-admission makes editing or a distinct corrected send safe. A user-message event
can appear during admission before its final receipt. The UI correlates that event and its queue row
by send UUID without treating transcript presence as acceptance.

The browser's old single-send localStorage journal remains recoverable as a previous-send row. Its
original receipt is checked before the draft can become a new queued message. Accepted or uncertain
legacy requests are not converted into replacement sends.

## Editing And Recovery

Edit reserves a row with a durable reservation identity, generation and view identity before
restoring its text and attachments to the composer. The current draft is stashed separately. Save
preserves queue position; Cancel retains the original queued content. An editing head blocks later
rows from passing it.

The browser retains edit buffers and pending file blobs in IndexedDB by conversation, entry and
reservation; server edit updates retain text and already-stored attachment references. Independent
edits of different rows keep separate buffers and stashed files, including across reloads. The
previous single-record browser format migrates atomically without dropping its bytes. Recover edit
explicitly transfers the reservation to another view and fences stale saves. Restoration prefers
the exact reservation or that view's pending buffer; an older writer cannot replace or clear a
newer reservation. A timeout does not silently release an editing row for dispatch. Stashed server
attachments retain durable references after Save or Cancel, so restoring the draft does not depend
on an agent's mutable workspace copy.

If another tab changes the ordinary draft during editing, Save or Cancel retains that newer draft
and preserves the stashed one separately in browser storage. Saved drafts exposes explicit restore;
restoring one first preserves the current draft. A concurrent change during restoration keeps the
latest shared content and leaves the saved draft available. A live edit takeover freezes the stale
editor and preserves its local buffer before returning to ordinary composition. Saved drafts share
the installation/owner/conversation boundary and refuse beyond 100 records without eviction.

Browser state is scoped by origin, Harness installation, authenticated owner and conversation.
Owner checks precede restoration or upload. Web Locks and cross-tab change signals coordinate
same-origin views; stable identities and server receipts also prevent competing uploaders from
recreating an acknowledged message when Web Locks are unavailable.

For durably staged rows, each actual enqueue HTTP call also registers a distinct local
transport-attempt UUID before it starts. This journal is separate from the stable server command
UUID and survives stale outbox writes. A definitive rejection settles only its own transport
attempt; another unknown call keeps recovery blocked, even when both calls use the same server
command. Recovery and registration serialize through the same IndexedDB stores, so a competing
uploader cannot send a locally recovered row.

## API And Identities

Owner-authenticated routes beneath `/api/sessions/{id}` expose:

| Route | Behavior |
| --- | --- |
| `GET /message-queue` | Current queue snapshot, revision, owner and installation identity. |
| `POST /message-queue/commands` | Enqueue, reserve/update/save/cancel/recover edit, reorder, delete, pause/resume or retry. |
| `PUT /message-queue/uploads/{uploadId}?name=...` | Raw file bytes under a stable upload UUID; exact retries preserve the stored name. |
| `GET /message-queue/attachments/{attachmentId}` | Authorized download of a retained immutable queue attachment. |

Commands carry `requestId`, `expectedRevision` and a typed `command`. Durable mutation receipts are
checked before revision checks: retrying an uncertain command with its exact original input returns
its original operation result alongside the current queue. Changed input under the UUID conflicts;
stale new mutations receive `queue_revision_conflict`. Retired entry identities remain tombstoned
through conversation retention, so another request UUID cannot enqueue the same entry twice.

Snapshots contain at most 100 pending entries. A message accepts text up to 60,000 UTF-8 bytes and
the existing attachment limits. Capacity overflow is refused without evicting accepted work.
`session_message_queue` events publish renderable snapshots through the existing SSE transport;
subscription replay ends with authoritative queue and session state. Queue revisions do not replace
the transcript's resume cursor.

## Dispatch, Authority And Restart

Dispatch claims only the eligible head after prior execution cleanup. It freezes message content,
attachment paths, settings/context revisions, a settings binding, payload fingerprint and a separate
`clientRequestId` before calling `postMessage`. Provider/account, runtime, autonomy, profile, skills
or workspace changes after the claim cannot redirect that attempt. The legacy immediate-send
endpoint cannot overtake accepted queue entries.
Validated replies to an already parked native question or task Decision continue that same turn
before this queue gate. Their existing owner, question and replay checks still apply; a paused
follow-up queue remains paused while the active question is answered.

`postMessage` remains the provider-admission primitive. It persists unknown admission before
publishing the message or dispatching the provider, and acceptance afterwards. Recovery follows
that existing evidence:

| Receipt | Result |
| --- | --- |
| Accepted | Retire the matching row once; retain the ordinary conversation message. |
| Unknown or unreadable | Keep the row locked and pause advancement. |
| Absent | Submit only the exact retained claim after eligibility and authority checks. |
| Rejected | Show the reason; explicit corrected retry creates a distinct send identity. |

Every automatic dispatch revalidates the current operator through Core and respects workspace
admission. Task-owned attempts and unresolved handoffs reject ordinary queues. Finalized handoff
drafts can be edited and queued; enqueue acceptance clears the consumed handoff draft atomically.
Closed workspaces reject enqueue/resume/retry. Existing worker and native-stop evidence remains
required; an idle record after coordinator replacement does not prove that an old native run exited.

Closing the tab does not stop server-accepted delivery. Queue state and files survive a Harness
restart, while runtime credentials remain outside durable storage. A missing or revoked identity
holds the queue for sign-in; authenticated refresh reaches retained queues even if their
conversations are not already loaded. This uses interactive authority and does not consume a
[background grant](../continuous-app-access/feature.md#explicit-background-delegation).

## Attachments And Retention

Queue uploads and promoted legacy files are immutable snapshots under the conversation's app-data
directory. Hash and size verification precede acknowledgement or materialization. Unique temporary
files and atomic rename prevent a partial write from becoming a completed blob. An altered or
missing snapshot blocks delivery instead of omitting the attachment.

The durable store enforces 25 MiB per file, 20 retained attachment identities and 100 MiB of content.
Unclaimed uploads, active queue/edit references and restored-draft pins retain their bytes. Restored
draft pins accumulate through conversation retention because other views can retain those aliases;
they still count toward the file/content allowances and have no separate release command. Deleting
or accepting the last queue-only reference releases its blob; upload UUID receipts remain as
identity evidence. An exact reopened upload re-pins its original bytes. Execution copies use stable
stored paths and the ordinary workspace count/byte limits, so repeated attempts do not multiply
cache copies. Display names remain separate from internal identities.

App backups include retained queue metadata, pending/edit/draft snapshots and immutable bytes
referenced by admitted source messages. Native execution copies retain their cache lifecycle;
their loss does not remove the admitted attachment identity. Accepted source attachments retain
their blobs after a queue row is retired. See
[Harness history durability](../harness-history-durability/feature.md) and
[Assistant Attachments](../assistant-attachments/feature.md).

Any queue entry, including paused, editing, failed or unknown work, protects the conversation from
automatic expiry. Explicit conversation deletion removes its queue, upload receipts and snapshots
through the normal lifecycle. See [Harness Session Retention](../harness-session-retention/feature.md).

## Verification Evidence

On 2026-11-09 the complete Harness suite passes 2,817 tests across 238 files on macOS Arm64,
with backend/web lint and TypeScript checks, SDK tests/build, production web/local bundles and
the sessions and worker integration suites. The real Chromium IndexedDB fixture covers separate
edit reservations, retained file blobs, atomic rejected-head recovery and independent transport
attempts without assuming Web Locks.

The opt-in `HOSTY_QUEUE_BROWSER=1 npm run test:integration -- harness-local` passes through normal
Core password login and app PKCE in a parent-managed child. It verifies paused FIFO order, continued
typing during upload, exact server attachment bytes, edit/reload/recover/Save/Cancel, stashed files,
reorder/delete, independent edits from two tabs and the 360 px dark layout. Three actual Worker
requests complete in order after the last browser page closes. Its owned deterministic Ollama HTTP
fixture calls no external model. Paused queue entries and their exact attachment bytes survive
both warm restart and missing-output recovery. The production runtime passes cold start, and
the parent verifies Finish and child resource removal.

## Testing Expectations

- Verify single-line rows for long multiline text at desktop and 360 px widths, attachment counts,
  hover/focus actions and touch visibility. Exercise pointer and keyboard reorder, locked-row
  barriers, cancellation and concurrent queue changes without losing full reorder identities.
- Exercise owner and same-origin guards, capacity refusal, command replay, revision races and
  retired-entry tombstones, including competing clients without browser locks.
- Inject interruption around frozen claims, receipt persistence, provider dispatch and acceptance.
  Unknown or unreadable evidence never authorizes another execution; settings changes do not
  replace frozen inputs, and missing native-stop evidence blocks overlap.
- Cover stable upload replay, immutable-byte verification, workspace-file modification, queue-only
  collection, restored draft pins, duplicate-byte identity limits and cache-path reuse.
- Cover edit reservation recovery, stale saves, cancellation, original position and restoration of
  both the queued message and pre-existing draft with attachments. Edit different entries in
  separate views, reload both buffers and migrate the legacy single-record format without losing
  stashed or edited file blobs.
- Verify IndexedDB ordering, reload during uploads/editing, account changes, unavailable storage,
  late acknowledgements, legacy send recovery and accessible Send/Stop/stack controls. Include an
  A-to-B-to-A switch while A stages, intentional identical-text replacements and B's retained draft.
- Exercise atomic local rejection recovery into Saved drafts, byte preservation, full-capacity
  rollback and advancement past the recovered head. Unknown or unsafe rejection evidence does not
  authorize recovery. Distinct transport attempts sharing a server command remain fenced when one
  rejection arrives while another call is unknown, including without browser locks.
- Run affected Harness tests and type checks, production web/local builds and the sessions,
  worker and Harness Local integration suites. Keep deterministic fixture results distinct from
  Core-managed browser/login/runtime evidence. `HOSTY_QUEUE_PLAYWRIGHT_MODULE` selects an installed
  Playwright module and `HOSTY_QUEUE_BROWSER_CHANNEL` selects an installed Chromium channel.

---
status: In Progress
created: 2026-11-07
updated: 2026-11-09
summary: A durable Harness conversation queue with editable ordered messages, recoverable sending and an immediately available composer.
components: [apps/harness]
---

# Harness Message Queue

## Goal And Approval

The owner requested a message stack above the composer, editing with restored attachments,
reordering, persistence across conversations and closed tabs, and an inline sending/Retry state
instead of the blocking composer and warning banner. The owner approved development on 2026-11-09
after reviewing this plan; there are no remaining design questions blocking implementation.

Related requested changes have their own scope in
[suggestion history](../assistant-prompt-suggestions/plan.md) and
[longer speech recordings](../long-speech-recordings/plan.md).

## Observed Baseline

Harness already owns conversation persistence, background execution, per-session serialization,
authenticated SSE, and UUID-keyed message receipts. `postMessage` stores an uncertain receipt
before provider dispatch and an accepted receipt afterwards. The browser retains one pending send
per conversation in localStorage. It blocks the composer and cannot schedule several messages.
There is no durable user-message queue.

Attachment bytes currently belong to the session cache/workspace rather than backed-up session
data. Session expiry does not know about pending queue entries. A queue implementation must address
both facts rather than persisting only text and names.

## Target Interaction

- Every Send creates a row immediately above the input. An idle conversation starts its first row;
  additional sends during a response join the same ordered queue. They do not interrupt the agent.
- The composer becomes available as soon as its submitted snapshot is durably staged locally or
  accepted by Harness. Upload, queue acceptance and provider admission remain distinct states.
  A late acknowledgement must never clear the next draft or its attachments.
- Waiting rows show text, attachment previews, Edit, Delete and accessible Move up/Move down controls.
  The queue is bounded and scrollable so a long stack does not consume the whole conversation pane.
- Edit atomically reserves the row before restoring text, literal/serialized app mentions and
  attachments into the composer. Save preserves its position; Cancel restores the original row.
  Preserve any existing unsent draft separately and restore it after editing. Persist the editing
  snapshot so reload does not lose either draft. An editing head blocks later rows from passing it.
- A sending row shows a neutral progress indicator and no edit/delete/reorder actions. Existing
  admission can publish its user message before the accepted receipt; correlate both representations
  by send UUID and avoid duplicate content. Retire the row only on confirmed admission, preserving
  its inline retry state if the outcome remains unknown. Queuing alone creates no transcript message.
- Failure stays on its own row with Retry. An uncertain send remains locked while Retry reconciles
  its original receipt. Return to editing or removal is available only after confirmed non-admission.
- Send continues to enqueue while a response runs; Stop remains a separate, clearly accessible
  action. Stop and execution failure pause queue advancement. Resume queue is explicit. Waiting for
  an approval/question never consumes another message. Successful completion advances in order.

## Harness Contract And Persistence

Keep the queue inside Harness, using its existing session authority, storage and events. No Core
queue API, Task, general job scheduler or new credential store is required.

Use a versioned queue record in durable conversation data, with a monotonic revision, owner,
ordered stable entry IDs, pause reason and idempotent mutation receipts. Entries retain text,
attachment identities/metadata, creation time and state. Initial bounds are 100 pending entries,
the existing per-message/attachment limits and explicit refusal before accepting beyond capacity.
Never evict accepted entries to enforce a limit.

Add authenticated owner-only queue read and command routes beneath `/api/sessions/{id}` for
enqueue, reserve/save/cancel edit, reorder, delete, pause/resume and retry. Mutations use a fresh
UUID request ID and expected revision. Identical retries return the original result; changed input
under that ID conflicts. Serialize all mutations and dispatch claims through the existing session
serializer. Publish queue revisions through existing SSE, with an authoritative snapshot after
reconnect, cross-tab conflict or missed events.

Give edit reservations a durable identity/generation. Atomically retain the edit buffer and stashed
draft with its owner/view identity. Expose explicit recover/cancel editing after the original tab
disappears; a timeout never silently releases an editing message for automatic sending. Other views
cannot overwrite its snapshots through a stale save.

Queued messages use the conversation's confirmed model and app context when dispatch begins.
Show in the queue that agent settings apply to pending messages. Explicit app mention references
and attachments remain part of each message. Atomically freeze the selected settings/context
revisions, payload fingerprint and a separate `clientRequestId` when claiming the head for sending.
Subsequent changes cannot alter that in-flight attempt; admission conflicts pause it for review.
The stable queue entry ID is not reused as a mutable-payload send identity.

Keep `postMessage` as the single provider-admission primitive. The legacy immediate-send endpoint
must not overtake accepted queue entries. Queue routes reject task-owned immutable attempts,
unresolved handoffs and closed workspaces under existing rules.

### Dispatch And Recovery

Wake dispatch after enqueue, successful execution cleanup, restored authority and startup
reconciliation. Schedule outside a currently held session serializer to avoid recursive waits.
Only one head may be claimed. Dispatch requires an idle conversation, confirmed prior native exit,
released execution/source ownership, current provider capacity and valid user/workspace authority.
Actively revalidate that authority before every automatic dispatch; a non-null cached credential is
not proof of current access. Authenticated refresh must reach all retained queued conversations for
that owner, including sessions not yet loaded into the in-memory live collection.
Optional prediction collection can end through its existing foreground-preemption path, but
`answer_complete` alone is not permission to overlap native runs.

Persist the frozen claim before dispatch. After interruption, reconcile its existing message receipt:

| Observation | Queue recovery |
| --- | --- |
| Accepted | Correlate the ordinary transcript event and retire the row once. |
| Outcome unknown | Retain the locked row and block advancement; inspect the same attempt. |
| No admission receipt | Reconcile and submit only the exact retained attempt identity/payload. |
| Definitively rejected | Show the reason; an explicit corrected retry may create a new send identity. |

Do not automatically replay uncertain provider effects. Startup does not manufacture completion or
native-stop evidence. A transcript event alone does not settle an unknown receipt. Pending queue
entries, editing snapshots and unresolved sends protect the
conversation from automatic retention; explicit deletion follows normal lifecycle authorization.

### Attachments And The Browser Acceptance Window

Persist queue-owned attachment bytes in app data before acknowledging enqueue, with stable file
identities and an atomic metadata/attachment-reference boundary. Store immutable copies, not
hardlinks or references to files an active agent can edit in the session workspace. At dispatch,
verify/materialize the exact snapshot under safe unique stored names for normal message admission.
Protect references while queued,
editing, sending or unresolved. Missing bytes produce an explicit blocked row, never a send without
the requested attachment. Preserve ordinary sent-message attachment behavior and document backup
coverage and release of queue-only references.

Use a bounded browser outbox to stage submitted text, metadata and pending file blobs in IndexedDB
before clearing the composer. Upload retries reconcile stable attachment identities rather than
creating duplicate filenames after a lost reply. Retire local staging only after server acceptance.
Reload restores incomplete transfers and checks the original enqueue operation before replaying it.
Preserve staged submission order with a durable per-conversation sequence and serialized enqueue
reconciliation: a second text-only message cannot overtake the first message's pending upload.
Scope browser staging and recovery locks by installation, user and conversation; verify the
authenticated owner before displaying, uploading or replaying staged content after an account switch.
When browser storage is unavailable, retain the submitted draft until server acceptance; show an
honest saving/uploading state and never claim unsent bytes are already safe on the server.

The existing one-request localStorage journal needs an explicit migration/recovery path. Resolve a
retained legacy send through its original receipt before permitting it to become another queued
message. Migration must not duplicate an already admitted turn.

## Background Authority Boundary

After Harness acknowledges enqueue, closing the tab or switching conversations does not stop
dispatch. The current process can use its existing valid actor authority. Queue data and files
survive a Harness restart, but runtime credentials are deliberately not persisted; if authority
cannot be restored, show Needs sign-in and resume only after authenticated refresh and revalidation.
Expiry, revocation, unavailable providers and closed workspaces preserve the queue and show why it
is waiting. They never grant additional access.

[Continuous App Access](../continuous-app-access/feature.md) already defines separately granted
background authority. Fully unattended continuation after restart/logout belongs to explicit
consumption of that authority and the broader [Durable Agent Jobs Draft](../durable-agent-jobs/plan.md).
This conversation queue neither depends on that runner nor claims to implement its deliverables.

## Deliverables

- [x] D1. Implement bounded durable queue commands, revision/UUID conflict handling, attachment ownership and the legacy-send migration, with persistence and concurrency tests.
- [x] D2. Integrate ordered background dispatch with existing message receipts, authorization refresh, confirmed execution cleanup, Stop/error pauses, retention protection and restart reconciliation.
- [x] D3. Implement the shared composer stack, browser staging, attachment-aware editing, reorder/delete, independent Send/Stop and per-row sending/retry states without losing new drafts.
- [ ] D4. Verify the complete workflow in a Core-managed child, update affected feature documentation and version Harness for the new functionality, then remove this completed plan and regenerate the index.

## Verification And Completion

Unit/API tests cover owner and same-origin checks, queue bounds, UUID replay, revision conflicts,
concurrent clients, edit/claim and reorder/dispatch races, cancelled editing, missing attachments,
lost-tab edit recovery, workspace-file modification while queued, retention protection and legacy
pending-send recovery. Inject interruption before/after claim,
receipt creation, provider acceptance and transcript acknowledgement; assert one admitted turn.

Browser tests cover immediate first-row feedback, continued typing during slow upload/admission,
several queued sends with different upload durations, account switching, file restoration, stashed
drafts, reload during editing/upload, lost enqueue
reply, storage failure, two tabs, 360 px layout and keyboard controls. Verify ordinary chat,
workspace and embedded surfaces. Closing the tab after acceptance must not stop the second message;
service restart must retain rows/files and show missing authority honestly. Stop/error/unknown states
must not advance the queue. Approval/question completion resumes only through normal run completion.

Run affected Harness tests, lint/type checks and production web/local builds, plus affected
integration suites for sessions, worker and Harness Local. Use separate child users/data and normal
Core password login and advertised preview URLs; synthetic provider fixtures establish deterministic
queue behavior without copying live credentials. Record the actual runtime/platform tested. Retain
the child for requested operator review and finish it through Core when the agreed workflow ends.

Update the current-reality docs for chat UI, composer controls, attachments and retention only after
their behavior is verified. Harness versions this implementation independently. Commits, publication,
merging and live runtime activation remain separate authorized actions.

## Verified Implementation Evidence

On 2026-11-09, the affected backend queue/attachment/retention/receipt/handoff checks pass 123
tests, including immutable materialization, safe temporary files and finalized-handoff admission.
The queue hook passes its affected cases, composer regressions pass 14, and the migrated conversation/legacy
recovery suites pass 91. Actual Chromium IndexedDB checks cover ordering, file/edit reload,
installation/owner isolation, stale uploader protection and preserved-draft capacity without eviction.

Composer regressions include switching conversations during staging, newer shared drafts during
Save/Cancel/Restore, lost replies, takeover by another editor, and transcript/queue deduplication.
Backend/web lint and TypeScript, the production web build and the local production bundle pass.
Harness and worker versions are 0.96.0; repository version consistency passes.

The complete Harness run passes 2,796 tests across 238 files with `CODEX_HOME` excluded from the
test environment. The last queue/command-isolation changes then pass all 51 affected tests,
including late responses from another conversation and an unreadable post-dispatch receipt.
`npm run test:integration -- worker` passes the two native tests and pinned CLI controls in
network-isolated test containers on macOS Arm64. It verifies the worker layer independently;
it installs no app into the child and grants no preview authority.

D4 remains open. A separate child Core is prepared with independent password identity, but its
Harness installation is awaiting Core's ordinary permission review. No managed app preview,
microphone or end-to-end closed-tab/restart acceptance is established by the local fixtures.
The sessions and Harness Local integration checks remain required; a different child or
approval route must not replace the pending operator review.

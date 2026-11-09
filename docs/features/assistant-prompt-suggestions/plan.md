---
status: In Progress
created: 2026-11-07
updated: 2026-11-09
summary: Move native next-message suggestions into conversation history and retain the original suggestion with the operator's explicit choice.
components: [apps/harness]
---

# Suggestions In Conversation History

## Goal And Approval

The owner requested suggestions as a separate section in the conversation rather than inside the
prompt input, retained with the chosen action. The owner approved development on 2026-11-09.
[feature.md](feature.md) describes the implemented conversation-history behavior.
The related [message queue](../harness-message-queue/plan.md) owns queued delivery and composer edits.

## Target Behavior

Render the suggestion alongside its completed answer in the transcript, outside the composer.
Keep its original literal text and status across conversation switching, reload and Harness restart,
under normal conversation retention. A resolved card shows Selected for draft or Dismissed; expiry
and supersession are separate automatic statuses, never attributed as an operator choice. Selection
records the explicit choice, not proof of local insertion or message delivery.

Use suggestion inserts literal text into an editable draft and does not send it. A later explicit
Send follows normal message admission/queue behavior. Typing, attachments, dictation and queue
editing do not record Dismissed or erase the historical card. Disable draft insertion while another
draft/edit occupies the composer, without replacing that content. Explicit Dismiss remains available
when otherwise authorized. Turning off future suggestions preserves existing history.

Keep native provider collection optional, bounded and correlated with the successful answer.
Persist only an actual available suggestion, not empty/collecting protocol noise. Keep the existing
15-minute action deadline; expiry removes actions rather than deleting the card. Context changes
supersede an actionable suggestion. A pending prediction is still cancelled/preempted under current
execution ownership rules.

## Durable Contract

Persist append-only suggestion-created and suggestion-resolved events with a stable suggestion ID,
native attempt/answer correlation, exact text, timestamps, action deadline and context revisions.
Store an explicit choice as selected-for-draft/dismissed; automatic expired/superseded transitions remain distinct.
Recover unresolved deadlines on restart without generating another prediction.

Add an authenticated owner-only suggestion action route in Harness with UUID request identity and
expected suggestion revision. Replaying the same operation returns its result; competing choices
conflict. Use existing session serialization and event sequencing. No Core API is required.

Separate the hook's current generic interaction dismissal from explicit choices. Before selecting,
persist a local insertion intent and draft-generation guard, scoped to installation/user/conversation.
Record the server choice before applying insertion, so a competing Dismiss cannot win after text
was inserted. Reconcile a lost reply with the same action identity. On conflict, refresh the chosen
result without changing the local draft. After selection, insert only into the same empty draft
generation; a concurrent edit/clear must not be overwritten or resurrected. Show a recoverable local
insertion failure without falsely marking the message sent. Live insertion participates in normal
undo; reload restores draft text/intent, not the editor undo stack. A selected historical card alone
must never recreate a draft. Repeated intent recovery inserts at most once into its guarded draft.

Extend transcript reduction/rendering and the history projection/export using the existing history
extension contract with literal fallback text. A suggestion is neither an assistant answer nor a
new user turn. Keep it out of provider/model context until its text is explicitly sent as an ordinary
user message. Resolved history must not trigger new model execution or recreate a cleared draft.

Retain keyboard accessibility, literal plain-text insertion and undo. Tab acceptance applies only
to a current actionable suggestion and an empty focused textarea; Shift+Tab retains navigation.
Mention menus, foreground controls, IME composition and native focus behavior take precedence.
Remove misleading Tab hints when the shortcut cannot apply. Explicit card buttons work by keyboard.

## Deliverables

- [x] D1. Persist correlated suggestion history and idempotent explicit actions, with restart/expiry reconciliation, ownership checks and history/export projection.
- [x] D2. Move suggestion cards into the transcript, display retained choices, separate draft interactions from dismissal and implement recoverable draft-only acceptance alongside queue editing.
- [ ] D3. Complete managed-child browser acceptance and final candidate builds/integration checks, address regressions, then remove this completed plan and regenerate the documentation index.

## Verification

Test restart before/after choice persistence, lost action replies, competing tabs, stale context,
deadline expiry, preference disable, cancellation and duplicate/late provider output. Ensure a
resolved suggestion stays readable but never becomes actionable again after reload. Exercise
insertion refusal, changed/cleared draft generations and close/reload around local intent and server
acknowledgement. Selected records the choice; repeated recovery inserts no second copy or cleared text.

Browser checks use normal child Core password login and cover the card's position outside the
input, scroll anchoring, mobile/dark layouts, literal HTML/@ text, undo, mentions, Tab/Shift+Tab,
Escape and IME. Existing draft/attachments and a reserved queue edit must survive. Confirm history
export contains the card and choice while provider input and user-message count remain unchanged
until explicit Send. Existing native-provider limitations remain stated; fixture predictions do not
claim successful inference on an unsupported provider version.

Run affected Harness/provider/worker tests, lint/type checks and web/local builds. The implementation
updates the current-reality feature document and participates in the Harness functionality version.
Publication and live activation require their separate authorization.

## Verified Implementation Evidence

On 2026-11-09 the durable suggestion/history, local insertion, hook and transcript tests pass,
including exact UUID replay, expiry/context reconciliation, history export and explicit extension
sharing. The migrated conversation and legacy recovery UI suites pass all 91 tests. Backend/web
TypeScript checks and the affected frontend ESLint checks pass. Harness source versions are 0.96.0.

The browser script now exercises the durable transcript-card workflow with controlled events and
action receipts retained in browser-test process memory. Its syntax check passes; these fixtures do
not establish real child persistence or live provider inference. D3 remains unchecked until normal
child Core login and advertised preview/browser acceptance are verified. The final production
web/local candidate builds and full Harness lint/TypeScript checks pass; Core's test-installation
permission review is pending, so these builds do not establish managed-runtime acceptance.

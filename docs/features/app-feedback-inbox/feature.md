---
created: 2026-10-30
updated: 2026-10-30
summary: Core-owned annotated feedback with local SDK drafts, reviewed Harness chat delivery, exact-prompt outcomes and workspace-aware retention.
components: [apps/core, apps/harness, packages/app-sdk]
---

# App Feedback Inbox

Core stores submitted feedback and its evidence. The JavaScript SDK supplies capture inside an
application. Harness supplies the administrator Feedback page and the Feedback section in workspace
details. A report contains one or more ordered annotations and an optional overall comment. Several
complete reports can be sent together to one chat. Feedback and tasks are independent domains.

## Capture And Local Drafts

The SDK's authenticated `HostyUiRoot` exposes Annotate when Core supports feedback. Select element
highlights the hovered element and suppresses activation of the selected control. Select region
records a viewport rectangle; Page comment supplies a text fallback. The overview panel collapses
while picking so it does not block page controls, and moves away from a selected right-edge target. Element context contains a
bounded label, selector, rectangle and viewport, without input values or a DOM dump. Each annotation
records its route and capture time. Selectors remain contextual hints when the original page changes.

The [selected capture sketch](annotation-capture-concept.png) records the original interaction reference.
The comment editor opens beside the selected element or region. Done saves that annotation locally.
Edit in the side panel edits the same annotation, including its stable identity and evidence. The
panel lists related annotations, supports removal and an overall explanation, and submits the whole
report. Saving, editing, capturing and submitting feedback do not start an agent.

Screen capture uses `getDisplayMedia` with the browser-owned chooser and permission. The current
application tab is offered as a source. SDK capture chrome is hidden without changing page layout;
only a still image is retained, and media tracks stop after success, failure or cancellation. A modal
preview requires explicit inclusion and supports dragging a crop or entering crop percentages.
Manual cropping avoids assuming that a selected window, zoom level or embedded frame maps directly
to an element's viewport coordinates. Unsupported or denied capture retains text/element input.
Browser and webview support determines availability; no DOM rasterization fallback is used.

Dictation uses an already granted `providers.speech-to-text` capability and a discovered provider.
Multiple providers require an explicit choice. Recording is limited to one minute, stops microphone
tracks, converts audio to bounded WAV and appends returned text to the current comment. Cancellation
ignores late microphone grants and transcription replies. Without speech permission/provider/browser
support, typing remains available. Dictation does not submit the report.

IndexedDB stores the entire unsent draft, including image blobs. Keys include Core identity, app ID,
installation identity and user ID. Writes are serialized and revision-checked in one transaction;
an older tab cannot overwrite a newer committed draft. Saved locally appears only after transaction
commit. Storage failure preserves current in-memory text and displays Not saved locally; it does not
promise recovery of uncommitted edits. Browser storage clearing/eviction and cross-device or
cross-origin synchronization are outside this guarantee.

Submission freezes a request UUID and exact payload until Core confirms acceptance. A lost response
or reload exposes Retry submission with that same identity. The local record is removed only after
a confirmed receipt or explicit discard. Core independently rejects a draft submitted under another
account or installation. Ordinary reporters receive local save state and immediate submission
results, with no post-submission inbox, processing status or notifications.

## Core Contracts And Evidence

Own-app intake requires an authenticated app service and a currently authorized app-user grant.
The SDK UI server adapter exposes fixed same-origin routes; it does not proxy arbitrary Core URLs.
Intake needs app access without a feedback-management grant. Management additionally requires both
an enabled administrator and the app's reviewed `apps.feedback.manage` permission. Identity and
workspace access are revalidated on mutations. Core's own session API works independently of any
distribution app: administrator `GET /api/feedback` and authorized, CSRF-protected
`POST /api/apps/{appId}/feedback` provide collection/intake access.

Internal app routes are rooted at `/api/internal/apps/{appId}`:

| Route | Purpose |
| --- | --- |
| `GET /ui/feedback` | Capability version, limits and authenticated draft scope |
| `POST /ui/feedback` | Idempotent whole-report intake |
| `GET /ui/feedback/{id}/review-targets` | Administrator-only declared review destinations |
| `GET /feedback` | Administrator collection and attempt history |
| `GET /feedback/{id}/images/{noteId}` | Authorized retained evidence |
| `POST /feedback/{id}` | Revision-checked workspace/disposition update |
| `POST /feedback/dispatches` | Atomic reviewed-batch reservation |
| `POST /feedback/dispatches/{id}/delivery` | Exact message admission/terminal outcome |
| `POST /feedback/dispatches/{id}/outcomes` | Structured per-report handling result |

Reports allow 1–20 annotations, 2,000 characters per annotation and 5,000 overall. Each PNG/JPEG
image is bounded to 2 MiB, with 8 MiB total and a 12 MiB encoded intake request. Core validates
signatures, dimensions of submitted geometry, identifiers and bounded fields. Metadata lives under
`core/feedback/state.json`; separately owned evidence lives below `core/feedback/evidence`.
Atomic metadata writes and a shared process gate serialize revisions, receipts and cleanup.
Unreferenced evidence from interrupted intake is cleaned under that same gate on later intake.

At first acceptance Core snapshots the available app/install/version and active development context.
Unknown source revision/workspace fields remain null. An unreadable optional development journal
produces unknown execution context while preserving intake; available development source-head
metadata is retained without claiming an exact served build. This is a best-effort observation of current
Core state, not an exact attestation of bytes served to an old browser page. Replays retain the first
snapshot. App-supplied route/element context remains distinct from verified app identity.

A report has at most one current workspace binding. Its immutable observation can name a different,
subsequently removed origin workspace. Reassignment changes the current binding only and requires a
current revision and accessible destination. Pending or uncertain work blocks standalone reassignment.
No private chat or source authority is created by a feedback reference.

## Administrator Review And Chat Delivery

The global page filters by application, processing status and unassigned binding. Workspace details
show that workspace's reports. Administrators inspect complete annotations/images, mark reports
Dismissed or Duplicate, restore them and reassign eligible reports. Lists refresh on entry, explicit
Refresh, focus/visibility return and workspace chat activity changes. An open send review retains its
selected snapshots and instruction; explicit refresh actions re-review reports and chat availability.

Address all selects at most 50 unprocessed reports in the current workspace/global scope, excluding
pending, processed, partial, failed, cancelled, uncertain and dismissed/duplicate reports. Selected
reports are reviewed together with the exact count, destination and optional instruction. Workspace
review defaults to the displayed chat. Global review defaults to a new chat using the default agent;
normal source preparation establishes its development workspace. Existing workspace/chat selection
and a new chat in an existing workspace are supported. Cancellation starts no agent work.

After successful administrator capture, the SDK offers direct review links. Eligible clients declare
`ui.navigation[].feedbackReview: true` and hold `apps.feedback.manage`; Core resolves their declared
endpoint/path through its normal launch contract with a `feedback` query parameter. Harness opens
that report's send review. Core contains no Harness route or first-party app-ID selection rule.
Ordinary reporters receive no review destinations.

Busy or awaiting-input chats cannot accept a batch. The server repeats the check before message
admission; there is no queue or automatic retry. Known refusal retains the reviewed reports and
instruction. Unknown acceptance retains the frozen request UUID and payload for explicit retry.
Harness uses the ordinary durable message-admission receipt, so retry cannot create a second prompt.
New-chat creation and source preparation retain the same task/request context.

The accepted prompt carries complete report snapshots and app context, plus scoped tools
`feedback_current`, `feedback_image` and `feedback_result`. Tools operate only for the current
accepted feedback prompt and revalidate user/app authority. Images arrive as MCP image content,
without unmanaged copies. The agent explicitly reports a summary, handled flag and handled
annotation IDs for every selected report.

## Processing And Workspace Retention

A report is Processed only when its exact accepted prompt ends successfully and its structured
result explicitly handles the report and all annotations. An idle session, unrelated later prompt,
commit, PR or deployment does not qualify. Missing/partial outcomes remain Partial. Errors,
cancellation and unknown outcomes remain distinguishable; there is no Closed state.

Send again creates a deliberate new attempt using the existing comments/images and an additional
instruction. Previous outcomes remain in history. A refused attempt restores the previous report
state; an accepted partial/failed/uncertain follow-up replaces the current processing state. A late
result from an older attempt cannot override the current one. Automatic bulk selection never resends
processed reports. History links to the owning chat without bypassing its normal access checks.

Deleting a logical workspace removes its currently processed reports and owned images. All other
reports detach with their comments, evidence, immutable version/context and attempt history intact.
Deleting an origin workspace has no effect on a report already reassigned elsewhere. A durable
deletion fence prevents late intake/delivery from reattaching to a deleted workspace. Active attempts
whose actual destination is deleted are cancelled; late completion cannot process them. Minimal
intake tombstones prevent delayed retries from resurrecting removed reports. Retained batch history
redacts removed report snapshots and outcomes. Repeating interrupted deletion is safe.

Pausing/completing a workspace or deleting only a chat/worktree does not trigger this policy. Reports
without a workspace remain in the global inbox. Retention is independent of PR merges and releases.

## Testing Expectations

- Core store tests cover concurrent intake replay, payload conflicts, first observation, atomic
  reservation, actor/installation binding, structured outcomes, manual repeats, late completion,
  reassignment, deletion races/replay, orphan cleanup and evidence retention.
- Core HTTP tests use an independently named app and ordinary/admin identities, checking intake
  without management permission, denied reporter reads and declaration-based direct review.
- SDK tests cover fixed adapter routes, same-origin enforcement, payload limits, capture permission
  failure/late cancellation, microphone/transcription cancellation and shared iframe policies.
- Harness tests cover exact-message admission, lost replies, busy/foreign-chat refusal, scoped agent
  tools, unrelated terminal events, unprocessed-only bulk review and frozen UI retries.
- `npm run test:integration -- feedback` builds Core/CLI and uses the existing parent-managed child
  Core/native Harness and Shell acceptance path with separate password-authenticated accounts and synthetic
  agent credentials. It verifies batch handling, source preparation, screenshot tools, repeat partial
  outcomes, deletion retention and owner Finish cleanup.
- The browser journey uses Playwright Chromium (`HOSTY_FEEDBACK_BROWSER_CHANNEL` optionally selects
  installed Chrome; `HOSTY_FEEDBACK_PLAYWRIGHT_MODULE` can supply an absolute module path). It checks
  anchored/sidebar editing, real browser-approved capture, preview, multi-annotation reload,
  IndexedDB quota/stale-tab faults, draft scope isolation and lost-response retry. Test-only chooser
  flags select the isolated test tab; production capture still requires the browser chooser.
- Platform acceptance records browser/native runtime coverage explicitly; native webviews and other
  operating systems require their own acceptance and do not inherit a macOS Chrome result.

Local acceptance on macOS/Chrome, 2026-10-30: the managed child Core journey passed capture/crop,
selection without activating the underlying button, three-note reload, quota/stale-tab/account-scope
faults, lost-response replay, direct administrator review and Shell-embedded text fallback after
chooser cancellation. The included screenshot was inspected with capture chrome excluded. The
parent Finish operation confirmed removal of the child resources. Live operator data was not used.

The full Core suite passed 4,386 tests with five opt-in runtime suites skipped by their existing
conditions; all 11 focused feedback store/HTTP tests passed after the final metadata change. SDK
and Harness suites passed 711 and 1,897 tests respectively. SDK/Core/Harness builds, web/backend
type checks, documentation/link validation, version consistency and 15 launcher tests passed. The
web lint retains one unrelated existing warning in `tasks.tsx`. Other operating systems and native
webviews were not exercised in this acceptance.

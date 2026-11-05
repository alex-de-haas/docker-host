---
created: 2026-10-30
updated: 2026-11-05
summary: Core-owned annotated feedback with app-owned local drafts, reviewed Harness chat delivery, exact-prompt outcomes and workspace-aware retention.
components: [apps/core, apps/harness, apps/shell, apps/desktop, packages/app-sdk]
---

# App Feedback Inbox

Core stores submitted feedback and its evidence. The JavaScript SDK supplies capture inside an
application. Harness supplies the administrator Feedback page and the Feedback section in workspace
details. A report contains one or more ordered annotations and an optional overall comment. Several
complete reports can be sent together to one chat. Feedback and tasks are independent domains.

## Capture And Local Drafts

The [feedback composer tool](../feedback-composer-tools/feature.md) owns the form and one local
draft per Core/app/installation/account. Harness declares the first composer. It appears in the
ordinary tool catalog, supports Shell pinning and uses the same concurrent columns as other tools.
Desktop uses ordinary window panels and a menu-bar shortcut for its root workspace. Standalone
apps use the SDK tool system. Without a declared provider, the SDK does not render a feedback form.

The SDK retains source selection, bounded evidence, screen capture helpers and source-authenticated
intake. Hosts broker the `feedback.capture.v2` channel, bound to origin, actor, installation, window,
generation and nonce. Only a mounted declared composer may request source operations. Source
navigation, authentication loss and provider closure invalidate requests. Source apps need the
compatible SDK; older capture UIs are not silently treated as composer providers.

Select element highlights the hovered element and suppresses activation of the selected control.
Hover clears when the pointer leaves its document, enters another iframe or moves onto capture
controls; returning resumes selection. Leaving the document also abandons an unfinished region.
In Shell, selection includes its own chrome, the main embedded app and visible tool documents.
Desktop window capture is scoped to that window; its root workspace also permits Desktop feedback.
The selected document determines application identity. Provider identity never substitutes for it.
Each report belongs to one app; switching applications preserves their separate saved drafts.

Select region records a viewport rectangle; Page comment records page context without a rectangle.
Harness includes an automatic screenshot by default for either action; the user can turn it off.
The provider form stays visible during selection.
Selection adds an editable comment to that form; Save comment confirms local persistence without submitting the report.
Feedback's own form can be annotated, attributed to the provider app. Only the temporary Cancel
selection control is excluded. Element context includes a bounded label, selector, rectangle and
viewport, never input values or a DOM dump. Each annotation records its route and capture time.
Selectors are contextual hints when the original page changes. Reports support related annotations,
removal, optional screenshots and an overall explanation. These actions never start an agent.

Screen capture starts directly from the provider's selection button, preserving browser user
activation and the `getDisplayMedia` chooser. After the user chooses a screen, window or tab, the
SDK selects an element/region and holds its outline while Harness captures one complete frame.
Page comments capture the chosen surface without an outline. Capture stops after that frame,
on failure or cancellation, and after a two-minute selection timeout. Harness attaches the complete
image to the local annotation draft immediately after capture, without a second review/crop dialog.
An inline thumbnail and remove/retake controls remain available before explicit report submission.
Image byte limits still apply; a rejected image does not discard its comment or an earlier screenshot.

Harness uses whole-surface capture without automatic iframe cropping. The SDK also exposes the
lower-level browser `CropTarget` operation for other providers. No viewport-coordinate guess or
DOM rasterization substitutes for browser capture. Denied or unavailable capture leaves text
feedback usable. See [Feedback composer tools](../feedback-composer-tools/feature.md) for the form
and capture lifecycle.

Dictation uses an already granted `providers.speech-to-text` capability and a discovered provider.
Multiple providers require an explicit choice. Recording is limited to one minute, stops microphone
tracks, converts audio to bounded WAV and appends returned text to the current comment. Cancellation
ignores late microphone grants and transcription replies. Without speech permission/provider/browser
support, typing remains available. Dictation does not submit the report.

The composer application’s IndexedDB stores the entire unsent draft, including image blobs. Keys include Core identity, app ID,
installation identity and user ID. Writes are serialized and check both the saved request identity and revision in one transaction;
an older tab cannot overwrite or discard a newer committed draft. Saved locally appears only after transaction
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
`POST /api/apps/{appId}/feedback` provide collection/intake access. Administrator session routes
`POST /api/feedback/{id}/edit` and `/delete` require CSRF protection and work independently of
distribution applications.

Internal app routes are rooted at `/api/internal/apps/{appId}`:

| Route | Purpose |
| --- | --- |
| `GET /ui/feedback` | Capability version, limits and authenticated draft scope |
| `POST /ui/feedback` | Idempotent whole-report intake |
| `GET /ui/feedback/{id}/review-targets` | Administrator-only declared review destinations |
| `GET /feedback` | Administrator collection and attempt history |
| `GET /feedback/{id}/images/{noteId}` | Authorized retained evidence |
| `POST /feedback/{id}` | Revision-checked workspace/disposition update |
| `POST /feedback/{id}/edit` | Revision-checked comment/annotation text edit with a request UUID |
| `POST /feedback/{id}/delete` | Revision-checked permanent report/evidence deletion with a request UUID |
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
show all of that workspace's reports without filters; the section is hidden when the workspace has
no reports. Loading failures remain visible with a Refresh action. Clicking a report opens a popup
with complete annotations and screenshots, current workspace and processing history. These report
details are read-only. Attempts from other clients/installations remain read-only history; only this
client installation reconciles or subscribes to its own attempts. Lists refresh on entry, explicit
Refresh, focus/visibility return and workspace chat activity changes. An open send review retains its
selected snapshots and instruction; explicit refresh actions re-review reports and chat availability.

The global inbox groups its labelled filters, displayed report count, selection count and bulk
actions in one responsive toolbar. Its observation list shows summaries of up to two lines,
secondary application/version, annotation, workspace and date metadata, labelled processing-state
badges and the report menu. Empty results have a distinct empty state. Workspace details retain
their compact two-line list and direct delivery controls.

Feedback filters, destination workspace/chat and new-chat settings use the existing themed ReUI
Select controls. Menus support keyboard selection, bounded wrapping labels and dialog focus return.
Empty defaults and opaque values remain distinct. Removed current choices stay visibly unavailable
until explicitly replaced; disabling a control closes its menu and prevents changes. Refreshing
available destinations or agent choices preserves the reviewed instruction and draft selection.

Each report's actions menu offers Edit and Delete in both the global inbox and workspace section.
Historical Dismissed or Duplicate reports remain visible under All and in their workspace lists,
with their disposition label and the same Edit/Delete menu. The inbox retains their disposition
without exposing disposition or standalone reassignment controls.

Edit changes the overall comment and existing annotation text, retaining annotation order, screenshots, original
capture context and workspace binding. Save checks the revision captured when editing began;
background refresh preserves the draft. Editing returns the report to Unprocessed while retaining
earlier attempt snapshots and outcomes. Existing dismissal/duplicate disposition remains explicit.
Cancel leaves the report unchanged. Active or uncertain processing blocks editing and deletion.

Delete requires confirmation and permanently removes the report and owned evidence. Retained batch
snapshots/outcomes redact the deleted report; already sent chat messages remain in their chat.
Successful deletion also clears the open detail and selection. Both operations freeze a request UUID
and exact payload for an uncertain retry, with errors visible in the dialog. Revision conflicts require
reviewing the latest report. Minimal mutation receipts and intake tombstones prevent duplicate
mutations and delayed intake from restoring deleted content.

An older Core without the edit/delete routes returns an explicit unsupported-action message with
Core-update guidance when its route response is an unstructured 404 or 405. This remains a known
refusal, so Cancel stays available. Structured not-found, permission and revision errors retain
their original meaning; unsupported routes never count as successful deletion.

Workspace details use a muted section heading with a report count, an icon Refresh action and
compact send controls. Reports form a borderless two-line list: observation text, then application,
annotation count and disposition/status. The surrounding workspace is not repeated in each row.
Version and observation time remain in the row tooltip and full report details. Missing/busy chat
guidance is compact in the heading, with the full explanation available to assistive technology and
in its tooltip. Read errors, delivery notices and uncertain-delivery recovery remain visible.
The global Feedback page retains its filters and expanded report metadata.

Address all selects at most 50 unprocessed reports in the current workspace/global scope, excluding
pending, processed, partial, failed, cancelled, uncertain and dismissed/duplicate reports. Selected
reports in workspace details go directly to the currently selected chat, without a destination
review dialog or chat inventory lookup. Send selected uses the same direct route. A missing or busy
selected chat disables sending with an inline explanation; it never creates a different chat.
An uncertain delivery exposes an inline retry retaining the original destination
and exact request even if the selected chat changes. Successful HTTP responses with a reserved or
unknown delivery state retain that recovery path and do not announce a confirmed send.
Reserved attempts also expose Recover delivery in the main pending-delivery section after reload;
recovery reuses the original reviewed request.
The global inbox reviews selected reports
together with their count, destination and optional instruction, defaulting to a new chat using the default agent;
normal source preparation establishes its development workspace. Existing workspace/chat selection
and a new chat in an existing workspace are supported. Cancellation starts no agent work.

The chat selector includes existing owned chats in the selected workspace, using the same workspace
resolution as server admission: an explicit association takes precedence; otherwise exactly one
distinct workspace from active source bindings qualifies. Several worktrees in that workspace
still identify one destination. Released bindings and ambiguous source workspaces do not assign
a chat to a selected workspace. Busy chats remain visible with a busy label, while sending waits
for them to become idle. Refresh chats reloads both status and bindings; a chat that moved out of
the selected workspace cannot be sent another batch from that review.

Within the mounted global inbox, subsequent send reviews retain the chosen workspace and chat.
Each review refreshes destination availability. Administrators can send successive batches to the
same existing chat without creating a new one or changing its agent settings. Reloading the page
restores the normal new-chat default.

New-chat review offers an agent profile or custom provider connection, model, catalog-supported
reasoning effort and Normal/Autonomous mode. A profile retains its provider/model/reasoning bundle;
custom settings select these separately without changing saved defaults. Choosing Autonomous is
explicit and describes its approval behavior. Existing destinations use the chat's current agent,
reasoning and autonomy; feedback delivery never reconfigures them. Unavailable choices block new-chat
delivery and offer an explicit refresh. Changing models clears effort unsupported by the new model.
All choices remain draft-only until Send. The server validates and stores initial configuration
atomically with creation and includes it in the creation receipt, preserving the same configuration
and chat across uncertain retries. A selected profile includes its reviewed revision.
The review initializes compatible custom model/effort and autonomy from the authenticated user's
[remembered browser choices](../harness-composer-controls/feature.md#remembered-manual-choices).
An explicit choice in the review takes precedence, and cancellation writes no browser preferences.

The send dialog keeps its header and actions visible while its body scrolls. Destination and agent
fields have bounded widths and allow their grid columns to shrink, including long chat/workspace
names. Short and narrow viewports retain the same controls without horizontal dialog scrolling.

After successful administrator capture, the composer offers direct review links. Eligible clients declare
`ui.navigation[].feedbackReview: true` and hold `apps.feedback.manage`; Core resolves their declared
endpoint/path through its normal launch contract with a `feedback` query parameter. Harness opens
that report's send review. Core contains no Harness route or first-party app-ID selection rule.
Ordinary reporters receive no review destinations.

Busy or awaiting-input chats cannot accept a batch. The server repeats the check before message
admission; there is no queue or automatic retry. Known refusal retains the reviewed reports and
instruction. Unknown acceptance retains the frozen request UUID and payload for explicit retry.
Harness uses the ordinary durable message-admission receipt, so retry cannot create a second prompt.
New-chat creation and source preparation retain the same task/request context. Retries reuse the
persisted workspace attachment arguments, including the original participation revision. New chats
select only currently available apps within the chat context limit; every selected report retains
its historical app/version context even after uninstall. Retrying an existing creation request
preserves that chat's app selection.

The accepted prompt carries complete report snapshots and app context, plus scoped tools
`feedback_current`, `feedback_image` and `feedback_result`. Tools operate only for the current
accepted feedback prompt and revalidate user/app authority. Images arrive as MCP image content,
without unmanaged copies. The agent explicitly reports a summary, handled flag and handled
annotation IDs for every selected report.

### Feedback Cards In Chat History

Submitted feedback appears as a compact Feedback submitted card in the conversation. It shows
report, annotation and screenshot counts, with application/version labels and up to three short
observation summaries. Details expands the reviewed instruction, comments, annotations and routes
using the existing Markdown renderer. Original request separately reveals the exact stored agent
request as plain text. Both disclosures start collapsed. Cards count screenshots without loading
images; ordinary message attachments retain their existing association.

New feedback messages persist only a server-owned versioned reference to their dispatch. Their
provider prompt, stored text, admission receipt and feedback tools retain the same behavior.
The session-scoped transcript reader checks chat ownership and current feedback-management
authority, then projects reviewed Core snapshots belonging to the current actor, application and
installation. It never reconciles attempts or retrieves evidence just to render history.

Existing messages match through their request UUID and Core's exact admitted message sequence;
prompt prefixes and embedded JSON do not identify a card. Live references also allow rendering
before Core records the accepted sequence. The client loads cards with history, on new feedback
references and on visible window focus, without polling during streamed replies. Session changes
discard stale responses. Missing permission, redacted snapshots and read failures retain the
original message: a trusted reference shows an unavailable card with its original-request
disclosure, while an unmatched historical message uses ordinary Markdown.

After interruption, an ordinary continuation message does not restore that prompt's feedback
binding. All three tools return `feedback_prompt_unbound` with recovery guidance: open Feedback,
choose Needs review (or All), select the original report's checkbox and choose Send selected, then
review the destination workspace and chat. The tool descriptions include the same guidance. This starts a new
attempt with the retained report and screenshots; the interrupted attempt remains in history.

## Processing And Workspace Retention

A report is Processed only when its exact accepted prompt ends successfully and its structured
result explicitly handles the report and all annotations. An idle session, unrelated later prompt,
commit, PR or deployment does not qualify. Reconciliation after subscription attachment also covers terminal events returned in the replay.
Missing/partial outcomes remain Partial. Errors,
cancellation and unknown outcomes remain distinguishable; there is no Closed state.

Selecting a previously sent report and choosing Send selected creates a deliberate new attempt
using its existing comments/images and the reviewed instruction. Previous outcomes remain in history.
A refused attempt restores the previous report state; an accepted partial/failed/uncertain follow-up
replaces the current processing state. A late
result from an older attempt cannot override the current one. Automatic bulk selection never resends
processed reports. History links to the owning chat without bypassing its normal access checks.

Deleting a logical workspace removes every report currently bound to it and the reports' owned
images, regardless of processing state or disposition. Reports reassigned elsewhere and unrelated
unassigned reports remain. The original observation and earlier attempts do not determine ownership.
Active attempts are cancelled when their destination is deleted or their batch contains a removed
report. Other reports in such a batch retain their binding and become Cancelled when that attempt
is current. Late completion cannot process or reattach removed content.

A durable deletion fence turns late intake observed in that deleted workspace into a deleted receipt
without creating a report or evidence. Exact intake retries retain the tombstone even if their later
observation changes. Retained batch history redacts removed snapshots, outcomes and copied
instructions. Metadata commits before evidence cleanup; repeating interrupted deletion finishes
that cleanup safely.

Reports detached by earlier workspace-deletion behavior remain in the global inbox. Administrators
can select All and delete these individually through the ordinary confirmation. Deletion requires
the report revision and current feedback authority, without a surviving workspace or chat. Pending
and uncertain work retains its normal resolution guard; historical context alone never authorizes
automatic deletion of these legacy reports.

Pausing/completing a workspace or deleting only a chat/worktree does not trigger this policy. Reports
without a workspace remain in the global inbox. Retention is independent of PR merges and releases.

## Testing Expectations

- Core store tests cover concurrent intake replay, payload conflicts, first observation, atomic
  reservation, actor/installation binding, structured outcomes, manual repeats, late completion,
  reassignment, all-status workspace deletion, cross-workspace batch cancellation, late intake,
  deletion races/replay, manual removal of legacy remnants, orphan cleanup and evidence retention.
- Inbox edit/delete tests cover unchanged screenshots/context, annotation ID validation, stale
  revisions, active/uncertain refusal, exact mutation replay, processing history redaction,
  actions-menu access, read-only previews, dialog cancellation, preserved drafts and clearing deleted
  selections. Browser acceptance edits, reloads and deletes a real submitted report through the
  authenticated Harness inbox.
- Core HTTP tests use an independently named app and ordinary/admin identities, checking intake
  without management permission, denied reporter reads and declaration-based direct review.
- SDK tests cover fixed adapter routes, same-origin enforcement, payload limits, capture permission
  failure/late cancellation, browser-verified crop/fallback, microphone/transcription cancellation and shared iframe policies.
- Feedback coordination tests cover source identity, stale frame messages, visible-frame selection,
  Desktop workspace scoping, cancellation, retained hidden tool drafts and bounded payloads. Picker
  tests and browser acceptance cover hover handoff between the host and iframe documents, leaving
  capture controls, window blur and abandoning an unfinished region at a document boundary.
- Harness tests cover exact-message admission, lost replies, busy/foreign-chat refusal, scoped agent
  tools, interruption followed by an ordinary continuation and explicit resend, recovery guidance,
  user/app/installation changes, unrelated terminal events, unprocessed-only bulk review and frozen UI retries.
- Transcript-card tests cover unchanged provider text and receipt replay, ignored public metadata,
  owner/permission checks, current-installation scope, exact historical/live identity and redacted
  snapshots. Component and hook coverage checks compact summaries, Markdown disclosures, inert
  images, original text, attachments, session changes, focus recovery and failed/stale reads.
- New-chat tests cover atomic provider/model/effort/autonomy creation, selected profile revisions,
  unavailable catalogs, profile refresh/review, unsupported-effort reset, cancellation without writes,
  unchanged settings on existing chats and replay after provider/profile removal. Browser checks
  measure long destination names at desktop, narrow and short viewport sizes with fixed dialog actions.
- Feedback Select tests exercise real menu interactions, empty/opaque values, unavailable choices,
  disabled options, busy-state closure, nested-dialog Escape/focus return and combined filters with
  selections retained across views. Agent and delivery tests use the same actual Select controls.
- `npm run test:integration -- feedback` builds Core/CLI and uses the existing parent-managed child
  Core/native Harness and Shell acceptance path with separate password-authenticated accounts and synthetic
  agent credentials and explicit administrator review of assistant-to-Core MCP access in the child.
  It verifies batch handling, source preparation, screenshot tools, repeat partial
  outcomes, deletion retention and owner Finish cleanup.
- The browser journey uses Playwright Chromium (`HOSTY_FEEDBACK_BROWSER_CHANNEL` optionally selects
  installed Chrome; `HOSTY_FEEDBACK_PLAYWRIGHT_MODULE` can supply an absolute module path). It checks
  anchored/sidebar editing, real browser-approved capture, automatic full-image attachment, multi-annotation reload,
  current-comment save acknowledgement, IndexedDB quota/stale-tab faults, draft scope isolation and lost-response retry.
  Responsive navigation checks use a separate browser context so initial full-tab capture retains
  strict width and height verification before the capture page is resized. Test-only chooser
  flags select the isolated test tab; production capture still requires the browser chooser.
  `HOSTY_FEEDBACK_CAPTURE_WINDOW_HEIGHT` optionally sets the fixture's native Chromium window height
  before its first capture (960–4096 pixels). Headless installed Chrome can capture a different
  height from its emulated CSS viewport; calibrate this test-only value for the selected browser
  while retaining exact 1360×960 capture assertions. The macOS installed-Chrome probe uses 1103.
  `HOSTY_FEEDBACK_BROWSER_ONLY=1` selects intake/browser verification without scripted-agent dispatch.
  `HOSTY_FEEDBACK_DESKTOP=1` includes a separately installed Desktop. For script iteration,
  `HOSTY_FEEDBACK_RETRY_BROWSER=1` retains the same child after a browser failure until the printed
  retry/stop marker is created (twenty-minute limit). It does not bypass the eventual owner Finish.
- Platform acceptance records browser/native runtime coverage explicitly; native webviews and other
  operating systems require their own acceptance and do not inherit a macOS Chrome result.

Local acceptance on macOS/Chrome, 2026-10-30: the managed child Core journey passed capture/crop,
selection without activating the underlying button, three-note reload, quota/stale-tab/account-scope
faults, lost-response replay, direct administrator review and Shell-embedded text fallback after
chooser cancellation. The included screenshot was inspected with capture chrome excluded. The
parent Finish operation confirmed removal of the child resources. Live operator data was not used.

The full Core suite passed 4,386 tests with five opt-in runtime suites skipped by their existing
conditions before integration of concurrent main changes. After integration, all 32 focused feedback
and workspace deletion tests passed with a canonical macOS temporary path. SDK and Harness suites
passed 711 and 1,930 tests respectively. SDK/Core/Harness builds, web/backend type checks,
documentation/link validation, version consistency and 16 launcher tests passed. The
web lint retains one unrelated existing warning in `tasks.tsx`. Other operating systems and native
webviews were not exercised in this acceptance.

Contextual capture acceptance on macOS/Chrome, 2026-11-02: standalone capture, iframe cropping,
separate Shell/app drafts, two Harness surfaces sharing a draft, retained Pull requests selection,
Desktop window capture and Desktop's own docked feedback passed. The suite also passed stale-tab,
quota, replacement-request, reload and lost-response checks. A cold Desktop development route
required its normal Retry action; the authenticated session and subsequent window capture passed.
The child reported a 24.556-second cold Harness start, 2.040-second warm restart and 21.387-second
missing-output recovery. Parent Finish confirmed resource removal. The full agent-dispatch variant
stopped earlier in the existing scripted Codex provider with exit code 3; it is not claimed as passed.
SDK, Shell, Desktop and Harness unit suites passed 727, 803, 32 and 1,998 tests respectively.
SDK and all affected Next.js consumers built successfully; existing lint warnings remain unchanged.

The subsequent stale-hover regression passed in both directions between Shell and an actual
cross-origin iframe. The same managed browser run passed Desktop window and host capture after
retrying its cold development-route connection failure in the existing child. Its cold start, warm
restart and missing-output recovery took 27.125, 2.017 and 22.508 seconds respectively. Parent Finish
confirmed removal of the child resources, test processes, credentials, builds and snapshots.

The authorized ordinary-data trial on the same date has Shell, Harness and Desktop running from
the same registered workspace. Harness API/worker and Desktop web report healthy. The embedded
Chats page exposes its own feedback target through Shell's dock without a floating Annotate
launcher. Desktop's window launcher opens the Harness-scoped draft, while its menubar launcher
opens the Desktop target. The first Desktop entry required normal Retry actions while development
routes compiled; the authenticated desktop and both feedback panels then loaded successfully.
The Core release process is unchanged and the source changes remain uncommitted. The workspace
activity lease is retained while native workspace consumers are running.

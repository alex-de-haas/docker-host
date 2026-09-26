# App Feedback Inbox

Status: Draft
Created: 2026-09-26
Updated: 2026-09-26

Part of [shared assistant development sessions](../assistant-development-sessions/plan.md).
The umbrella's common invariants apply; this feature has independent scope and requires its own Ready approval.

## Target Behavior

Owner direction, 2026-09-25. Working name: **App feedback inbox**; final product naming is open.
Support bugs, broken interactions, confusing content, visual adjustments and improvement requests,
without forcing every observation into a bug category. The inbox lets people collect small items
before an administrator combines related work into one development session.

### Capture In App Context

Provide an entry point while using an app. A proposed capture mode lets the user select a component
or page region, add a comment, preview the captured evidence and submit. Capture may contain an
element highlight, a cropped screenshot or a page-level screenshot. The exact overlay, picker and
button placement require a capability/design spike; a report must remain possible with text and
app/page context when element selection or screenshot capture is unavailable, including an app error.

Record the trusted Hosty environment and app/install identity, reporter and timestamp, comment,
available page/route and app version/source observation, optional image and optional element locator,
label/bounds and viewport context. Separate verified app identity from app-supplied context. Keep
element information as reproduction evidence, not a guaranteed permanent selector or source-code
location. A moved/deleted element must not make the report unreadable. Preview the included context;
allow cropping/removal of evidence and avoid capturing credentials, hidden inputs or unrelated pages.
Do not require a full DOM dump or diagnostic-log collection for ordinary feedback.

### Submit Without Agent Access

Ordinary users can submit feedback for apps they are authorized to use. Submission creates an inbox
item only: no model turn, development session, source grant, worktree or privileged operation. The
reporter does not gain access to assistant conversations, repository paths or other users' reports.
This needs a narrow authenticated intake contract, not access to the administrator-only Gateway API
or the operator's delegated agent credential. Place intake and durable evidence in Core or a separate narrowly scoped app, outside the
administrator-only Harness process. Choose between those two placements before implementation;
the current admin-only assistant boundary remains intact.

Keep reports and evidence durable before any session exists. Define their storage, retention and
access independently of disposable session attachment caches. Later attachment to a session must
not leave a broken screenshot when another session is deleted. Comments, screenshots and app content
remain attributed input data, not trusted instructions or permission grants, even after admin review.

### Administrator Triage And Grouping

An administrator opens the inbox, filters by app/status, reads comments and inspects screenshots and
page/element context from different reporters. Support selection of several related entries, with
the ability to leave other entries pending, identify duplicates or dismiss an item with a reason.
Grouping is an explicit operator choice, not an automatic promise that unrelated requests form one
feature. Cross-app selection is valid when it belongs to the same change; repository grouping still
follows the session's one-worktree/normal-one-PR-per-repository rule.

**Send to assistant** prepares a reviewable batch for a new or existing non-completed session. Show
the selected item ids, their evidence, suggested app context and the administrator's combined request;
let the administrator edit that request and explicitly send it. This action may start the agent;
the earlier report submission and mere selection may not. Selecting feedback does not grant source
access: reuse the existing development preparation and approval flow. Preserve provenance for each
item instead of flattening all reports into an anonymous prompt.

An administrator may use the same capture surface to save items for later or send a reviewed item
directly to a chosen session, without a mandatory inbox round trip. Ordinary users receive the
submission path only. Exact direct-send UX is a design question, not approval to auto-run page text.

### Traceability And Partial Results

Store batch/session links and the item revision/evidence selected at dispatch. A later edit to a
report must not silently rewrite an already accepted agent request. Retrying a batch submission must
not create duplicate sessions or model turns; show existing links when an item is selected again.
Allow partial treatment within a batch: one item may be fixed, another need clarification and a
third be dismissed or deferred. Track outcomes per item and link the relevant session/PR result;
neither attaching the batch nor merging one PR automatically marks every report resolved.

Proposed states include new, under review, linked/in progress, addressed, dismissed and duplicate;
exact transitions and the distinction between code merged, verified and delivered to the reporting
user remain open. Exposing a minimal outcome to a reporter must not expose the private development
conversation. This is feedback intake and triage, not a general project-management product.

The session receives the reviewed batch through its normal history/context model and can expose it
to AHP clients with authorized attachment access. AHP is not the user feedback store or an automatic
authorization route from a regular app user to an agent. This feature requires independent approval and owns capture/intake and batch delivery; shared history
feature owns receiving the normal session input.

## Capture Feasibility And Reporter Updates

Shell embeds app UIs in cross-origin frames; Shell cannot directly read/render their DOM into a
screenshot. Spike cooperating in-app capture via `@hosty-sdk/app` and the embedder channel,
user-mediated display capture where supported, and native capture in Swift clients. None is a
universal DOM/image capture API; validate browser permissions/platform availability and keep the
text/context fallback. Native capture belongs in the relevant client scope rather than assuming
the first Harness Swift version embeds every app.

Reuse [Core notifications](../notifications/feature.md) for safe reporter receipt/outcome messages;
any reporter detail view still needs an authorized record endpoint. Do not expose private session
content through a status link. Administrator triage and batch dispatch require access to the
destination session under the shared-history visibility policy.

The feature name `app-feedback-inbox` is distinct from `shell-operation-feedback`, which describes
lifecycle operation UI. This inbox collects evidence and hands it to development sessions; it is
not project-manager's general task/project domain. A future project-manager integration may consume
reviewed reports without duplicating their storage or granting regular users free-form agent access.

## Deliverables

- [ ] Implement narrow authenticated intake and durable evidence in the selected Core/separate-app location.
- [ ] Validate and implement supported screenshot/element capture paths with text/context fallback.
- [ ] Implement administrator triage, reviewed batch and direct-send paths with idempotent session delivery.
- [ ] Implement per-item outcomes, authorized reporter notifications and evidence retention/access.

## Open Questions

- Where do feedback intake and its durable evidence live, and what narrow authorization permits ordinary
  users to submit without agent access? What can reporters see, and how do retention, attachment access,
  batch retry and per-item outcome transitions work?
- Which capture mechanism works for embedded apps, cross-origin frames, inaccessible DOM elements and
  broken pages? What SDK/host cooperation is needed, what is the fallback, and what are the final
  entry-point/inbox/direct-send UI and separate-feature boundaries?

## Verification

- A regular user submits a page/element observation with comment and screenshot; it survives
  reload before any session exists. Verify no agent turn, workspace or elevated permission is
  created, and that another user's reports and administrator session are inaccessible.

- An administrator selects several reports from different users/apps, inspects the exact batch,
  adds a combined request and explicitly sends to a new or existing session. Only selected items
  and their evidence arrive, app context is proposed and source grants remain explicit. Repeated
  delivery after a timeout does not duplicate the session or turn.

- An administrator can capture and send directly to a session. A failed capture/broken page supports
  text/context fallback; a stale selector keeps the screenshot/comment usable. Cancelling capture
  or batch review creates no submitted report or agent work.

- Update a report after dispatch, delete an unrelated session, and complete only some items in a
  batch. The accepted evidence remains attributable and available, pending items stay pending and
  the reporter's permitted outcome view does not leak private conversation or repository information.

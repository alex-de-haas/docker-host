---
status: In Progress
created: 2026-11-06
updated: 2026-11-06
summary: Combine Chats and Workspaces into Sessions, preserving workspace rows and showing standalone conversations alongside them with workspace sessions in the right-hand details.
components: [apps/harness]
---

# Sessions: Unified Chats And Workspaces

## Goal And Baseline

The operator requests one page and one list for ordinary conversations and development work,
preserving the existing Workspaces list appearance. The current
[navigation behavior](feature.md#navigation-and-conversation) exposes two pages backed by the
same conversation and navigation components: Chats lists every accessible conversation, including
attached chats, while Workspaces lists authorized workspaces. This makes the same work appear
in different forms in two places.

This plan changes Harness presentation and navigation. It reuses the existing workspace,
participation, conversation, event and lifecycle APIs. The operator confirmed the final section
name and grouping decisions in chat on 2026-11-06 and explicitly requested implementation.
Implementation is in progress in the registered workspace.

## Target Behavior

### One Mixed List

Show all currently listed, non-deleted workspaces and every accessible conversation that is not
already represented by one of those workspace rows. Interleave both kinds in a single ordering;
do not divide them into separate workspace/chat sections or replacement tabs.

A workspace occupies one row, including external workspaces and workspaces without an accessible
chat. Its attached, accessible conversations are represented by that workspace item in the left
list and remain selectable in the existing Sessions section in its right-hand details. Opening a
workspace restores the last accessible chat, falling back to its
most recent chat; an empty workspace stays empty until explicit session creation.

A standalone conversation occupies one row and opens that conversation directly. It has no
workspace details panel. If its associated workspace is absent, deleted or no longer accessible,
the accessible conversation remains reachable as an individual row. Do not hide a conversation
solely because it contains source preparation metadata or an association identifier.

Use the existing participation contract (`attached` and `canOpen`) to identify conversations
represented by a workspace, retaining the current legacy-owner fallback when participation is
absent. A workspace filtered out by the user's search/activity filter does not cause its chats
to reappear as individual rows. Successful attach/detach observations move the same conversation
between its workspace group and an individual row without changing its identity or draft.

### Preserve The Workspace Row Design

Keep workspace rows' typography, spacing, two-line structure, hover/selected states, hammer icon,
activity counts, source summary and pull request facts. Apply the same row structure to ordinary
sessions: a chat icon, title, activity indicator in the same position, and a muted second line
with the conversation's status and last activity. Idle sessions still have a useful second line.
Reuse the existing activity categories and accessible labels. A single chat uses a status
indicator rather than presenting an aggregate session count. It has no repository or PR facts.

Keep the existing session deletion confirmation and workspace lifecycle controls attached to
their respective resources. Rename remains in the conversation header. Keep desktop column
resizing, keyboard access and the retained narrow-screen list/details behavior.

### Workspace Row Deletion

The operator additionally requests a delete shortcut on each workspace row, matching the existing
session-row trash button. Put it in the same trailing position and reveal it on pointer hover or
keyboard focus; retain the existing always-reachable behavior on touch surfaces. Give it an
accessible name identifying the workspace. Respect the same workspace manage permission as the
existing Delete workspace action.

Clicking the shortcut opens the existing WorkspaceDelete dialog for that row's workspace, without
selecting the row, switching conversations or immediately deleting anything. Reuse its workspace
name, repository/file/unmerged-commit details, temporary-resource information, activity warnings,
Cancel/Delete actions, progress and same-request retry/recovery. Completed work with merged pull
requests is the operator's motivating example, not a new prerequisite for showing the shortcut.

The shortcut targets the workspace itself; do not bind the dialog's optional conversation-deletion
callback to an unrelated currently selected conversation. Existing explicit conversation deletion
remains separate. Keep the dialog mounted independently of the row so a refreshed inventory cannot
remove it before deletion progress/result is shown. Cancel preserves the current selection and
returns focus to the shortcut; after removal, focus moves to a surviving list control. Refresh the
inventory after deletion; retained accessible chats become individual rows under the mixed-list rule.

### Search, Activity And Actions

Reuse the common search and existing All, Needs attention, Working and Failed filters. Search a
workspace by its name, disclosed session titles and existing app context; a title match on an
accessible own chat opens that chat. Standalone search matches its title and existing app context. Counts
refer to list rows; one workspace can match several activity categories without duplicating rows.
Other users' disclosed activity keeps contributing to workspace counts without private links.

Preserve the current ordering semantics: latest substantive workspace/source/workflow activity,
own conversation activity and participant changes, with stable row-ID ordering on ties. Ordinary
sessions use their activity time with the current creation-time fallback. Heartbeats and source
observation timestamps do not move rows by themselves. Reuse existing event subscriptions and
recovery rather than adding a refresh loop for the combined view.

Offer New session, Create app and Continue building from the unified page using the existing
flows. New session creates an unattached conversation; the plus in Sessions creates an attached
conversation. Selecting a row sends no message and creates no resource. Preserve independent
loading/error states: an unavailable inventory is not evidence that all workspaces were removed.

### Navigation And Selection

Use Sessions as the single advertised navigation entry, retaining `/chats` as its route. Remove the
separate Workspaces entry from Harness's manifest so standalone, Shell and Desktop navigation
derive the same page. Keep `/development` working as an alias of the unified page with existing
session/workspace query parameters preserved; keep the compact `/assistant` panel's behavior.

Both full-page entry paths use one selection model. Explicit URL selections take precedence;
otherwise restore the shared saved selection, importing the old path's selection when no shared
selection exists. Remember workspace-only selections as well as conversations. Preserve Shell
surface reporting, Back/Forward, reload and existing workspace/diff deep links. Opening an
attached chat highlights its containing workspace row.

## Deliverables

- [x] D1. Replace the mutually exclusive list modes with one mixed row model, deduplicating only conversations represented by listed authorized non-deleted workspaces before search/activity filtering and preserving shared search, activity counts and stable ordering.
- [x] D2. Render ordinary conversations in the Workspaces row style, retain workspace rows and details, and expose the existing creation and resource-specific actions on the unified page.
- [x] D3. Advertise one navigation entry, retain compatible full-page URLs, and unify selection persistence and deep-link behavior across standalone and embedded Harness.
- [ ] D4. Verify the affected behavior, update current feature documentation and the workspace-session navigation description, apply the Harness version change, and remove this plan when all deliverables pass.
- [x] D5. Add a workspace-row trash shortcut matching the session-row hover/focus/touch behavior and opening the existing workspace deletion dialog for the correct target, with its warnings, recovery and explicit confirmation intact.

## Verification

- Extend the existing navigation/model tests for a mixed activity order; no duplicate attached
  chats; standalone and sessionless/external workspaces; unavailable/deleted workspace fallback;
  attach/detach transitions; legacy ownership; private participants; search and category counts.
- Verify stale/disconnected inventory and session refreshes preserve accessible conversations,
  existing source fences, drafts and pending approvals; do not interpret failed reads as deletion.
- Update existing full-page tests for ordinary/attached/empty selections, both historical entry
  paths, shared storage migration, Back/Forward, reload, Shell route reporting and deletion.
- Verify workspace-row deletion opens the existing dialog for that row without selecting it,
  issuing a delete request or deleting the active conversation. Cover manage permissions,
  hover/keyboard/touch reachability, Cancel/focus, pending-request recovery, retained result UI,
  completed/merged workspaces and retained accessible chats after workspace removal.
- Use an isolated Core-managed preview with synthetic workspace/chat data to inspect the
  preserved row design, idle/working/waiting/failed states, all existing creation entry points,
  keyboard focus, desktop resizing and narrow-screen navigation. Verify normal password login
  and Core/Shell preview URLs; no provider secrets or production data are needed for list QA.
- Run affected unit/component checks and the Harness web lint/type/build checks. Documentation
  preparation alone requires only the documentation/index validator and no runtime preview.

## Verification Progress

On 2026-11-06 the implementation before the final section-name update passes all 1,295 Harness
web tests in 114 files. After the operator's Sessions rename, all 129 affected component tests,
Harness API/web lint and type checks, the web production build, version consistency and the
documentation/index validator pass. Regression coverage includes independent compact-panel selection
and late startup restoration after a newer workspace/history choice. The source is Harness 0.95.0.

D4 remains open for browser acceptance. A separate current-version child Core is running with
normal password setup and a pending ordinary installation review for the registered source Harness.
The previous review expired; a fresh review uses the final Sessions manifest in the same child.
Core requires the operator's confirmation on its review page before that installation can run.
`apps/harness/test/work-browser.mjs` is prepared and syntax-checked; runtime/UI results are not yet
verified. Keep this child and its test identity for the pending review; no live runtime is switched.

## Confirmed Decisions

- On 2026-11-06 the operator chose Sessions as the common section name, replacing the earlier Work label.
- The operator confirmed that a workspace appears as one item on the left instead of its attached
  sessions. Selecting that workspace exposes its attached sessions in the right-hand workspace
  details. Only conversations not represented by an accessible workspace get individual list rows.
- These answers close the two remaining design questions and make this plan Ready.

The expected release is a Harness minor version (0.94.0 to 0.95.0 at this baseline), with manifest,
API/web package versions and the lockfile kept in step. Documentation-only preparation needs no version bump.
Commits, remote publication, merge and live runtime activation require their own authorization.

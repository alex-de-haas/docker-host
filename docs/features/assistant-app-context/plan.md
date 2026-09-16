# Assistant App Context

Status: Draft
Created: 2026-09-16
Updated: 2026-09-16

## Goal And Owner Direction

An administrator can associate any installed app, or several apps, with an assistant session. Context
belongs to the session and is visible and editable; it is not limited to apps created by the assistant.
A deleted conversation never prevents opening a new conversation about the same apps.

Owner, 2026-09-16, explicitly requests two entry points:

1. Inside chat, an app picker with checkboxes to select one or multiple apps.
2. In an app's Shell navigation/dashboard menu, an assistant action that opens a new session already
   associated with that app, available when the assistant is enabled and available.

This is a shared prerequisite of [prototype workspaces](../app-prototype-workspaces/plan.md), also
useful for diagnostics and ordinary operator conversations. The product direction is accepted;
these implementation details remain Draft pending review. One complete feature PR, followed by the
prototype feature PR, rather than duplicate binding implementations in both features.

## Context Versus Development Workspace

An app association means "this conversation is about these apps". It does not enable an MCP
provider, grant access to app data, change assignments, install dependencies, switch runtime, enable
Development Mode or grant filesystem writes. It is not a sandbox or a restriction on all other tools.
The operator's current role and existing tool permissions remain authoritative.

Docker-only, stopped and source-less apps can all be associated. A session with no associated apps
is still an ordinary host assistant session. Selection may include system apps for diagnostics;
selecting Core/gateway/Shell never authorizes self-modification or restart.

Keep these fields distinct:

- `appIds`: ordered unique app identities defining the conversation's current subject.
- `primaryWorkspaceAppId`: optional primary development cwd, resolved through Core by
  [assistant approval rules](../assistant-approval-rules/plan.md), never inferred from checkbox order.
- Development grants: separate per-app source-write and command permissions owned by that same
  feature, available for existing apps as well as newly created prototypes.

Several contextual apps may receive explicit development grants, creating several permitted source
roots. Selection alone grants none. The primary cwd remains distinct from that permission set.
A context-only session keeps its ordinary cwd. The permissions feature owns safe native-thread
reconfiguration, source binding and revocation; never silently rebind a running native thread.

## User Experience

### App Picker In The Assistant

Add an **Apps** button in the session header/composer area, visible for new and existing sessions.
It opens a searchable list of installed apps with checkboxes, title, id and runtime state. Include
apps independently of MCP provider enablement, source availability or running state. Use the current
administrator-visible app roster; do not use the MCP-provider list as a substitute.

An Apply action persists the selection; Cancel changes nothing. Display selected apps as removable
chips and keep the full list accessible for narrow panels. An empty selection means general context.
Proposed initial limit: 16 apps, with an explicit count/limit; never silently truncate the selection.
Do not send a message or invoke the model merely because the selection changed.

While a turn is active, edits are allowed for the next turn. Show "Applies to your next message";
the in-flight turn continues with its captured context. Closing/reopening the panel or reloading
Shell preserves the selection. Removing an app changes subsequent context, not past transcript text,
and the UI must not imply that earlier model knowledge has been erased.

When development permissions are available, expose the per-app controls and effective scope defined
by [assistant approval rules](../assistant-approval-rules/plan.md). Context removal must coordinate
revocation: quiesce affected execution before marking its permissions removed, even though ordinary
context additions apply next turn. Removing the primary app clears the development binding through
that shared mechanism. Re-adding it restores context only. This feature owns selection; the permissions
feature owns these controls and enforcement, so context can ship independently.

### New Session From An App

Use **New assistant session** in the app's Shell sidebar overflow menu and its Apps/dashboard card
or row actions, sharing one callback. The click always creates a new session with `appIds: [appId]`,
opens the existing assistant panel and selects that session. Keep the current app preview/page open.
The composer is empty and focused; no fabricated user message, automatic diagnosis or paid model
turn is submitted. The session header makes the associated app obvious.

Show the action only for administrators when a running gateway exposes assistant-session capability
and the assistant is enabled. A transient harness outage discovered after the menu was rendered
shows an actionable error; preserve current UI and do not fall back to an unbound session. The app
being discussed need not be running. Disable duplicate activation while the request is pending and
use a request id so a retried click request does not create two sessions; a later deliberate click
uses a new id and creates another session.

Keep existing app-originated `hosty:ask-assistant` draft behavior. It does not become a mechanism for
an embedded app to change durable associations or submit a message. These two new entry points are
explicit operator actions in Shell/assistant chrome.

### Deleted Sessions And Unavailable Apps

Deleting a session deletes its associations with that session only. Apps, source workspaces and other
sessions are untouched. The app menu or picker can start a fresh conversation at any time. Prototype
Continue building creates a new bound development session when its older chat no longer exists.

If an associated app is uninstalled, retain its id with an "Unavailable" chip; let the operator
remove it. Resolve current access on every use. Do not inject stale endpoint/source paths as active
facts. A roster fetch failure is "Context unavailable", not "No apps installed". Offer retry and an
explicit send-without-fresh-app-details path; never silently send as if context resolution succeeded.

## Persistence And API

Extend `SessionRecord` with `appIds?: string[]` and an `appContextRevision` counter. Existing sessions
read as an empty list; do not guess associations by parsing titles, prose or arbitrary legacy
`context`. Preserve legacy context as informational data. Resolve labels for display from Core;
optional last-seen display labels are cosmetic and never authority or instructions.

Proposed gateway contracts, behind existing admin authentication and cookie-origin checks:

| Route | Change |
| --- | --- |
| `GET /api/session-apps` | Bounded/paginated administrator-visible roster, with search, independent of provider toggles |
| `POST /api/sessions` | Optional `appIds` and `clientRequestId`; validate/deduplicate before creating the session |
| `PUT /api/sessions/{id}/apps` | Replace selection with `{ appIds, expectedRevision }`; reject concurrent stale writes |
| `GET /api/sessions` and `/{id}` | Return persisted app ids/revision and availability summaries for UI |
| `POST /api/sessions/{id}/messages` | Capture the committed context revision with the message; reject a stale submitted revision before dispatch |

Use Core's existing authenticated app-discovery/read mechanisms server-side and the acting admin's
permissions. Do not expose a new unauthenticated fleet roster or grant the gateway broader internal
access just to populate a picker. If existing discovery lacks a required field, add only that field
through the established contract and test its authorization.

New selections reject unknown/unauthorized ids and excessive counts; existing now-unavailable ids
can remain visibly unresolved until removed. Canonicalize using Core identities, preserve explicit
selection order and deduplicate. Do not accept caller-supplied app descriptions, paths or endpoint
URLs as resolved context. Never persist delegated bearer tokens with associations.

Creation request ids are actor-scoped; the same id and payload return the existing session, a changed
payload conflicts. Record selection changes as session events and notify all attached clients over
the existing stream. Revision conflicts must not overwrite another tab's selection. Update selection
and message acceptance under the session's serialized state handling so a turn observes one version.

## Context Delivered To The Harness

At message acceptance, capture selected ids/revision and resolve a bounded fresh snapshot from Core:
app id, display name, description, version, selected runtime, runtime/operation state, declared
interfaces and relevant endpoint/readiness facts. Do not fetch app records/data, logs, secrets or
source file contents merely because an app was selected. Specific investigations still use tools.

Append the snapshot to that turn in an attributed structured context block, separate from the user's
words and standing host instructions. This must work for already running native sessions, where the
initial system prompt cannot be replaced. Explicitly state when the selected set changed or became
empty so an old app does not remain presented as the current target by accident. Unavailable ids are
marked unavailable; do not reuse last-seen URLs as live endpoints.

Cap descriptions per app and total context bytes (proposed 16 KiB), with visible truncation markers;
never drop ids silently. Manifest/app text is untrusted descriptive data, not operator instructions.
Store the bounded snapshot/revision alongside the accepted message for traceability using ordinary
transcript retention. Captured state is dated, not a guarantee that an app remains running throughout
the turn. Selection does not attach or refresh MCP servers beyond existing provider policy.

If selected apps are ambiguous for an edit, the assistant asks which is the target. It must not
choose one implicitly just because it was first in the list. The primary workspace, when present,
is displayed separately and supplies that edit target explicitly.

## Component Work And Deliverables

- [ ] Add typed association persistence, revision handling, request deduplication and backward-compatible
      reads in gateway session storage/manager. Session deletion must not mutate any app/workspace.
- [ ] Add the independent app roster and association routes with administrator/identity checks,
      bounded input/context and honest unavailable/truncated states.
- [ ] Inject per-turn fresh snapshots into both harness adapters through the shared manager; preserve
      provider opt-ins, current approvals and a stable cwd for context-only sessions.
- [ ] Add the multi-select picker, chips, selection events and next-turn indication to gateway web;
      retain drafts/attachments when applying or cancelling selection.
- [ ] Add the shared New assistant session action to Shell sidebar/app-card menus; create through a
      minimal authenticated gateway client and open through existing panel routing. Shell does not
      acquire ownership of the conversation UI or a second copy of session state.
- [ ] Make panel session opening fetch an unknown requested id after authentication, rather than
      discarding it because the initial list is stale; handle deleted/unauthorized sessions explicitly.
- [ ] Define selection-change integration with the shared development-grant owner: selected apps,
      permitted source roots and primary cwd are distinct. Removal coordinates revocation and binding
      invalidation; context-only selection never creates a permission or silently repoints cwd.
- [ ] Add persistence/API/UI tests and the live acceptance below; update gateway/entry-point docs,
      write `feature.md`, remove this plan and regenerate the index at completion.
- [ ] Bump Shell and gateway minor versions with manifest/package consistency in the implementation
      PR. SDK/platform versions change only if their code/contracts actually need changes.

## Phases

One feature PR: (1) persistence/roster/API; (2) turn context; (3) picker and app-menu entry points;
(4) failure/concurrency and both-harness verification. The prototype feature consumes this result
and owns change/loss observations, the assisted Git flow and creation orchestration. General source
binding and execution permissions belong to assistant approval rules. Do not duplicate those
implementations here or wait for Git/publishing/development MCP to ship context-only selection.

## Verification And Acceptance

1. Start a general chat, select two apps (including a stopped Docker-only app), reload and verify the
   same chips. Send a question and inspect the captured context in both harness paths.
2. Add/remove an app during a running turn. Its existing snapshot stays unchanged; the next message
   has the new revision. Two browser tabs cause a visible revision conflict, not a lost update.
3. From each supported Shell menu, open a fresh session already associated with that app. No user
   message or model execution occurs before Send. Duplicate network submission creates one session;
   a later deliberate menu click creates a new one.
4. Delete that chat and start another from the same app. The app/source is intact. Uninstall an app
   associated with another chat: it becomes unavailable without broken rendering or stale live URLs.
5. MCP disabled, no source and stopped runtime do not prevent association. Selection changes no MCP
   toggle, runtime, grant, assignment or cwd. Non-admin and unauthenticated callers cannot read the
   roster or mutate associations; credential expiry and discovery outages have actionable states.
6. Resume existing sessions without new fields. Their behavior remains general context; historical
   context/title text is never parsed into an executable binding.
7. Verify active app preview stays open beside the panel and a freshly created session absent from
   its initial list is fetched. App-originated ask-assistant remains draft-only.

Run gateway tests/lint/web build, Shell tests/lint/build, version checks, docs-index and diff checks;
SDK/Core suites only when changed. Fake-harness tests must be supplemented by a live context turn on
both configured adapters. No second Core on the same host.

## Review Defaults

User-requested entry points and multiple associations are settled product scope. Proposed details to
review: 16 selected apps, 16 KiB context budget, next-turn application during active runs and menu
wording "New assistant session". Context association itself never submits a model turn.

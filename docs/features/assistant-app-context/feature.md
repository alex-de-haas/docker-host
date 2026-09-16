# Assistant App Context

Created: 2026-09-16
Updated: 2026-09-16

Administrators associate up to 16 installed apps with an assistant session. The gateway persists
an ordered, unique `appIds` selection and an `appContextRevision`; it resolves fresh metadata from
Core when accepting each message. Both Claude and Codex receive the same bounded context through
the shared session manager.

## Selecting Apps

The **+** button beside the context chips opens a searchable, paginated checkbox popover.
Both the app list and selected chips display the app icon, with a named-icon or generic fallback.
Escape or an outside click dismisses the popover without applying the draft selection. Apply persists the
selection; Cancel keeps the previous selection. Removable chips show the current apps, including
unavailable identities after uninstall. Empty selection means general host context. Search and
selection are independent of MCP-provider toggles, runtime state and source availability: stopped,
Docker-only and system apps are all valid subjects.

Selection changes leave the composer and pending attachments intact. They appear as transcript
events and propagate to connected clients. While the model is active, **Applies to your next
message** explains that its accepted turn retains the earlier snapshot. Clearing context affects
subsequent messages; it does not erase earlier conversation text or model knowledge.

Each selection write and message carries the displayed revision. A stale write or send returns
`app_context_conflict`; the UI reloads the authoritative selection and retains the unsent draft.
Reopening a session from the list, a Shell action or a notification fetches its current record,
including sessions absent from the initial list. Reloading preserves the committed selection.

Icon metadata comes from the authenticated Core directory. Relative asset URLs resolve against
`HOSTY_CORE_PUBLIC_ORIGIN` (falling back to the local Core origin when no public origin is configured);
Core image requests retain the existing browser session gate. Icon URLs and names are display-only
and are excluded from the model snapshot.

Directory failures are reported as **App context is unavailable**, with Retry. A failed context
resolution prevents message dispatch; the operator can explicitly choose **Send without fresh app
details for this message**. The resulting snapshot says `resolution: unavailable`. An uninstalled
app instead retains its id with `available: false`; stale URLs are not reused. Removing an
unavailable association remains possible during a directory outage.

## New Session From An App

**New assistant session** appears in Dashboard app actions
when the signed-in user is an administrator and a running gateway advertises the `appContext`
capability with an available harness. The target app itself can be stopped. Shell checks gateway
availability again on activation and reports an actionable failure without creating a fallback
unbound chat.

The action creates a new session with that app selected, opens the existing assistant panel and
focuses an empty composer. The current page or app preview stays open. It submits no user message
and starts no model run. Pending activation is disabled across menus; a network retry reuses its
actor-scoped creation request id. A later deliberate activation creates another session.

Shell owns the small authenticated creation client and panel routing; the gateway owns the
conversation. App-originated `hosty:ask-assistant` remains draft-only and cannot change durable
associations. Deleting a chat removes its associations with that chat only. Creating another chat
about the same app does not depend on the deleted conversation.

## Persistence And API

Existing records without association fields read as `appIds: []` and revision zero. Titles and
legacy `context` data are never parsed into app bindings. Session records use serialized atomic
replacement; context mutations, message acceptance, harness events, rename and deletion share the
manager's per-session queue. Creation retry records survive gateway restart. A reused request id
with a different normalized payload conflicts; ids are scoped to the creating administrator.

All routes below use the existing administrator authentication and cookie-origin checks. The
server obtains the roster through Core's existing authenticated app-directory endpoint. It does
not accept client-supplied labels, paths or endpoints as authoritative metadata.

| Route | Behavior |
| --- | --- |
| `GET /api/session-apps` | Search by id/title, pages of 100 using `offset`; `ids` resolves up to 16 exact ids for chips |
| `POST /api/sessions` | Optional `appIds` and `clientRequestId`; validation, ordered deduplication and actor-scoped retry handling |
| `PUT /api/sessions/{id}/apps` | `{ appIds, expectedRevision }`; replaces selection, increments revision and emits `app_context_changed` |
| `GET /api/sessions` and `/{id}` | Persisted ids/revision plus current availability snapshots; the list shares one discovery read |
| `POST /api/sessions/{id}/messages` | `appContextRevision` and optional `withoutAppDetails`; checks revision and captures context before dispatch |

Legacy callers can omit a message revision while it remains zero. Once a selection changes, a
revision is required. Unknown new app ids, malformed ids and selections exceeding 16 are rejected;
previously selected unavailable ids can remain until explicitly removed. Selecting apps persists
no delegated credentials.

## What The Model Receives

The accepted `user_message` event stores a timestamped snapshot and revision beside the original
text and attachment names. The harness prompt appends an attributed JSON block with ids, display
names, descriptions, versions, selected runtimes, runtime/operation states and declared interfaces
resolved by Core. The block identifies metadata as untrusted descriptive data and explicitly
replaces the previous selection, including when the current selection is empty. It directs the
assistant to clarify an ambiguous target rather than infer one from checkbox order.

Descriptions are limited to 512 characters, titles to 160, other text fields to 80, and interfaces
to eight per app. Overlong URLs are omitted rather than shortened into a different endpoint.
Truncation is marked in the snapshot. The complete appended context block is capped at 16 KiB;
when full metadata exceeds that budget it retains every selected id, availability and runtime
state. A captured state is a dated observation, not a guarantee of continued runtime availability.
A never-bound legacy general conversation receives its original prompt unchanged.

Association resolves metadata only. It does not read app data, source files, logs or secrets, and
does not enable MCP providers, change runtime, enable Development Mode, grant source writes or
command execution, or change the native session's cwd. The existing tool and permission policies
remain authoritative. Selecting a system app creates no extra authority over it.

## Development Integration Boundary

Selection is distinct from both a primary development workspace and execution grants. The
[assistant approval rules](../assistant-approval-rules/plan.md) plan owns their implementation,
source binding and safe native-thread reconfiguration. Its integration must quiesce affected
execution before revoking grants or removing a primary binding; re-adding an app restores context
only. This feature's selection mutation documents that integration boundary and performs no
implicit rebinding. [Prototype workspaces](../app-prototype-workspaces/plan.md) consume these
associations rather than implementing another session binding mechanism.

## Testing Expectations

- Gateway tests cover persistence across restart, actor-scoped retry deduplication, revision
  conflicts, serialized selection/message capture, next-turn and empty-context behavior, event
  delivery, old records, unavailable apps, directory outages and explicit fallback. Metadata limits
  preserve all ids, mark truncation and omit partial URLs. Association leaves cwd and MCP unchanged.
- API tests reject anonymous and non-admin roster/mutation requests, exercise search and exact-id
  summaries, unavailable list summaries and stale messages before a `user_message` is accepted.
  Existing cookie-origin tests cover the common API gate.
- Shell client tests exercise delegated-token refresh, uncertain-response retries with the same id,
  unavailable/unsupported gateways and creation without message submission. Menu/picker wiring is
  checked in the Core-managed UI; the repository has no component-rendering test harness for it.
- Core HTTP tests cover the app-directory metadata contract and existing service-token checks,
  including the absence of settings, secrets and source paths.
- Live acceptance on 2026-09-16 used one existing Core: a Claude turn received stopped Demo App and
  running Docker-only Torrent Engine; after selection was cleared, the same native conversation
  reported no current apps. A separate Codex turn received stopped Demo App correctly. No tool
  calls occurred. The stored message snapshots matched the selections and revisions.
- Live UI acceptance covered checkbox selection, chip removal, draft preservation, reload,
  Dashboard session creation and opening a newly created session absent
  from the panel's initial list. A Solitaire preview remained mounted beside its new empty bound
  chat. Deleting the test chats and recreating a bound chat left apps intact. Temporary source
  overrides and the harness setting were restored. Uninstall/outage races are tested with controlled
  fixtures rather than uninstalling the operator's real apps.
- The follow-up picker check on 2026-09-16 verified Dashboard-only session creation, loaded Core
  asset icons in chips and the checkbox list, Cancel, Apply, Escape focus restoration, chip removal
  and persistence after reload. The popover fits a 360-pixel panel with a scrolling app list.
  This UI check sent no model requests and removed its temporary session afterwards.

Required checks: gateway tests/lint/web build; Shell tests/lint/build; Core tests when its discovery
contract changes; version consistency; documentation index; diff whitespace. Exercise real Claude
and Codex turns when changing the shared prompt delivery contract, in addition to fake-harness tests.

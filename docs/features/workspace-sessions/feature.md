---
created: 2026-10-25
updated: 2026-10-30
summary: Core workspaces support concurrent private sessions, permission-based source access, attributable activity and independent conversation lifetimes.
components: [apps/core, apps/harness]
---

# Multiple Sessions In A Shared Workspace

A logical workspace retains its source, name and workflow independently of its conversations.
An authorized application and initiating administrator can access every retained workspace on the Core. Each session has at most one active association; a workspace can have any number of
sessions, including none. Sessions from different users run concurrently in the same directories
and branches. Attaching or creating a session sends no message to a provider.

## Identity And Compatibility

Core persists session bindings and historical participation metadata in `core/development/participation`.
The original `WorkspaceOwner` remains immutable allocation evidence, preserving aggregate/worktree IDs,
paths, branches, bases and old request fingerprints. It does not supply another actor's credentials.
Internal and external workspaces use the same operation-permission model. Historical membership records
remain readable for compatibility but do not restrict source access or require a sharing dialog.

Attachment mutations carry a UUID and expected participation revision. Matching retries preserve later
detachments; conflicting arguments fail. Attach and preparation serialize to prevent conflicting
associations. An attached session can prepare another registered repository under the same allocation.
Session association selects working context; it is not a resource permission.

The session API remains `/api/internal/apps/{appId}/sessions/{sessionId}/workspaces`. Companion
`workspace-association` routes read the association and attach/detach a logical workspace.
`workspace-inspection/{workspaceId}/participants` reads activity and association metadata.

## Source Access And Privacy

[Workspace permissions](../external-workspace-access-continuity/feature.md) combine the application's
operation permission with the initiating user's current rights. Collection reads and local source
operations do not filter by creator, session, app installation, credential or historical membership.
A fresh authorized credential can inspect and continue existing source without reallocating it.

Remote fetch/publication still uses the acting user's authorized provider connection. Retained local
source access does not transfer another user's connection, tokens or private provider evidence.
Harness lists, reads, mutates and streams only the current user's conversations. Other users' rows
have no private conversation link. Core omits provider grants and other sessions' command bodies
from source projections. Provider selection, history, drafts, attachments and approvals remain private.
Harness's existing installation-level provider connection settings retain their independent rules.

## Execution And Managed Git

Each execution claims its own worktree leases. Harness reports running/waiting activity through its
own current app authorization; stale active reports become unknown after 45 seconds. Confirmed
terminal failures remain visible until another current outcome replaces them. Monotonic per-session
report sequences reject delayed reports, while separate change timestamps exclude heartbeat-only
updates from activity ordering. Publishing an idle/failed state without exit acknowledgement retains
an unresolved lease and projects unknown activity. A lease by itself is
not evidence of a running process. Stop verifies the owning native/worker execution's exit before
releasing its exact claims. Missing stop acknowledgements retain the lease and recovery evidence.

Permission revocation fences new managed admissions. Pause
fences the workspace, coordinates its current-installation sessions and confirms only after consumers
reconcile. Other installations and arbitrary external processes require their own recovery.

Managed mutations serialize on stable workspace/worktree identity. Branch-replacing operations
refuse other or unknown writers. Shared-workspace commits require an explicit selected-file review
bound to the actor, participation revision, HEAD, exact Git tree and a 15-minute expiry. An isolated
index commits only that snapshot; changed selected content is refused and unrelated files remain
uncommitted. Provider connections are acquired after workspace admission where both are required.

Native writes remain cooperative: simultaneous changes to the same file have no automatic merge
or isolation guarantee. Agent context identifies shared source, exposes bounded participant activity
and requires rereading files after another participant's edits. Permission revocation cannot erase source already read or establish a filesystem boundary inside the shared worker.

## Navigation And Lifetimes

Harness has one left-hand list of authorized workspaces and unattached chats. Attached conversations
are grouped into their workspace row. External and sessionless workspaces remain in the same list. All workspace rows use the same hammer icon, with no external marker, secondary label or tooltip.
Internal and externally allocated workspaces show only the current user's accessible Harness sessions
as keyboard-navigable tabs, with a plus that creates one idle conversation. Empty workspaces offer
explicit creation without creating a chat on selection. Other hosted participants' titles and activity
appear in the right-hand details panel without private conversation links. Standalone chats have no
workspace panel. External allocation remains provenance: its original record and source are retained,
but it does not appear as a hosted conversation or contribute inferred session activity. The external
client's transcript and activity are not synchronized. New Harness chats share the existing files,
branches and uncommitted edits. Transcript file links resolve the current accessible association,
including externally allocated workspaces, rather than requiring the chat to be the original creator.

Workspace rows display independent Working, Needs attention and Failed icon/count groups, hiding
zeros. Each attached participant contributes to one current category; approval/question waits do not
also count as working. Unknown and stopping activity has a separate indicator. External leases do
not become fictitious session counts. Search includes disclosed titles and app context; an own-chat
match selects that tab. Filters retain any workspace with matching participant activity. Ordering
uses source/workflow changes, own session changes and bounded participant changes, excluding heartbeats.

Session links retain the containing workspace and tab. Workspace links represent external or empty
selections; each workspace remembers the user's last accessible tab with a recent-chat fallback.
In-place route updates report to Shell without reopening the page. Drafts and approval state remain
independent; unsent local files survive tab switches in the current document, while uploaded references
and text drafts survive reload. Tabs scroll horizontally; the plus stays reachable on narrow screens.
Attachment controls and source lifecycle/review actions remain on the right; there is no sharing-permission menu.
Attach session opens a modal with the current user's available chats, loading/empty/error states and
Cancel/Attach actions. Successful attachment closes it; uncertain requests retain their exact retry
inside the modal, or in the details panel after it is dismissed.
Source views say Workspace changes because a diff is not attributable to one chat.

Joining requires an idle session with reconciled source/resource operations. Detach preserves source
and history; a subsequent attachment starts a fresh provider execution context. New-session and
association actions retain exact request IDs for retry, scoped to the authenticated viewer/workspace.
Late results cannot navigate a view that has moved to another workspace. Existing observation events
update participation without duplicating source subscriptions per session.

Deleting a chat stops and detaches only that chat and removes its private history/cache. Dirty
shared source and other sessions survive, including deletion of the original creator's chat.
Session-owned unfinished resources still need explicit Finish when deleting only a chat. Workspace Delete
coordinates removal of its attached resources under workspace management authority, including resources
created by another user. It accepts dirty source and retained leases without requiring Pause or Complete. Retained histories
cannot restore a removed source association.

Automatic retention protects attached development chats, including completed workspaces. Detached
chats become eligible for ordinary-chat retention only after Core confirms resource reconciliation.
Existing settings retain their values. Previously accepted legacy cleanup requests recover with
their exact IDs; expiry cannot start a new shared-source deletion. Owner recovery of abandoned
internal or external leases requires paused admission, exact HEAD, explicit exit confirmation and
fresh consumer checks.

## Testing Expectations

- Core tests cover immutable allocation identity, fresh credentials, cross-user source access,
  current user/app denial, attach/replay, private transcript boundaries and actor-bound remote credentials.
- Harness tests cover session ownership, provider isolation, exact execution stop acknowledgements,
  selected-file commits, concurrent activity and independent chat/source lifetimes.
- `npm run test:integration -- sessions` uses a parent-managed child Core, normal password login,
  distinct users, disposable repositories and locally built Harness images. It checks shared paths
  without grants, private chat routes, creator-chat deletion, sessionless inventory and deletion replay.
  External allocations also cover multiple hosted chats, exact creation replay, immutable source/lease
  identity, private routes and source preservation after detachment and chat deletion.
- Browser acceptance uses Core app launch URLs and the same isolated fixture. Parent Finish removes
  the child and its services after verification. Test credentials remain in temporary fixture data.
  `HOSTY_ACCEPTANCE_HOLD_UI=1 npm run test:integration -- sessions` builds Shell locally and keeps
  the fixture available for explicit first/second chat creation, keyboard tabs, independent drafts,
  reload and workspace-return restoration, and narrow-screen checks. No provider prompt is required.

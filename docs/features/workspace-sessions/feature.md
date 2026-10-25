---
created: 2026-10-25
updated: 2026-10-25
summary: Explicitly shared workspaces support concurrent private sessions, scoped source access, attributable activity and independent conversation lifetimes.
components: [apps/core, apps/harness]
---

# Multiple Sessions In A Shared Workspace

A logical workspace retains its source, name and workflow independently of its conversations.
An enabled administrator owns it and explicitly grants contributors access to selected repository
worktrees. Each session has at most one active association; a workspace can have any number of
sessions, including none. Sessions from different users run concurrently in the same directories
and branches. Attaching or creating a session sends no message to a provider.

## Identity And Compatibility

Core persists membership and session bindings in `core/development/participation`. The original
`WorkspaceOwner` remains immutable allocation evidence, preserving aggregate/worktree IDs, paths,
branches, bases, runtime consumers, source grants and old request fingerprints. It does not supply
another participant's actor credentials. Legacy internal workspaces materialize the original owner
and first binding without moving source. External workspaces retain their reviewed principal/task
ownership and cannot join this membership model.

Membership and attachment mutations carry a UUID and expected participation revision. Core stores
actor and exact normalized arguments before acknowledgement. Matching retries preserve later
revocations or detachments; conflicting arguments fail. Attach and initial preparation serialize,
so racing sessions cannot create conflicting associations. Explicit preparation after verified
physical removal preserves allocation compatibility and revokes previous sharing grants.

The session API remains `/api/internal/apps/{appId}/sessions/{sessionId}/workspaces`. Companion
`workspace-association` routes read the association and attach/detach a specific logical workspace.
`workspace-inspection/{workspaceId}/participants` reads bounded participation metadata; its `grant`
and `revoke` actions require the owner. Application identifiers and viewer routes are opaque contracts.

## Source Access And Privacy

The owner reviews the repository selection and its disclosure of checked-out source, diffs, commit
metadata, session titles and activity. Contributors receive a bounded grant to those worktrees,
including private source. Repository additions and changes in underlying source authorization
invalidate the corresponding sharing revision until the owner reviews it again.

Reads and execution admissions require current membership, session binding, user/installation
access and source authority. Local private-source inspection validates the original source grant
without refreshing or borrowing the owner's provider token. Public document caches retain their
anonymous-access proof requirement. Fetch and publication use the acting user's authorized Git
connection. A publication or local remote bound to another user's connection refuses that action;
it does not transfer the connection. Owner-bound PR review and lifecycle controls retain their
separate authorization requirements.

Harness lists, reads, mutates and streams only the current user's conversations. Workspace
participation grants no transcript, attachment, approval, model selection or message receipt access.
Other users' rows have no private conversation link. Core strips private source grants and other
sessions' operation bodies from session projections. Plans receives the authorized source view and
an optional viewer link to the current user's own attached session. Shell consumes the existing
optional viewer contract; neither client needs a new artifact version for this change.

Claude/Codex connections remain shared among Harness administrators at the installation level.
Workspace membership neither partitions nor changes access to those connections. Each conversation
retains its provider selection, history, draft, attachments and approvals independently.

## Execution And Managed Git

Each execution claims its own worktree leases. Harness reports running/waiting activity through its
own current app authorization; stale active reports become unknown after 45 seconds. Confirmed
terminal failures remain visible until another current outcome replaces them. Monotonic per-session
report sequences reject delayed reports, while separate change timestamps exclude heartbeat-only
updates from activity ordering. Publishing an idle/failed state without exit acknowledgement retains
an unresolved lease and projects unknown activity. A lease by itself is
not evidence of a running process. Stop verifies the owning native/worker execution's exit before
releasing its exact claims. Missing stop acknowledgements retain the lease and recovery evidence.

Revocation fences new managed admissions first. Harness requests cancellation through each affected
local session's own credentials. A failed stop remains visible and blocks cleanup. Pause similarly
fences the workspace, coordinates its current-installation sessions and confirms only after consumers
reconcile. Other installations and arbitrary external processes require their own recovery.

Managed mutations serialize on stable workspace/worktree identity. Branch-replacing operations
refuse other or unknown writers. Shared-workspace commits require an explicit selected-file review
bound to the actor, participation revision, HEAD, exact Git tree and a 15-minute expiry. An isolated
index commits only that snapshot; changed selected content is refused and unrelated files remain
uncommitted. Provider connections are acquired after workspace admission where both are required.

Native writes remain cooperative: simultaneous changes to the same file have no automatic merge
or isolation guarantee. Agent context identifies shared source, exposes bounded participant activity
and requires rereading files after another participant's edits. Revocation cannot erase source
already read or establish a filesystem boundary inside the shared worker.

## Navigation And Lifetimes

Harness has one left-hand list of authorized workspaces and unattached chats. Attached conversations
are grouped into their workspace row. External and sessionless workspaces remain in the same list. All workspace rows use the same hammer icon, with no external marker, secondary label or tooltip.
Internal workspaces show only the current user's accessible sessions as keyboard-navigable tabs,
with a plus that creates one idle conversation. Other participants' titles and activity appear in
the right-hand details panel without private conversation links. Standalone chats have no workspace
panel; external workspaces have an empty center, without a composer or session-creation controls.
Sessionless internal workspaces offer explicit creation without creating a chat on selection.

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
Participant sharing/attachment controls and source lifecycle/review actions remain on the right.
Source views say Workspace changes because a diff is not attributable to one chat.

Joining requires an idle session with reconciled source/resource operations. Detach preserves source
and history; a subsequent attachment starts a fresh provider execution context. New-session and
association actions retain exact request IDs for retry, scoped to the authenticated viewer/workspace.
Late results cannot navigate a view that has moved to another workspace. Existing observation events
update participation without duplicating source subscriptions per session.

Deleting a chat stops and detaches only that chat and removes its private history/cache. Dirty
shared source and other sessions survive, including deletion of the original creator's chat.
Session-owned unfinished resources still need explicit Finish. Workspace Delete/Discard retains
its independent clean/integrated or destructive-review contract and checks resources across all
participants; it does not transfer another participant's sandbox ownership. Retained histories
cannot restore a removed source association.

Automatic retention protects attached development chats, including completed workspaces. Detached
chats become eligible for ordinary-chat retention only after Core confirms resource reconciliation.
Existing settings retain their values. Previously accepted legacy cleanup requests recover with
their exact IDs; expiry cannot start a new shared-source deletion. Owner recovery of abandoned
internal or external leases requires paused admission, exact HEAD, explicit exit confirmation and
fresh consumer checks.

## Acceptance (2026-10-25)

The registered worktree is based on `3fa7ff74f41e47133e7e2b89df58d695f1fe0375`. The initial tested candidate advances
Platform 0.152.3 to 0.153.0 and Harness 0.67.7 to 0.68.0. Publication reconciles the platform
version with current main: Platform 0.153.0 to 0.154.0; Harness remains 0.67.7 to 0.68.0. Plans and Shell use the existing optional
viewer contract and have no implementation or version change. The original acceptance covers D1-D8:
contracts, durable associations, authorization, concurrent execution, lifecycle, UI, acceptance
and documentation/versioning.

On macOS arm64 with .NET 10.0.402 and Docker 29.9.2, a parent-managed child Core runs the candidate
Core and Docker Harness with a separate Git fixture, data root and three test administrators.
Each administrator uses ordinary password authentication; invitation grants are confirmed through
the existing Core settings review. Acceptance verifies that an uninvited administrator cannot join,
an invited user sees the same physical directory and branch, and repeat new-session requests return
one idle conversation without dispatch. Renaming a session updates participant metadata.

Cross-user transcript, event, attachment, model and retention routes refuse access. Both authorized
users observe changes to the shared files; revocation fences further source reads. Removing both
conversations, including the creator's, preserves their dirty files. A new idle conversation can join
the retained workspace after its session count reaches zero.

Browser acceptance uses normal Core password login and the Core-managed Harness preview URL.
It verifies distinct session/workspace names, new-session creation, two independent unsent drafts,
switching and reload persistence. At 390 by 844 pixels the conversation and workspace panel retain
usable navigation and participant controls. The browser viewport is restored afterwards.

The commands completed for this candidate are:

| Command | Result |
| --- | --- |
| `dotnet test apps/core/tests/Haas.Hosty.Core.Tests/Haas.Hosty.Core.Tests.csproj --no-restore --filter "$workspace_filter"` | 146 affected tests pass, none skipped; selection below |
| `npm run harness:test` | Original acceptance: 1,588 tests in 148 files pass |
| `npm run harness:lint` | Server/web TypeScript and web ESLint pass |
| `npm run plans:test` | 137 tests in 14 files pass |
| `npm run shell:test` | 740 tests in 68 files pass |
| `node --test scripts/test-integration.test.mjs` | 10 tests pass |
| `docker build -f apps/harness/Dockerfile -t ghcr.io/alex-de-haas/hosty-harness:0.68.0 .` | Production API/web image builds |
| `npm run core:aot` | Native AOT for osx-arm64 passes with no new trim/AOT warnings; four existing compiler/platform warnings remain |
| `npm run test:integration -- worker` | Both Claude/Codex adapter protocols and the worker Docker build pass |
| `npm run test:integration -- transport` | Docker transport/authentication isolation passes |
| `npm run test:integration -- activation` | Exact Core/CLI builds, managed activation/Return and killed-helper recovery pass |
| `python3 scripts/check-workspace-activation.py . sessions --managed --hold-ui` | Multi-user API and browser acceptance pass; parent Finish confirms child resource removal |

The final Core selection combines the changed authorization, source, publication and lease groups
with every regression found by the earlier 597-test workspace/source run. That earlier run had
585 passes and 12 failures; the failures are resolved and included in the passing final selection.
It is not a claim that the complete Core suite was rerun after the fixes.

```bash
workspace_filter='FullyQualifiedName~WorkspaceParticipation_|FullyQualifiedName~SourceDocuments_|FullyQualifiedName~Publication_|FullyQualifiedName~LeaseRecovery_|FullyQualifiedName~LocalRemote_|FullyQualifiedName~AppAssetWorkspaceHttpTests|FullyQualifiedName~DevelopmentWorkspaceHttpTests|FullyQualifiedName~WorkspaceSharingHttpTests|FullyQualifiedName~CoreSourceWorkspaceHttpTests|FullyQualifiedName~WorkspaceInspection_HistoricalSummaryRequiresExactHeadAndExistingAuthority|FullyQualifiedName~ExecutionInventory_PublicForeign|FullyQualifiedName~WorkspaceReview_PublishedDiffRetainsProviderThreadsAndExcludesLocalEdits|FullyQualifiedName~WorkspaceDiscard_OldRemovedRequestCannotCompactANewerReallocationForTheSameOwnerAndTask|FullyQualifiedName~WorkspaceInspection_PublicationFactsRequireOwnerRepositoryConnectionAndPublishedHead'
```

`node scripts/check-versions.mjs`, `node scripts/docs-index.mjs --check` and `git diff --check` pass.

The acceptance closes through its owning parent. Test Core processes, helper, fixture Git server,
ports, temporary credentials, builds and fixture data are removed. The worker and transport probes
also remove their owned resources. Original repository files are unchanged; registered source work
is retained. Raw evidence and screenshots stay outside the repository.

No real provider prompt is dispatched and no provider credential is copied to the sandbox.
Adapter protocol checks and unit coverage establish execution/lease coordination; they do not
establish model-generated concurrent-edit behavior. Native same-file edits remain cooperative.
Windows-specific process checks and other Native AOT targets are not run on this macOS host.

## Unified Navigation Acceptance (2026-10-25)

The follow-up completes D9-D13: unified navigation, accessible session tabs, independent activity
counts, responsive workspace details and verification. It remains part of the same unshipped
Platform 0.153.0 / Harness 0.68.0 candidate; there is no additional phase version bump.

| Command | Result |
| --- | --- |
| `npm test --workspace @haas/hosty-harness` | 1,596 tests in 149 files pass |
| `npm test --workspace @haas/hosty-harness -- assistant-conversation-review-entry app/assistant/page` | 76 tests pass after the final in-place routing change |
| `npm test --workspace @haas/hosty-harness -- development-navigation workspace-navigation workspace-sessions` | 16 tests pass after the final sidebar layout change |
| `npm run harness:lint` | Server/web TypeScript and ESLint pass; web lint also passes after the final layout change |
| `dotnet test apps/core/tests/Haas.Hosty.Core.Tests --filter 'FullyQualifiedName~WorkspaceParticipation_\|FullyQualifiedName~WorkspaceSharingHttpTests' --nologo` | 12 affected Core tests pass, none skipped |
| `dotnet build apps/core/src/Haas.Hosty.Core/Haas.Hosty.Core.csproj --nologo` | Exact target builds; the isolated launch generation also builds, with four existing warnings and no errors |
| `npm run build:web --workspace @haas/hosty-harness` | Final native web build passes |
| `docker build -f apps/harness/Dockerfile -t ghcr.io/alex-de-haas/hosty-harness:0.68.0 .` | Final API/web image builds |
| `node --test scripts/test-integration.test.mjs` | 10 tests pass; both Python acceptance scripts parse successfully |
| `python3 scripts/check-workspace-activation.py . sessions --managed --hold-ui` | Isolated multi-user API acceptance passes; browser fixture and parent-owned cleanup complete |

The full Harness run precedes the final routing and compact-row adjustments; the affected suites
and web lint are rerun after those adjustments. The Core regression verifies monotonic report
ordering, heartbeat-independent change times, failed/retry/idle outcomes and refusal to release an
unconfirmed execution lease. Navigation coverage includes simultaneous working/attention/failed
counts, foreign metadata, expired observations, external ownership and attached/standalone grouping.
The broader original acceptance above is not represented as rerun for this UI follow-up.

The managed browser fixture includes two own chats, a foreign participant's disclosed title,
a standalone chat, an empty internal workspace and an external workspace. Desktop and 390 by 844
journeys verify explicit idle creation, independent unsent drafts, switching, reload, browser history,
keyboard tab focus and responsive details. Foreign conversations have no tab or private transcript
link. External selection has no composer or creation plus. The browser viewport is restored.

Normal password login and embedded rendering are verified through the child Core and Shell preview
URLs. The browser automation tool cannot target interactive controls inside the Shell iframe in this
run; interactive journeys therefore use the Core-authenticated Harness preview, with Shell route
reporting additionally covered by component tests. This is not a claim of automated iframe-click
coverage. No real provider prompts or copied provider credentials are used.

The first fixture's Shell URL lookup is corrected to use its declared browser endpoint; its stopped
resources retain only failure diagnostics outside the repository. The successful fixture uses the
supported app update plan/update flow to apply a rebuilt Docker tag: an app restart alone retains
the old container image. Parent Finish confirms removal of the child environment, containers,
processes, ports, temporary credentials and successful fixture data.

The already-authorized main-instance dev trial is refreshed from the same registered worktree.
A briefly unavailable Core launch is recovered through the supported exact-project start command.
Subsequent checks confirm a new process identity, the expected source project, no pending restart,
healthy native Harness API/worker services and the unified UI. Source and ordinary app data remain
in place. Documentation, version consistency and whitespace checks pass.

The initial icon refinement preserves session tab titles and removes the external text row. The existing navigation/conversation/participation suites pass
40 tests (`npm test --workspace @haas/hosty-harness -- development-navigation assistant-conversation-review-entry workspace-sessions`). Web lint, native web build and the Docker image build pass.
A fresh managed fixture repeats the multi-user API acceptance and verifies workspace icons inside
Shell after normal Core password login; parent Finish removes all owned test resources. The main
instance displays the same final icons. This refinement changes no Core code.

## Publication Candidate (2026-10-25)

The publication workspace merges the preserved feature commit with current main without modifying
the worktree consumed by the main Core. Version conflicts resolve to Platform 0.154.0 and Harness
0.68.0. The local integration dispatcher retains both dependency-startup and shared-session suites.
`npm run test:integration -- sessions` passes on this merged candidate, including Core/CLI builds,
both Harness Docker images, three password-authenticated users, sharing/privacy, retained dirty
source and confirmed parent-owned sandbox cleanup. Harness TypeScript/ESLint and its web build pass.
The fresh checkout's full Harness run passes 1,595 tests; its sole failure lacks the required static
export. After building that export, all 63 gateway tests pass. No runtime workaround is introduced.
Documentation/version validation and the integration dispatcher's 10 tests pass.

Review regression coverage verifies selected-file `reviewId` transport for both commit tools,
ordinary chat workflow reads after creator detachment without restoring source access, and durable
attach/detach refusal recovery. Definitive refusals stop blocking chat retention/deletion; uncertain
responses retain their exact request. A later authorization refusal does not erase that uncertainty.
Browser recovery also clears confirmed refusals, unlocking attachment, sharing and new-session
controls across reloads, while retaining uncertain requests after a later authorization failure.
Deletion retries a refused detach with a fresh membership revision. Environment source admission
continues to return the sandbox API's forbidden error for an unattached session.

## Testing Expectations

- Core coverage includes real temporary Git stores, migration/reallocation, membership revision and
  replay, concurrent attach, shared preparation, private-source revocation, session lease attribution,
  selected-content commit reviews, publication lock ordering and internal/external recovery.
- HTTP tests use an unrelated assistant ID with no distribution apps and test forged identities,
  uninvited administrators, source projections and revoked admissions.
- Harness tests cover session ownership across routes/streams, provider isolation, exact lost-response
  recovery, confirmed/unknown stops, conservative retention and stale UI actions/draft preservation.
- `npm run test:integration -- sessions` builds Core, CLI and both Docker Harness images, then uses a
  parent-managed child Core, ordinary setup/password login and invitations for three test users.
  It checks shared paths, explicit grants/revocation, private routes, idle session creation, source
  visibility, creator deletion and reattachment after zero sessions. Parent Finish removes resources.
- `python3 scripts/check-workspace-activation.py . sessions --managed --hold-ui` retains that owned
  sandbox for browser acceptance until its printed completion sentinel is created. Test credentials
  stay in the temporary fixture and are removed during successful cleanup.
- Worker adapter checks exercise Claude/Codex catalog and lifecycle protocols without copied provider
  credentials. Real provider prompts require separately available sandbox credentials; catalog
  acceptance alone does not establish model-generated concurrent editing coverage.
- Run affected Core/Harness/client tests, builds, Native AOT validation, local transport/activation
  checks, version consistency and documentation validation before publication.

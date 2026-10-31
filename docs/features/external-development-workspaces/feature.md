---
created: 2026-10-07
updated: 2026-10-31
summary: Authorized external clients use registered Core worktrees, independent test environments, canonical publication and native Git/provider reconciliation.
components: [apps/core, apps/harness, apps/documents]
---

# External Development Workspaces

## Registry And Allocation

Core creates registered Git worktrees for local external agents using the same repository store,
target refs, durable operations and observer as [assistant session workspaces](../assistant-session-workspaces/feature.md).
An external owner contains the current administrator, the direct credential's stable principal,
a logical task ID and a plain display label. It has no installed assistant or conversation binding.
Existing installed-assistant records retain their original serialized owner identity, allocation IDs,
preparation fingerprints and session links after upgrade and restart.

OAuth ownership follows the durable grant, so access-token refresh retains existing workspaces.
A new grant has its own bindings. Manual Core credentials use a hashed credential identity; bearer
values never enter workspace records, tool results or audit references. Labels do not change allocation
identity. Replaying preparation with changed explicit arguments is refused.

The direct Core MCP workspace tools require both `mcp:read` and the separately reviewed
`mcp:workspaces` permission, including listing, observation and byte-bearing diffs. Every call resolves
the current credential, administrator, OAuth grant/client and source grant. Browser-only and device credentials do not establish this external allocation authority. Independently
named applications use the canonical installed-app caller adapter with current user/source permission;
this does not turn an app credential into an external principal. Other operation scopes remain
independent. Legacy session endpoints retain their installed-app authorization.

Listing includes every retained workspace allowed by the application's operation permission and the
initiating administrator's current rights. Creator, session, credential and source-provider grant do
not filter retained local source. Invalid records are omitted individually. Allocation identity and
old operation receipts remain unchanged; a fresh authorized credential can continue an existing tree.

Preparation requires a short purpose-based workspace `name`, separate from the external agent label.
The `rename_workspace` tool changes that aggregate name with an exact UUID replay receipt; names
propagate through workspace observation without changing source, ownership or active runtimes.

Preparation selects an installed app's declared repository and optional target branch. It returns
a Core-owned absolute directory, registered branch, target branch and original base. External
preparation requires an explicit activity lease and accepts no assistant session path. Native file
edits and commits in that directory appear through the existing observer. Remote source operations revalidate the acting user's provider authority. Retained local source does
not require the creator's provider connection and never transfers its credentials.

## Plans Presentation

[Plans](../plan-tracking/feature.md) displays `External / Codex` or the chosen agent label beside the
workspace's branch, status and observed time. Missing conversation links are expected for external
owners. Tracked-branch progress and each workspace's progress remain independent, including
uncommitted plan edits. Observation errors stay visible with their evidence time. Existing assistant
links and older payloads without external metadata retain their original presentation.

[Harness Development](../harness-development-ui/feature.md) includes external workspaces on its
Workspaces page, with the same workspace icon. Core aggregates repositories sharing one external principal/user/task reference.
The legacy worktree ID stays unchanged; `workspaceId` identifies its logical group. The standalone
[Workspaces app is retired](../workspaces-app/feature.md); Core inspection records and source APIs remain.
Shell provides ordinary app navigation and has no workspace source access.

## Pull Request Observation

Core's [shared PR scheduler](../harness-pull-request-inbox/feature.md#shared-observation) excludes
inactive and deleting/deleted workspaces. Visible authorized workspace scopes promote active CI to
the ten-second target and quiet PRs to one minute; without demand, reads use a five-minute baseline.
The common queue, account pacing and compact observation cache coordinate ordinary publications,
external references and the installed-app inbox. Provider work has a bounded deadline; failed reads
retain the prior evidence timestamp and are retried under the shared budget.
The read-only path never creates publication commands, merges, pushes, resolves review threads or
schedules source cleanup. Compact facts carry no publication-completion or review-body evidence.

Core uses the workspace's reviewed Git connection when present. For public source without a
selected connection, it uses the owner's sole connected account for that provider. Missing,
expired or ambiguous connections have explicit explanations in Workspaces. Another administrator's
account is never selected. Selecting an application's Git source connection resolves ambiguity.

Each reference is correlated with the workspace repository, head repository, target branch and
canonical PR URL. Read-only title, state and check observations allow the linked PR's working branch
to differ from the current workspace, including follow-up PRs created by another task in the same
repository. This does not reassign the workspace's branch or accept a foreign fork or repository.
Multiple references refresh independently. A new remote head updates status and checks together
without modifying local Git, and Workspaces displays a head difference when applicable. Provider
failures replace successful facts with an unavailable reason.

These display observations never carry completion evidence or private review bodies, including when
reading older cached snapshots. Review, publication and merge commands retain exact workspace/source
and current-head checks. Workspace completion and cleanup fetch separate, fresh, branch-bound provider
evidence; a linked card's merged state or passing CI never proves the workspace is safe to remove.

Observations persist under Core's `development/publications/external` directory and survive restart
while the workspace is retained. Successful workspace Delete removes these snapshots; late provider
responses cannot recreate them. Startup recovery removes verified legacy deleted workspace records
and their caches under the [workspace deletion contract](../workspace-lifecycle-controls/feature.md#unified-delete-and-recovery).
Reads revalidate the current administrator, source access and connection before showing cached facts.
The projection includes state, draft flag, checks, review decision, unresolved-thread count and
observation time, but omits credentials and private review comment bodies. Removed references are
never projected; the next successful refresh replaces the stored snapshot for the remaining
references. Git publication authority remains separate from the external workspace grant.

## Local Agent Setup

The external agent and Core run on the same machine. The returned `path` is a directory on
Core's host; connecting to a remote Core does not make it a local directory. Check the intended
instance first:

```bash
hosty --data-root /absolute/path/to/instance core status
```

Use that instance's Core origin or listen URL with `/api/mcp`, not Shell, an app endpoint or an
assistant's delegated MCP facade. A default local instance listens at `http://localhost:7070`;
its published Core origin can have a different hostname. The configured public origin must be
reachable by both the local client and its browser because OAuth metadata advertises that origin.
See [Core's own public origin](../core-public-origin/feature.md).

The preferred connection uses Core's ordinary OAuth consent flow. An administrator enables
**OAuth client registration** in Core settings when the client needs dynamic registration, then
signs in with the ordinary Hosty password flow. Request `mcp:read` and `mcp:workspaces` for the
Core resource, and explicitly select the workspace permission on the consent page. Read access
alone permits no workspace source/diff reads or operations. The workspace permission does not
grant app start/stop, Core restart, publication or update authority. The shared Core control secret
stays private. See [MCP OAuth](../mcp-oauth/feature.md).

For Codex, use a distinct server name if a remote Hosty connection already exists. These command
forms are checked against Codex CLI 0.147.0. Replace both URLs with the exact endpoint of the
selected local instance before running them; the example uses a verified IPv6 loopback Core origin:

```bash
codex mcp add hosty-local --url 'http://[::1]:7070/api/mcp' --oauth-resource 'http://[::1]:7070/api/mcp'
codex mcp login hosty-local --scopes mcp:read,mcp:workspaces
codex mcp get hosty-local --json
```

For desktop clients, perform login using the CLI bundled with that application or its own
connection UI. A separately installed CLI can be older and write OAuth metadata that the desktop
cannot refresh. Check both versions; an issuer-missing error calls for compatible reauthentication,
not longer Hosty session lifetimes. See [MCP recovery diagnostics](../mcp-oauth/feature.md#client-recovery-diagnostics).

Codex stores MCP settings in its local `config.toml`; local desktop, CLI and IDE clients on the
same Codex host share configuration. Reconnect the client after changing its server configuration.
The [official Codex MCP documentation](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)
describes HTTP/OAuth connections and the shared configuration. Other local clients use their own
Streamable HTTP connection setup with the same endpoint, OAuth resource and requested scopes.
Check the actual client help and connection state instead of assuming provider-specific commands.

A manually issued Core-audience scoped credential with those two permissions is an optional
fallback for clients without OAuth support. The operator creates and labels it through the
credential management surface, and the client stores it in its protected credential configuration.
Keep it out of repository files, prompts and logs. The OAuth client name or manual credential label
supplies the default external agent display label. Optional `prepare_workspace` `label` changes only
that presentation, never ownership. Use a nonempty label of at most 80 characters without surrounding
whitespace or control characters.

After authentication, call `get_host_status` and `list_apps` through the new connection. Confirm
that they describe the intended local host and installed source app. Inspect the live tool catalog:
clients can namespace or defer tools, so the names below are Core's protocol names. The presence
of a tool in that catalog is not proof that the credential may call it.

## Development Workflow For External Agents

A logical task has a stable opaque `taskId`, chosen once for that work context and reused when
resuming it. Use a nonempty ID of at most 200 characters without surrounding whitespace or control
characters. OAuth binds ownership to the current administrator and durable grant; token refresh
retains that binding. A newly authorized grant has its own allocation context but can access the same retained source
through the workspace operation permission. Tasks remain separate allocations. A task ID, agent label,
conversation ID or original credential is not an authorization boundary. Core records no imported conversation and provides no external-session URL.
[Harness sessions](../workspace-sessions/feature.md) can attach to the same workspace without
changing its allocation identity or importing the external transcript. Their private chats and
activity are tracked separately from the external client and its leases.

1. Read the user's approved scope and select an installed app with declared source. Do not register
   an arbitrary repository, change app source selection or install/start an app merely to obtain
   a workspace.
2. Generate a fresh UUID `requestId` for `prepare_workspace`, a stable task ID, and a separate fresh
   UUID `leaseId` for the active native work. Supply `appId`, those identities and an optional
   explicit `targetBranch`. Preparation requires a lease so Core retains activity while the client
   edits or runs native processes. The result identifies `id`, absolute `path`, `branch`,
   `targetBranch`, `originalBase` and the current observation. Confirm preparation succeeded and
   use the returned `path` as the development directory before making source edits.
3. Read that directory's `AGENTS.md`, applicable nested instructions, current `feature.md` and the
   approved `plan.md`. Implement only authorized work. For a Ready plan, set the working copy to
   In Progress when implementation begins and update its `updated` date. An already approved
   In Progress plan can be resumed. A Draft, On Hold or Blocked plan needs the repository's
   approval or blocker resolution before implementation.
4. Edit and test inside the returned directory. Native file edits and native commits are observable;
   the external application does not need to notify Core of every write. Keep unrelated changes
   intact. As soon as a deliverable's required verification passes, check its stable `D` item in
   the working-copy plan and update the date. Describe failures honestly and leave unverified
   deliverables unchecked. Run `node scripts/docs-index.mjs --fix` after meaningful document
   changes when the repository uses this documentation workflow. This rule authorizes document
   updates, not commits.
5. Use `get_workspace` to inspect current source state and durable operations, and
   `get_workspace_diff` with `view: "local"` for uncommitted changes or `view: "session"` for the
   original-base-to-current changes. Plans displays this workspace version separately from the
   tracked branch, including uncommitted plan progress. Do not edit main solely to change the
   tracked-branch progress. The Core observer's cycle is twenty seconds; its timestamp identifies
   the evidence being displayed.
6. Before pausing, wait for native edits, Git commands, builds and background processes to stop.
   Release only the matching known activity lease with `release_workspace_lease`. On resume,
   inspect the existing binding and acquire a new lease with `acquire_workspace_lease` before
   native work. Closing the application, losing its connection or revoking its credential does
   not release a lease or delete the worktree.

The initial preparation creates a Core-owned worktree; it does not adopt an existing Codex worktree
or move dirty files. An operator-authorized migration can transfer a reviewed patch into a newly
prepared directory. Inspect the exact patch and destination before applying it, preserve the
original checkout, and carry forward only the approved changes.

## Default Source And Test Workflow

Repository guidance uses Core-registered worktrees for Hosty source edits. The original checkout
and shared managed source remain outside the task's editing scope. Runtime/browser verification
uses the existing [sandbox and child Core lifecycle](../app-sandbox-runtimes/feature.md), with
separate test data, identity and dependency instances. Unit builds/tests run in the worktree;
documentation-only changes use document validation without starting a sandbox.

Sandbox disposal and source completion are independent. Useful reports are exported before Finish;
dirty, unmerged or consumed worktrees remain protected. The existing
[live-data dev mode](../app-development-controls/feature.md) is a separately authorized operation
in the installed app's Core, with recoverable Return. It does not mount ordinary data into a child
Core or imply source/data rollback.

The direct external workspace scope does not itself authorize sandbox or publication operations.
Clients use the canonical Core API/MCP adapters with separately reviewed environment and publication
authority. An older Core without those adapters has an explicit capability limitation; its workspace
grant cannot be repurposed into lifecycle or publication authority.
Repositories without a registered source binding retain their authorized repository workflow;
the guidance does not create bindings or permission grants implicitly.

## Canonical Environment, Publication And Work Lifecycle

Direct OAuth/manual callers use Core API/MCP without installing Harness or creating a chat. Application
callers use the same domain services through their current installation, initiating user and reviewed
permissions. Creator identity records attribution; authorized same-user access is not limited to the
client that originally created the resource. Other-user resources and revoked source access remain denied.

Environment discovery uses `mcp:environments-read`; mutations additionally require
`mcp:environments-manage`. Child API/setup needs the distinct `mcp:environment-api` scope. Registered
source inputs also require workspace authority. `environment_consent` validates a proposed creation;
it does not grant authority or start a child. Create, start, stop, restart and Finish retain their
UUID/revision checks. Status reports observed process identity and readiness. Optional task/conversation
references do not determine the environment's lifetime. Active or unknown registered consumers block
Stop, Restart and Finish until their owners provide exact stop evidence; disconnect and elapsed time
are not evidence. Source cleanup and test-data disposal remain separate operations.

Publication reads require workspace plus `mcp:publication-read`; remote publication mutations also
require `mcp:publication-write` and a current authorized source-provider connection. `/api/publications/v1`
and `pr_*` MCP operations compose existing configure, commit, push, publish, link, review, ready, merge,
completion and corrective-cycle services. They retain selected-file review receipts, expected heads,
request fingerprints and current actor checks. A read grant never creates remote publication authority.
Connection discovery and cached observations revalidate the acting user; unavailable or ambiguous
provider facts do not imply successful publication or cleanup eligibility.

`/api/workflows/v1` and `workflow_*` tools expose status, pause, resume and completion for a registered
aggregate workspace. Pause first prepares a closure; confirmation follows stopped consumers under the
same request. Completion consumes fresh publication evidence. Harness retains responsibility for
stopping its own native writers and releasing leases before a queued handover; it cannot establish
stop merely by submitting a completion tool call. None of these operations deletes conversations or
Finishes independent environments.

A normal external workflow prepares source, edits/builds/tests it, creates and starts a separate test
Core, verifies readiness and normal password identity, exports useful evidence and Finishes that test
Core. Publication then uses the authorized provider with exact-head review and retained request IDs.
After a lost reply, observe or repeat the original request and arguments. Do not invent a replacement
UUID, copy another application's credentials or switch the ordinary Core to bypass unavailable support.

## Native Git And Provider Reconciliation

Core observes native edits and commits from Git, including the current branch, HEAD, dirty files and
ancestry. An interrupted managed merge can be reconciled when native Git has completed the exact
recorded merge: both expected parents must be ancestors and no merge remains in progress. Dirty
source is preserved. Uncertain or incompatible state stays explicit rather than being marked complete.

Authorized provider observation can discover an externally created PR on the exact repository and
branch. Discovery does not fabricate a Core push/publication receipt or automatically set a reviewed
published head. Explicit `pr_link` verifies the selected repository, branch and head before adoption;
multiple candidates, foreign forks, unrelated refs and unavailable authority retain their refusal or
unknown outcome. The canonical adapter preserves the original creator and records the current actor.
An existing PR or native push never bypasses exact-head completion, active-consumer or cleanup checks.

## Workspace Tools And Recovery

Every external workspace tool derives the administrator and principal from the current direct Core
credential and rechecks authority. Callers do not supply another administrator, principal or
assistant installation. Workspace source-byte reads and diff reads require `mcp:workspaces` too.
Read-only credentials and delegated facade connections cannot acquire this authority implicitly.
Revocation stops future Core calls; it does not remove the external program's existing operating
system access to a directory it already received. These instructions coordinate trusted local work
and do not create a Hosty filesystem sandbox.

An authorized administrator can delete unwanted work through the same [Delete operation](../workspace-lifecycle-controls/feature.md#unified-delete-and-recovery)
from Harness or MCP. Dirty/unmerged source and retained leases are warnings, not permission gates.
The UI confirms once; MCP Ask/Run/Disabled is the broker's approval point. Core requires no second
review, typed name, prior inspection, completion or pause.

| Core tool | Purpose |
| --- | --- |
| `prepare_workspace(requestId, taskId, appId, leaseId, targetBranch?, label?)` | Prepare or reuse this task's installed-app source binding |
| `list_workspaces(taskId?, includeReleased?)` | List all authorized Core workspaces, including released records by default |
| `get_workspace(workspaceId)` | Observe the binding and inspect durable `operations` and leases |
| `get_workspace_diff(workspaceId, path, view?)` | Preview a repository-relative path; `session` is the default view |
| `refresh_workspace(workspaceId, requestId)` | Fetch the target without changing the workspace branch |
| `commit_workspace(workspaceId, requestId, expectedHead, message, paths, authorName, authorEmail)` | Commit the explicitly selected paths with attribution and a HEAD check |
| `merge_workspace_target(workspaceId, requestId, expectedHead, message, authorName, authorEmail)` | Explicitly integrate the latest target into clean source |
| `abort_workspace_merge(workspaceId, requestId, expectedHead)` | Abort a pending integration with a HEAD check |
| `acquire_workspace_lease(workspaceId, requestId, leaseId)` | Record durable activity before native work |
| `release_workspace_lease(workspaceId, requestId, leaseId)` | Release known stopped activity |
| `record_workspace_pull_requests(workspaceId, requestId, pullRequests)` | Associate existing HTTPS PR URLs for read-only provider observation; never publish or prove merge |
| `delete_workspace(requestId, workspaceId?, workspaceIds?, all?)` | Delete one logical workspace or a fixed collection without a Core confirmation |

Generate a new request UUID for each intentional managed mutation. Retain its original arguments.
After a lost response, retry the same operation with that same UUID and arguments; do not guess that
it failed and create a new request. Reusing an ID with different arguments is refused. After uncertain
preparation, retry `prepare_workspace` before editing an assumed directory. For later operations,
inspect `get_workspace` and its durable `operations`; accepted or pending is not success. An unknown
result needs explicit recovery from the recorded command and actual Git state, not blind repetition.

Git changes follow the user and repository's authority. In this repository, creating a commit needs
an explicit user request; a development request or a checked deliverable does not authorize one.
Authorized commits use Conventional Commits, a detailed body and the committing agent's own
`Co-Authored-By` trailer. Do not squash or rewrite existing commits unless explicitly requested.
Use a regular merge commit for repository PRs. Push, PR publication, merge and app runtime source
selection remain separate workflows with their own authority; this workspace scope grants none of
them implicitly.

Deletion is explicit and follows the user's requested selection. If the task says to remove only
completed and merged work, verify those predicates before selecting targets. An unconditional Delete
removes unfinished source too. Never delete Core's shared repository/cache or unrelated directories
manually. Keep request IDs after a timeout; bulk retries retain the original target allocations.
The legacy `cleanup_workspace` MCP entry is retired; accepted old cleanup/discard operations retain
recovery compatibility. See [workspace authority](../external-workspace-access-continuity/feature.md).

## Workspace Runtime Activation

[Workspace activation](../workspace-live-activation/feature.md) composes explicitly bound applications
and repository-matched Core with a reviewed selection, supervised handover and individual/group
Return. Runtime consumers persist independently of workspace Close and sandbox Finish. Core
participation requires separate Core authority; ordinary source or lifecycle access is insufficient.
Return preserves current data and live source edits.

## Testing Expectations

- Exercise external PR observation with multiple references, remote head changes, provider errors,
  malformed or unrelated URLs, expired/disconnected/ambiguous accounts, owner access loss and
  persisted observations. Include linked PRs whose working branch differs from the workspace, and
  preserve head-repository, target-branch, canonical-URL and selected-account checks. Verify that
  current and legacy metadata snapshots expose no completion/private-review evidence, and that
  branch mismatches still refuse exact-source review, merge, completion and cleanup evidence.
  Verify that no publication command or source cleanup is created.
- Verify the exact GitHub query against a real PR and inspect state, checks, review summaries and
  connection loss through Core-managed Workspaces after normal browser login.
- Preserve legacy owner JSON, allocation IDs, preparation argument fingerprints, persisted records,
  original bases and Harness session bindings through upgrade/restart.
- Exercise real OAuth consent and PKCE redemption, token refresh, same-grant tasks, independent grants,
  manual credentials, expiry/revocation, client deletion, current administrator role and Core-only scopes.
  Read-only/browser/device credentials cannot create external allocations or read workspace diffs.
  Independently named applications require the canonical source permission and current initiating user.
- Retain local workspace access after provider authorization changes; omit malformed records
  individually and require current user/app permission on every read or operation.
- Check same-request replay, conflicting arguments, cross-actor access, native commits and uncommitted
  plan edits, acting-user provider authority, clearing/rebinding/revocation and interrupted recovery.
- Keep activity leases through disconnect/restart; explicit Delete accepts dirty, conflicted,
  unmerged and leased source. Never infer deletion authority from elapsed time or a PR URL.
- Verify a real local client against a Core-managed instance with ordinary password login and OAuth
  consent. Use the returned directory, verify distinct target/workspace progress and two logical tasks,
  inspect the Core/Plans responses and UI, revoke authority and preserve source until authorized cleanup.
- Exercise canonical source/publication callers, cross-creator same-user access, revoked admission, native
  commits, discovered-but-unlinked PRs and exact-head linking without fabricating remote mutations.
- Run managed sessions/tasks/pull-requests integration with independent users, same-repository apps, an
  additional dependency repository, reconnect/replay and owner-confirmed test-resource removal.
- Run affected Core/MCP and Plans tests, exact Core build, Native AOT publish, lint/production app build,
  version consistency, canonical documentation validation and repository diff checks.

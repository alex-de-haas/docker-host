---
created: 2026-10-07
updated: 2026-10-07
summary: Local external agents prepare authorized Core-owned Git worktrees through direct MCP, with separate workspace progress in Plans.
components: [apps/core, apps/plans]
---

# External Development Workspaces

## Registry And Ownership

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
the current credential, administrator, OAuth grant/client and source grant. Browser-only, device,
app and delegated credentials do not establish this external authority. Other Core operation scopes
remain independent. Existing Harness session tools keep their installed-app authorization.

Preparation selects an installed app's declared repository and optional target branch. It returns
a Core-owned absolute directory, registered branch, target branch and original base. External
preparation requires an explicit activity lease and accepts no assistant session path. Native file
edits and commits in that directory appear through the existing observer. Private-source reads and
operations revalidate current reviewed source ownership; cleared, rebound or revoked grants do not
restore earlier managed access from cached observations.

## Plans Presentation

[Plans](../plan-tracking/feature.md) displays `External / Codex` or the chosen agent label beside the
workspace's branch, status and observed time. Missing conversation links are expected for external
owners. Tracked-branch progress and each workspace's progress remain independent, including
uncommitted plan edits. Observation errors stay visible with their evidence time. Existing assistant
links and older payloads without external metadata retain their original presentation.

Shell's development section links to source-capable tools. It does not read workspace source or gain
additional permissions for this feature.

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
retains that binding. A newly authorized grant is a new principal and does not inherit the old
one's source. Tasks within one grant are separate allocations but share its authority. A task ID,
agent label or conversation ID is not an authorization boundary. Use separate grants when separate
authority is required. Core records no imported conversation and provides no external-session URL.

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

## Workspace Tools And Recovery

Every external workspace tool derives the administrator and principal from the current direct Core
credential and rechecks authority. Callers do not supply another administrator, principal or
assistant installation. Workspace source-byte reads and diff reads require `mcp:workspaces` too.
Read-only credentials and delegated facade connections cannot acquire this authority implicitly.
Revocation stops future Core calls; it does not remove the external program's existing operating
system access to a directory it already received. These instructions coordinate trusted local work
and do not create a Hosty filesystem sandbox.

| Core tool | Purpose |
| --- | --- |
| `prepare_workspace(requestId, taskId, appId, leaseId, targetBranch?, label?)` | Prepare or reuse this task's installed-app source binding |
| `list_workspaces(taskId?, includeReleased?)` | List this principal's workspaces, including released records by default |
| `get_workspace(workspaceId)` | Observe the binding and inspect durable `operations` and leases |
| `get_workspace_diff(workspaceId, path, view?)` | Preview a repository-relative path; `session` is the default view |
| `refresh_workspace(workspaceId, requestId)` | Fetch the target without changing the workspace branch |
| `commit_workspace(workspaceId, requestId, expectedHead, message, paths, authorName, authorEmail)` | Commit the explicitly selected paths with attribution and a HEAD check |
| `merge_workspace_target(workspaceId, requestId, expectedHead, message, authorName, authorEmail)` | Explicitly integrate the latest target into clean source |
| `abort_workspace_merge(workspaceId, requestId, expectedHead)` | Abort a pending integration with a HEAD check |
| `acquire_workspace_lease(workspaceId, requestId, leaseId)` | Record durable activity before native work |
| `release_workspace_lease(workspaceId, requestId, leaseId)` | Release known stopped activity |
| `record_workspace_pull_requests(workspaceId, requestId, pullRequests)` | Associate existing HTTPS PR URLs without publishing or proving merge |
| `cleanup_workspace(workspaceId, requestId, expectedHead)` | Explicitly request conservative source cleanup |

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

Cleanup is an explicit operation after the user/repository has authorized it. Core refuses dirty,
unavailable, conflicted, leased, unmerged or runtime-consumed source. Ordinary cleanup freshly checks
that the workspace HEAD is included in the target; a recorded PR URL or a reported merge is not
proof. Never force removal or manually delete Core's tree or shared bare repository to bypass a
refusal. Durable leases do not expire with time; an administrator releases abandoned activity only
after checking that its native consumer stopped. Released metadata remains available for inspection.

## Testing Expectations

- Preserve legacy owner JSON, allocation IDs, preparation argument fingerprints, persisted records,
  original bases and Harness session bindings through upgrade/restart.
- Exercise real OAuth consent and PKCE redemption, token refresh, same-grant tasks, independent grants,
  manual credentials, expiry/revocation, client deletion, current administrator role and Core-only scopes.
  Read-only, browser, device, app and delegated credentials cannot call workspace tools or read diffs.
- Check same-request replay, conflicting arguments, owner isolation, native commits and uncommitted
  plan edits, effective private-source ownership, clearing/rebinding/revocation and interrupted recovery.
- Keep activity leases through disconnect/restart; refuse dirty, conflicted, unmerged, unavailable,
  leased and runtime-consumed cleanup. Never infer deletion authority from elapsed time or a PR URL.
- Verify a real local client against a Core-managed instance with ordinary password login and OAuth
  consent. Use the returned directory, verify distinct target/workspace progress and two logical tasks,
  inspect the Core/Plans responses and UI, revoke authority and preserve source until authorized cleanup.
- Run affected Core/MCP and Plans tests, exact Core build, Native AOT publish, lint/production app build,
  version consistency, canonical documentation validation and repository diff checks.

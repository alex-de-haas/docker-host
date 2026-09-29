# Assistant Pull Request Lifecycle

Created: 2026-09-29
Updated: 2026-09-29

Core owns GitHub.com publication records for registered session workspaces. The assistant chooses
when to commit, publish a draft or ready PR, resolve addressed feedback, merge, complete and request
cleanup. Core validates and executes those requests and observes remote facts independently. A passed
check does not schedule a merge. Core does not own the conversation or decide its workflow.

## Authority And Storage

The internal API extends the workspace owner tuple: assistant app ID and installation, administrator
user ID and session ID. Every request needs both the app service token and a current user credential
addressed to that app, the existing `apps.workspaces.manage` grant and the new
`apps.publications.manage` installation grant. Install Core 0.114.0 before updating Harness 0.37.0;
review the new permission during the app update. Editing a manifest alone does not grant it.

Each publication explicitly selects one of the user's GitHub connections. Core uses the existing
per-user connection lock and refresh path; another user's connection cannot substitute for it.
Provider credentials stay in Core, including authenticated Git push. Credentials are passed through
process environment overrides, with configured credential helpers, redirects and hooks suppressed.
They are absent from MCP configuration, API responses, operation records and audit details.
The external read-only facade and delegated Core MCP grants remain read-only.

Local agents still have the accepted cooperative working-directory contract. This API does not claim
exclusive Git access or a filesystem sandbox. Native edits and commits are observed by the existing
workspace service; PR facts come from GitHub, including actions taken outside Core.

Records live under `core/development/publications/<workspace-id>.json`, with owner-only atomic writes.
A mutation records its UUID, kind, immutable argument fingerprint and pending intent before remote
side effects. Retry the same request and arguments after an uncertain response. A different request
cannot overtake a pending operation. PR discovery reconciles matching source repository, branch and
base before creating a PR; multiple matches or incomplete observations fail closed. A confirmed merge
can be recovered without invoking merge again. Failed operations retain their errors and identity.

## Operations

Routes are under `/api/internal/apps/{appId}/sessions/{sessionId}/publications`:

- `GET /` lists durable records; `GET /connections` lists the user's GitHub connection summaries.
- `GET /{workspaceId}` refreshes the provider observation.
- `POST /{workspaceId}/{kind}` accepts a UUID `requestId` and operation-specific arguments.

Harness exposes these as `pr_list`, `pr_connections`, `pr_status`, `pr_configure`, `pr_commit`,
`pr_publish`, `pr_link`, `pr_ready`, `pr_resolve_review`, `pr_merge`, `pr_corrective`, and `pr_complete`
on its authenticated local `hosty-workspaces` MCP server. The service token never enters the native
agent. Calls use the [shared MCP approval policy](../assistant-approval-rules/feature.md), including
writes and merge; there is no separate PR approval toggle.

Configure binds a canonical HTTPS GitHub.com repository to a concrete connection. It selects the
upstream when the account can push, otherwise creates/verifies a fork in the upstream network.
An explicit `fork` also selects this path. Provider restrictions, fork creation delay, missing PAT
permissions and unavailable identities produce actionable errors rather than assumed success.
Configuration includes dependencies and completion requirements and is locked after publication.

`pr_commit` uses the user's explicit Git profile, otherwise the connected GitHub account's verified
primary email and name. OAuth device authorization requests email-read access; an older connection
may need reconnection or explicit profile identity. Authentication is not Git attribution. A commit
operation retains its resolved author for recovery. Harness records the contributing adapter;
Core retains contributors and adds missing Co-Authored-By trailers. Recorded contributors are also
retained in merge/squash messages. Ordinary workspace/native commits keep their explicit attribution.
Repository commit and merge instructions remain the agent's responsibility.

Publish requires a clean active worktree and exact `expectedHead`, pushes that commit without force,
and creates or updates the PR title/body. `draft` selects creation posture; `pr_ready` marks an existing
draft ready. Updating an already-ready PR does not turn it back into a draft. Link validates an
existing PR number against repository, branch, target and current workspace head. Review observations
include thread IDs, paths, lines and bounded comment text as provider data. Thread resolution is an
explicit request for feedback already addressed and verified, never an automatic merge-gate shortcut.

Merge refreshes GitHub state immediately before submitting its SHA-bound merge request. The PR must
be open, non-draft and cleanly mergeable, with the requested head, no unresolved review threads,
no blocking/required review decision and no failed, pending or unknown checks. GitHub enforces its
repository protection and allowed merge methods. Core defaults to a regular merge; squash/rebase
require an explicit method and remain subject to repository policy.

## Observation And Completion

A Core background service observes draft, ready and completed-contribution PRs every thirty seconds,
without an open browser or model turn. It rechecks the assistant installation/grant and enabled user,
then uses the selected connection. Unavailable provider access is a timestamped unavailable result.
Old observations do not count as fresh evidence. Observed external merges are facts, not proof that
Core authorized them. No automatic merge or cleanup follows an observation alone.

Each observation separates PR state, head, draft state, mergeability, CI/review results and completion.
Merged PRs retain their merged state when release verification is unavailable. Completion policy
explicitly chooses exact check names, workflow IDs and artifact selectors; an empty policy means
merge itself supplies the post-merge evidence. Workflow observations select the actual merge SHA and
target branch, rather than a moving latest-main badge. Unknown, missing or failed evidence blocks
merged completion. Supported artifact selectors are:

- `release`: exact Git tag resolving to the merge commit and an uploaded asset on its published release.
- `npm`: public npm package name and exact semantic version, with matching `gitHead` and integrity metadata.
- `ghcr`: public GHCR image name and exact semantic-version tag; runnable manifests' config digests,
  source repository labels and revision labels must match the merge commit. Public registry reads
  receive no GitHub credential. Missing metadata or private artifacts are unavailable evidence.

Dependencies are workspace IDs within the same owner/session. Core rejects cycles and missing or
foreign resources. A dependent publish/merge waits for dependencies to merge and satisfy their exact
artifact conditions. Operations remain per repository, preserve partial outcomes and revalidate each
merge; they are not an atomic cross-repository transaction.

A corrective operation preserves the merged PR reference and starts a fresh remote publication branch
for the same registered checkout. Subsequent publish creates a new PR; the prior merged PR is not
updated. The assistant performs required source corrections/target integration in the worktree and
can explicitly configure the new cycle's release selectors before publication.

Complete accepts `merged`, `submitted` or `abandoned`. Merged requires verified post-merge evidence;
submitted requires the intended open PR and records **Submitted for review**, without waiting for an
upstream maintainer. The published head must equal the clean workspace head. Other session workspaces
must have published, verified or explicit dispositions; incomplete dependencies remain blockers.
An abandoned disposition is explicit and is not displayed as successful completion. Unpublished work
can be abandoned without inventing a PR; automatic publication cleanup is refused because it lacks
a remote recovery reference. Explicit workspace cleanup retains its ordinary checks. A completed
contribution's recorded outcome does not change when a maintainer later merges or closes it.

Harness saves session PR references before requesting completion. Core also retains provider/repository,
PR URLs, submitted heads and corrective history after checkout removal. Optional cleanup is a durable
request, rechecked by the observer: current publication evidence, unchanged clean files, no conflicts,
no activity leases and no active source/runtime consumers. Submitted or squash-merged work can use
publication evidence instead of local commit ancestry. Dirty or in-use work is preserved. Source
merge, artifact publication, installation and runtime selection remain separate facts.

Harness's Source workspaces section displays Core state, PR links, CI/review status, pending/failed
operations, completion and observation freshness. Publication mutations are requested through the
agent; there are no new Publish/Merge/Complete buttons. Existing workspace controls remain available.

## Testing Expectations

- Verify ownership, installation/permission revocation, connection ownership and credential exclusion.
- Exercise lost create/merge responses with identical retry IDs, changed arguments, external actions,
  mismatched PR associations, stale heads, failed/unknown CI and unresolved reviews.
- Verify verified/user-configured attribution, commit retry identity and retained contributors.
- Exercise dependency cycles, incomplete multi-workspace dispositions, corrective branch history and
  exact merge-bound checks/artifacts, including unavailable release evidence after a confirmed merge.
- Verify submitted and merged cleanup preserves dirty files, active leases and runtime consumers, and
  retains provider history after removing the worktree.
- Test real local MCP transport, Ask/Run unprompted/Disabled, ownership, cancellation and restart
  recovery without duplicate native approval, plus both adapters' proxy configuration.
- Build Core including Native AOT, run Core/Harness tests, build Harness/Shell and test profile controls.
  Live provider acceptance requires a configured GitHub account and a disposable contribution target;
  fixtures do not prove an account's actual token scopes or organization policy.

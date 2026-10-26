---
created: 2026-10-07
updated: 2026-10-26
summary: Core source-document access, target freshness and workspace projections for Documents and other authorized readers.
components: [apps/core, apps/documents, apps/harness, apps/shell, packages/app-sdk]
---

# Plan Tracking

## Application

[Documents](../documents-app/feature.md) is the current first-party reader. It includes the original
plan/version comparison, discussion, translation and optional read-only MCP behavior, with navigation
for all supported documentation kinds. This feature owns the Core document transport and plan
projection semantics; Documents owns its current screens and application actions.

## Repository And Workspace Projection

Core derives repository entries from installed apps' source declarations and deduplicates them by
canonical repository identity and tracked branch. An unreleased workspace whose repository/target
branch has no installed-app entry contributes a workspace-derived entry. Preparing and releasing
workspaces remain listed with unknown document changes when their worktree is unreadable.

The projection reuses the repositories and target refs owned by
[development workspaces](../assistant-session-workspaces/feature.md). A workspace's own changes are
measured from the merge base of its current `HEAD` and the current target ref. Uncommitted edits
count. A document whose worktree bytes already equal the tracked branch is omitted, including
content integrated by a merge commit, squash or cherry-pick. Harness's `SessionFiles` retains its
original-base meaning.

Session URLs use the owning assistant installation's actual browser origin. The path must remain
on that origin. Removing or reinstalling the assistant removes the URL and supplies a reason while
retaining the workspace and its document changes.

Private repositories require a current Git source grant owned by the acting administrator. Core
checks the installed app's reviewed grant or the matching workspace's effective grant on each
request, including cached-ref reads. After source-app removal the original administrator can use
the workspace fallback for the matching baseline and their own workspace. Another administrator
cannot inherit that fallback. Reviewed clearing, rebinding and revoked connections invalidate the
old access. Credentials remain in Core.

Private workspace base and worktree reads use the authorized local repository and target ref;
provider downtime does not prevent reading local changes while the reviewed grant remains valid.
Tracked-branch reads retain their target-fetch freshness checks.

Serving public documents requires a recent successful anonymous fetch of that target commit.
Credentialed fetches invalidate that proof; their cache or in-flight transport cannot establish
public access after a grant is cleared. Anonymous Git transport suppresses inherited credentials
and refuses repository transport overrides. Known providers normalize equivalent repository URLs;
an existing equivalent workspace keeps its registered object store. Conflicting legacy stores
remain visible as unavailable entries instead of being silently reassigned.

## Core Document Contract

The app declares `apps.sources.read`. The independent `apps.sources.full` permission controls the
existing source tools. Legacy `apps.sources` declarations normalize to `apps.sources.full`, and
startup migrates persisted declarations and grants before unsupported-grant cleanup. An unchanged
Harness retains its reviewed authority on upgrade. `sources.connections` remains separate.

Every source-document request supplies the calling app's service-token bearer and an acting-user
credential in `X-Hosty-User-Token`. Core verifies the current read grant and administrator role. It
accepts an active app session, an invocation credential addressed to that app by the assistant MCP
relationship, or an app-scoped access token with `mcp:read`. Discovery-only MCP credentials and
mixed Core session cookies are refused. This exception for MCP credentials is confined to these
read endpoints.

The endpoints under `/api/internal/apps/{appId}/source-documents` are:

| Method and path | Result |
| --- | --- |
| `GET /repositories` | Entries, installed-app mappings, current target commit and fetch time; unavailable entries retain their reason. |
| `GET /repositories/{repositoryId}/documents` | Document paths, blob SHAs, sizes and referenced-path metadata for `version=target`, `base` or `worktree`; workspace versions require `workspaceId`. `refresh=true` refreshes the target. Optional `path` limits the listing to one document. |
| `GET /repositories/{repositoryId}/content` | One document's UTF-8 content and SHA, using the listed `commit` for target/base or `expectedSha` for worktree, plus `path`, `version` and optional `workspaceId`. |
| `GET /workspaces` | Unreleased workspace state, names, heads, local-change flags, recorded PR observations and document changes; optional `repositoryId` selects one entry. |
| `GET /events` | Authorized source invalidation stream; optional `repositoryId` scopes its subscription. Ready/ping/change/revocation events carry no workspace IDs or document bytes. |

Only repository-relative `docs/**/*.md` content is served. Absolute paths, traversal, symlinks and
non-regular files are refused. Documents are limited to one MiB and listings to 10,000 documents.
Target/base content reads refuse stale or arbitrary commits; worktree reads refuse a changed blob.
An absent valid focused path returns an empty document list, allowing workspace-only detail views.
Returned SHAs describe the exact served bytes, using the shared repository's Git object format.
Responses use `Cache-Control: no-store`.

Document references contain only `{ path, exists, isDirectory }` for components and relative links
mentioned by that document. They allow the parser to validate references without exposing content
outside `docs/` or a general repository listing. Reference metadata is bounded to 512 paths per
document; exceeding the bound produces an explicit error. Full listings also enforce a 64 MiB
aggregate metadata budget while they are built. An oversized listing fails explicitly; a focused
document listing can still be requested without constructing the full result.

Reference extraction handles LF and CRLF documents identically on every Core host, including
Windows. Only the temporary parsing text is normalized; document bytes and Git blob SHAs remain
unchanged for tracked branches, workspace bases and working copies.

Target fetches share an in-flight operation per repository and branch with workspace preparation,
refresh and merge. Ordinary reads reuse a fetch for 30 seconds; explicit refresh joins an existing
fetch or starts a fresh one. Transport has a 30-second deadline and a 128 MiB repository-growth
limit. A fetch does not hold a global workspace lock. The observer skips a workspace owner busy in
a managed mutation and continues observing other owners.

Visible document subscriptions use the same fetch window for installed and workspace-derived
sources. Target refresh stays on schedule even while workspace events arrive. Events are scoped to
currently authorized workspaces and revalidated after changes and heartbeat; dropped events cause
invalidation. This adds no recurring worktree scans or implicit merges. Documents revalidates on
reconnect and visibility return, and older Core versions use explicit refresh.

Core caches immutable Git tree metadata, document listings and blob bytes in a shared 64 MiB,
1,024-entry LRU keyed by the registered repository and commit or blob SHA. Concurrent loads of the
same snapshot share their work. Cold full listings read blobs through Git's binary `cat-file
--batch` protocol; warm listings avoid rebuilding the snapshot. Focused detail listings read only
the requested document and its reference metadata. Every request still resolves current access,
public proof and the target/base version before using cached values. Mutable worktree bytes and
their reference metadata are read afresh and never enter this immutable cache.

The app's source client allows 75 seconds for fetch, queued transport and local metadata work;
caller cancellation still interrupts the request. This covers Core's 30-second fetch budget without
ending an otherwise valid cold read after 15 seconds.

## Parsing, Cache And MCP

The parser follows the [documentation workflow](../documentation-workflow/feature.md): its strict
frontmatter subset, dates, summaries, components, document headings, relative links, the single
Deliverables section and stable `D<n>` IDs. Fenced examples do not count as deliverables or links.
Rejected documents show errors and unknown progress.

The disk SHA cache is limited to 32 MiB, evicts least recently accessed entries and verifies Git
blob hashes. A separate 32 MiB memory LRU reuses validated parsing results for the same SHA, document
path and current reference metadata. Core authorizes a current listing for the acting administrator
before any cache hit is served. Changed reference metadata triggers validation again; neither cache
stores an access decision. Cache storage failure does not prevent an authorized read.

The read-only MCP endpoint is `/api/mcp`. `list_plans`, `get_plan` and `plan_workspaces` return
tracked-branch state, workspace versions, errors and detail links. Each request introspects its
app-addressed MCP credential through Core, requires `mcp:read` and a current administrator, and
passes the same credential to the document API. The app's agent guidance is in
[apps/documents/docs/agent.md](../../../apps/documents/docs/agent.md).

## Runtime And Release

Documents ships independently as hosty.documents 0.8.0 from apps/documents. The new source stream
and current PR projections ship in Core/CLI 0.156.0. The manifest requires apps.sources.read; assistant,
panel and translation permissions remain optional. Ordinary install/remove replaces the former
hosty.plans app without copying its grants. See [Documents](../documents-app/feature.md#distribution-and-ownership).

## Testing Expectations

- Core tests cover repository/branch discovery, private grants and revocation, public-proof isolation,
  bounded UTF-8/reference metadata, stale commits and SHAs, cache authority, worktree deletion and
  separate base/target/local facts. Unrelated reader app IDs use the same contract.
- Stream tests cover administrator and app/source permissions, scoped hints and revocation. Shared
  fetch tests verify coalescing, the freshness window, provider failures and caller cancellation.
- Documents tests cover parser/cache/MCP parity, exact version selection, independent workspace
  counts, completing versus removed labels, optional permission failure, assistant retry/provider
  pinning and translation cancellation/source fingerprints.
- npm run test:integration -- documents verifies normal password identity, a Docker reader and
  real Git/worktree edits in a managed child Core, including target integration and workspace removal.
- Browser acceptance uses normal Core/Shell embedding with separate users/data and keeps provider
  or device-specific limitations explicit. The Documents feature owns current screen expectations.

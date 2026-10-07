---
created: 2026-10-07
updated: 2026-10-07
summary: Administrator plan overview across installed source repositories and unreleased development workspaces, backed by bounded Core document reads.
components: [apps/core, apps/plans, apps/harness, apps/shell, packages/app-sdk]
---

# Plan Tracking

## Application

`hosty.plans` is an administrator runtime app in `apps/plans`. Markdown in Git is its source of
truth. The app displays each tracked branch's plans and the separate versions in development
workspaces; its disk cache contains derived document bytes, with validated parsing results cached
separately in memory.

The interface uses free ReUI components, ShadCN primitives and Tailwind 4 with the same semantic
theme tokens as Shell and Harness. ReUI frames hold the document comparison panes; shared inputs,
selects, toggle groups, badges, progress, alerts and empty states provide the workbench controls.

The overview shows plans across repositories and branches, status counts and deliverable progress,
and supports title/summary search and repository, app and status filters in the Data Grid header.
The URL preserves the filters. Repository loads run independently with at most three concurrent
loads. One failed repository has its own error, and invalid documents remain visible with unknown progress.
Loaded rows appear as each repository finishes. A compact spinner and repository count indicate
remaining initial or explicitly requested loads; existing rows stay visible while an update is pending.
Automatic background revalidation is quiet and pauses while the document is hidden.
Initial document loads use the same compact indicator.

The overview uses a sortable Data Grid with pages of 10 or 20 rows. Rows retain detail links,
tracked-branch progress, explicit repository/branch/app labels and workspace counts. Expanding a
row shows each workspace's status, progress, last change, observation and links. Workspace progress
never replaces a missing or unavailable tracked-branch version. Sorting and pagination do not write
Markdown or change source status.

Plans new in a workspace appear beside tracked-branch plans. A deleted plan has the label
`completing` only when the same workspace creates or changes that folder's `feature.md`; otherwise
its label is `removed`. The label identifies the evidence and does not introduce a plan status.

The detail view displays the tracked-branch document and selectable workspace versions, status and
progress, deliverable changes, a diff against the workspace's base, and an assistant-session link
when available. A URL can select a workspace. A notice identifies a document also changed on the
tracked branch. Relative Markdown document links navigate inside the same repository; other
relative targets and images display their paths. Documents are rendered without raw HTML.

Open pages re-read every 20 seconds. Refresh sources requests a fresh target fetch. A workspace
marker means that the workspace changes the plan; it makes no claim about current agent activity.
Unavailable workspace observations display their state, observation time and reason.

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
| `GET /workspaces` | Unreleased workspace state and document-change projections; optional `repositoryId` selects one entry. |

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

Target fetches share an in-flight operation per repository and branch with workspace preparation,
refresh and merge. Ordinary reads reuse a fetch for 30 seconds; explicit refresh joins an existing
fetch or starts a fresh one. Transport has a 30-second deadline and a 128 MiB repository-growth
limit. A fetch does not hold a global workspace lock. The observer skips a workspace owner busy in
a managed mutation and continues observing other owners.

Core caches immutable Git tree metadata, document listings and blob bytes in a shared 64 MiB,
1,024-entry LRU keyed by the registered repository and commit or blob SHA. Concurrent loads of the
same snapshot share their work. Cold full listings read blobs through Git's binary `cat-file
--batch` protocol; warm listings avoid rebuilding the snapshot. Focused detail listings read only
the requested document and its reference metadata. Every request still resolves current access,
public proof and the target/base version before using cached values. Mutable worktree bytes and
their reference metadata are read afresh and never enter this immutable cache.

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
[apps/plans/docs/agent.md](../../../apps/plans/docs/agent.md).

## Runtime And Release

The manifest provides Docker and Core-managed local `dev` profiles, an app cache target and a
feed. The development HTTP port is 3600 before Core port allocation. The Docker image runs the
standalone Next.js server as the cache mount's unprivileged owner. The image workflow gates
publication on version checks, lint and tests and follows the repository's immutable version-tag
policy. It builds Linux amd64 and arm64 images with provenance attestations, carrying the repository
and ReUI license notices.
`manifest.json`, `package.json` and the Docker image tag share the independent app version `0.1.0`.

## Testing Expectations

- HTTP authorization covers absent/read/full grants, current administrator role, app sessions,
  app-addressed assistant MCP and scoped credentials, mixed cookies, audience mismatch and revocation.
- Repository and worktree tests cover deduplication, default branches, independent fetch freshness,
  shared in-flight fetches, stale commits/SHAs, path and size guards, symlinks and UTF-8 bytes.
- Workspace tests cover integrated target changes, merge/squash/cherry-pick equality, concurrent
  target edits, new/deleted documents, private fallback, clearing/rebinding/revocation, interrupted
  cleanup and removed/reinstalled assistant origins.
- Parser contract tests compare repository documents and valid/invalid fixtures with the canonical
  validator. Cache tests cover SHA verification, current authorization and eviction limits. App
  tests cover filters, counts, component mapping, workspace labels, detail links and MCP refusals.
- Browser checks cover Data Grid sorting, pagination, page size, search, quiet background reads and
  workspace expansion that persists across polling, with separate tracked and workspace progress.
- Integration verification uses Core-managed app lifecycle and normal password login in a separate
  data root, including Shell embedding and workspace changes. Core passes its tests and Native AOT
  publish; the app, Shell, Harness and SDK pass affected tests and builds.

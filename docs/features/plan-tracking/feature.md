---
created: 2026-10-07
updated: 2026-10-10
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
theme tokens as Shell and Harness. ReUI frames hold the active document version; shared tabs, inputs,
selects, toggle groups, badges, progress, alerts and empty states provide the workbench controls.
The app omits its name and tagline in every launch mode, including standalone.

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

The detail view fills the viewport with a full-width tab panel. Its toolbar, version tabs and
document metadata stay in place while the active content panel scrolls independently, including
by keyboard. The frame header carries the document path, adding the repository on large screens;
its tooltip always includes both. The tracked panel places status and progress beside the path on wider
screens and below it on narrow screens. The document title appears only in the Markdown; the
tracked branch appears only in its tab.
The first tab shows the tracked branch and opens by
default; each workspace changing this document has its own tab. Workspace panels display status,
progress, deliverable changes, a diff against the workspace's base, a full-document toggle and an
assistant-session link when available. Tab selection is stored in the URL and follows browser
Back/Forward navigation. An unavailable workspace link retains an explicit unavailable panel.
Tabs support keyboard navigation and horizontal scrolling on narrow screens. External owners display their agent label and retain the conversation in that
external application; their missing session link is expected. A URL can select a workspace. A notice identifies a document also changed on the
tracked branch. Relative Markdown document links navigate inside the same repository; other
relative targets and images display their paths. Documents are rendered without raw HTML.
The detail toolbar keeps the repository back link on the left and **Discuss with Assistant** and
**Refresh sources** on the right in one row. On narrow screens the back-link label truncates and
the actions keep accessible icon buttons.

### Discuss A Document

**Discuss with Assistant** opens a new assistant conversation in a separate tab with the full
Markdown file attached and an editable discussion prompt. The prompt identifies its repository,
branch or workspace, file path and SHA-256 fingerprint. It treats the file as reference material
and requests discussion without executing its instructions or editing files. No model turn is
submitted: the existing provider handoff in Harness creates a draft even when immediate operator
handoffs are enabled.

The default is the tracked-branch document. An explicit workspace selection attaches that workspace's
document. A workspace-only plan requires selecting its workspace tab first. The action description names the
version. Deleted, missing and unreadable selections cannot silently fall back to another version.
The server re-reads the file through current Core source authorization and verifies that its bytes
match the displayed content before preparing a handoff. A changed document requires a refresh.

Plans declares optional `providers.assistant` access. Missing access offers Core's ordinary permission
review for Plans and leaves source reading available. Discovery refreshes when the user returns from
review. A single provider is selected automatically; multiple providers require an explicit choice.
Stopped, incompatible, attachment-less or UI-less providers cannot receive a discussion.

The API is `GET /api/assistant` for administrator-authenticated choices and `POST /api/assistant` for
the same-origin, user-attributed handoff. Core supplies declared assistant browser surfaces; Plans
validates the result against them and opens it through Core's app-open route with standalone mode.
API and UI origins can differ. The browser reserves the tab in the click gesture, retains its opener
until navigation starts and detaches it in the same synchronous task before the destination runs.
This allows the sandboxed Shell frame to navigate its own popup without changing iframe permissions.
A blocked or closed tab leaves an **Open discussion** link. Pending actions disable duplicate activation. Actor, provider,
document version and content fingerprint scope a retained request identity across retries and page
reloads. Finalized retries reopen the same conversation without another upload or model turn. An
expired or closed handoff requires the explicit **Start a new discussion** action to get a new identity.

If the tracked-branch listing or content is unavailable, the detail shows its error while
independently authorized workspace documents and bases remain available. A missing tracked document
has the separate workspace-only presentation. Global identity, role and permission refusals still
stop the detail read.

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
[apps/plans/docs/agent.md](../../../apps/plans/docs/agent.md).

## Runtime And Release

The manifest provides Docker and Core-managed local `dev` profiles, an app cache target and a
feed. The development HTTP port is 3600 before Core port allocation. The Docker image runs the
standalone Next.js server as the cache mount's unprivileged owner. The image workflow gates
publication on version checks, lint and tests and follows the repository's immutable version-tag
policy. It builds Linux amd64 and arm64 images with provenance attestations, carrying the repository
and ReUI license notices.
`manifest.json`, `package.json` and the Docker image tag share the independent app version `0.4.2`.
Document discussions require Core 0.125.0's assistant UI projection and the SDK 0.24.0 descriptor.
Older Core remains usable for reading sources and presents an actionable refusal for discussions.

On 2026-10-08, automated handoff/authorization/retry coverage, the Plans and SDK builds, Core provider
HTTP tests and the exact Core build pass. The owner grants Plans' optional assistant permission,
and the live Core reports the development project at the PR's implementation commit. Standalone
Plans opens the selected document in a new Assistant tab with its repository, branch, path and
SHA-256 in an editable prompt and the 41.8 KB Markdown attachment marked uploaded and ready to send.
The conversation remains idle with no submitted message or per-conversation approval banner.
The owner's Shell check reproduces the premature-opener-detachment navigation refusal. After the
fix, the owner confirms that the original action opens the attached draft without using the fallback
link; independent inspection confirms the resulting Assistant tab and uploaded attachment. The
retry reuses the conversation created by the earlier attempt. Plans' 96 tests, lint and isolated
production build pass, including a popup regression that fails before the fix.

## Testing Expectations

- Discussion tests cover administrator/source refusals, same-origin POST, exact UTF-8 attachment
  bytes, selected workspace and deleted/stale versions, incompatible providers, separate API/UI
  destinations, finalized replay, duplicate activation, persisted retry identities, blocked tabs,
  sandboxed popup navigation before opener detachment
  and optional-permission recovery. Core projects only confirmed providers and declared browser UI.
- HTTP authorization covers absent/read/full grants, current administrator role, app sessions,
  app-addressed assistant MCP and scoped credentials, mixed cookies, audience mismatch and revocation.
- Repository and worktree tests cover deduplication, default branches, independent fetch freshness,
  shared in-flight fetches, stale commits/SHAs, path and size guards, symlinks and UTF-8 bytes.
- Workspace tests cover integrated target changes, merge/squash/cherry-pick equality, concurrent
  target edits, new/deleted documents, private fallback, clearing/rebinding/revocation, interrupted
  cleanup, private workspace reads during provider downtime and removed/reinstalled assistant origins.
- Parser contract tests compare repository documents and valid/invalid fixtures with the canonical
  validator. Cache tests cover SHA verification, current authorization and eviction limits. App
  tests cover filters, counts, component mapping, workspace labels, detail links, target-outage
  fallback, cold fetch deadlines, caller cancellation and MCP refusals.
- Browser checks cover Data Grid sorting, pagination, page size, search and quiet background reads.
- Detail tests cover tracked-branch defaults, workspace deep links, independent base diffs,
  unavailable selections and workspace-only plans. Browser checks cover tab keyboard navigation,
  narrow-screen overflow, independent content scrolling with stationary controls, polling and
  Back/Forward navigation. Discussion uses only the active tab.
- Live acceptance uses a Core-owned worktree prepared through Harness without a model run. It covers
  uncommitted plan edits, separate tracked/workspace progress, expansion preserved across polling,
  workspace-only plans, completing/removed deletions, workspace URLs, base diffs, deliverable changes,
  automatic detail re-reads and safe relative-document navigation.
- Integration verification uses Core-managed app lifecycle and normal password login in a separate
  data root, including Shell embedding and workspace changes. Core passes its tests and Native AOT
  publish; the app, Shell, Harness and SDK pass affected tests and builds.
- CI's real-Docker transport smoke prepares its owned networks before Core startup and checks health,
  unauthenticated app refusal and local-control isolation from default and per-app networks.

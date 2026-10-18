---
created: 2026-10-09
updated: 2026-10-14
summary: Workspace and source inspection, pull-request evidence, and optional child Core sandbox creation, preview and lifecycle controls.
components: [apps/workspaces, apps/core, apps/harness, apps/shell]
---

# Workspaces App

Hosty Workspaces (`hosty.workspaces`, version `0.3.1`) is an ordinary runtime app. It consumes
Core's [workspace inspection contract](../assistant-session-workspaces/feature.md) under the
reviewed `apps.workspaces.read` permission and the current administrator's app identity. It has
no provider interface, MCP surface, source mutation controls or conversation storage.

## Inventory And Navigation

The inventory groups every authorized repository worktree under its owning session or typed
external work reference. Clean workspaces remain visible. Search matches repositories, working
branches, app names, owners and references; filters select current, all, changed, attention or
released history. Unknown source state is distinct from zero changed files. A problem in one
repository does not replace the other children with an aggregate success or failure.

`/?workspace=<aggregate-id>&worktree=<worktree-id>` selects a workspace and optional repository.
Shell's embedded `path` parameter preserves this query when opening a direct link.
An invalid selection does not silently open another worktree. Wide layouts show inventory beside
details; narrow layouts provide an All workspaces return action. The owning assistant's current
installation supplies Open session. External agents show their label/task without an invented
conversation link. Missing assistant installations retain an explanation.

Shell discovers the app's manifest navigation entry. The previous Development workspaces launcher
below Core is removed. Harness's source-worktree cards offer Open in Workspaces using a Core-resolved
URL bound to that session/worktree. No default-assistant or provider registry is needed.

## Worktree Views

The selected repository shows working/target branches, original and integration bases, observed
HEAD, its path on Core's host and observation time. Each child retains independent status, errors,
app bindings and PRs.

- **Changes** names the comparison explicitly: original base to current files or local uncommitted
  changes. It shows Git file status, file-to-app directory matches, bounded text diffs and up to 100
  commits since preparation. Binary/image changes direct the operator to a source editor. Target
  ahead/behind uses the last fetched target; refreshing the view does not fetch Git. Conflicts are
  explicit. Released or unreadable worktrees do not report a clean current source state.
- **Pull requests** lists multiple references and authorized recorded provider observations. CI,
  review summaries, published-head differences and observation age are explicit. A URL without
  evidence shows an unobserved state with its connection or refresh explanation. External workspace
  references use Core's existing provider observer every 30 seconds with the owner's source connection.
  Observations older than 90 seconds are labelled stale;
  historical PR references do not imply current checks or aggregate completion.
- **Applications** lists explicit installation/subpath bindings. Matching a file to a directory is
  navigation help, not exhaustive dependency analysis; shared/unmapped files remain visible.
- **Activity** shows known source overrides and Core-registered local service consumers, retained
  lease IDs and recorded Core operation outcomes. Pending/unknown operations direct recovery to
  the original request ID in the owning session. Leases do not prove that an agent is running.

The app reads on entry, explicit refresh and every 20 seconds while visible. Failed reads clear
previous source content; changed selection aborts outstanding requests. Core and BFF responses
are not cached. Source inspection exposes no fetch, merge, commit, publish or source-cleanup action.
Sandbox lifecycle controls below operate on separate child Core environments.

## Sandbox Environments

With separately reviewed `core.environments.inspect` and `core.environments.operate` grants, an
administrator creates a [child Core sandbox](../app-sandbox-runtimes/feature.md#shell-and-workspaces-controls)
from active workspace worktrees. The panel supports the current Core build or a selected relative
Core project, normal test-account setup, observed app status, authenticated preview, Start/Stop and
confirmed complete deletion. Sandbox deletion preserves source. The Shell dashboard provides the
same inventory/lifecycle view across workspaces. These controls do not grant source mutation rights.
Application installation uses existing child Core/Harness workflows; worktree attachment alone does
not install an application. The earlier single-app sandbox inventory remains a separate section.

## Runtime And Identity

Docker runs a standalone Next.js build as a non-root user; the local `dev` runtime is started by
Core from the source checkout and uses the assigned HTTP port. The health endpoint is `/healthz`.
The app publishes an independent manifest/version, image workflow and `app-feeds.0.1` feed.

The shared SDK owns app-code exchange, session recovery, administrator gating, theme and launch
mode. Standalone entry displays the app title; embedded/native entry hides duplicate app chrome.
The server forwards only its service token and this app's current user credential to the bounded
Core read routes and the bounded sandbox UI routes. It cannot forward arbitrary Core paths,
arbitrary child API transport or source mutation requests.

The app exposes the SDK GET/POST adapter at `/api/hosty/ui/[...action]` behind the existing
administrator session gate. It supplies host verification, navigation metadata and tool resolution,
so Shell policy hides app navigation after reloads and standalone navigation finishes loading.

## Testing Expectations

- Verify sandbox creation with current/source Core, normal test-account setup, app preview and
  confirmed Finish through Shell embedding. Assert source retention and complete child cleanup.
- Cover administrator/grant requirements, cross-origin mutation denial and bounded proxy paths.


- SDK UI routes cover authenticated bootstrap/navigation/panels reads, same-origin navigation
  resolution, and rejection of anonymous, non-administrator and cross-origin requests.

- Run app lint, production build and Vitest coverage for filtering, clean/unknown/history states,
  path-boundary app mapping, safe links, stale PR evidence and invalid deep links.
- Verify that a displayed diff and source paths disappear after authorization is revoked.
- Run Core inspection/source/publication tests for aggregate identity, access revocation,
  independent repositories, bounded diffs and provider correlation; run the Native AOT check.
- Test normal password login and standalone/embedded navigation on a separate Core data root.
  Prepare real worktrees through the scoped external MCP flow, change one repository and keep
  another clean, then inspect diffs, PR unknown state and recorded operations in the browser.
- Verify the layout at narrow and wide breakpoints and that Shell's former launcher is absent.
- Run affected Shell and Harness checks, manifest version consistency and documentation validation.

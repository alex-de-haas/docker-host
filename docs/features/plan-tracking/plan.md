---
status: Ready
created: 2026-10-06
updated: 2026-10-06
summary: An administrator app that shows every plan across the installed apps' source repositories, with status, progress and the assistant sessions working on it.
components: [apps/core, apps/harness, apps/shell, packages/app-sdk]
---

# Plan Tracking App

## Goal

Plans and features are Markdown in Git, spread over every app's repository. Reading them file by
file gives no overview: which plans exist, in which state, how far along, when they last moved, and
which assistant sessions are changing which plan right now. This app answers those questions from
the documents themselves, read through Core, without becoming a second source of truth.

The document format it reads is the one [documentation workflow](../documentation-workflow/feature.md)
defines and validates in every repository: YAML frontmatter (`status`, `created`, `updated`,
`summary`, `components`) and stable `D<n>` deliverable IDs.

## Owner Direction (2026-10-05 – 2026-10-06)

- Markdown in Git stays the single source of truth. External trackers and a plan database were
  considered and rejected; the app is a read-only view, and anything it stores is a derived cache.
- A separate runtime app, `hosty.plans` in `apps/plans` of docker-host — not part of Harness and
  not a Core module.
- Administrators only.
- Repositories come only from the `source` declarations of installed apps' manifests. Media Server
  has a development runtime and therefore must declare its `source`; it gains one.
- The app shows the **current state of each plan**: the version on the tracked branch is the
  baseline, and every active session whose worktree changes the plan is shown beside it, with its
  version of the plan and a link to the session. Several sessions may change the same plan at once;
  each is shown, and none is merged into the baseline.
- Uncommitted worktree changes count: a session is linked to a plan from its first edit.
- Freshness relies on what Core already maintains for session workspaces — the shared repositories,
  their target refs and the twenty-second worktree observer — rather than a separate polling
  mechanism.
- The read permission is `apps.sources.read`. The existing `apps.sources` is renamed
  `apps.sources.full` so the two names describe what they grant.
- Translation, summarization and other AI functions are out of scope; the general app-to-agent
  interface they depend on is parked.
- Approved for implementation on 2026-10-06.

## Current Behavior

Verified against `main` at `024b369a`.

- **Shared repositories.** Core keeps one bare repository per canonical source at
  `core/development/repositories/<sha256(repository)>.git`
  ([session workspaces](../assistant-session-workspaces/feature.md)). It creates one when an
  assistant prepares a session workspace and fetches the target branch — an explicit development
  branch, else the manifest's `source.branch`, else the repository's default — into
  `refs/hosty/targets/<hash(branch)>` on preparation and on the workspace `refresh` operation.
  Private repositories are fetched with the Git grant persisted on the installed app
  (`PrivateSources.Git`), which names the connection and its owner chosen at the app's reviewed
  installation ([private app sources](../private-app-sources/feature.md)); a workspace adopts that
  grant only when its owner is the workspace's administrator.
- **Session workspaces.** Each record names its owner (assistant app, administrator, session id),
  repository, branch `hosty/session/<id>`, original base, session UI path and pull request
  references. Core's observer refreshes every twenty seconds; its observation includes
  `SessionFiles`, the files changed against the original base, uncommitted and untracked files
  included.
- **Authority.** `apps.sources` grants workspace preparation, Git operations, source diffs,
  personal source connections and publication; Harness declares it. No permission reads repository
  documents without also granting those mutations. At startup Core removes persisted grants whose
  names it does not know (`AppPermissionMigration`), so a renamed permission without a migration
  would silently drop existing grants.
- **App sources.** An installed app's record holds its manifest `source` (repository, branch,
  manifest subpath), managed checkout and local override. Shell, Harness, Marketplace, Telemetry and
  the Demo App share the docker-host repository. Media Server declares no `source`, although its
  manifest has a `dev` local-command profile that runs from source.

## Target Behavior

### Core: permissions

- **`apps.sources.read`** grants reading the documentation of installed apps' source repositories
  and nothing else. Every call additionally requires an administrator user, checked on each request
  like other app-delegated operations.
- **`apps.sources.full`** replaces `apps.sources` with the same grant. Core migrates persisted
  declarations and grants from the old name at startup, before unsupported grants are removed, and
  keeps accepting `apps.sources` in a manifest as an alias, so an installed Harness keeps working
  until it is updated. Harness declares the new name. Shell's source-tool gate — which finds
  source-capable apps by their granted permission and drives the development-workspace and private-
  source views — recognizes the new name, and review descriptions, Shell's permission texts and SDK
  references follow.

### Core: repository documents

- **Repositories.** A list of entries, one per canonical repository and tracked branch behind
  installed apps' `source` declarations, so a monorepo whose apps share a branch appears once. Apps of
  one repository that track different branches yield one entry per branch, each the baseline for its
  own apps; no branch is chosen arbitrarily. Each entry carries the apps it serves with their manifest
  subpaths and declared `source.paths`, the last fetched commit and time, and an availability
  state with its error.
- **Tracked branch and freshness.** The tracked branch follows the rule session workspaces already
  use for their target, and it is read from the same `refs/hosty/targets/<hash(branch)>` ref in the
  same shared repository — never a second registry. Freshness is tracked per repository and branch,
  because each fetch updates one branch's ref: a read fetches that ref when its own last fetch is
  older than a short interval, at most once per repository and branch per interval; an explicit
  refresh bypasses the interval; and workspace preparation and `refresh` keep updating the same
  ref, so their fetches count as that branch's last fetch and serve the app too. Nothing polls remotes in the background. Fetches are bounded in
  time and size.
- **Private repositories.** No new connection selection exists. A fetch uses the Git grant already
  persisted on an installed app of that repository, and only when the grant's owner is the acting
  administrator — the rule session workspaces apply. When no such grant exists, for example because
  another administrator connected the source, the entry is listed as unavailable with that reason
  and its documents are not served. A session-derived entry whose source app is gone falls back to
  the grant stored on the workspace itself, as workspace fetches already do, and serves it only to
  that workspace's administrator; to everyone else it is unavailable with the reason. Public
  repositories need no grant.
- **Documents.** For the tracked branch, or for a session workspace's worktree including its
  uncommitted changes, Core lists `docs/**/*.md` with path and blob SHA, and returns one document's
  content. Nothing outside `docs/`, nothing but Markdown, no symbolic links, and a size cap per file.
- **Sessions.** A read-only projection of active session workspaces: workspace id, repository,
  target branch, assistant app, session id, an absolute session URL, administrator, branch,
  observation time, the subset of `SessionFiles` under `docs/`, and pull request references. Core
  builds the session URL from the assistant app's browser origin and the recorded session path and
  refuses a path that would leave that origin, so the app needs neither `apps.read` nor its own
  origin lookup. The URL exists only while the workspace's owning installation — app id and
  installation time — is still installed; after the assistant is removed or reinstalled the session
  stays in the projection, because its worktree changes remain, with no URL and the reason, and is
  never linked to a different installation. A session belongs to the entry with the same repository
  and tracked branch as its target. Any active session without such an entry — its explicit target
  branch is one no installed app tracks, or the app it was prepared for has since been uninstalled —
  adds a session-derived entry for its repository and target branch, marked as such, whose baseline
  is the target ref the workspace already fetched; the entry exists only while an active session
  needs it, so no session disappears; for a private repository its documents follow the private
  rule above. No Git operation is reachable.

### The app

- **Shape.** `hosty.plans`, a Next.js runtime app in `apps/plans` using `@hosty-sdk/app` for
  identity, like Marketplace and Telemetry UI. It declares `apps.sources.read`, an
  administrator-only UI, `docker` and `dev` profiles, and its own feed and image workflow.
- **Parsing.** The frontmatter is a strict YAML subset, so the app reads it with a standard YAML
  parser and applies the validator's deliverable rule (`- [ ] D<n>. ` under `## Deliverables`).
  Contract tests run the parser over docker-host's own `docs/` so a format change cannot silently
  diverge from the validator.
- **Overview.** Every plan across repositories as it stands on the tracked branch — status,
  progress (`done/total`), `updated` date, repository and apps — with counts per status and filters
  by repository, app, status and age. A plan that active sessions are changing carries a marker with
  the number of sessions and each session's version in brief, such as `In Progress · 5/9`. A plan
  that exists only in a session's worktree appears as new in that session, and a plan a session
  deletes while writing its `feature.md` appears as being completed. `components` map to apps
  through each installed app's declared source paths — its manifest subpath plus `source.paths`, so
  `apps/telemetry-backend` and `apps/telemetry-ui` both map to Telemetry; the repository listing
  carries these paths per app. In a single-app repository the repository is the app.
- **Detail.** The tracked-branch version rendered with Marketplace's safe Markdown rules, and
  deliverables with their IDs and state. A relative link to another `docs/**/*.md` document of the
  same repository opens that document in the app; any other relative target — a source file outside
  `docs/`, or a non-Markdown file — renders as plain text with its repository path, and a relative
  image as its alt text and path, because Core serves nothing else. Beside the document, one entry
  per session changing the plan: the session's status, progress and `updated` date, the
  deliverables it checks off or adds, a diff of the document against the tracked branch, the last
  observation time, and the session URL from Core's projection.
- **Live updates.** Session links come from the observer's `SessionFiles`. While a page is open the
  app re-reads the session projection on the observer's twenty-second cadence; Core publishes no
  new event for it.
- **Cache.** Parsed documents are cached by blob SHA in the app's cache directory; nothing the app
  stores is authoritative, and deleting the cache loses nothing. The cache holds content, never an
  access decision: every request first asks Core for the document listing with the acting
  administrator's credential, and only blob SHAs Core has just returned for that request may be
  served from the cache. A private document one administrator loaded is therefore never served to
  another whom Core refuses.
- **Agents.** An app-owned MCP interface offers read-only tools — list plans, get a plan, sessions
  changing a plan — that return the tracked-branch state together with the session versions, plus an
  agent skill file, so an agent can ask what is in progress across repositories. A tool call carries
  a `hosty_mcp.1` credential, which ordinary app-session validators reject, so Core's document and
  session endpoints explicitly accept, as the acting-user credential, an MCP credential addressed to
  the calling app. Core validates it exactly as MCP introspection does — relationship, installations,
  parent grant and current user — and applies the same administrator and private-grant checks to that
  credential's user. The acceptance covers only these read endpoints, never other Core APIs.

### Media Server

Media Server's manifest declares `source` for its repository, which its `dev` runtime needs for an
installation that does not come from a local folder; its documents then appear like every other
app's.

## Deliverables

### Phase 1 — Core

- [ ] D1. `apps.sources.read`: catalogue entry, review description, endpoint mapping and the
      per-request administrator check; the document and session endpoints also accept an MCP
      credential addressed to the calling app as the acting-user credential, validated like MCP
      introspection. HTTP tests for refusal without the grant, for a non-administrator user, for an
      app-mediated call, for an MCP credential of an administrator and of a non-administrator, and
      for an MCP credential presented to any other Core API.
- [ ] D2. Rename `apps.sources` to `apps.sources.full`: startup migration of persisted declarations
      and grants ahead of unsupported-grant removal, the legacy name accepted as an alias in
      manifests, Harness's manifest and code, Shell's source-tool gate with its test fixtures, Shell's
      permission texts and SDK references updated, with tests for an upgraded host that keeps
      Harness's grant and still lists it as a source tool in Shell.
- [ ] D3. Repository listing from installed apps' `source` declarations, deduplicated by canonical
      identity and tracked branch, reading the workspace target refs with interval-limited fetches
      on read, an explicit refresh, and private access only through an installed app's persisted Git
      grant owned by the acting administrator.
- [ ] D4. Document listing and content for the tracked branch and for session worktrees (uncommitted
      changes included), restricted to `docs/**/*.md` with size caps and symlink refusal; Native AOT
      serialization and path-guard tests.
- [ ] D5. The read-only session workspace projection, including the `docs/` subset of
      `SessionFiles` and an absolute session URL validated against the assistant app's origin, absent
      with a reason once the owning installation is removed or reinstalled; a session-derived entry
      for any active session without an installed-app entry (an untracked explicit target branch, or
      an uninstalled source app).

### Phase 2 — App

- [ ] D6. `apps/plans` scaffold: `hosty.plans` manifest with `apps.sources.read`, administrator-only
      UI, `docker` and `dev` profiles, SDK identity, feed, image workflow, and version sources
      registered in `scripts/check-versions.mjs`.
- [ ] D7. Frontmatter and deliverable parsing with contract tests against docker-host's `docs/`, and
      the blob-SHA cache, served only for SHAs Core has just authorized for the acting
      administrator.
- [ ] D8. Overview: tracked-branch state, session markers with each session's version in brief,
      plans new or being completed in sessions, status counts, filters and component-to-app mapping.
- [ ] D9. Detail: the rendered tracked-branch version beside each session's version, with status and
      progress changes, deliverable changes, a document diff and a link to the session; in-app
      navigation between documents and plain-text rendering of other relative targets; live re-reads
      while the page is open.

### Phase 3 — Integration

- [ ] D10. Read-only MCP tools returning tracked-branch state with session versions, calling Core
      with the tool call's MCP credential, and an agent skill file.
- [ ] D11. Media Server's manifest declares `source`, in a Media Server PR, verified to leave its
      `docker` runtime unchanged and to let a feed installation switch to `dev`.
- [ ] D12. `feature.md` for this feature, the Core API, permission and session workspace documents
      updated, this plan deleted and the index regenerated.

## Versioning

- Platform (Core and CLI): minor, for the new permission, the rename and the document endpoints.
- Harness: minor, for the renamed permission in its manifest; installed after Core.
- `hosty.plans`: a new app starting at `0.1.0`.
- Shell: a patch, for the renamed permission's source-tool gate, texts and tests.
- SDK packages: a patch where a permission reference changes.
- Media Server: per its own rules, in its own PR.

## Interactions

- **[Session workspaces](../assistant-session-workspaces/feature.md):** the app reuses the shared
  bare repositories, the target refs and the observer's `SessionFiles`; it must not create a
  competing repository registry, as [ai-agent-bridge](../ai-agent-bridge/plan.md) step 12 also
  requires.
- **[Development sessions](../assistant-development-sessions/plan.md):** the umbrella adds no
  separate development task entity. The app stays a view over plans and sessions and never becomes
  a task store.
- **[Documentation workflow](../documentation-workflow/feature.md):** the frontmatter and
  deliverable rules are the app's input contract; a format change updates the validator, its tests
  and the app's parser together.
- **[App permission management](../app-permission-management/feature.md) and
  [app installation](../app-installation-sdk/feature.md):** both permissions go through the existing
  declaration, review and grant flow; the rename must not force re-review of an unchanged Harness.
- **[Core extension model](../core-extension-model/plan.md):** an ordinary app with one new
  permission; no contribution point is involved.

## Verification

- Core HTTP tests: permission and administrator checks, the rename migration on an upgraded data
  root, path guards (`..`, symlinks, non-Markdown, outside `docs/`, oversized files),
  private-repository access through a grant owned by the acting administrator and the unavailable
  entry for another administrator's grant, two apps of one repository on different branches, the
  per-branch fetch interval (a fetch of one branch never marks the other fresh) and explicit
  refresh, a session worktree read that includes an uncommitted change, and a session whose assistant
  was reinstalled keeping its changes but losing its URL, a session whose source app was
  uninstalled (readable by its own administrator through the workspace grant when private,
  unavailable to others), and a session targeting a branch no app
  tracks appearing under its own entry.
- App tests: parsing against docker-host's `docs/`, status counts and progress, component-to-app
  mapping, session markers for a changed, a new and a deleted plan, and two sessions changing one
  plan.
- Live: install the app through Core with the local runtime profile, sign in as an administrator
  through Shell, see plans from docker-host and a sibling repository, then edit a `plan.md` in an
  assistant session worktree and see the session's version within one observer cycle. Update an
  existing Harness after Core and confirm its workspace operations keep working.
- `npm run core:test`, `npm run core:aot`, the Harness and app tests and builds,
  `node scripts/check-versions.mjs` and `node scripts/docs-index.mjs --check`.

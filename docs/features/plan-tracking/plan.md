---
status: Ready
created: 2026-10-06
updated: 2026-10-07
summary: An administrator app that shows every plan across the installed apps' source repositories, with status, progress and the development workspaces changing it.
components: [apps/core, apps/harness, apps/shell, packages/app-sdk]
---

# Plan Tracking App

## Goal

Plans and features are Markdown in Git, spread over every app's repository. Reading them file by
file gives no overview: which plans exist, in which state, how far along, when they last moved, and
which development workspaces are changing which plan. This app answers those questions from the
documents themselves, read through Core, without becoming a second source of truth.

The document format it reads is the one [documentation workflow](../documentation-workflow/feature.md)
defines and validates in every repository: YAML frontmatter (`status`, `created`, `updated`,
`summary`, `components`) and stable `D<n>` deliverable IDs.

## Owner Direction (2026-10-05 – 2026-10-07)

- Markdown in Git stays the single source of truth. External trackers and a plan database were
  considered and rejected; the app is a read-only view, and anything it stores is a derived cache.
- A separate runtime app, `hosty.plans` in `apps/plans` of docker-host — not part of Harness and
  not a Core module.
- Administrators only.
- Repositories come only from the `source` declarations of installed apps' manifests. Media Server
  has a development runtime and therefore must declare its `source`; it gains one. Refined during
  review: the one exception is a workspace's own repository and target branch when no
  installed-app entry covers them (see Workspaces below), so that no workspace disappears.
- The app shows the **current state of each plan**: the version on the tracked branch is the
  baseline, and every workspace that changes the plan is shown beside it, with its version of the
  plan and a link to the assistant session it was prepared for. Several workspaces may change the
  same plan at once; each is shown, and none is merged into the baseline.
- **Workspaces, not sessions** (2026-10-07). The unit the app tracks is the development workspace
  Core already keeps: one worktree on its own branch, with an owner and a state, prepared for an
  assistant session. A conversation with an agent is also a session, so the app names workspaces
  and shows the session as a link on its workspace. A workspace exists until it is released, whether
  or not an agent is working in it; the app says a plan is changed in N workspaces and never claims
  that an agent is working on it.
- **A workspace's own changes** (2026-10-07). What a workspace changed is measured from its base on
  the tracked branch, not as its difference from the tracked branch's current state, which also
  holds other work merged since. Work the tracked branch merged after the workspace started never
  appears as the workspace's change or as a revert.
- Uncommitted worktree changes count: a workspace is linked to a plan from its first edit.
- **Deleted plans** (2026-10-07). Deleting `plan.md` both completes a plan and abandons one, so the
  deletion alone says nothing. The workflow's completion rule — the change that completes the last
  deliverable also creates or updates `feature.md` — decides the label: a workspace that deletes a
  plan and changes the same folder's `feature.md` is completing it, and one that deletes it without
  that is removing it. No `Cancelled` status is added to the documentation workflow. On the tracked
  branch a deleted plan simply leaves the overview.
- Freshness relies on what Core already maintains for development workspaces — the shared
  repositories, their target refs and the twenty-second worktree observer — rather than a separate
  polling mechanism.
- The read permission is `apps.sources.read`. The existing `apps.sources` is renamed
  `apps.sources.full` so the two names describe what they grant.
- Translation, summarization and other AI functions are out of scope; the general app-to-agent
  interface they depend on is parked.
- Approved for implementation on 2026-10-06; the refinements dated 2026-10-07 were approved on
  2026-10-07.

## Current Behavior

Verified against `main` at `2562a34b`.

- **Shared repositories.** Core keeps one bare repository per canonical source at
  `core/development/repositories/<sha256(repository)>.git`
  ([session workspaces](../assistant-session-workspaces/feature.md)). It creates one when an
  assistant prepares a session workspace and fetches the target branch — an explicit development
  branch, else the manifest's `source.branch`, else the repository's default — into
  `refs/hosty/targets/<hash(branch)>` on preparation, on the workspace `refresh` operation and on
  `merge`. Private repositories are fetched with the Git grant persisted on the installed app
  (`PrivateSources.Git`), which names the connection and its owner chosen at the app's reviewed
  installation ([private app sources](../private-app-sources/feature.md)); a workspace adopts that
  grant only when its owner is the workspace's administrator. Every workspace's worktree shares its
  repository's object store, so one repository holds the commits of all its workspaces.
- **Development workspaces.** Each record names its owner (assistant app, administrator, session
  id), repository, branch `hosty/session/<id>`, original base, integration base, session UI path and
  pull request references. Its state stays `active` until the workspace is released and says nothing
  about whether an agent is working. Core's observer refreshes every twenty seconds; its observation
  includes `SessionFiles`, the files changed against the original base, uncommitted and untracked
  files included. Because that base never moves, after the workspace integrates the target branch
  `SessionFiles` also lists the files the target changed, and a file the workspace changed stays
  listed after the target has merged it. The integration base advances only through Core's `merge`
  operation, not when an agent merges in the worktree itself.
- **Serialization.** Workspace preparation and commands, their fetches included, and every observer
  pass run under one lock for the whole workspace service, so a slow fetch of one repository delays
  every workspace.
- **Authority.** `apps.sources` grants workspace preparation, Git operations, source diffs, selecting
  existing source connections and publication; Harness declares it. Managing personal connections is
  the separate `sources.connections`, which Shell declares
  ([source providers](../source-providers/feature.md)), and selecting connections for a private
  installation accepts either. No permission reads repository documents without also granting those
  mutations. At startup Core removes persisted grants whose names it does not know
  (`AppPermissionMigration`), so a renamed permission without a migration would silently drop
  existing grants.
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
  until it is updated. Harness declares the new name. Checks that accept `apps.sources` or
  `sources.connections` for selecting a connection accept `apps.sources.full` in its place;
  `sources.connections` itself is unchanged. Shell's source-tool gate — which finds source-capable
  apps by their granted permission and drives the development-workspace and private-source views —
  recognizes the new name, and review descriptions, Shell's permission texts and SDK references
  follow.

### Core: repository documents

- **Repositories.** A list of entries, one per canonical repository and tracked branch behind
  installed apps' `source` declarations, so a monorepo whose apps share a branch appears once. Apps of
  one repository that track different branches yield one entry per branch, each the baseline for its
  own apps; no branch is chosen arbitrarily. Each entry carries the apps it serves with their manifest
  subpaths and declared `source.paths`, the last fetched commit and time, and an availability
  state with its error.
- **Tracked branch and freshness.** The tracked branch follows the rule development workspaces
  already use for their target, and it is read from the same `refs/hosty/targets/<hash(branch)>` ref
  in the same shared repository — never a second registry. Freshness is tracked per repository and
  branch, because each fetch updates one branch's ref: a read fetches that ref when its own last
  fetch is older than a short interval, at most once per repository and branch per interval; an
  explicit refresh bypasses the interval; and workspace preparation, `refresh` and `merge` keep
  updating the same ref, so their fetches count as that branch's last fetch and serve the app too.
  Nothing polls remotes in the background. Fetches are bounded in time and size.
- **Shared fetches.** Fetches of one repository and branch are shared: while one runs, a read or a
  workspace preparation, `refresh` or `merge` that needs the same fetch waits for it instead of
  starting another. A read never waits behind a workspace operation or another repository's fetch,
  so a slow or unreachable remote delays only its own entry.
- **Private repositories.** No new connection selection exists. A fetch uses the Git grant already
  persisted on an installed app of that repository, and only when the grant's owner is the acting
  administrator — the rule development workspaces apply. When no such installed-app grant is
  available, an active workspace for the same canonical repository and target branch may supply its
  effective Git grant, whether the workspace belongs to an installed-app entry or a
  workspace-derived entry. Core resolves it by the existing workspace rules, including reviewed
  rebinding or clearing and current connection-validity checks; both the workspace's administrator
  and the grant's owner must be the acting administrator. This fallback authorizes the entry's
  baseline and that administrator's matching workspace documents, never another administrator's
  worktree through that grant. Thus, if the source app is uninstalled but another app still tracks
  the same repository and branch under another administrator's grant, the original administrator
  retains access through their workspace. With neither an owned installed-app grant nor an eligible
  workspace grant, the entry is listed as unavailable with the reason and its documents are not
  served. Public repositories need no grant.
- **Documents.** For the tracked branch, for a workspace's base, or for a workspace's worktree
  including its uncommitted changes, Core lists `docs/**/*.md` with path and blob SHA, and returns
  one document's content. Nothing outside `docs/`, nothing but Markdown, no symbolic links, and a
  size cap per file.
- **One version per read.** A listing and the content read after it belong to one version. Every
  content read names what it expects — the commit a tracked-branch or base listing reported, or the
  blob SHA of a worktree file — and Core serves it only while that still holds: after the ref moves,
  the base changes or the file is edited, the read is refused as a conflict and the app lists again.
  The response carries the blob SHA of the bytes it returned. Core never serves an arbitrary commit,
  only the entry's current commit or a workspace's current base, because the shared repository also
  holds every other workspace's commits.
- **Workspaces.** A read-only projection of active development workspaces: workspace id, repository,
  target branch, assistant app, session id, an absolute session URL, administrator, branch,
  observation time, pull request references, and the workspace's document changes.
  - Document changes are measured from the workspace's base — the merge base of its `HEAD` and the
    tracked branch's target ref, computed when the projection is read — to its worktree,
    uncommitted and untracked files included, limited to `docs/`. Each change carries its path, its
    kind (added, modified, deleted), the file's modification time when it exists, and whether the
    tracked branch has also changed that document since the base. The base follows integration
    however it happens, through Core's `merge` or an agent's own `git merge`, and a change the
    tracked branch has since merged leaves the list. `SessionFiles` keeps its meaning for Harness
    and is not used for this.
  - Core builds the session URL from the assistant app's browser origin and the recorded session
    path and refuses a path that would leave that origin, so the app needs neither `apps.read` nor
    its own origin lookup. The URL exists only while the workspace's owning installation — app id
    and installation time — is still installed; after the assistant is removed or reinstalled the
    workspace stays in the projection, because its worktree changes remain, with no URL and the
    reason, and is never linked to a different installation.
  - A workspace belongs to the entry with the same repository and tracked branch as its target. Any
    active workspace without such an entry — its explicit target branch is one no installed app
    tracks, or the app it was prepared for has since been uninstalled — adds a workspace-derived
    entry for its repository and target branch, marked as such, whose baseline is the target ref the
    workspace already fetched; the entry exists only while an active workspace needs it, so no
    workspace disappears; for a private repository its documents follow the private rule above.
  - No Git operation is reachable.

### The app

- **Shape.** `hosty.plans`, a Next.js runtime app in `apps/plans` using `@hosty-sdk/app` for
  identity, like Marketplace and Telemetry UI. It declares `apps.sources.read`, an
  administrator-only UI, `docker` and `dev` profiles, and its own feed and image workflow.
- **Parsing.** The frontmatter contract is the validator's strict YAML subset: the app parses it
  with a YAML parser restricted to that subset, keeps dates as strings, and treats anything the
  validator rejects as an error. Deliverables follow the validator's rule (`- [ ] D<n>. ` under
  `## Deliverables`), including its handling of fenced code blocks. Contract tests run the parser
  over docker-host's own `docs/` and over invalid fixtures — broken frontmatter, an unknown status,
  a duplicate deliverable ID, a checkbox outside `## Deliverables`, checkboxes inside a fenced code
  block — and require the app and the validator to accept and reject the same documents, so a format
  change cannot silently diverge from the validator.
- **Invalid documents.** A document the parser rejects stays visible as a card with its path and
  the parse error, and its progress is unknown. On the tracked branch this is rare, because CI
  validates it; in a worktree it is normal while an edit is under way.
- **Overview.** Every plan across repositories as it stands on the tracked branch — status,
  progress (`done/total`), `updated` date, repository and apps — with counts per status, a text
  search over titles and summaries, and filters by repository, app, status and age; search and
  filters live in the URL, so a filtered view can be linked. Repositories load independently with
  bounded concurrency: each repository's plans appear when its listing arrives, and a slow or
  unavailable repository shows its own state without holding back the others.
  - A plan that workspaces change carries a marker — changed in N workspaces — with each
    workspace's version in brief, such as `In Progress · 5/9`, and when the plan last changed there.
  - A plan that exists only in a workspace appears as new in that workspace.
  - A plan a workspace deletes is labelled from the facts, which the label shows: completing — plan
    deleted, `feature.md` updated — when the same workspace creates or changes `feature.md` in that
    feature folder, and removed — `feature.md` unchanged — otherwise. Deliverable progress is not
    used, because the last deliverable is usually checked in the change that deletes the file.
  - `components` map to apps through each installed app's declared source paths — its manifest
    subpath plus `source.paths`, so `apps/telemetry-backend` and `apps/telemetry-ui` both map to
    Telemetry; the repository listing carries these paths per app. In a single-app repository the
    repository is the app.
- **Detail.** The tracked-branch version rendered with Marketplace's safe Markdown rules, and
  deliverables with their IDs and state. A relative link to another `docs/**/*.md` document of the
  same repository opens that document in the app; any other relative target — a source file outside
  `docs/`, or a non-Markdown file — renders as plain text with its repository path, and a relative
  image as its alt text and path, because Core serves nothing else. Beside the document, one entry
  per workspace changing the plan: its status, progress and `updated` date, the deliverables it
  checks off or adds, a diff of its version against its base version — the workspace's own changes,
  so work the tracked branch merged since never looks reverted — a notice when the tracked branch
  has also changed the document since that base, the last change and observation times, and the
  session URL from Core's projection. The detail URL names the plan and optionally one workspace, so
  a link opens with that workspace's version selected.
- **Live updates.** Workspace links come from Core's workspace projection. While a page is open the
  app re-reads the projection on the observer's twenty-second cadence; Core publishes no new event
  for it.
- **Cache.** Parsed documents are cached by blob SHA in the app's cache directory, under the SHA
  Core reported for the bytes it returned, never a SHA from an earlier listing. The cache is bounded
  in size and evicts the least recently used entries; nothing the app stores is authoritative, and
  deleting the cache loses nothing. The cache holds content, never an access decision: every request
  first asks Core for the document listing with the acting administrator's credential, and only blob
  SHAs Core has just returned for that request may be served from the cache. A private document one
  administrator loaded is therefore never served to another whom Core refuses.
- **Agents.** An app-owned MCP interface offers read-only tools — list plans, get a plan, workspaces
  changing a plan — that return the tracked-branch state together with the workspace versions and
  the app's detail links, plus an agent skill file, so an agent can ask what is in progress across
  repositories. A tool call carries a `hosty_mcp.1` credential, which ordinary app-session
  validators reject, so Core's document and workspace endpoints explicitly accept, as the
  acting-user credential, an MCP credential addressed to the calling app. Core validates it exactly
  as MCP introspection does — relationship, installations, parent grant and current user — and
  applies the same administrator and private-grant checks to that credential's user. The acceptance
  covers only these read endpoints, never other Core APIs.

### Media Server

Media Server's manifest declares `source` for its repository, which its `dev` runtime needs for an
installation that does not come from a local folder; its documents then appear like every other
app's.

## Deliverables

### Phase 1 — Core

- [ ] D1. `apps.sources.read`: catalogue entry, review description, endpoint mapping and the
      per-request administrator check; the document and workspace endpoints also accept an MCP
      credential addressed to the calling app as the acting-user credential, validated like MCP
      introspection. HTTP tests for refusal without the grant, for a non-administrator user, for an
      app-mediated call, for an MCP credential of an administrator and of a non-administrator, and
      for an MCP credential presented to any other Core API.
- [ ] D2. Rename `apps.sources` to `apps.sources.full`: startup migration of persisted declarations
      and grants ahead of unsupported-grant removal, the legacy name accepted as an alias in
      manifests, the checks that accept `apps.sources` or `sources.connections` accepting the new
      name with `sources.connections` unchanged, Harness's manifest and code, Shell's source-tool
      gate with its test fixtures, Shell's permission texts and SDK references updated, with tests
      for an upgraded host that keeps Harness's grant and still lists it as a source tool in Shell.
- [ ] D3. Repository listing from installed apps' `source` declarations, deduplicated by canonical
      identity and tracked branch, reading the workspace target refs with interval-limited fetches
      on read, an explicit refresh, and private access through an installed app's persisted Git
      grant or the matching active-workspace fallback defined above, with ownership and current
      connection checks; fetches shared per repository and branch with workspace preparation,
      `refresh` and `merge`, and a read that never waits behind a workspace operation or another
      repository's fetch.
- [ ] D4. Document listing and content for the tracked branch, a workspace's base and a workspace's
      worktree (uncommitted changes included), restricted to `docs/**/*.md` with size caps and
      symlink refusal; every content read names the listed commit or expected blob SHA, returns the
      SHA of the bytes it served and is refused as a conflict once that no longer holds, and no
      arbitrary commit is served; Native AOT serialization and path-guard tests.
- [ ] D5. The read-only workspace projection: document changes under `docs/` measured from the
      merge base of the workspace's `HEAD` and the target ref, with change kind, modification time
      and whether the tracked branch changed the document since; an absolute session URL validated
      against the assistant app's origin, absent with a reason once the owning installation is
      removed or reinstalled; a workspace-derived entry for any active workspace without an
      installed-app entry (an untracked explicit target branch, or an uninstalled source app);
      matching workspaces in either entry kind use the private-grant rules above.

### Phase 2 — App

- [ ] D6. `apps/plans` scaffold: `hosty.plans` manifest with `apps.sources.read`, administrator-only
      UI, `docker` and `dev` profiles, SDK identity, feed, image workflow, and version sources
      registered in `scripts/check-versions.mjs`.
- [ ] D7. Frontmatter and deliverable parsing restricted to the validator's subset, with contract
      tests against docker-host's `docs/` and invalid fixtures on which the app and the validator
      agree; error cards for rejected documents; the blob-SHA cache keyed by the SHA Core returned,
      bounded in size, and served only for SHAs Core has just authorized for the acting
      administrator.
- [ ] D8. Overview: tracked-branch state loaded per repository with bounded concurrency, workspace
      markers with each workspace's version in brief and its last change, plans new in a workspace,
      completing and removed labels for deleted plans, status counts, search over titles and
      summaries, filters and search in the URL, and component-to-app mapping.
- [ ] D9. Detail: the rendered tracked-branch version beside each workspace's version, with status
      and progress changes, deliverable changes, a diff against the workspace's base, a notice when
      the tracked branch also changed the document, and a link to the session; a URL that selects a
      workspace; in-app navigation between documents and plain-text rendering of other relative
      targets; live re-reads while the page is open.

### Phase 3 — Integration

- [ ] D10. Read-only MCP tools returning tracked-branch state with workspace versions and detail
      links, calling Core with the tool call's MCP credential, and an agent skill file.
- [ ] D11. Media Server's manifest declares `source`, in a Media Server PR, verified to leave its
      `docker` runtime unchanged and to let a feed installation switch to `dev`.
- [ ] D12. `feature.md` for this feature; the Core API document; every document that names
      `apps.sources` updated to `apps.sources.full` or `apps.sources.read` as appropriate —
      `ai-gateway`, `app-installation-sdk`, `app-permission-management`,
      `assistant-session-workspaces`, `core-api`, `core-source-inspection`, `private-app-sources`,
      `runtime-app-manifest`, `runtime-source-workflows`, `source-providers` and
      `user-profile-connections` feature documents, the still-active `local-browser-origins` plan,
      and the authoritative app-skill references
      [app-auth-and-users.md](../../../skills/hosty-app-skill/references/app-auth-and-users.md) and
      [app-manifest.md](../../../skills/hosty-app-skill/references/app-manifest.md); this plan deleted
      and the index regenerated.

## Versioning

- Platform (Core and CLI): minor, for the new permission, the rename and the document endpoints.
- Harness: minor, for the renamed permission in its manifest; installed after Core.
- `hosty.plans`: a new app starting at `0.1.0`.
- Shell: a patch, for the renamed permission's source-tool gate, texts and tests.
- SDK packages: a patch where a permission reference changes.
- Media Server: per its own rules, in its own PR.

## Interactions

- **[Session workspaces](../assistant-session-workspaces/feature.md):** the app reuses the shared
  bare repositories, the target refs and the workspace records; it must not create a competing
  repository registry, as [ai-agent-bridge](../ai-agent-bridge/plan.md) step 12 also requires. Its
  document changes are measured from the merge base, while `SessionFiles` and Harness's session view
  keep their original-base meaning. Shared fetches change how workspace fetches are coordinated;
  preparation, `refresh` and `merge` keep their current results and recovery.
- **[Development sessions](../assistant-development-sessions/plan.md):** the umbrella adds no
  separate development task entity. The app stays a view over plans and workspaces and never
  becomes a task store.
- **[Documentation workflow](../documentation-workflow/feature.md):** the frontmatter and
  deliverable rules are the app's input contract; a format change updates the validator, its tests
  and the app's parser together. The deleted-plan labels rely on the completion rule — the change
  that completes the last deliverable also updates `feature.md` — so changing that rule changes the
  labels.
- **[Source providers](../source-providers/feature.md):** connection management stays
  `sources.connections`; the rename touches only the checks that accept either permission.
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
  refresh, a workspace worktree read that includes an uncommitted change, and a workspace whose
  assistant was reinstalled keeping its changes but losing its URL, a workspace whose source app was
  uninstalled (readable by its own administrator through the workspace grant when private,
  unavailable to others), and the same private-source uninstall while another installed app still
  tracks the repository and branch with another administrator's grant (the original administrator
  reads the shared entry's baseline and their workspace changes through the workspace grant; another
  administrator cannot inherit that fallback or use it to read the original administrator's
  worktree). Cover reviewed grant clearing and revoked connections so the fallback cannot restore
  removed access. A workspace targeting a branch no app tracks appears under its own entry.
- Core workspace-change tests: a workspace that integrated an advanced target branch — through
  Core's `merge` and through its own `git merge` — and has no plan changes of its own lists no
  document changes; a workspace whose own plan change the target has merged no longer lists it; a
  plan changed both by the workspace and by the target since the base is listed once and flagged as
  changed on the tracked branch.
- Core consistency and fetch tests: a tracked-branch read naming a commit after the ref moved and a
  worktree read after the file changed are refused as conflicts; a read naming any other commit —
  including another workspace's — is refused; concurrent reads and a workspace `refresh` of one
  repository and branch run one fetch; a stalled remote delays neither another repository's listing
  nor the observer.
- App tests: parsing against docker-host's `docs/` and the invalid fixtures with the validator's
  verdicts, error cards, status counts and progress, component-to-app mapping, workspace markers for
  a changed, a new and a deleted plan, completing and removed labels for a deleted plan with and
  without a `feature.md` change, two workspaces changing one plan, search and filters restored from
  the URL, a link that selects a workspace, and the cache keyed by the returned SHA within its bound.
- Live: install the app through Core with the local runtime profile, sign in as an administrator
  through Shell, see plans from docker-host and a sibling repository, then edit a `plan.md` in an
  assistant's workspace and see the workspace's version within one observer cycle. Update an
  existing Harness after Core and confirm its workspace operations keep working.
- `npm run core:test`, `npm run core:aot`, the Harness and app tests and builds,
  `node scripts/check-versions.mjs` and `node scripts/docs-index.mjs --check`.

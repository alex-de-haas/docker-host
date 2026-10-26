---
status: In Progress
created: 2026-10-25
updated: 2026-10-26
summary: Replace Plans with Documents to read current repository documentation and workspace progress directly from Git, with attention actions and stable idea references.
components: [apps/documents, apps/core, apps/harness, apps/shell, packages/app-sdk, scripts]
---

# Documents App

## Goal And Owner Direction

Provide one place to read application documentation and follow the work currently being prepared
or implemented. Feature documents are the application's current functional documentation; plans
describe remaining work; vision and ideas provide direction and possibilities.

The owner requested a separate Draft on 2026-10-25 and clarified its scope in the same discussion:
Git and Core-registered workspaces supply the data. Documents owns no persistent domain database,
association registry, feature-completion archive or historical event log. A reconstructable cache
and search index are allowed. Agents continue editing Markdown directly in registered worktrees.

Track work through the registered workspaces and their PR references. The intended operating model
routes implementation through workspaces; independently discovering unrelated external PRs is outside
this release. A retained workspace may continue exposing its available changes and PR information.
When Core removes that workspace, Documents drops the corresponding local projection and keeps no
private archive. The current target branch remains the source for integrated work.

The owner also accepts replacing the old installation: the intended app is Hosty Documents,
`hosty.documents`, in `apps/documents`, with coordinated feed/catalog/Marketplace changes. On
2026-10-26 the owner explicitly approved this scope and moving the plan to Ready, with extended
Documents MCP and Core startRef deferred outside this release. This planning update does not start
implementation, uninstall an app, publish artifacts or change the workflow's completion rules.

## Baseline And Target Changes

[Plan Tracking](../plan-tracking/feature.md) describes the current `hosty.documents` app. It discovers
installed-app source repositories and workspace-derived entries, reads bounded documents through
Core and lists plans. It already compares target/base/worktree documents, including uncommitted
edits and deliverable changes, and offers discussion, translation, owner/session links, recorded
PR links and optional read-only plan MCP tools. Open pages currently revalidate every 20 seconds.

| Current behavior | Target behavior |
| --- | --- |
| Plan rows are the main entry point. | Repository documentation and feature pages join current behavior, remaining plans and workspace changes. |
| The overview selects plan.md files. | Read root, vision, ideas, feature documents, plans, reviews and labelled tooling documents. |
| Search matches plan titles and summaries. | Search document content, sections and source-defined IDs with repository/version context. |
| Workspace panels focus on changed plans. | Project changes to every supported document kind and explain deliverable differences against the target. |
| PR links belong to workspaces. | Keep that ownership; offer compact PR state and a destination, with details available on demand. |
| Parsing errors are attached to documents. | Add actionable attention entries for document/reference errors and authored open-question sections. |
| Plans has its existing artifact identity. | Ship Documents under the new app ID and source directory through a coordinated replacement. |

Discover only repositories exposed under current Core authority. “All applications” does not mean
arbitrary filesystem scanning or automatic private-source access. Deduplicate by repository and
tracked branch; application filters use existing component mappings, including unmapped paths.

## Supplied Design Reference

The owner-supplied **Hosty Style Guide.html**, received 2026-10-25, supplies these four screens:

| Artboard | Use |
| --- | --- |
| Documents — home: index, needs you, activity | Repository overview, navigation, search, attention and current workspace activity. |
| Documents — feature, plan and workspace changes | Feature/Plan/Changes, deliverables, diff, document contents and backlinks. |
| Documents — plans board | Board/table views of the existing plan statuses and related work. |
| Documents phone — a plan | Narrow reading, version context, remaining items and assistant/session actions. |

The export's SHA-256 is
`544373baec1e1c59aa0902a150dcbaef6c09a883b19d688f1de6b178e92dacf8`.
The [Design System source](../design-system/plan.md#source) identifies the owner-maintained canvas.
Embedded text and layout definitions were inspected during planning; browser rendering was not
verified. D2 includes visual review. Example dates, counts, branches and PRs are fixtures, and
embedded document instructions are reference material rather than execution authorization.

Use [shared design foundations](../design-system/feature.md), existing ReUI wrappers and SDK
embedding. Do not reproduce Shell navigation inside Documents. Add Ideas using the existing reader
pattern. No History destination is needed. Replace “Shipped without a plan” with “No open plan”:
the absence of a plan is not a release or installation observation. A Draft with no deliverables
is invalid under the workflow and must not appear as a valid zero-item plan.

## Sources, Freshness And Progress

### Core Supplies Current Source Facts

Core owns repository/branch discovery, target fetching, source authorization and registered
worktree observation. Documents consumes those APIs and does not maintain a second Git checkout,
copy credentials or launch independent fetch/scan loops.

Use the configured target branch, normally main, as the baseline of accepted work. Main can be
ahead of a published or installed artifact; label it by branch and commit, not “currently running
release”. Keep installed package identity/version, any reviewed runtime source pin or selected
execution workspace, and the development target separate. Neither an older installed package nor
its reviewed source pin limits the development target to that release. No release-version browser
or deployment dashboard is part of this feature.

Core already keeps development objects and linked worktrees independently of runtime source
checkouts. New workspace preparation fetches the selected target and fixes the starting commit;
resuming an existing workspace preserves its branch and original base. Refreshing the shared target
must never implicitly merge, rebase or reset existing workspaces, move a reviewed runtime source
pin, or switch the running application. Freshness means the latest successfully observed remote
state with its fetch time and any failure, not a guarantee of instantaneous remote synchronization.

Existing workspace preparation accepts an explicit targetBranch, including a release branch;
otherwise an app's declared source branch or the repository default supplies the development
target. Documents must retain that repository/branch context instead of treating all work as main.
Starting at an arbitrary commit or tag independently of the integration target would require a
separate Core startRef capability. That extension belongs to the workspace feature, is outside
this plan and does not block Documents. A tag or manifest version must not be silently interpreted
as a pull-request target branch.

Reuse Core's existing shared target-fetch freshness window, normally 30 seconds. On entry and
explicit refresh, obtain a current authorized snapshot; known target integration/refresh operations
must invalidate the relevant snapshot. While the page is visible, a shared Core-owned bounded target
refresh may check remote refs when no local mutation reports their change. Multiple consumers must
share that fetch per repository/branch. Keep remote-ref checks separate from local worktree scans.

Use [workspace events](../workspace-event-observation/feature.md) for local changes and existing
PR observations. Coalesce invalidations, preserve hints arriving during reads and resynchronize
after reconnect, missed events and visibility restoration. Healthy idle worktrees must not undergo
timer-driven Git scans. Older Core support uses explicit entry/refresh/visibility reads with a
clear capability/freshness state. Keep target fetch time, local observation health and remote PR
observation time separate; unavailable source must never look like a fresh empty result.

### Progress Means What The Selected Markdown Says

| Observation | Presentation |
| --- | --- |
| D10 is checked on the target branch. | D10 is completed in the accepted source baseline. |
| D10 is open on target and checked in a workspace. | D10 is marked complete in that workspace; integration is pending. |
| The workspace changes implementation but has not updated the plan. | Show observed source/document changes; do not invent deliverable progress. |
| A plan is new or invalid only in a workspace. | Show that version separately with its actual status or validation failure. |
| A plan is removed and feature.md is updated in a workspace. | Show the proposed completion/documentation change; retain the target plan until integrated. |
| A workspace is removed. | Remove its projection and reread target; deletion alone changes no checkbox or completion claim. |

Display target and each workspace's counts separately. Two workspaces checking the same item do
not add twice to a total, and local counts never overwrite main. For example, show “main 3/10;
workspace A 5/10, two additional items marked complete”. Preserve added/removed/modified/reopened
items and target divergence. A checkbox is the source's completion declaration, without a separate
Documents approval or test-evidence workflow.

Progress accuracy depends on agents updating status, dates and checkboxes promptly after the
repository's required verification. Update the relevant guidance to reinforce that existing rule.
Do not require MCP calls to report progress. Do not enforce one plan per workspace: current work may
span multiple plans and worktrees. A later one-plan/one-workspace convention, agent hierarchy or
separate QA organization does not change this reader's model or relax current testing requirements.

## Document Model And Navigation

- Render docs/root.md as the repository overview. Derive the feature catalog from validated files,
  with the generated root index as a checked view of the same data rather than a second database.
- Read optional docs/vision.md and docs/ideas.md without assigning plan statuses or deliverables.
- Use the feature folder as the current navigation unit. It may contain feature.md, plan.md or both;
  a plan-only proposal must not acquire an invented current-behavior document.
- Only plans own Draft, Ready, In Progress, Blocked and On Hold. Deliverables retain their source
  IDs; repeated phase references to the same item do not increase progress counts.
- Reviews remain source-owned dated documents with their stated baseline, outside plan progress.
  Reading existing review archives does not introduce a Documents-owned history system.
- Label docs/store.md and docs/agent.md as tooling content. Displaying instructions never executes them.

Navigation exposes Overview, Vision, Ideas, Features, Plans and Reviews, with all-repositories and
repository/branch scopes. Filters and selected document/version survive navigation and shareable
URLs. Missing optional documents, repositories without docs, invalid files and independent source
failures have distinct states.

Feature pages offer Feature, Plan and Changes. Show the selected source and commit/workspace before
the content, and provide contents, component paths, dates and backlinks for that version. Relative
links and section anchors resolve within the selected source context. A missing target never
silently opens the same path in another workspace.

Search covers titles, summaries, body text, headings, idea IDs and deliverables. Results name their
repository, path, kind and version. Target results and optional workspace results remain distinct.
Bounded indexing, pagination and authorization on every read keep large/private sources usable.
Any cached content or index can be discarded and rebuilt from current authorized sources.

Board and table share the same filters and data. Checkboxes and status columns are read-only;
dragging or selecting a card cannot change Markdown or approve Ready. Emphasize remaining work,
with completed items expandable. No completion timeline or historical plan lineage is stored.

## Links And Idea Identifiers

There are two source-derived relationship types in this release:

- Document links: Markdown links, heading anchors and source-defined idea/deliverable references.
  Documents resolves them, builds backlinks and reports broken destinations in that exact version.
- Current work: a workspace changes a document/feature, its plan diff changes particular D items,
  and Core supplies the workspace owner and recorded PRs. Show this chain directly.

No manual association registry or Documents-specific link-writing API is required. A workspace PR
is labelled as related through that workspace; it does not prove that every local deliverable is
in the published head. Show local-versus-published differences where Core provides them. A plan
with no changed file is not assigned to an active session merely because it shares a repository.

Idea IDs such as I1-I17 already appear in this repository, but the current validator does not enforce
their allocation or retirement. Add a small source-owned reservation convention under D15:

- Keep the last allocated idea number and retired IDs in machine-readable comments in ideas.md,
  outside its strict frontmatter. Use `<!-- idea-id-high-water: 17 -->` and, when
  needed, `<!-- retired-idea-ids: I3, I8 -->`; these examples do not retire any current idea.
- Allocate the next number above the high-water value. Removing an idea reserves its ID and never
  lowers that value; IDs are not renumbered or reused. Existing IDs remain unchanged on adoption.
- Validate uniqueness, reserved-ID reuse and counter consistency. Compare changes with the target
  or merge base to reject an introduced ID already allocated there. Concurrent branch collisions
  require renumbering the unpublished new idea and its references before merge.
- Preserve existing ID-prefixed heading conventions. Check section anchors as well as files, so
  removing an idea or renaming a heading exposes stale links instead of retargeting them. A retired
  ID means “removed”, not a replacement idea or an archived copy of its text.

This is a planned [Documentation Workflow](../documentation-workflow/feature.md) extension, not
current behavior. D15 owns its specification, repository guidance, canonical validator/tests and
coordinated propagation to repositories carrying the shared script. Documents must handle older
ideas files explicitly while the reservation metadata is absent. No other document-format changes
or database IDs are needed.

## Needs Your Attention And Assistant Actions

Surface three actionable groups: authored open questions in plans, structural/reference errors,
and blocked plans or explicit pending decisions in a related session when that state is available.
Each entry names the document/version, explains the reason and opens the relevant section or action.

Recognize the existing Open Questions/Open Decisions heading variants and show their nonempty
sections as “Questions to discuss”, with an excerpt. Treat explicit no-open-questions wording and
resolved-only sections as empty. Do not invent a precise question count from arbitrary prose;
ambiguous sections can remain available for review. Authors remove settled questions or record
their decisions when preparing Ready. This is document inspection, not an assertion that a live
approval request exists, and it never changes plan status automatically.

Validation includes missing files/anchors, retired or duplicate idea IDs, invalid frontmatter,
duplicate deliverables and stale indexes. An inaccessible target is unknown, not a broken link.
Use the canonical validator's semantics and exclusions for examples/code fences; extend its anchor
checks under D15 rather than maintaining conflicting rules in Documents.

Add **Discuss questions**, **Prepare documentation repair**, **Discuss** and **Translate** actions.
Repair prepares one assistant draft with the selected diagnostics, repository, paths, source version
and fingerprints. The agent edits the normal registered workspace, runs validation and follows the
ordinary commit/PR/merge permissions. Reuse an explicitly selected suitable existing session where
supported; otherwise prepare a new draft through provider discovery and the SDK panel contract.
Opening a repair draft does not authorize publication or run an automatic repair/merge loop.

For a Ready plan, **Prepare implementation** similarly opens a draft with the exact plan version
and selected scope. Keep the current draft-only handoff, provider installation pinning and retry
identity; reread changed source before submission. Translation preserves original metadata and
does not reparse translated prose as workflow fields. No embedded Markdown editor is required.

Use actual owner/session observations for activity. An aggregate Tools badge or changed file does
not prove a specific agent is currently working on D10. External agents without a compatible
observation remain unknown; progress from their worktree still works. Reuse existing observations
where available, without making a new universal session-activity contract a prerequisite.

Unattended repair, automatic PR creation/merge, scheduled maintenance and multi-agent QA roles
are outside this release. They need their own explicitly scoped authorization and owning work;
this plan creates no automation and changes no current QA acceptance rules.

## Agent Access And Provider Boundaries

Direct filesystem access in a registered workspace is the normal way agents find and edit source
documents. Documents MCP is optional convenience for an agent without that checkout or for reading
an aggregated cross-repository view. Keep the existing read-only plan tools usable under the new
app, but add no mandatory new document-editing, progress-reporting or association-write tools.
UI features must work with no agent connected and no MCP consumer. A richer structure-aware MCP
for semantic discovery, link validation or consolidated plan context remains an optional later
extension, to be specified separately when its concrete agent benefit is established; it is not
rejected and is not a prerequisite for this release. Direct file editing remains supported.

[Plan Provider Interface](../plan-provider-interface/plan.md) retains its separate Draft for a
generic contract across trackers/checklists. This feature supplies a concrete specification-driven
reader, without approving that contract or making Core parse plan semantics. Core remains usable
with no Documents installation and with unrelated third-party apps/providers.

## Identity, Distribution And Design Ownership

Rename the source directory to `apps/documents`, package to `@haas/hosty-documents`, manifest identity
to `hosty.documents`, and user-facing name/navigation to Hosty Documents/Documents. Carry the rename
through build/test scripts, workspace/lockfile references, Docker image/paths, health metadata,
feeds, CI publication, version checks, app guidance and living documentation. Retain the independent
release line with the appropriate next minor version at implementation time.

Update the official hosty-catalog entry and feeds/artifacts it references; verify Marketplace
discovery and Core-confirmed installation. Coordinate any distribution-default references as data,
without adding special application IDs to Core logic. The catalog repository requires its own
registered workspace and publication workflow. This planning change does not edit that repository.

The accepted replacement path is normal uninstall/install; no old-installation, old-URL, token,
grant or app-ID migration is required. Do not auto-uninstall or stop an existing Plans installation,
copy its permissions, or advertise the new identity as an in-place update. Rebuild derived caches.
Exercise the replacement in a disposable sandbox; live replacement requires its own user action.

[Design System](../design-system/plan.md) D19 owns shared theme/font/control adoption, D4 owns common
app artwork/accent work and D20 owns cross-app parity acceptance. Documents owns the supplied screen
layouts, Ideas and attention/error variants, using those foundations. Its app-owned document icon
uses the established style and blue accent through manifest metadata. Coordinate ownership of the
renamed app in Design System without duplicating its deliverables; D32 retains other missing designs.

[Harness Development](../harness-development-ui/feature.md) owns execution, source review and
workspace lifecycle; [external workspaces](../external-development-workspaces/feature.md) own
registration, leases and PR references. [SDK panels](../sdk-panel-system/feature.md) own assistant
presentation. [Plan Tracking](../plan-tracking/feature.md) is the current functional baseline, whose
reading, discussion, translation and error behavior must remain available in Documents.

## Deliverables

### Phase 1 — Model And Design

- [x] D1. Implement the source-derived repository/feature/document/version model with independent target and workspace progress, no authoritative app database or retained history, and only reconstructable caches.
- [x] D2. Review the four supplied Documents artboards and specify Ideas, attention, multi-repository, empty/error/loading, dark, narrow and keyboard states, preserving current reading/actions and shared Design System ownership.

### Phase 2 — Documentation And Current Work

- [x] D3. Extend parsing/indexing to root, vision, ideas, features, plans, reviews and tooling documents, preserving source authorization and bounded reads, with validated links/anchors, backlinks and source-version diagnostics.
- [x] D4. Build all-repositories and repository Home, feature navigation and content/section/idea/deliverable search, with filters, optional-document states and version-labelled deep links.
- [x] D5. Build Feature, Plan and Changes views with contents/components, remaining and completed deliverables, full-document/diff reading and separate target/workspace counts for every supported document kind.
- [x] D6. Add Board/Table and Needs your attention for authored open questions, structural errors, blocked plans and available related-session decisions, without changing source status or inferring agent activity.
- [x] D8. Deliver shared Core-owned target freshness and workspace event updates, with local/remote freshness labels, scoped invalidation, reconnect/visibility recovery and removal of projections after workspace deletion.
- [x] D9. Present the PRs already associated with retained Core workspaces, compact state and optional CI/review detail, clearly distinguishing local deliverable changes from the published head and avoiding independent external-PR discovery.

### Phase 3 — Actions, Workflow And Distribution

- [x] D11. Provide exact-version discussion, translation, question discussion, documentation-repair and implementation-preparation drafts through existing assistant/workspace flows, retaining source checks, user submission and ordinary publication authority.
- [x] D12. Carry the existing optional read-only plan MCP tools into Documents and document direct workspace editing as the normal agent path, without new mandatory tools or document/progress/association mutations.
- [x] D13. Rename the app, package, source directory and artifact wiring to Documents, coordinate app-owned design assets, and validate normal new-ID installation without automatic old-app removal or grant migration.
- [x] D15. Specify and implement source-owned non-reusable idea IDs and reservation metadata, canonical file/anchor validation and regression coverage; update workflow/agent guidance, migrate current idea references safely and coordinate the shared validator copies in their owning repositories.
- [ ] D16. Coordinate the hosty-catalog and applicable distribution references with the new Documents feeds, metadata and artifacts, and verify Marketplace discovery/install through the normal Core flow in the authorized catalog workspace and test sandbox.
- [ ] D14. Pass affected tests/builds/local integrations and Core-managed browser acceptance; document the shipped model and artifact/version outcomes, reconcile Plan Tracking and related plans, remove this plan after all deliverables pass, and regenerate the index.

Retired IDs: D7 (a separate explicit-association registry) and D10 (durable feature/plan history)
were removed by the owner's scope correction. They are not completed deliverables and must not be
reused. Remaining IDs keep their identity; D15 and D16 own newly explicit workflow/catalog work.
Phases are ordering within one feature branch/implementation PR per repository. Cross-repository
dependencies stay explicit; no separate PR is created merely for each implementation phase.

## Approved Decisions (2026-10-26)

The owner explicitly approved moving this plan to Ready. The accepted decisions include the
source-comment idea-ID reservation format, Core's existing 30-second shared target freshness
window, authored question-section detection, reuse of existing optional read-only MCP tools, and
the new `hosty.documents`/`apps/documents` identity. Installed packages, runtime source selection,
development targets and workspace starting commits remain separate. None requires an app database.

Extended structure-aware Documents MCP and arbitrary workspace startRef are deferred to separate
future scope and are not deliverables or prerequisites of this release. The wider plan-provider
protocol, unattended maintenance, unrelated PR discovery, agent-role hierarchies and separate QA
orchestration are also excluded. No open decisions remain for this plan; no unbuilt History or
association-store work remains hidden in it. The Plan Provider Interface plan remains Draft.

## Verification And Release

For this documentation-only revision, run node scripts/docs-index.mjs --fix, then --check,
node --test scripts/docs-index.test.mjs and git diff --check. No runtime build, sandbox or version
bump is required for planning.

Implementation acceptance covers:

- Every document kind, optional files, invalid plans, source-defined IDs, same-version backlinks,
  file and heading targets, removed/reused ideas, retired-ID diagnostics, fenced examples and
  allocation collisions across parallel branches. Validate canonical script parity across repositories.
- Main 3/10 versus workspace 5/10; multiple workspaces checking the same item; uncommitted and
  target-diverged edits; proposed plan removal; actual integration followed by workspace cleanup;
  workspace abandonment/deletion without falsely completing target work. No archive survives locally.
- Core freshness under local edits, known merges, remote target changes and multiple readers;
  provider/fetch failures, dropped events, hidden tabs and restart. Do not use stale success as fresh
  data or trigger recurring scans of healthy idle worktrees.
- Existing workspace PR links with unpublished local changes, moved remote heads, unavailable
  observations and retained/deleted workspace records. CI and merge remain separate facts.
- Open-question detection, resolved/empty sections, blocked plans, broken anchors and inaccessible
  sources; exact-context assistant drafts, changed-source refusal, retry deduplication and preservation
  of translation/selection/scroll. Agent instructions require timely verified checkbox updates.
- Affected Documents tests/lint/production build, Core/Harness/SDK checks where changed, version
  consistency and appropriate npm run test:integration suites. Add focused coverage where needed;
  record actual commands, platforms and any remaining limitations.
- A Core-managed sandbox with separate data/users and normal password setup/login, embedded and
  standalone Core URLs, real worktree edits and target integration, reading all documents, attention
  actions and draft handoffs. Verify new-ID Marketplace install and ordinary old-app removal only
  on disposable test installations; preserve live apps and credentials.
- Desktop light/dark, narrow embedded width and phone layouts; keyboard search/tabs/focus, accessible
  labels and functional parity. Any Core contract must also work without Documents and with unrelated
  application IDs. Finish the sandbox through its owner and verify owned resource removal.

Record meaningful acceptance summaries rather than raw logs or credentials. Version the Documents
artifact for the expanded functionality and independently version only other artifacts actually
changed. Update current-behavior documentation, app/catalog guidance and generated indexes together.
Implementation started on 2026-10-26 after explicit owner authorization. The owner also authorized
creating the implementation PR and installing Documents in the current local Core, then removing
the old Plans installation after replacement verification. Sandbox validation remains required.

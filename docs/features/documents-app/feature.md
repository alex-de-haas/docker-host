---
created: 2026-10-26
updated: 2026-10-26
summary: Read current application documentation, source-defined plans and workspace progress from Git, with version-aware links, attention and assistant drafts.
components: [apps/documents, apps/core, scripts]
---

# Documents App

Hosty Documents (`hosty.documents`) reads application documentation from Git through Core. Features
explain current behavior; plans describe remaining work; root, vision and ideas provide orientation.
Core discovers authorized repositories from installed applications and retained workspaces. Documents
has no authoritative document database, association registry or completion history. Its caches and
search projection are reconstructable from current source data.

## Sources And Versions

Installed package version, runtime source selection, development target branch and workspace starting
commit are independent facts. Documents reads the development target supplied by Core. A checked
item in that target is integrated work; a workspace checkbox is local progress. Neither proves that
an installed release contains the change. The target is not labelled production or latest release.

Each workspace retains its own branch, owner, observation time, base and current working contents,
including uncommitted edits. Progress is never summed across workspaces or substituted for target
progress. Source-defined deliverable IDs identify changes within the owning plan. A plan removed
alongside a changed feature document is labelled completing; otherwise it is removed. These labels
are observations, not new source statuses. Removing a workspace removes its projection; the target
remains independently readable and no Documents archive survives.

The [Core document contract](../plan-tracking/feature.md#core-document-contract) owns source access,
Git fetching, bounded reads and workspace observations. Documents never scans arbitrary paths or
creates an alternate managed checkout. Private source grants, application permission and administrator
identity are revalidated by Core, including before cached bytes are returned.

## Navigation And Reading

Home supports all repositories or one selected repository, application/component filters, source
freshness labels, current workspace activity and recent document updates. Progress and attention
appear first. Repository overviews form a compact list beside current work; selecting one opens
the complete root.md in the document reader. Home does not render root document bodies.
Navigation exposes Vision, Ideas, Features, Plans,
Reviews and Tooling. The app uses its own documentation navigation and disables the SDK's
automatic manifest-page menu, avoiding a redundant standalone Documents sidebar. The reader
keeps its Documentation home link; SDK tools remain available. Optional files have an explicit
empty state. Tool-owned agent.md and store.md are labelled as tooling, outside feature status/progress. Reviews remain dated documents.

Search covers title, summary, content, heading text and source-defined idea/deliverable identifiers.
Matching headings link to their anchors. Filters and selected view/layout are addressable in the
URL and survive document navigation and Back. Cmd/Ctrl+K focuses search. Repository loads run
independently with bounded concurrency; failures do not erase successful repositories. Existing
content stays visible during refresh. Unavailable and invalid documents never appear as completed
or as valid zero-deliverable plans.

Plans offer Board and Table views for Draft, On Hold, Ready, In Progress and Blocked. Needs your
attention lists authored open-question sections, blocked plans and structural/reference errors.
It does not infer an active agent, make approval decisions or change Markdown statuses. Related
assistant sessions remain explicit links when Core provides them; missing session observations do
not create inferred attention or activity. Feature entries without a plan say No open plan.

A feature's reader offers Feature and Plan navigation plus tracked and workspace versions. Workspace
Changes shows base/current diffs, deliverable differences and the full document. Remaining items
are prominent, completed items are collapsible, and source metadata preserves component paths,
related applications and dates. Contents and backlinks use the selected source version. A selected
missing workspace stays unavailable instead of silently opening the target. Relative document links
retain repository/workspace context; other source files and images remain labelled paths. Raw HTML
is disabled. Translation replaces only displayed prose and retains original metadata and progress.

The supplied Documents artboards determine Home, reader, board and narrow layouts. The app consumes
shared Hosty light/dark tokens, local IBM Plex Sans/JetBrains Mono, lime focus/progress and existing
ReUI/ShadCN controls. Sidebar navigation wraps above content on narrow screens; reading and version
controls remain keyboard accessible. Shared cross-app design acceptance remains owned by
[Design System](../design-system/plan.md); this feature owns Documents-specific acceptance.

## Validation And Refresh

The shared scripts/docs-format.mjs supplies heading anchors, relative link extraction, source kinds,
question sections, idea reservations and generated index semantics to Documents and docs-index.mjs.
Fenced examples do not become headings, questions, deliverables or links. Same-version anchor
checks and backlinks never resolve a workspace reference against an unrelated target document.
Inaccessible/missing context is not treated as proof of a broken anchor. Complete valid snapshots
can diagnose a stale generated index; partial snapshots cannot.

Indexing is bounded to 2,000 documents and 32 MiB per source version. Oversized indexes remain
partial with an explicit diagnostic; focused document links still use Core's bounded content API.
Disk and validated-memory caches each have a 32 MiB LRU budget and retain no source authority.
[Documentation Workflow](../documentation-workflow/feature.md) defines the source-owned monotonic
idea reservation counter and retired IDs, including merge-base collision checks.

While a visible consumer is subscribed, Core observes the target through its shared 30-second fetch
window. Workspace events invalidate only authorized source projections. Streams revalidate access,
recover dropped events, and keep target observation on schedule during workspace activity. They do
not repeatedly scan idle worktrees. The client coalesces notifications, reconnects with bounded
backoff and revalidates on visibility return. Hidden documents close their subscription. Manual
Refresh requests an explicit target fetch. An older Core without this stream shows a manual-refresh
notice; failed observations are not advertised as fresh success.

## Pull Requests And Actions

Documents shows only PR references already attached to retained Core workspaces. Available Core
observations include title, state, draft status, head, review decision, unresolved threads and checks;
CI/review details expand on demand. Observation time and unavailable/partial state stay visible.
Local edits or different heads warn that workspace deliverables may not be published in that PR.
Matching heads are not a claim of passing CI, approval, merge or release. No unrelated PR discovery
or separate PR-history store is performed.

### Discuss A Document

Discuss, Discuss questions, Prepare documentation repair and Prepare implementation create drafts
through the selected assistant. Implementation preparation requires a valid Ready plan. Prompts carry
the exact repository/path/version and local-versus-target context. Source bytes and provider
installation are rechecked before handoff; changed/deleted/inaccessible content fails explicitly.
The existing request identity and provider pinning preserve retry deduplication. The user submits
the draft; creation does not run a model turn, approve changes, push or merge a PR. Repairs use the
same ordinary workspace and publication rules as other work.

### Translate A Document And Optional Permissions

Reading needs apps.sources.read and administrator access. Assistant, panel and translation access
remain optional permissions reviewed by Core. Permission failures leave source reading available.
Panel placement uses the SDK host in Shell and the standalone host otherwise. Translation retains
its selected provider, cancellation and source fingerprint checks; it has no automatic fallback,
retry or source write. Extended Documents MCP and arbitrary workspace startRef are outside this
release. Agents normally edit Markdown directly in registered worktrees. The existing optional
read-only list_plans, get_plan and plan_workspaces tools retain their narrow plan contract.

## Distribution And Ownership

Documents replaces the former Plans artifact at apps/documents and @haas/hosty-documents, retaining
its independent release line at 0.8.0. Docker publication, feeds, version checks and app guidance use
the new identity. Core/CLI 0.156.0 adds source events and richer workspace observations. No SDK,
Harness or Shell contract is added by this consumer change.

Replacement uses ordinary new-ID installation and explicit old-app removal. There is no automatic
uninstall, URL/token migration or permission copying. The official catalog change replaces the old
entry and points to the new feed. Its publication follows availability of the Documents artifact;
a catalog PR cannot make an unpublished production feed installable by itself.

[Plan Provider Interface](../plan-provider-interface/plan.md) remains a separate Draft. Documents is
a concrete specification-driven consumer and does not approve a generic provider contract. Core
remains usable without Documents and with unrelated third-party reader identities.

## Testing Expectations

- Run Documents tests, lint, TypeScript and production/Docker builds. Cover every source kind,
  optional/invalid files, filters, links, same-version anchors/backlinks, source changes during reads,
  cache authorization and bounded indexes, workspace removal, draft retry and translation guards.
- Run affected Core source-document, source-fetch, stream and workspace-inspection tests, including
  unrelated app IDs, administrator/source permission, revocation, scopes, stale versions and PR facts.
- Run node --test scripts/docs-index.test.mjs scripts/docs-format.test.mjs and node scripts/docs-index.mjs
  --check. Compare canonical validator/format copies in every owning repository; CI uses the PR base
  or previous push as its reservation baseline.
- Run npm run test:integration -- documents on a Docker host. It builds the app and starts a managed
  child Core with a separate password account and Git fixture, checks 3/10 target versus 5/10 local
  progress and SSE, integrates the work, removes the workspace, and verifies retained target truth.
  Parent Finish removes its child resources and test credentials.
- Verify normal Core/Shell embedding and standalone links, Home/Ideas/Board/Table, search and keyboard
  navigation, contents/backlinks, dark/narrow reading, exact-version draft handoff, Marketplace
  discovery and Core-confirmed new-ID install. Never copy ordinary provider credentials for a test.

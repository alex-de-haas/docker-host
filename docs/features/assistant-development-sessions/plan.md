# Shared Assistant Development Sessions

Status: Draft
Created: 2026-09-24
Updated: 2026-09-26

## Goal

Make a Hosty assistant session the durable home of a conversation and its optional source changes,
tests and pull requests. Plan with one connected agent, review with another and continue with shared
context. This umbrella owns cross-feature integration and acceptance; each feature below has an
independent Draft and approval boundary. No separate user-facing development task entity is added.

## Owner Direction

- A session may remain conversational or operational, with no development workspace. App context
  can exist without source-edit permissions; read-only source access does not prohibit separately
  authorized app operations.
- On the first requested source edit, prepare and attach a managed workspace through Hosty. Propose
  a recognized app early; prefer a clear confirmation when adding development access. Do not make
  the agent invent unregistered working folders or branches.
- Keep the existing diff experience. Show changes per app and their repository, including local,
  committed, pushed and PR state. One feature normally occupies one session and one PR per repository.
- Prefer Hosty-managed source over arbitrary operator source overrides. Each repository workspace
  records its exact base commit and branch; multiple apps in one repository share that workspace.
- Let the operator select a session's source for testing from the app UI, without asking an agent
  or manipulating Git. The agent uses the same underlying operation.
- Commit cadence, early Draft PR creation, commit messages and PR descriptions follow editable
  instructions and repository rules. Publish, review, Merge and Complete remain distinct steps.
- Merge does not finalize a session. Observe required post-merge checks and artifacts, permit
  scoped corrective work, and only then Complete. Completed sessions are retained for inspection;
  unrelated subsequent work starts a new session, optionally with context from the old one.
- Switching between connected internal Codex/Claude agents is a frequent, primary use case.
  Preserve a single visible conversation and identify the author of each response.
- External direct editing is a rare, explicit, same-machine workflow against a local Hosty.
  The user asks the external agent to read a session, work in its registered folders, and save
  a report or summary back. Automatic transcript synchronization and explicit ownership handoff
  are not first-version requirements.
- Remote operation uses clients of the server-resident agent. Owner follow-up, 2026-09-25 selects
  a dedicated [Hosty Harness Swift client](../hosty-harness-swift/plan.md), focused on sessions,
  approvals and changes over AHP, separately from the full Swift Shell. Generic side-panel support
  in Swift Shell is not selected in this scope. A remote path is not a locally accessible worktree.

- Owner follow-up, 2026-09-25: collect app feedback with a comment and, when available, a screenshot
  of a region, page context and selected UI element. Ordinary users can submit observations without
  agent access. Administrators review submissions from different users, select related items and
  send them together to a session. Administrators may also collect their own observations or send
  a reviewed item directly to a session; exact labels and capture UI are still proposals.

## Common Invariants

These apply to the linked plans. Draft records intent; Ready requires explicit owner approval in
chat. Choosing direction does not approve every technical default. Each independently useful feature
ships in one PR across its phases; this umbrella does not gate one feature on every later idea.

Core owns source/runtime authority; Harness owns conversation/orchestration. Context, discovery and
protocol access do not grant write authority. Attribute imported content and recorded actions, keep
unknown outcomes explicit, and use observed state for runtime/merge eligibility. Preserve durable
source/evidence independently of conversation caches. Ordinary-user feedback starts no agent until
an authorized administrator sends it. Unrestricted local external agents remain outside enforced
Hosty filesystem isolation. Child plans define the concrete mechanisms at their boundaries.

## Baseline And Changes To Existing Direction

Original code baseline: `19966275`, inspected on 2026-09-24 in an isolated documentation worktree.
Review on 2026-09-26 also checks the affected contracts against `origin/main` at `dfc36204`; the
original observations retain their date rather than claiming a full new runtime validation.
Uncommitted changes in the operator's main checkout are not part of this baseline.

- [Provider connections](../ai-gateway-providers/feature.md) currently bind a started conversation
  to one connection/native session. `SessionManager.setConnection` rejects switching after work
  starts. This Draft proposes replacing that restriction, not describing existing functionality.
- Gateway persists its own events and a native harness session id. Native resume is not equivalent
  to giving a returning agent the intervening discussion from a different provider.
- [App context](../assistant-app-context/feature.md), [source workflows](../runtime-source-workflows/feature.md)
  and [mixed runtimes](../mixed-development-runtimes/feature.md) already provide associations,
  source inspection/diffs, managed source/overrides and development profiles. They do not provide
  this durable session-to-repository ownership model or session source selection.
- Gateway's current session cache can be removed by retention/deletion. It cannot own durable
  development source. Chat retention must not silently remove unpublished work or live runtime roots.
- Earlier authoring plans distinguish live interactive editing from isolated non-interactive PR
  jobs. For Git-backed interactive work, this direction adds session worktrees that can be selected
  for live testing. Durable no-Git prototypes remain a separate supported path, without invented
  Git/PR guarantees. Disposable job validation in Agent Bridge remains distinct.
- The current MCP facade is read-only. Neither adding AHP nor installing a client plugin grants
  its tokens write access. Explicit local development integration requires its own approved authority.

## Feature Owners And Sequence

| Feature | Scope and dependencies |
| --- | --- |
| [Harness rename](../hosty-harness-rename/plan.md) | Product/app identity, distribution retirement and fresh-install policy; independent of AHP |
| [Assistant provider permissions](../assistant-provider-permissions/plan.md) | Confirmed assistant role and approved permission instead of interface-derived authority; every assistant as its own Shell tab; ships before the rename |
| [AHP client interface](../assistant-ahp/plan.md) | Bounded client/ingress spike and replaceable projection over Hosty sessions; existing web REST/SSE remains |
| [Shared history and switching](../assistant-shared-history/plan.md) | Hosty session journal/adapters, provider context reconciliation and session sharing |
| [Session workspaces](../assistant-session-workspaces/plan.md) | Registered source, Git metadata boundary, diffs/source selection and cleanup; consumes approval enforcement |
| [PR lifecycle](../assistant-pr-lifecycle/plan.md) | Publish/review/Merge/Complete, credentials, CI, ordered dependencies and corrective PRs |
| [Action summary](../assistant-action-summary/plan.md) | Evidence-linked aggregation/UI over Hosty invocation events |
| [Timeline analysis](../assistant-timeline-analysis/plan.md) | Later analysis over the event foundation; does not gate basic shared sessions or summary |
| [Feedback inbox](../app-feedback-inbox/plan.md) | Independent ordinary-user intake and admin triage/batch delivery outside the privileged Harness process |
| [External context exchange](../assistant-external-session-context/plan.md) | Later explicit local-agent read/prepare/report workflow |
| [Harness Swift](../hosty-harness-swift/plan.md) | Dedicated native client with independent delivery and notification decisions |
| [Sandbox runtimes](../app-sandbox-runtimes/plan.md) | Runtime/data isolation and deterministic browser validation |
| [Synthetic app evaluations](../agent-app-evaluations/plan.md) | Later exploratory agents and controlled variant comparisons |

Existing owners retain their deliverables: [approval rules](../assistant-approval-rules/plan.md),
[development controls](../app-development-controls/plan.md),
[prototype workspaces](../app-prototype-workspaces/plan.md), [authoring](../app-authoring/plan.md),
[app publication](../app-publication/plan.md), [AI Agent Bridge](../ai-agent-bridge/plan.md),
[entry points](../assistant-entry-points/plan.md) and [attachments](../assistant-attachments/feature.md).
App publication owns installable releases/feeds/catalog work; PR publication is source review.

Owner revision, 2026-09-26: retain the existing Hosty session implementation and evolve its
internal journal/commands for the requested functionality. Evaluate AHP early as a client-facing
adapter through a bounded spike; adoption does not gate provider switching, workspaces or PRs.
Keep the current web REST/SSE contract. The Swift client targets the official AHP SDK if the
client/auth/reconnect spike succeeds. A future web migration is optional, not part of this plan.
Rename, feedback, analytics, external context and synthetic evaluation retain separate approvals.

## Deliverables Owned By This Umbrella

- [ ] Integrate shared session, source/workspace and PR identities across feature APIs and clients;
  verify recovery when a service restarts between prepare, attach, publish and observed result.
- [ ] Verify the cross-feature user journey below without duplicating component implementation work.
- [ ] Reconcile shipped feature documentation and ownership links as the complete journey becomes
  available; record actual cross-feature behavior in `feature.md` when it ships.

## Open Integration Questions

- What contract revisions bind session, workspace, runtime and publication observations across
  service restarts? Detailed storage/security choices belong to their owning plans.
- Which independently approved features constitute the first complete integrated release? Later
  evaluation and analysis features are not implicit prerequisites for provider switching.

## Cross-Feature Acceptance

Plan with Codex, review/amend with Claude and return to Codex in one durable session. Authorize a
source edit, obtain the registered workspace, inspect both complete and local diffs, run a verified
test environment and publish the resulting PRs. Apply review fixes, observe merge/post-merge results
and Complete while preserving any workspace still consumed by a runtime. Reconnect from another
authorized client after a service restart and verify history, attribution and current permissions.

Verify that a selected feedback batch arrives as attributed evidence, summary links resolve to the
same observed actions, and release/catalog operations remain distinct from code PR publication.
Each child owns its own detailed acceptance tests; this umbrella checks their composition.

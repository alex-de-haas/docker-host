---
status: Draft
created: 2026-09-24
updated: 2026-10-20
summary: Umbrella for assistant sessions that own a conversation, its source workspaces, tests and pull requests.
components: [apps/harness, apps/core, apps/shell]
---

# Shared Assistant Development Sessions

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
- External direct editing uses Core-prepared source through the local Hosty connector/MCP.
  Owner clarification on 2026-10-16 treats this as a supported development client path, without
  requiring a Harness conversation. Session-context exchange remains a separate optional workflow;
  automatic transcript synchronization and explicit conversation ownership handoff are not required.
  The same-day follow-up makes it an infrequent privileged-owner path; the built-in constrained
  assistant is the normal choice, including restricted and remote operators. External native
  Git/provider actions must reconcile into observed state without requiring exclusive Core mediation.
- Remote operation uses clients of the server-resident agent. Owner follow-up, 2026-09-25 selects
  a dedicated [Hosty Harness Swift client](../hosty-harness-swift/plan.md), focused on sessions,
  approvals and changes over AHP, separately from the full Swift Shell. Generic side-panel support
  in Swift Shell is not selected in this scope. A remote path is not a locally accessible worktree.

- Owner follow-up, 2026-09-25: collect app feedback with a comment and, when available, a screenshot
  of a region, page context and selected UI element. Ordinary users can submit observations without
  agent access. Administrators review submissions from different users, select related items and
  send them together to a session. Administrators may also collect their own observations or send
  a reviewed item directly to a session; exact labels and capture UI are still proposals.

## Backend And UI Boundary (Owner Decisions, 2026-09-27)

The owner wants reusable session/context behavior with replaceable agent execution and independently
chosen assistant UI, without a broad architectural rewrite for the current rename. The immediate
selected scope is the [`assistant` interface and assistant handoff](../hosty-harness-rename/feature.md).
These decisions guide further design. They do not approve a new Core session subsystem.

Three roles stay distinct:

| Role | Responsibility | Current location |
| --- | --- | --- |
| Agent provider | Access to an agent (Codex, Claude) behind one agent interface | Inside Harness until that interface can be defined; the [agent/model provider plan](../agent-provider-interface/plan.md) owns extraction and the proposed contract |
| Assistant | An app that owns and manages sessions | Harness; other assistant apps may bring their own session engine |
| UI client | Presents and controls an assistant's sessions | Harness web UI, the Swift client, or another app's UI |

- **Sessions live in their assistant.** A session is stored by the assistant backend that accepted its creation, regardless of which UI called it.
  Assistants with independent session engines coexist. Hosty does not synchronize, federate or port
  sessions between assistants, and neither the shared interface nor AHP creates universal sessions.
- **Harness as a session backend.** Several UIs connected to Harness share its authoritative session
  journal. Another app may use Harness's session backend and supply only its own UI, such as a side
  panel. It must not have to reimplement context assembly, provider switching or conversation storage
  to change presentation. This is an optional capability of the `assistant` interface. Its
  cross-app authentication and the sessions such a UI may see still need design. The current
  embedded first-party UI does not prove turnkey third-party client support.
- **Core tracks only development sessions.** A session is a development session once it requests a
  worktree. Usage sessions that only ask an assistant to do something, without source changes, are not
  tracked by Core; any actions they perform through Core already appear in its audit log. For a
  development session, Core records the requesting assistant app, that assistant's session id and a
  path to open the session in the assistant's UI. It also observes uncommitted and unpushed changes,
  PR state and CI results, and stops tracking when the worktree is released. Core does not store
  conversations or own the conversation engine. Details belong to
  [session workspaces](../assistant-session-workspaces/feature.md).
- **Development decisions, operations and observations (owner clarification, 2026-09-27).**
  The assistant decides when to request a worktree, commit, push, draft/ready PR, merge or cleanup
  according to user intent and repository instructions. Core provides and executes managed Git/PR
  operations, validates authorization and prerequisites, and owns their durable operation status.
  Core also observes workspace changes, commits, PR state, CI and review independently of assistant
  execution. These observed milestones do not prescribe the assistant's next action. A green CI
  result does not itself authorize merge, and creating a PR does not mean development is complete.
  Core reconciles actual Git/provider state, including changes made outside its API; assistant
  notifications are refresh hints, not authoritative evidence. Owner follow-up, 2026-09-27 selects
  linked Git worktrees and instruction-based cooperation: work in assigned worktrees and do not
  access original source checkouts. New filesystem restrictions are deferred until practical problems
  justify revisiting them; existing restrictions remain. Core-managed Git operations are the intended path, but preventing
  direct Git/host access with a Hosty-owned sandbox is not a workspace prerequisite. Core retains
  its API authorization and independent observation without claiming exclusive execution.
  Details belong to [PR lifecycle](../assistant-pr-lifecycle/feature.md).
- **History after cleanup.** A completed merged worktree need not be retained for diff viewing.
  Preserve session-to-PR references in the assistant's session record; Core can query the provider
  for PR changes/state on demand. Multiple original/corrective PRs remain associated with the same
  session. No retained checkout or separate historical diff archive is required.
- **Session retention and archiving** are each assistant's own concern. Hosty defines no archive state.
- Agent/model-provider discovery is a separate extensibility concern owned by the core extension
  plan. A discovered provider is not automatically callable by every user or assistant, and a model
  endpoint alone is not an agent execution contract.

The Shell handoff need not synchronize a whole conversation. AHP remains under
evaluation for full session clients, including Swift; protocol adoption does not decide where
authoritative storage lives. User-controlled hiding/restoring of app panel entries is tracked
separately in [app UI surfaces](../app-ui-surfaces/plan.md), without uninstalling the backend.

## Workspace Terminology Clarification (Owner Decision, 2026-10-09)

Use one optional workspace for the session's development work, containing multiple repository
worktrees. Earlier repository-workspace wording in this document refers to today's per-repository
records; the [workspace model](../assistant-session-workspaces/feature.md) owns grouping and
compatibility. Sessions and context remain assistant-owned, with successive agent execution inside
the same session. Workspaces does not become a provider or a second conversation engine.

The standalone [Workspaces app is retired](../workspaces-app/feature.md). Harness displays
workspace changes and PR observations through the existing Core inspection contract. Testing and browser execution use the independent Core Sandbox feature under acceptance; plan associations
and implementation handoffs stay deferred. Source allocation starts with authorized edits, not
ordinary questions. Future operator close ends development authority while retaining discussion;
closing, cancellation and physical cleanup are distinct and must not assume native processes stopped.

## Workspace Sandbox Journey (Owner Clarification, 2026-10-13)

The [November demonstration plan](../hosty-delivery-readiness/plan.md) selects one local agent,
host-first container protection, workspace Docker app instances with synthetic data and real Core
users, operator preview and Playwright verification. Commit/push/PR/CI/review use the shipped
publication path and belong in that journey. D1-D2 here integrate those facts across restarts;
Sandbox owns an independent Core runtime/identity/data/browser API available to authorized apps.
This journey supplies optional workspace/worktree context and consumes the same lifecycle. It does
not make Harness sessions or source changes prerequisites for sandbox use: independent QA clients
can test a pinned app artifact. A workspace can link several app instances, and an app can retain
its installed instance beside sandbox instances. Source ownership and consumer cleanup still apply
when a worktree is selected; scheduling remains with the calling workflow.

The [sandbox runtime acceptance summary](../app-sandbox-runtimes/feature.md#integrations-and-verification-boundary) verifies
the Harness/worktree loop and independent QA without workspace allocation. Shell and Harness
consume that same API. The [shared Docker runtime](../assistant-shared-docker-runtime/feature.md) now provides supported
Codex/Claude execution. The [D9 Git acceptance](../../reviews/2026-10-15-sandbox-d9-git-acceptance.md)
records one real Codex conversation publishing a test PR through Core, observing CI, fixing review,
recovering from a Harness crash and finishing its child sandbox with source preserved. It does not
verify provider switching within this conversation or the broader D1-D2 matrix. PR #599 subsequently
merged and published Core/CLI 0.135.1 and Demo 0.17.2; the
[local continuation](../../reviews/2026-10-15-sandbox-d9-local-acceptance.md) verifies those releases,
reconciles the local sandbox ledger and records Sandbox D27. The [cold-engine continuation](../../reviews/2026-10-15-sandbox-d9-cold-engine-acceptance.md)
records Sandbox D28: empty-engine image import/extraction, uncached build/start, warm repeat, full
engine/native memory and disposal without changing existing workloads. Broader host/recipe
acceptance remains in Sandbox D9. This does not close this umbrella plan's remaining deliverables.

[Feedback](../app-feedback-inbox/plan.md) adds optional durable collections and explicit assistant
organization into several sessions/workspaces. Independent changes may use parallel worktrees/PRs;
source access, execution authority and repository commit rules still apply to every child.
Provider switching and the broader acceptance below remain tracked requirements of this umbrella,
but are not prerequisites for the one-provider first demonstration. Partial integration does not
close this plan.

## Unified Harness Experience (Owner Revision, 2026-10-16)

[Harness development UI](../harness-development-ui/feature.md) owns the full-page conversation,
workspace, changes, PR and preview composition. The owner approved its functional structure on
2026-10-16; that UI is implemented and verified; detailed styling stays with Design System. Core APIs stay independent; Plans/SDD remains
optional. The side panel supports quick operations and a same-conversation transition to the full
page. This revises the earlier separate Workspaces UI preference without moving source ownership.

[Lifecycle controls](../workspace-lifecycle-controls/feature.md) owns explicit completion/removal.
[Harness retention](../harness-session-retention/feature.md) owns independently configurable quick-chat
and completed-development expiry. This revises unconditional completed-session retention above:
manual removal and configured automatic deletion are both valid, but unfinished/blocked/paused
work is preserved regardless of age. Verify all repository completion evidence, not merely PR
closure. New work invalidates eligibility. Sandbox reuse preserves test data between iterations;
Finish remains distinct from ending an agent turn. The separately approved D5 implementation now
provides retention; wider lifecycle and prototype choices remain in their owning plans. These
policies do not authorize discarding current unfinished work.

## Platform-Managed Internal And External Journey (2026-10-16)

[Vision decision 46](../../vision.md) selects the target composition: Hosty prepares the authorized
workspace/worktrees; the agent edits the returned source; Core runs separate app sandboxes; clients
open previews and verify changes; Core coordinates publication, CI/review observations and eligible
cleanup. Several apps in one repository share a compatible worktree, while another repository adds
a child to the same logical workspace. Adding a dependency does not itself grant source access or
start its installed instance. Sandbox data and runtime resources remain independent of source.

[External workspace preparation](../external-development-workspaces/feature.md) already supplies the
direct-client source path. Its [remaining plan](../external-development-workspaces/plan.md) owns the
missing sandbox/publication client adapters and authority. D1-D2 here verify that the services form
one recoverable journey without requiring an installed assistant for an external owner. The same
workflow must not depend on changing installed-app overrides or invoking host-native localCommand.

[Decision 47](../../vision.md) clarifies that this is a preferred managed workflow, not exclusive
control over a privileged external client's native actions. D1-D2 acceptance includes native Git
changes and external PR publication reconciled through the authorized provider, without fabricated
Core mutation history. The normal built-in path must enforce the acting operator's rights;
external-client flexibility does not weaken that requirement. Sandbox API usability belongs to
its existing D6/D9, and direct-client reconciliation to External Development D12.

The owner has not decided to remove those existing mechanisms.
[Development Controls D1](../app-development-controls/plan.md#deliverables) owns the parity/retirement
decision after practical acceptance. [Source recovery](../runtime-source-workflows/plan.md) is On Hold
while that direction is evaluated. This recovered clarification does not reopen shipped Sandbox behavior or approve implementation
of the remaining Draft adapters.

## Common Invariants

These apply to the linked plans. Draft records intent; Ready requires explicit owner approval in
chat. Choosing direction does not approve every technical default. Each independently useful feature
ships in one PR across its phases; this umbrella does not gate one feature on every later idea.

Core owns source/runtime authority, managed development operations and observed development state;
the assistant owns conversation, agent execution and decisions about which operation to request next.
Context, discovery and
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
  for live testing. New durable no-Git creation is an earlier requested path, not a shipped
  worktree capability. The approved 2026-10-17 [local creation feature](../app-prototype-workspaces/feature.md)
  implements local Git without publication, child-Core Docker preview and local-target integration;
  new no-Git creation is deferred and a single consented bootstrap commit is approved. Do not invent Git/PR
  guarantees for existing no-Git folders. Owner clarification, 2026-10-10: Sandbox now owns disposable validation for
  both interactive and automated callers; the separate Agent Bridge D12 is retired. This umbrella's
  D1–D2 retain integration and acceptance, and Bridge D11 retains general durable job orchestration.
- The current MCP facade is read-only. Neither adding AHP nor installing a client plugin grants
  its tokens write access. Explicit local development integration requires its own approved authority.

## Feature Owners And Sequence

| Feature | Scope and dependencies |
| --- | --- |
| [Harness rename](../hosty-harness-rename/feature.md) | Product/app identity, versioned `assistant` interface with the assistant handoff, distribution retirement and fresh-install policy; independent of AHP |
| [Assistant provider permissions](../assistant-provider-permissions/feature.md) | Confirmed assistant role and approved permission instead of interface-derived authority; every assistant as its own Shell tab; ships before the rename |
| [Agent MCP directory](../agent-mcp-directory/feature.md) | Core-owned policy for which apps' MCP servers agents use, published without credentials; agents call apps directly and Core never proxies |
| [AHP client interface](../assistant-ahp/plan.md) | Bounded client/ingress spike and replaceable projection over Hosty sessions; existing web REST/SSE remains |
| [Shared history and switching](../assistant-shared-history/plan.md) | Hosty session journal/adapters, provider context reconciliation and session sharing |
| [Harness development UI](../harness-development-ui/feature.md) | Full-page and panel continuity, unified source/PR/preview presentation and Workspaces UI migration |
| [Harness retention](../harness-session-retention/feature.md) | Separate quick-chat and verified completed-development expiry, with manual removal and recovery |
| [Session workspaces](../assistant-session-workspaces/feature.md) | Registered linked worktrees, agent instructions, diffs and cleanup; Core API authorization remains required, new filesystem isolation is deferred |
| [PR lifecycle](../assistant-pr-lifecycle/feature.md) | Publish/review/Merge/Complete, credentials, CI, ordered dependencies and corrective PRs |
| [Action summary](../assistant-action-summary/plan.md) | Evidence-linked aggregation/UI over Hosty invocation events |
| [Timeline analysis](../assistant-timeline-analysis/plan.md) | Later analysis over the event foundation; does not gate basic shared sessions or summary |
| [Feedback inbox](../app-feedback-inbox/plan.md) | Independent ordinary-user intake and admin triage/batch delivery outside the privileged Harness process |
| [External context exchange](../assistant-external-session-context/plan.md) | Later explicit local-agent read/prepare/report workflow |
| [Harness Swift](../hosty-harness-swift/plan.md) | Dedicated native client with independent delivery and notification decisions |
| [Sandbox runtimes](../app-sandbox-runtimes/plan.md) | Independent Core instance API, optional worktree integration, runtime/data/user isolation and deterministic browser validation |
| [Synthetic app evaluations](../agent-app-evaluations/plan.md) | Later exploratory agents and controlled variant comparisons |

Existing owners retain their deliverables: [approval rules](../assistant-approval-rules/plan.md),
[agent session containment](../assistant-runtime-containment/plan.md),
[execution authorization](../assistant-execution-authorization/plan.md),
[workspace lifecycle controls](../workspace-lifecycle-controls/feature.md),
[development controls](../app-development-controls/plan.md),
[prototype workspaces](../app-prototype-workspaces/feature.md), [authoring](../app-authoring/plan.md),
[app publication](../app-publication/plan.md), [AI Agent Bridge](../ai-agent-bridge/plan.md),
[entry points](../assistant-entry-points/plan.md) and [attachments](../assistant-attachments/feature.md).
App publication owns installable releases/feeds/catalog work; PR publication is source review.

Owner revision, 2026-09-26: retain the existing Hosty session implementation and evolve its
internal journal/commands for the requested functionality. Evaluate AHP early as a client-facing
adapter through a bounded spike; adoption does not gate provider switching, workspaces or PRs.
Keep the current web REST/SSE contract. The Swift client targets the official AHP SDK if the
client/auth/reconnect spike succeeds. A future web migration is optional, not part of this plan.
Rename, feedback, analytics, external context and synthetic evaluation retain separate approvals.

## Deliverables

- [ ] D1. Integrate shared session, source/workspace and PR identities across feature APIs and clients;
  verify recovery when a service restarts between prepare, attach, publish and observed result.
- [ ] D2. Verify the cross-feature user journey below without duplicating component implementation work.
- [ ] D3. Reconcile shipped feature documentation and ownership links as the complete journey becomes
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

Repeat the integrated journey with a directly connected external agent and no Harness conversation.
Include same-repository apps and an authorized dependency repository, preview reuse, instance Finish,
external PR linking and CI/review observations. Preserve installed-app data and unfinished worktrees;
verify replay/reconnect without duplicating instances or PRs. This acceptance belongs to D1-D2.

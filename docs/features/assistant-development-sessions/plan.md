# Shared Assistant Development Sessions

Status: Draft
Created: 2026-09-24
Updated: 2026-09-27

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

## Backend And UI Boundary (Owner Decisions, 2026-09-27)

The owner wants reusable session/context behavior with replaceable agent execution and independently
chosen assistant UI, without a broad architectural rewrite for the current rename. The immediate
selected scope is the [`assistant` interface and assistant handoff](../hosty-harness-rename/feature.md).
These decisions guide further design. They do not approve a new Core session subsystem.

Three roles stay distinct:

| Role | Responsibility | Current location |
| --- | --- | --- |
| Agent provider | Access to an agent (Codex, Claude) behind one agent interface | Inside Harness until that interface can be defined; later the candidate `agent` role of the [core extension model](../core-extension-model/plan.md) |
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
  Details belong to [PR lifecycle](../assistant-pr-lifecycle/plan.md).
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
  for live testing. Durable no-Git prototypes remain a separate supported path, without invented
  Git/PR guarantees. Disposable job validation in Agent Bridge remains distinct.
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
| [Session workspaces](../assistant-session-workspaces/feature.md) | Registered linked worktrees, agent instructions, diffs and cleanup; Core API authorization remains required, new filesystem isolation is deferred |
| [PR lifecycle](../assistant-pr-lifecycle/plan.md) | Publish/review/Merge/Complete, credentials, CI, ordered dependencies and corrective PRs |
| [Action summary](../assistant-action-summary/plan.md) | Evidence-linked aggregation/UI over Hosty invocation events |
| [Timeline analysis](../assistant-timeline-analysis/plan.md) | Later analysis over the event foundation; does not gate basic shared sessions or summary |
| [Feedback inbox](../app-feedback-inbox/plan.md) | Independent ordinary-user intake and admin triage/batch delivery outside the privileged Harness process |
| [External context exchange](../assistant-external-session-context/plan.md) | Later explicit local-agent read/prepare/report workflow |
| [Harness Swift](../hosty-harness-swift/plan.md) | Dedicated native client with independent delivery and notification decisions |
| [Sandbox runtimes](../app-sandbox-runtimes/plan.md) | Worktree runtime selection, runtime/data isolation and deterministic browser validation |
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

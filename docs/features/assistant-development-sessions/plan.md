# Shared Assistant Development Sessions

Status: Draft
Created: 2026-09-24
Updated: 2026-09-25

## Goal And Approval Boundary

Make a Hosty assistant session the durable home of a conversation and, when development begins,
its source changes, test runs and pull requests. The operator can plan with Codex, review and amend
that plan with Claude, then return to Codex to implement it without losing the discussion or changing
workspaces. Browser and native clients connect to the same host-resident work through Agent Host
Protocol (AHP).

This early Draft captures the owner's discussion on 2026-09-24 and follow-ups on 2026-09-25,
including feedback intake, action summaries/timelines and the Hosty Harness rename. Agreement with
the broad direction does not approve implementation, API names, storage layout, sandbox mechanisms
or migration defaults.
There is no new user-facing development task entity separate from the session. Feedback inbox
items are incoming observations that may be selected as session input, not a second development
workflow. The integration work owned here is listed below; existing feature owners retain their
deliverables.

## Owner Direction

- A session may remain conversational or operational, with no development workspace. App context
  can exist without source-edit permissions; read-only source access does not prohibit separately
  authorized app operations.
- On the first requested source edit, prepare and attach a managed worktree through Hosty. Propose
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

## Product Name: Hosty Harness

Owner direction, 2026-09-25: rename **AI Gateway** to **Hosty Harness** as part of this broader
redesign. Use that spelling consistently in the resulting product UI, app display metadata, setup
guidance and documentation. References to Gateway in this Draft still identify the existing
component and baseline; this documentation change does not rename the installed app today.

Owner clarification, 2026-09-25: change the application id as well as its display name. Planned
target: `hosty.ai-gateway` -> `hosty.harness`. The transition is an operator-performed uninstall of
the old app followed by a fresh Hosty Harness installation and manual configuration. No migration
or preservation of old sessions, history, provider settings, credentials or grants is required for
this replacement; the owner has no valuable state to carry over. Do not build an in-place upgrade,
legacy-id alias or automatic state import for this rename.

Update manifest identity, system-app registration/discovery, feeds/install references, token audiences,
permissions and client configuration coherently for the new id. Inventory related paths/routes and
documentation during implementation. A new installation must not silently reuse old credentials or
depend on the old app. This clean-install decision is specific to replacing the current AI Gateway;
the new Harness's normal source/session retention and safe workspace-cleanup requirements still apply.
This Draft does not uninstall anything now; the operator performs the replacement when it is ready.

## Baseline And Changes To Existing Direction

Baseline: `origin/main` at `19966275`, inspected on 2026-09-24 in an isolated documentation worktree.
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

## Ownership And Dependencies

| Owner | Responsibility and relation to this plan |
| --- | --- |
| This feature / Gateway | Durable session development associations, shared history, internal agent switching, AHP projection, session change/PR lifecycle, explicit external context exchange and the feedback-intake/batch-to-session workflow below; intake service placement is not yet decided |
| Core, integrated by this feature | Registered repository/worktree identity and lifecycle, source selection resolution, ownership and active-use checks; no model execution or conversation content in Core |
| [Assistant approval rules](../assistant-approval-rules/plan.md) | Source/command enforcement and scoped lifecycle authority for both harnesses; consumes registered worktree roots instead of trusting a path in chat |
| [App development controls](../app-development-controls/plan.md) | Typed inspect/enter/run/leave controls and Core runtime verification; this plan owns the additional session-source identity and picker |
| [Prototype workspaces](../app-prototype-workspaces/plan.md) | App creation, durable no-Git source, bootstrap/guide and assisted initial Git setup; consumes this session lifecycle once Git-backed development is selected |
| [App authoring](../app-authoring/plan.md) | Creation/integration journey and its own cross-feature acceptance; no duplicate development-session registry |
| [App publication](../app-publication/plan.md) | Hosted repository provisioning, app release/feed and catalog promotion; this plan's Publish means code PR publication, not an app release or deployment |
| [AI Agent Bridge](../ai-agent-bridge/plan.md) | App delegation, durable job authority and disposable non-interactive validation; reuse those mechanisms without copying their backlog |
| [Assistant entry points](../assistant-entry-points/plan.md) | Existing app-to-assistant draft forwarding and its trust boundary; the new feedback intake is a separate user submission path, not automatic sending through `ask-assistant` |
| [Assistant attachments](../assistant-attachments/feature.md) | Existing image/file presentation and harness delivery to reuse; current session-cache retention is not durable pre-session feedback storage |
| Shell / Gateway web clients | App source picker, feedback capture/inbox and session changes/PR views using the same server operations |
| [Hosty Harness Swift client](../hosty-harness-swift/plan.md) | Dedicated native remote assistant UI for sessions, approvals, changes and advertised actions; separate from the existing full Swift Shell and approved independently |

## Target Session Model

The session has one stable id scoped to a Hosty environment. Store structured references, not facts
that only exist in a model's memory: app/install identity, canonical repository identity, base commit,
target branch, workspace id/path, session branch, grant revision, observed source revision, test
evidence, pushed commit and PR ids/URLs, dependency/release observations and active runtime consumers.
Core is authoritative for workspace paths and lifecycle; Gateway holds durable associations to Core
ids. Exact storage and cross-service recovery are open design questions.

Allocate a workspace lazily when editing is authorized. Repeated preparation returns the existing
binding, including after a timeout/restart. Use one branch/worktree per session and repository, not
per app or provider. Merely discussing another app does not create a writable checkout. Changing
the selected agent does not allocate another workspace. Git remains the source-history mechanism.

Keep the complete session change view distinct from uncommitted changes: committing must not make
the apparent session diff empty. Group files by app where possible, with an explicit repository-wide
view for shared files and changes outside app subdirectories. Preserve provenance for final diff
inspection after workspace cleanup; decide retained Git refs versus a final review artifact before
implementation, without creating a general source snapshot/restore service.

### Managed Source And Override Transition

The owner prefers removing the arbitrary local source override from the normal workflow and using
Hosty-managed repositories as the origin of session worktrees. However, "latest version" must be
resolved before approval: installed/reviewed version, latest release and target-branch head differ.

Proposal: preserve the installed/reviewed source baseline, fetch the configured PR target branch and
create new worktrees from a recorded commit without changing the running baseline. Existing session
bases never move silently when the app updates. Fixing an older installed version may need an explicit
base choice. This proposal is not yet an owner-approved default.

Define canonical repository grouping for monorepos, managed repository placement, app-relative source
paths and how multiple installed apps share objects without duplicating worktrees. Do not assume
one clone per app is the final layout. Before removing overrides, replace their current role in
private-repository access and local development; preserve dirty files and unpublished commits in
existing operator folders. Removal is a migration, not deletion of those folders.

### Runtime Selection And Inspection

Keep runtime profile (how to run) separate from source selection (installed baseline or a specific
session workspace). Use one consistent root for cwd, builds, source mounts, manifest inspection and
diffs. Reuse existing inspected source/runtime contracts rather than rewriting an override setting
behind the user's back.

First proposal: one running source per installed app/environment. Several sessions can edit in
parallel, but selecting another for testing replaces that app's current test runtime. Show the
selected session and the actually running source separately until verified. Preflight, apply and
observe through Core; handle stale selections and failed startup honestly. Existing failure behavior
restores the prior selection and may leave the app stopped, not automatically healthy.

Record which source state a test verified. Later edits invalidate that evidence; hot reload or a
successful build alone does not prove the expected code is running. Worktrees isolate files, not
app data, processes, databases or build caches. Reuse app data only with the existing development
controls' compatibility checks. The follow-up
[sandbox runtimes and agent testing Draft](../app-sandbox-runtimes/plan.md) assesses separate test
data, concurrent runtime instances, browser testing and synthetic feedback. It owns those additional
deliverables; the single-runtime proposal above does not provide production isolation. Prefer a
sandbox for agent validation once its runtime/auth boundaries are available and verified.
Do not restart the editing Gateway or Core implicitly; self-development needs a separately verified
lifecycle path and must respect the one-Core-per-host rule.

## Shared History And Internal Agent Switching

Gateway owns the durable shared conversation and exposes it through an AHP-compatible state model.
Avoid an independent second transcript that can diverge from what the UI and agents see. Keep
messages, visible tool results, attachments and decisions attributable to the user and selected
provider/account. Native hidden state is not a portable transcript or a prerequisite for switching.

Select an available connected agent for the next turn. Initially, finish or explicitly interrupt
the active turn before switching; do not silently replay pending tools/approvals on another provider.
Retain workspace and policy identity while revalidating the selected adapter's actual capabilities.
An unsupported permission boundary must fail explicitly rather than broadening access.

Maintain native execution identities separately from the Hosty session, bound to the exact provider
connection/account. Never give a Claude session id to Codex or reuse a native id under a different
account. Track which shared events each execution has consumed. On return, supply all missing
relevant events once; if reliable native resume plus context injection is unavailable, start a new
native execution from the shared history. Imported results are historical evidence, not tool calls
to execute again or fabricated provider-native messages.

For long histories, retain the full accessible transcript while building a bounded model context
from recent turns, a versioned summary and retrievable earlier material. Read current plan/source
files after another agent edits them. Mark summary coverage and stale source observations. The
Codex-plan -> Claude-review/amend -> Codex-implement loop must work across Gateway restart as well
as ordinary switching. Changing providers does not count as a new development session.

## Session Action Summary

Owner follow-up, 2026-09-25: alongside source diffs, show a readable summary of the tools and MCP
calls used during the session. This also applies to operational conversations without source edits.
An operator should be able to see what the agent inspected, changed, tested or published without
reading every tool event. Example: inspected Media Server logs; changed four files; ran two test
commands, one initially failed and was retried successfully; opened a PR.

Provide two levels: a compact overview grouped by app/repository and action kind, with expandable
invocations showing the agent, tool/MCP server, purpose when supplied, observed status, relevant
target and bounded result. Link to source diffs, test evidence and PRs when explicit identifiers
support that association. A requested action or claimed intention is not proof of its effect.
Do not infer a file change's author or a successful test solely from a nearby tool name/event.

AHP's chat model provides tool-call lifecycle, names, optional intentions and input, MCP contributor
identity and results. Use those primitives for client presentation. Hosty owns aggregation and any
optional model-written narrative; AHP does not create a reliable session summary on its own. Native
adapter and controlled MCP-boundary observations must first provide stable invocation/turn ids,
provider attribution and terminal results. At this baseline, Gateway's normalized `tool_use` event
does not carry a correlated per-call completion, so a complete result summary requires adapter work.

Derive counts and outcomes from recorded events; distinguish pending, denied/cancelled, failed,
successful and unknown/incomplete invocations. Link retry attempts to a logical operation where
that identity exists; do not double-count replayed events or present retries as unrelated achievements.
Record producer-observed timing only when available rather than inventing tool durations. A tool's
success is not independently verified runtime health, CI success or satisfaction of the user's goal.

If a model produces the readable narrative, label it as generated and retain links to its supporting
events plus the last included event revision. Refresh after new work and provider switches without
replacing the underlying history. Show coverage gaps: external-agent reports are reported evidence,
not a complete trace of that agent's local tool calls. Both internal providers must expose comparable
coverage or clearly identify unavailable fields.

Use the existing authorization/audit ownership in assistant approval rules; this is a session view,
not another Core audit system. Redact sensitive arguments/results before persistence or model/client
exposure, bound retained output and keep access aligned with the underlying session/evidence. Decide
retention and detail limits before implementation. Summaries cannot authorize calls or replace merge,
test and Complete gates that use actual evidence.

### Timeline And Tool-Usage Analysis

Exploratory owner direction, 2026-09-25: extend the action summary with a timeline to understand how
agents work, improve their instructions and identify useful new MCP tools. This is a later analysis
capability built on observed events, not a requirement to automate instruction changes or tool creation.

Show turns and attributed actions over time: request accepted, provider execution, streamed response,
tool/MCP start and completion, retries, approval/user-input waits, cancellation and interruption.
Represent concurrent calls as overlapping spans, not a falsely sequential list. Use producer-measured
durations and event ordering where available; mark missing timing and clock uncertainty rather than
summing parallel durations into session elapsed time. Idle gaps remain unclassified unless their
cause is observed. An adapter-reported reasoning activity may be labelled as such, but silence is not
proof of thinking and this feature neither needs nor promises access to private model reasoning.

Allow filtering by agent/connection, app/repository, tool/MCP server, outcome and turn. Expand a span
to the same evidence used by the action summary. Initially inspect one session; aggregate authorized
sessions to compare call frequency, observed latency, errors, retries and recurring command sequences.
Retain coverage indicators and distinguish invocation attempts from deduplicated logical operations.
Normalize commands for grouping without retaining credentials or conflating different targets.

For possible alternatives to shell/CLI/direct HTTP calls, record the tool catalogue/capability and
permission revisions actually available to the agent at dispatch, plus the relevant instruction
revision. Distinguish advertised tools from tools loaded/discoverable at that point, and unknown
availability from confirmed availability. A similar MCP name alone does not establish equivalent
behavior: arguments, target, permissions and results matter. Present an evidence-linked suggestion
such as "this log-reading command may have an available MCP equivalent", not an automatic finding
that the agent bypassed a rule. Disabled, unavailable, unsuitable or unauthorized tools can justify
a direct command. External-agent activity outside observed channels remains a coverage gap.

Identify repeated pairs/sequences as candidates for a composite MCP operation, with representative
traces, frequency, failures and time spent. Repetition can reflect required verification, dependency
ordering or retries; reducing call count alone is not an improvement. A proposed combined tool must
preserve authorization, useful intermediate results and partial-failure semantics. Keep analysis
advisory: an administrator may revise instructions or request a new tool through normal development.
Do not execute captured commands during analysis or install generated tools automatically.

Store or reference the applicable agent/model, instructions and tool-schema revisions for comparisons.
Evaluate proposed changes on comparable tasks using correctness, checks passed, elapsed time and
retries as well as call count; a before/after chart is not proof that instructions caused a change.
Reuse the session event stream and existing telemetry/audit references instead of a conflicting
second execution log. Timing coverage, aggregation scope, retention and UI remain open design work.

## AHP Boundary And Remote Clients

Use AHP for discovery, shared session/chat state, history access, changesets, turn control and
confirmation/reconnection where the pinned capabilities support them. Hosty still implements Git,
permissions, runtime selection and completion semantics. AHP authentication does not implicitly
authorize workspace, publication or Core mutation operations.

The inspected specification has a session-level `provider`, multiple chats and multiple active
clients. That is not a guarantee of arbitrary cross-provider native-context migration. A required
design spike must choose and test the mapping, for example a stable Hosty orchestration provider
with an agent-selection configuration and attributed responses. Do not promise stock clients render
Hosty-specific operations or support switching merely because the server advertises them.

Choose SDK/protocol versions, map Gateway events to stable turn/tool identities, snapshots and
sequence cursors, and verify disconnect/replay behavior. A reconnect must not duplicate messages or
mutations; in-progress state must be reconstructible or honestly marked interrupted. Keep existing
REST/SSE behavior during a reviewed transition; do not assume a transport replacement is sufficient.

Web and the planned [dedicated Swift client](../hosty-harness-swift/plan.md) operate the same
server-resident agents and workspaces. The native plan owns phone navigation, app delivery and its
client acceptance; this plan owns the server contract and interoperability. No generic Swift Shell
side-panel implementation is required by this direction. Client
disconnect should not cancel server work; approvals can remain pending and be answered after
reconnection. Server crash recovery is a separate contract, not an automatic AHP guarantee. Scope
session ids and credentials to an environment so local and remote hosts cannot be confused.

## Publish, Review, Merge, Complete

These are proposed development states, independent of whether an agent turn is idle or running:
editing -> PR review -> partially/fully merged -> post-merge verification -> completed.
Record failures and per-repository state; Publish can recur, and early Draft PRs are supported.

Editable workflow instructions govern commit cadence, messages, PR content and how the agent
responds to review. Repository instructions and allowed merge methods remain applicable. Hosty
executes authorized Git/provider operations with structured results and recoverable identities;
the agent supplies descriptions and fixes. Publish creates or updates PRs for changed repositories
and preserves partial progress without duplicating a PR after an uncertain response.

Merge eligibility checks the latest pushed head, required CI, required approvals, unresolved review
threads/blocking reviews and provider mergeability. Ordinary discussion comments have no universal
resolved flag. Do not auto-resolve a review thread merely to pass a gate. Unknown/pending checks are
not success, and new commits require new evidence. The operator chooses a merge method permitted by
repository policy; this repository currently requires regular merge commits, not squash.

For independent PRs, prefer checking all candidates before starting merge. This is not an atomic
cross-repository transaction: revalidate each merge and preserve partial results. For dependencies,
store an explicit ordered plan such as SDK PR merge -> exact package version available -> update
consumer dependency/lockfile -> new CI/review -> consumer merge. An expected unpublished dependency
is different from an unexplained failing check. Detect unresolved ordering/cycles rather than
letting the agent silently waive eligibility. In this monorepo, Shell uses the workspace SDK, so
their compatible source changes can share one PR without waiting for npm publication.

Merge leaves the session open. Observe the required main-branch checks and publication runs for
the actual merge/corrective commits and exact artifacts, not an unrelated moving latest-main badge.
If a post-merge failure needs code changes, prepare a fresh corrective branch/PR linked to the same
session; a merged PR cannot receive another update. This is an explicit exception to the normal
one-PR-per-repository rule, limited to finishing the same feature. Re-runs without source changes
need not create a PR. Release success and installation/deployment are separate facts.

Complete finalizes the development session only when all required PRs, post-merge checks and artifact
conditions are satisfied and no session changes remain unpublished. Keep it viewable; subsequent
feature work starts a new session with optional copied context and fresh source bindings. Failed,
closed-unmerged or abandoned work needs an explicit disposition and is not silently called Complete.
PR/CI monitoring belongs to durable server work with scoped authorization, not an open browser or
an endlessly running model turn.

Cleanup is distinct from Complete. Remove only Hosty-owned worktrees/branches after checking dirty,
untracked and unpublished work, active agents/builds/runtime consumers and retained PR/history
references. Show why a workspace remains. Choose the return-to-baseline runtime behavior before
implementation; never delete a running source folder. Session deletion/retention and Gateway cache
cleanup cannot bypass this policy or erase source ownership records.

## App Feedback Inbox And Batch Session Input

Owner direction, 2026-09-25. Working name: **App feedback inbox**; final product naming is open.
Support bugs, broken interactions, confusing content, visual adjustments and improvement requests,
without forcing every observation into a bug category. The inbox lets people collect small items
before an administrator combines related work into one development session.

### Capture In App Context

Provide an entry point while using an app. A proposed capture mode lets the user select a component
or page region, add a comment, preview the captured evidence and submit. Capture may contain an
element highlight, a cropped screenshot or a page-level screenshot. The exact overlay, picker and
button placement require a capability/design spike; a report must remain possible with text and
app/page context when element selection or screenshot capture is unavailable, including an app error.

Record the trusted Hosty environment and app/install identity, reporter and timestamp, comment,
available page/route and app version/source observation, optional image and optional element locator,
label/bounds and viewport context. Separate verified app identity from app-supplied context. Keep
element information as reproduction evidence, not a guaranteed permanent selector or source-code
location. A moved/deleted element must not make the report unreadable. Preview the included context;
allow cropping/removal of evidence and avoid capturing credentials, hidden inputs or unrelated pages.
Do not require a full DOM dump or diagnostic-log collection for ordinary feedback.

### Submit Without Agent Access

Ordinary users can submit feedback for apps they are authorized to use. Submission creates an inbox
item only: no model turn, development session, source grant, worktree or privileged operation. The
reporter does not gain access to assistant conversations, repository paths or other users' reports.
This needs a narrow authenticated intake contract, not access to the administrator-only Gateway API
or the operator's delegated agent credential. Decide service ownership and reporter status visibility
before implementation; the current admin-only assistant boundary remains intact.

Keep reports and evidence durable before any session exists. Define their storage, retention and
access independently of disposable session attachment caches. Later attachment to a session must
not leave a broken screenshot when another session is deleted. Comments, screenshots and app content
remain attributed input data, not trusted instructions or permission grants, even after admin review.

### Administrator Triage And Grouping

An administrator opens the inbox, filters by app/status, reads comments and inspects screenshots and
page/element context from different reporters. Support selection of several related entries, with
the ability to leave other entries pending, identify duplicates or dismiss an item with a reason.
Grouping is an explicit operator choice, not an automatic promise that unrelated requests form one
feature. Cross-app selection is valid when it belongs to the same change; repository grouping still
follows the session's one-worktree/normal-one-PR-per-repository rule.

**Send to assistant** prepares a reviewable batch for a new or existing non-completed session. Show
the selected item ids, their evidence, suggested app context and the administrator's combined request;
let the administrator edit that request and explicitly send it. This action may start the agent;
the earlier report submission and mere selection may not. Selecting feedback does not grant source
access: reuse the existing development preparation and approval flow. Preserve provenance for each
item instead of flattening all reports into an anonymous prompt.

An administrator may use the same capture surface to save items for later or send a reviewed item
directly to a chosen session, without a mandatory inbox round trip. Ordinary users receive the
submission path only. Exact direct-send UX is a design question, not approval to auto-run page text.

### Traceability And Partial Results

Store batch/session links and the item revision/evidence selected at dispatch. A later edit to a
report must not silently rewrite an already accepted agent request. Retrying a batch submission must
not create duplicate sessions or model turns; show existing links when an item is selected again.
Allow partial treatment within a batch: one item may be fixed, another need clarification and a
third be dismissed or deferred. Track outcomes per item and link the relevant session/PR result;
neither attaching the batch nor merging one PR automatically marks every report resolved.

Proposed states include new, under review, linked/in progress, addressed, dismissed and duplicate;
exact transitions and the distinction between code merged, verified and delivered to the reporting
user remain open. Exposing a minimal outcome to a reporter must not expose the private development
conversation. This is feedback intake and triage, not a general project-management product.

The session receives the reviewed batch through its normal history/context model and can expose it
to AHP clients with authorized attachment access. AHP is not the user feedback store or an automatic
authorization route from a regular app user to an agent. Before Ready, decide whether capture/intake
ships as an independently approved feature; until then this Draft owns the unchecked work below.

## Explicit Local External-Agent Workflow

This is lower priority than internal switching and remote clients. Support an authenticated local
external agent receiving environment + session id (or selecting it), reading shared history and
registered paths, performing requested work, and explicitly saving an attributed report/summary.
New external work can create a visible Hosty session and request worktrees through the same registry.
No server-hosted model needs to be started merely to register that external work.

Hosty independently observes diffs and Git/PR facts. Saving external context must not implicitly
start an internal turn. Prefer available transcript fragments with source ids when explicitly
requested; label model-written summaries as summaries, not complete imported history. Deduplicate
repeated uploads. Automatic Codex transcript extraction/synchronization is excluded from this scope.

Use AHP for supported reads and MCP/API for Hosty-specific preparation/report operations. AHPX's
current `session import` saves a local CLI record; it does not upload history to the live server.
Do not base the workflow on that assumption. A read-only facade credential stays read-only; design
an explicit local authorization route for the new writes without exposing the Core control secret.

A possible Codex plugin packages MCP configuration, skills and setup guidance; a short repository
`AGENTS.md` explains how to use it. CLI installation is only needed if the chosen integration uses
that CLI. Teach the agent to use registered worktrees and read/save context at user-requested points.
Plugin packaging cannot be assumed to grant full Codex transcript access.

There is no mandatory external/internal ownership transfer. Show participant activity and possible
overlap; instructions ask cooperating agents to avoid concurrent edits. A local external agent with
unrestricted OS access remains outside Hosty's enforceable filesystem boundary. A heartbeat or lease
is not proof that its processes stopped. Do not claim this best-effort coordination is sandboxing.

## Deliverables Owned Here

- [ ] Resolve the open design questions and reconcile contracts with the linked owners; obtain
      explicit Ready approval before implementation. Preserve the lower priority of external work.
- [ ] Rename the product to Hosty Harness and change its application id to `hosty.harness` across
      manifests, registration/discovery, install/feed references, authorization and client setup.
      Document and test uninstall-old/install-new with manual configuration; no old-state migration
      or legacy-id compatibility is required.
- [ ] Validate a pinned AHP/adapter design for shared history, internal provider selection, native
      context rebuilding, reconnect and authentication; document tested compatibility and gaps.
- [ ] Implement durable session development bindings and registered Git workspace preparation,
      repository grouping, source-base selection, override migration and retention/cleanup ownership.
      Consume permission enforcement from assistant approval rules rather than duplicating it.
- [ ] Implement shared-history context assembly and internal Codex/Claude switching, including
      account boundaries, missed-event coverage, active-turn handling and restart recovery.
- [ ] Normalize correlated tool/MCP invocation lifecycle and results for both internal harnesses,
      then implement the session action overview and expandable evidence, with attribution, retry/
      replay handling, redaction, coverage gaps and optional generated narrative.
- [ ] Add the later timeline/tool-usage analysis view with observed overlapping activity, timing
      and coverage indicators, capability/instruction revisions, authorized aggregate metrics and
      evidence-linked candidates for MCP use or composite tools. Keep optimization suggestions advisory.
- [ ] Add session/app change views and session source selection; compose the existing development
      controls for runtime execution and verify the selected source actually runs.
- [ ] Expose AHP session/history/changeset/control capabilities and validate a remote client path,
      including capability discovery and compatibility with the existing Gateway interface.
- [ ] Implement session code-PR publication, durable review/CI observation, dependency-ordered merge,
      post-merge correction, Complete eligibility and safe cleanup with visible partial failures.
- [ ] Design and implement app feedback capture with optional region/element screenshots and a
      text/context fallback, narrow regular-user submission authority, durable evidence and an
      administrator inbox. Resolve service ownership and reuse attachment/entry-point mechanisms.
- [ ] Implement reviewed multi-item selection into a new/existing session, administrator direct-send,
      retry-safe dispatch and per-item session/PR/outcome links; preserve reporter boundaries and
      require separate source grants. Include the capture and batch acceptance cases below.
- [ ] Add the explicit local external-agent read/prepare/report workflow and its instructions;
      settle skill-only versus plugin packaging without adding automatic transcript synchronization.
- [ ] Complete the cross-feature acceptance cases below, publish shipped behavior in `feature.md`,
      remove this plan only when its scope is complete, regenerate the index and version affected
      artifacts when implementation ships. Documentation alone needs no version bump.

## Proposed Sequence

Resolve contracts and run the protocol/context spike first. Prioritize shared internal conversation
and provider switching, then managed development workspaces/diffs/runtime selection, then PR lifecycle
and remote-client acceptance. Feedback capture/inbox can be shaped in parallel, with batch dispatch
depending on the shared session/context contract; its release boundary must be decided before Ready.
Timeline/usage analysis follows the reliable action-event foundation and remains a later slice.
Explicit local external work follows the core experience. These are
planning phases, not an instruction to open one PR per phase. If scope becomes several independently
useful features, split their ownership into approved plans before implementation rather than silently
dropping deliverables from this Draft. Existing dependency plans keep their own status and approval.

## Open Questions Before Ready

1. Which pinned AHP versions and client capabilities support the desired UI, and how is Hosty's
   selected executor represented without pretending native providers share a session format?
2. What is the canonical history/context representation, attachment retention and summary policy?
   Which native adapters can resume with missing context safely, and when must they be recreated?
3. Does managed source follow the installed pin or target-branch head? What is the default new-work
   base, shared-repository layout, private-source credential path and non-destructive override migration?
4. What exact Core/Gateway contracts make prepare/attach and cleanup recoverable across partial
   failures, and keep ownership durable across transcript retention, app removal and Gateway removal?
5. What permissions and sandbox mechanisms protect baseline source and shared Git metadata while
   allowing registered worktree edits/project commands on both harnesses? Reuse the approval owner.
6. What happens to active test runtimes on Complete, and how are source-sensitive caches invalidated?
   What source identity and evidence make a test result stale?
7. Which repository provider ships first, which CI/review/release conditions are required, and what
   approvals govern ordered merges and dependent follow-up commits? How are cycles and abandoned PRs handled?
8. What history/diff evidence remains after cleanup, and what is the narrow local authority and
   packaging for explicit external-agent context exchange? A session id alone is not authorization.

9. Where do feedback intake and its durable evidence live, and what narrow authorization permits
   ordinary users to submit without agent access? What can reporters see, and how do retention,
   attachment access, batch retry and per-item outcome transitions work?
10. Which capture mechanism works for embedded apps, cross-origin frames, inaccessible DOM elements
    and broken pages? What SDK/host cooperation is needed, what is the fallback, and what are the
    final entry-point/inbox/direct-send UI and separate-feature boundaries?

11. Which invocation fields and results can each adapter reliably expose, what output is retained
    or redacted, and which action-summary details are deterministic versus generated? How are partial
    traces, timing, retry groups and associations with changed files represented without overclaiming?

12. Which timeline phases and monotonic timings are observable for each provider, and how much
    tool-discovery/permission/instruction history is available? Define aggregation/retention scope,
    command grouping, MCP-equivalence evidence and comparison criteria before building optimization UI.

13. Which repository paths, routes, build/publish references and client setup details need updating
    alongside the new `hosty.harness` app id? Inventory them for a coherent fresh installation; the
    owner has already chosen manual replacement without migration or legacy-id aliases.

## Verification And Acceptance

- Verify a fresh `hosty.harness` installation and the documented operator uninstall-old/install-new
  flow. Configure providers anew and check Shell/client discovery, permissions, new sessions and
  subsequent updates under the new identity. No old sessions/settings/credentials are imported and
  no old-app dependency or legacy-id alias is needed.

- Codex plans, Claude reviews and edits that plan, Codex implements the amended version in one
  visible session/worktree. Repeat after Gateway restart; verify attribution, no missing/duplicated
  context, no replayed tool mutations and no cross-account native-session reuse.
- Ordinary Q&A creates no worktree. First edit creates exactly one registered workspace; repeat
  preparation after an uncertain response. Two apps in one repo share it; two repos produce two
  bindings/PRs. A context-only app receives no source-write grant.
- Two sessions edit the same app in separate worktrees. The operator selects each from the UI and
  sees the expected running result and complete/uncommitted diffs, without agent assistance.
  Verify failed/stale switching, edits after testing and baseline/private-source migration behavior.
- Exercise early Draft PR, repeated Publish, review corrections, multi-repo partial publication,
  failed/unknown CI, unresolved reviews, stale head and concurrent merge changes without duplicate PRs.
- Merge an SDK dependency, wait for its exact artifact, update the consumer and require fresh checks.
  Test failed publication and recovery. Also test the monorepo Shell/SDK single-PR path.
- Fail a required post-merge job: Complete remains unavailable, a corrective PR remains in the same
  session, and successful correction/checks permit completion without unrelated later-main interference.
- Complete while a test runtime still uses the worktree: preserve source and report the cleanup
  blocker. Dirty/unpublished or operator-owned folders are never removed by session/cache retention.
- Connect/disconnect/reconnect a remote client to server-resident work; recover history and pending
  approvals without restarting completed actions. Verify environment/actor isolation and revoked access.
- On local Hosty, an external client explicitly reads a session, uses its worktree and saves a
  summary; the internal agent continues with that evidence. Re-upload is deduplicated, saving alone
  triggers no model run, read-only credentials cannot write, and direct-access coordination is labelled
  honestly. Remote direct filesystem editing is not an acceptance requirement.

- A regular user submits a page/element observation with comment and screenshot; it survives
  reload before any session exists. Verify no agent turn, workspace or elevated permission is
  created, and that another user's reports and administrator session are inaccessible.
- An administrator selects several reports from different users/apps, inspects the exact batch,
  adds a combined request and explicitly sends to a new or existing session. Only selected items
  and their evidence arrive, app context is proposed and source grants remain explicit. Repeated
  delivery after a timeout does not duplicate the session or turn.
- An administrator can capture and send directly to a session. A failed capture/broken page supports
  text/context fallback; a stale selector keeps the screenshot/comment usable. Cancelling capture
  or batch review creates no submitted report or agent work.
- Update a report after dispatch, delete an unrelated session, and complete only some items in a
  batch. The accepted evidence remains attributable and available, pending items stay pending and
  the reporter's permitted outcome view does not leak private conversation or repository information.

- In a session using both internal agents, exercise a successful MCP read, a rejected operation,
  a failing test followed by a successful retry, and a call interrupted by restart. Verify accurate
  per-call outcomes and grouped counts after reconnect/replay; unknown completion stays unknown.
  Expand the summary to its evidence, check that new work invalidates its coverage marker, secrets
  are omitted, and external reports are not presented as a complete observed invocation trace.

- Timeline analysis preserves concurrent call overlap, separates approval waits from observed
  execution, and leaves unexplained gaps unclassified. Reconnect/replay must not inflate statistics.
  Compare an available equivalent MCP tool with disabled, undiscovered, incompatible and unknown
  cases; surface qualified suggestions without declaring an unsupported bypass. Repeated command
  pairs produce inspectable candidates, not automatic tool creation, and missing external calls do
  not masquerade as zero usage. Instruction-version comparisons retain their evidence and scope.

## Protocol References

Inspected during the design discussion on 2026-09-24; pin and revalidate before implementation:

- [AHP session model](https://microsoft.github.io/agent-host-protocol/reference/session.html)
- [AHP chat/history model](https://microsoft.github.io/agent-host-protocol/reference/chat.html)
- [AHP changesets](https://microsoft.github.io/agent-host-protocol/reference/changeset.html)
- [AHP connection lifecycle](https://microsoft.github.io/agent-host-protocol/specification/lifecycle.html)
- [AHPX CLI](https://github.com/TylerLeonhardt/ahpx) and its
  [local history import implementation](https://github.com/TylerLeonhardt/ahpx/blob/master/src/bin.ts#L2410)
- [Codex plugin architecture](https://developers.openai.com/plugins/concepts/plugins)

Protocol and CLI references establish integration primitives, not evidence that the proposed Hosty
workflow already works. No runtime implementation or interoperability test is part of this Draft.

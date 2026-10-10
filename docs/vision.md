---
created: 2026-08-19
updated: 2026-10-10
---

# Hosty Platform Vision

The umbrella document: where Hosty is going, so individual decisions have a criterion to be judged
against. It authorizes no implementation and owns no deliverables — work it names is tracked in the
owning feature's `plan.md` — and it links the features it spans rather than duplicating them. It is a
living document outside the status workflow: when the direction changes, so does this file, and
its `updated` date says when.

## Thesis

Hosty is becoming a **tightly integrated pair of a hosting platform and an agent harness — where
hosting is what produces the harness's tool environment.** Installing an app is not adjacent to the
agent story; it *is* the agent story: an installed app brings its MCP tools, its telemetry, its
surfaces, and its identity, and the agent's reach grows by exactly that much.

This is not a hybrid of two products. The seam is already built, and every mechanism on it serves
both halves at once:

| Mechanism | Hosting half | Harness half |
| --- | --- | --- |
| Delegated tokens | app authenticates its user | the agent's per-call credential to app tools |
| `interfaces.mcp` | an app's self-description | the tool set of the assistant and of external clients |
| App identity | app→app authorization | how telemetry answers the agent |
| Telemetry | fleet observability | the agent's diagnostic tools |
| The manifest | what to run and how | which surfaces and tools appear |

The intended operator story: a small company hosts its working software on Hosty; an administrator
or a small team develops those apps *in* Hosty — edit, run, and test in place — and agents do an
increasing share of that work under the operator's control. Regular users work in the apps; their
feedback reaches development through surfaces built for it (an annotation overlay is the recorded
example), with the administrator approving what becomes an agent's task.

## App Creation And Development (owner direction, 2026-09-16)

The intended development loop includes creating apps inside Hosty: an administrator supplies an app
id, display metadata and a prompt, then sees a running prototype beside its assistant session and
iterates in place. An app may begin as a durable local folder without Git. Local does not mean
temporary: source must outlive the conversation, and a valid manifest still gives the app an identity
and version.

Assistant sessions can be associated with any installed app, or several apps, independently of
creation: the operator selects apps in chat or starts a new session from an app's menu. This context
survives panel reloads, and deleting a conversation never removes the ability to start another about
the same app. [Assistant app context](features/assistant-app-context/feature.md) owns that shared work;
context association alone changes neither tool grants nor the development workspace.

App creation is stack-neutral: the starting artifact is minimal metadata with an optional disposable
HTML preview, not a framework template. The agent chooses one or several services and their languages
from the request. Core-owned development guidance describes the platform contract; supported SDKs
simplify integration, while other languages use the same documented API directly.

Owner source-policy decisions, 2026-09-16: new apps use the existing `apps/<id>/source` directory,
including without Git. Reuse existing development/runtime mechanisms wherever they satisfy the
requirements. Core observes source state and warns before operations that could discard work;
Git owns history, and the assistant provides the explicit save/commit/push path. Hosty does not keep
source snapshots or restore history. Ordinary runtime command failures remain Core errors,
restarts are operator/agent-triggered, and new prototype autostart defaults to off.

The same loop extends to source-capable installed apps through declared development profiles and compatible
runtime profiles. Integration with installed apps uses their published interfaces and authorization
contracts. Optional promotion proceeds through repository history, remote source, installable
release/feed and a catalog contribution; the catalog maintainer retains the approval decision.
Those are separate milestones, not one publish flag, and none implies public network exposure.

The [app-authoring epic](features/app-authoring/plan.md) gathers existing mechanisms and assigns the
remaining work to prototype workspaces, development controls, integrations and publication. Its plans
are Draft: this direction does not approve their implementation choices. Interactive live editing
continues decision 2 below. Decision 10 adds session-owned worktrees for Git-backed interactive work;
non-interactive jobs with disposable validation remain the distinct Development Agent Bridge workflow.

## The Security Consequence

If installing an app extends the agent, then **installing an app is a capability grant**, and the
rules this repository already enforces stop being caution and become the product's core security
property:

- MCP providers are off by default; enabling one is a decision, not a side effect of installing.
- An app's `readOnlyHint` is an assertion, not enforcement; whose word counts is the operator's
  per-app choice.
- Assistant handoffs default to a draft. Owner clarification, 2026-09-27 (decision 16), permits an
  explicit receiver-side immediate-start setting for all authorized handoffs, including app prompts;
  prompt authorship is not treated as a verifiable authorization fact.
- External clients stay read-only until enforcement is real rather than labelled.

Any future feature that weakens one of these must say so in its plan, in those words.

## Decisions (owner; dates noted below)

Decisions 1–5: 2026-08-19.

1. **Administrator-only initial agent rollout (2026-08-19; clarified 2026-10-10).**
   The original direction deferred scopes and gave regular users AI only through functions an app
   builds on top of it, such as a "generate checklist from this task" button. Scoped credentials
   have since shipped. Direct Harness access remains administrator-only today; decision 28 retains
   ordinary-user conversations as a later capability after verified isolation, rather than a
   permanent prohibition. Decision 29 retains app-facing model/agent calls independently; their
   authority contract remains open question 1.
2. **Dev mode is the live-edit mechanism, and the update flow stays as it is.** An administrator
   flips an app to dev mode, edits through the agent, sees the change immediately; when done, the
   change goes back through PR → review → merge → update. Backups bound the data risk. Separate
   dev and production *installations* are the operator's own practice (and the owner's actual
   setup), not a platform-level split — what the platform owes is the mechanism of editing in the
   executing environment with immediate feedback.
3. **One Core per host, always.** A second Core adopting the live host's containers is a failure
   mode this project has already paid for, not a topology. Seeing live Core edits on a dev
   environment is wanted — without splitting environments into distinct installations — and is open
   question 4; no mechanism for it exists today.
4. **The extension model stays out-of-process, and contribution points grow as features need
   them.** Apps are the extension mechanism; the isolation, identity and credentials they already
   have are the point. In-process plugin composition (the Cordis / "everything is a plugin in one
   runtime" style) is explicitly rejected — Hosty's boundary is a protocol, not a shared object
   graph. What VS Code is the better reference for is *enumerable contribution points*: declared in
   a manifest, rendered natively by Shell when declarative, served by the app when rich. A future
   runtime kind for **micro apps that consume nothing until a request arrives** is the expected
   answer to "ten small extensions must not cost ten containers" — a direction, not a design.

5. **Hard at the perimeter, sovereign inside, legible between — and the administrator owns the
   install decision.** Three rings, because "security" means a different thing at each distance:
   - **The perimeter is hard and not negotiable.** External clients, the network, anything not on
     this host: authenticated, fail-closed, no functionality argument overrides it. This is the
     protection "извне" — and it is aimed at exactly the era the owner names, where agents find
     holes cheaply.
   - **Inside its own boundary an app is sovereign.** Protection mechanisms must not subtract
     capability; where a guard would block a function, the platform informs the administrator and
     lets them decide. The precedent already shipped: the remote-`localCommand` hard block became an
     amber install warning by owner decision — the dialog says *"Install it only from a source you
     trust — you do so at your own risk"*, which is this principle in one sentence. Do not
     reintroduce hard blocks where a warning does the job.
   - **Between apps, the platform owes attribution and containment — not policing.** "The admin owns
     what they installed" is only a fair model when installing app A grants A's *declared* reach and
     nothing more; one bad install must not silently become fleet-wide reach. This is not caution
     layered on top of the model — it is what makes the model coherent, and it is bought by the
     identity machinery, not by limiting what an app may do in its own ring.
   The original decision kept draft-only ask-assistant and providers-off-by-default as guards on
   third-party text steering the agent. Decision 16, dated 2026-09-27, explicitly relaxes the handoff
   draft guard through a separate assistant setting. Installing an app alone still does not enable
   automatic prompt execution or offer its MCP tools.

6. **Session development permissions apply to existing and new apps (2026-09-16).** An administrator
   can explicitly permit source edits and project commands for one or more apps in a session's
   context. Association alone grants nothing. Routine work inside that authorized boundary runs
   without repeated approval cards; filesystem, command and credential restrictions require verified
   enforcement on both harnesses. This changes the former every-write-asks policy within that boundary.
   [Assistant approval rules](features/assistant-approval-rules/plan.md) owns the permission choices;
   [session containment](features/assistant-runtime-containment/plan.md) owns the enforcement and
   experiment required before claiming an isolated capability (ownership revised by decision 32).
   App creation consumes these shared capabilities.
   The administrator owns the consequences of code they create and execute through localCommand,
   including malicious code. The current runtime executes under Core's OS account outside the agent
   sandbox; it does not provide filesystem isolation between apps. This qualifies decision 5's
   containment language for localCommand: API identity checks remain, but they do not isolate local
   processes. Explain this at development setup without prompting on every edit or restart.

7. **First development slice prioritizes app boundaries (2026-09-16).** Immediate revocation of
   already-running commands and further experiments on it are deferred tracked work. Permission
   changes apply to subsequent dispatch/resume; existing processes may finish with their original
   rights. Isolation between temporary folders is not a first-slice requirement. Shared scratch
   space is acceptable, while Hosty app source outside granted roots, Core state and credentials
   remain protected. Canonical protected roots under broadly accessible temporary directories need
   an explicit unsupported-placement policy, not an isolation promise. The remaining work and scope
   move to [session containment](features/assistant-runtime-containment/plan.md) and
   [workspace lifecycle controls](features/workspace-lifecycle-controls/plan.md) under decision 32.
   This historical native first-slice scope does not establish cross-session isolation for the later
   container backend.

8. **Profile-bound development; existing apps first (2026-09-16).** Development is a declared
   `development: true` runtime profile; `dev` is a convention, not a reserved key. Replace the independent
   operator toggle with reviewed profile selection and explicit compatibility handling. Profile commands
   supply hot reload; Core preserves edited source when returning to a reviewed runtime. Prioritize the
   existing-app edit → view/diff → explicit Git discard loop before creation. Development UI identifies
   branch/commit/changes rather than presenting manifest version as the source identity. Ordinary release
   updates and explicit Git synchronization stay separate. Git owns history; no-Git folders have no
   promised undo. Source and development-control plans own implementation; future branch management and
   Docker development are not prerequisites.

9. **App permissions and trusted confirmation (2026-09-18).** Runtime apps declare requested Core
   operations in their manifests; administrator review grants that set. User identity alone does
   not give an app the user's Core authority. Installation permission allows preparing a request;
   the final decision belongs to a Core-owned browser surface, independent of any Shell, and cannot
   be forged with an app token. Custom preparation UI remains supported. Permission increases on
   update cross the same trusted boundary. This adds app grants, not a redesign of user roles or
   external OAuth scopes. [App installation](features/app-installation-sdk/feature.md) describes
   the implementation and completed browser acceptance.

10. **Shared development sessions and clients (2026-09-24; clarified 2026-09-26).** A session owns
    a shared conversation and optional registered source workspace. Switching connected agents
    preserves visible context; clients control host-resident work. Keep source diffs and separate
    Publish, Merge and Complete. Prefer managed source with a verified migration from overrides.
    The [session umbrella](features/assistant-development-sessions/plan.md) coordinates independently
    approved feature plans, including rare explicit local external-agent context exchange.

11. **Feedback intake before agent work (2026-09-25).** Users can capture a region or UI element,
    add a comment and submit an app/page-linked observation; screenshots and element context are
    included where available. This covers bugs and improvements. Ordinary users submit without
    agent access. An administrator reviews the inbox, groups related items and explicitly sends
    the selected evidence and a combined request to a session. Administrators may also send their
    own reviewed observation directly. Submission alone starts no agent and grants no source access;
    feedback items are input to sessions, not a second development task model. The capture mechanism,
    narrow user-facing authority, durable evidence and triage UX remain Draft work owned by
    [app feedback inbox](features/app-feedback-inbox/plan.md).

12. **Dedicated native Harness client (2026-09-25).** Build a separate Swift client focused on
    Hosty Harness sessions over AHP, including remote conversation, permission/question requests,
    changed files/diffs and supported session actions. Agents and workspaces remain on the host.
    Phone usability is a primary requirement; compact navigation need not mimic desktop sidebars.
    The existing full Swift Shell remains separate. Generic panels in Swift Shell were considered
    but are not the selected scope, and this decision does not retire that client. The
    [Hosty Harness Swift plan](features/hosty-harness-swift/plan.md) owns native delivery, depends on
    the shared session server contract and remains Draft pending platform/UX/protocol decisions.

13. **AHP as a client interface (2026-09-26, revised after review).** Keep Hosty's existing
    session implementation and journal authoritative. Evaluate AHP as a replaceable external client
    adapter, with a bounded Swift/auth/reconnect spike. Existing web REST/SSE remains; provider
    switching and other internal features do not depend on AHP adoption. Swift targets the official
    SDK subject to the spike. This supersedes the earlier same-day AHP-first foundation/web-cutover
    decision; [client integration](features/assistant-ahp/plan.md) remains Draft.

14. **Authority comes from confirmed declarations, not the system label (2026-09-26).** What an app
    provides is a confirmed role in `provides`; what it may do is a permission in `corePermissions`.
    Keep permissions few, each tied to a real Core check and described in plain language. Required
    roles and permissions are accepted together or the installation is declined; optional
    permissions are offered unchecked and changeable later in the app's settings. `role: system`
    stops conferring privilege and remains an ownership fact. This extends decision 9 with app
    grants and leaves decision 1's admin/user model intact. The
    [core extension model](features/core-extension-model/feature.md) documents the shipped boundaries;
    [assistant provider permissions](features/assistant-provider-permissions/feature.md) is its first slice.

15. **Core is the MCP directory, not a proxy (2026-09-26).** Agents run on the host; how clients
    reach them is decision 13's AHP spike, and the directory does not depend on it. Core owns which apps' MCP servers agents may use and publishes that
    configuration without credentials; agents configure themselves from it and call each app
    directly, so tool traffic never passes through Core and the agent-bridge boundary stands. A
    single-entry facade for full external clients such as Claude Code or Codex becomes a separate
    app later. [Agent MCP directory](features/agent-mcp-directory/feature.md) owns the directory;
    [MCP facade](features/mcp-facade/plan.md) is On Hold.

16. **Assistant handoff execution is an explicit receiver-side choice (2026-09-27).** Default to
    a draft. If the operator enables immediate start in the assistant, every authorized finalized
    handoff may run without individual Send confirmation, including one submitted by an app.
    Do not claim to prove prompt authorship or exempt a self-reported "user" source. Authentication,
    caller access and execution/tool permissions still apply. The
    [Harness/interface plan](features/hosty-harness-rename/feature.md) owns implementation.

17. **Assistants choose development actions; Core executes and observes them (2026-09-27).**
    The assistant decides when to request a worktree, commit, push, draft/ready PR, merge and cleanup
    under user intent and repository instructions. Core provides and executes managed operations,
    enforces prerequisites/authorization and tracks durable results. It independently observes
    changes, commits, PRs, CI and review, including draft PRs, even when the assistant is stopped.
    Its value includes shared workspace lifecycle, recoverable operations and factual state across
    assistant implementations. Observations reconcile Git/provider reality, including external
    actions; assistant notifications only prompt refresh. Exclusive execution is an enforceable
    guarantee only after verifying process, filesystem and credential isolation. A worktree or cwd
    is not a sandbox. Native local commit permission and remote publication/merge permissions are
    independent decisions; keeping provider credentials in Core requires protecting them from
    agent processes and indirect access paths.
    Observed milestones are not an autonomous workflow: a commit does not create a PR, and passing
    checks do not authorize merge. Harness owns conversation and agent execution; Core owns the
    factual development state. Completed merged worktrees need not be retained for history:
    sessions keep PR references and Core can retrieve provider-held diffs/status. Authorized cleanup
    still respects active consumers and unpublished work. The
    [workspace](features/assistant-session-workspaces/feature.md) and
    [PR lifecycle](features/assistant-pr-lifecycle/feature.md) own implementation.

18. **Harness uses a coordinated breaking replacement (2026-09-27).** Ship Core, Shell and Harness
    changes in one feature PR; operators update Core first, Shell next, then replace the old Gateway
    with a fresh Harness installation and reconnect clients. Temporary assistant unavailability is
    accepted. Do not maintain old interface/ID aliases or old manifest/feed URLs; document that older
    installs must update and manually replace the app. Harness continues the Gateway version line
    with a minor bump. Shell requires the base versioned `assistant` contract and treats `attachments`
    as optional, with unavailable file/screenshot actions explained. The owner delegates handoff
    route, retry and cleanup design to the agent; the
    [Harness/interface plan](features/hosty-harness-rename/feature.md) records those details and owns
    implementation. This direction does not authorize live uninstallation.

19. **Usable delegated work and continuous embedded sign-in (2026-10-05).** The owner prioritizes
    usability and deliberate operator choices over repeated confirmation. Opening an app, assistant
    panel or embedded settings within an authenticated Shell must not routinely require another
    sign-in click. Keep app permissions and Core-owned identity, but provide session continuity.
    For assistant work, offer an explicitly selected autonomous session mode that includes native
    terminal/file operations as well as MCP; permitting all MCP tools alone does not satisfy this
    goal. Repeated approval cards for ordinary investigation defeat delegation and encourage blind
    approval. An operator who deliberately installs software or grants broad execution authority
    accepts responsibility for that choice. Do not describe broad native command access as an
    enforced workspace sandbox. This direction supersedes the product expectation that every native
    write must ask, but does not silently change current grants or authorize an agent to choose its
    own autonomy mode. The [session autonomy feature](features/assistant-session-autonomy/feature.md)
    implements the approved native approval control. The
    [embedded app sign-in feature](features/embedded-app-sign-in/feature.md) implements direct Core
    sign-in to the target app's frame without giving its credentials to Shell. Additional native
    isolation belongs to [session containment](features/assistant-runtime-containment/plan.md);
    prefix rules remain in the [approval rules plan](features/assistant-approval-rules/plan.md).

20. **Source providers belong to the platform (2026-10-07).** GitHub is the built-in Core source
    provider behind a typed internal contract, without a separate process. Shell owns personal
    account/Git identity management through a narrow reviewed permission; Harness consumes selected
    connections. This supersedes the earlier placement of account and private-install forms in
    Harness. Azure DevOps leaves active support while saved records remain explicitly unsupported.
    External provider applications and a plugin transport are outside this implementation. The
    [source providers feature](features/source-providers/feature.md) owns the shipped boundary.

21. **Workspaces is a separate ordinary app (2026-10-08).** Provide a dedicated UI over Core's
    registered workspaces, including clean and externally owned records, source changes, app impact,
    session ownership, publication evidence, runtime use and activity. Keep specialized source UI
    outside Shell and replace its dashboard workspace launcher when the app ships. Workspaces adds
    no provider role and owns neither conversations nor plan parsing. Open the recorded owner's
    session when possible; external agents may have no session URL. The
    [Workspaces app](features/workspaces-app/feature.md) documents the shipped read-only experience.

22. **Default applications belong to Core (2026-10-08).** Explore shared default choices for
    supported roles/provider interfaces, starting with shell and assistant. Shell renders settings;
    preferences do not grant permissions. This supersedes assistant selection being exclusively
    local to each UI client. Explicit owner/provider references always take precedence. Workspaces
    remains an ordinary app, and Plans does not become a provider by reading source documents.
    The [default applications plan](features/default-applications/plan.md) owns shared selection;
    the [replaceable UI-client plan](features/replaceable-ui-clients/plan.md) retains shell-specific
    work. Scope, fallback and migration details remain Draft.

23. **Plan providers are an early deferred exploration (2026-10-08).** Consider a small common
    plan/progress interface: Hosty Plans could supply specification-driven Markdown plans while
    other apps adapt task trackers or checklists. Providers own parsing and native workflow meaning;
    Core owns no universal plan format. MCP is a candidate agent interface, and direct authorized
    Markdown edits remain valid. The owner requested an idea sketch, not a settled protocol or
    implementation. The [plan-provider Draft](features/plan-provider-interface/plan.md) owns that
    exploration, independently of the Workspaces app.

24. **A session workspace contains repository worktrees (2026-10-09).** One session has zero or
    one workspace, allocated for authorized source work; the workspace belongs only to that session.
    It may contain worktrees for several repositories and apps, each with its own branches and PR
    history. Agent switching is deferred session work. The
    [workspace model](features/assistant-session-workspaces/feature.md) documents compatible grouping
    of per-repository worktree records and the inspection authority boundary.

25. **Read-only workspace inspection first (2026-10-09).** The initial
    [Workspaces app](features/workspaces-app/feature.md) shows workspace/worktree inventory, source
    changes, owners and existing publication facts. The read-only implementation has the separate
    `apps.workspaces.read` grant. Management capabilities and stronger operator/session-execution
    scope remain deferred. Later close
    must revoke development authority without equating it with physical deletion. Builds, tests
    and browser execution stay with [Sandbox](features/app-sandbox-runtimes/plan.md); plan linkage
    and PR-derived plan hints remain deferred. This vision does not authorize implementation;
    the initial viewer was implemented under the owner's subsequent explicit approval.

26. **Agent source isolation is deferred container work (2026-10-09).** Current unrestricted local
    agents follow assigned-directory guidance, with no promised filesystem containment. The later
    direction mounts only the owning workspace's worktrees into its agent execution environment,
    excluding original sources and other workspaces. [Agent isolation](features/assistant-runtime-containment/plan.md)
    owns the source/Git metadata boundary; [lifecycle controls](features/workspace-lifecycle-controls/plan.md)
    owns revocation, verified execution stop and safe cleanup. App Sandbox testing and agent switching
    remain separate deferred work. This direction is not implementation approval.

27. **One SDK panel system for Shell and standalone (2026-10-10).** Share panel hosting and
    presentation across the two modes. Shell owns composition for its window, including its own
    pages; a top-level standalone app uses the SDK host. Embedded apps delegate to the current host
    and do not grow nested panel rails. Keep blocking authentication recovery separate from the
    dock's layout/lifetime. The first complete scenario is Plans opening its finalized assistant
    discussion beside the source document in either mode. Provider selection remains separate from
    placement; opening an existing discussion cannot reselect its owner or invoke it again.
    Explicit separate opening uses the same session, without promising live UI/draft transfer.
    A standalone panel host is not automatically a full UI client or an approved embedder. The
    [SDK panel plan](features/sdk-panel-system/plan.md) owns the common system and first scenario;
    [Default applications](features/default-applications/plan.md) owns shared selection, and
    [replaceable UI clients](features/replaceable-ui-clients/plan.md) owns full-shell eligibility
    and primary navigation. The owner approved the direction and planning; implementation remains
    subject to the individual plans becoming Ready.

28. **Ordinary-user agents follow verified isolation (2026-10-10).** Retain free-text agent
    conversations for non-administrators once agent execution is fully isolated and its only action
    tools are MCP calls under the acting user's current app/resource rights. Existing administrator
    sessions must not be opened to ordinary users by changing a role check. Containerization is a
    dependency whose effective filesystem, network and credential boundaries need verification.
    [Isolated user sessions](features/user-agent-sessions/plan.md) receives Bridge D9 and stays On
    Hold; [session containment](features/assistant-runtime-containment/plan.md) owns the execution backend.
    This direction changes the
    permanent reading of decision 1, not current access or implementation approval.

29. **Apps can consume independent agent/model providers (2026-10-10).** Retain Bridge D10's
    app-to-AI purpose while replacing its central Gateway assumption. Agents become independently
    provided capabilities consumable by other apps through a common interface: a defined prompt
    can return JSON or another declared result. A provider may expose several models, including a
    future Ollama-backed provider of local models. Specialized speech, image and other providers
    coexist. Prefer an established API shape after comparison; no protocol is selected yet.
    [Agent and model providers](features/agent-provider-interface/plan.md) owns the Draft contract,
    extraction and caller authority. Distinguish inference from tool-executing agent runs so API
    compatibility never silently imports operator permissions. Existing Harness connections and
    assistant handoffs remain unchanged until an independently approved implementation.

30. **Workspace and Sandbox features replace the separate development bridge (2026-10-10).**
    Retire Bridge D12 as a separate workstream. Session workspaces and PR lifecycle own source and
    publication; their pending authorization/lifecycle work stays with the respective plans.
    Sandbox owns isolated runtime/data/browser verification, and development sessions own the
    integrated journey. General scheduled/non-interactive agent execution remains Bridge D11.
    This transfers ownership without claiming Sandbox or automatic source jobs already work.

31. **Retire the Core Extension Model umbrella (2026-10-10).** The owner agreed that its shipped
    concepts and outdated assumptions no longer form a useful standalone implementation plan.
    D1's permission inventory is approved as a read-only Shell Security page in
    [app permission management](features/app-permission-management/feature.md); remaining ownership,
    role-state badges and lifecycle consequences move to [replaceable UI clients D8](features/replaceable-ui-clients/plan.md#deliverables).
    D2's producer authentication moves to [Observability D1](features/observability/plan.md#deliverables),
    with network confinement staying in [Cross-App Dependencies D6](features/cross-app-dependencies/plan.md#deliverables).
    D3 moves to [Notifications D6–D7](features/notifications/plan.md#deliverables).
    D4's linked login methods and broker investigation move to [Auth Provider Extensions D6–D7](features/auth-provider-extensions/plan.md#deliverables).
    D5's remaining delegation, lifetime and vocabulary decisions move to [Cross-App Auth D7–D9](features/cross-app-auth/plan.md#deliverables),
    with facade adoption in [MCP Facade D6](features/mcp-facade/plan.md#deliverables).
    D7 becomes the current [extension boundary documentation](features/core-extension-model/feature.md).
    Agent/model providers remain in their [own Draft](features/agent-provider-interface/plan.md).
    This transfer does not approve those Draft or On Hold implementations; the permission inventory
    is the concrete implementation requested in this discussion. Structured `provides` objects and
    a generic extension framework are not prerequisites.

32. **Separate agent isolation from permission choices (2026-10-10).** The owner requested plan
    consolidation without implementation. [Agent Session Containment](features/assistant-runtime-containment/plan.md)
    remains On Hold and owns individual session execution boundaries, authorized workspace/Git
    access, credentials, network/native-tool enforcement and runtime stop evidence. A Docker profile
    for the whole Harness app is not a substitute for isolation between sessions.
    [Approval Rules](features/assistant-approval-rules/plan.md) remains Draft and owns grant scope,
    lifetime, confirmation rules, visible revocation and decision audit. Existing MCP rules and
    Normal/Autonomous are shipped dependencies; no every-write confirmation requirement is restored.
    [Execution Authorization](features/assistant-execution-authorization/plan.md) owns trusted Core
    execution credentials; [App Development Controls](features/app-development-controls/plan.md)
    owns app/action lifecycle authority. [Workspace Lifecycle Controls](features/workspace-lifecycle-controls/plan.md)
    coordinates close/revoke/cleanup using the execution backend's verified stop acknowledgement.
    App Sandbox and ordinary-user MCP-only acceptance keep their separate owners. Retired approval
    deliverable IDs are transferred with traceability, not marked complete or reused. Historical
    native-sandbox experiments are regression inputs, not proof of current-version containment.

## Expectations And Later Directions

- **Apps ship with source.** The default is open source; a company's internal apps are closed by
  their own choice and on their own responsibility. This expectation is load-bearing twice over: the
  develop-in-place story only works on apps whose source is present, and the analysis direction
  below is only meaningful against source.
- **Agent-performed app review.** A future capability, not a design: at install time the harness
  reads the manifest, the declared surfaces, and the source, and reports what the app can reach and
  whether anything looks malicious. The attachment point already exists — the install plan/review
  dialog is where the amber warnings live today. Advisory by definition: a model that misses a
  backdoor does not make the backdoor absent, so this sharpens the administrator's decision and
  never substitutes for the perimeter.
- **The gateway's name (owner follow-up, 2026-09-25).** Rename AI Gateway to **Hosty Harness**
  within the broader [shared development session redesign](features/hosty-harness-rename/feature.md).
  Owner clarification: change the app id too (`hosty.ai-gateway` -> planned `hosty.harness`). The
  operator will uninstall the old app, install the new one and configure it afresh. No old-session,
  settings or credential migration, in-place upgrade or legacy-id aliases are required. Update
  discovery, install/feed references and authorization consistently for the new identity. This is
  an unchecked Draft deliverable, not approval to implement or uninstall the current app now.

## Contribution Points, Named

Today's points exist but were each invented ad hoc: `ui.entrypoint`/`ui.navigation`, then
`ui.settings` and `ui.panel` ([app-ui-surfaces](features/app-ui-surfaces/feature.md)), and `interfaces.mcp`
([app-mcp](features/app-mcp/feature.md)). Widgets are a named future axis.

The direction this document sets: **the next capability does not invent a fifth seam** — it either
fits an existing contribution point or adds one deliberately, as a first-class, documented part of
the manifest contract. Two standing consequences:

- Confirmed assistant and speech providers satisfy the former Core Extension Model graduation
  criterion. Decision 31 retires that umbrella plan; new contracts remain feature-owned work.
- The manifest is becoming an API in the `vscode.d.ts` sense. The "never bump `schemaVersion` for
  ordinary changes" discipline holds while additions stay additive; the day a contribution point
  needs breaking change, the contract needs a real versioning conversation first.

## Open Questions

1. **How are app-only inference and user-attributed agent calls authorized?** Core already provides
   app provider grants and short-lived invocation credentials; system and ordinary apps share the
   assignment policy. Harness itself remains administrator-only. The
   [agent/model provider Draft](features/agent-provider-interface/plan.md) must specify when an app
   calls on its own behalf and when the acting user's current rights also bound every tool call.
   Reuse the existing provider foundation without exposing vendor secrets or allowing an app to
   borrow a provider's stronger permissions. Direct ordinary-user chat has its separate isolation
   gate in decision 28. Resolve the contract against the first real consuming-app scenario.
2. **What is the micro-app runtime?** Scale-to-zero, activation on request, cost near zero when
   idle. Shape, isolation, and how it differs from `localCommand` are all open.
3. **What does cross-environment integration look like?** The owner's setup is a local dev
   installation and a separate production host; wanted later: reading prod telemetry from dev and
   reproducing prod errors there. Today's answer is the SSH topology of
   [telemetry-mcp](features/telemetry-mcp/feature.md); anything richer is undesigned.
4. **How are live Core edits seen on a dev environment, with one Core per host and no installation
   split?** No mechanism exists today; running Core from source is the developer loop in this
   repository, not an operator affordance.

## Spanned Features

[workspaces-app](features/workspaces-app/feature.md) ·
[default-applications](features/default-applications/plan.md) ·
[sdk-panel-system](features/sdk-panel-system/plan.md) ·
[replaceable-ui-clients](features/replaceable-ui-clients/plan.md) ·
[plan-provider-interface](features/plan-provider-interface/plan.md) ·
[hosty-harness-swift](features/hosty-harness-swift/plan.md) ·
[assistant-development-sessions](features/assistant-development-sessions/plan.md) ·
[app-authoring](features/app-authoring/plan.md) ·
[core-extension-model](features/core-extension-model/feature.md) ·
[assistant-provider-permissions](features/assistant-provider-permissions/feature.md) ·
[agent-mcp-directory](features/agent-mcp-directory/feature.md) ·
[ai-agent-bridge](features/ai-agent-bridge/plan.md) ·
[user-agent-sessions](features/user-agent-sessions/plan.md) ·
[agent-provider-interface](features/agent-provider-interface/plan.md) ·
[app-ui-surfaces](features/app-ui-surfaces/feature.md) ·
[assistant-entry-points](features/assistant-entry-points/plan.md) ·
[agent-background-sessions](features/agent-background-sessions/feature.md) ·
[runtime-source-workflows](features/runtime-source-workflows/feature.md) ·
[telemetry-mcp](features/telemetry-mcp/feature.md) ·
[hosty-mcp-connector](features/hosty-mcp-connector/feature.md) ·
[cross-app-dependencies](features/cross-app-dependencies/plan.md) ·
[hosty-app-sdk](features/hosty-app-sdk/plan.md)

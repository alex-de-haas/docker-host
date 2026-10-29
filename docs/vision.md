---
created: 2026-08-19
updated: 2026-10-29
---

# Hosty Platform Vision

The umbrella document: where Hosty is going, so individual decisions have a criterion to be judged
against. It authorizes no implementation and owns no deliverables — work it names is tracked in the
owning feature's `plan.md` — and it links the features it spans rather than duplicating them. It is a
living document outside the status workflow: when the direction changes, so does this file, and
its `updated` date says when. Exploratory owner directions may remain here before any feature plan
is requested; they are not implementation commitments or a delivery schedule.

## Thesis

Hosty is a **modular platform for personal and shared environments, assembled from independently
installed applications.** Docker-based application hosting supplies the foundation. Applications
can serve their own purpose and extend the environment through tools, interfaces, data and UI
surfaces. An assistant can use the capabilities its user has enabled, alongside ordinary direct
interaction with those applications.

The environment may serve one person's everyday work, documents, media, entertainment and pet
projects; a household sharing selected photos, events and information; or a team coordinating
analysis, development and testing. Software development is one important use case. A project,
workspace, assistant, Shell or Marketplace must not become a conceptual prerequisite for every
use of Hosty. The desired minimal composition can simply host an application; richer compositions
add the applications and integrations their users need. Product vocabulary such as "environment"
does not introduce a new Core record or rename the existing sandbox/child-Core environment API.

The hosting and assistant capabilities already share useful mechanisms:

| Mechanism | Application environment | Agent integration |
| --- | --- | --- |
| Delegated tokens | app authenticates its user | agent calls tools under the acting user's authority |
| `interfaces.mcp` | app declares its tools | enabled tools become available to assistants and external clients |
| App identity | authorized app-to-app interaction | attributable access to each app's capabilities |
| Telemetry | runtime visibility | diagnostic tools for authorized agents |
| The manifest | runtime, identity and declared contributions | discoverable interfaces and UI surfaces |

Installing an application makes its declared contributions available under the platform's review
and access rules; it does not automatically enable its tools or share every user's information.
External connections, including document and email integrations, are further possible app-supplied
capabilities. An individual can keep a small, simple environment, while a family or team can choose
more shared tools and richer interfaces. The composition determines the experience.

The owner clarified this broader direction on 2026-10-23. Decision 52 and the
[exploration below](#personal-and-shared-environments-owner-exploration-2026-10-23) retain the
direction without selecting a new architecture, creating plans or changing existing implementation
status. Forms that are still raw live in [ideas](ideas.md).

On 2026-10-25 the owner selected a bounded next step: map the universal capabilities needed for
composable human and agent work and investigate their gaps. Decision 54 and the
[composable-work Draft](features/composable-agent-systems/plan.md) record this planning scope;
the broader exploration retains its separate open choices. Decision 55 records the 2026-10-26
clarification of shared tasks, agent participants, decisions and basic artifact handoffs, with
explicit workspace alternatives and learned memory deferred.

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
continues decision 2 below. Decision 10 records the original session-owned worktree direction;
decision 52 revisits that ownership for optional shared workspaces. Non-interactive jobs with
disposable validation remain the distinct Development Agent Bridge workflow.

## The Security Consequence

As applications extend the environment, **reviewed grants and the acting user's rights bound their
reach**. Installation, tool enablement and sharing are separate choices. The existing authority
mechanisms apply to personal, family and team use alike:

- MCP providers are off by default; enabling one is a decision, not a side effect of installing.
- An app's `readOnlyHint` is an assertion, not enforcement; whose word counts is the operator's
  per-app choice.
- Assistant handoffs default to a draft. Owner clarification, 2026-09-27 (decision 16), permits an
  explicit receiver-side immediate-start setting for all authorized handoffs, including app prompts;
  prompt authorship is not treated as a verifiable authorization fact.
- External clients use their reviewed scopes. Read-only access does not become write authority;
  the separately authorized local workspace path in decisions 46/47 retains its stated boundaries.

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
   [workspace lifecycle controls](features/workspace-lifecycle-controls/feature.md) under decision 32.
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
    a conversation and optional registered source workspace; clients control host-resident work.
    Decision 61 retires the original in-conversation agent-switching requirement in favor of
    separate sessions and explicit context handoffs. Keep source diffs and separate
    Publish, Merge and Complete. Prefer managed source with a verified migration from overrides.
    The [session umbrella](features/assistant-development-sessions/plan.md) coordinates independently
    approved feature plans, including rare explicit local external-agent context exchange.
    Decision 52 supersedes exclusive session ownership as the long-term direction: independent
    sessions may share a workspace. [Workspace sessions](features/workspace-sessions/feature.md)
    implements that collaboration; it does not share private transcripts.

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
    adapter, with a bounded Swift/auth/reconnect spike. Existing web REST/SSE remains; session
    recovery and explicit context handoffs do not depend on AHP adoption. Swift targets the official
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
    [retirement record](features/workspaces-app/feature.md) documents the 2026-10-20 decision to remove
    this separate application and its operator form while retaining Core APIs and Harness tools.

22. **Default applications belong to Core (2026-10-08).** Explore shared default choices for
    supported roles/provider interfaces, starting with shell and assistant. Shell renders settings;
    preferences do not grant permissions. This supersedes assistant selection being exclusively
    local to each UI client. Explicit owner/provider references always take precedence. The former
    Workspaces app added no provider role, and Plans does not become a provider by reading source documents.
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
    history. Decision 61 later retires in-conversation agent switching. The
    [workspace model](features/assistant-session-workspaces/feature.md) documents compatible grouping
    of per-repository worktree records and the inspection authority boundary. This remains the
    current allocation baseline; decision 52 replaces the exclusive-session assumption in the
    intended direction, with membership, independent lifetimes and compatibility still undesigned.

25. **Read-only workspace inspection first (2026-10-09).** The initial
    [Workspaces app](features/workspaces-app/feature.md) originally shipped workspace/worktree inventory, source
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
    owns the source/Git metadata boundary; [lifecycle controls](features/workspace-lifecycle-controls/feature.md)
    owns revocation, verified execution stop and safe cleanup. App Sandbox testing has its own
    feature and remaining acceptance; decision 61 retires in-conversation agent switching.
    Decision 35 later prioritizes a shared host boundary before
    this stricter session boundary. This direction is not implementation approval.

27. **One SDK panel system for Shell and standalone (2026-10-10).** Share panel hosting and
    presentation across the two modes. Shell owns composition for its window, including its own
    pages; a top-level standalone app uses the SDK host. Embedded apps delegate to the current host
    and do not grow nested panel rails. Keep blocking authentication recovery separate from the
    dock's layout/lifetime. The first complete scenario is Plans opening its finalized assistant
    discussion beside the source document in either mode. Provider selection remains separate from
    placement; opening an existing discussion cannot reselect its owner or invoke it again.
    Explicit separate opening uses the same session, without promising live UI/draft transfer.
    A standalone panel host is not automatically a full UI client or an approved embedder. The
    [SDK panel system](features/sdk-panel-system/feature.md) implements the common system and first scenario;
    [Default applications](features/default-applications/plan.md) owns shared selection, and
    [replaceable UI clients](features/replaceable-ui-clients/plan.md) owns full-shell eligibility
    and primary navigation. The owner subsequently approved and authorized the SDK panel implementation;
    Default applications and replaceable UI clients remain subject to their own Ready approval.

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
    integrated journey. General scheduled/non-interactive agent execution was retained as Bridge D11; its scope now lives in [Durable Agent Jobs](features/durable-agent-jobs/plan.md) after the 2026-10-26 transfer.
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
    at that point remained On Hold and owned individual session execution boundaries, authorized
    workspace/Git access, credentials, network/native-tool enforcement and runtime stop evidence. A Docker profile
    for the whole Harness app is not a substitute for isolation between sessions.
    [Approval Rules](features/assistant-approval-rules/plan.md) remains Draft and owns grant scope,
    lifetime, confirmation rules, visible revocation and decision audit. Existing MCP rules and
    Normal/Autonomous are shipped dependencies; no every-write confirmation requirement is restored.
    [Execution Authorization](features/assistant-execution-authorization/plan.md) owns trusted Core
    execution credentials; [App Development Controls](features/app-development-controls/plan.md)
    owns app/action lifecycle authority. [Workspace Lifecycle Controls](features/workspace-lifecycle-controls/feature.md)
    coordinates close/revoke/cleanup using the execution backend's verified stop acknowledgement.
    App Sandbox and ordinary-user MCP-only acceptance keep their separate owners. Retired approval
    deliverable IDs are transferred with traceability, not marked complete or reused. Historical
    native-sandbox experiments are regression inputs, not proof of current-version containment.
    Decision 35 revises the first milestone and returns containment to Draft planning; it retains
    the stricter session requirements as unfinished work.

33. **Explicit SDK composition across shells (2026-10-11).** Framing and presentation are separate.
    A plain standalone tab defaults to visible app navigation and access to authorized tools;
    a host explicitly chooses navigation/tool policy and owns placement. Supply both a standard
    manifest-driven SDK menu and a visibility boundary for custom navigation. A desktop shell may
    keep navigation in each app window while sharing an assistant window or dock; do not impose
    one assistant per app, a fixed desktop layout or conversation-selection behavior in the SDK.
    [SDK UI composition](features/sdk-ui-composition/feature.md) implements the mechanisms, extending
    decision 27's panel system. After the documentation-first pass and continuous-access work,
    the owner approved implementation on 2026-10-11. The coordinated defaults/UI-client plans
    retain their own approval and deliverables.

34. **Continuous trusted-app access and explicit unattended authority (2026-10-11).** Remove the
    product requirement for routine hourly Renew access while a trusted app remains in use.
    Maintain already-authorized access transparently, preserve current user/app rights and
    revocation, and give deliberately configured background work an independent, visible grant.
    App trust does not imply all user permissions, and browser activity is not background consent.
    [Continuous app access](features/continuous-app-access/feature.md) implements the session policy,
    SDK maintenance and durable Core grants after the owner's subsequent implementation approval
    on 2026-10-11. Cross-App Auth D8 is retired by transfer; the runner formerly tracked as Bridge D11 now belongs to [Durable Agent Jobs](features/durable-agent-jobs/plan.md) and consumes
    those grants. Container-based isolation and honest disclosure of unrestricted local commands
    remain separate from authentication UX. SDK UI composition remains deferred. Verification uses
    an isolated instance; this direction does not authorize changes to the operator's live grants.

35. **Protect the host before separating agent sessions (2026-10-13).** Prefer one shared
    administrator agent container for the initial local demonstration, with access to its dedicated
    data, explicitly shared worktrees and selected sandbox seed folders. It must not inherit
    unrelated host paths, production app data or unrestricted host control. Cross-workspace source
    visibility is an accepted initial limitation. Compare native, shared and per-session execution
    for startup/resource cost before selecting more isolation; one active agent without queueing
    suffices for the first demonstration. This revises decisions 26/32's sequencing, not the meaning
    of session isolation or decision 28's ordinary-user gate. [Containment](features/assistant-runtime-containment/plan.md)
    returns to Draft and tracks the shared milestone separately from its retained session target.
    Broad coordinator credentials must remain outside model-accessible execution. The
    [delivery plan](features/hosty-delivery-readiness/plan.md) records the November 5 target and open
    technical decisions; planning direction is not implementation approval.

36. **Sandbox instances belong to workspaces and use real Core users (2026-10-13).** Reuse
    [Docker source development](features/mixed-development-runtimes/feature.md) for additional
    app instances, with live source reload where the stack supports it, separate empty/synthetic
    data and instance-specific resources. A workspace may contain several app instances beside the
    normal installed apps. The agent can prepare test data only in the selected sandbox data area.
    Core remains the real identity provider; preview users are real Core users, while sandbox
    credentials, permissions, discovery and data stay separate from the installed app. This replaces
    Sandbox's synthetic-users-only assumption and removes production-data snapshot import.
    [Sandbox](features/app-sandbox-runtimes/plan.md) returns to Draft and owns runtime identity,
    lifecycle, local operator preview and Playwright testing. Core orchestration with Workspaces/Shell
    as clients is the proposed ownership split, still subject to the instance-contract design.
    Local preview is required first; remote preview remains optional. A live-data trial belongs to
    [Development Controls](features/app-development-controls/plan.md) and requires a separate
    operator action; passing tests or merging source does not trigger it. Existing workspace/Git/PR
    mechanisms compose with this journey, including commit/push, CI and review. No implementation
    or live-environment mutation is authorized by this direction.

    Follow-up on 2026-10-13: the owner approves the local network/resource profile and agent-created
    sandbox-only users with configurable roles and permissions, including administrators that
    cannot act outside their sandbox. The approved
    [identity contract](features/app-sandbox-runtimes/feature.md#parent-managed-child-core-environments)
    retains real Core operator preview and adds a separately typed, Core-managed test realm per
    runtime instance. This revises the real-users-only testing assumption, not global Core login
    or administrative authority. The owner clarifies that users and temporary resources belong to
    the sandbox: technical stop/restart preserves them, and Finish sandbox deletes the realm,
    credentials, data, caches and temporary artifacts. Source worktrees remain independent; reports
    survive only when explicitly exported. The Sandbox plan is Ready after this approval;
    implementation and verification remain unfinished. Other owning plans retain their own status.
    Decision 40 below supersedes mandatory workspace ownership with independent Core sandbox APIs.

37. **Collect durable observations, then review and optionally delegate (2026-10-13).** Extend
    decision 11: users and administrators can accumulate small app/element comments and submit a
    collection. Preserve unsent drafts and evidence across navigation/reload with visible save state.
    Prefer Feedback/Comments as working vocabulary rather than requiring formal issues. Administrators
    approve/dismiss, select and amend; dispatch is a separate action. They may send one batch to one
    session or explicitly let the assistant organize it into several tasks/sessions. Independent
    repositories can proceed in parallel; independent changes to one repository may use separate
    worktrees/PRs with overlap/merge-order handling. Every item keeps provenance and partial outcomes.
    [Feedback Inbox](features/app-feedback-inbox/plan.md) owns intake/grouping/dispatch integration;
    [Durable Agent Jobs](features/durable-agent-jobs/plan.md) retains general
    execution/delegation. Feedback remains optional for the local demonstration, and neither
    reporting nor approval alone launches an agent or grants source access.

38. **Adopt the design incrementally while preserving functionality (2026-10-13).** The owner
    continues refining the visual references. Start with finished colors, typography, logos and
    common styling, then apply prepared Shell layouts and extend their patterns elsewhere.
    A mockup is not an exhaustive feature specification: absent actions, states or permissions
    must not disappear from the product. [Design System](features/design-system/plan.md) owns the
    parity inventory and verification along with its existing visual deliverables. Readiness of
    individual references does not approve all remaining layout/activity decisions or promise
    completion in a single session.

39. **Keep agent execution and application sandboxes separate (2026-10-13).** The owner confirms
    that an agent worker runs in its own container and each sandbox app executes in separate
    runtime containers. Core or a trusted launcher owns creation; source and selected synthetic
    seed access connect the worker to an instance without exposing Docker control or the agent's
    provider home. One shared agent worker remains sufficient for the first milestone; this does
    not require one agent container per session. The two dated container experiments exercised
    agent commands, including application compilation/tests in the second run, but no app server.
    Their memory results do not measure a running agent-plus-app pair. General build placement is
    still open under [Containment D9](features/assistant-runtime-containment/plan.md); separate
    runtime, reload, preview and browser acceptance remain under
    [Sandbox](features/app-sandbox-runtimes/plan.md). Recording this distinction approves no new
    implementation or experiment.

40. **Sandbox is an independent Core capability (2026-10-13).** The owner requires a permissioned
    API usable by any authorized app, including QA and recurring performance-test workflows without
    code changes. Core owns instances, resource/input authorization, temporary users/data, preview
    and complete cleanup. Workspace/worktree and Harness-session integration is optional client
    context, not the service's owner or a mandatory creation dependency. Reviewed worktree inputs
    retain their source leases; pinned app artifacts support runs without workspaces. Callers own
    schedules, scenarios and exported results. Unattended execution requires an explicit revocable
    sandbox grant; current background installed-app actions do not implicitly authorize it.
    [Sandbox D1/D2/D6/D12](features/app-sandbox-runtimes/plan.md#deliverables) owns this boundary and
    independent-client acceptance. This refines decision 36 and the Ready plan without adding a
    scheduler or autonomous optimizer to Core; implementation and verification remain outstanding.

41. **Sandbox separates app data while allowing approved integrations (2026-10-14).** The owner
    defines a practical development/test environment, not malware containment. Internet is a required
    capability; offline remains a selectable profile. Operators can persist approval for internet,
    selected installed/shared providers, shared-folder mounts and specific Core operations so agents
    work autonomously within that scope. Separate instance IDs/data/cache/credentials remain the
    baseline; read-only mounts are enforced, and shared database resources require real provider-side
    separation. Multi-app dependency scenarios and an authorized sandbox creating other sandboxes
    are valid uses of the independent API. Reuse Core's existing permission, dependency and mount
    mechanisms and keep code small; avoid a parallel identity system or universal proxy framework.
    Public production URLs may be reachable with internet access; existing endpoint authentication
    and explicit grants, not the word sandbox, determine authority. Dependency discovery currently
    does not supply universal peer authorization. These qualifications refine decisions 35/36/40.
    [Sandbox D13-D17](features/app-sandbox-runtimes/feature.md#parent-managed-child-core-environments)
    owns the extension and its checks. The current verified implementation is still the offline profile.

42. **Prefer dedicated sandbox dependencies and explore scoped Core state (2026-10-14).** In the
    later discussion the owner prefers separate dependency app instances over sharing installed
    Transcode Engine/database services; approved shared mounts and internet remain useful exceptions.
    Test-user roles are limited to assigned app instances. The owner proposes disposable Core data
    namespaces for workspace, session, key and child-sandbox operations. The implementation proposal
    distinguishes an environment from its individual app instances, scopes both users and service
    principals, and cleans up owned resources rather than everything created by one user. Host-only
    operations and app-owned records need explicit treatment. This refines decision 41; it does not
    approve a blanket migration of all Core APIs or claim those namespaces already exist.
    [Sandbox D14/D16-D19](features/app-sandbox-runtimes/feature.md#parent-managed-child-core-environments)
    owns the contract review and implementation; shared installed providers stay deferred under D14.

43. **Use trusted same-host test Core instances with shared Docker (2026-10-14).** The owner selects
    separate Core processes, ports, browser origins and data roots on the same machine, without a VM
    or mandatory Docker API broker. This supersedes decision 42's proposed token-scoped Core stores
    and extra sandbox role distinctions. Each instance uses normal users/roles and can run modified
    Core source together with its test apps. Core is trusted; shared Docker authority is accepted,
    and operators requiring a physical boundary use a separate host. The primary Core should own
    environment lifecycle and cleanup, including graceful child stops. Process parentage alone does
    not implement that guarantee. The owner authorizes the local experiment now; its result and the
    remaining parent manager are tracked by [sandbox D18-D21](features/app-sandbox-runtimes/feature.md#parent-managed-child-core-environments).

44. **Prefer SSE where a screen needs background updates (2026-10-16; clarified the same day).**
    The owner recommends SSE for screens whose architecture, user request or interaction model
    calls for background updates, such as Dashboard metrics and active Harness conversations.
    Frequent changes and existing streaming infrastructure make this particularly useful. Prefer
    renderable state or versioned deltas where practical so the view can react on arrival.

    This is not a mandate to make every screen live. Rarely changed settings can load on entry,
    refresh after an action or offer explicit refresh; updates must preserve unsaved form edits.
    Agents may choose polling, event-triggered fetching or another suitable refresh strategy based
    on freshness needs, request volume and implementation/maintenance cost, without a separate
    exception approval. Avoid building dedicated streaming infrastructure where its value is small.

    Where streams are used, share existing connections within authorization boundaries and handle
    visibility, reconnect and missed-data recovery. Browser suspension and native SSE reconnect
    alone do not recover application state. The
    [resource delivery implementation](features/runtime-resource-usage/feature.md) remains scoped to Dashboard
    and its shared-stream support; it does not authorize a migration of every screen.

45. **Harness becomes the development workspace UI (2026-10-16).** The owner wants a full Harness
    page combining conversation, workspace changes, PR/CI/review and reusable sandbox previews, while
    keeping the side panel for quick assistance. This revises decision 21's preferred UI placement;
    Core still owns independent workspace/sandbox APIs and other clients can use them. The later
    layout clarification groups Harness sessions by associated apps, with unassigned sessions at
    the end. The owner subsequently places the main chat in the center and workspace details on the
    right, omitting that panel entirely until a workspace exists. A separate External workspaces tab
    shows Core-registered external work and its details without a conversation or history import;
    Sessions itself adds no parallel workspace list. Details list each repository's change popup,
    then sandboxes and PR/CI/review rows. Plans remains
    separate and optional; editable default instructions can use SDD without making it mandatory.
    Agents prepare workspaces and preview data through existing authority. Technical restarts and
    iterations retain sandbox data until explicit lifecycle completion. External workspaces must
    remain inspectable without fabricated Harness conversations. [Harness development UI](features/harness-development-ui/feature.md)
    owns layout/migration; [lifecycle controls](features/workspace-lifecycle-controls/feature.md) owns
    operator completion/removal. The owner also allows independent automatic retention for quick
    chats and completed development sessions, but explicitly rejects expiry of forgotten unfinished
    features: only verified completed/merged work becomes eligible. [Harness retention](features/harness-session-retention/feature.md)
    owns those settings, eligibility and recovery. Two days/one week are examples, not selected
    defaults. A local Git repository before optional remote publication is a candidate revision to
    [prototype workspaces](features/app-prototype-workspaces/feature.md), still to be reconciled with the
    earlier no-Git design. On 2026-10-16 the owner approved the revised Harness information structure
    and requested it be recorded: the UI plan is Ready, with detailed styling deferred to the
    [Design System redesign](features/design-system/plan.md). Lifecycle, retention and prototype
    plans retain their separate statuses. No implementation starts or current-resource deletion is
    authorized by this recording request. Subsequent owner approval on 2026-10-17 selected local Git
    without publication, one consented bootstrap commit and child-Core Docker preview; the
    [local creation feature](features/app-prototype-workspaces/feature.md) records that implementation
    and resolves the earlier no-Git candidate for this creation flow.
    Decision 52 reopens long-term UI/component placement and session/workspace retention boundaries.
    The existing Harness integration and Workspaces-app retirement remain the implementation
    baseline; no extraction, restoration or data migration is selected by that exploration.

46. **Platform-managed development before retiring legacy source controls (2026-10-16).**
    The preferred internal and external agent journey is: request source through Hosty, receive
    a registered workspace/worktree, edit there, ask Hosty for sandbox instances, inspect/test
    through browser previews, finish instances, publish PRs and follow CI/review through Core.
    A workspace groups repository worktrees; apps in one repository share a compatible tree,
    while another dependency repository adds a tree to the same authorized work context.
    Preparing source or a sandbox does not replace an installed application's runtime or source.
    External agents use the direct Hosty connector/MCP for managed operations and edit the path
    Core returns; a path is local only when the agent has access to Core's host filesystem.

    Source-based runtimes remain. Host-native `localCommand` execution is a separate concern:
    the owner is considering stronger restrictions or removal, and the current installed-app
    local dev workflow and arbitrary source overrides may become unnecessary. No option is
    selected for removal yet. First exercise the workspace/sandbox workflow, verify parity and
    obtain explicit owner acceptance; preserve existing capabilities until an approved migration.
    Keeping source in Hosty does not eliminate an execution environment: sandbox containers run
    the application with their own data, resources and browser identity. MCP coordination alone
    does not sandbox a native external editor or revoke its operating-system access.

    This revises decisions 2/8/10's development direction without changing Sandbox's independent
    API boundary in decision 40 or granting publication/lifecycle rights through workspace access.
    [Source recovery](features/runtime-source-workflows/plan.md) is On Hold rather than becoming a
    permanent redesign of the old controls. [Development Controls D1](features/app-development-controls/plan.md#deliverables)
    owns parity and conditional retirement; [external development](features/external-development-workspaces/plan.md)
    owns missing direct-client adapters/authority; [Development Sessions D1-D2](features/assistant-development-sessions/plan.md#deliverables)
    owns integrated acceptance. Sandbox and PR services retain their own implementation ownership.
    This direction authorizes documentation alignment, not new implementation, experiments or
    removal of `localCommand`, overrides or development profiles. Decision 52 additionally explores
    bringing an existing local repository into Hosty without a duplicate checkout. That candidate
    does not change the managed-source workflow required by decision 48 and repository instructions.

47. **Built-in agents are the normal constrained path; external agents are a trusted exception (2026-10-16).**
    The owner expects most edits through the built-in assistant, including remote operators and
    administrators with narrower development rights. Privileged local external agents are an
    infrequent owner/host-operator tool. "Super administrator" and "restricted administrator"
    describe intended access profiles here, not new implemented role names or an approved RBAC schema.
    Remote restricted development uses the built-in assistant with verified execution, source,
    credential, network and operation boundaries. Existing broad administrator checks and the
    initial shared trusted-admin runner do not establish that narrower access model.

    External clients normally prepare source, request sandboxes and manage workspace lifetime
    through Hosty because the documented API is convenient. Instructions coordinate their use;
    Core does not promise exclusive control over their native filesystem/Git/provider actions.
    Local edits and commits must reconcile from Git regardless of origin. PR/CI/review facts come
    from the authorized provider and require a verified repository/branch/head association; they
    cannot be inferred from Git alone. Observe external facts without inventing Core mutation audit
    entries or inferring that an observed merge authorizes further actions or source deletion.

    Make sandbox preparation, readiness, preview, logs, retries and Finish easy to discover and
    use, with practical examples and actionable failures. External native publication must not
    corrupt workspace tracking or make a Core-only publish path a correctness prerequisite.
    [Sandbox D6/D9](features/app-sandbox-runtimes/plan.md#deliverables) owns client usability;
    [external development](features/external-development-workspaces/plan.md) owns its adapters and
    external-action reconciliation acceptance. [Execution Authorization](features/assistant-execution-authorization/plan.md)
    and [Containment](features/assistant-runtime-containment/plan.md) own restricted-operator
    authority and execution prerequisites. Ordinary-user MCP-only sessions retain their separate
    [On Hold plan](features/user-agent-sessions/plan.md). Source/native-runtime retirement remains
    conditional under decision 46; this clarification approves no new implementation or access grants.
    Decision 52 broadens the product beyond this development-client preference: a hosted assistant
    is an optional component of the environment. Existing authorization and execution limits still
    apply to whichever clients are used.

48. **Managed source and sandbox become the default local workflow (2026-10-18).**
    Preserve unpublished plans before retiring old checkouts. Use Core-registered workspaces for
    Hosty source changes and child Core sandboxes for runtime/browser verification with separate
    test data. Apply this guidance to shared agent instructions and Hosty repositories. Clear
    obsolete Source overrides only after checking their consumers and durable source alternative.
    The operator deletes legacy repositories manually after preservation and dependency checks;
    neither a clean Git status nor a merged PR proves that an entire checkout is disposable.
    This operational migration does not remove supported runtime types or override APIs. Unified
    live-data dev mode remains an explicit authorized trial in the existing Core, with Return;
    it is not replaced by attaching production data to a child Core. Repositories not registered
    as Hosty source keep their documented workflow until an explicit integration or fallback exists.

49. **Docker and Local are ordinary Harness production runtimes (2026-10-20).**
    The owner requires two equally supported production profiles, Docker and Local, with Docker
    declared as the manifest default. Users select either at installation or later through normal
    Core runtime controls. Core owns the selected profile and the common behavior for remembering
    a user's production preference. Local is not a privileged-task mode or a chat-level override.

    The [production-runtime feature](features/assistant-shared-docker-runtime/feature.md) records verified Docker
    packaging, lifecycle integration, compatibility and acceptance, reusing the shared Codex/Claude
    worker. Development profiles are separately marked `development: true`; their redesign and
    general preference persistence remain platform work. Runtime startup failures use the normal
    Core diagnostics. This clarifies decisions 35/46/47 while retaining the separate per-session
    isolation and application-sandbox work. The feature records the shipped production profiles and their acceptance limits.

50. **Declare agent execution as an ordinary service; keep its traffic out of Core (2026-10-20).**
    The owner requests a redesign plan for the worker as a normal Harness service in `services[]`,
    with its own lifecycle, private endpoint, health, logs and resource visibility. Harness calls
    that service directly; Core retains ordinary runtime, identity, discovery and workspace
    responsibilities without a provider-specific exec/stdio proxy. This revises the transport and
    special-container integration of the shared-runtime implementation, while retaining decision
    49's Docker/Local profiles and decision 35's separation of broad coordinator authority from
    agent execution.

    Native Windows Core with Linux Docker containers is a first-release acceptance target, alongside
    macOS/Linux verification; running Core inside WSL does not substitute for the Windows target.
    Keep the application API independent of Harness's UI/storage so an agent can later become a
    separately installed provider. The [worker-service redesign](features/assistant-shared-docker-runtime/plan.md)
    owns the concrete service/API replacement and clean Harness update. The
    [agent-provider plan](features/agent-provider-interface/plan.md) retains public protocol selection,
    provider discovery/authority and independent application extraction. No provider protocol is
    selected by this direction. This request authorizes a Draft plan, not implementation, production
    lifecycle changes or removal of existing data.

51. **Keep the Harness worker cooperative and preserve external workspaces (2026-10-20).**
    The owner clarifies decision 50: mount the entire managed worktree parent once, allow sibling
    access within that shared directory, and avoid per-session containers or custom containment
    machinery. Creating or deleting an eligible child worktree must not require restarting worker
    or Harness. Track specific active work/consumers; parent-mount visibility alone must not become
    a global cleanup lock. Existing external-agent activity leases and normal dirty/unmerged/source
    checks remain authoritative. This deliberately accepts cooperative access, not exclusive use
    or detection of every undeclared background process.

    The production Harness can start with clean app state; old conversations and native provider
    sessions need no migration. Local external workspaces and their Core registry, Git metadata,
    paths and active consumers must remain intact, including old trees kept for later cleanup/UI
    testing. Core already owns these workspace records and files independently of Harness;
    changing Harness requires no workspace migration, import, restore or preservation job. Treat
    their unchanged state as an update regression check. Do not add bulk Git conversion or a
    history migration framework to preserve them.
    The [worker-service plan](features/assistant-shared-docker-runtime/plan.md) owns this revised
    scope; stricter isolation stays in [containment](features/assistant-runtime-containment/plan.md).
    This records a planning decision, not a request to perform resets, remove current workspaces
    or interrupt parallel external agents in this session.

52. **Explore personal and shared environments assembled from applications (2026-10-23).**
    The owner broadens the product framing from hosting plus development to everyday personal,
    family and team environments. Preserve the existing modular foundation and investigate useful
    extension boundaries as scenarios become concrete. Optional workspaces, independent sessions,
    reusable knowledge, collaboration and QA tools are composable capabilities. The
    [exploration below](#personal-and-shared-environments-owner-exploration-2026-10-23) records the
    direction; [ideas](ideas.md) I1–I2 and I12–I16 keep the possible forms and unresolved choices. It revises the long-term exclusive-session assumption in decisions
    10/24 and reopens the packaging and retention choices around decision 45; it does not reverse
    shipped behavior, select component extraction or weaken existing access boundaries.

    The owner explicitly requests vision capture only: no new plans, deliverables, implementation,
    prioritization or near-term schedule. Existing plans retain their statuses and scope; references
    below identify related work without assigning these ideas to it. Any later selected work needs
    its own planning and approval under repository policy. No live data or source is changed by this
    direction, including the local-repository scenario.

53. **Core is an app-neutral platform (2026-10-22).** Core must remain usable with no standard
    applications installed. Startup, authentication, configuration, CLI/API management, recovery and
    source/resource safety cannot depend on Shell, Harness, Marketplace, Telemetry, Plans or any
    vendor's application. App identity, display name, vendor and repository/path spelling confer
    no special runtime behavior, privilege, ownership or platform role. Consume explicit registered
    facts, confirmed roles, versioned interfaces and current grants instead.

    Core must not construct or interpret a first-party app's internal navigation routes as platform
    knowledge. A different origin does not make a Shell-specific path a generic UI contract. App
    destinations belong to a separately reviewed navigation/object-link/declared-adapter contract;
    its representation is not selected by this decision. Missing or unsupported optional providers
    produce explicit unavailable/recovery states while Core remains operational. The reserved
    `hosty:core` identity denotes the platform resource and its authority, not a built-in runtime app.

    Distribution catalogs and manifests carry application identities as data, not platform policy.
    Any historical exact identity needed for a bounded, one-time migration remains migration data;
    it is never a runtime fallback lookup or an authority grant. This direction does not select a
    new UI schema, approve the existing Draft proposals wholesale or claim legacy coupling is fixed.
    The [Core application-boundary audit](reviews/2026-10-22-core-application-boundaries.md) records
    the remaining violations. [Replaceable UI Clients D3](features/replaceable-ui-clients/plan.md#deliverables)
    owns app-neutral navigation and owner links; D4 owns selected/last-UI removal warnings and D8
    owns inventory and role-derived lifecycle consequences. Bootstrap migration/configuration and
    collector coupling stay with their existing feature owners. The
    [Core Extension Model](features/core-extension-model/feature.md) records the current boundary;
    its retired umbrella implementation plan stays retired.

54. **Build reusable capabilities for composable human and agent work (2026-10-25).**
    The owner wants a construction kit for autonomous systems of varying complexity, useful to
    one person and to teams with different responsibilities. People and configured agents can
    perform, delegate, review and accept work. An analyst, designer, developer or QA role is an
    application-level responsibility, separate from Core permissions and from a model connection.
    Humans may configure specialized agents and accept their results at any chosen stage.

    Prioritize investigating a shared skill pool and delivery, with reusable packages from
    standard sources, standing role instructions and optional skills selected for a project or
    application. Core's delivery capability and an app's agent/profile configuration are distinct
    building blocks. Reconcile role/project selection with the existing Shared Skills decisions;
    selecting instructions does not grant tool access or establish enforcement.

    Identify reusable contracts for authority, capability discovery and invocation, durable work,
    events, versioned inputs/results, human decisions and resource lifetimes. Core supplies the
    application-neutral mechanisms within its ownership; providers and ordinary apps own agent
    execution, roles, task meaning and orchestration. Explicit calls, events, hooks/webhooks and
    schedules remain options for initiating the same authorized work. No transport, workflow
    language, universal task store, organization chart or packaging into Harness versus a separate
    application is selected.

    Idea-to-plan-and-mockup review, implementation, functional/visual QA, sandbox acceptance and
    authorized PR/review/merge form one example composition. Iterations can reuse their test
    environment and data, and acceptance refers to the reviewed versions. Non-development work
    and simple direct use remain equally valid. Existing repository, resource, privacy and
    publication boundaries apply; merge is distinct from production deployment.

    The [Composable Human And Agent Work Draft](features/composable-agent-systems/plan.md) owns the
    initial capability/gap map, missing ownership decisions and proposed investigation order.
    This advances only that foundational investigation beyond decision 52's vision-only capture.
    Existing feature plans keep their deliverables and statuses, including ordinary-user access
    prerequisites. The owner authorizes documentation and Draft planning only, with no implementation
    or operational changes; the retired Core Extension Model implementation umbrella stays retired.

55. **Shared work records, deliberate workspace choices and explicit handoffs (2026-10-26).**
    Decision 62 supersedes the Core-owned task-store preference and separate agent-principal
    proposal below; it retains the common contract, optional resources and explicit handoffs.
    The owner prefers investigating a small shared task model in Core, with replaceable executors
    and app-owned orchestration. Other apps can create tasks, observe states and participants, and
    inspect child tasks and resource/result links through a common contract. A task-provider model
    remains an alternative to compare. Standardization and storage are separate choices; extra
    executor state need not become Core fields. No wire schema or implementation is approved.

    Persistent agent participants are distinct from profiles, model connections, sessions and runs.
    They can have stable system identities, explicit access and a responsible human. Agent hierarchies
    remain app-owned relationships between participants; task parentage is independent. A direct
    agent invocation need not create a participant account. Existing user/session restrictions remain.

    Shared task and decision state should be observable through authorized events. A decision can
    be addressed to the responsible human or a role/project-specific reviewer, presented in a common
    inbox and answered outside the original chat. Quick answers may resume a live run; longer waits
    retain the question and recoverable state while releasing stopped execution resources. A saved
    response can trigger durable continuation. Silence, decision expiry and process-wait time are
    different outcomes; permission decisions retain their own enforcement and revalidation.

    Reuse an existing workspace for related delegated work and prevent accidental duplicate allocation,
    while allowing explicit independent workspaces. The owner does not select one workspace per whole
    task tree: an unrelated bug discovered during feature work can have its own workspace and PR, with
    a decision about urgency or hotfix targeting if needed. Exact binding/inheritance rules remain open.
    Workspace sharing does not imply shared private conversations or safe unrestricted concurrent writes.

    Basic artifacts are needed for work handoff and reuse: descriptions, versions, provenance and
    access-controlled content/references for reports, scripts and prepared materials. A child can return
    a summary plus artifact references for another agent to consume. Session context, explicitly shared
    context, artifacts and skills remain distinct; no elaborate artifact tiers or automatic promotion
    are selected. Source identity/version survives a change of location into a workspace.

    Learned long-term memory stays outside this investigation. Keep recurring preferences and decisions
    as a later [idea](ideas.md#i1-memory-as-a-replaceable-provider), with no implementation or automatic
    policy learning. The [composable-work Draft](features/composable-agent-systems/plan.md) owns the
    integration questions, including minimal artifacts; existing feature owners keep their scope and
    status. These clarifications update the investigation under decision 54, not implementation approval.

56. **Separate capability Drafts and a first composition inside Harness (2026-10-26).**
    Decision 62 retires the agent-participant Draft and selects a manual/API task as the first
    journey, with profile-backed Harness execution and no document prerequisite.
    The owner requests independently refinable plans for the missing reusable blocks. Existing
    Shared Skills, Agent Providers and Notifications D6 retain their scope; new Drafts own
    the subsequently retired agent-participant proposal,
    shared task work (split by decision 64 into [Basic Tasks](features/basic-tasks/feature.md) and
    [Task Workspace Coordination](features/shared-tasks/plan.md)),
    [artifacts](features/shared-artifacts/plan.md) and
    [decisions](features/shared-decisions/plan.md). The
    [composable-work umbrella](features/composable-agent-systems/plan.md) retains priorities and
    integration boundaries rather than duplicating those deliverables.

    The initial organizational experience is proposed within
    [Harness](features/harness-work-orchestration/plan.md): app-owned profiles, optional agent
    hierarchy, task coordination and a coherent Tasks/Decisions/Artifacts UI. A separate app and
    its name remain open; cross-app widgets or a new UI composition framework are not prerequisites.
    Shared contracts remain independent of Harness routes, app identity and private storage.
    First prove one Documents task, one agent, an artifact, a human decision and continuation before
    expanding hierarchy. Core stays usable without this application and learned memory stays deferred.

    The owner also requests closing Bridge D11. Its entire unbuilt runner, scheduling/retry budget,
    notification and background-grant consumption scope transfers to
    [Durable Agent Jobs](features/durable-agent-jobs/plan.md), Draft. D11 is retired, not declared
    implemented. The Bridge rollout plan closes with no remaining owned deliverables; its dated
    validation and ownership transfers remain in the feature document. No implementation, Ready
    status or runtime/publication action is authorized by this documentation split.

57. **One skill pool, profile selections and full app packages (2026-10-26).**
    Decision 59 supersedes revision pinning/retention; decision 60 removes manual uploads.
    The owner selects one administrator-managed library per Hosty instance. Core stores package
    bytes, provenance and immutable revisions and provides APIs/prepared exports. Harness owns
    profiles, standing instructions and skill references, with its first management UI over Core.
    Resolve a conversation's effective set from its profile or assistant default and retain those
    revisions on resume, independently of model/provider credentials. This supersedes the earlier
    installation-wide selection assumption. No personal pools or per-package user owners are added.

    Git is the primary import/update source, with prepared uploads and app-supplied packages in the
    same catalog. Reuse Core's Git-check mechanisms to show package updates; administrators apply
    Git updates explicitly. App packages advance with their app version. Expose source kind and
    revision, preserve standard package contents, and resolve native-name collisions explicitly.
    Hosty package editing/forking is excluded; customization remains in instructions and profiles.

    Replace agent.skillFile through a coordinated producer/reader migration. Each app can supply
    several complete directories with SKILL.md, references, examples and supporting files; no
    permanent single-file compatibility mode is selected. Decision 58 selects the manifest and
    catalog shape; API and rollout details remain in the [Shared Skills](features/agent-skills/feature.md). Test both Harness native
    runtimes, different profile selections and one explicitly provisioned external local client.
    Supporting files must survive for pinned conversations under an explicit retention contract.
    Existing tool/app authority remains separate from package selection. Automatic Git updates,
    personal libraries and remote MCP Skills delivery remain later ideas; these answers settle
    scope but do not approve implementation or change the Draft status.

58. **Skill declarations and catalog identities (2026-10-26).**
    Decision 59 supersedes immutable Revision records/session bindings; decision 60 removes uploads.
    The owner accepts agent.skills as an array of stable app-local key and manifest-relative
    directory path entries. One package contains one root SKILL.md and supporting files; name and
    description come from the portable file rather than duplicate manifest fields. The declaration
    describes installed resources, not a running-app endpoint.

    Core keeps Source, Skill and immutable Revision records. Source kinds are git, app and upload;
    a stable skill ID is distinct from its native name, source revision and complete-package content
    hash. Profiles select skill IDs; new sessions resolve and retain skillId/revision pairs.
    Existing sessions keep those revisions. New app skills enter the catalog without automatic
    profile enrollment; conflicting native names in one selected set require an explicit choice.

    The shared API covers catalog lookup, package reads, import, update checks/apply and prepared
    execution sets. Harness keeps profiles/instructions. The
    [Shared Skills](features/agent-skills/feature.md#api-and-delivery)
    owns exact examples and remaining validation, API, storage/export and migration questions.
    This records accepted design only; status remains Draft and implementation is not authorized.

59. **Current skill contents, simple removal and native Core implementation (2026-10-26).**
    The owner removes the requirement to pin skills to conversations or retain old package copies.
    Core supplies current installed content. Native clients may discover updates during execution
    when they support it; otherwise they use their normal loading behavior. Hosty does not add a
    universal hot-reload or context-revocation mechanism. Source commit/app version may describe
    current installed content without a historical Revision store or a session lifetime policy.

    Removing a skill, including through removal of its supplying app, removes its availability
    and supplied files everywhere. Missing references are omitted, without blocking a new/resumed
    session or retaining deleted content. Only technical name collisions require validation;
    contradictory guidance in different skills is an operator configuration concern, not something
    Core detects or resolves. The source/skill identities and app directory declaration remain.

    In a subsequent confirmation on the same date, the owner selects discovery of repository skills,
    installation of chosen packages only, and manual per-skill updates plus Update all. Reuse one
    source checkout/download across selected packages in an operation; keep only each skill's current
    installed contents and source commit, with no archive for sessions. Download transport does not
    dictate update granularity. Update all does not install unselected skills. The
    [Shared Skills](features/agent-skills/feature.md) owns remaining integration details. Git checks
    do not apply updates automatically. App packages continue to follow their supplying app.

    The owner rejects adding a Node.js dependency for skills management. Implement the mechanism
    natively in Core/.NET with suitable existing Git infrastructure; the skills CLI is an external
    design reference only. This simplifies the Draft without authorizing product implementation.

60. **Skill acceptance, private Git and initial source scope (2026-10-26).**
    The owner accepts replacing repeated content-digest confirmation: administrator install/update
    supplies current content to selected consumers, and app skills advance with their app without
    another acceptance in each profile. Migrate both Harness and CLI/facade content gates while
    preserving explicit selections and independent repository/tool permissions.

    Private Git reuses explicitly selected existing administrator Source connections within
    supported providers/transports. No separate skill credential store is added. Upstream deletion
    is shown by a check and removes the skill only when the administrator applies that update;
    unavailable sources and failed downloads preserve installed content.

    Manual package upload is removed from the initial slice. Its only sources are Git and installed
    apps; no archive-upload UI/API or upload replacement flow is required. Earlier upload references
    in decisions 57-58 are superseded. The [Shared Skills](features/agent-skills/feature.md) now
    tracks implementation/acceptance under D1-D6. Runtime verification belongs to delivery rather
    than requiring finished code before Ready. This records scope, not implementation start or
    promotion from Draft.

61. **Separate agent sessions and explicit context handoffs (2026-10-27).**
    The owner abandons the Shared Assistant History And Provider Switching plan. Independent
    sessions already use a shared workspace, and upcoming orchestration coordinates separate
    agents. Planning, implementation and review therefore use separate conversations with their
    own profile, provider/account and history. Switching Codex and Claude inside one started
    conversation and round-trip native-context migration are no longer product requirements.
    This supersedes the switching direction in decision 10 and its old acceptance scenarios;
    existing model/reasoning selection within a connection is unchanged.

    [Shared Artifacts D2-D4](features/shared-artifacts/plan.md#deliverables) owns explicit handoffs:
    goals, constraints, decisions/rationale, bounded attributed summaries, versioned materials,
    unresolved questions and the next expected step. Workspace membership does not disclose
    private conversations, attachments or credentials. Selected evidence retains provenance,
    current access checks and visible gaps; recorded actions are not instructions to replay.

    Necessary reliability work remains tracked: former Shared History D1 transfers to
    [Action Summary D4](features/assistant-action-summary/plan.md#deliverables), with public
    invocation semantics in [Agent Providers D2](features/agent-provider-interface/plan.md#deliverables).
    Former D2-D4 session commands, same-provider continuation and bounded context transfer to
    [Durable Agent Jobs D7](features/durable-agent-jobs/plan.md#deliverables), also usable by ordinary
    chats without a scheduler. D4 cross-session materials belong to Shared Artifacts; D6 visibility
    belongs to [Harness Orchestration D7](features/harness-work-orchestration/plan.md#deliverables)
    and its material/client consumers. Keep private history private and revalidate access; no
    blanket whole-conversation sharing is implied. D5 is abandoned, not implemented.

    Delete the abandoned plan and reconcile living references and acceptance criteria. The
    [development-session umbrella](features/assistant-development-sessions/plan.md#retired-switching-plan-and-requirement-owners-2026-10-27)
    records the transfer map. Receiving work remains unchecked and Draft; this decision approves
    documentation changes, not implementation, publication or a runtime migration.

62. **Common task contracts, app providers and internal Harness profiles (2026-10-27).**
    Core defines the universal task structure and interoperable provider/executor contract.
    Applications supply task storage and execution; Core is not the initial task provider/store.
    A producer, task provider and execution app are separate roles that one app may combine.
    Harness is the first provider and executor; other compatible apps may replace either capability.
    This replaces decision 55's preferred Core task store without moving workflow policy into Core.

    A task describes work with a stable qualified ID, human-readable string number, Markdown and
    assignments, plus optional typed resource/input/result references. Applications and artifacts
    are resource kinds. Tasks do not depend on documents, repositories or workspaces; source work
    can bind a workspace and expose reverse task links using existing resource APIs. Core owns the
    common lifecycle meaning while providers may expose controlled status/phase details. Decision 63
    selects numbering, statuses and launch behavior, now owned by
    [Basic Tasks](features/basic-tasks/feature.md) after decision 64's split.

    Assign work to an existing human or an execution app with an optional opaque executor choice.
    Harness initially publishes choices backed by its profiles. Their names and configurations
    already serve as its named agents; keep the Profile concept and existing editor, with no extra
    agent record or Core principal. Profile instructions, model/connection settings and skills stay
    internal to Harness and are not shared with other applications. Other executors need no profile
    concept. An admitted session/run remains distinct from the profile used to configure it.

    Agents use what their application can do under existing user/app authority and MCP/tool policy.
    There are no new per-profile permissions, MCP partitions, workspace ACLs or enforced role fences.
    Reviewer/developer specialization is instructional. Existing denials and invocation preferences
    still apply; attaching a resource or assigning a task cannot grant access. Native/local execution
    may have broader OS capabilities than MCP; this decision adds no new isolation requirement or
    claim. Existing runtime modes, grants and private-session boundaries remain under their owners.

    Retire the separate Persistent Agent Participants plan without claiming its deliverables shipped.
    Its useful assignment/discovery/attribution requirements originally moved into Shared Tasks
    D1-D2 and Harness Orchestration D1 using existing identities and profile choices; decision 64
    transfers that work to [Basic Tasks D1-D4](features/basic-tasks/feature.md#requirement-transfer). The separate
    new-principal, per-agent access and cross-app identity implementation is abandoned. Future hierarchy remains app-owned orchestration over these choices.

    Start with manual/API creation, assignment, Ready, automatic Harness execution and an observable
    result. Human-assigned tasks remain manually performed. Reliable attempt acceptance/recovery is
    required, but document approval, a team hierarchy, general scheduling, parked decisions and public
    model-provider extraction are not prerequisites. Artifact and decision integration stays tracked
    after the basic journey, and Documents is an optional producer. The shipped Core skill library
    stays unchanged; a general skill-provider extension is a separate undecided direction.

    At this decision, the owning Drafts were Shared Tasks and Harness Work Orchestration; decision 64
    moves basic delivery into [Basic Tasks](features/basic-tasks/feature.md), retains
    [workspace coordination](features/shared-tasks/plan.md) and
    [Harness orchestration](features/harness-work-orchestration/plan.md), and preserves linked execution,
    event, artifact and decision owners. This records the selected architecture and documentation
    changes, not implementation approval, completed deliverables or runtime/publication changes.

63. **Provider task numbers, common statuses and direct execution (2026-10-27).**
    The owner accepts provider-selected display prefixes and the proposed task lifecycle/launch
    contract. A task provider returns an opaque complete number such as MS-42 or HRN-17, with its
    own counter independent of executor/profile. Existing numbers remain unchanged, are never reused
    and survive reassignment. Creation retries recover the original number. Core uses provider plus
    UUID as identity; no global prefix registry is required. Ambiguous display numbers include the
    provider's name. Prefixes and task numbers describe the supplying provider, not the executor.

    Common statuses are Draft, Ready, InProgress, Blocked, Done and Cancelled. Blocked carries a reason
    and explanation; internal display phases do not replace these semantics. Execution failures are
    retained on attempts. requiresReview defaults to false; explicit successful task completion closes
    work or waits in Blocked/needs_review for acceptance. A completed model turn is not a completed
    task. Human-assigned Ready tasks are started manually and do not create agent runs.

    Persist the Ready transition, executionId, immutable input snapshot and pending dispatch together.
    The executor exposes versioned PUT /executions/{executionId}, GET of that execution and idempotent
    POST cancellation. Accept durably before launch; identical requests recover the same receipt and
    changed input under the same ID conflicts. HTTP uncertainty recovers the same execution; explicit
    retry after a failed/stopped attempt uses a new ID. One task has at most one active or uncertain
    attempt. Cancellation fences late dispatch and does not claim completion before execution stops.

    Harness binds its current profile at first acceptance and retains that snapshot through replay,
    edit and deletion. A missing pre-acceptance option is an explicit failure, never a default switch.
    Existing app/user/MCP authority and private-session ownership apply. The public DTO carries task
    data and opaque executor references, not profile configuration or credentials.

    Direct task dispatch needs persisted request/receipt recovery over the existing Worker, with
    HTTP reads and SSE UI refresh plus state reload. Completing Notifications D6, the general
    Durable Agent Jobs scheduler or Shared Decisions is not a prerequisite. Their broader event,
    scheduling/retry and overnight-wait work remains tracked with those owners. Basic task review
    stays in the task lifecycle; richer hierarchy and human routing remain Harness orchestration.

    At this decision the common contract/dispatch belonged to Shared Tasks and the execution/UI adapter
    to Harness Orchestration. Decision 64 now combines that basic delivery in
    [Basic Tasks](features/basic-tasks/feature.md), with explicit Ready approval and preserved deferred
    source-allocation and richer-orchestration owners. This earlier decision recorded design/readiness
    only and did not itself authorize implementation or completion.

64. **Approve Basic Tasks as an independent Ready feature (2026-10-27).**
    The owner explicitly requests a separate basic-task plan, updated links and Ready status.
    [Basic Tasks And Execution](features/basic-tasks/feature.md) owns the complete first feature:
    Core/SDK provider contracts, app-owned task storage, Harness profile execution, manual/API creation,
    assignment, Ready dispatch, observable results and optional simple review/rework. It retains the
    accepted provider-prefix numbering, six statuses and recoverable three-operation launch contract.
    Optional existing resource references and an explicitly selected existing workspace are included;
    no document, repository, artifact service, organization hierarchy or scheduler is required.

    Automatic workspace allocation/reuse, inherited bindings and reverse task observation remain in
    [Task Workspace Coordination](features/shared-tasks/plan.md), using the stable shared-tasks folder
    and its surviving D3/D5 IDs. [Harness Work Orchestration](features/harness-work-orchestration/plan.md)
    retains D3-D7's artifact/decision integration, parked waits, task decomposition, hierarchy and
    cross-session material access. [Shared Artifacts](features/shared-artifacts/plan.md),
    [Shared Decisions](features/shared-decisions/plan.md) and [Durable Agent Jobs](features/durable-agent-jobs/plan.md)
    keep their unfinished content, addressed-response, scheduling and continuation contracts.

    Transfer Shared Tasks D1-D2/D4 and the basic parts of D3/D5, plus Harness Orchestration D1-D2
    and the base-UI/acceptance parts of D3/D5/D6, into Basic Tasks D1-D6. The owning plans record the
    exact map. Retire transferred IDs without reusing them or marking them implemented. Existing
    session privacy is preserved by the basic adapter; broader cross-session integration remains D7.

    Only Basic Tasks becomes Ready. Deferred plans stay Draft and are outside this approved delivery;
    no remaining requirements are hidden, deleted or counted as complete. Basic Tasks can be delivered
    as one feature/PR independently of full orchestration, in accordance with repository versioning
    and verification rules. The current documentation update does not claim implementation started,
    runtime acceptance or publication.

65. **Own the Ollama engine and separate agent provider applications (2026-10-28).**
    The owner selects a Hosty-owned agent engine that calls Ollama directly, rather than using Codex
    to execute Ollama-backed conversations. The target has independently installed Codex, Ollama and
    Claude Code provider applications. One provider can expose multiple models; a model is not an app.
    Harness is a consumer and conversation UI. Core supplies generic discovery, identity, grants and
    authorized references; agent messages/events flow directly between consumer and provider.

    The initial Ollama adapter uses the already installed host Ollama server through a configurable
    URL with a runtime-appropriate local default. It does not install/start the inference server,
    download models or place weights in Worker storage. Provider-app packaging and inference-server
    packaging are separate decisions. The existing app-cache contract is available for reproducible
    weights if a managed server is separately designed; no host model-store migration is implied.

    Integrate the adapter into the existing Worker with explicit state and tool dependencies.
    Do not require a new engine daemon or a switch from Docker to native execution in this feature.
    This is preparation for extraction, not evidence that current agent processes survive a Harness restart. Shared implementation libraries are allowed; a mandatory
    central agent runtime in Core or Harness would defeat the lifecycle boundary.

    [Ollama Agent Adapter And Connections](features/ai-gateway-providers/feature.md) owns direct inference,
    coding/MCP tools, context and durable execution in the initial integration.
    [Agent And Model Provider Interface](features/agent-provider-interface/plan.md) owns the public
    contract, separate applications, migration and reconnect acceptance. This decision fixes the
    direction, superseding the combined-provider/Codex-backed suggestions. The owner subsequently
    approved the initial external-server adapter for implementation on the same date. Separate
    application extraction remains Draft; no live runtime switch is authorized.

## Personal And Shared Environments (owner exploration, 2026-10-23)

### Composition And Extension Boundaries

Core supplies reusable hosting, identity, authorization and resource-lifecycle mechanisms. Apps
supply capabilities through discoverable interfaces and can expose MCP tools and UI contributions.
A team may combine several small apps or build one larger app with its own chosen workflow. Neither
approach requires the platform to prescribe an analysis-to-development-to-QA pipeline. The same
foundation should support ordinary personal applications and selectively shared household material.

Review boundaries against concrete uses before designing additional contracts. Existing provider
discovery, permissions, SDK composition and independent sandbox APIs are starting points. Questions
include how much workspace coordination must remain with Core's resource owner, which higher-level
workspace services could become providers, and whether Harness should keep its current combined UI
or expose more independently usable components. The retired Workspaces application is a useful
comparison, not a decision to restore it. No universal plugin framework or wholesale rewrite is
selected. Docker remains a foundation without this exploration removing supported Local/native
runtimes.

Progressive UI composition matters as much as API modularity. A small installation should remain
simple; additional panels, discussions, overlays and team tools appear when installed and useful.
The host UI and provider choices can vary. An app may offer a highly specialized team interface
without making that interface or its workflow a requirement for other users. Some users may never
need to see or use a workspace.

### Independent Workspaces, Sessions And Materials

The desired workspace is an optional shared work context with its own identity, name and possible
description, app associations and materials. Several users and concurrent agent sessions may
participate, with separate session names, purposes and local conversational context. Creation from
an agent session can remain a convenient default: create the workspace and attach that session.
Creating another session in the same workspace should not require transferring a single conversation
between agents. A workspace may also exist without a session, and a session without a workspace.

The [Multiple Sessions In A Shared Workspace feature](features/workspace-sessions/feature.md) implements
the approved 2026-10-25 scope: explicit administrator sharing, concurrent private sessions and
independent workspace lifetimes. Broader roles, shared materials and knowledge lifetimes remain
separate design questions; this direction grants no implementation authority for them.

Treat their association as a separate relationship. A session may detach or survive deletion of a
workspace; removing one session need not remove shared work. Workspace resources should not be kept
merely to preserve conversation history or knowledge. Preserve unfinished source and actual resource
consumers under the existing cleanup rules until a replacement lifecycle is explicitly designed.
Historical references, permissions after detachment and retention of shared attachments need their
own semantics. This direction does not define a mandatory archive or authorize current cleanup.

Sharing concerns both people and their agents. Family or team membership must not imply access to
every member's private information or provider credentials. Resource lifetimes, distinguishable
authority and external session history are explored in [ideas I12](ideas.md#i12-workspace-session-and-material-lifetimes).

### Still-Open Topics

The 2026-10-23 exploration also covered topics that remain too unformed for a direction beyond
decision 52. They live in [ideas](ideas.md), where each topic also records prior art and known
pitfalls:

- Knowledge and search providers: [I1](ideas.md#i1-memory-as-a-replaceable-provider) and
  [I2](ideas.md#i2-search-across-knowledge-providers).
- Retention, transcription and summaries: [I13](ideas.md#i13-retention-transcription-and-summaries).
- Collaboration and QA as optional compositions: [I14](ideas.md#i14-collaboration-and-qa-as-optional-compositions).
  Decision 54 selects the underlying capability/gap investigation in the
  [composable-work Draft](features/composable-agent-systems/plan.md); specific application forms
  remain exploratory.
- Bringing existing applications into Hosty: [I15](ideas.md#i15-bringing-existing-applications-into-hosty).
- A portable environment and a dedicated Hosty OS: [I16](ideas.md#i16-a-portable-environment-and-a-dedicated-hosty-os).

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
5. **Which boundaries enable useful independent compositions?** Decision 52 reopens the placement
   of higher-level workspace functions, knowledge/search, QA and collaboration. Which mechanisms
   must stay with Core's resource owner, and which can be supplied by ordinary apps? Evaluate
   small concrete consumers before selecting extraction or a universal interface.
6. **What do knowledge producers and consumers need to exchange?** Resolve useful content/reference,
   provenance, version, sharing and deletion semantics across providers with different storage,
   without making a project or workspace mandatory. How are private, household and team scopes
   represented, and how are changed permissions reflected in summaries and search copies?
   Explored in [ideas I1–I2](ideas.md#i1-memory-as-a-replaceable-provider).
7. **Which retention and retrieval choices fit different environments?** Full transcripts,
   archives, summaries and selected excerpts have different costs and fidelity. How can users
   choose storage and processing policies, see stale or missing evidence, and bound agent context
   without retaining obsolete workspace resources? Explored in
   [ideas I13](ideas.md#i13-retention-transcription-and-summaries).
8. **How is shared work attributed and reviewed?** Consider several users/sessions, uncommitted
   changes, separate publication streams and session detachment. What evidence is reliable with
   simultaneous writers, and what remains useful after resources or conversations are deleted?
   Explored in [ideas I12 and I14](ideas.md#i14-collaboration-and-qa-as-optional-compositions).
9. **How small can onboarding and UI composition stay?** Explore existing-repository adoption and
   optional tools/panels without hiding lifecycle consequences or requiring a development-oriented
   setup for personal use. Which conventions are sufficient before introducing another contract?
   Explored in [ideas I15](ideas.md#i15-bringing-existing-applications-into-hosty).

## Spanned Features

[composable-agent-systems](features/composable-agent-systems/plan.md) ·
[basic-tasks](features/basic-tasks/feature.md) ·
[shared-tasks](features/shared-tasks/plan.md) ·
[shared-artifacts](features/shared-artifacts/plan.md) ·
[shared-decisions](features/shared-decisions/plan.md) ·
[durable-agent-jobs](features/durable-agent-jobs/plan.md) ·
[harness-work-orchestration](features/harness-work-orchestration/plan.md) ·
[harness-development-ui](features/harness-development-ui/feature.md) ·
[harness-session-retention](features/harness-session-retention/feature.md) ·
[workspaces-app](features/workspaces-app/feature.md) ·
[default-applications](features/default-applications/plan.md) ·
[sdk-panel-system](features/sdk-panel-system/feature.md) ·
[sdk-ui-composition](features/sdk-ui-composition/feature.md) ·
[continuous-app-access](features/continuous-app-access/feature.md) ·
[replaceable-ui-clients](features/replaceable-ui-clients/plan.md) ·
[plan-provider-interface](features/plan-provider-interface/plan.md) ·
[hosty-harness-swift](features/hosty-harness-swift/plan.md) ·
[assistant-development-sessions](features/assistant-development-sessions/plan.md) ·
[app-authoring](features/app-authoring/plan.md) ·
[core-extension-model](features/core-extension-model/feature.md) ·
[assistant-provider-permissions](features/assistant-provider-permissions/feature.md) ·
[agent-mcp-directory](features/agent-mcp-directory/feature.md) ·
[ai-agent-bridge](features/ai-agent-bridge/feature.md) ·
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

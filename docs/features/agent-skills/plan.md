---
status: In Progress
created: 2026-10-15
updated: 2026-10-26
summary: Implement a shared Core skill library from Git and app packages, manual individual and bulk updates, current-content native delivery and coordinated app-contract migration.
components: [apps/core, apps/cli, apps/harness, apps/shell, apps/documents, apps/demo-app, packages/app-sdk, packages/app-sdk-dotnet]
---

# Shared Agent Skills And Configurable Workflows

## Goal And Status

Implement one administrator-managed Core skill library, selected by assistants/profiles and usable
without a particular orchestration application. Initial sources are Git repositories and installed
app packages. Git installation is selective; updates are manual, per skill or Update all. Consumers
receive current installed files, without session revision pins or historical package retention.

The owner settled product choices on 2026-10-26, including reuse of Source connections for private
Git, removal on applied upstream deletion, and replacement of repeated content-digest acceptance.
The latest decision removes manual package upload. D1-D6 below now describe implementation outcomes
and acceptance within their existing responsibility areas. No product question remains open.
The owner approved Ready and end-to-end implementation, verification, PR, review and merge on
2026-10-26. Implementation progress is tracked in D1-D6; other linked Draft plans remain unapproved.
Historical research below retains its original limits. Complete runtime integration is delivery
acceptance, not a prerequisite to have finished code before approving the plan.

The owner requested standards and client-integration research on 2026-10-16, without implementation.
The owner then requested verification against Harness's pinned Codex and Claude versions. The
dated research and isolated native-client checks below contribute evidence to D2 and D4; they do
not establish an end-to-end Hosty skill delivery flow or authorize implementation.
On 2026-10-18 the owner requested the same directory experiment in Docker with a real bind mount;
the results below extend the native-client evidence without changing the Draft's scope.
These are historical checks of Codex `0.160.0` and Claude Agent SDK `0.3.288`. At this
reconciliation, Harness pins Codex `0.162.1` and Claude Agent SDK `0.3.296`; verification of
those current pins remains outstanding in D4. The historical results do not cover that upgrade.

The goal is to let users shape how their agents work through reusable skills, while Hosty supplies
the tools those workflows need. This should serve Hosty Harness, other installed assistants and
authorized external clients such as Codex. An assistant running inside Hosty is one consumer of
the platform, rather than the only place where the workflow can exist.

Here, **skill** is shorthand for reusable instructions, potentially packaged with supporting files.
An instruction-only skill should remain possible; a fuller skill might contain examples, reference
documents, templates, scripts and nested directories. Multi-file packaging and layered selection
are separate questions: supporting nested files does not decide an inheritance model for settings.

## Settings Coordination (2026-10-20)

The owner clarified that choosing whether Harness uses an app instruction file
belongs to that Harness, without an additional Core approval. The
[settings experience](../settings-experience/feature.md) implements this change for the
existing single-file contract, including local content-digest review, authorized
reads and migration from the shared approval gate. It also separates Core-enforced
MCP application/tool access from Harness-owned per-call Ask/Run preferences.

Harness currently uses local digest acceptance; CLI/facade retain the global digest gate.
Decision 60 replaces these content gates for the new contract; this is a planned migration, not
current behavior. This shared-skills plan owns full packages and delivery,
and should reuse that assistant settings entry rather than create a second editor.
It does not duplicate the shipped settings work or authorize implementation.

## Owner Decisions (2026-10-26)

The owner answered the ten scope questions and selected the following direction; see
[vision decisions 57-60](../../vision.md). This list incorporates the simplification in decision 59
and source/update choices in decision 60. Product agreement does not mark implementation deliverables
complete or itself change the plan status.

1. **One shared pool per Hosty instance.** Core owns current package bytes,
   provenance, catalog APIs and prepared exports. Administrators manage that one pool for all
   consumers. There are no personal pools or per-package user owners. Who imported a package is
   audit provenance, not a new ownership/visibility model. Existing caller and app permissions
   still govern reads and delivery; a common catalog does not grant an app's tools or private data.
2. **Profiles select current installed skills.** Harness owns profiles, role instructions and
   stable skill references, independently of model and provider credential connection. Use an
   assistant default until a profile is selected. Deliver current installed contents without
   pinning a conversation to historical files. Native clients determine when they reload changes;
   Hosty does not add a hot-reload requirement. Other clients consume the same Core APIs.
3. **Git and app packages only.** Discover packages in a repository/subdirectory and install only
   those the administrator selects, recording their source commit. Apps can contribute complete
   packages. Show source kind, repository or supplying app and installed version in the catalog.
   Manual package/archive upload, upload replacement, a marketplace and in-product authoring are
   outside the initial slice.
4. **Stable identity without changing portable content.** Keep Hosty IDs, source metadata and
   revisions outside the standard SKILL.md package. Native name, display name and Hosty ID are
   distinct. Detect technical native-name collisions without silently renaming, merging or
   overwriting unrelated packages. Hosty does not analyze contradictory instructions; selecting
   mutually inconsistent guidance is an operator configuration concern.
5. **Instructions and skills are different inputs.** Edit standing instructions and profiles in
   Harness. Make optional packages available for native activation; a profile/task can explicitly
   request a selected skill when necessary. Do not inject every package into every prompt or
   mistake skill selection for enforcement of workflow or permissions.
6. **Check Git, apply manually.** Reuse Core's existing Git ref/update-check mechanisms where they
   fit. Show available changes and let an administrator update one installed skill or choose
   Update all. Detection never advances the installed package revision on its own. App-supplied
   skills instead advance with the applied app version, without an independent Git update action.
   Replace the current supplied files on update. Removing a skill, including through app removal,
   stops its delivery everywhere; stale selections do not block a new or resumed conversation.
   Do not retain old packages for sessions. Automatic Git skill updates remain a later idea.
7. **No package editor or fork flow.** Do not edit, override, merge or fork skill contents in Hosty
   initially. Customization is limited to instructions/profiles. Administrators manage Git
   installations and app-supplied packages; they do not upload or edit package bytes in Hosty.
8. **Replace the app single-file contract.** Migrate existing app producers and readers to a new
   declaration supporting multiple complete skill directories per app, including examples,
   scripts and references. Do not keep agent.skillFile as a permanent compatibility mode or merely
   mark it deprecated. The selected agent.skills shape is recorded below; validation details and the coordinated release sequence still need design.
9. **Administrative management, no personal ownership.** Additional administrators can install
   packages and configure the agents they manage. Non-admin users consume the configured capabilities
   through existing rights; per-user package management/private pools are outside this scope.
10. **Verify actual consumers.** Cover both Harness native runtimes and one explicitly provisioned
    external local client. Test differing profile selections, full-package reads/activation,
    updates, disabling and resumed conversations. Remote MCP Skills delivery and automatic script
    dependency installation are deferred, not prerequisites.

The owner also excludes adding Node.js or the skills CLI as a dependency of this feature. Core owns
the mechanism in .NET and reuses suitable Git infrastructure. External installers are research
references only; no CLI installation, invocation or new runtime dependency is selected.

The owner also accepted these operational rules on 2026-10-26:

- Administrator install/update supplies current content to selected consumers. Replace repeated
  content-digest acceptance in Harness and CLI/facade. App updates advance selected app skills
  without another per-profile confirmation. New skills are not automatically selected; source
  grants and tool/script permissions remain separate.
- Public Git needs no connection. Private Git uses an explicitly selected existing administrator
  Source connection, within supported providers/transports. No separate skill token store or
  credential form is added.
- A check shows upstream deletion without changing the pool. Applying that update removes the
  skill. Access/network errors preserve installed contents and are not evidence of deletion.

## Composable Work Coordination (2026-10-26)

The [composable-work umbrella](../composable-agent-systems/plan.md) retains skills as the first
priority. This plan owns package formats, import/update, delivery, effective-set resolution and
the app-contract migration. [Harness Work Orchestration D1](../harness-work-orchestration/plan.md#deliverables)
owns profiles and role/project configuration; [Agent Participants](../agent-participants/plan.md)
owns persistent actor identity. Neither must be implemented in full before the library can serve
an assistant default. A model connection or responsible human is not a package owner.

Core exposes the shared API; the first management and selection UI is in Harness. Core prepares
exports and Harness attaches them to native execution. The existing settings entry is the starting
point, not a second Core approval of each Harness selection. Updates replace complete packages;
tool grants and script execution remain separate. D3-D4 implement and verify separate selection
exports and concurrent native delivery before claiming per-profile runtime support.

## Current Baseline

The starting point is partial support, rather than an absence of instructions:

| Area | Current behavior or existing plan |
| --- | --- |
| Harness instructions | A built-in host prompt and a configurable operator system prompt are composed with app instructions when starting the native agent. Harness settings expose the operator prompt; there is no shared user-managed skill-package library described by that feature. See [Harness](../ai-gateway/feature.md). |
| App instructions | [App-provided skills](../app-provided-skills/feature.md) use one `agent.skillFile` Markdown file per app. Delivered text is attributed, approved by digest and capped at 8,000 characters per app. Supporting directories are not delivered as a general skill package. |
| Access and review | The [Agent MCP Directory](../agent-mcp-directory/feature.md) already assigns MCP targets to individual assistants. Harness accepts app-file digests locally; CLI/facade retain shared approvals. This is not a general skill-package selection library. Tools and instruction approval are separate decisions. |
| Workspaces | [Session workspaces](../assistant-session-workspaces/feature.md) and [external development workspaces](../external-development-workspaces/feature.md) provide registered source worktrees and observation. Local external agents can prepare them through separately authorized direct Core MCP. |
| Sandboxes | [Sandbox instances and child Core environments](../app-sandbox-runtimes/feature.md) are shipped capabilities. Their API is independent of a workspace or Harness session; the remaining plan tracks broader acceptance. |
| Plans | [Hosty Plans](../plan-tracking/feature.md) displays repository and workspace documents. The separate [plan-provider Draft](../plan-provider-interface/plan.md) explores other plan sources, optional associations and possible MCP tools. |

MCP tools describe available operations. Skills can explain when and how to combine those operations,
the conventions of an app and the user's preferred way of working. Tool availability alone should
not be treated as proof that a client discovers or follows a complete development workflow.

## Owner Direction (2026-10-16)

This dated decision selected native filesystem packages for environments Hosty controls.
The 2026-10-26 decisions above supersede its installation-wide selection and unresolved library
ownership, while retaining filesystem delivery, fresh-conversation behavior and coexistence with
native sources. It was not implementation approval.

- **Complete packages in ordinary directories.** Preserve SKILL.md and its supporting directory
  tree. Core prepares a directory containing the skills selected for an assistant. Native clients
  discover them using their existing filesystem mechanisms; internal delivery does not depend on
  the MCP Skills extension.
- **One Hosty selection per assistant.** An assistant supporting both Claude and Codex receives
  the same selected Hosty set through their respective discovery locations. Per-model selections
  are not an initial requirement. The exact assistant identity and user/administrator ownership
  still need definition; provider credential profiles are a delivery detail, not a new selection
  scope by default.
- **Stable export root.** For a containerized assistant, mount a persistent parent directory and
  add/remove package directories inside it. The same source may serve multiple native discovery
  locations without duplicating package contents. Prefer read-only access from the consumer while
  Core manages the source. For local execution, use equivalent native directories or directory
  links. The [shared Docker worker](../assistant-shared-docker-runtime/feature.md) already supplies
  container execution; selected skill exports are not integrated into that launcher.
- **Fresh-session semantics.** The required behavior is that a newly created agent conversation
  receives the current Hosty selection. After disabling a package, Hosty no longer supplies that
  package to such a session. Already loaded instructions may remain in an existing conversation;
  restarting a worker or resuming old history does not count as a fresh conversation. Live reload
  may improve the experience, but immediate revocation inside an active conversation is not a
  requirement.
- **Other skill sources remain valid.** Built-in, user and repository skills may coexist with
  Hosty's set. This is not an exclusive allowlist over everything an agent can discover. Recommend
  avoiding duplicate copies of skills already delivered by an app, without prohibiting repository
  skills or deleting them. A separately available copy can still be discovered after its Hosty
  copy is disabled, so the guarantee concerns Hosty delivery rather than all possible agent use.

The owner also authorized a small isolated experiment on the unresolved path issue: whether
native discovery works with the per-connection CODEX_HOME and CLAUDE_CONFIG_DIR used by Harness.
Its results are recorded below. Storage, import/update UX, package review, concurrent updates and
external-client provisioning remain part of D2-D4. No product implementation is requested.

## Confirmed Bind-Mount Direction (2026-10-18)

After reviewing the Docker experiment, the owner selected **bind mounts as the primary delivery
mechanism for containerized assistants whose environment Hosty controls**. Mount a stable
per-assistant parent directory read-only and publish selected complete packages inside it.
Connect the native discovery paths to that mount, including each managed CLAUDE_CONFIG_DIR.
Core manages the export. Core library ownership and profile/session selection are settled by the
2026-10-26 decisions; the delivery section below supplies the implementation direction for exports.
Historical package retention is excluded.

The following list records the 2026-10-18 baseline. Installation-wide selection is superseded above;
bind mounts, fresh-conversation semantics and native-source coexistence remain selected:

- One Hosty-selected set per assistant, shared by its Claude and Codex runtimes, rather than a
  separate selection per model or provider credential profile.
- Selection changes are required to affect fresh conversations. Immediate removal from existing
  context and live reload are optional; resuming history does not create a fresh conversation.
- Native repository, user and built-in skills may coexist. Hosty's selection controls its own
  delivery, with duplicate-source guidance rather than a global native allowlist.
- Internal delivery does not require MCP Skills. External clients still need their own verified
  provisioning path; a Core MCP connection alone does not mount files into their environment.

The experiments answer whether these pinned native clients can discover the shared directory,
including host-side replacement through a real Docker bind mount. They do not implement runtime
provisioning. The [shared Docker runtime](../assistant-shared-docker-runtime/feature.md) owns the
shipped worker, while [Assistant Runtime Containment](../assistant-runtime-containment/plan.md) owns stricter isolation; this feature supplies the selected package export and its delivery
contract rather than introducing another runner. The plan remains Draft.

## Selected Initial Scope

### Shared Pool, Profiles And Sources

Core stores one administrator-managed pool. Git and app packages use the same catalog and provenance
model. Manual package upload is excluded from the initial UI and API. No personal owner/visibility tiers,
package editor or fork workflow are included. A shared package may be unrelated to any installed app;
an app can contribute several packages. Read permissions and actual tool access remain explicit.

Harness stores profiles and selected package references, with an assistant default for consumers
without profiles. Selected skills resolve to current installed content, including when resuming.
Updating or removing a package changes its supplied files; the native client controls rediscovery
and may already have loaded instructions. Hosty neither preserves old packages for sessions nor
promises to erase loaded context. Standing instructions remain editable separately. Selecting a
skill makes it available; actual activation and observed behavior require separate evidence.

### Selected Package And Catalog Contract (2026-10-26)

The owner accepted the declaration and stable identities in [vision decision 58](../../vision.md).
Decision 59 supersedes immutable revision records/session snapshots; decision 60 removes uploads
and settles update acceptance/private sources. The model below includes those changes; it is not
an implemented API.

#### App Declaration And Package Contents

Keep the existing agent block and replace skillFile with skills:

```json
{
  "agent": {
    "skills": [
      { "key": "planning", "path": "skills/project-planning" },
      { "key": "review", "path": "skills/plan-review" }
    ]
  }
}
```

The key is stable and unique within the supplying app. Moving its directory does not by itself
change the skill's logical identity or profile references. The path names a complete directory
relative to the manifest. Name and description come from SKILL.md, not duplicate manifest fields.
An absent skills declaration contributes no packages. These are installed resources under agent,
not a new endpoint in interfaces; reading their stored content does not require the app to run.

One package is one directory with one root SKILL.md and its supporting files. An app or Git source
may supply multiple independently selectable packages:

```text
skills/
  project-planning/
    SKILL.md
    references/documentation-rules.md
    assets/plan-template.md
  plan-review/
    SKILL.md
    scripts/validate-plan.py
```

Use the [Agent Skills format](https://agentskills.io/specification), including name and description
in YAML frontmatter. Keep Hosty source, identity and revision metadata outside the portable package.
Directory/native-name validation follows the supported format; exact limits and path diagnostics
remain part of D2. The declaration above is the selected target, not a claim that current manifests
or clients already accept it.

#### Core Catalog Records

| Record | Responsibility |
| --- | --- |
| Source | Kind git or app; repository/ref with an optional authorized Source connection, or supplying installed-app reference. One source can supply several skills. |
| Skill | Stable Hosty ID, source reference, source-local package key/path, current complete contents and parsed metadata. Its native/display identity is distinct from the Hosty ID. |

Keep the currently installed Git commit or app version as provenance and update information.
A current content hash may support change detection or validation; it is not a separately retained
Revision entity or a session pin. Do not maintain a history of package copies for active/resumable
sessions. Temporary update staging is an implementation detail, not a historical version library.

Only technical name collisions need validation. Reject introducing a second installed package
with the same native name into the shared pool, with a clear source diagnostic and no overwrite.
Validate before publishing the package/app change. This implementation rule replaces the earlier
candidate of allowing duplicate names until selection. Hosty does not check semantic contradictions between
different skills or infer which instructions should win. Native sources outside Hosty's pool retain
their own discovery/precedence behavior.

#### Profile References And Current Delivery

A Harness profile references stable skill IDs, for example:

```json
{ "skills": ["skill_123", "skill_456"] }
```

Resolve those references to currently installed packages. Do not record skillId/revision pairs as
execution dependencies, retain their old bytes or restore historical packages on resume. A native
client that supports rediscovery can pick up replaced files while running; otherwise its normal
next load uses them. No additional live-reload mechanism is required by this scope.

Removing a package removes its supplied files and availability in every Hosty selection/export.
Discard missing IDs during selection resolution; stale profile references do not block session
creation or resume and do not substitute another package. The same applies when the supplying app
is removed. Already loaded instructions remain a native session-context concern.

New app packages enter the catalog without being automatically selected into existing profiles.
Explicitly requesting a skill for a task is an invocation instruction, not a package permission.

#### Shared API And Catalog Presentation

Core provides catalog listing/lookup, authorized package reads, selective Git import, source update checks,
manual update application, removal and preparation of currently selected packages for execution.
Harness owns profiles and instructions and consumes these operations. Use existing Core route,
DTO and pagination conventions, administrator writes and authorized reads. No upload or arbitrary
archive-replacement operation is included.

The catalog shows name, description, source, installed source commit/app version and update
availability, with filtering by supplying app or Git source. Git updates are manually applied;
app packages follow app install/update/removal. Adding content does not automatically select new
skills. Selected consumers receive current content without repeated digest acceptance; selection
does not grant tools, repository credentials or script-execution authority.

### Git And Application Updates

Installation selection, source download and update granularity are separate choices. Discover
package directories in a repository or supplied subdirectory, then let the administrator select
which packages to install. Only selected complete directories enter the shared skill pool; finding
more skills in the repository does not automatically install or enable them.

The owner confirmed manual per-skill updates plus Update all on 2026-10-26. Store source URL/ref,
package path and the installed commit for each package. Reuse one source checkout/download across
selected packages in an operation instead of cloning once per skill. Updating one package replaces
only its current installed copy; other packages keep their currently installed contents. No
archive of replaced versions is required. Update all groups installed packages by source and
reuses each source download; it does not install newly discovered skills. Updating a source does
not force every installed skill from that source to advance when only one was selected.

For the first generic Git transport, a shallow checkout is a simple baseline. It avoids full Git
history but can still download unselected repository contents. Copy only selected packages into
the library and release temporary source material afterwards. Do not promise folder-only network
downloads or keep one full clone per installed skill. Partial fetching is an optimization to assess,
not a prerequisite for selection or independent updates.

A source commit change is enough for a source-level update indication; do not claim every package
changed solely from that signal. Per-directory comparison can refine it if included in the selected
UI. Detection does not apply updates. Failed source checks leave installed files usable. New upstream
skills are not auto-installed. Show a removed selected directory in the update preview; remove
its package only on explicit apply, without historical retention. Failed fetches/reads are errors,
not evidence of upstream deletion.

Core's existing [AppSourceService](../../../apps/core/src/Haas.Hosty.Core/AppSourceService.cs)
resolves remote refs without advancing installed source, and
[AppUpdateSweep](../../../apps/core/src/Haas.Hosty.Core/AppUpdateSweep.cs) coordinates checks.
Reuse suitable .NET/Git mechanisms without registering skill repositories as runtime apps or adding
Node.js/skills CLI as a dependency. These are existing building blocks, not an implemented skill updater.

Private Git reuses [Source connections](../user-profile-connections/feature.md) and the
[source-provider boundary](../source-providers/feature.md), with explicit administrator selection.
Persist repository-scoped connection references, never tokens in skill metadata. Adapt repository
grants to skill sources without registering a fictitious app or borrowing an unrelated app grant.
Recheck supported providers and access for remote operations. Revocation blocks new fetches but
does not erase installed package files; readers of the common pool receive no repository credentials.

Use the repository default branch unless an explicit ref is supplied, through the existing resolver.
Reuse update-check configuration where suitable and provide manual refresh. Stage and validate a
complete package before replacing it. A failed update preserves its current contents; Update all
reports per-package outcomes without rolling back unrelated successes.

App packages follow the supplying app's applied version. Update replaces their current content;
app removal or removal from its declaration removes those skills from the pool and exports.
Rollback follows the actual applied app package contents, not a separate retained skill history.
Neither Git nor app updates pin sessions; native-client loading determines when new files take effect.

#### Installer Reference (2026-10-26)

The [Vercel skills CLI README](https://github.com/vercel-labs/skills#install-a-skill) documents
interactive skill selection and an explicit --skill option. Its command list supports updating
named skills or the installed collection. The inspected
[Git transport](https://github.com/vercel-labs/skills/blob/main/src/git.ts) creates a temporary
shallow clone with depth 1; [discovery](https://github.com/vercel-labs/skills/blob/main/src/skills.ts)
finds SKILL.md packages in that checkout. Its
[update code](https://github.com/vercel-labs/skills/blob/main/src/update.ts) filters requested skill
names. This demonstrates selective installation/update without requiring a separate repository per
skill. It does not establish folder-only downloads. These are external implementation references,
not a Hosty dependency or evidence that Hosty's proposed flow is implemented.

### App Contract Replacement And Migration

The selected target replaces agent.skillFile with the agent.skills array of key/path directory
entries above. Implement complete-package validation, source attribution, installed/reinstalled
bindings, asset inclusion, API transport and coordinated releases. Do not introduce a permanent legacy branch or deliver the same guidance both
as old prompt text and a new package.

The repository inventory on 2026-10-26 finds current declarations in
[Plans](../../../apps/documents/manifest.json) and [Demo App](../../../apps/demo-app/manifest.json).
The migration must cover them, inventory registered/external app repositories with this contract,
and identify the owner/release of every required change before claiming rollout completion. An external app is not migrated
by editing this repository's examples alone.

Cover Core manifest validation, package vendoring/asset limits, registry/read/export APIs, installation
and update/rollback behavior; Harness settings and native delivery; CLI/connector and other current
readers; SDK/schema surfaces where present; tests, templates and app-authoring documentation including
[the manifest reference](../../../skills/hosty-app-skill/references/app-manifest.md). The source/discard
asset inventory also reads the old field. None of these consumers is updated by this documentation change.

The selected rollout has one contract. D2/D6 coordinate releases and give actionable old-manifest
diagnostics; never silently drop instructions or retain a permanent legacy reader. A failed update
preflight preserves the installed app. Remove legacy content-digest gates and their UI/state in
migrated consumers. Map existing accepted/enabled app instructions to migrated package selections,
without duplicate old prompt text and new packages; additional packages remain unselected.
Keep caller/app authorization and separate repository/tool approvals.

The 8,000-character prompt cap and trimmed-text digest do not define a full-package limit. Validate
supporting files using existing asset containment and bounded-size conventions. A content hash
may support integrity or change detection; it is not an acceptance gate or historical archive.

### Workflows As Configurable Guidance

The same platform tools should support different working styles. A specification-driven skill
might say to draft a plan, discuss it, wait for approval and then implement it. Another workflow
might start an authorized small fix directly. Existing repository instructions still apply; a
generic workflow must not silently erase a repository's planning or approval rules.

Workspaces manage source, changes and the relevant Git operations. Sandboxes provide instances,
test data and preview. Neither primitive should require specification-driven development, a plan
document or a particular assistant just because this repository uses that discipline.

Optional plan creation, discovery and updates belong to the existing plan-provider investigation.
A workspace might link one plan, several plans, or none; observing documents in a worktree is
different from explicitly attaching a plan. Whether those operations appear through Core MCP,
provider MCP or a combination remains open. This sketch does not move plan parsing into Core.

### Full App Knowledge And Test Recipes

An app skill could explain its stored data, supported ways to read or change it, and how to prepare
synthetic examples for an isolated instance. Supporting files could include data-shape references,
fixtures, runnable seed scripts or script examples, reset instructions and test scenarios.

This could let an agent request the appropriate runtime, prepare a useful dataset and inspect the
result without rediscovering the app's operational conventions on every task. Descriptions and
recipes need a relationship to the app version and runtime they describe. Loading a script as part
of a skill does not itself execute it or grant access to production data. Sandbox execution and
fixture authority remain owned by the sandbox feature.

### Internal And External Delivery

Use native package directories and the selected read-only bind-mount direction for managed container
runtimes, with equivalent native directories/links for local execution. Publish current complete
packages for the selected set. Two profiles using the same provider connection
must not accidentally receive each other's Hosty export because they share a native config home.
D3 supplies a stable parent export for each selection context and replaces complete package entries.
Native discovery links resolve within the consumer namespace; differing concurrent selections use
separate discovery locations even when credentials are shared. D4 verifies the actual launcher
integration; historical single-set probes do not prove concurrent delivery.

Keep the library independent of credentials and the client UI. Verify both Harness adapters and one
named external local client with explicit provisioning. Use Codex CLI on the Core host for first
external acceptance, linking an authorized Core-managed selection export into its native discovery
path. Make this provisioning available through Core/CLI independently of Harness. A Core MCP
connection alone does not put files on disk.
Remote MCP Skills delivery, automatic dependency installation and universal client support are outside
the initial slice. Native repository/user/built-in skills can coexist; Hosty controls its delivered
set, not every instruction a native client can discover.

Update/removal changes the files supplied to active and future consumers. Do not preserve superseded
packages to keep an old session reproducible or turn deletion into a session-start failure. Native
clients may cache loaded instructions; document their actual behavior rather than require universal
hot reload. Basic complete-package replacement still must not publish half-written files.

## Illustrative Journey

This is the owner's desired experience to explore, not an available end-to-end flow:

1. In Harness or an external client, the user asks for a Shell change or a new feature.
2. The agent discovers the applicable instructions and available tools. If the selected workflow
   requires a plan, it drafts one and seeks the required approval; otherwise it follows the
   authorized task and repository rules directly.
3. The agent prepares a registered workspace through Hosty and edits the returned source worktree.
   The user can observe the workspace and its changes through Hosty applications, even when the
   conversation stays in the external client. Plan associations are optional.
4. When verification needs a running app, the agent requests a sandbox for the changed source
   through the supported Hosty interface and uses the app's guidance to prepare synthetic data.
   Missing runtime recipes or unsupported inputs remain explicit; prose alone cannot supply them.
5. The user or agent opens the sandbox preview. The agent may use its existing browser capability
   or an available Playwright runner, depending on the client and configured workflow. Choosing a
   browser integration does not belong to the skill library itself.
6. The agent reports test evidence and changes. Commit, push, PR, merge and cleanup follow the
   user's workflow, repository instructions and the existing operation authority.

The same skills mechanism should also support non-development work; this journey motivates the
idea without defining its entire scope.

## Integration Boundaries

- **Existing app skills:** the owner selected replacement, not permanent compatibility. D2/D6
  own the coordinated multi-package manifest/read/delivery migration and treatment of old clients,
  content limits and current contents; current feature.md remains an account of shipped code.
- **MCP directory:** reuse its identities and grants where appropriate. Profile/session skill
  selection must remain distinct from MCP access and from permission to run bundled scripts.
  A generic language skill need not have an MCP target; app-specific tool guidance needs an honest
  account of which tools the current client can actually use.
- **Modularity:** use the Core-owned library/API with application-owned profiles, presentation and native
  loading. [Agent/model providers](../agent-provider-interface/plan.md) own invocation contracts;
  this feature must not introduce a competing agent runtime or mandatory workflow engine in Core.
- **Runtime provisioning:** [Assistant Runtime Containment](../assistant-runtime-containment/plan.md)
  owns the remaining isolation requirements; the [shared Docker runtime](../assistant-shared-docker-runtime/feature.md) owns the shipped worker lifecycle and mounts. The skills feature defines the selected
  export and native-path requirements; it must coordinate with that launcher rather than treating
  the isolated Docker probe as a shipped Harness container profile.
- **Related development work:** workspace, sandbox, Git/PR and plan-provider implementation remain
  with their existing owners. [App authoring](../app-authoring/plan.md) already anticipates reusable
  recipes; it can consume the eventual library rather than build a second distribution mechanism.
- **External integration:** [external session context](../assistant-external-session-context/plan.md)
  already considers client instructions/plugins. Share packaging decisions, but keep skill delivery
  independent of conversation import or synchronization.

## Standards And Client Research (2026-10-16)

This is a documentation survey of primary sources retrieved on the stated date, plus static
inspection of Hosty's current working copy. It is not an installation, execution or conformance
test. Vendor documentation describes the published product, which may differ from Hosty's pinned
dependencies. Links below identify the sources for each finding.

### Distinct Layers

| Layer | Finding |
| --- | --- |
| Portable skill content | The open [Agent Skills specification](https://agentskills.io/specification) defines a directory with `SKILL.md`, YAML `name` and `description`, and optional supporting files. It directly covers the multi-file package in the owner's idea. |
| Remote delivery | [MCP Skills](https://skills.extensions.modelcontextprotocol.io/) transports those packages over MCP Resources. It supplements the content format rather than defining another one. |
| Repository instructions | [AGENTS.md](https://agents.md/) is plain Markdown for repository guidance, including nested scopes. It has no required metadata or skill-package discovery contract. It remains useful for standing repository rules alongside on-demand skills. |
| Installation and policy | Git importers, plugin marketplaces, assistant configuration and execution permissions have product-specific contracts. The surveyed specifications do not supply Hosty's proposed per-assistant assignment model. |

### Package Contents And Loading

One possible standard-format app skill, shown only to explain the package shape:

```text
prepare-demo-fixtures/
  SKILL.md
  references/data-model.md
  scripts/seed-demo.py
  assets/sample-records.json
```

The specification permits additional directories and files; `scripts`, `references` and `assets`
are conventions. Optional metadata includes `license`, `compatibility` and a string-valued
`metadata` map. `allowed-tools` is experimental. A metadata version is not a universal dependency
resolver or update policy. Relative references resolve from the skill root; deep chains of
references are discouraged even though nested directories are allowed.
[Format specification](https://agentskills.io/specification).

The integration model separates a small discovery catalog, loading the chosen `SKILL.md`, and
reading supporting content as needed. A filesystem agent can use file tools; another agent can use
an activation/read tool. Remote or sandboxed execution needs explicit provisioning or remote
discovery. `.agents/skills/` is an interoperability convention, not a required installation path.
The integration guide also discusses disabled-skill filtering, explicit activation and preserving
loaded context across compaction. These are useful implementation patterns rather than a universal
configuration schema. [Client integration guide](https://agentskills.io/client-implementation/adding-skills-support).

### Native Client Comparison

The table describes native packages and controls. It does not certify that these clients implement
the separate MCP Skills extension.

| Client | Discovery and delivery | Selection and activation |
| --- | --- | --- |
| [Codex](https://learn.chatgpt.com/docs/build-skills) | Repository `.agents/skills` along the working-directory-to-root path, user `~/.agents/skills`, administrator `/etc/codex/skills`, and bundled skills; plugins distribute reusable packages. | Explicit invocation or model selection by description. `[[skills.config]]` disables a local skill by path. `agents/openai.yaml` adds product metadata, tool dependencies and `allow_implicit_invocation`; disabling implicit use still permits explicit invocation. |
| [Claude Code](https://code.claude.com/docs/en/skills) | `.claude/skills` at project/user/managed scopes, additional directories and plugin packages. Nested project discovery and namespaced plugin commands are supported. | `/name` or model selection. `disable-model-invocation` and `user-invocable` control different invocation paths. Native extensions include arguments, dynamic shell context and subagent execution; these are not portable base-format guarantees. |
| [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/skills) | Filesystem packages discovered through `settingSources`, working/additional directories or explicit plugins. There is no API for registering an in-memory skill body as a native package. | `skills: [names]`, `"all"` or `[]` controls model invocation. Unlisted files remain readable through filesystem tools; the filter is not isolation, and direct command dispatch is separate. |
| [Gemini CLI](https://geminicli.com/docs/cli/skills/) | `.gemini/skills` and `.agents/skills` at user/workspace scopes, built-ins and extensions. Its installer accepts Git repositories and local directories. | The model calls `activate_skill`; the documented UI asks consent before adding instructions and access to the package directory. `/skills` supports list, enable, disable and reload. Workspace overrides user skills; `.agents` wins over `.gemini` within a scope. |
| [GitHub Copilot in VS Code](https://code.visualstudio.com/docs/agent-customization/agent-skills) | Project `.github/skills`, `.claude/skills`, `.agents/skills`; personal `.copilot/skills`, `.claude/skills`, `.agents/skills`. | Automatic selection and `/skill` commands; separate user/model invocation flags. `chat.agentSkillsLocations` is deprecated and not read by Copilot harness sessions, so it is not a reliable common integration point. |
| [Cursor](https://cursor.com/docs/skills) | Project/user `.cursor/skills` and `.agents/skills`, compatibility directories, recursive skill discovery and plugins. | Automatic or `/skill` invocation, `disable-model-invocation`, file scopes and skill-backed Custom Modes. Local user skills do not automatically accompany remote agents; documented cloud sync covers `~/.cursor/skills`, not `~/.agents/skills`. |

Codex additionally exposes native App Server methods for listing skills, setting extra discovery
roots, enabling/disabling by path and observing changes. These offer an integration surface for a
consumer such as Harness. Its `skills/list` is an **App Server RPC**, not evidence of support for
the identically named **MCP extension method**. The App Server page also mentions `SKILL.json`
metadata while the authoring page documents `agents/openai.yaml`; verify the pinned version's
accepted sidecars instead of assuming equivalence.
[Codex App Server](https://learn.chatgpt.com/docs/app-server).

The common content format does not make client-specific fields, precedence or execution behavior
portable. In particular, Codex can expose duplicate names rather than merge them, whereas Gemini
documents precedence. Import should preserve provenance rather than flatten every skill into a
single name. [Codex discovery](https://learn.chatgpt.com/docs/build-skills),
[Gemini discovery](https://geminicli.com/docs/cli/skills/).

### MCP Already Has A Skills Extension

[SEP-2640](https://modelcontextprotocol.io/seps/2640-skills-extension) is marked **Final**, on the
Extensions Track. Its page is a historical accepted proposal and directs implementers to the
current stable specification. It explicitly records archive distribution as deferred; a ZIP
importer should not be described as part of this extension.

The extension identifier is `io.modelcontextprotocol/skills`. A participating server exposes
`skills/list` and `skills/get`; files use ordinary `resources/read`, commonly with `skill://` URIs.
`resources/directory/read` is optional. Clients use the negotiated extension; a generic resource
read alone does not activate a skill or approve its contents. The client still owns the skill
loading path. [Extension overview](https://skills.extensions.modelcontextprotocol.io/).

The current stable contract targets MCP `2026-07-28` or later and advertises through
`server/discover`. A fixed package entry carries all files with byte sizes and SHA-256 digests;
persisted approval binds to that set and becomes invalid when it changes. Dynamic packages are
also defined, without content-bound integrity. Nested skills are permitted but require their own
activation consent. A conforming host supports at least 512 resource entries and 16 MiB per skill;
these transport limits differ from a prompt budget. Digests establish consistency, not publisher
trust. [Stable MCP Skills specification](https://skills.extensions.modelcontextprotocol.io/specification/stable/skills).

There is implementation evidence beyond the specification: the official
[MCP Python SDK v2](https://py.sdk.modelcontextprotocol.io/v2/advanced/skills/) documents server/client
extension helpers, while the [Apify mcpc client](https://github.com/apify/mcpc/blob/main/README.md#skills)
documents listing, retrieval and manifest verification. These are usable integration examples,
not proof of native support in every coding-agent UI. No released-product confirmation of this
extension was established for the five coding clients above by the sources inspected. Their
status here is **unverified**, not **unsupported**. The SEP's prototype links are not release evidence.

### Distribution Practices

Git repositories are a real distribution mechanism, but a repository can hold one skill, several
skills or an entire plugin. Vercel's [Skills CLI](https://github.com/vercel-labs/skills) accepts Git
and local sources, supports choosing skills and target agents, installs through copies or symlinks,
and has update/removal commands. It is an ecosystem installer, not the Agent Skills format or a
standard for Core policy. Its source support is useful precedent for import UX, without making
this CLI a required Hosty dependency.

Vendor plugin packages can combine skills and MCP connections. For example, OpenAI recommends
plugins for reusable distribution, while Cursor's repository-import UI expects its plugin
marketplace structure. A plain shared skills repository and a native installable plugin are
therefore different artifacts. [OpenAI distribution](https://learn.chatgpt.com/docs/build-skills),
[Cursor repository import](https://cursor.com/docs/skills#installing-skills-from-a-repository).

Hosted APIs add another provisioning route. OpenAI's hosted shell accepts uploaded, optionally
versioned `skill_reference` attachments; local shell uses local files instead. Its Agents API
discovers packages from registered `environment.capability_directories` inside the sandbox.
These are OpenAI-specific provisioning contracts, not generic MCP installation operations.
[OpenAI API skills](https://developers.openai.com/api/docs/guides/tools-skills).

### What This Means For Hosty

The following are historical research conclusions. The 2026-10-26 decisions select Core package ownership, native delivery and app migration; the research is not product acceptance.

- **Reuse the content format.** Agent Skills is a strong candidate for the package boundary. Core
  could keep Hosty assignments, provenance and reviewed revisions outside the portable content,
  with adapters for native client metadata where needed.
- **Separate delivery paths.** Compare native package provisioning for controlled Harness workers
  with MCP Skills delivery for verified compatible clients. A bootstrap skill/plugin or explicit
  read tools remains a candidate fallback for other clients, and must be labelled as that fallback.
- **Preserve complete packages.** Hosty's current one-file prompt composition and trimmed-text
  digest cannot establish approval of scripts or referenced files. Moving to packages needs a
  deliberate migration; simply reading everything referenced by the approved file is insufficient.
- **Keep policy and environment explicit.** Selecting a skill, exposing its files and allowing a
  script to run are distinct operations. Optional plan-first guidance can be one selected workflow;
  neither the standard nor remote delivery requires Core to enforce specification-driven development.
- **Test per client and version.** Native package support, discovery, remote transport and successful
  task execution need separate evidence. A script still needs its interpreter, dependencies and
  authorized app/sandbox endpoint in the agent's actual environment.

Static Hosty findings at the historical inspection baseline:

- Harness dependencies at that inspection pinned Claude Agent SDK `0.3.288` and
  Codex `0.160.0`; the [current manifest](../../../apps/harness/package.json) has since changed. The installed Claude SDK types already declare the session
  `skills` filter. The [Claude adapter](../../../apps/harness/src/harness/claude.ts) sets
  `settingSources: ["user", "project"]` but supplies no Hosty-selected skill list. Native skill
  discovery can therefore coexist with the absence of a Hosty-managed library. The pinned-client
  checks below exercise the native behavior separately from the Harness adapter.
- The [Codex adapter](../../../apps/harness/src/harness/codex.ts) starts App Server. The native
  methods verified below are not wired into a Hosty skill-selection flow.
- The historical app-skill composer (retired during this implementation) injected approved Markdown
  with an 8,000-character cap. The [CLI connector](../../../apps/cli/src/Haas.Hosty.Cli/Mcp/StdioMcpServer.cs)
  advertises protocol `2025-06-18` and handles tools rather than the Skills extension methods;
  [assistant catalog discovery](../../../apps/core/src/Haas.Hosty.Core/AssistantMcpDiscovery.cs)
  also selects `2025-06-18`. Adopting the current MCP Skills contract needs an explicit protocol/SDK
  compatibility investigation, not just an extra resource on the existing connector.

### Remaining Evidence

The original research left import/update and migration work open, including whole-package review
and revision retention. Decisions 59-60 remove historical retention and repeated digest acceptance.
D2 now implements sources/migration; the following checks contribute historical evidence to D4.
D4 still includes verification against the current Harness pins, other consumers, nested-resource access, script prerequisites, update/resume
behavior and one explicitly provisioned external local client. Remote delivery is outside the selected initial slice. Passing native selection checks does not complete
that broader investigation.

## Pinned Harness Client Verification (2026-10-16)

### Scope And Evidence

The package declarations, installed package metadata and native `--version` outputs agree:

| Harness dependency | Installed native client | Entry point used by Harness |
| --- | --- | --- |
| `@openai/codex` `0.160.0` | Codex CLI `0.160.0` | `codex app-server` |
| `@anthropic-ai/claude-agent-sdk` `0.3.288` | Claude Code `2.1.288` | SDK `query()` |

Inspection baseline: commit `f146d0ddd810eeaaa1d9cc922bf6c000a6d1d3e2` plus the existing working
copy. This verified that baseline's pinned packages on macOS arm64, not the current pins or
the executable of a running deployment. [Codex binary resolution](../../../apps/harness/src/harness/codex-binary.ts) also allows
an explicit command override and a PATH fallback; those require their own version check.

Tests used temporary HOME/CODEX_HOME/CLAUDE_CONFIG_DIR directories, synthetic `alpha` and `beta`
packages, an extra `gamma` package directory, and loopback MCP and model API fixtures. The model
fixture returned deterministic text or a scripted Skill call. Assertions inspected the actual
model request, native tool results and MCP requests; they did not rely only on a discovery list.
No real model inference, production credentials, working Core or deployed Harness session was
used. Source code and dependency versions were not changed.

The locally archived evidence snapshot (`pinned-client-evidence-2026-10-16.json`; excluded from version control) records binary hashes,
selection results and observed MCP methods. Temporary probe scripts and raw fixture requests
remain outside the repository. This is a bounded research result, not a product test suite.

### Selecting Native Skills

**Claude: a direct session allowlist is already available.** The installed SDK's `Options.skills`
accepts `"all"` or a list of discovered skill names. Packages still need to be present in a native
discovery location or supplied through a supported local plugin mechanism; the option does not
upload arbitrary package contents. The probes used `.claude/skills/<name>/SKILL.md` with the same
`settingSources: ["user", "project"]` and Claude Code system-prompt preset as Harness.

| SDK selection | Verified model-visible behavior |
| --- | --- |
| `skills: "all"` | Both fixture descriptions appear; bodies remain unloaded initially. |
| `skills: ["alpha"]` | Only alpha's fixture description appears. Calling `Skill` for alpha loads its body and base directory. |
| `skills: []` | Neither fixture description appears. |
| `skills: ["alpha"]`, scripted `Skill("beta")` | Native tool rejects beta as outside the session's allowlist; its body is not loaded. |

`initializationResult().commands` still contains both alpha and beta even when the model's skill
catalog is filtered. It is not an effective-skill view. The installed types also distinguish
omitting `skills` from disabling skills: omission leaves CLI defaults in effect. The filter applies
to the main session; subagent configuration is a separate contract. Files remain readable through
ordinary file tools if those tools have access, so selection does not establish a filesystem
permission boundary. These semantics match the [SDK skill documentation](https://code.claude.com/docs/en/agent-sdk/skills).

**Codex: selection works through discovery roots and per-thread configuration.** The exact binary
generated its own protocol types using `app-server generate-ts --experimental`. Runtime probes
confirmed:

- `skills/list` discovers `.agents/skills` packages and returns canonical paths and enabled states.
- `skills/extraRoots/set` adds a local directory containing packages; gamma then appears in both
  discovery and the next thread's model-visible catalog. This is a process-level root setting,
  not itself a per-thread allowlist.
- `thread/start` accepts `config: { "skills.config": [{ "name": "beta", "enabled": false }] }`.
  Beta disappears from that thread's catalog. A subsequent thread without the override sees beta
  again, demonstrating that this override did not change the shared config.
- Disabling every discovered name except alpha produces a catalog containing only alpha,
  including removal of the bundled system skills from that catalog. This constructs a selection
  from the current discovery result; newly discovered packages and name collisions still need an
  explicit policy. It is not a first-class immutable allowlist API.
- `skills/config/write` persists an enabled-state change in the configured CODEX_HOME. It changes
  shared configuration and is not equivalent to the isolated per-thread override above.
- `turn/start` accepts `{ "type": "skill", "name": "alpha", "path": "<canonical SKILL.md path>" }`
  and loads the complete alpha instruction body. Use the path returned by discovery: the initial
  probe using the `/tmp` alias instead of the returned `/private/tmp` path did not load the body.

A separate initialization without `experimentalApi` accepted `skills/list`,
`skills/extraRoots/set` and `skills/config/write`. The generated `SkillsListParams` for `0.160.0`
contains only `cwds` and `forceReload`; do not copy newer documentation's
`perCwdExtraUserRoots` field into an implementation targeting this binary. The protocol also has
environment capability-root selection, which was not exercised here. As with Claude, catalog
selection is not proof that excluded files cannot be read through other authorized tools.

The current Harness adapters expose neither of these native selection mechanisms. Their existing
app-skill prompt composition remains a separate route. Supporting a chosen set in Harness appears
feasible with these pinned versions, but requires an approved Hosty package-provisioning and
selection design before implementation.

### MCP Skills Is A Separate Capability

Codex App Server's `skills/list` is a host-to-Codex JSON-RPC method. It does **not** demonstrate
support for the identically named MCP Skills method on an attached server.

The MCP fixtures advertised `resources`, an ordinary tool, and
`extensions["io.modelcontextprotocol/skills"]` with `directoryRead: true`. The first fixture used
legacy initialization; the second also returned a valid modern `server/discover` response and
modern result envelopes. Both native clients connected successfully and discovered ordinary MCP
tools/resources. Neither requested `skills/list`, `skills/get` or `resources/directory/read`, and
the remote skill description did not enter either model's skill catalog.

| Client | Observed transport | MCP Skills conclusion for this integration |
| --- | --- | --- |
| Codex `0.160.0` | Opens with `initialize`, requesting `2025-06-18`, even against the dual-era fixture. | No native MCP Skills discovery demonstrated. Ordinary `skill://` resource visibility does not activate a skill. Do not use this as a supported remote-skill delivery path. |
| Claude Code `2.1.288` through SDK | Probes `server/discover`; uses modern `2026-07-28` metadata when supported. Falls back to legacy initialization requesting `2025-11-25` in the first probe. | Modern MCP transport works, but skill discovery remains inactive in the ordinary isolated SDK configuration. |

Claude's bundled implementation contains more than an unknown extension string: it has a skill
fetcher, `skills/list`, loading through `resources/read`, and directory-resource support. The
fetch path is gated by `tengu_mcp_skills`, whose fallback is false. No private flag was forced and
no production account rollout state was inspected. An account-specific rollout may differ; the
installed version number alone cannot establish availability.

The inspected fetcher also parses list entries as `frontmatter`, `uri` and a top-level `digest`,
then fetches and hashes SKILL.md. Its parser does not consume the current complete `resources`
manifest, and no `skills/get` implementation was found in that binary. Thus this is evidence of
a gated implementation of a different contract shape, not verified compatibility with the current
[stable MCP Skills specification](https://skills.extensions.modelcontextprotocol.io/specification/stable/skills),
which includes `skills/get` and per-file manifests. Enabling a gate would not by itself close that
compatibility question.

### Consequences And Limits

For these exact versions, **native filesystem packages plus client-specific selection are a
verified candidate for controlled Harness workers**. **MCP Skills is not yet a verified common
delivery mechanism for the two clients.** The owner subsequently preferred directory provisioning
with coexisting native sources, rather than requiring an exclusive native allowlist. External
This historical limitation does not block the selected filesystem delivery. Remote MCP Skills
delivery is excluded from the initial slice; D4 covers native delivery.

The probes establish catalog filtering and explicit native activation, not autonomous workflow
quality. Each local package contained a nested reference, but nested reads, script execution,
dependency preparation, subagent inheritance, package updates, active-session changes and resume
were not exercised in this first probe. Those remain in D2-D4, with live changes optional under the
owner direction above. The subsequent managed-home experiment narrows the fresh-session path
question. Neither experiment authorizes implementation; the document stays Draft.

## Managed-Home Directory Experiment (2026-10-16)

### Question And Setup

Does one selected package directory remain discoverable when Harness gives each provider
connection its own native configuration home? The [connection registry](../../../apps/harness/src/connections/registry.ts)
creates homes under `cache/agent-providers/<connection-id>/<revision>` and passes them as
CLAUDE_CONFIG_DIR or CODEX_HOME. It does not move the process HOME to those directories.

The experiment used the same pinned versions as the first probe, with the equivalent native
launch variables and Claude `settingSources: ["user", "project"]`. It did not modify or launch
the working Harness. Temporary assistant A had one export directory and two configuration homes
for each client. Assistant B had its own export and process HOME. Workspace directories contained
no project skills. No native skills allowlist was supplied: discovery followed the files alone.

Each package contained SKILL.md and `references/details.md`. Export directories were mode 0555
and files 0444 while clients consumed them. Native configuration homes remained writable, separate
directories. The model endpoint was a loopback fixture returning deterministic text; assertions
checked the skill description markers in actual model requests, plus Codex's discovery output.
No real model inference or production credentials were used.

### Observed Results

| Check | Result |
| --- | --- |
| Claude negative control: skill exists only at HOME/.claude/skills, but CLAUDE_CONFIG_DIR points elsewhere | That skill is absent from the model-visible catalog. A mount into the ordinary default Claude home alone would miss this managed configuration. |
| Claude: each connection's CLAUDE_CONFIG_DIR/skills is a directory link to assistant A's shared export | Both connections discover the exported package, with no SDK skill selection option. |
| Codex: HOME/.agents/skills links to assistant A's shared export, while each connection has a different CODEX_HOME | Both connections discover the package as a user skill and include it in the model-visible catalog. CODEX_HOME does not replace this HOME-based discovery root. |
| Remove the initial package and add a different package within the same export root, then create fresh conversations using all four existing configuration homes | All four new conversations see the replacement and omit the removed package. The directory links and profile homes remain unchanged. |
| Start Claude and Codex for assistant B, whose native discovery paths point at a different export | Both see B's package and neither A package. This demonstrates distinct discovery sets, not filesystem access isolation. |
| Resolve a nested reference through the Codex and Claude directory links, before and after replacement | Both paths resolve to the same exported file and preserve the supporting directory tree. This was a filesystem assertion, not an agent tool call. |

All 11 fresh-session cases and both nested-path assertions passed. The
locally archived evidence snapshot (`managed-home-evidence-2026-10-16.json`; excluded from version control) records versions, binary and
probe hashes, per-case catalogs, layout and limitations. The probe script and raw fixture requests
remain in temporary storage outside the repository.

### What The Experiment Establishes

The managed-home concern has a working native-path solution for these pinned clients. One
per-assistant export can supply both runtimes while provider credentials/configuration stay in
separate homes. A candidate local layout is:

```text
assistant export/                 complete selected packages
assistant HOME/.agents/skills ->  assistant export/
connection A CLAUDE_CONFIG_DIR/skills -> assistant export/
connection B CLAUDE_CONFIG_DIR/skills -> assistant export/
```

For a container, the candidate adaptation is to mount the export once at a stable internal path
and connect native discovery directories to that internal path. Symlinks must resolve inside the
container's namespace; host-only paths cannot be copied into them blindly. Profiles created or
rotated later would need the same connection to the export. This is an integration requirement
for D4, not an implemented Harness behavior.

This first managed-home test ran on macOS with native directories and symlinks. It proved
fresh-session discovery with the managed-home layout and unchanged export links. The Docker
follow-up below tests Linux clients and host-side changes through a bind mount. Neither test
exercises watcher propagation, active-session reload, resume, profile rotation or concurrent
package replacement. Runtime checks stay in D4 and package publication in D2-D3; decision 59
removes historical retention. Immediate removal of already loaded context remains outside the required
behavior agreed above.

## Docker Bind-Mount Experiment (2026-10-18)

### Question And Setup

Can the same native discovery paths consume a read-only Docker bind mount, and can fresh
conversations see host-side selection changes without restarting the container?

The experiment reused the locally available `ghcr.io/alex-de-haas/hosty-agent-worker:0.54.0`
image, launching it by immutable image ID. Its historical installed packages and native
executables were Codex **0.160.0**, Claude Agent SDK **0.3.288** and Claude Code **2.1.288**.
These differ from [Harness's current package pins](../../../apps/harness/package.json); this
experiment does not verify the current clients. The worker image tag
is not the Harness package version. The environment was Docker Desktop 4.95.0, Docker Engine
29.8.2, Linux arm64 and Node 22.23.3. No image build or dependency update was needed.

Each temporary assistant container received one host export directory at `/skills` using
`--mount type=bind,source=<assistant-export>,target=/skills,readonly`. The process ran as
UID/GID 1000 with a read-only root filesystem and writable `/tmp`. It had no external network,
production credentials, repository mount or Docker socket. A loopback model API inside the
container returned deterministic text. The actual Harness server and Core were not launched.

The native layout preserved separate writable provider configuration homes:

```text
host assistant export/ --read-only bind mount--> /skills/
assistant HOME/.agents/skills -----------------> /skills/
connection A CLAUDE_CONFIG_DIR/skills ----------> /skills/
connection B CLAUDE_CONFIG_DIR/skills ----------> /skills/
connection A CODEX_HOME                         separate writable configuration
connection B CODEX_HOME                         separate writable configuration
```

The links were created inside the container and resolved to its `/skills` path. Each package
contained SKILL.md and `references/details.md`. Claude used the SDK's `claude_code` preset and
`settingSources: ["user", "project"]`; Codex used its native app-server. No native skill-selection
override was provided. Every case created a fresh conversation and native client process, with
the same container driver and existing configuration homes reused for assistant A's cases.

Assertions checked fixture skill descriptions in actual model requests. For Codex, the first
turn completed and its model-visible catalog was checked **before** calling `skills/list` for
corroborating discovery output. Thus a preliminary catalog reload was not needed to make the
fresh conversation discover the packages.

### Observed Results

| Check | Result |
| --- | --- |
| Claude with a custom CLAUDE_CONFIG_DIR and a skill only in HOME/.claude/skills | Negative control passed: the HOME-only package was absent. Each managed Claude home needs its own connection to the shared export. |
| Two Claude profiles with CLAUDE_CONFIG_DIR/skills pointing to `/skills` | Both fresh conversations included the mounted package in the model-visible catalog. |
| Two Codex profiles with separate CODEX_HOME values and HOME/.agents/skills pointing to `/skills` | Both fresh conversations included the mounted package; native discovery classified it as a user skill at `/skills/<name>/SKILL.md`. |
| Host removes `shared-workflow` and adds `replacement-workflow` inside the existing export root | All four subsequent conversations included only the replacement fixture skill. The parent directory inode, container ID and start time stayed unchanged; restart count remained zero. |
| Another container receives assistant B's export containing `other-assistant` | Both clients included B's fixture skill and neither A fixture skill. This verifies separate mounted selections, not a general authorization boundary. |
| Attempt to create a file and overwrite an existing supporting file through `/skills`, in both containers | All four writes failed with `EROFS`; the host could still change its source directory. |
| Read the nested reference through both native discovery links, before/after A's replacement and for B | All three filesystem assertions passed. Both discovery paths resolved to the same mounted package tree. |

**All 11 fresh-session cases and seven filesystem assertions passed.** Both containers exited
successfully and were removed after the experiment. The
locally archived evidence snapshot (`docker-bind-mount-evidence-2026-10-18.json`; excluded from version control) records the immutable
image ID, binary/probe hashes, runtime versions, Docker mount inspection, before/after container
identity, per-case catalogs and cleanup results. Temporary probe scripts and logs stay outside
the repository; model request bodies and credentials are not included in the snapshot.

### Consequence For The Draft

The proposed directory mechanism works with these Linux client versions and a real Docker bind
mount. A stable per-assistant export can be mounted once and shared by both native discovery
paths. Host-side changes to its child packages become available to fresh conversations without
recreating the container or reconnecting the mount. Managed Claude configuration homes still
need their own `skills` link; mounting only HOME/.claude/skills is insufficient for that setup.

This verifies filesystem delivery and discovery in the specified environment. It does not yet
verify Core provisioning, the deployed Harness lifecycle, Linux amd64, arbitrary full Harness
operation with a read-only root filesystem, external-client setup, profile rotation or concurrent
package publication. Each native process was new; active-process watcher behavior, ongoing
conversations and resumed history were not tested. Nested reference checks were ordinary file
reads, not agent tool calls; real-model skill activation, scripts and workflow quality were not
part of this Docker probe. D2-D4 retain those broader design and integration questions. No product
code, manifest, version or runtime configuration was changed, and the plan remains Draft.

## Deliverables

D1-D6 retain their original responsibility areas, now expressed as implementation outcomes rather
than preparation of another research proposal. Verified implementation and acceptance are checked below. Owner decision 60 explicitly removes manual upload.

- [x] D1. Deliver Harness's administrator library journeys over shared Core APIs: catalog/filter/read packages, discover/select Git skills, choose existing Source connections, install, check, update one/update all and remove; show current provenance, removals and failures without upload, package editing or repeated content-acceptance UI.
- [x] D2. Implement source/skill persistence and complete-package validation for Git/app sources, shared fetching, manual per-skill/bulk updates and applied upstream removals; migrate agent.skillFile producers, packaging, readers, SDK/schema surfaces, templates and existing selections to agent.skills, including app lifecycle and removal of legacy digest gates.
- [x] D3. Implement the application-neutral Core catalog/read/import/check/apply/remove/export API and native current-content delivery; enforce administrator writes, authorized reads and repository connection grants, omit deleted IDs, publish complete replacements and separate differing selection exports without historical revisions or session pins.
- [ ] D4. Verify both current Harness native adapters and an explicitly provisioned local Codex CLI consumer: full-package references/activation, two concurrent selections on one provider connection, update/removal, private-source failure, publication and resume; record reload limits and prove no historical retention or missing-skill session block.
- [x] D5. Integrate assistant-default selection and stable-ID inputs for app-owned profiles while preserving standing instructions and separate tool/script authority; demonstrate development and non-development journeys, reuse workspace/sandbox/optional plan owners and support an independent authorized Core consumer without team orchestration or first-party-ID dependencies.
- [ ] D6. Complete the coordinated component/app migration inventory and release sequence, record verification and outstanding blockers, update feature.md and current behavior/authoring documentation, retire this plan only after all deliverables pass, and regenerate the index alongside applicable artifact version changes.

## Implementation Boundaries And Defaults

Product choices are settled. Route/DTO names, storage layout, bounded package-size constants and
launcher mechanics are engineering choices within the contract above, not further owner questions.
Use existing Core API, asset validation, Source connection and lifecycle conventions. If evidence
requires a new dependency or a change to agreed behavior, revise the plan explicitly.

Core owns package contents and APIs and works without Harness. Harness owns its management UI,
instructions and assistant/default references. The orchestration plan owns full role/profile UI,
hierarchy and human-review routing. Support caller-selected skill IDs and differing execution
contexts now without requiring that larger profile feature. A selected skill remains optional
guidance unless explicitly requested in invocation instructions; it never grants execution authority.

Validate SKILL.md metadata, contained paths, supported files, bounded sizes and technical name
uniqueness before publication. Do not analyze semantic conflicts. Checks never remove installed
packages. Explicit apply can replace/remove them; staged failures preserve current usable content.

Manual upload, package editing, personal pools, automatic Git apply, historical package archives,
learned memory, remote MCP Skills delivery and a new Node.js dependency are excluded. Possible
later upload work stays an idea, not hidden unfinished scope in this implementation.

## Implementation Order

1. Start D2-D3 with catalog/source persistence, full-package validation and Core operations/tests.
   Reuse public Git transport and explicitly authorized private Source connections.
2. Deliver D1 and D5's default selection over those APIs. Keep catalog reads, administrator actions,
   source credentials and optional skill selection distinct.
3. Wire D3 exports into both native adapters and local Codex CLI, then run D4 against current pins,
   including real activation and differing concurrent selections rather than path discovery alone.
4. Complete D2/D6 producer/reader migration and coordinated releases, including old-manifest
   diagnostics and removal of old content gates. Finish documentation and versions with verified
   implementation. Keep one feature PR rather than one per phase.

## Verification And Promotion

Ready requires approval of this implementation plan, not a previously working implementation.
Runtime checks below are acceptance during delivery. Historical experiments do not complete D4.
All unfinished implementation remains in D1-D6.

| Area | Required acceptance |
| --- | --- |
| Package/import | SKILL.md, nested reference and script/example; selective installation from a multi-skill repository; no upload route/UI; technical name/path/size validation. |
| Updates | Checks never apply; one-skill update leaves another unchanged; Update all reuses source downloads without installing new skills; upstream deletion is shown and applied explicitly; network/authentication/validation errors preserve current copies. |
| Private source | Explicit existing supported Source connection; rejected unauthorized/unsupported bindings; revoked access blocks remote reads without deleting installed files; no repository credentials exposed to consumers. |
| Delivery | Two differing contexts on one provider connection, both Harness runtimes and local Codex CLI; full-package reads and actual activation; current files on resume, no historical retention, missing IDs omitted and native reload limits recorded. |
| App migration | Multiple packages, stable keys across directory moves, app update/removal reflected in delivery, no repeated digest gates or duplicate legacy instructions, migrated selections preserved and additional packages unselected. |
| Composition | A framework skill and multi-package app, development and non-development tasks, editable standing instructions and unchanged tool/script permissions; APIs usable without Harness and by an unrelated authorized app. |

Run affected builds/unit tests in the registered worktree and integration/browser checks in a
Core-managed sandbox with separate test data and normal identity. Test real provisioning for both
native adapters and local Codex CLI. Do not copy live credentials or ordinary app data to make a
test pass; report missing authorized test inputs. Inventory external app migrations explicitly and
do not claim complete rollout while any required migration remains unfinished.

The owner approved this plan as Ready on 2026-10-26. Mark In Progress when implementation starts
and check deliverables only after their required verification passes. The approval-only edit
requires no version bump or runtime deployment. Run the docs
index generator/checker, documentation-validator tests and git diff whitespace validation.

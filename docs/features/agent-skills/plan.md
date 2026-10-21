---
status: Draft
created: 2026-10-15
updated: 2026-10-20
summary: Draft bind-mount delivery decision, native-client evidence and remaining choices for shared skills selected per assistant.
components: [apps/core, apps/harness, apps/shell]
---

# Shared Agent Skills And Configurable Workflows

## Idea And Status

An intentionally very early idea sketch captured at the owner's request on 2026-10-15, so the
discussion is not lost. The initial capture left ownership, configuration, packaging and delivery
open. The owner's subsequent filesystem-delivery preference is recorded below; detailed design
and implementation remain unapproved. The deliverables are questions to investigate, not a
committed build sequence.

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

Harness uses local digest acceptance; CLI/facade retain the global digest gate.
This shared-skills plan owns full packages and delivery,
and should reuse that assistant settings entry rather than create a second editor.
It does not duplicate the shipped settings work or authorize implementation.

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

The owner prefers native filesystem packages as the initial delivery approach for assistants
whose execution environment Hosty controls. This narrows the Draft; it is not approval to implement
or promote it to Ready.

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
Core manages the export; the detailed library ownership and storage model remain open.

This settles the delivery direction, not the full feature design or an implementation approval.
The following earlier decisions remain in force:

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

## Candidate Direction

### A Shared Pool With Different Sources

Explore a shared library, possibly owned by Core, containing:

- Core-provided skills for using Hosty capabilities and composing common workflows.
- App-provided skills for the app's own tools, concepts, development and test data.
- User-authored or uploaded skills, including skills unrelated to a particular installed app.
- Imported packages, potentially from a Git repository or another distribution source.

A user might add Rust or framework-specific guidance even when Hosty ships no such skill. An app
might supply several focused skills instead of one growing instruction file. The library would
preserve where each skill came from; an app update, Core update and user edit need not share one
update policy. These are possibilities to compare, not a selected manifest or storage layout.

### Selection Per Assistant

The owner's preferred initial scope is a common pool with selection for each assistant: one
assistant gets a development-oriented set, another a different specialization.
Users should be able to add skills and disable optional skills they do not want used.

Explore shared defaults with per-assistant choices and define the user/administrator configuration
surface. Harness could expose the relevant controls without being the owner of every assistant's
configuration. Resolve how the assistant identity maps to installations and users. Separate
per-model or per-provider-connection selections are not required for the initial approach.

Separate eligibility, selection and actual loading: a skill can be available without every file
being inserted into every prompt. Decide how the user sees the effective set and why a particular
skill was included, excluded or unavailable. Optional guidance is configurable; actual API grants
and enforcement do not become instructions that can be toggled off.

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

Aim for the same applicable guidance to be usable by an internal assistant and an authorized
external agent. Do not assume identical native skill support, local files, browser tools or
configuration APIs in every client. A direct external Core connection is distinct from the
read-only facade, and receiving instructions does not enlarge its grants.

Use native skill-package directories for Hosty-controlled runtimes, with the confirmed bind-mount
approach for containerized assistants and equivalent local directories/links for local execution.
For external clients, investigate local provisioning, discovery metadata, MCP resources or tools,
and a small client plugin or bootstrap instruction where needed. Those external delivery paths
remain candidates, not claims about current compatibility. An MCP connection alone is not evidence
that a new external chat automatically loads Hosty's skills.

Git-backed distribution is one candidate. The research below identifies existing formats and
delivery mechanisms; Hosty's repository layout, import policy and installation mechanism remain
undecided.

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

## Relationships And Tensions To Resolve

- **Existing app skills:** move from one reviewed file to full packages without losing attribution
  or accidentally treating unreviewed referenced files as approved. Decide compatibility with
  `agent.skillFile`, content limits and the existing shared digest policy.
- **MCP directory:** reuse its identities and grants where appropriate. Per-assistant skill
  selection must remain distinct from MCP access and from permission to run bundled scripts.
  A generic language skill need not have an MCP target; app-specific tool guidance needs an honest
  account of which tools the current client can actually use.
- **Modularity:** compare a Core registry/policy with assistant-specific presentation and native
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

The following are research conclusions and candidates for discussion, not approved decisions:

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
- [App-skill composition](../../../apps/harness/src/mcp/skills.ts) still injects approved Markdown
  with an 8,000-character cap. The [CLI connector](../../../apps/cli/src/Haas.Hosty.Cli/Mcp/StdioMcpServer.cs)
  advertises protocol `2025-06-18` and handles tools rather than the Skills extension methods;
  [assistant catalog discovery](../../../apps/core/src/Haas.Hosty.Core/AssistantMcpDiscovery.cs)
  also selects `2025-06-18`. Adopting the current MCP Skills contract needs an explicit protocol/SDK
  compatibility investigation, not just an extra resource on the existing connector.

### Remaining Evidence

D2 remains open for a Hosty import/update and migration proposal, including identity, full-package
review and revision retention. The following checks contribute historical evidence to D4.
D4 still includes verification against the current Harness pins, other consumers, nested-resource access, script prerequisites, update/resume
behavior and a verified remote-delivery route. Passing native selection checks does not complete
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
MCP delivery remains a separate question in D4.

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
package replacement. Remaining runtime integration checks stay in D4; package publication and
retention stay in D2. Immediate removal of already loaded context remains outside the required
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

- [ ] D1. Compare concrete user workflows and internal/external consumers, including one development flow without a plan and one non-development use, and identify the smallest useful scope.
- [ ] D2. Investigate full skill-package formats and distribution conventions, including nested resources, app/Core/user sources, Git import, revisions, updates and compatibility with existing app skills.
- [ ] D3. Define configuration ownership and the per-assistant selection identity, shared defaults, exclusions, duplicate-source guidance and an understandable view of Hosty-supplied skills alongside native sources.
- [ ] D4. Repeat version-sensitive discovery and selection checks against the current Harness pins, then validate native directory provisioning for managed Harness homes and container mounts, fresh-session selection changes, another assistant and an external client; record capabilities, optional live reload and fallback/bootstrap needs.
- [ ] D5. Map the workspace, optional plan, sandbox, fixture and browser journey to existing feature owners; identify missing integration contracts without duplicating their implementation deliverables.
- [ ] D6. Consolidate findings and unresolved choices into a reviewable proposal with acceptance scenarios, migration and permission boundaries; obtain explicit owner approval before any implementation scope becomes Ready.

## Open Questions

The bind-mount choice and fresh-conversation semantics above are settled direction. The remaining
questions below are grouped for discussion; references to D1-D6 keep all unfinished work in the
existing deliverables rather than adding an implementation checklist.

### 1. Initial Scope And User Experience (D1, D3, D6)

What is the first useful slice: a library and assistant selection screen, a bundled Core workflow,
or both? Which sources must be usable initially: Core, installed apps, user-uploaded directories,
Git repositories or direct authoring? Decide whether editing, automatic updates, reusable selection
profiles and external-client installation belong in that slice. Choose one development example
without a mandatory plan and one non-development example to keep the library general.

Where can an administrator browse, import, enable, disable and remove packages? How does the UI
explain source, revision and whether a package is selected, awaiting review or unavailable? A
Hosty selection screen must not claim to enumerate every repository/built-in skill a client can
discover or prove that a selected skill was loaded by the model.

### 2. Library Ownership And Assistant Identity (D2, D3)

Does Core keep the package bytes and revisions, index provider-owned content, or combine both?
Should common library management live in Shell while assistants expose their own selection UI?
Who may modify the library and assignments: only administrators, or also users within a defined
scope? Are shared defaults needed initially?

The MCP directory already identifies installed assistants and binds assignments to installation
identity. Decide whether skill selections reuse that identity, what reinstall/removal does to
them, and whether user-specific overrides are needed. This does not reopen per-model selection;
provider credential profiles remain native delivery targets for the assistant's shared set.

### 3. Package Identity, Imports And Compatibility (D2)

Define a stable Hosty package identity separately from its display name and native skill name.
Resolve same-name imports from different sources, multiple skills from one app/repository, nested
independently selectable skills and dependencies. Agree on the supported portable SKILL.md subset
and treatment of client-specific metadata without inventing a new content format unnecessarily.

Is Git a one-time importer, an update source, or both? How are repository URL, subdirectory and
revision recorded? Can users edit an imported package, and is that a fork or an upstream override?
Choose revision pinning and update behavior for app, Core, Git and uploaded packages. Size/file
limits, unsupported fields and package-path validation also need a defined import contract.

### 4. Existing App Skills, Review And Permissions (D2, D3, D6)

The existing `agent.skillFile` contract supplies one attributed text file, caps prompt delivery at
8,000 characters and approves a digest of that text. Full packages need an explicit compatibility
path: keep that contract alongside packages, adapt it, or migrate it. Decide how to prevent the
same guidance being injected as legacy prompt text and discovered again as a native package.

What exactly is reviewed and pinned when a package includes scripts, assets and references? Decide
whether approval covers a complete package revision, how changed files invalidate it, and how
source attribution survives native loading. Existing shared instruction approval and per-assistant
selection are different concepts. Keep skill choice distinct from MCP grants and script execution
authority; app guidance without the relevant tools must be represented accurately.

### 5. Always-Applied Instructions And Optional Skills (D1, D3)

The initial idea uses "skills" for both standing workflow instructions and reusable knowledge.
Directory discovery does not ensure that an agent activates every optional skill. Decide how a
user's rule such as "always draft a plan before a feature" reaches the standing instruction channel,
and which guidance should instead load on demand as a native skill. Harness already has an
operator system prompt; compare reuse/composition before introducing another instruction surface.

Define how Core defaults, user workflow instructions, app guidance and repository instructions
compose and how conflicting guidance is explained. Selecting a skill does not enforce a workflow
or grant operations. Repository requirements and existing operation authority still apply.

### 6. Publishing Updates And Retaining Supporting Files (D2, D4)

Fresh conversations must see a consistent selected revision. Decide how a complete multi-file
package is staged and published inside the stable mounted parent, including concurrent updates,
failure recovery, rollback and app removal. The successful sequential add/remove probe does not
prove a concurrent publication protocol.

When an existing conversation has already loaded instructions, disabling or updating that package
can still remove a reference or script it expects to read later. Decide whether old supporting
files remain available for active work and for how long. This is a file-lifetime question, not a
requirement to retract existing context or add live reload.

### 7. Runtime Integration And External Clients (D4)

Define how the runtime launcher connects the export to newly created or rotated native homes,
preserving writable per-connection configuration and the shared read-only skills root. Remaining
verification includes actual Harness lifecycle integration, the intended supported architectures,
and agent-driven reads/activation of a full package. The experiments already establish discovery
on the historical tested clients. Repeat version-sensitive checks against the current Harness
pins before claiming compatibility for the deployed runtime; this remains part of D4.

External clients need a selection identity and explicit provisioning appropriate to their own
environment. Decide the initial supported external scenario and whether local installation/export
is sufficient. Remote clients without filesystem access may need another verified delivery/read
path. Bind mounts do not establish MCP Skills support or automatic skill loading by an external
client connected to Core; neither MCP Skills implementation nor a bootstrap plugin is selected yet.

### 8. Workflow Recipes And Related Feature Contracts (D1, D5)

Which scripts are executable helpers versus examples, and how are interpreters, dependencies,
app versions, data shapes and fixture prerequisites described? Use a concrete app recipe to identify
missing contracts without making the skills library own sandbox execution or browser tooling.

Map workspace, optional plan, sandbox, fixture and browser steps to the existing owners. Plan
discovery/update contracts and associations stay with the plan-provider Draft; a universal plan
service or mandatory specification-driven workflow is not a prerequisite for the skills library.

## Suggested Decision Order

The following is a proposal for the next discussion, not an additional owner decision:

1. **Agree on the smallest first use case and ownership (questions 1-2).** A starting proposal is
   a Core-managed library/export and administrator-selected packages for an existing installed
   assistant, with shared administration in Shell. Keep user overrides, reusable profiles and
   richer authoring optional until a concrete need is chosen. Explicitly choose the first source
   and external-client scope rather than silently dropping the broader goals.
2. **Define the content and instruction contract (questions 3-5).** A starting proposal is
   standard-format package directories with Hosty identity, provenance and revision metadata kept
   outside the portable files; treat standing workflow instructions separately from on-demand
   skills. Resolve legacy app compatibility and full-package review before deciding import UI or
   extending app manifests.
3. **Define revision publication and delivery acceptance (questions 6-7).** Keep the selected
   bind-mount approach and agree on supporting-file lifetime, new-profile setup and the exact
   Harness/external-client scenarios that must pass. These follow the product choices rather than
   requiring another generic transport investigation.
4. **Validate the chosen slice against real workflows (questions 1 and 8).** Check both development
   and non-development examples, record related-feature gaps under their owners, and consolidate
   a reviewable proposal in D6. Only explicit owner approval can promote an implementation scope
   to Ready. All six exploratory deliverables remain open because none is fully satisfied yet.

## Verification And Promotion

Before a build proposal is approved, use concrete packages and client capability evidence to
evaluate D1-D5. Include a nested reference plus fixture script, a user-added framework skill, two
assistants with different selections, a disabled/updated skill, and an external client requiring
explicit setup. Compare both a plan-driven journey and one with no plan. Distinguish available
guidance, loaded guidance and observed agent behavior; configured skills do not guarantee actions.

Keep this document Draft while the choices remain open. The owner direction, documentation survey
and bounded native-client checks leave the exploratory deliverables open and authorize no
implementation. This uses the existing Draft document type; it introduces no separate ideas
format or documentation-workflow change.

For this documentation-only capture, run `node scripts/docs-index.mjs --fix`,
`node scripts/docs-index.mjs --check`, the documentation-validator tests and `git diff --check`.
Product builds and deployed-runtime tests are not applicable until product code changes. The
isolated native-client research probes above are separate from those product checks.

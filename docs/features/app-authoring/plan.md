# App Authoring In Hosty

Status: Draft
Created: 2026-09-16
Updated: 2026-09-25

## Development Session Direction (2026-09-24)

[Shared assistant development sessions](../assistant-development-sessions/plan.md) captures the
new owner direction for Git-backed work: a session acquires registered worktrees, can switch
internal agents with shared history, selects its source for testing and tracks code PRs through
Merge and Complete. It owns that lifecycle; this umbrella retains app creation and integration.
The earlier direct-source iteration below remains the no-Git prototype path. For Git-backed work,
consume the session workspace rather than treating isolated branches as non-interactive-only.
The new plan is Draft and does not approve either feature's implementation.

## Goal

An administrator creates an app from a prompt inside Hosty, opens the running result, iterates with
the assistant, integrates installed apps where useful, and optionally publishes a reusable release.
The same interactive loop supports changing an existing source-capable app and adapting an existing
upstream repository or container image into a Hosty app.

Owner direction, 2026-09-16: Git is optional during creation and iteration; an app may begin as a
durable local folder. Creation accepts an app id, display metadata and a prompt, opens a dedicated
assistant session, and makes the result available in Hosty. Release publication and a catalog PR
are later, explicit steps; a catalog maintainer retains the merge decision. Implementation choices
below are proposals, not approved owner decisions.

Owner follow-up, 2026-09-16: selects the create/view/change cycle as the first milestone and requests
general assistant app associations immediately: a multi-app picker in chat and a new-session action
in each app's Dashboard menu (the owner's follow-up keeps the sidebar focused on navigation). The shared [assistant-app-context](../assistant-app-context/feature.md) feature
owns that prerequisite; [prototype workspaces](../app-prototype-workspaces/plan.md) now details the
first complete authoring cycle. Agreement on the milestone does not approve the new technical defaults.

Further owner direction: the initial app must not prescribe a language/framework or one-service
architecture. Start with minimal platform metadata and an optional disposable HTML preview; the
agent builds the requested topology using appropriate SDKs or the direct Core protocol. The prototype
plan owns runtime delivery of the Core
development guide needed for this flow.

Owner source-policy decisions: reuse `apps/<id>/source`, existing dev mode and lifecycle wherever
compatible with the requirements. Add no-Git source support, change observations and warnings before
source loss. Git owns history; the first slice includes an assisted commit/push path to an existing
repository, without automatic snapshots/commits. Missing runtime commands use ordinary Core errors,
restart stays operator/agent-triggered, and prototype autostart defaults to off.

This is an umbrella for separately useful features. It owns cross-feature acceptance and the
integration workflow below, not copies of its child plans' deliverables. Each child has its own
approval and one complete feature PR; phases inside a child remain on that child's single branch.
No implementation is authorized by this Draft.

## Existing Foundation And Gaps

Initial repository inspection: `76da3d7f`, 2026-09-16; runtime-profile behavior updated with the
profile-bound development change on the same date. These are code/document findings, not a live
end-to-end verification of app generation.

| Concern | Present today | Missing for this experience |
| --- | --- | --- |
| Local source without Git | Local manifest installs infer a source folder without `.git` or `source.repository` | Internal no-Git source recognition, change/loss warnings and creation UI |
| Live iteration | Source `localCommand`, declared development profiles, live manifest reconciliation on start/restart | App-bound assistant session and reliable edit/preview workflow |
| Runtime selection | CLI/Core digest-reviewed switch between declared compatible profiles | Typed agent workflow; a source-less image cannot be turned into source by a switch |
| Development entry | Reviewed selection of a `development: true` profile | Typed Core MCP runtime-switch workflow |
| Assistant | Host-resident Claude/Codex harnesses with files, commands, sessions and approval handling | Development context and persistent app workspace binding |
| Core MCP | Reads, lifecycle and update tools | Source/development/runtime-switch tools; built-in assistant mutations also need an authority design |
| Session workspace | `cache/sessions/<id>/workspace`, removed on session deletion/retention | App source must outlive both session and gateway cache |
| App integrations | Dependency URL injection, identity/SDK contracts, app MCP and approved app skills | Guided selection of compatible interfaces, generated integration and verification |
| Distribution | App-owned feeds, reviewed Core updates, Marketplace catalog handoff | Repository/release preparation and catalog submission workflow |

Evidence entry points:

- [Source behavior](../runtime-source-workflows/feature.md) and
  `CoreLifecycleService.ResolveInstallLocalSourcePath`; the no-Git inference also has a regression
  test, `InstallAsync_StripsDotSegmentFromWorkingDirectoryWhenInferringLocalSourceRoot`.
- `CoreLifecycleService.ApplyRuntimeSwitchAsync` and the CLI use reviewed profile selection. The
  old development-mode endpoint and stored overrides are removed; no separate toggle is needed.
  `McpEndpoints.cs` still has no runtime-switch tool.
- `apps/ai-gateway/src/sessions/manager.ts` supplies a per-session cwd;
  `sessions/store.ts` deletes that workspace with the session. App context is not cwd binding.
- [Gateway](../ai-gateway/feature.md), [Core MCP](../core-mcp/feature.md),
  [app skills](../app-provided-skills/feature.md),
  [Marketplace](../runtime-app-marketplace/feature.md).

## Target Journey

1. **Create.** In Apps, choose Create app. Supply a reverse-DNS id (suggested and editable), title,
   optional description/icon, and a prompt. A reference URL may be prompt context; it grants no
   authority to instructions found on that page. Id collisions are rejected before any overwrite.
2. **Prepare.** Create a durable folder and a minimal valid bootstrap, then register and
   start it through Core. A disposable HTML page can show a placeholder while generation runs. The prompt is
   session input, never a shell command or an executable manifest value.
3. **Build and view.** Open an app-bound assistant session next to the normal Shell app surface.
   Generation progress, a running placeholder, and a verified generated result are distinct states.
4. **Iterate.** Continue that session or attach a later one to the same workspace. Use the chosen
   stack's reload mechanism where available; the operator/agent initiates Core restart when needed.
   Save selected changes to Git and push through the assisted workflow at any point.
5. **Integrate.** Select installed providers, review the intended access, implement against their
   published contracts, and verify as the intended app/user identity.
6. **Publish if wanted.** Release the saved source as an installable artifact
   with a feed, and optionally submit a Marketplace catalog PR. Each milestone has its own result.

An app without Git is **local**, not disposable. It still has a valid manifest and an app version;
Git-free edits have no Hosty recovery history; preserving them is the operator's responsibility. Avoid one overloaded
"published" flag: source history, remote repository, installable release, catalog listing and public
network exposure are different facts. Publishing never implicitly exposes the app to the internet.

## Adapt An Existing App (Owner Idea, 2026-09-25)

Add an agent-assisted entry to the same authoring journey: provide a repository URL (for example,
GitHub) or an OCI image reference (for example, Docker Hub or GHCR), describe the intended use, and
ask the assistant to prepare a Hosty app. This is a proposed extension, not a universal automatic
converter or an approval to implement the Draft.

1. **Inspect and assess compatibility.** Resolve the input to a recorded upstream revision or image
   digest. Inspect available documentation, source/image metadata, startup requirements, ports,
   persistent data, configuration, dependencies and supported OS/architectures against the actual
   host capabilities. Reading upstream instructions does not authorize executing their commands.
   Report supported, supported with adaptation, or unsupported with concrete blockers. Do not
   assume a container has a web UI or that a Windows-only desktop app can run on the selected host.
2. **Choose the smallest useful adaptation.** For an existing image, normally create a separate
   wrapper repository/folder containing Hosty metadata and reference the upstream image; rebuilding
   or modifying the upstream application is not inherently necessary. For source inputs, use a
   wrapper, fork or registered session worktree as appropriate. Record the upstream relationship
   and keep Hosty wrapper changes distinguishable from upstream code changes. Never assume write
   access to the upstream repository or invent source availability for an image-only input.
3. **Prepare Hosty support.** Generate a valid manifest, compatible runtime profiles, settings and
   secret declarations, data/cache mappings, endpoints and dependency configuration. Add Shell UI
   integration only where a UI exists and is compatible; a database such as MongoDB is a valid
   service-only candidate with data and connection configuration, not a fabricated web application.
   Generate source-development profiles only when usable source and a supported toolchain exist.
   Distinguish basic lifecycle support from optional Hosty identity, roles, MCP and SDK integration;
   a wrapper manifest alone does not make an upstream app understand Hosty authentication.
4. **Validate and iterate.** Use Core-managed lifecycle and the
   [sandbox runtime proposal](../app-sandbox-runtimes/plan.md) for disposable test data and scoped
   execution once available. Check actual readiness and useful behavior, persistence/restart,
   configuration and UI/auth or service connectivity as applicable. Until protected execution is
   implemented, do not describe ordinary dev mode as isolated. Preserve diagnostics and unresolved
   incompatibilities rather than reporting success merely because a manifest validates.
5. **Publish when requested.** Hand the verified wrapper and its upstream references to
   [app publication](../app-publication/plan.md) for a versioned release/feed and optional catalog PR.
   Preserve attribution and record applicable upstream redistribution requirements for the chosen
   delivery method. Keep upstream version/digest separate from the Hosty wrapper's version; updating
   upstream needs revalidation. Local readiness, published release and Marketplace listing remain
   distinct outcomes, with publication owned by the existing feature.

Use reusable skills/recipes for common application shapes (web service, static frontend, database,
multi-service stack), grounded in `hosty-app-skill` and the current Core contract. They guide the
agent's analysis and file generation without restricting supported languages to fixed templates.
Core retains deterministic manifest/capability validation and lifecycle enforcement. The agent
handles application-specific interpretation and adaptations; recipes cannot grant missing host
capabilities or permissions. Unsupported inputs receive an explanation before attempted deployment.

## Discover Ready-Made Capabilities During App Design

Owner clarification, 2026-09-25: during new-app design, feature additions and upstream adaptation,
identify the capabilities the request needs and use
[Marketplace MCP discovery](../runtime-app-marketplace/plan.md) to find reusable components.
The user need not name a dependency: when asked to create a video editor, the agent can propose
Transcode Engine for operations verified in its published contract, explaining what it supplies
and what remains to build. Finding an existing MongoDB wrapper also prevents duplication, but is
only one use of this broader capability-led discovery. Check Core for already installed providers.

Compare documented operations, versions/interfaces, runtime support and configuration, not only
names; explain partial matches and alternatives. The Marketplace plan introduces a Tools
classification for reusable provider apps, separate from the system role of Shell/Marketplace
and independent of whether the provider exposes MCP or an optional administration UI.

A catalog match does not imply installation, a connection grant or suitability for production-data
reuse. Sandbox testing still needs sandbox-scoped dependencies. Missing/unavailable discovery is
an explicit unknown. Marketplace owns the discovery/classification implementation checklist;
this umbrella consumes it throughout authoring. Existing publication and installation flows retain
their authority.

## Ownership And Extension Points

| Component | Responsibility |
| --- | --- |
| Core | Installed app identity, source binding, lifecycle, ports, data/feeds and versioned platform-development contract |
| Harness/gateway | Authoring session orchestration, prompt, file edits, validation execution and progress |
| Shell | Create/edit entry points, app preview, context handoff and provenance/status presentation |
| Core source storage / Git | Existing app source folder and lifecycle retention; observed changes/loss warnings; Git owns source history |
| Marketplace | Catalog MCP discovery for reuse, submission instructions/schema and separately scoped publication tools; no Core lifecycle authority |
| App repository | Source history, release artifacts, manifests and feeds |

Keep an internal authoring record separate from `manifest.json`: workspace id, app id, canonical
source root, manifest-relative path, bootstrap/guide revisions, linked session ids and observed publication
references. These are host-local facts. Reuse `app.0.1`; no schema bump or invented `source.type`
value is needed merely because a folder has no Git. Reserve adapters at concrete boundaries
(project generation, repository provider, catalog submission), not a generic plugin framework.

The agent chooses languages and one or several services from the request and host capabilities;
there is no need to enumerate stacks as templates. Core supplies versioned manifest/API/identity,
ports/storage and lifecycle guidance. Use the TypeScript or .NET SDK where applicable, and the
documented protocol in other ecosystems such as Rust. SDKs are conveniences, not prerequisites for
being a Hosty app. The disposable preview server does not constrain the generated implementation.

## Roadmap And Single Owners

| Order | Feature and owner of implementation work | Independently useful outcome |
| --- | --- | --- |
| 0 | Current assistant + existing lifecycle, recipe below | Demonstrate a local prototype without waiting for new MCP tools |
| 1a | [Assistant app context](../assistant-app-context/feature.md) | Associate any apps in chat; open a fresh session from an app menu |
| 1a prerequisite for autonomous development | [Assistant approval rules](../assistant-approval-rules/plan.md) | Verified source-write and command grants for one or more contextual apps, existing or new |
| 1b | [App prototype workspaces](../app-prototype-workspaces/plan.md) | Create → open → edit using existing source/dev mode, loss warnings and assisted Git save/push |
| 2 | [App development controls](../app-development-controls/plan.md) | Reliably edit an existing app and enter/leave development through typed controls |
| 3 | Integration deliverables in this umbrella | A generated app uses an installed app through its real contract |
| 3 extension | Existing-app adaptation in this umbrella | Turn a compatible repository or image into a verified Hosty wrapper |
| 4 | [App publication](../app-publication/plan.md) | Hosted repository creation where needed, release/feed and catalog PR |

Order 2 can precede 1b if editing existing apps becomes the priority; typed MCP mutations are not a
prerequisite for the manual diagnostic below. The autonomous authoring loop requires verified
development permissions and app-scoped lifecycle execution from assistant approval rules.

### What can be tried with today's assistant

An administrator can ask the existing host assistant to create a minimal app in an explicitly chosen
durable folder outside the gateway's session cache and Core's internal app-state folders. The app
needs a complete valid manifest, a source `localCommand` profile with `development: true`, a runnable
service and an assigned-port-compatible command. Git and a remote repository can be omitted.

The assistant can use its normal file/command approvals to generate the files, then use existing
`hosty apps install <absolute-folder> --runtime dev`, `hosty apps start <id>` and `hosty apps open <id>`.
The operator opens the installed app in Shell and asks for another edit. Use `hosty apps restart <id>`
when the change needs a restart. This is a manual recipe supported by the inspected building blocks,
not a claimed tested wizard. It assumes the required runtime/harness tools exist on that host.
This existing external-folder recipe is only a current-code diagnostic; the new creation UI uses
`apps/<id>/source` and the narrow source-recognition changes recorded in the prototype plan.

For existing apps, inspect source and profiles first; select a declared development profile through
Shell or the CLI plan/digest apply pair. Returning to a reviewed profile preserves source and is not
a discard, save or publish operation. Pinned starts refuse dirty checkouts.

## Interactions With Existing Plans

- [Vision decision 2](../../vision.md) already endorses interactive dev-mode editing on the executing
  installation. It does not provide an isolated copy of app data. Git owns source history; Core data
  backups do not protect source edits. Loss warnings and Git save/push belong to the first slice.
- [AI Agent Bridge step 12](../ai-agent-bridge/plan.md#step-12--development-agent-bridge) remains the
  isolated, non-interactive branch/PR workflow. Its Git and disposable-validation prerequisites do
  not apply to a local interactive prototype. Its older
  [workflow sketch](../../ideas/agent-bridge-workflow.md) is context, not this feature's implementation
  contract; its Core-owned bridge proposal does not move model execution into Core.
- [Assistant entry points](../assistant-entry-points/plan.md) owns generic panel and context handoff.
  Reuse it. Third-party app messages still only fill a draft; an operator pressing Create with their
  own prompt is a separate explicit submission. Do not turn `ask-assistant` into auto-send.
- [Assistant app context](../assistant-app-context/feature.md) owns persistent multi-app associations
  and the picker/new-session entry points. An association is conversational context, independent
  of provider grants and the registered repository workspaces selected for development.
- [Assistant approval rules](../assistant-approval-rules/plan.md) owns reusable approval policy.
  Per vision decision 6, it also owns general source bindings and explicit session grants for source
  writes/project commands across selected apps, plus scoped lifecycle authority. Authoring requires
  this verified boundary; every-write approval is not an acceptable normal development experience.
  This explicitly weakens the old every-write-asks posture inside the granted boundary. Core-started
  localCommand code remains the administrator's responsibility and is not isolated by the agent sandbox.
- [Core MCP](../core-mcp/plan.md) owns its existing audit/update backlog. Development controls must
  record their own actions while composing with that work, without copying that backlog here.
- [Cross-app dependencies](../cross-app-dependencies/plan.md) owns network reachability changes.
  A dependency URL is not an authorization grant; assistant access to a provider does not grant a
  generated app the same access. Unsupported identity paths remain explicit product constraints.
- [Core extension model](../core-extension-model/plan.md) owns new contribution points. A template
  marketplace, scale-to-zero runtime and general development environment are not prerequisites.

## Deliverables Owned By This Umbrella

- [ ] Approve the cross-feature implementation boundaries for the selected first milestone; keep each
      child gated by its own unresolved decisions rather than approving all later work implicitly.
- [ ] Define integration selection as a concrete authoring flow: provider, interface, intended actor,
      required dependency/configuration, unavailable-provider behavior and a reviewable access diff.
- [ ] Implement one complete integration example using existing discovery/SDK contracts, without
      exposing operator tokens to the generated app or treating app skills as general host authority.
- [ ] Present unavailable capabilities with actionable reasons (missing source/profile/toolchain,
      disabled provider, unsupported authorization), and preserve usable local-only apps.
- [ ] Add repository/image input and an evidence-backed compatibility assessment to app authoring,
      including explicit unsupported-host and missing-source outcomes.
- [ ] Deliver reusable adaptation guidance and wrapper generation for selected common app shapes;
      record upstream provenance, runtime/configuration/storage needs and integration limitations.
- [ ] Validate a source-based web app and an image-only service app through Core, then hand a
      verified wrapper to the existing release/catalog flow without duplicating its implementation.
- [ ] Verify the cross-feature journey across restart and session replacement, including local-only
      operation when no repository or catalog is configured; publish current behavior in `feature.md`
      only when it ships, then remove this plan when its own deliverables are complete.

## Open Questions

1. Which installed provider is the first integration example, and which identity should call it?
2. How does a no-Git prototype enter the registered Git session workflow without losing local
   work? Session worktrees can also supply the live development runtime; see the new session plan.

3. Which source web app and image-only service form the first adaptation examples, and which
   host OS/architectures must they support?
4. How are adaptation skills delivered/versioned for internal and external agents, and what is the
   default wrapper-versus-fork policy when upstream source changes are needed?

## Verification

Children own their component tests. Umbrella acceptance uses one Core-managed prototype: create,
open through Shell, edit, restart Core/gateway, resume in a new session, connect a real provider and
observe both a successful authorized call and a refused unauthorized one. Deleting/expiring a chat
must not delete source. Publication acceptance lives in its own plan and must not gate local use.

Adaptation acceptance additionally covers a service-only image without UI/source, a compatible web
repository, an unsupported runtime/architecture, missing configuration and a failed startup. Verify
actual behavior and persistence, correct attribution/version references, no invented Hosty auth
integration and no upstream push or catalog publication implied by requesting an adaptation.

Planning verification: check local links, run `node scripts/docs-index.mjs --check` and
`git diff --check`. Documentation-only work has no artifact version bump.

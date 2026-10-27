---
status: Draft
created: 2026-09-16
updated: 2026-10-27
summary: Epic for prompt-driven app creation, live iteration, integration with installed apps and optional publication.
components: [apps/core, apps/harness, apps/shell]
---

# App Authoring In Hosty

## Development Session Direction (2026-09-24)

[Shared assistant development sessions](../assistant-development-sessions/plan.md) captures the
owner direction for Git-backed work and links independent owners for session recovery/context handoffs,
session workspaces, source selection and PR lifecycle. It owns cross-feature session acceptance;
those child features own implementation, while this umbrella retains authoring integration and adaptation.
The earlier direct-source iteration below remains a manual external-folder recipe. For Git-backed work,
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
owns that prerequisite. [Local app creation](../app-prototype-workspaces/feature.md) implements the
local authoring cycle under the later approval below; this umbrella retains its own open scope.

Further owner direction: the initial app must not prescribe a language/framework or one-service
architecture. Start with minimal platform metadata and an optional disposable HTML preview; the
agent builds the requested topology using appropriate SDKs or the direct Core protocol. The [local creation feature](../app-prototype-workspaces/feature.md#docker-preview-and-agent-guidance)
packages the running Core's development guide for this flow.

Owner source-policy decisions: reuse `apps/<id>/source`, existing dev mode and lifecycle wherever
compatible with the requirements. Add no-Git source support, change observations and warnings before
source loss. Git owns history; the first slice includes an assisted commit/push path to an existing
repository, without automatic snapshots/commits. Missing runtime commands use ordinary Core errors,
restart stays operator/agent-triggered, and prototype autostart defaults to off.

This is an umbrella for separately useful features. It owns cross-feature acceptance and the
integration workflow below, not copies of its child plans' deliverables. Each child has its own
approval and one complete feature PR; phases inside a child remain on that child's single branch.
No implementation is authorized by this Draft.

Owner approval, 2026-10-17: all five [local creation decisions](../app-prototype-workspaces/feature.md)
are approved: local Git without publication, one consented bootstrap commit, immediate stopped
app registration, local acceptance into main and explicit ordinary local use. New no-Git creation
is deferred; existing no-Git apps remain compatible. That local flow is implemented and verified as recorded in its feature document.
This does not approve the unrelated integration/adaptation/publication work in this umbrella.

## Existing Foundation And Gaps

Local creation checkpoint, 2026-10-18: the feature branch implements and verifies the local
Git/worktree/child-Core flow, optional existing-remote publication and versioned development guide.
This is working-copy acceptance, not evidence of a merged PR or published release.

| Concern | Verified foundation | Remaining owner |
| --- | --- | --- |
| Durable source | Canonical local Git, one consented bootstrap commit, removal/source-loss review and retained-source reinstall | New no-Git creation is deferred by owner decision; existing no-Git compatibility is retained |
| Session workspaces | Multi-app worktrees, leases, continuation, local acceptance and protected cleanup | General development-session integration stays in its own plan |
| Assistant and UI | Codex/Claude Docker worker, Create app/Continue building, recoverable form and guide access | Cross-provider session continuity and broader instruction/approval policy stay separate |
| Preview | Multi-service Docker in a reusable child Core, separate data/users, optional checks and Finish | Broader host/architecture acceptance belongs to sandbox and mixed-runtime plans |
| Source publication | Existing remote connection, reviewed commit/push/draft PR and CI/review observation | Hosted repository/release/feed/catalog provisioning belongs to App Publication |
| App integrations | Dependency discovery/configuration, identity/SDK contracts, app MCP and skills | This umbrella owns guided compatible-interface selection, generated integration and verification |
| Upstream adaptation | Existing manifest/source/runtime contracts | This umbrella owns repository/image/Compose assessment and wrapper generation |

Evidence owners: [local creation](../app-prototype-workspaces/feature.md),
[session workspaces](../assistant-session-workspaces/feature.md),
[shared worker](../assistant-shared-docker-runtime/feature.md),
[Harness UI](../harness-development-ui/feature.md),
[workspace lifecycle](../assistant-pr-lifecycle/feature.md),
[sandbox environments](../app-sandbox-runtimes/feature.md) and
[source workflows](../runtime-source-workflows/feature.md). Reuse these existing registries and
contracts rather than adding authoring-only source/workspace state.

## Target Journey (Approved Prototype Scope)

1. **Discuss and create.** Start in Harness, optionally via Shell. Agree on an app id and request.
   Discussion does not itself allocate source or publish anything. Create has explicit authority
   for the bounded bootstrap and its proposed first Git commit.
2. **Prepare.** Core registers a stopped local app with durable canonical source and no remote.
   Harness binds a normal session worktree; the canonical source stays outside chat/sandbox data.
3. **Build and view.** Run the worktree's Docker development profile in a managed child Core.
   Use the existing chat and workspace panel, normal preview authentication and separate test data.
4. **Iterate and accept.** Reuse the workspace and sandbox. Hot reload where supported; rebuild/restart
   explicitly when needed. Accept reviewed local commits into the local target before completion;
   Finish disposes the test environment without deleting source.
5. **Integrate and use.** Test required dependencies as separate child-Core installations. Ordinary
   local use is an explicit reviewed handoff, not promotion of test users/data or automatic startup.
6. **Publish if wanted.** Connect/push source, provision a hosted repository where requested, prepare
   an installable release/feed and optionally submit a catalog PR. These remain separate outcomes.

The owner approved the prototype's five choices on 2026-10-17, explicitly deferring
new no-Git creation. Existing no-Git source support must remain compatible. Git history, remote
backup, installed runtime, release, catalog listing and public network exposure are different facts.
Neither a local commit nor a clean worktree means the source is backed up remotely.

## Adapt An Existing App (Owner Idea, 2026-09-25)

Add an agent-assisted entry to the same authoring journey: provide a repository URL (for example,
GitHub), an OCI image reference (for example, Docker Hub or GHCR), or a Compose file/repository
containing `compose.yaml` or `docker-compose.yml`; describe the intended use and
ask the assistant to prepare a Hosty app. This is a proposed extension, not a universal automatic
converter or an approval to implement the Draft.

1. **Inspect and assess compatibility.** Resolve the input to a recorded upstream revision or image
   digest. Inspect available documentation, source/image metadata, startup requirements, ports,
   persistent data, configuration, dependencies and supported OS/architectures against the actual
   host capabilities. Resolve image architecture/platform explicitly: an amd64-only image on an
   arm64 host needs a supported, explicitly selected emulation path or an incompatibility result.
   Core's current `ArtifactLock` stores a digest but not the selected OS/architecture/variant or
   emulation choice. Explicit cross-platform adaptation depends on the reviewed platform-lock
   extension owned by [runtime artifacts](../runtime-artifact-model/plan.md), including enforcement
   on subsequent starts. Reuse that extended lock rather than a second store; until it is available,
   report unsupported platform selection instead of claiming a digest preserves it. Reading
   upstream instructions does not authorize executing their commands.
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
   [sandbox environments](../app-sandbox-runtimes/feature.md) for separate test data and dependencies.
   Check actual readiness and useful behavior, persistence/restart, configuration and UI/auth or
   service connectivity as applicable. Ordinary dev mode on the primary installation still does
   not provide disposable data. Preserve diagnostics and unresolved
   incompatibilities rather than reporting success merely because a manifest validates.
5. **Publish when requested.** Hand the verified wrapper and its upstream references to
   [app publication](../app-publication/plan.md) for a versioned release/feed and optional catalog PR.
   Preserve attribution and record applicable upstream redistribution requirements for the chosen
   delivery method. Keep upstream version/digest separate from the Hosty wrapper's version; updating
   upstream needs revalidation. Local readiness, published release and Marketplace listing remain
   distinct outcomes, with publication owned by the existing feature.

For Compose input, inspect the full service graph and translate only supported ports, volumes,
settings/secrets, dependency/readiness behavior and image/build references into reviewed Hosty
contracts. Report unsupported directives and host-specific mounts/network/privilege requirements
explicitly. Do not execute `compose up` as a substitute for Hosty-managed integration, and do not
copy production `.env` secrets into the wrapper. Define the supported Compose subset before Ready.

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

Keep creation operation correlations separate from `manifest.json`. Resolve app/source/workspace
identity and manifest-relative paths from the existing Core records; retain bootstrap/guide revisions
and operation/session references without a second source registry. Preserve canonical local identity
when attaching a remote. These are host-local facts. Reuse `app.0.1`; local creation alone needs
no manifest schema bump. Reserve adapters at concrete boundaries
(project generation, repository provider, catalog submission), not a generic plugin framework.

The agent chooses languages and one or several services from the request and host capabilities;
there is no need to enumerate stacks as templates. Core supplies versioned manifest/API/identity,
ports/storage and lifecycle guidance. Use the TypeScript or .NET SDK where applicable, and the
documented protocol in other ecosystems such as Rust. SDKs are conveniences, not prerequisites for
being a Hosty app. The disposable preview server does not constrain the generated implementation.

## Roadmap And Single Owners

| Order | Feature and owner of implementation work | Independently useful outcome |
| --- | --- | --- |
| 0 | Current workspaces, Harness UI and sandbox lifecycle | Existing-app development provides the foundation for the implemented local creation flow |
| 1a | [Assistant app context](../assistant-app-context/feature.md) | Associate any apps in chat; open a fresh session from an app menu |
| Bounded development permissions | [Assistant approval rules](../assistant-approval-rules/plan.md), consuming [session containment](../assistant-runtime-containment/plan.md) | Explicit source-write and command grants for contextual apps; the execution backend owns enforcement |
| 1b | [Local app creation](../app-prototype-workspaces/feature.md) | Verified local Git → worktree → Docker preview → Accept/Use locally, with optional existing-remote publication |
| 2 | [App development controls](../app-development-controls/plan.md) | Reliably edit an existing app and enter/leave development through typed controls |
| 3 | Integration deliverables in this umbrella | A generated app uses an installed app through its real contract |
| 3 extension | Existing-app adaptation in this umbrella | Turn a compatible repository or image into a verified Hosty wrapper |
| 4 | [App publication](../app-publication/plan.md) | Hosted repository creation where needed, release/feed and catalog PR |

Order 1b is implemented; primary-installation development controls in order 2 retain their own scope.
Typed MCP mutations are not a prerequisite for the manual diagnostic below. Shipped administrator
Autonomous mode remains available. Local creation uses the shared-worker and trusted-child-Core contracts, with existing
grants and lifecycle authority. It does not infer authority from an autonomy toggle or wait for a
stronger per-session containment model. Primary-installation development controls retain their own scope.

### Existing Manual Local-Command Recipe

This diagnostic recipe is not the local creation default and provides no runtime data isolation.
An administrator using an authorized host workflow can ask the assistant to create a minimal app in an explicitly chosen
durable folder outside the gateway's session cache and Core's internal app-state folders. The app
needs a complete valid manifest, a source `localCommand` profile with `development: true`, a runnable
service and an assigned-port-compatible command. Git and a remote repository can be omitted.

The assistant can use its normal file/command approvals to generate the files, then use existing
`hosty apps install <absolute-folder> --runtime dev`, `hosty apps start <id>` and `hosty apps open <id>`.
The operator opens the installed app in Shell and asks for another edit. Use `hosty apps restart <id>`
when the change needs a restart. This is a manual recipe supported by the inspected building blocks,
not a claimed tested wizard. It assumes the required runtime/harness tools exist on that host.
This existing external-folder recipe is only a current-code diagnostic; the new creation UI uses
`apps/<id>/source` and the source-recognition rules recorded in the local creation feature.

For existing apps, inspect source and profiles first; select a declared development profile through
Shell or the CLI plan/digest apply pair. Returning to a reviewed profile preserves source and is not
a discard, save or publish operation. Pinned starts refuse dirty checkouts.

## Interactions With Existing Plans

- [Vision decision 2](../../vision.md) already endorses interactive dev-mode editing on the executing
  installation. It does not provide an isolated copy of app data. Git owns source history; Core data
  backups do not protect source edits. Loss warnings and Git save/push belong to the first slice.
- Owner clarification, 2026-10-10: [workspaces](../assistant-session-workspaces/feature.md),
  [PR lifecycle](../assistant-pr-lifecycle/feature.md) and [Sandbox](../app-sandbox-runtimes/plan.md)
  replace the separate AI Agent Bridge D12 workflow. General scheduled source jobs remain within
  [Durable Agent Jobs](../durable-agent-jobs/plan.md). Their Git and
  disposable-validation prerequisites do not gate a local interactive prototype; Core owns source
  and runtime operations, not model execution.
- [Assistant entry points](../assistant-entry-points/plan.md) owns generic panel and context handoff.
  Reuse it. Third-party app messages still only fill a draft; an operator pressing Create with their
  own prompt is a separate explicit submission. Do not turn `ask-assistant` into auto-send.
- [Assistant app context](../assistant-app-context/feature.md) owns persistent multi-app associations
  and the picker/new-session entry points. An association is conversational context, independent
  of provider grants and the registered repository workspaces selected for development.
- [Assistant approval rules](../assistant-approval-rules/plan.md) owns reusable approval policy.
  Per vision decisions 6 and 32, it owns explicit session grant choices for source writes/project
  commands across selected apps. [Containment](../assistant-runtime-containment/plan.md) owns the
  execution boundary, [execution authorization](../assistant-execution-authorization/plan.md) owns
  Core execution credentials, and development controls owns app/action lifecycle authority.
  Routine authorized work does not require a card for every write. Core-started localCommand code
  remains the administrator's responsibility and is not isolated by the agent container.
- [Core MCP](../core-mcp/feature.md) provides bounded audit search and planned updates. Development controls must
  record their own actions using that audit contract without duplicating the existing machinery.
- [Cross-app dependencies](../cross-app-dependencies/plan.md) owns network reachability changes.
  A dependency URL is not an authorization grant; assistant access to a provider does not grant a
  generated app the same access. Unsupported identity paths remain explicit product constraints.
- [Core extension boundaries](../core-extension-model/feature.md) describe the current seams; new
  contracts belong to their owning feature plans. A template
  marketplace, scale-to-zero runtime and general development environment are not prerequisites.

## Deliverables

- [ ] D1. Approve the cross-feature implementation boundaries for the selected first milestone; keep each
      child gated by its own unresolved decisions rather than approving all later work implicitly.
- [ ] D2. Define integration selection as a concrete authoring flow: provider, interface, intended actor,
      required dependency/configuration, unavailable-provider behavior and a reviewable access diff.
- [ ] D3. Implement one complete integration example using existing discovery/SDK contracts, without
      exposing operator tokens to the generated app or treating app skills as general host authority.
- [ ] D4. Present unavailable capabilities with actionable reasons (missing source/profile/toolchain,
      disabled provider, unsupported authorization), and preserve usable local-only apps.
- [ ] D5. Add repository/image/Compose input and an evidence-backed compatibility assessment to app authoring,
      including explicit unsupported-host and missing-source outcomes.
- [ ] D6. Deliver reusable adaptation guidance and wrapper generation for selected common app shapes;
      record upstream provenance, runtime/configuration/storage needs and integration limitations.
- [ ] D7. Validate a source-based web app, an image-only service and a supported Compose stack through Core, then hand a
      verified wrapper to the existing release/catalog flow without duplicating its implementation.
- [ ] D8. Verify the cross-feature journey across restart and session replacement, including local-only
      operation when no repository or catalog is configured; publish current behavior in `feature.md`
      only when it ships, then remove this plan when its own deliverables are complete.

## Open Questions

1. Which installed provider is the first integration example, and which identity should call it?
3. Which source web app and image-only service form the first adaptation examples, and which
   host OS/architectures must they support?
4. Which Compose directives are supported, and which cross-architecture execution paths can Core verify?
5. How are adaptation skills delivered/versioned for internal and external agents, and what is the
   default wrapper-versus-fork policy when upstream source changes are needed?

## Verification

Children own their component tests. Umbrella acceptance uses one Core-managed prototype: create,
open through Shell, edit, restart Core/gateway, resume in a new session, connect a real provider and
observe both a successful authorized call and a refused unauthorized one. Deleting/expiring a chat
must not delete source. Publication acceptance lives in its own plan and must not gate local use.

Adaptation acceptance additionally covers a service-only image without UI/source, a compatible web
repository, a multi-service Compose input with an unsupported directive, an amd64-only image on
an arm64 host, missing configuration and a failed startup. Check Core artifact-lock provenance. Verify
actual behavior and persistence, correct attribution/version references, no invented Hosty auth
integration and no upstream push or catalog publication implied by requesting an adaptation.

Planning verification: check local links, run `node scripts/docs-index.mjs --check` and
`git diff --check`. Documentation-only work has no artifact version bump.

# App Prototype Workspaces — Create, View, Change

Status: Draft
Created: 2026-09-16
Updated: 2026-09-16

## Goal And Decisions

Deliver the first complete [app-authoring](../app-authoring/plan.md) slice: an administrator describes
an app, opens its running result in Shell, asks for a change and sees the result. The app can contain
one or several services in any language supported by the host's executable runtime environment.
Source and the installed app outlive conversations. Git is optional.

Owner decisions, 2026-09-16:

1. Use the existing `apps/<app-id>/source/` directory for newly created source. No separate
   `HostyApps` root, gateway-owned source library or configurable authoring-root setting.
2. Start with a manifest, plain HTML and a tiny replaceable preview server. No framework scaffold,
   package manager, SDK or language choice imposed on the resulting application.
3. The bootstrap uses an already available runtime. Generated app commands run through the normal
   Core `localCommand` path. Missing executables, SDKs or failed setup are ordinary startup errors
   shown through Core state/logs, regardless of how the app was installed. No toolchain installer
   or language-specific preflight framework belongs to this feature.
4. Git owns source history. Hosty takes no source snapshots, automatic commits or recovery copies.
   Without Git, preserving/recovering edits is the operator's responsibility. Core observes source
   presence and Git state, including uncommitted changes, only when source exists.
5. Preserve the current edit/restart loop: framework hot reload when available; otherwise the
   operator or an authorized assistant uses Core to restart. No automatic restart after each turn.
   Explicit validation can remain available; it is not a gate on editing or opening the app.
6. Autostart defaults to off, with an optional creation-form switch. Initial creation still starts
   the preview immediately; autostart controls subsequent Core/host startup.

The owner also requests general multi-app associations in chat and new-session actions in app menus.
[Assistant app context](../assistant-app-context/feature.md) owns that shared feature and precedes this
one. General source binding and per-app source-write/command grants belong to
[assistant approval rules](../assistant-approval-rules/plan.md), for existing apps as well as prototypes.
This feature consumes both shared capabilities; it does not introduce prototype-only permissions.

Owner clarification: reuse existing source/dev-mode/lifecycle mechanisms wherever they satisfy the
requirements, without forcing new behavior into an unsuitable abstraction. The remaining source work
is internal no-Git source recognition, consuming the shared change observations, warnings before
source loss and a usable Git push flow.
No parallel source-management platform is required.

These product decisions are recorded; the implementation plan remains Draft, with no implementation
started. One branch and one complete feature PR after the shared-context feature.

## Scope And Boundaries

| Included | Behavior |
| --- | --- |
| Browser Shell creation | Admin form, durable creation operation, runnable placeholder and app-bound chat |
| Existing app source storage | Core-owned registration in `apps/<id>/source`, with or without Git |
| Minimal bootstrap | Three files; no application framework or package scaffold |
| Generated service topology | Agent-selected languages/services within the current Core manifest contract |
| Core development guide | Versioned platform contract, SDK capabilities and direct API integration instructions |
| Source status and loss warnings | Source-aware observations and warnings on operations that may discard changes |
| Save to Git | Connect an existing repository, review/commit changes and push through a bound assistant session |
| Continued editing | Same or new session, both adapters, explicit session development grants and Core lifecycle |

Existing-app runtime-switch tools belong to [development controls](../app-development-controls/plan.md).
Cross-app integration belongs to the [epic](../app-authoring/plan.md); hosted repository creation,
release/feed generation and catalog PRs belong to [publication](../app-publication/plan.md).

Do not build a template catalog, editor/terminal UI, native-client creation flow, new Core runtime
kind, toolchain manager or Hosty source-history/export/restore service. The first slice includes a
visible Save to Git/Push entry point backed by the existing assistant's
Git capabilities. It does not wait for release/catalog publication or add arbitrary Core Git command execution. No automatic image publishing or public network exposure is part of creation.

## Baseline Checked In Code

Repository baseline `76da3d7f`; findings are code inspection, not a live generation experiment:

- `CoreDataPaths.ResolveManagedCheckoutPath` already selects `apps/<id>/source`. Uninstall's
  `DeleteSource` flag governs this folder separately from data/runtime-state removal.
- Local external manifest installs can infer source without Git. However, `ResolveInstallLocalSourcePath`
  currently excludes the entire internal app root, and `ResolveLiveSourcePath` recognizes a managed
  checkout through `.git`. Creating a no-Git app in the existing internal source folder therefore
  needs explicit Core support; simply writing there and running today's install command is insufficient.
- `AppSourceService.ResolveManagedAsync` and pinned starts require a repository. No-Git local source
  must not be cloned, fetched or pinned through those paths. `GetAsync` currently returns source
  metadata, not a fresh dirty-worktree result.
- A manifest must contain a runtime profile and at least one service; `localCommand` needs a command.
  A metadata-only manifest is not currently an installable empty app.
- `SessionStore` retains transcript data separately from disposable session work/attachment folders.
  `SessionManager` uses the latter as cwd; it has no validated source-workspace binding today.
- Shell already has a docked assistant panel and a route/session handoff. Newly created sessions
  must be fetched if absent from its initial list, owned by the shared app-context feature.
- Core lifecycle and command failure reporting already exist; Core MCP delegated assistant credentials
  cannot perform lifecycle writes. The approved local CLI path remains available.
- TypeScript and .NET SDKs exist with different capabilities. Protocol guidance currently lives in
  docs and the Hosty app skill; Core has no runtime development-guide tool yet.

## Product Flow

### Create

Apps gains **Create and build** for administrators when the gateway is available. Inputs:

- Title and a suggested editable app id, validated with Core's actual identifier rules.
- Optional description and icon; use a generic icon by default. Accept bounded PNG/WebP/JPEG
  uploads (proposed 2 MiB), decode/validate dimensions/content; no SVG/HTML upload path in v1.
- Required prompt, proposed maximum 16,000 characters. Links are reference material, not authority.
- Optional existing Git repository URL, labelled as a save destination, not an installation feed.
  No credential-bearing URLs, repository creation or visibility selection in this form.
- **Start automatically with Hosty**, off by default.

Show that files are saved on this host. Without Git, no source history is kept by Hosty. Preserve form
input on failure. Request ids prevent duplicate creations when the browser retries. Availability
checks cover Core/gateway, the known bootstrap executable and source allocation; they do not test for
Rust, .NET, npm or any prospective language selected later by the agent.

A provided repository becomes an explicit instruction to connect the created source using Git in the
bound session. It does not cause Core to clone into or overwrite the populated source directory,
write `source.repository` prematurely, commit everything, publish publicly or force-push. A non-empty
remote needs ordinary Git reconciliation. Pushes happen only when the operator requests/authorizes
that action, through normal agent approvals and credentials outside model-visible logs.

### Prepare And Open

Gateway orchestrates a Core-owned source allocation and registration operation, materializes the
known bootstrap in the returned source folder, installs its validated manifest and starts it through
Core. Shell opens the normal app surface beside a new session with `appIds: [id]` and an explicit
source binding. The creation form exposes the shared session development permissions for the new app.
With that grant, direct agent writes are confined to the resolved source roots and dedicated working
directories by the verified permissions feature; parent registry/config/credential files stay outside
the permitted boundary. Further contextual apps become writable only through their own explicit grants.

Explain the accepted runtime boundary at creation: Core executes localCommand code under its own OS
account, outside the assistant sandbox. The administrator is responsible for generated code they launch.
The agent's source restrictions do not isolate the running app or prevent it accessing other host files.
This is vision decision 6, not a claim of runtime containment or a new prompt on every restart.

Show stages: Preparing source → Registering app → Starting preview → Building your app. The preview
is plain informational HTML with public title/id/version and a "being built" message. It is not a
claim that the requested functionality or authentication is implemented. Closing the page does not
cancel the operation. The creation action submits the operator prompt; app-originated ask-assistant
messages keep their existing draft-only behavior.

### Ask For Changes

The agent retrieves the platform guide, reads source, chooses/changes the app's service topology and
edits under the session's explicit development grant, without a card per edit or project command.
This explicitly weakens the former every-write-asks policy within that boundary. No source checkpoint,
automatic commit or hidden backup precedes a
turn. Explicit Git requests use normal Git operations in the same source directory.

Hot reload depends on the generated application's development command. Otherwise the operator uses
Restart, or the agent uses the shared app-scoped lifecycle grant and trusted Core execution path.
Creation starts the initial placeholder; it does not grant a blanket restart after every message.
Refresh preview reloads the browser surface and resolves the current Core URL, not a process restart.

A failed command or turn leaves the actual files intact for repair; Hosty offers logs and another
turn, without promising source rollback. An authorized Git revert/checkout is separate from Core
app-data backup/restore. App health, model turn outcome and optional check results remain distinct.

### Continue Later

An authored app shows **Continue building** and its source/Git status. Reopen the last available bound
session, or create a new one if it was deleted. **New building session** explicitly starts a fresh
conversation on the same source even if an old idle session exists. The general **New assistant
session** action stays available for any app and gives conversational context without silently
changing cwd. Additional apps selected in chat do not become additional source roots.

Deleting/retaining a chat never deletes app source. Reinstalling the gateway discovers bindings from
Core rather than from old chats. If the app/source is missing or source binding changed, report that
condition; do not recreate an empty folder or silently switch a running session to another path.

## Source Ownership And Core Changes

Use the existing layout and resolver, preserving its platform-specific casing:

```text
<Core data root>/apps/<app-id>/
  source/                 # editable manifest and application source, optional .git
  manifest.json           # existing Core-reviewed/internal manifest copy
  state.json              # existing Core installation record
  data/                   # ordinary app runtime data when declared
  ...                     # existing secrets/cache/other Core-owned state
```

Core owns identity allocation, source location and install/lifecycle state. Gateway owns session and
creation orchestration. Add the smallest explicit source-origin distinction needed for a locally
created internal folder without a repository. Reuse existing source-state fields for paths; add a
backward-compatible discriminator if path/repository facts alone cannot distinguish it reliably.
Do not invent a public manifest source type or require a Git repository to hold the folder open.

Compose existing Core source/install services and their per-app locking for creation. Resolve the
canonical source path from Core rather than accepting a browser path. Materialize the fixed bootstrap
only in that app's source folder and use the normal validated/reviewed install mechanism. Make the
narrow adjustments needed to recognize a locally created no-Git folder there. Add a small typed
creation entry point only where existing APIs cannot express that operation safely; do not introduce
a parallel source registry or general reservation/provisioning subsystem. Durable creation retries
belong to the gateway operation journal and existing Core installed/source state.

Update source inference, live-manifest resolution, start/restart and update-source detection together.
Recognize only the registered `source/` subtree as editable source, keeping the internal reviewed
manifest and other app-state files excluded. No broad removal of `IsInternalAppPath` protections.
Preserve external overrides and managed repository installs. A source folder may gain `.git` later;
that alone does not switch its feed/pin or trigger checkout/reset/fetch on restart.

Use per-app operation locking and canonical path validation. Existing non-empty source or installed
id collisions are conflicts, not an overwrite opportunity. Retained source after uninstall is adopted
only by an explicit reinstall/recovery flow. If creation fails, retain the source and operation error;
cleanup is an explicit lifecycle/source-deletion choice, never recursive cleanup by the agent.

Source removal follows the existing Core `DeleteSource` choice for uninstall, including locally
created no-Git source. Do not add parallel gateway delete/forget/export semantics. Session deletion,
cache cleanup and gateway removal do not invoke that choice. Retained source can be reinstalled;
explicitly deleted source is not recoverable through Hosty. Core data backups retain their existing
scope and are not advertised as source backups.

## Source And Git Status

Shared source status, selected-file diff and reviewed Git discard are implemented for existing
apps by [source workflows](../runtime-source-workflows/feature.md). Reuse that contract in newly
authored apps and bound-session UI. Do not duplicate its state probes, Git mutation implementation,
no-Git semantics, scope boundaries or recovery claims. Assistant access still requires its own
verified source grants; app association alone does not authorize these administrator APIs.

A minimal prototype may declare only one `development: true` profile. A clean worktree is not proof
of a pushed commit or backup, and a remote URL is not a published release. Provider-specific
publication remains in its own feature.

## Warnings Before Source Loss

Add source-loss information to the existing lifecycle review/error surfaces. Consult the effective
source state before an operation that actually deletes, resets, replaces or abandons editable source:
uninstall with Delete source, a reviewed source replacement/update, and entering a pinned mode whose
checkout/clean path discards work. Apply this to existing source-backed apps as well as prototypes.
A normal live restart or Docker stop that does not touch source needs no generic loss warning.

- For Git source, name staged/unstaged/untracked/conflicting edits that may be lost and offer the
  Save to Git path. A local commit may protect a reset but not deletion of the repository itself;
  a clean worktree does not prove its commits were pushed. Deleting the only known repository still
  needs the existing explicit source-delete choice with that fact visible.
- For source without Git, say that local files have no Git history and Hosty cannot restore them.
  The operator can keep the source, save it to Git or explicitly proceed. Do not invent a clean
  comparison against an absent commit. If detecting changes since an earlier observation is useful,
  keep only bounded file hashes/metadata, never historical file contents or a recovery archive.
- A failed or stale Git probe is unknown, never clean. Re-read near mutation; existing digest-bound
  plans must account for changed source-loss facts so an earlier clean result is not stale consent.
  For direct lifecycle actions, use the same explicit warning/acknowledgment principle.

The warning is information for the administrator's decision, not a permanent ban on deleting or
replacing their files. Carry it through Shell, CLI and applicable Core mutation paths so an agent
cannot silently sidestep it. Reuse review/confirmation patterns; no new universal approval system,
no automatic stash/commit/snapshot and no warning on every harmless action. Keep app-data backup
prompts distinct: data backups do not save source edits.

## Save Changes To Git In The First Slice

Add **Save to Git** for apps with source in app details and the bound-session source header. Reuse the
same source resolution and existing assistant UI. No source means no Git action. Gateway unavailable
means the assisted action is unavailable; the operator can still use their Git client on the folder.

The action opens/selects a bound session and prepares an explicit Git request. For no Git, allow the
operator to specify an existing remote; for Git, resolve the actual remotes/branch before presenting
a target. The request stays visible for Send/approval; opening the action alone performs no commit
or network write. The assistant uses normal file/command tools and Hosty guidance, not a new Core
endpoint that runs arbitrary Git commands.

The complete workflow is review diff/file selection → initialize/connect Git if requested → commit
chosen changes if requested → push the chosen branch to the chosen remote. Offer **Push commits**
when only uploading existing commits is wanted; explain that pushing does not save uncommitted files.
Before writing, show the files/commit scope and remote/branch. Use real Git results, not model prose,
for outcome/status; refresh Core's source observation afterwards. A failed push leaves the local
commit/source intact and is a retryable remote operation, not a lost edit.

Do not commit secrets/runtime data/caches by default, force-push, rewrite history or clone over the
working source. Handle unborn repositories, missing credentials, non-fast-forward failures, existing
remotes and a non-empty remote through ordinary Git decisions. Credentials use the operator's normal
Git authentication and are not placed in manifests/prompts. No automatic commits or pushes per turn.
Hosted repository creation, releases, feeds and catalog submission remain in the publication plan;
this workflow saves source without changing Core's installed feed or public network exposure.

## Minimal Bootstrap And Generated Application

Bootstrap files: `manifest.json`, `index.html`, `preview.mjs`. The fixed helper serves only HTML and
health; no package install, SDK, business API, directory listing or arbitrary file serving. Public
metadata is escaped; no prompt, environment, raw manifest secrets, paths or launch codes are exposed.

The temporary helper uses the Node executable already running the host-resident gateway. Supply its
verified executable location through the supported creation contract rather than assuming bare
`node` is on Core's PATH; encode the runtime command correctly for the host shell. This introduces
no app-toolchain installation choice. Core still runs a normal `localCommand`, not raw static HTML.
A host without a functioning creation gateway cannot offer this creation flow. After replacement,
Node is not a dependency of a Rust/.NET-only generated app.

Bootstrap manifest: ordinary app (not system), `app.0.1`, version `0.1.0`, one temporary `preview`
service in source `dev` profile, `development: true`, Core-assigned HTTP port and loopback binding.
It has no source repository or required persistent data. No user assignments are created implicitly.
Metadata-only installed apps would need another Core contract; this plan uses the approved runnable
placeholder instead.

The generated app can use several languages/services. It declares its own commands/setup, ports,
service dependencies, health and data targets, with persistent runtime data in Core-provided data
paths. The agent uses an SDK where it fits or implements the protocol directly. No monorepo-relative
imports, globally installed personal skill or mandatory package manager.

Keep id/source stable. Generate files, validate a complete candidate manifest, then adopt its topology
through Core's live-manifest/restart or reviewed update mechanisms. The user/agent initiates the
restart needed to see it. Retain valid manifest bytes until replacement is ready; last-good manifest
handling is not source history. Reconcile obsolete preview processes and re-resolve the UI endpoint.
Delete the helper only after the generated app starts. On failure show the real Core error; do not
promise transactional rollback of source or app data.

Missing `cargo`, `dotnet`, npm or any declared command is handled by the same runtime path as a
manually installed app: attempt the manifest command/setup, record the failure/service/exit result
and logs, and show it in Shell and to the assistant. Test both process-spawn failure and a shell
starting successfully then exiting because its child command was not found. Do not infer a healthy
app from successful shell creation. An agent may diagnose and propose installation as a separate
operator request, not an automatic dependency-management subsystem.

## Core-Owned Development Guide

Package a versioned read-only guide with Core, derived from reviewed contract docs and maintained
Hosty skill references. Gateway supplies workflow/cwd guidance and consumes this host contract;
Core neither chooses frameworks nor executes models. Avoid independently maintained copies of API
facts in gateway prompt strings. Each response names Core version, guide revision and manifest schema.

Topics: manifest/lifecycle; multi-service ports/discovery/storage; identity and Shell embedding;
SDK capabilities; language-neutral Core requests/responses/error handling; optional app MCP and
cross-app integration; stack-appropriate verification and restart guidance.

The SDK map names actual TypeScript package slices and .NET `HostySdk.App` capabilities without
assuming parity. Other languages use documented launch-code exchange, opaque app sessions,
server-only credentials, revalidation and 401/403/unavailable recovery. SDKs are conveniences, not
admission requirements. Framework tutorials remain SDK-linked material, not a Core template catalog.

Proposed readers: `get_app_development_guide(topic)` under Core MCP's existing read grant, plus a
trusted control read and `hosty apps development-guide --topic <topic>` CLI wrapper. All serve the
same bounded topics/index, not arbitrary files. Use MCP when enabled or the normal approved CLI path;
do not toggle providers automatically. Record the guide revision used and refresh when Core changes.
The guide teaches when hot reload suffices and when a Core restart is needed; it does not schedule
restarts. Keep app-authored skills and their trust policy separate from platform instructions.

## Gateway, Sessions And Authority

Implement an authoring orchestration module in gateway. Invoke a narrow local CLI bridge with fixed
verbs and argument arrays for the current reserved/installed app. No browser-supplied arbitrary path
or shell command, and no manual editing of Core state. Use structured results or reconcile against
Core reads, not styled CLI tables. Initial Create authorizes fixed bootstrap creation/install/start;
subsequent agent changes use the shared development grant. The autonomous cycle requires the verified
source/command boundary and app-scoped lifecycle execution from assistant approval rules. The agent
must not receive the orchestration bridge's broad host authority. A declined action cannot be retried
through the orchestrator as a fallback. Core delegated tokens gain no blanket lifecycle authority.

All authoring routes use existing admin authentication/origin checks. Record actor, app, operation
and outcome through durable operation records and the existing app audit reporter; never prompts
or credentials in audit. App reports do not replace Core's separate lifecycle-audit backlog.

Reuse `appIds`, context revision and the permissions feature's Core-resolved `primaryWorkspaceAppId`
and development grants. Authoring workspace/operation references describe creation, not a second
source-binding or permission system. Old sessions keep ordinary cwd behavior. Attachments stay in
session cache. Additional apps can receive explicit grants without silently changing the primary cwd.
Removing an app coordinates grant revocation and binding invalidation through the shared policy.

Native resume/reconfiguration follows the shared binding and grant revision rules. One active writer
per canonical workspace, held while running or awaiting approval/question.
A second session gets `workspace_busy`; explicit takeover waits for cancellation/quiescence first.
For a turn permitted to write several roots, acquire the full writable set in stable order before
dispatch; do not leave additional granted apps outside writer coordination. On restart reconcile
possible orphan writers before releasing ownership. This coordinates sessions,
not all human editors or arbitrary host tools, and creates no source history.

Core source metadata is authoritative. Gateway stores rebuildable associations/operation references,
not a second source registry. Session retention removes only session artifacts; gateway recreation
can bind a new session to a registered app without resurrecting old transcripts.

## API And Creation Recovery

Proposed gateway routes use opaque ids and the existing authenticated `/api` surface:

| Route | Purpose |
| --- | --- |
| `GET /api/authoring/capabilities` | Core creation/guide support, bootstrap capability and input limits |
| `POST /api/authoring/workspaces` | Metadata, prompt, optional Git destination/icon, autostart and request id; return 202 operation references |
| `GET /api/authoring/workspaces` and `/{id}` | Paginated Core-backed source/workspace/app summary |
| `GET /api/authoring/operations/{id}` | Creation stage, error and retry eligibility |
| `POST /api/authoring/operations/{id}/retry` | Reconcile/resume the failed step without duplicating effects |
| `POST /api/authoring/workspaces/{id}/sessions` | Select/create a validated development session |
| `POST /api/authoring/workspaces/{id}/verify` | Optional execution of a separately reviewed project-specific check recipe |

Source-state and dirty-status reads belong to Core's source contract, shared by CLI/Shell/gateway.
Conversation uses existing session message/SSE/approval/cancel/delete routes. Optional icons use
bounded temporary upload handling, not an unrelated chat workspace. No source-history endpoints.

Creation stages: `reserved → materialized → installed → preview_ready → session_bound →
prompt_accepted → complete`. Only completed creation, not completed application generation, is meant
by the final stage. Persist correlation ids atomically and reconcile filesystem/Core/session effects
on retry. Repeated request id/payload returns the same operation; changed payload conflicts. Session
creation is correlated too, so a crash cannot silently allocate a second conversation.

There is no transaction across Core, files and model execution. Ambiguous prompt acceptance after a
crash becomes `submission_unknown`; inspect transcript/native-session evidence and require explicit
retry if unresolved. Do not claim exactly-once execution or silently spend a second model turn.
Never persist delegated bearer tokens for recovery. Browser close does not cancel backend work;
explicit cancellation stops generation, retaining the current source and running app unless a
separate stop was requested.

## Optional Verification And Restart

Keep **Check preview** explicit and separate from restart. It checks Core manifest/topology/health
and, when configured, executes a reviewed per-service build/test recipe. Commands depend on the
project: npm scripts, `dotnet build/test`, `cargo check/test` or other host commands. No implicit
package restore/toolchain install after every edit, and no missing-check gate on continued work.

Prepared recipes name service, contained cwd, executable/arguments, relevant source/script hashes
and timeout. Review actual commands and any required interruption; changed executable content needs
fresh review. A browser invokes a prepared recipe id/digest, not arbitrary shell text. Serialize with
writing turns; respect build-output locking, using separate output or an explicitly requested Core
stop/restart. Record exit results and mark them stale after source/recipe changes.

No recipe means build/tests `not_checked`, not passed. Health and a successful model turn do not prove
functional correctness or identity recovery. Bound output/timeouts and terminate owned command trees
on timeout; proposed defaults are 120 seconds for readiness and 5 minutes per check, overridable in
a reviewed recipe. Ordinary Restart remains available even when no recipe is configured.

## Failure Behavior

| Event | Result |
| --- | --- |
| Existing id/non-empty source or competing install | Conflict; do not overwrite, remove or adopt silently |
| Missing generated-app executable or failing setup | Ordinary Core start failure/logs; source retained for repair |
| Browser closes or gateway restarts | Reattach/reconcile persisted operation/session and Core source binding |
| Chat deleted/expired or gateway removed | App source unchanged; new session remains possible |
| User cancels/declines | Stop/quiesce generation; no hidden alternate execution or rollback |
| App uninstalled with source kept | Source retained for explicit reinstall |
| App uninstalled with Delete source | Source deleted by Core; no Hosty recovery promise |
| Git unavailable/probe fails | Unknown status; no fabricated clean state |
| Source binding moves or disappears | Pause bound editing with repair reason; never substitute an empty folder |
| Validation fails or source changes during checks | Failed/stale result; editing remains available |

## Implementation Phases And Deliverables

- [ ] Add an explicit upstream fetch/status flow with observation time, without automatic pull; decide
      fast-forward updates and branch switching in a later approved extension.

All phases belong to one complete feature PR after the shared app-context feature.

### Phase 1 — Core Source And Bootstrap

- [ ] Extend existing Core source/install handling only as needed for an internal no-Git folder; update
      install, live manifest, start/restart and update-source recognition without exposing app state
      as editable source or breaking existing managed repositories/external overrides.
- [ ] Compose existing install/source locking with idempotent creation handoff, canonical paths,
      partial-operation reconciliation and existing keep/delete-source uninstall semantics.
- [ ] Package the three-file placeholder and verified bootstrap executable binding; prove immediate
      install/start/open with autostart off and no prospective application toolchain requirement.
- [ ] Add source-loss warnings to the relevant existing lifecycle paths, including stale/unknown
      observations, no-Git deletion and dirty pinned starts; preserve explicit operator choice.
- [ ] Package the Core development guide and bounded MCP/control/CLI readers, with SDK map/direct
      protocol examples and app-origin-independent localCommand failure/restart guidance.

### Phase 2 — Creation And Session Orchestration

- [ ] Implement authenticated gateway creation/status/retry and fixed-argument CLI bridge, with
      durable correlations, actor/outcome records and explicit ambiguous-submission handling.
- [ ] Reuse shared app associations, Core-resolved development bindings and verified session grants;
      retain attachments and coordinate writers across all granted roots with cancellation/recovery.
- [ ] Add on-demand guide retrieval and host-authored instructions, correct the stale cwd preamble,
      preserve provider opt-ins and shared development/Git grants, and hand optional Git destination to the
      agent without Core clone/commit/push or source-history behavior.
- [ ] Add the assisted Save to Git/Push flow, covering explicit repository connection, review,
      selected commits, target branch/remote, real push outcomes and source-status refresh.

### Phase 3 — UI And Iteration

- [ ] Add create form, optional icon/Git destination, autostart-off switch, durable progress/errors
      and opening the preview beside the new session through existing panel navigation.
- [ ] Add Continue building/New building session and source/Git observations; reuse the general
      multi-app picker while keeping primary source target explicit.
- [ ] Adopt generated multi-service topology through Core, cleanup obsolete preview services and
      preserve manual/agent-triggered restart. No per-turn automatic restart.
- [ ] Keep Check preview optional, with reviewed stack-specific recipes, real command results,
      unknown/stale status and honest build/restart effects; support repair of an app that cannot start.

### Phase 4 — Verify And Document

- [ ] Test source recognition, duplicate/crash boundaries, access/path guards, retention,
      uninstall source choices, writer recovery, non-mutating Git observations, loss warnings,
      assisted Git success/failure and ordinary runtime failures.
- [ ] Run the live script below on both real harnesses; fake tests supplement but do not replace it.
- [ ] Build/test changed Core/CLI, gateway and Shell; apply platform/gateway/Shell minor version bumps
      with their required source-of-truth consistency. SDK bumps only if SDK implementation changes.
- [ ] Write current feature documentation, update source/assistant/guide docs and epic links, remove
      the completed plan and regenerate the index. No schemaVersion bump for ordinary additive work.

## Acceptance Script

1. Create a notes app without Git, remote or chosen language. Confirm files are under the actual
   `apps/<id>/source`, no independent source root exists, and preview opens through Core/Shell.
   Initial start succeeds although autostart is off. Core restart leaves it stopped until Start;
   repeat with the switch on and verify normal autostart.
2. Observe platform-guide retrieval, approvals and generation. Ask for search and an empty state.
   Use hot reload where supplied; otherwise explicitly restart through Core. Runtime data survives.
3. Delete/expire the chat, recreate gateway, then continue in a new bound session on the same source.
   No source-history/snapshot files or automatic Git repository/commits were created.
4. Initialize Git via an explicit operator/agent action. Observe an unborn repository, staged,
   unstaged/untracked changes and a clean tree after an authorized commit. Core status reads change
   no source/history and never fetch/push; clean does not imply uploaded. Test Git absent/error too.
5. Provide an existing Git destination, then use Save to Git to review/commit/push a change to an
   authorized test repository. Push existing commits separately; uncommitted files remain uncommitted.
   Exercise credential and non-fast-forward failures: source/local commits remain, outcomes are
   truthful, no force-push or unsolicited network write occurs and status refreshes correctly.
6. Configure a missing executable through a generated app's localCommand and through a normally
   installed app. Both show Core startup failure/service output. Repair the environment/command and
   explicitly retry; do not add a prototype-only language installer or preflight refusal.
7. Crash at creation boundaries and repeat request ids. No duplicate app/folder/session/model turn
   is silently created. Resolve an ambiguous dispatch explicitly. Two writing sessions cannot run
   simultaneously after cancellation or gateway restart.
8. Uninstall once keeping source and reinstall; use Delete source on another app after its loss
   warning. Test dirty pinned-source transitions and changes appearing after a reviewed clean state.
   No-Git and unknown-status cases never promise recoverability. Ordinary non-destructive live
   restart adds no source-loss warning. An explicit informed delete still works.
9. Replace the placeholder with .NET backend plus Node UI; verify appropriate SDKs, service discovery,
   health/identity through Shell, explicit restart and no orphan preview process. Also generate a
   small Rust app using direct Core protocol on a provisioned host and test identity/recovery.
10. Repeat edit/approval/resume with the other harness, MCP-disabled guide retrieval through CLI,
    manual Restart without a check recipe, and source/recipe changes invalidating optional checks.

Implementation verification: Core/CLI tests/builds; gateway tests/lint/web build; Shell tests/lint/build;
bootstrap and generated-project checks appropriate to their stacks; version consistency, docs-index
and diff checks. Report unavailable live checks honestly. Never start a second Core on the same host.

## Approval Gate

The product direction is accepted, including general per-app development grants and administrator
responsibility for localCommand execution. Before implementation approval, assistant approval rules
must record the both-harness baseline and enforcement experiment and resolve its technical questions.
This plan remains Draft; no live containment or autonomous create/edit/build result is claimed here.

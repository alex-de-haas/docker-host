---
status: Draft
created: 2026-11-05
updated: 2026-11-12
summary: Review app.0.2 around package execution, simple native setup/command and one Git-workspace development workflow while retaining Docker tags and optional feeds.
---

# Manifest app.0.2 And Workspace Execution

## Direction And Approval Boundary

This replaces the blanket app.0.1 functional-parity proposal requested on 2026-11-05. On
2026-11-07 the owner asked to review legacy runtime/source behavior against the current platform,
retain useful capabilities without duplicate development paths, and avoid rushing the contract.
Keeping every historical authoring mechanism is no longer the acceptance invariant.

Settled owner requirements:

- Docker tags remain supported alongside explicit digests. A plain container wrapper must not
  require Hosty's publisher, Marketplace, feeds or a hosted repository.
- Native production may consume either delivered artifacts or source built on the installation
  host. Do not require publishers to host binaries for every platform.
- Source-delivered production uses a release build and then runs its prepared result. Normal
  subsequent starts reuse that result; updating relevant inputs requires a new preparation.
- Managed development should have one coherent Git/workspace workflow, including local Git with
  no remote, newly created apps, and repositories containing only a manifest and configuration.
- Agent tooling, diagnostics and recovery are part of the design, not a later UI-only adaptation.

Owner decision on 2026-11-09: keep native execution deliberately small. Docker is the preferred
application delivery path; Harness Local is the main motivating native case, not an app-ID exception
in Core. Preserve generic native support and existing native consumers. Retain optional `setup`
and the service `command`; application code owns preparation, output location and build reuse.
This supersedes the proposed Core-owned build/run engine, declared build outputs and toolchain cache.

Do not add SDK/toolchain declarations, package installers, build providers or automatic toolchain
environments to Core as part of this plan. Existing child-Core test environments remain supported.
An agent checks the project's documented prerequisites and prepares the intended development host within its existing authority, or gives the operator
concrete installation instructions. This decision does not itself authorize host changes or SSH access.
The owner still favors one development recipe per app; cardinality exceptions, compatibility mapping
and legacy retirement remain open. These scoped decisions do not approve the whole plan as Ready.

This remains a planning-only Draft. No implementation, commits, source migration, publication,
installation changes or development-mode switches are authorized by this document. Existing app.0.1
installations and already published app.0.2 releases must remain readable and recoverable. Review
legacy authoring separately from removal of readers, stored state or recovery operations.

## Evidence And Current Boundaries

The following bounded code/document snapshot was reviewed on 2026-11-07 at main commit
`53becd6165adda8ea96b8b9f5c802566faab50bd`. The local guide observed that day reported Core
0.177.0 and taught app.0.1. For Draft publication on 2026-11-09, the planning branch was updated to
`44cef7715fe2796c4f472b8eaa629d6d7cb89629`; related documentation links and the generated index were
rechecked. Revalidate implementation assumptions against current main before starting D1/D8.
This planning review is not runtime acceptance or approval to implement the proposed contract.

- `RuntimeAppManifest.cs` still restricts app.0.2 Docker images to repository/digest objects and
  requires an immutable source commit for non-development localCommand profiles. All nine authored
  runtime-app manifests in the repository remain app.0.1.
- `AppDevelopmentManifest.cs` accepts supported cross-schema workspace/package pairs. Current
  [development controls](../app-development-controls/feature.md) already separate installed package
  metadata from admitted workspace execution and retain native, Docker and mixed recipes.
- A development profile currently needs at least one source service. That restriction does not
  describe a manifest-only wrapper's editable repository or its useful sandbox test correctly.
- [Local app creation](../app-prototype-workspaces/feature.md) already creates canonical local Git,
  a registered worktree and a stopped bootstrap app without a remote. Accept locally, Use locally,
  remote publication and child Core preview are distinct existing actions.
- Current source override and legacy dev-mode/runtime-switch APIs remain supported. Their migration
  assessment is owned by [Development Controls D1](../app-development-controls/plan.md#deliverables).
  The broader [source recovery proposal](../runtime-source-workflows/plan.md) remains On Hold.
- `LocalCommandRuntimeAdapter` runs setup on ordinary starts unless preparation for that operation
  already covered the service. This is not a durable platform-wide build cache across restarts.
- Harness Local already implements its own input/platform fingerprint, isolated compiled output,
  output verification and warm reuse. OPUS declares dependency installation and compilation in
  setup. These are different app-level preparation
  contracts, not evidence that generic localCommand guarantees one build per update.
- Core/CLI already publish prebuilt native packages through their separate platform release model.
  Runtime apps support immutable local-folder prebuilt delivery. Downloadable URL/Git-release
  delivery remains owned by [Runtime Artifact Extensions](../runtime-artifact-model/plan.md).

Numeric schema versions in storage, app-feeds.0.1, app-release.0.1 and Core/CLI feed schemas are
separate contracts. Do not mass-replace them when changing app manifest authoring.

## Proposed Model

### Keep Independent Decisions Independent

| Decision | Meaning |
| --- | --- |
| Execution mechanism | A service runs in Docker or as a supervised native process. A graph can contain both. Native does not imply development. |
| Execution target | The installed package or an explicitly selected registered workspace supplies the admitted manifest and executable inputs. |
| Artifact preparation | Pull an image, materialize a delivered native artifact, or build immutable source into a native result. This is not another development mode. |
| Update binding | An optional feed, direct manifest reference or supported local delivery determines candidate updates. It does not select an editable workspace. |
| Authoring source | An optional Git repository contains the app definition and any implementation/configuration. It may be local, private, remote or manifest-only. |

A manifest describes application identity, services, endpoints, settings, data, dependencies and
execution recipes. Core stores installation selections, artifact locks, workspace bindings,
operations and existing lifecycle receipts. Application scripts own native build-cache state and
receipts; no generic build receipt is added. Do not embed machine-specific workspace paths, build cache
state or operator overrides into a distributable manifest.

Retain shared service/topology declarations where possible. A development recipe may change the
service implementations without duplicating settings, identity and data contracts in a second
complete manifest. Keep permissions and topology changes subject to current workspace admission.
Exact JSON layout needs D8 review; illustrative terms here are not implemented schema fields.

### Native Production: Application-Owned Preparation

Retain the existing small `localCommand` contract: an optional, repeatable `setup` followed by a
long-running `command`. Core provides the working directory and environment, waits for setup,
reports exit/errors and logs, supervises the process and checks runtime readiness. It does not
interpret the compiler, select a language SDK, discover build output or decide build-cache validity.

- Delivered ready artifacts and interpreted programs can use `command` without a no-op setup.
- Source-delivered production resolves the reviewed source revision. The application-owned setup
  performs any required release preparation and decides whether an existing result can be reused;
  the launch command uses the application's known output path. Workspace edits stay separate.
- Keep existing setup semantics and service dependency ordering. Shared preparation can follow the
  existing Harness pattern instead of introducing a generic build graph or another manifest hook.
- Authors may put preparation in a self-preparing launcher; Core then observes a single startup
  process. Recommend separate setup where useful for diagnostics and reuse, without pretending
  that command strings can be inspected to prove that they never compile or download dependencies.
- Preserve existing lifecycle, update failure and source/artifact integrity behavior. Setup success
  alone does not prove the service is ready. No new before-stop native-build transaction, generic
  output validator, platform cache manager or automatic rollback is introduced by this plan.

Harness is a reference for application-owned caching, not a mandatory implementation. Its current
local recipe uses `setup: node scripts/local-runtime.mjs prepare` and separate `start worker` /
`start api` commands. Prepare fingerprints selected files plus Node/OS/architecture, builds a separate
generation when necessary and reuses a complete matching generation; start requires that prepared
result. These are application-level decisions. Preserve its cold/warm-start behavior when migrating
manifest syntax, without moving those mechanisms into Core or requiring every native app to copy them.

Development and native production prerequisites belong in application/repository documentation and
useful startup diagnostics. The agent checks the actual execution host (not merely its own container),
uses existing compatible tools where suitable, installs missing tools only within granted authority,
or provides version-specific operator instructions for that host. Core need not enumerate supported
languages or gain an SDK installer to support this workflow. Missing tools remain a clear preparation
or startup failure; they do not trigger an implicit privileged installer.

This scope does not claim that an ordinary native process is isolated from its host. Existing
permissions still apply; no new native sandbox or package-approval subsystem is introduced. Broader
native delivery remains with its existing feature owner. A reviewed source commit still does not
make arbitrary unpinned dependency downloads reproducible.

### One Workspace Development Journey

The preferred journey is repository or local creation -> registered worktree -> edit -> validate
and preview in a child Core -> review/commit -> local acceptance or publication. An explicitly
requested ordinary-data trial selects that workspace through the same execution service, then
returns to the installed package. Preview and ordinary-data use differ in environment/authority,
not in the application recipe or source-selection model.

Propose one logical development recipe per app: one service graph with Docker, native or mixed
implementations as required by the application. A recipe describes how to run editable implementation
from the selected workspace, including its build/watch behavior and source/cache bindings. It is
not an installable production alternative named dev in every runtime dropdown.

One workflow does not necessarily justify banning every platform-specific recipe. Audit actual
Windows/macOS/Linux requirements, native-only hardware workloads and multiple current profiles.
Prefer a single unambiguous default; allow variations only for demonstrated needs, with one common
selection/lifecycle contract. Do not invent a generic variant framework in advance.

Source availability permits editing; it does not prove that executable source or a supported source
launch recipe exists. These facts must be discoverable separately:

- A manifest-only repository can be edited and its changed image/settings/dependency declarations
  tested using its package execution recipe in a child Core. No fake source service, watcher or
  duplicate dev recipe is necessary. New image/tag resolution remains reviewed and locked.
- A repository with implementation but no development recipe can be edited. Tools must report
  that source execution is unavailable rather than quietly running an old published image and
  claiming to test the edited code. Manifest-only preview must be labelled accordingly.
- A multi-service workspace may combine locally edited services and unchanged third-party images.
  A shared monorepo worktree can bind several apps; another repository remains another worktree.
- A repository declaration is not automatic access to private source or permission to run it.

Source override should stop being a second preferred development workflow. Proposed replacement:
review/register an existing local repository or copy/import an external folder into local Git, then
use ordinary workspace controls. Preserve existing files, dirty state, ownership and update bindings.
Never silently git-init, move, reset or commit the user's folder. A remote is optional; an initial
commit for worktree creation is an explicit creation/import consequence, not implicit authoring consent.

Existing override readers and original operation recovery stay during migration. Removing new
legacy entry points, converting non-Git users and deciding unsupported cases needs the separate
Development Controls D1 assessment/approval. This Draft authorizes assessment, not retirement.

### Installation, New Apps And Manifest-Only Wrappers

| Scenario | Intended behavior |
| --- | --- |
| One JSON wrapping an image such as MongoDB | Install from file/URL with tag or digest; no Git, feed, marketplace or development recipe required. |
| Wrapper repository containing manifest/configuration | Register Git workspace, edit definition, validate and preview the image recipe; no MongoDB source checkout required. |
| New app, no remote and no release | Create local Git and a registered worktree; develop/preview before any remote publication. No hosted-repository requirement. |
| Existing external Git repository | Review/register source access and prepare a workspace without replacing the original checkout. |
| Existing folder without Git | Direct installation remains independent; managed development offers explicit import/copy/adoption with preservation and commit review. |
| Docker or native production app | Use the selected package and its exact artifacts/prepared native result independently of authoring source availability. |
| Source-delivered native package | Resolve a reviewed revision, build/reuse prepared output and run it; edits in a development workspace do not affect production. |
| Docker-source, native or mixed development | Use the same workspace lifecycle and an explicit source recipe; native/system workloads are not forced into Docker. |
| Several apps/dependencies under test | Bind worktrees and install dependencies in the same separate child Core; do not borrow production services/data implicitly. |
| Private/offline source, moved refs, missing artifacts | Preserve current selections and surface precise preparation/access failures; never choose another source silently. |

A new app does not have to pretend that a published release exists. Preserve current local acceptance
and optional Use locally; decide how an accepted local commit becomes a prepared package baseline
when there is no production recipe yet. Workspace-only execution must not invent a Return target.
The minimum first prototype may remain stopped in the parent and run only in its child preview.
This lifecycle decision must be resolved before changing the existing bootstrap, not left to agents.

Docker tag updates retain exact reviewed digest locks, including same-version/tag changes. Ordinary
Start runs the locked identity; an explicit update check may resolve a new candidate. Invalid digests,
missing/malformed registry manifests and unsupported platforms do not become successful updates.
App version, manifest schema, source revision and artifact identity remain separate values.

### Agent And Operator Tools

Reuse the current Core-owned operations behind Shell, CLI, Harness and direct MCP. Existing
`app_create`, `prepare_workspace`, `configure_workspace_runtime`, environment lifecycle, execution
selection, local acceptance and publication are starting points, not claims that every proposed
journey is already exposed. Audit adapter parity and missing import/manifest-only capabilities.

A bounded discovery/plan response should provide authorized source/workspace references, package
and development capabilities, selected recipe, supported next actions and application-provided
prerequisite documentation/diagnostics. No universal SDK discovery or prerequisite schema is needed.
Distinguish editable definition, executable source, running process and healthy/ready service;
application-specific build readiness is not a new generic Core state. Avoid app-id inference.

Retain durable original request IDs and diagnostics for existing source/artifact preparation,
setup, start, status, logs and retry operations. Build output and repair instructions come from the
application-owned setup/launcher; do not add generic build/rebuild tools or infer a compiler phase.
Use the supported lifecycle retry after prerequisites are prepared. Agents must not edit Core's
private records, guess owned paths or grant themselves authority to recover. Development tooling
installation uses the agent's ordinary authorized host tools or operator instructions; it does not
replace typed Hosty lifecycle operations with a broad shell escape or generic CLI bridge.

Use the same recipe resolution for sandbox and ordinary execution, while keeping permissions,
users, data, dependencies and cleanup separate. Source authority is not lifecycle authority.
Coarse convenience tools may compose existing operations with retained receipts; they must not
create another state machine or silently switch from sandbox to production.

## Legacy Audit And Ownership

| Existing concept | Proposed disposition / decision owner |
| --- | --- |
| Docker tags/digests and direct manifest installation | Retain; this manifest plan removes schema-based restrictions without weakening reviewed identity. |
| Native production from source and prebuilt folders | Retain optional setup plus command, with application-owned build/output/cache behavior; new download protocols stay in Runtime Artifact Extensions. |
| Core-owned native build engine and SDK/toolchain installation | Exclude from this plan per the 2026-11-09 owner decision; development prerequisites are prepared by the authorized agent or operator. |
| localCommand meaning development | Reject that conflation; native is an execution mechanism in both package and workspace targets. |
| Arbitrary dev profile names and several development profiles | Normalize into workspace recipes; audit necessary variations before restricting authoring. |
| Editable definition with no source service | Support through existing package recipe preview; do not manufacture a source runtime. |
| Source override / inferred local folder / legacy dev-mode APIs | Assessment and staged retirement remain owned by Development Controls D1; coordinate this manifest contract, preserve recovery readers. |
| Package/workspace selector and scoped workspace admission | Reuse; retain current data, update bindings and package identity across ordinary execution changes. |
| Optional feeds and ready-release publication | Retain independently of manifest syntax and development. |
| Cross-schema workspace use/return | Retain; schema equality is not app identity or authority. |
| Old storage fields / request receipts / immutable published releases | Preserve compatibility and exact recovery; not a mass schema migration. |

The old [source-workflow plan](../runtime-source-workflows/plan.md) remains On Hold; do not revive
its Standard/Custom UI as a competing new model. The [artifact extension plan](../runtime-artifact-model/plan.md)
owns new native download delivery, per-runtime updates and broader artifact-lock extensions.
Existing [mixed-runtime acceptance](../mixed-development-runtimes/plan.md) owns its unfinished host
coverage. This plan must coordinate these owners, not duplicate their deliverables or mark them done.
General Core version ranges and post-startup data rollback remain in
[update recovery](../runtime-app-update-recovery/plan.md). Core/CLI package schemas stay independent.

## Compatibility And Rollout

First decide normalized semantics and the smallest authoring change. The runtime already consumes
published app.0.2 manifests with runtimeProfiles/services; preserve them byte-for-byte and map them
into the internal model. New syntax must not silently reinterpret old app.0.2 recipes. If old/new
spellings coexist, reject ambiguous combinations instead of defining hidden precedence. If the
approved semantics cannot coexist safely, explicitly reconsider the schema boundary before editing
public manifests. Do not assume the number 0.2 permits breaking its already published contract.

General admission accepts tag-based app.0.2. Callers requiring ready releases invoke a separate
semantic validator for declared production recipes, immutable source/artifact identities, profile
coverage and artifact correspondence. A source delivery can be ready for preparation without a
native build having run on every consumer. Registry availability and local host readiness remain
separate checks. Feed names or publisher/app identity are not readiness evidence.

Publish compatible readers and explicit release validation before migrating authored manifests,
templates, packaged guides and client tools. Existing app.0.1 installations keep running and update
through normal review; no silent feed selection or installed-state rewrite. The one-PR repository
rule conflicts with reader-first public-manifest cutover: approve a bounded two-step exception or
explicitly accept/document the old-reader break. New reader availability is not proof that every
consumer of a mutable main URL upgraded. Keep this open until an owner decision.

## Deliverables

D1-D7 retain their IDs and areas from the earlier proposal; their blanket-parity wording is replaced
by the owner's 2026-11-07 review direction and 2026-11-09 native-runtime simplification. D8 is the
added design-decision gate. No implementation is complete and no deliverable is checked by planning.

- [ ] D1. Complete the legacy and scenario audit against current code, first-party/independent apps and actual source consumers; classify retained capabilities, normalized concepts, migration candidates and exclusions, linking each cross-feature item to its owner.
- [ ] D2. Implement the approved general app.0.2 admission and preserve the simple native contract: Docker tags/digests, optional setup plus command, source/prebuilt/interpreted cases and strict malformed-input handling, retaining old schema readers and existing application-owned preparation behavior without a Core build engine or SDK installer.
- [ ] D3. Align install/update/runtime and artifact-lock paths with the approved package/source/preparation model; preserve exact reviewed identities, same-tag updates, private access, current data and original-request recovery without forcing feeds.
- [ ] D4. Separate explicit ready-release validation from ordinary schema admission in publisher and Core migration guards; verify complete production inputs, old immutable release compatibility, digest reuse and promotion.
- [ ] D5. Align manifest workspace recipes and Core/CLI/Shell/Harness/MCP discovery, preview, preparation and recovery around the approved single workflow, including manifest-only/local-Git cases; coordinate override retirement through Development Controls D1 rather than duplicate it.
- [ ] D6. Complete the approved reader-first authoring/template/guide rollout, map existing profiles and source consumers without silent lifecycle/data changes, retain immutable releases and legacy recovery, and document independent-repository migration and minimum readers.
- [ ] D7. Complete differential/contract and managed-runtime acceptance for the retained scenario matrix, including cold/warm/missing-output native starts; run affected checks, update reality documents/version artifacts, remove this plan only after all deliverables pass and regenerate the index.
- [ ] D8. Resolve the remaining architecture and rollout decisions, freeze concrete schema examples and legacy mappings with the owner, assign cross-feature dependencies and approve a Ready implementation scope before coding.

## Open Decisions Before Ready

- Workspace authoring: one logical default recipe, which demonstrated platform alternatives remain,
  and how manifest-only preview is selected without a duplicate development runtime.
- New local app baseline: preserve Accept locally / Use locally and define the no-release Return
  behavior without running mutable canonical source as an accidental production package.
- Source import/legacy retirement: review private/local/no-Git/system workflows under Development
  Controls D1; choose an explicit non-destructive transition and compatibility window.
- Public syntax compatibility and reader-first rollout: select field mapping, ambiguity rejection,
  minimum reader and publication boundary before authored manifests change.

## Verification

Planning-only changes require documentation/link/index checks and diff inspection. They do not
need a runtime deployment. The following are future implementation acceptance, not completed tests:

- Parameterized legacy/app.0.2 parser and normalized-model fixtures, old immutable releases,
  Docker tags and invalid digests, malformed recipes, unselected profiles and dependency cycles.
- Direct file/folder/URL installs without Git/feeds, a manifest-only MongoDB-style wrapper, a new
  local-Git app with no remote, a private repository, monorepo bindings and explicit no-Git import.
- Docker, native and mixed workspace execution, native-only system/device cases, scoped authority,
  dirty source preservation, package Return and old original-operation recovery.
- Native fixtures with command only and with setup plus command; setup ordering, failure logs,
  missing executable diagnostics and supported retry. Preserve OPUS and third-party native
  contracts; the focus on Harness does not remove or silently convert other installations.
- Harness app-level regression for cold preparation, warm reuse and its existing missing-output
  recovery; verify a third-party native app needs no special identity, build hook or SDK declaration.
  Cache/invalidation correctness remains owned and tested by the application, not a generic Core engine.
- Verify production source/output stays separate from editable workspaces, setup success is not
  reported as runtime readiness, and neither native start nor workspace creation installs host SDKs
  implicitly. Agent/operator setup instructions identify the intended host and documented versions.
- Controlled moved tags/refs, unavailable registries, invalid manifests/platforms and failed builds;
  verify processes, data and reviewed locks rather than only response status.
- Core/CLI unit and integration tests, relevant Shell/Harness tests/builds and NativeAOT; publisher
  model/validator tests; managed child-Core activation, native and manifest-only preview through
  normal password identity with separate users/data/dependencies and verified Finish cleanup.
- Verify every selected host platform explicitly and report untested platforms. Update packaged
  guide/tool examples together; do not claim Docker-only acceptance proves native operation.
- Run docs-index --fix and --check --base <integration-base>, version checks when implementation
  ships, and git diff --check. Planning changes have no artifact or schema version bump.

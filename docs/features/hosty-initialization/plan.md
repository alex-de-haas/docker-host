---
status: In Progress
created: 2026-10-21
updated: 2026-10-21
summary: First-run hosty init installs Core, selects distribution apps, assigns automatic ports and opens administrator setup; Dashboard environments reuse the initialization services.
components: [apps/core, apps/cli, apps/shell, packages/app-sdk, scripts]
---

# Hosty Initialization And Environment Creation

## Goal And Owner Direction

Make the public installation journey short enough for a new user to follow from the README:
run the installer, run `hosty init`, select applications, and create the first administrator in
the browser after the selected applications are ready. The owner requested this plan on
2026-10-21 in preparation for people installing Hosty after the upcoming demonstration.

The owner clarified two separate entry points:

- `hosty init` initializes the primary installation in place. Repeating it never allocates a
  second Core, data root or instance identity. Existing explicit data-root targeting remains
  supported for authorized administration and testing; init never invents another target.
- Dashboard **Create environment** allocates a new parent-managed child Core and then initializes
  that child. It can reuse initialization code, but it is not another spelling of `hosty init`.

The install script continues to install the CLI only. `hosty init` installs Core if missing,
before presenting the application selection. An existing Core binary is reused; upgrades remain
the responsibility of `hosty update`. Registration collects administrator credentials on the
new Core's ordinary browser page, not in the CLI or the parent's Dashboard.

The owner explicitly approved this plan and implementation in chat on 2026-10-21. The plan
was promoted to Ready before implementation. No `feature.md` is created until behavior ships.

## Current Behavior And Integration Ownership

Baseline: repository `main` at `6ec694fc281e2c61df1d5b5f91748e4eb5dd0c48`.

| Existing behavior | Change owned by this plan |
| --- | --- |
| [CLI bootstrap](../cli-bootstrap/feature.md): installer downloads CLI; first Start downloads Core and boots it | Download missing Core during init; gate an uninitialized installed-root Start and make installer guidance lead to init |
| [Distribution catalog](../removable-system-apps/feature.md): first boot seeds defaults; setup manages actual installed entries | Select initial entries before any automatic installation and execute a resumable selected-app initialization |
| [Automatic app ports](../automatic-runtime-app-ports/feature.md): persistent app allocations; Shell manifest still pins 7171; Core falls back to 7070 | Automatically assign and persist fresh Core/Shell ports, preserving existing assignments and explicit overrides |
| [Password login](../local-password-login/feature.md): ordinary setup-token, bootstrap, login and recovery | Reuse that authentication flow with a ready-to-open setup link and no pre-created administrator |
| [Child environments](../app-sandbox-runtimes/feature.md): separate users/data, allocated Core port, empty distribution catalog and managed lifecycle | Add explicit initial-app selection and initialization observation to the existing child manager |
| Dashboard shows existing sandboxes and hides an empty inventory; child account connection enables its app inventory | Keep a creation entry point visible when empty and offer setup/open without requiring a parent-held child login |

This feature owns the first-install journey and its Dashboard integration, including their tests.
It reuses the existing lifecycle, catalog, authentication, local-origin and child-environment services.
The [remaining port plan](../automatic-runtime-app-ports/plan.md) retains its update/runtime-switch,
UDP, bind-scope and general reassignment work; those deliverables are neither copied nor silently
approved here. [Sandbox acceptance](../app-sandbox-runtimes/plan.md) retains its wider host/recipe
matrix and optional remote preview. [Delivery readiness](../hosty-delivery-readiness/plan.md) links
this first-install outcome without duplicating its implementation checklist.

## Primary Installation Journey

1. The Unix or PowerShell installer verifies and installs CLI, configures PATH and prints the exact
   next command, `hosty init`. Keep the current-terminal/new-terminal guidance accurate. It does
   not start Core, install applications or create an administrator by default.
2. Init resolves the existing target data root, acquires its operation lock and installs the
   platform Core artifact only if absent, using the existing verified download mechanism. A failed
   download leaves a retryable installation, never a partially replaced executable or another root.
3. Load the target Core's distribution catalog and present titles, purpose descriptions and
   checkboxes. Core is mandatory. Shell and Marketplace are preselected and labeled Recommended;
   Harness and Telemetry are optional. The catalog supplies the available entries rather than
   duplicated lists in CLI and Shell. Show future distribution entries through the same contract.
4. The normal flow uses automatic ports. Show the selected applications and an installation
   summary for confirmation. Manual ports belong to an optional advanced path or explicit scripted
   inputs; answering port questions is not required for the default journey.
5. Persist the selection and port choices, run the selected installations and start their services.
   Show actual progress and actionable per-app failure reasons. Successful installation alone is
   not readiness: wait for the declared runtime/HTTP readiness of every selected application.
6. Only after readiness, issue a fresh ordinary setup token, print its full setup URL and attempt
   to open the browser when supported. Browser-open failure leaves the printed link usable. The
   user enters email, display name and password on Core, creates the administrator and proceeds to
   Shell if installed. Later access uses normal password login.

Shell remains optional in the approved contract. Deselecting it shows an inline explanation that
management uses CLI/API and that `hosty setup` can add Shell later. The Core setup completion page
must offer truthful completion and recovery guidance rather than a broken Shell redirect. Core-only
installation is valid. Do not make application provider credentials part of this wizard: for
example, a healthy Harness may still need its ordinary provider configuration after login.

Check prerequisites for the selected runtime profiles before installing their applications,
especially a reachable Docker engine for the standard Docker profiles. Report a missing prerequisite
at the stage that needs it, preserve completed work and allow resume. Do not copy provider or Docker
registry credentials from the parent merely to make child initialization succeed.

## Command And State Contract

| Command or state | Expected behavior |
| --- | --- |
| `hosty init`, genuinely fresh root | Install missing Core, collect choices, initialize this root and offer first-administrator setup |
| `hosty init`, interrupted initialization | Resume saved choices and incomplete stages in the same root; inspect actual outcomes before retry |
| `hosty init`, applications ready but first setup unfinished | Reuse the installation and offer a fresh setup link; do not install another Core or reset data |
| `hosty init`, already initialized | Report the existing installation and open URL; point to setup for app changes, without reinstalling or changing accounts |
| `hosty setup` | Keep the existing distribution-app management command and its explicit install/remove behavior; it does not restart first-administrator registration |
| `hosty start` / `hosty core start`, new uninitialized installed root | Exit unsuccessfully with `Hosty is not initialized. Run hosty init.` before launch or automatic app seeding |
| Start or restart, established installation | Use its persisted configuration and ordinary lifecycle; never rerun initial selection |
| Existing users or credentials with an access problem | Offer the existing explicit recovery path; never classify account loss as a fresh installation |

Keep both init and setup in this proposal. The first-use README needs only init; existing scripts
and operators retain setup for changing distribution apps. Preserve its current noninteractive
forms and data-retention semantics. Repeated init is neither an uninstall nor a repair that
silently overwrites application settings.

Initialization progress and administrator registration are separate facts. Persist configuration,
accepted application selection, resolved install inputs, installation/start outcomes and errors.
Observe administrator existence from Core's authoritative authentication state. A printed link is
not completed registration, and a missing browser response is not proof that registration failed.
The process must be resumable even if the CLI exits while the browser remains open.

Existing installations without a new initialization marker must be recognized from their durable
installation history and adopted without changing ports, users, keys, apps or data. A malformed
marker must produce a recoverable diagnostic, not permission to initialize over existing state.
Preserve existing explicit source/native launch workflows. Route fresh supported development and
test roots through explicit initialization inputs; do not add an authentication bypass or broadly
remove localCommand support. Managed children need their own explicit initialization intent so
the installed-root Start guard does not prevent the manager from creating them.

## Shared Initialization Services

Core owns catalog resolution, validation, application lifecycle, readiness and setup-token issuance.
CLI owns interactive prompts and installing a missing Core executable. The parent owns child
allocation and lifecycle. Shell owns the creation dialog and progress presentation. Both entry
points use the same versioned initialization request/status contract after selecting their target;
the Dashboard must not shell out to an interactive CLI or maintain another app installer.

Provide an initialization-only startup/control path to read the installed Core's catalog before
app selection, with ordinary local control authority and automatic seeding suppressed. It may start
the Core process as part of init, but must not expose unauthenticated installation/lifecycle APIs.
Separate the ability to run this initialization phase from a normal Start of an uninitialized root.
The initialization path must not mark the old default seed pass complete before the user's
selection is durably accepted, or later run that pass and install deselected applications.

Use the existing catalog and seed/lifecycle machinery for execution. Retain each operation's
request identity and normalized inputs; changed arguments require a new explicit operation.
Retried downloads, lost HTTP responses, concurrent init calls and parent restarts must not produce
duplicate instances, installations or user accounts. Preserve successful stages and report partial
failures. Do not silently omit a failed selected app and call the whole operation ready.
Uninstalling an app after initialization must remain durable across restarts and repeated init.

Requests select catalog app IDs and supported port choices, not unrestricted executable commands
or manifest URLs. Resolve manifests/feeds through the target distribution's normal trusted path,
retain the accepted install inputs for recovery and preserve required installation/access review.
Do not silently change accepted versions during replay. Initializing a child with another Core
build uses that build's supported catalog/contract or reports incompatibility explicitly.

## Automatic Ports And Local Addresses

Assign the Core listen port once for a fresh root and persist it in Core-owned settings. Remove the
fixed host-port requirement from fresh Shell installations and use the normal app allocator.
Other distribution apps use their existing automatic port contracts. Internal container ports
remain valid; this change concerns competing host listeners, not randomizing container protocols.

Use the existing allocation policy and readiness checks. Revalidate binding before launch and
handle concurrent primary/child initialization and externally occupied ports. Before first readiness,
an automatic allocation may be retried with a new candidate while updating its stored endpoints
atomically; never silently move an operator-pinned port or renumber an established installation.
Normal restart keeps assigned ports. Removing the Shell manifest pin must not move an already
installed Shell from its current address during upgrade.

Reuse [local browser origins](../local-browser-origins/feature.md) and actual endpoint projections.
Display Core/app URLs with the assigned ports; do not construct assumed `7070`/`7171` URLs or
promise port-free routing. The primary namespace and instance-qualified child namespaces remain
distinct. These are local browser URLs, not automatically reachable LAN/remote endpoints.
Manual advanced inputs require range, collision and service/endpoint validation and must be
persisted through the same allocator rather than unvalidated settings-file edits.

## Dashboard Environment Creation

Keep the Sandboxes creation entry point visible to an authorized administrator when inventories
are empty. Provide **Create environment** with a name and distribution-app checkboxes/descriptions;
use the same recommended defaults as init. Automatic ports are the default, with optional advanced
overrides. The manager chooses a new owned data root; the normal form does not require a source
folder, workspace, agent conversation or arbitrary host data path.

Create a child through the existing `/api/core-environments` service, then apply the explicit
initialization selection to it. Retain the creation/initialization request IDs and observe progress
after reload or uncertain responses. Separate Core-running, apps-preparing, setup-available and
failed states so the row never claims the whole environment is ready because a process exists.
Read failures remain errors, not an empty inventory; refresh must preserve the dialog's draft.
Use existing event/observation infrastructure where suitable; a new global stream is not required.

The parent row needs the environment name, state, setup/open link and existing lifecycle/delete
actions. Until the first administrator exists, **Set up administrator** obtains a fresh setup URL
for that child; provide explicit Copy setup link / Copy token actions. Afterwards **Open environment**
uses the child's ordinary Shell/login destination, or Core's completion/status surface without Shell.
Issue short-lived credentials only for that explicit action. Do not place tokens in inventory
responses, persisted operation receipts, browser storage, events or routine logs. An expired link
can be renewed through the authorized parent action without recreating the environment.

Registration and browser login happen entirely inside the child. Neither creating/opening its row
nor observing initialization may require entering child email/password into the parent or creating
`parent-session.json`. Use bounded owner-authorized management observations for readiness and
first-setup availability. Existing agent `environment_setup` and child API sessions remain available
for their separately authorized use; they are not prerequisites for this manual journey. Existing
app-inventory features must not block the basic row or incorrectly claim registration is unfinished
merely because no parent-held child session exists.

Reuse current parent ownership, scoped Shell permissions, CSRF protection and consent rules. The
current Shell operator mapping covers lifecycle/setup and workspace creation, not a general direct
create/setup-link route; explicitly map and test the new operations. This feature grants no public
or delegated caller broader environment access by virtue of knowing an ID or URL.

Child users, keys, app registries and data stay independent. Applications and users see ordinary
fresh-install authentication, without a special parent account. Keep the manager's technical quota,
process ownership and cleanup integration. Stop retains state; Finish removes only owned child
resources and preserves borrowed source. A separate data root does not imply hostile-code isolation
or a new Docker engine.

## Compatibility And Resource Limits

Existing environment API clients that omit initialization options retain their empty-child behavior.
An explicit empty selection is also supported. The UI sends an explicit recommended selection;
do not silently add Shell/Marketplace to every existing agent-created environment. Initialization
options participate in request fingerprints and applicable delegated consent/replay validation.
Existing current/release/source modes, workspace retention and source-test workflows remain intact.
Testing a candidate Shell remains possible through ordinary supported source/artifact selection
inside the child; this plan does not add a second installed Shell identity or change the parent.

Validate the selected app graph against the child's existing resource contract before claiming the
selection can start. The current default reserves 4 GiB/2 CPUs for a child and 2 GiB/1 CPU per app;
Shell and Marketplace already consume that nominal two-app allowance. Selecting Harness as well
needs an explicitly adequate allocation within the tree pool or an actionable capacity refusal.
Do not silently exceed limits, reduce them to unverified values or omit selected apps. Primary-host
readiness and Docker availability are not evidence of spare child capacity. Preserve the current
two-unfinished-descendant bound, reservations through Stop/failure, and release only after Finish.

## Deliverables

- [x] D1. Implement the shared initialization request/status contract, durable progress and recovery using Core's catalog/seed/lifecycle services, with explicit pre-selection startup and no premature default seeding.
- [x] D2. Add hosty init: install Core only if missing, present catalog choices/descriptions and recommended defaults, support explicit noninteractive inputs, and keep repeated calls on the same target with the command/state behavior above.
- [x] D3. Assign and persist fresh Core/Shell host ports automatically, support validated advanced overrides, handle initial bind races and preserve existing ports and instance-qualified browser origins across restart/upgrade.
- [x] D4. Execute the selected application installations and starts with prerequisite/capacity checks, real readiness, bounded progress and resumable per-app failures; preserve setup management and post-init removals.
- [x] D5. Deliver ordinary browser administrator registration after readiness, including fresh/expired setup-link handling, explicit copying, no-Shell completion and existing-account recovery without parent credentials or automatic account creation.
- [x] D6. Add Dashboard Create environment and the visible empty-state entry point, reusing child allocation and shared initialization with durable requests, progress, setup/open and existing lifecycle/Finish controls.
- [x] D7. Implement and verify initialization/setup-link authorization and child compatibility: current Shell app-auth mappings, ownership/consent, credential-free management observations, omitted-options empty behavior and independent identity/resource cleanup.
- [x] D8. Update installed-root Start guards, legacy-root adoption, installer guidance and existing --start behavior; preserve explicit source/test workflows, supported setup commands and no-reset repeat semantics.
- [x] D9. Pass affected CLI/Core/SDK/Shell tests and builds, covering state/replay, install failures, readiness, ports, migration, authorization and UI recovery; record the results for the exact candidate.
- [ ] D10. Verify real first-install and Dashboard-child browser journeys with isolated test roots, normal administrator registration, selected-app readiness, resource limits, restart/retry and independently confirmed Finish cleanup; record platform coverage and every unavailable case.
- [ ] D11. Update README, CLI help and affected reality documents, publish this feature's reality document, apply required component versions, remove this plan on final completion and regenerate the documentation index.

## Implementation Sequence

| Phase | Deliverables | Exit condition |
| --- | --- | --- |
| Shared foundation | D1, D3, D7 | Target-specific initialization, automatic ports and authority/replay contracts work without UI duplication |
| Primary onboarding | D2, D4, D5, D8 | Installer then init reaches real registration; interruption and existing-root behavior are correct |
| Dashboard integration | D6, D7 | A manual child reaches the same registration flow without a parent-held child login |
| Verification and documentation | D9-D11 | Both journeys pass on recorded targets; final docs and version outcomes match shipped behavior |

Use one feature branch/PR for the complete approved implementation. The phases organize work;
they do not authorize separate partial feature PRs. A documentation-only plan has no version bump.
Implementation introduces platform and Shell functionality, so use their minor version rules;
bump SDK and other artifacts only when their shipped code changes, using their own version policy.

## Approved Contract Details

The approved command split keeps init for first setup/resume and setup for later app management.
Shell is recommended and preselected, with an explicit supported headless choice. These choices
were approved with the plan on 2026-10-21. Exact advanced CLI
flag spellings and additive DTO names are implementation details; they must preserve the behavioral
contract and existing command compatibility above.

## Verification

D1-D9 are implemented and verified in the registered workspace. The current implementation is
described in [feature.md](feature.md). The affected suites/builds and macOS/Linux ARM64 Native AOT
gates pass. D10 retains unavailable publication/native-platform acceptance; the macOS native-linker
blocker is resolved by the SDK floor documented below. D11 has updated implementation documentation
and component versions; final plan retirement depends on D10 and is not treated as complete while
those checks remain outstanding.

### Verified candidate evidence — 2026-10-21

- Platform 0.149.0 → 0.150.0 (including rolling-channel metadata); Shell 0.109.2 → 0.110.0;
  JavaScript SDK 0.32.0 → 0.33.0. Candidate release artifacts are not published.
- CLI suite: 300 passing tests. Shell suite: 375 passing tests; production build passes, lint has
  zero errors and three existing warnings. Setup copying covers both working and unavailable clipboard APIs. SDK suite: 682 passing tests across 34 files; its package build and overlay upgrade contract pass.
- Core affected suites: 200 passing tests, including initialization/review, failed-start resume,
  actual readiness, post-init removal, authorization/consent, automatic-port collisions and retained
  Shell ports after removing the manifest pin. The broad run exposed a second automatic bind-probe
  race during environment Create; that probe is removed and the affected suites pass afterwards.
  The subsequent full final-candidate run on system SDK 10.0.402 passes: 3,983 tests passed,
  zero failed and five opt-in integration tests skipped in 31 minutes 3 seconds. Its skipped scenarios
  require explicitly enabled Harness/Telemetry/Docker-development or Torrent/VPN fixtures. This run
  includes CoreLifecycleServiceTests and replaces the earlier split-suite evidence.
- macOS source Core, clean root: Core-only init assigns and persists a port, prints an unwrapped
  setup link, and ordinary browser setup creates an administrator with truthful headless guidance.
- A second clean root uses the supported distribution-path override with the candidate Shell
  artifact and Marketplace. Init installs both through Core, observes both healthy, and ordinary
  browser registration redirects into an authenticated Shell. Core/Shell/Marketplace receive distinct
  automatic ports (22587/27729/31759). Repeated init preserves installed timestamps, versions and ports.
- Dashboard's initially empty Sandboxes section exposes Create. Its normal catalog shows recommended
  Shell/Marketplace and optional Harness/Telemetry. A recommended child reaches partial failure
  honestly: Marketplace becomes healthy, while the currently published Shell still pins occupied
  port 7171. No app is silently skipped or reported ready. The candidate manifest removes this pin.
- A Core-only Dashboard child reaches its own ordinary setup page with a prefilled token, registers
  a separate administrator, and retains its port/account on Restart. Neither child creates a
  parent-session file. Parent and child identities/data remain separate.
- Both children are Finished through their owning test Core after normal password login. Independent
  checks confirm removed roots, closed listeners and zero owned containers, networks and volumes.
  Both temporary primary fixtures are also stopped after ordinary app removal; their listeners are
  closed and their Docker containers, networks and volumes are absent. The operator Core is preserved.
- Version consistency, documentation/index/relative-link checks, whitespace and Unix installer
  syntax pass. Later portable PowerShell and owner-provided native Linux VM checks are recorded below.

### macOS Native AOT resolution — 2026-10-21

The earlier Xcode 27.1 linker assertion (`too many large addends`) came from the .NET 10.0.11
Native AOT compiler used by SDK 10.0.400. Microsoft backported the
[Mach-O relocation fix](https://github.com/dotnet/runtime/pull/132171) to .NET 10.0.12.
The repository now requires SDK 10.0.401 through `global.json`, retaining `latestFeature` roll-forward
and compatibility with Harness's pinned SDK 10.0.401 worker. Core and CLI keep Native AOT;
no classic-linker workaround is added. Initial verification uses temporary isolated SDK installations;
the subsequent authorized system upgrade is recorded below. The operator's running Core is preserved.

- On macOS ARM64 with Xcode 27.1, SDK 10.0.402/runtime 10.0.13 passes the exact cold Core gate
  (`npm run core:aot`) and CLI Release Native AOT publish. The Core gate reports no new trimming/AOT
  warnings; existing CS9113/CA1416 compiler warnings remain. Both Mach-O executables pass
  `codesign --verify`, and their native version/initialization-contract probes succeed.
- The minimum supported SDK 10.0.401/runtime 10.0.12 also passes the exact cold macOS ARM64
  Core gate and CLI Native AOT publish after the final `global.json` change. Core reports no new
  trimming/AOT warnings; the CLI native version probe returns 0.150.0. The CI policy suite passes
  all 27 tests, and version, documentation/index/link and whitespace checks pass.
- The native CLI starts the native release Core in a separate fresh primary fixture. Premature
  Start is refused, `init --core-only --no-open` succeeds, an automatic port is assigned and the
  ordinary administrator setup form returns HTTP 200. Repeated init retains the port. Core status
  confirms release mode; normal Stop succeeds, with the process absent and listener closed afterwards.
  This is a native startup/HTTP smoke check, not another completed browser-registration journey.
- Tests on SDK 10.0.402 pass: CLI 300; Core excluding CoreLifecycleServiceTests 2,940; .NET SDK 64;
  Telemetry backend 120; Whisper 9. Whisper's one opt-in native recognition test is skipped because
  `HOSTY_WHISPER_INTEGRATION=1` and its pinned speech-model fixture are not enabled. The subsequent
  full Core run after the system SDK upgrade is recorded above.
- The exact Linux ARM64 Core gate (`node scripts/check-core-aot.mjs linux-arm64`) previously passed
  in an isolated SDK 10.0.401 container with Clang and zlib, with no new trimming/AOT warnings.
  Its source mount was read-only and the container was removed. This remains build evidence,
  not a native Linux installation journey.

### System SDK and native acceptance — 2026-10-21

- The owner-authorized system SDK upgrade to 10.0.402 succeeds through Microsoft's signed,
  Apple-notarized macOS ARM64 package after SHA-512 verification against official release metadata.
  `/usr/local/share/dotnet/dotnet --version` returns 10.0.402 in this workspace; the system package
  receipt agrees. Older SDKs remain installed. `global.json` keeps the verified 10.0.401 minimum
  and permits 10.0.402 through its existing roll-forward policy.
- With the system SDK, `npm run core:aot -- osx-x64` and CLI Release Native AOT publish for
  `osx-x64` both pass. Core reports no new trimming/AOT warnings. The ARM64 host cannot execute
  x64 binaries because Rosetta is unavailable; these are compilation checks, not Intel runtime evidence.
  The local x64 CLI publish is unsigned (`codesign --verify` reports no signature); no signing or
  notarization claim is made for that artifact.
- The SDK 10.0.402 native ARM64 CLI and Core initialize a fresh isolated primary root using the
  supported custom distribution catalog, the candidate Shell image and Marketplace. Both applications
  become healthy before ordinary browser administrator registration redirects into authenticated Shell.
- From that Shell's initially empty Dashboard, Create environment with the recommended Shell and
  Marketplace selections succeeds. The child reaches ordinary administrator setup and authenticated
  Shell using separate credentials. All six primary/child Core/application listener ports differ.
  Parent credentials are rejected by the child, and no child `parent-session.json` exists.
- Restarting the child preserves its Core/Shell/Marketplace ports and browser session. Restarting the
  primary with `--keep-apps` adopts the running child and preserves its readiness. A two-app selection
  with insufficient nominal capacity is refused before allocating an environment. Removing Marketplace
  from the primary remains effective after repeated init and restart; the child's apps remain intact.
- Finish through the owning primary succeeds. Independent checks confirm the child root is removed,
  its process/listeners are absent, and no owned Docker containers, networks or volumes remain. The
  primary's apps are removed through normal lifecycle and its Core is stopped; the same resource checks
  pass for that fixture. The operator Core retains its original process-start identity and source target.
- Six Unix installer fixture cases pass: default install prints init without starting it; `--start`
  and `HOSTY_INSTALL_START=1` invoke `init --yes`; download failure, unavailable checksums and checksum
  mismatch refuse replacement while preserving an existing executable. These use substituted download
  and CLI executables, not a published release. Unix syntax validation also passes.
- A separate macOS installer fixture stages the real native candidate CLI through a substituted
  download with its actual SHA-256. The installer prepares only the explicit temporary data root and
  profile, leaves Core absent and apps empty, and prints init guidance. Premature `hosty start` exits
  unsuccessfully with the init instruction, without downloading Core or creating a control endpoint.
  This exercises native CLI installation and the Start guard, but still excludes GitHub transport.
- A temporary official PowerShell 7.6.7 ARM64 runtime parses `scripts/install.ps1` without errors and
  runs its Help path. Normal invocation on macOS is refused by the Windows-only guard before installation.
  No PowerShell system install is performed. Native Windows/PowerShell 5.1 behavior remains unverified.

### Native Ubuntu ARM64 acceptance in UTM — 2026-10-21

- After the owner identifies the available UTM VM, Hosty QA - Ubuntu 24.04 is started in disposable
  snapshot mode. The guest reports Ubuntu 24.04.5, Linux 6.8 ARM64. Hosty QA - Clean Baseline is not
  started or changed. The QA guest has no running containers before the test.
- The exact candidate Core/CLI build inputs are copied from the registered workspace without Git
  metadata, credentials or unrelated app data. Checksum-verified SDK 10.0.402 and Native AOT prerequisites
  produce both `linux-arm64` Release executables inside the guest. Core has the existing CS9113/CA1416
  warnings; neither publish reports trimming/AOT warnings. No repository source edits occur in the guest.
- The normal desktop user `hostyqa`, with verified Docker access, runs the actual Unix installer
  against a substituted download containing the native candidate CLI and its real SHA-256. The installer
  prepares only the explicit test root/profile, leaves Core absent/apps empty and prints init guidance.
  Premature Start refuses initialization before downloading or launching Core. The locally built Core
  is then staged for the existing-binary init case; real GitHub release download remains separate.
- The supported custom catalog and the same candidate Shell/Marketplace images are used after checking
  the transferred image archive's SHA-256. Init reaches ready with both applications. Native Linux
  Chromium, driven through Playwright CLI, completes ordinary administrator registration and redirects
  into authenticated Shell. No account or session is seeded.
- Dashboard Create environment with recommended Shell/Marketplace creates a separate child. Its own
  browser setup form appears despite the parent browser's active administrator session; normal child
  registration redirects into the child's authenticated Shell. All four apps are healthy. The six
  Core/application ports are distinct: primary 28678/30877/23174, child 25366/22500/30794.
- Ordinary password API checks reject the parent's credentials on the child, accept the child's own
  credentials and confirm no `parent-session.json`. Child restart preserves its account, application
  readiness and ports. Parent restart with `--keep-apps` preserves the child's PID and Linux process
  start ticks; all six ports remain unchanged and both browser sessions survive reload. Repeated init
  succeeds without replacing the installation. A test-only exact UTC timestamp comparison is corrected
  to the stable Linux PID/start-tick identity; no product change is required.
- The Dashboard reports Administrator registered, both apps ready and both services healthy after
  restart. Browser-console coverage is not claimed clean: optional workspace endpoints return 403,
  fixture-only icons/favicon return 404, and the unpublished local Shell image shows an update-check
  warning. These do not prevent the verified initialization/environment journey; the published artifact
  path remains an explicit acceptance gap.
- The browser is closed, the child is Finished through its authenticated owner and the primary apps
  are removed through normal lifecycle before Core Stop. Independent checks confirm the child root is
  gone, both Core processes stopped, all six listeners closed and zero owned Docker containers,
  networks or volumes. Selected reports and the registered-child screenshot are exported without
  browser profiles, setup tokens or Core credentials before graceful VM shutdown. UTM subsequently
  reports both the QA VM and untouched clean baseline stopped.

### Outstanding verification owned by D10-D11

D10 needs the coordinated published CLI/Core/Shell artifacts for the real CLI-only download
journey and the default published-distribution child path with the new Shell manifest. Current rolling
artifacts do not contain this candidate. Native macOS ARM64 and Ubuntu ARM64 recommended-child journeys
pass with the candidate custom distribution; they do not establish the published download path.
Native Windows and Linux x64 installer/browser coverage remains unverified, as does macOS Intel runtime
execution. Portable PowerShell parsing and substituted installer downloads do not replace those cases.
D11 keeps this plan until these outstanding deliverables are resolved.

Implementation checks include:

- `npm run core:build`, `npm run core:test`, `npm run core:aot`, `npm run cli:build` and `npm run cli:test`.
- `npm run shell:lint`, `npm run shell:test` and `npm run shell:build`; SDK tests/build when its contracts change.
- Unix installer syntax/tests and PowerShell installer tests; missing Core, download failure and existing binary reuse.
- `node scripts/check-versions.mjs`, `node scripts/docs-index.mjs --check` and `git diff --check`.
- Regression cases for two simultaneous init calls, interrupted install/start, same-ID replay after lost response,
  invalid/changed inputs, occupied ports, concurrent children, stable restart addresses and preservation of legacy data.
- Authentication/authorization cases for expired/used setup tokens, no token inventory/log leakage, cross-owner
  denial, revoked app access, setup already completed in another browser and recovery for existing accounts.

Live acceptance uses registered workspaces and supported Core-managed test environments with separate
test roots/users/data. The primary-install fixture must actually begin uninitialized, with Core absent
for the download case; a pre-seeded child or fabricated user/session is not evidence of this journey.
Do not remove the operator's installed Core or run destructive installer tests against its data root.

| Scenario | Required observation |
| --- | --- |
| CLI-only fresh install, then premature Start | Clear init instruction; no Core/app startup or account creation |
| Init with Shell + Marketplace | Core download, chosen apps ready, normal browser setup, automatic signed-in Shell navigation |
| Init with an extra optional app / Core only | Correct graph and readiness; clear no-Shell completion; no unnecessary provider-login prerequisite |
| Browser fails to open / setup link expires | Printed/copyable usable link and fresh-token retry without reinstall |
| Interrupted init / repeated init after registration | Same identity, ports and completed stages; no duplicate user/app or implicit reinstall |
| Established installation upgrade | Preserved users, data, origins, ports and removed-app choices; ordinary Start still works |
| Dashboard initially empty | Create action available with authorized scope and catalog selection |
| Child with Shell + Marketplace beside primary | Separate origins/ports/accounts/data; manual child registration needs no parent child-account connection |
| Child capacity refusal / install failure / parent restart | Honest error and durable recovery with unchanged request identity; no silent selection reduction |
| Legacy agent creation without new options | Empty child and existing normal environment_setup/API flow remain functional |
| Stop/restart and Finish | Retained state on restart; owned process, listener, containers, volumes and temporary data removed on Finish; source and primary preserved |

Record actual native macOS/Linux/Windows installer and browser coverage against advertised support.
Simulation, Linux in Docker or unit tests do not establish another native platform's first-install
experience. Keep D10 open for required unavailable coverage or obtain an explicit support-scope decision.
Export concise evidence and finish owned test environments through their owner, verifying removal.
Keep credentials, raw logs and evidence JSON out of the PR.

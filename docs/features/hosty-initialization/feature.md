---
created: 2026-10-21
updated: 2026-10-29
summary: Core-owned first-run initialization selects applications, persists automatic ports and opens ordinary administrator setup from CLI or Dashboard environments.
components: [apps/core, apps/cli, apps/shell, packages/app-sdk, scripts]
---

# Hosty Initialization

## Primary Installation

The Unix and PowerShell installers install the CLI and print `hosty init` as the next step.
Their explicit start option runs noninteractive recommended initialization. A normal Start of a
fresh installed data root refuses to launch and points to init. Established installations retain
ordinary Start behavior; explicit source project launches remain supported.

`hosty init` targets the resolved data root. It installs Core only when missing, before reading the
catalog or asking about applications. An existing Core is reused; an incompatible initialization
contract produces an explicit upgrade diagnostic. `hosty update` owns upgrades.

The interactive selection uses the target Core's distribution catalog, with descriptions and
recommended defaults. Core is mandatory; Shell and Marketplace are recommended, while the other
catalog entries remain optional. The CLI displays the selection for confirmation. The command
supports `--yes`, `--apps <IDs>`, `--core-only`, `--no-open`, `--port <port>`, repeatable
`--app-port appId:service:portKey=port`, and an explicit `--project` for source verification.

Core starts in initialization mode without the legacy default seed pass. The selected applications
are installed through ordinary lifecycle plans and started through their selected runtime profiles.
Initialization checks Docker availability when needed and waits for actual service/readiness health.
Boot continues to apply ambient development source overrides to installed apps without seeding
unselected applications, both during explicit initialization and after it completes.
Per-app progress and errors remain visible. Only after all selected applications are ready does the
CLI print a full setup URL/token and attempt to open the browser.

Administrator registration is the normal Core setup-token flow. It collects email, display name and
password in the browser, creates the normal session, removes the completed form and token URL, and
opens the current Shell origin when available. Without Shell, it reports successful registration and
CLI/API management guidance. No administrator or default password is seeded.

## Durable State And Recovery

`core/initialization.requested` suppresses automatic seeding before choices exist.
`core/initialization.json` stores the versioned `hosty-initialization.0.1` request, normalized input
fingerprint, resolved install versions/digests and per-app outcomes. Its phases are `pending`,
`preparing`, `failed` and `ready`; observations additionally report `selection` and adopted `existing`
roots. Administrator existence is read from authoritative user state, independently of these phases.

A hosted Core worker owns accepted work, so losing the CLI or an HTTP response does not cancel an
installation. Pending/preparing work resumes after Core restart. A retry inspects installed apps,
keeps completed work and rechecks health. Request-identity conflicts are rejected even while the
worker holds its execution lock. A retry or review submitted as terminal state becomes visible waits
for that lock to be released, so completion cannot silently discard the submission.
Mutable feeds or manifests cannot silently replace the accepted inputs. A completed initialization never reinstalls apps removed afterwards.

Repeating init before registration issues a fresh ordinary setup link. Repeating it afterwards
reports the existing destination and points to `hosty setup` for application management. Existing
accounts with no active administrator require the explicit recovery flow; init never resets them.
Legacy seed/choice files, installed app records or existing users identify an established root.
Malformed initialization state produces a diagnostic rather than permission to overwrite it.

After a failed operation, `hosty init --review` explicitly accepts a new selection and new request
UUID. It can change apps/ports or accept newly resolved distribution inputs while retaining installed
apps and data. Previous request IDs remain retired and cannot replay over the new selection. Ordinary
resume preserves the current accepted request. A review can keep an installed app's existing operator
port while it is still running; other occupied ports remain invalid. Changing a running app's port
restarts it before readiness checks. The applied configuration snapshot also detects a restart still
pending after an interrupted reassignment. Ready installations use setup for app changes.

## Ports And Browser Origins

A fresh initialization chooses a free Core listener and persists it in Core settings and an
initial-listener checkpoint. It revalidates automatic candidates before readiness and can retry a
bind race. Once ready, the assigned port remains stable. Explicit and established ports do not move
silently. Child allocation also excludes reserved sibling and selected manual app ports, revalidates
before its first launch, and records first readiness independently of later initialization failures.

Fresh Shell manifests omit the old host-port pin and use the ordinary runtime allocator. Removing
that pin on an existing installation preserves its assigned address. App port overrides use the
normal reviewed reassignment operation, including range, collision and endpoint checks; fixed
manifest, host-network and unsupported transport endpoints are refused.

CLI and Dashboard use actual Core/Shell endpoint projections with the existing instance-qualified
local browser hostnames. Ports remain part of the URL. Container-internal ports and the legacy Core
fallback for explicit non-initialization launch paths are unchanged.

## Dashboard Environments

The administrator's Dashboard lists child environments under the connected Core. Create environment offers a name,
the distribution catalog with recommended selections, and optional port/resource fields. The parent
allocates an owned root and starts a child through the existing environment lifecycle. It then submits
an explicit selection to the child's initialization service. Initialization is separate from the
child's process state; a running Core can still have preparing or failed applications.

Create environment is one form without numbered stages. Its header and Create/Cancel footer stay
visible while the name, catalog and optional port/resource controls scroll. Local validation keeps
invalid input in the dialog. A valid Create closes it immediately; Dashboard owns the request and
shows a named pending row until the child appears. Failed or uncertain creation retains its error
and exact-request retry, without reopening the form or silently creating a second environment.
Creation and Start keep separate durable request IDs in existing operation receipts.

Initialized-child rows show the current application being prepared/installed/started or administrator
setup requirement below their status. Initialization failures appear as a name-adjacent icon with
a hover/focus tooltip. The parent reads the existing bounded initialization
endpoint while setup is incomplete; these observations are not part of the sandbox SSE payload.
Checks pause while hidden, recover on focus/visibility return, and stop on readiness with a registered
administrator. Stopped, replaced and unmounted children reject obsolete reads and setup responses.
Environment Details shows one installed-app inventory with each app's runtime and health on the same
line, plus resources and access. There is no inline expansion, second app progress list or stage display.

One primary row action offers Sign Up when first registration is available, Stop for a
running child, or Start for a stopped child. The three-dot menu contains other applicable operations,
Resume initialization, status refresh and confirmed deletion. Open Core appears there only after
administrator existence is confirmed and opens the child login in a new tab. It is absent before
registration; setup disappears after registration. Legacy children retain their account connection
flow and obtain navigation readiness from its application inventory.

Set up administrator obtains a fresh setup link and opens the child's browser form. A dialog retains
Open registration, explicit link/token copying and renewal when opening is blocked or the link expires.
Setup credentials remain in component memory, outside inventory and persisted browser receipts,
and are cleared after registration or a child lifecycle/scope change. Existing users needing recovery
remain on the normal administrator recovery path. This action cannot add another administrator after
first setup has completed.

The child has its own users, keys, app registry and data. Parent observation, app inventory and
setup-link issuance use bounded fixed control operations and need no child password or
`parent-session.json`. Browser setup/login happens inside the child. Existing agent setup/account
transport remains available separately. Requests omitting initialization retain their empty-child
behavior; explicit empty selection is also supported.

The parent retains ownership, consent, quota, Stop/Restart and Finish responsibilities. Creation
validates selected app capacity against existing environment limits; it never silently drops a chosen
app. Defaults allow two nominal application reservations per child. A larger selection requires an
explicit adequate reservation within the shared tree pool. A Core-only selection can reserve 1 GiB;
its per-app memory ceiling is capped at that total. Finish removes owned child resources and
keeps borrowed source; Stop retains the installation.

## Authority And Implementation

Core owns catalog resolution, installation, health and setup-token issuance. CLI owns prompts and
missing-Core installation; Dashboard owns presentation and child allocation requests. The common
contract lives in [Initialization.cs](../../../shared/Initialization.cs), with the worker in
[HostInitializationService.cs](../../../apps/core/src/Haas.Hosty.Core/HostInitializationService.cs).

The local control API exposes initialization status, submit and setup-link operations under
`/control/v1/core/initialization`; it requires the normal local control secret. Parent environment
status/resume/setup-link routes retain current owner and consent checks. Shell's operator routes
require environment inspect/operate permissions; generic child API transport remains unavailable
through that mapping. Shell declares environment inspect/operate and sandbox inspection as required
permissions, while sandbox mutations remain optional. Existing installations gain changed required
permissions through ordinary reviewed manifest updates.

Related contracts: [CLI bootstrap](../cli-bootstrap/feature.md),
[distribution catalog](../removable-system-apps/feature.md),
[automatic app ports](../automatic-runtime-app-ports/feature.md),
[local password login](../local-password-login/feature.md), and
[child environments](../app-sandbox-runtimes/feature.md).

## Testing Expectations

- Verify the single creation form at narrow/short viewport sizes, persistent header/footer, local
  validation, immediate close, named pending progress, lost-response recovery and exact-request retry.
  Cover collapsed install/setup progress, one expanded installed-app inventory, lifecycle/menu actions,
  no Open Core before registration and no setup afterward. Verify setup fallback/copy/renewal,
  stopped-child and obsolete-response guards, hidden-page recovery and no idle setup polling after readiness.

- Exercise pre-selection suppression, durable replay, explicit review, failed starts, actual readiness,
  corrupt state, repeated init and post-init app removal using the real Core lifecycle with isolated adapters.
- Cover installed-root Start guards, recommended/explicit/headless CLI input and incompatible Core diagnostics.
- Verify first-bind collision handling, stable restart addresses and preservation of existing Shell ports.
- Test owner, permission, consent, CSRF and fixed-transport boundaries, including setup-link denial after revocation.
- Cover the visible empty Dashboard, catalog choices, resource refusal, setup/resume and error-preserving refresh.
- Use isolated native roots and normal browser registration for primary and child acceptance; inspect absence of
  parent-held child sessions, actual readiness and independently confirmed Finish cleanup.
- Run CLI/Core/SDK/Shell suites, production builds, Native AOT, installer syntax, version and documentation checks.
  Platform and publication coverage, including unavailable acceptance cases, is recorded in the active plan.

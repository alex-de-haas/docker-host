---
status: In Progress
created: 2026-09-30
updated: 2026-10-10
summary: Every local browser workflow works without a domain, DNS or configured public origin.
components: [apps/core, apps/shell, packages/app-sdk, apps/harness]
---

# Local Browser Origins Without Public-Origin Configuration

## Goal

A default Hosty installation supports every local browser workflow without a purchased domain,
external DNS, ingress provider, or manually configured public origin. Users do not switch between
`localhost` and `127.0.0.1` to make authentication, embedded apps, or permission confirmation work.

On 2026-09-30 the owner requested a product fix after Shell's required-permission review opened
`http://localhost:7070/install/confirm/...` and Core refused the shared cookie hostname. The owner
clarified that the fix must cover the default local experience, rather than manually configuring
this installation or special-casing just that confirmation link.

## Approved Decisions

The owner approved implementation on 2026-09-30, including custom public origins with ingress
`none`. Local defaults require no DNS configuration or hosts-file changes. Target modern Chromium,
Firefox and Safari on macOS 26 or newer; older system resolvers are not an automatic fallback.
Unexecuted browser/platform acceptance remains tracked below.

On 2026-10-08 the owner requested restoring named localhost Core sign-in over HTTP after protocol
2's literal-IP restriction made generated Core defaults unusable. Chromium accepts Secure host-prefix
cookies on HTTP localhost, but a real Safari probe rejects them. This implementation uses a Core-origin
sessionStorage nonce initialized only by the validated app-origin POST. A continuation GET cannot
initialize proof or issue a code; a same-Core-origin navigation POST submits existing proof in its
body. Preserve nonce/S256 binding, atomic claims, bounded attempts and every app endpoint host check.
HTTPS and literal-IP cookie flows remain unchanged; other HTTP DNS remains unsupported. Missing or
blocked storage fails closed, with the existing credential-free silent fallback.

App names use an injective DNS-safe encoding of the full app ID (hyphen, dot and underscore escaped),
split into bounded labels, under `hosty.localhost`. Core uses the reserved `core` label. Non-default
Core instances include their persisted instance identity in the shared local site namespace.
Overrides retain precedence; reject app/Core cookie-host collisions. Generated addresses remain
separate from external publication state and internal transport.

On 2026-10-01 the owner clarified the intended trust boundary: Core owns user sign-in and the
primary session; Shell is replaceable and must use the same application identity and permission
rules as other apps. Remove Shell-specific authority exceptions rather than giving its server a
full user credential. This establishes the direction; the detailed API permission mapping and
browser exchange design below still need to be completed before authentication changes start. The
owner subsequently selected the initial coarse permission catalogue recorded below.
On 2026-10-01 the owner approved proceeding after resolving the final running-app policy: deny
operations immediately and stop an app normally when a required grant is lost or unsupported.
The agreed decisions authorize implementation; browser acceptance remains a shipping requirement.

On 2026-10-01 the owner also approved removing development-only impersonation: `/login` uses
email/password in every environment and direct `POST /api/auth/session` creation is removed.
Development startup does not seed or re-enable users. New local installations use normal setup;
existing passwordless development accounts use explicit recovery. Automated fixtures may seed
isolated stores in-process, while browser acceptance must exercise real password login. Update
developer and agent instructions with the same rule.

## Profile and source-provider UI (owner decisions, 2026-10-01)

The owner rejected a general Core settings UI. Core retains login, credential issuance and final
consent. Shell edits the current user's ordinary profile through an identity-only API, without
`users.read/manage`. Those permissions remain administrative user management.

The owner placed GitHub/Azure DevOps connections under `apps.sources.full` and selected Harness as their
settings UI, alongside agent providers. Source providers remain built into the current implementation;
separate provider apps are a direction, not part of this implementation. Core retains credential
storage and source operations. Shell declares no `apps.sources.full` and does not list or configure
source connections. Source connection access still requires the current owner and administrator role.

Completed:

- Separate basic profile data from source connection summaries, provider availability and Git
  attribution; gate source connection APIs with `apps.sources.full`, live app identity and owner checks.
- Add Harness Source providers settings for GitHub/DevOps, including Git attribution, PAT/device
  authorization, connection checks/rename/disconnect and the app-local server transport.
- Remove connection forms from Shell; retain self-profile and link to authorized source tools.
- Update owning documentation and app-authoring instructions; verify Core/Harness/Shell API,
  transport and UI tests, builds and a Core-managed browser flow without real provider credentials.

Private-source installation/binding and broader browser acceptance remain separately tracked below.

## Original Acceptance Failure And Remaining Migration

On 2026-09-30, Safari on macOS 27 resolved the generated names and created a Core session.
Direct navigation to Core's `/api/auth/session` returned `authenticated: true`, but the Shell
cross-origin cookie flow returned to login. Chromium passed the same flow. The implementation
therefore fails the approved WebKit acceptance requirement and is not ready for deployment.
On 2026-10-01, Safari Web Inspector traced Shell's `GET /api/auth/session`: it sends
`Sec-Fetch-Site: cross-site` without a `Cookie` header. Core answers HTTP 200 with the exact Shell
`Access-Control-Allow-Origin` and `Access-Control-Allow-Credentials: true`; Shell returns to login.
Direct navigation to the same session endpoint remains authenticated. This establishes the missing
cross-site cookie, without attributing it to a specific internal WebKit privacy mechanism.
A Core-managed test app successfully uses Core navigation, a one-time code, server-side exchange
and app-grant revalidation in both Safari and Chromium. Its server receives no Core session cookie,
and the app session survives Core restart. The owner's clarified direction rules out transferring
a full Core user session to Shell as a workaround. Application authorization must preserve this
common permission model while removing the cross-origin Core-cookie dependency.

On 2026-10-01 the real Shell password flow and authenticated dashboard passed on Safari 27
and Chromium after the app-grant transport replaced Core-cookie CORS. This resolves the original
Shell sign-in loop. Embedded apps, Harness tool authorization, and the full browser/platform matrix
remain unfinished; successful dashboard login is not full acceptance.

The owner confirmed that fine-grained per-user management permission assignment is deferred.
This implementation keeps the existing role and app-assignment checks alongside app permissions.

## Original Behavior And Conflict

- [Core public origin](../core-public-origin/feature.md) falls back to Core's listen URL.
- [Runtime app ports](../automatic-runtime-app-ports/feature.md) retain a loopback URL for each
  endpoint. Core-to-app traffic intentionally uses an IPv4 literal to avoid Docker IPv6 resolution
  failures. That transport URL also reaches browser navigation when no public origin is set.
- Shell resolves its browser address from its installed app record. Its cookie-authenticated Core
  API calls need a compatible same-site origin.
- [Installation confirmation](../app-installation-sdk/feature.md) correctly refuses a hostname
  used by a runtime app: cookies are scoped by host, not port. Substituting `127.0.0.1` for
  `localhost` everywhere reproduces the conflict.

This work changes the browser fallback policy across these features. It does not remove the
confirmation isolation check or turn the transport URL into a browser authentication policy.
The [advertised app origins draft](../advertised-app-origins/plan.md) addresses clients on other
devices and keeps ownership of its LAN deliverables; this plan owns same-machine local defaults.

## Target Behavior

### One automatic local browser address policy

Use the reserved `.localhost` namespace for generated browser origins, with Core at
`http://core.hosty.localhost:<core-port>` and a stable app-specific hostname under
`hosty.localhost` for each app's browser endpoints. Core and individual apps have distinct cookie hosts. Authentication must also work when a browser
classifies these origins as cross-site; a shared DNS suffix is not evidence of same-site cookie access. Ports retain their existing
assignments. Generated names come from stable app identity, never display names or request headers;
the mapping must handle normalization collisions and DNS length limits deterministically.

Generated local origins are defaults, not saved public-origin overrides. An explicit public
origin keeps precedence. Clearing it restores the automatic local address. Public-origin controls
continue to describe external publication rather than asking users to configure local operation.

`localhost` and `127.0.0.1` remain recognized local entry addresses. Safe browser entry navigation
goes to the canonical local browser address before creating a session or authorization code;
Hosty never asks a user to change the address manually. API requests, POST bodies, credentials and
one-time codes must not be blindly redirected or copied between origins. Old Core sessions cannot
authorize decisions on the new hostname; migration explains the required fresh sign-in.

### Separate browser addresses from transport addresses

Keep persisted endpoint transport URLs, port bindings, readiness checks, service discovery,
Core-to-app requests, container host-gateway addressing and CLI control transport on their existing
local transport paths. Browser navigation uses an explicit effective browser-origin projection.
Do not reinterpret a generated browser hostname as proof of public/LAN publication.

One shared resolution policy supplies endpoint navigation, Shell navigation, app redirect
allowlists, app launch codes, injected browser-facing environment, and SDK adapters. Core login,
setup/recovery/invitations, installation/permission confirmation and browser-facing OAuth links
use the corresponding Core browser origin. Audit native clients and MCP audience discovery so
they can still use direct transport and configured remote origins without resolving browser-only
names inside containers or on another device.

### Compatibility and migration

Apply the defaults to fresh installations and existing records without explicit origin overrides.
Preserve operator-configured origins and port assignments. Running apps retain their injected
environment until restarted; the upgrade path must expose and complete that transition rather than
advertising a working session while old processes still use the old origins. Do not silently
restart unrelated live workloads during development verification.

Support local operation without internet access. Browser/OS resolution and cookie behavior are
acceptance requirements, including supported WebKit-based clients; Chromium alone is not proof.
Do not introduce a public wildcard DNS service or silently fall back to a shared cookie hostname.
Document any verified minimum browser/OS requirements explicitly. If the supported platform matrix
needs an additional resolver mechanism, resolve that design before shipping, with no manual
public-origin setup imposed on the user.

### Core-owned sign-in and ordinary application access

The browser holds Core's host-only HttpOnly session cookie; Core holds the authoritative session
record. Neither Shell's server nor its JavaScript receives the primary credential. Application
identity does not confer the user's full authority. A Core API operation requires both an eligible
user and the calling app's confirmed permission, plus Core-owned confirmation where applicable.

Use the existing application-code/grant flow as the starting point: the browser navigates to Core,
Core checks its own session and the target application, and returns an expiring single-use code to
an allowed application callback. The application exchanges it for an app-bound grant. An app-local
cookie or server session represents only that grant; Core remains authoritative for identity,
expiry, revocation and access checks. Browser navigation to Core is distinct from a cross-origin
background API request and does not require exposing Core's cookie to the app.

Existing code already supplies `/api/apps/{appId}/open`, single-use code exchange, app-bound grant
revalidation and parent-session revocation. It does not yet provide all of Shell's management API
operations under app permission checks. Do not reinterpret an ordinary app grant as a full Core
session or turn a generic proxy into an implicit management permission.

The current permission model is documented in [app permission management](../app-permission-management/feature.md)
and vision decisions 9 and 14. This feature needs a concrete inventory of Shell's calls: which use
existing app permissions, which need a narrowly defined generic permission, and which remain on a
Core-owned operator surface. That includes OAuth consent, credentials/private sources, events and
logout, not only the dashboard. The callback design must cover initiation binding, exact callbacks,
code interception/replay and embedded-app behavior; existing mechanics are not proof of full coverage.

## Approved Initial Permission Catalogue (Owner Decision, 2026-10-01)

The owner selected coarse, self-contained capabilities as the initial contract, superseding both
previous permission proposals. Use the exact names below. Do not manufacture read/manage pairs or
add a third naming segment when there is no distinct capability to name. Later splitting is separate
work and must account for previously granted authority. For this transition, the owner explicitly
accepts expansion of existing grants without renewed approval. Catalogue approval does not mean the
permissions have been implemented or granted to installed applications.

| Permission | Initial scope |
| --- | --- |
| `apps.read` | List applications and inspect their state. Excludes configuration values and logs. |
| `apps.logs` | Read application logs. |
| `apps.notifications` | Read notifications originating from applications for the acting user. |
| `apps.lifecycle` | Manage application running state: start, stop, restart, autostart and runtime selection, including development mode. Selecting an existing source runtime does not grant source-code access or editing. |
| `apps.configure` | Read and change application settings, including sensitive setting values; includes backup operations for now. No separate settings-read, secret-setting-read or backup permission. |
| `core.read` | Read Core's state. Does not mean arbitrary access to every resource implemented by Core. |
| `core.update` | Update Core through the supported update workflow. |
| `core.lifecycle` | Manage Core lifecycle, initially restart. A possible stop operation remains unbuilt and is not implied by adding this permission. |
| `core.configure` | Read and change Core configuration, including mounts, settings and ingress. Do not reintroduce separate mount/ingress permissions in this initial catalogue. |
| `core.logs` | Read Core logs. |
| `users.read` | Read user-management information within actor policy. |
| `users.manage` | Manage users and their access within actor policy; includes the reads needed for that management. |
| `apps.sources.full` | Access and work with other applications' source code. This broad source-development capability belongs to Harness; Shell must not require or optionally request it. |
| `apps.install` | Unified application installation, update and uninstallation capability. Preserve Core-owned confirmation for installation/update and independent actor checks; the permission does not authorize an app to approve its own request. |

This is 13 new capability names plus the broadened `apps.install` capability. The owner chose to
combine installation, update and removal rather than introduce `apps.uninstall` or retain a separate
`apps.update` in the target catalogue. Existing
`apps.skills.read`, `providers.speech-to-text` and `providers.assistant` remain outside this change;
they are not removed or implicitly granted by the new catalogue. No separate telemetry capability
was selected in this list; the combined resource snapshot and internal scrape use `apps.read`
and `core.read` rather than adding the earlier proposed telemetry permission.

`apps.configure` intentionally includes reading setting values: read-only access can already disclose
API keys, so it is not represented as a lesser setting permission. This applies to manifest/runtime
settings, not the separate app keychain. `AppSecretsEndpoints` continues to authenticate the owning
app's service token; configuring app A does not grant the caller app A's keychain token or another
app's keychain contents. Application-owned settings pages remain the preferred direction, with
Shell configuration retained for headless/utility applications.

Core remains responsible for sign-in, the primary browser session and final app-permission approval.
A calling app must hold the relevant confirmed permission and the user must independently be eligible
for the operation. These coarse grants must not be implemented by issuing a full Core session to Shell.
An app's own sign-in, grant validation and request for review of its declarations remain available
without management permissions. Core validates event visibility under the same permissions as reads.

### Installation-permission migration and bootstrap

The current `apps.install` grant covers installation requests, and `apps.update` separately covers
update requests. Reusing the installation name for the unified capability changes its authority.
The owner accepts that expansion on 2026-10-01: existing `apps.install` grants acquire the unified
meaning without repeated confirmation or a permission-definition versioning mechanism. Remove
retired `apps.update` entries rather than introducing an alias or automatically granting
`apps.install` to an update-only app. New declarations still follow ordinary permission review.
Define removal and any associated data deletion explicitly in the operation matrix and confirmation UI.

Use the canonical `CoreAppPermissions.Known` catalogue for an idempotent startup cleanup before
permission-dependent consumers start. Remove names absent from that catalogue from persisted
granted permission lists, saving only changed records through the registry's normal locking/write
path. Preserve required and optional declarations as evidence of the app's contract, even when
Core no longer recognizes their names. Retain all known grants, including capabilities outside this change.
Refresh the affected permission revision so an outstanding review cannot restore removed names.
Apply the same validation at grant writes and authorization checks so cleanup does not rely solely
on a restart. This cleanup only removes names; it does not infer replacement grants.

Account for installed manifest snapshots and source manifests that still declare retired names:
do not erase or ignore required declarations to make an incompatible app start. The owner's later
decision below supersedes the previously proposed legacy-declaration normalization. Do not rewrite
the application's source files. Newly submitted manifests must use supported names and receive a
clear validation error for unsupported declarations. Update first-party manifests in the same change.

Keep distribution bootstrap behavior unchanged: fresh trusted distribution installs receive their
required grants, without automatically selecting optional grants. Distribution membership does not
silently approve new permissions for an already installed app. Such changes still require review.

### Required permissions are launch preconditions (Owner Decision, 2026-10-01 — superseded)

Superseded by the owner's Part C decision on 2026-10-02. Required declarations
are setup diagnostics, not lifecycle preconditions. Remove launch gates and observer
stops across manual/restart/autostart/update/runtime-switch/retained workloads.
Keep per-call grant checks, unsupported-grant cleanup with revision invalidation,
observations, unsupported-name diagnostics, and Core-owned permission approval.
Only persisted grants confer permission authority; launching never grants declarations.

### Missing-permission notice and coordinated upgrade (Owner Decision, 2026-10-02)

Expose own permission state through the SDK server helper and a shared neutral/React
notice. Only administrators can request Core review. Unsupported required names require
an app/Core update instead; optional names never trigger the notice. Embedded requests
are resolved by Shell from the sending frame, not an app id supplied in the message.
Refresh after review and allow dismissal until reload. Adopt in Shell, Harness,
Marketplace and Telemetry UI.

Investigate coordinated Core/system-app upgrade and propose its concrete behavior to
the owner before implementing the upgrade change. Verify the approved approach with
the existing 0.116.0 upgrade fixture.

- C1 (done): Remove lifecycle permission gates and enforcement; verify launch without grants and per-call denial until approval, and document grant-only authority.
- C2 (done): Implement and adopt shared SDK missing-permission notice, including secure embedding and refresh tests.
- C3 (open, tracked under Deliverables): Propose coordinated upgrade/preflight, implement the approved option, and verify the upgrade fixture.

### C3 investigation and proposal (2026-10-02; owner selection pending)

`CoreRestartEndpoints` runs the CLI `update` command. `UpdateCommand` updates CLI,
stops Core with retained apps, replaces Core and starts it; `CheckCoreAndShellAsync`
then only prints a Shell update plan and an apply command. Its failure is a warning.
The current product channel pins a CLI version/release tag but only a local Shell
manifest path; it does not describe a compatible immutable system-app set. The prior
0.116.0 fixture verifies origin/adoption migration, not coordinated Shell compatibility.

Proposed preferred option, presented to the owner: ship a release-bound manifest and
artifact set for compatible first-party/system apps; preflight and stage it before
stopping Core, collect explicit approval for new authority, persist a resumable operation,
then apply the prepared app updates after the target Core becomes ready. Limit changes
to installed matching apps, preserve data and operator runtime/source choices, and surface
failure/recovery from Core even while Shell is unavailable. No implicit permission grants.
A stale plan or failed staging leaves the running installation unchanged. Since old Core
cannot parse the new manifest, the release/CLI layer must own target compatibility metadata
and preparation; asking old Core to validate the new manifest is insufficient.

The alternative offered is a preflight warning with concrete instance-specific CLI recovery
commands and documented Core-first upgrade order. The owner has not selected an option yet;
no updater changes or renewed 0.116.0 coordinated-upgrade acceptance are claimed in this batch.
The unchecked C3 deliverable above owns that remaining work.

### Source-permission migration

Current source work uses `apps.workspaces.manage`; Git publication uses `apps.publications.manage`
and also checks the workspace grant. Harness declares both today. The selected destination is the
broader `apps.sources.full` capability, not a cosmetic rename that preserves exactly the old authority.
Inventory and map local source inspection/editing, session workspaces, Git and PR operations into
this capability. Keep remote account ownership and resource checks: source access does not reveal
Git-provider credentials or authorize arbitrary operations on unrelated repositories.

Remove retired workspace/publication names through the same catalogue cleanup. Do not maintain
aliases for `apps.workspaces.manage` or `apps.publications.manage`, or infer `apps.sources.full`
from those removed names: Harness declares the new capability
and uses the ordinary declaration-review workflow. Update manifests, SDK/agent contracts and
revocation checks together. Expansion of an unchanged permission name does not require a separate
review in this transition, as explicitly accepted by the owner.

The separate equal-authority rename in [plan tracking](../plan-tracking/feature.md) changes
`apps.sources` to `apps.sources.full`; its legacy manifest alias and startup migration preserve
existing reviewed declarations and grants. `apps.sources.read` reads only repository documentation
and workspace document changes as an administrator and confers none of this mutation authority.

Shell must not declare `apps.sources.full`, even optionally. Harness performs source inspection/editing
and publication. Runtime selection, including selecting development mode without editing source
files, belongs to `apps.lifecycle`; do not require a source grant just to use that selection UI.

Private-source app requests require `apps.install` plus either `apps.sources.full` or
`sources.connections`, including updates that retain existing private bindings. Core checks the
acting connection owner, and rechecks the effective grants
permissions before submission and execution. Clearing a binding also requires source authority.
Shell owns installation and selection/rebinding UI without gaining `apps.sources.full`.
The host-wide telemetry scrape requires `apps.read` plus `core.read`, like the resource snapshot.

### Sandbox is deferred

`apps.sandbox` is a candidate for a later capability, not part of the active initial catalogue or a
permission to implement now. The owner deliberately defers this to
[app sandbox runtimes](../app-sandbox-runtimes/plan.md). Worktree/source access is not authority to
start an isolated test instance and does not itself provide isolation.

The eventual runtime needs its own data, settings, environment and replacement mounts. It cannot
silently inherit production mount paths or credentials. Dependencies such as a separately installed
MongoDB need explicit test instances, mocks or supplied endpoints; arbitrary app internals and
hard-coded external connections cannot be discovered reliably. Separate directories alone do not
justify a claim of complete sandbox isolation. That feature owns its execution guarantees and
unresolved dependency/runtime design, not this authentication change.

### Operation mapping

The management matrix below covers removal and data-removal options, mount metadata, notifications,
runtime/source/feed operations and mixed requests. Resource snapshots and the internal telemetry
scrape require both `apps.read` and `core.read`. Private-source requests also require `apps.sources.full`
and the connection owner, including cached plans and bindings that the request retains or clears.
Shell's declarations exclude source authority; Harness requests `apps.install` optionally.
Completing the mapping does not establish the remaining browser/provider acceptance.

### App assignments, including Shell (owner decision, 2026-10-01)

The owner explicitly chose administrator-controlled assignments instead of a manifest audience
(`all users` / `administrators`). An enabled administrator can access every installed app; an enabled
ordinary user can access only explicitly assigned apps, including system apps and a replacement Shell.
The system role alone neither grants nor prohibits user access. Do not add a Shell-name exception.
The user-role check on administrative operations remains independent of app access and app grants.
The owner explicitly deferred configurable per-user management permissions: keep the existing
administrator/member model during this migration; do not add user permission sets or new roles.

A user assigned to an ordinary app but not Shell signs in from that app's standalone origin through
Core and returns to that same app. Shell is not a prerequisite for authentication. Core binds the
continuation to the target app and checks its registered endpoint/public/local browser origins,
never the union of every app's origins. A public origin does not require an ingress provider.

### Management transport mapping (2026-10-01)

The generic server-to-server management transport carries the calling app's service bearer token
and `X-Hosty-App-Identity` containing its existing opaque user grant. Core resolves the caller from
its signed service token, revalidates the grant for that app and checks current persisted permissions
on every request. Existing user-role/assignment checks still apply. Unmapped routes deny app callers;
app credentials cannot fall back to a simultaneously supplied full Core cookie.

- `apps.read`: app inventory/state, health, update status and declared display assets. Settings and
  mount bindings are omitted without `apps.configure`; app source files require `apps.sources.full`.
- `apps.logs`: application logs. `apps.notifications`: the acting user's app and host notifications
  and read acknowledgements. The combined event stream requires the permissions for every included
  class of events and revalidates while connected.
- `apps.lifecycle`: start/stop/restart, autostart, reviewed runtime selection, clearing a source
  override and worktree summary metadata. Selecting any source folder through an app, including
  a registered worktree, requires Core confirmation. Source file diffs/discards require `apps.sources.full`.
- `apps.configure`: settings (including sensitive values), port reassignment, app mount bindings and
  backups/restores/deletion. A mixed configure request that also changes autostart requires lifecycle.
- `apps.install`: reviewed installation/update/removal requests, feed selection and update checks.
  App-requested removal requires the same isolated Core confirmation, with frozen deletion options
  and target installation identity. Core displays data, backup, source and runtime-state cleanup,
  dependencies and publication impact. Direct removal stays available to trusted operator clients;
  app credentials cannot invoke it, including when the caller is Shell.
- `core.read`: Core state, development target and operation/update status. `core.lifecycle`: restart.
  `core.update`: update. `core.configure`: Core settings, source-target configuration, shared-mount
  registry and ingress. `core.logs`: logs. Mount metadata does not grant filesystem read access.
- `users.read`: user/assignment/invitation metadata. `users.manage`: invitations, user changes and
  assignment changes, retaining user-role restrictions. Neither grants primary session credentials.
- `apps.sources.full`: source status/diffs/discards and existing workspace/publication APIs, preserving
  repository/account ownership checks; current-user source-provider connections and installed
  private-source bindings. Private-source installation/update also requires `apps.install`.
  Shell declares no source permission. Ordinary self-profile reads/edits need app identity only.
- Password/session creation, personal credential issuance, OAuth/device approval, connection secrets
  and cross-app user-token issuance remain Core-owned. Generic management grants do not authorize
  them. Shell must navigate to the corresponding Core surface for these operations.

## Deliverables

### Source and mount authority correction (approved 2026-10-02)

The owner explicitly approved this extension on 2026-10-02, including mounts and the global
registry. The implementation remains in the existing working tree on `main`, with no commits or
branch moves. Source override is a rare, temporary escape hatch; keep it small and reuse Core
confirmation rather than building another workflow. Possible removal of override is a direction,
not part of this implementation. Update reality documents with the completed behavior.

Verified baseline:

- `apps.lifecycle` currently admits app-token `POST /api/apps/{appId}/source/override`.
  `AppSourceService.SetLocalOverrideAsync` accepts an existing directory; live `localCommand`
  manifests can change the host command without a new review. Override/clear handlers call the
  source service directly, outside CoreLifecycleService's per-app operation lock.
- Harness's `DevelopmentClient` uses session-scoped workspace/publication endpoints. No direct
  source-override or runtime-switch caller exists in its current TypeScript implementation.
  Its native agents still have cooperative OS access; app-token policy does not sandbox them.
- DevelopmentWorkspaceService stores installation/user/session ownership, app installation and
  manifest-subpath bindings, canonical repository identity and actual Git-worktree metadata.
  A path prefix or matching remote URL alone is insufficient evidence of a managed workspace.
- MountPathPolicy already rejects paths inside the Hosty data root, including symlink targets.
  However, it does not reject an ancestor directory exposing that root as a descendant.
  Arbitrary permitted external paths still require an explicit app-delegation decision.
- The global mount registry is currently writable through app credentials with `core.configure`.
  It cannot be treated as exclusively operator-approved until that mutation path is restricted.

Approved behavior:

1. Owner revision approved on 2026-10-02: keep `apps.lifecycle` for start/stop/restart,
   autostart, reviewed runtime selection and clearing an override, without extra confirmation.
   Every app-requested source override requires Core confirmation, including registered worktrees.
   This supersedes the earlier workspace exception. CLI/direct Core operators retain direct source
   selection subject to the shared path restrictions. Shell does not receive `apps.sources.full`.
2. Apply a shared real-path prohibition to every override writer, including CLI, bootstrap and
   Core approval. App storage/source trees and host directories exposed through external/global
   container mounts are not
   eligible override sources. Include symlinked ancestors, effective manifest subpaths and retained
   app directories. The app-facing override route always returns HTTP 403 `source_override_confirmation_required`.
   Preparing a review or a direct operator mutation rejects protected locations outright
   (`source_override_path_forbidden`); no approvable plan exists for them. This resolves the proposal's contradictory expectation
   that an app data directory should both require confirmation and be unconditionally forbidden.
3. Add a source-override plan (the source variant of `HostPathApprovalPlan`) to the existing Core approval flow, authorized by `apps.lifecycle`
   rather than `apps.install`. Freeze requester/actor, target installation/source revision, canonical
   directory, effective manifest path/digest, repository and development runtime command details.
   Core explains that the folder's current and later changes can execute commands on the host.
   Under the same per-app operation lock used by lifecycle verbs, revalidate the caller, target,
   real path, protected-path policy and manifest digest before setting the override. Set and clear
   paths must share that lock so direct API/CLI requests cannot race the reviewed apply.
   Denial, expiry, replay or stale state leaves the source unchanged. No confirmation on each restart.
4. Shell tries the app-authorized selection once; only the structured confirmation-required result
   opens Core's review. A protected-path denial is shown as an error and cannot be approved away.
   Preserve blocked-popup recovery and status polling, and do not claim the override changed while
   approval is pending. Do not add a Shell-specific authorization exemption.
5. Describe `apps.lifecycle` as ordinary lifecycle/runtime control with source changes requiring Core confirmation, and
   `apps.sources.full` as authority to change code Hosty can execute on the host in development mode.
   This is an app API trust boundary, not filesystem isolation or a sandbox for native processes.
6. Before treating registered global mounts as a confirmation-free choice, make adding/repointing
   their host paths through app credentials require Core confirmation as well. Otherwise
   `core.configure` can register an arbitrary path and bypass external-mount consent. Trusted
   operator CLI/Core changes retain their explicit authority. Reject mounts exposing the Hosty data
   root through an ancestor path. Check both orderings of mount/source selection so a previously
   approved source directory cannot later become app-writable through an unreviewed mount change.
   Existing intentional development source mounts need their own explicit treatment, not a blanket
   ban that silently disables Docker development. Arbitrary external app mount bindings use Core
   confirmation; selecting an already approved global entry retains the simple workflow.

Deliverables for this extension:

- [x] D1. Owner approval of the source policy and the mount/global-registry scope above.
- [x] D2. Implement shared real-path source classification and unconditional protected-path denial;
  verify compatibility with source bootstrap and existing operator folders.
- [x] D3. Require Core confirmation for every app source override, remove the worktree exception,
  and preserve direct operator workspace selection and Harness workspace APIs (owner revision, 2026-10-02).
- [x] D4. Implement frozen Core source-override plans, caller revalidation, nonce/expiry/replay checks,
  command/ongoing-trust disclosure and stale-plan refusal under that same lock.
- [x] D5. Migrate Shell source selection to the confirmation flow and update permission descriptions.
- [x] D6. Add HTTP/service tests for app data and symlink denial, mandatory app confirmation including worktrees,
  direct operator workspace selection, operator denial of protected paths, changed manifest,
  symlink retargeting, reinstallation, concurrent set/clear, revoked caller, denial and expiry.
- [x] D7. Close arbitrary external mount delegation, app-mediated global-registry bypass and ancestor
  exposure of the Core data root; cover mount/source ordering and approved development mounts.
- [x] D8. Build affected artifacts, run focused source/workspace/approval/mount and Shell tests,
  update runtime-source, workspace, mount and approval documentation, and verify artifact versions.

Verification of the 2026-10-02 lifecycle revision: `dotnet test` with isolated artifacts and
filters for CoreLifecycleServiceTests, HostPathApprovalHttpTests, AppManagementHttpTests and
InstallationApprovalStoreTests passed 595 tests (4 opt-in Docker/VPN tests skipped). After extending
the HTTP case to allocate a real registered worktree, the focused approval/operator suite passed
10 tests. Core built successfully; Shell's confirmation-flow component suite passed 7 tests.
Version consistency, documentation index and whitespace checks passed. No live Core restart or
browser login QA was performed for this revision; browser acceptance remains tracked below.

### Approved implementation

- [x] D9. Close the app-delegated removal bypass through Core-owned confirmation; freeze cleanup
  options and target identity, migrate Shell, and verify denial/replay/stale consent and trusted
  operator compatibility (owner-requested correction, 2026-10-02).

- [x] D10. Apply assignments uniformly to system and ordinary apps, including Shell; cover standalone login
  without Shell access, user-role restrictions on management, and revocation after assignment removal.

- [x] D11. Remove development login impersonation and direct session creation; remove development-user
  seeding, document setup/recovery and test-fixture boundaries, and verify password login plus bypass
  rejection in Development and Production, including an isolated browser check.
- [x] D12. Approve the canonical local browser-origin policy and finalize the deterministic app-hostname mapping.
- [x] D13. Trace the Safari failure and verify the existing Core-owned navigation/code/grant flow without
  assuming a new permission catalogue is necessary. Resolution support alone is insufficient.
- [x] D14. Select the initial coarse permission catalogue and names with the owner.
- [x] D15. Register the catalogue, consolidate installation/update and workspace/publication checks,
  and update Shell/Harness declarations. Management API enforcement remains in the migration below.
- [x] D16. Complete the per-operation mapping, installation/source-grant migrations and required/optional declarations
  under the selected catalogue, including mixed private-source requests and telemetry reads.
- [x] D17. Implement and test idempotent removal of unsupported stored grants at startup and write-time
  validation; preserve manifest declarations for diagnostics and preserve known grants, and
  reject stale reviews without requiring renewed approval for unchanged names whose scope expands.
- [x] D18. Move Shell to the common app identity/permission transport, remove its privileged browser-session
  exception, and preserve Core-only confirmation. Cover revocation, expiry, callback security and denied
  operations with generic app tests, including a replacement Shell client.
- [x] D19. Implement shared local/browser/transport origin resolution, including explicit-origin
  precedence and collision-safe app identities, without changing runtime port allocation.
- [ ] D20. Integrate Core browser links, Shell navigation, endpoint projections, app identity redirect
  validation, runtime browser environment and affected SDK consumers with the shared policy.
- [ ] D21. Provide safe legacy local entry navigation and fresh-session migration; preserve configured
  public origins, direct API/control traffic, OAuth/MCP behavior and native clients. Include browser
  profiles that retained redirects to a previous instance, as observed in the Safari QA run below.
- [x] D22. Handle upgrade of running apps with old origin environment explicitly; verify both a clean
  install and an existing installation after the required lifecycle transition.
- [ ] D23. Verify login/logout, setup/recovery, Shell, standalone and embedded apps, installation/update,
  required/optional permission approval and revocation, and relevant popup/speech behavior with
  no public-origin settings and no external DNS/internet dependency.
- [ ] D24. Verify isolation: app servers do not receive Core's session cookie; shared-host and foreign-
  origin decisions, foreign redirects, replay and stale approval requests remain rejected.
- [ ] D25. Run the supported browser/OS matrix, including a WebKit client and Docker/localCommand runtimes;
  record unavailable environments as unfinished verification rather than passing acceptance.
- [x] D26. Resolve native Linux Docker-to-Core reachability under the default loopback listener and
  verify Shell callback/recovery revocation, renamed origins, late Docker availability, default
  and per-app networks. Keep the broader standalone/embedded browser checks in the acceptance
  deliverables above; do not broaden the default listener to all interfaces.
- [ ] D27. Exercise the published installer on a clean machine and submit the setup/recovery forms
  interactively in a browser; clean-data source/AOT initialization and HTTP submissions are covered
  by the 2026-10-01 acceptance pass below.
- [x] D28. Bump changed release artifacts; update the owning feature documents, create the reality document,
  and regenerate the index. All touched owning documents already use feature folders.
- [ ] D29. Finish acceptance, update the final reality document and delete this plan only when every remaining
  deliverable is complete.
- [x] D40. Restore HTTP sign-in on canonical localhost names with a Core-origin storage-bound nonce, exact-origin POST continuation and no cookie fallback; verify real Chromium/Safari login plus relay, parent-domain injection, replay, capacity and existing HTTPS/IP regressions, then update the owning reality documents.

### Remaining client migration details

The embedded recovery implementation uses a user-opened Core popup. Core validates the app's
registered redirect origin and returns a one-use app code directly to its opener with an exact
target origin. The app checks the Core origin, popup window reference and a random initiation state
before exchanging the code. Shell never handles these messages or credentials. The app keeps the
returned app grant in document memory for same-origin API requests when iframe cookies are blocked;
no primary Core credential or persistent browser token storage is involved. Standalone navigation
continues to use an app HttpOnly cookie. Session denial and unavailable Core remain distinct states.

- [x] D30. Replace all four Shell launch-code issuance call sites with common app-owned embedded recovery;
  verify Safari cookie restrictions, exact popup/message targets, initiation binding and replay.
- [x] D31. Complete embedded recovery acceptance with password entry inside the popup, API-triggered
  revocation recovery without reload, and the non-privileged sandbox flow in Safari.
- [x] D32. Check remaining first-party SSR-only consumers and migrate their protected client API requests
  to the common app-grant transport; verify both standalone and embedded content.
  Demo App now loads overview, people, roles and panel user data after app authentication,
  prioritizes explicit bearer identity over stale cookies, and keeps role mutations and JSON
  inspection on `appFetch`. Marketplace, Telemetry and Harness already use this transport.
- [x] D33. Separate Harness's own app credential for workspace/source operations from its cross-app MCP
  credential; ordinary chat must not gain cross-app access from an app login. This preparation is
  independent of the assistant-target authorization below (owner requested continuation on Harness).
- [x] D34. Complete Harness MCP authorization with Core-owned assistant-to-target grants. On 2026-10-01
  the owner approved this model instead of a blanket MCP permission or separate per-user consent.
  The existing host-wide offers remain an upper bound for all consumers; they do not automatically
  grant any assistant access. Administrators explicitly assign installed assistants to targets.
  Grants bind both installation identities and are checked by Core at issue and use.
- [x] D35. Issue a distinct MCP-only credential carrying the calling assistant, target and acting user;
  revalidate current app identity, target access and grant. Ordinary app APIs must reject it.
  Core MCP retains its own operation permission checks. Update SDK/reference consumers and Harness.
- [x] D36. Expose assistant-target grants in the existing Agents settings and verify issuance/refusal,
  revocation, reinstallation, target/identity spoofing and ordinary-API rejection. Verify a
  Core-managed embedded Harness tool call and update the owning documentation.
- [x] D37. Verify Shell's server-side assistant handoff against a real Core-managed provider, including
  optional `providers.assistant` approval/revocation and retries after an uncertain response.
- [ ] D38. Complete Shell profile, Harness source-selection and Core confirmation browser acceptance, including installed private-source
  update recovery; deterministic provider fixtures do not prove a real external account integration.

### Missing-permission notice and coordinated upgrade

- [ ] D39. C3: Propose coordinated upgrade/preflight, implement the approved option, and verify the
      upgrade fixture.

## Phases

1. Confirm address policy and browser support, then implement shared origin resolution with tests.
2. Wire clients, identity, runtime environment and migration on the same branch.
3. Complete default-install and upgrade acceptance, documentation and version alignment in one PR.

## Verification

- Unit tests: canonical names, ports, explicit overrides/reset, old records, normalization and
  collision handling; browser projections never replace internal transport URLs.
- HTTP tests: real login continuation and session binding; Shell CORS/CSRF; app-code redirect
  allowlists; permission-only approval, installation/update and the existing rejection boundaries.
- Browser tests: fresh and upgraded Core-managed local installations; actual cookies received by
  Core and app servers; Shell and embedded app sessions; no repeated host-switch login loops.
- Build and test all affected artifacts, including Core, CLI, Shell and any SDK/runtime app whose
  code changes. Run `node scripts/check-versions.mjs`, `node scripts/docs-index.mjs --check` and
  `git diff --check`. Complete Core's prescribed build/test/restart/readiness loop if deploying locally.

## Reference Constraints

- [RFC 6761, section 6.3](https://www.rfc-editor.org/rfc/rfc6761.html#section-6.3) reserves localhost
  names for loopback use; this does not by itself prove support in every browser/OS combination.
- [WebKit issue 160504](https://bugs.webkit.org/show_bug.cgi?id=160504) documents historical
  `.localhost` resolution differences and reports support in macOS 26. Verify the supported matrix
  rather than assuming an OS-independent resolver.

## Verification Recorded

- `dotnet test apps/core/tests/Haas.Hosty.Core.Tests/Haas.Hosty.Core.Tests.csproj --no-restore`:
  2,247 passed, 4 opt-in integration tests skipped, 0 failed. Two subsequently added identity/migration
  regressions passed in the focused `LocalBrowserOrigins|AppIdentityServiceTests` run (43 passed).
- `dotnet test apps/cli/tests/Haas.Hosty.Cli.Tests/Haas.Hosty.Cli.Tests.csproj --no-restore`:
  223 passed.
- `npm run test --workspace @haas/hosty-shell`: 177 Node tests and 45 Vitest tests passed.
- `npm run build --workspace @haas/hosty-shell -- --webpack`: passed.
- `npm run lint --workspace @haas/hosty-shell`: 0 errors; 2 pre-existing navigation warnings.
- Exact Core project `dotnet build --no-restore -o /tmp/hosty-local-origins-final-bin`: passed.
- Version consistency, generated docs index and diff whitespace checks: passed.
- Isolated Core-managed localCommand Shell: Chromium bare-localhost entry, login, dashboard and
  required-permission form passed. Removing the legacy runtime origin marker displayed Restart required;
  an explicit Core-managed app restart cleared it and retained the authenticated dashboard.
- Safari: DNS and Core's own session passed; Shell session flow failed as described above.
- Firefox, Windows/Linux browser matrix, real Docker acceptance, embedded-app and speech acceptance
  remain unexecuted. The 4 opt-in Docker/telemetry/VPN integration tests were not enabled.
- The operator's active installation was not restarted or migrated; only a separate temporary instance
  was used. No commit or PR was created.

### Permission lifecycle batch (2026-10-01)

- `dotnet test apps/core/tests/Haas.Hosty.Core.Tests/Haas.Hosty.Core.Tests.csproj --no-restore`:
  2,263 passed, 4 opt-in integration tests skipped, 0 failed (2,267 total).
- `dotnet test apps/cli/tests/Haas.Hosty.Cli.Tests/Haas.Hosty.Cli.Tests.csproj --no-restore`:
  223 passed, 0 failed.
- `npm test --workspace @haas/hosty-shell`: 177 Node tests and 46 component tests passed.
- `dotnet build apps/core/src/Haas.Hosty.Core/Haas.Hosty.Core.csproj --no-restore`: passed.
- `npm run build --workspace @haas/hosty-shell -- --webpack`: passed.
- Shell lint: no errors; the two existing navigation warnings remain.
- Version consistency, generated documentation index and diff whitespace checks passed.
- Runtime changes were tested through Core lifecycle services and recording adapters; Core-owned
  recovery uses the real HTTP test pipeline. No new managed-browser acceptance or deployment was
  performed for this batch. The Safari and management-transport deliverables above remain open.

### Local runtime and browser acceptance (2026-10-01)

- Built and launched the exact source Core project through CLI-managed isolated generations under
  `/tmp/hosty-local-origins-qa`, port 27070. Shell ran as a Core-managed localCommand app on 27171;
  a synthetic app-identity fixture ran on 27272. The operator's installation was not restarted.
- A missing required grant prevented Shell startup. Revoking `apps.read` while Shell was running
  stopped the real process and closed its port in 3.55 seconds; relaunch returned
  `app_permissions_required`. Core-owned review restored the grant without a running Shell.
- Foreign-origin approval POST and nonce replay were rejected. Chromium reached the authenticated
  dashboard through a bare-localhost entry and the generated app hostname. Core's primary cookie
  was HttpOnly, SameSite=Lax and scoped to the Core hostname.
- Adding an unsupported required declaration to the live manifest stopped the process and refused
  restart. An unsupported optional declaration did not prevent startup or stop the running app.
- With apps kept alive across Core restart, startup removed an obsolete stored grant while preserving
  the required declaration, adopted then stopped incompatible Shell, and preserved the healthy
  identity fixture's PID. The replacement Core's PID, start identity, source project and readiness
  were verified. This found and fixed autostart overwriting `blocked` with `failed`; the corrected
  status was verified on a further source Core restart.
- Safari 27 on macOS 27 resolved the generated names and opened Core-owned permission recovery
  while Shell was stopped. Web Inspector isolated the missing cross-site Core cookie described in
  the acceptance blocker. Shell still loops to login; Safari acceptance is **not** complete.
- A Core-managed synthetic app exercised top-level Core navigation, one-time authorization-code
  exchange, its own HttpOnly app cookie and service-authenticated grant revalidation. Safari and
  Chromium both returned `appSessionAuthenticated: true`, `grantRevalidationStatus: 200` and
  `coreCookieReceived: false`. Safari retained this app session across Core restart. This verifies
  the existing common flow, not the unfinished Shell transport or embedded-app acceptance.
- The two Docker opt-in tests passed with `HOSTY_TEST_DOCKER_DEVELOPMENT=1` and the filter
  `Telemetry_CoreManagedMixedProfileIngestsAndAuthenticatesReads|DockerDevelopment_CoreManagedMixedLifecycleReloadsSourceWithoutRebuilding`.
  The first telemetry attempt collided with the operator's existing Next dev lock; repeating with
  `NEXT_DIST_DIR=.next-hosty-permission-qa` isolated the build and passed. Only test-generated Next
  output/config changes were removed. Existing services were left running.
- After the autostart fix, the exact Core project build passed; lifecycle and supervisor tests
  passed (543 passed, 4 opt-in tests skipped). The two Docker tests above were executed separately.
  Version consistency, documentation index and whitespace checks passed.
- QA Core and both managed app ports were closed after verification; the temporary Chromium and
  Safari tabs were closed. Logs and synthetic fixtures remain under `/tmp` for reproduction.
- Firefox and the Windows/Linux browser matrix remain unexecuted; no such local browser/OS is
  available. The two torrent/VPN integrations were not enabled: the dedicated companion checkout,
  authorized test VPN directory and legal torrent fixture were not supplied. Full management API
  enforcement, Shell migration, embedded-app and popup/speech acceptance remain open above.

### Removal of development login bypass (2026-10-01)

- `/login` now verifies email/password regardless of the ASP.NET environment. Removed direct
  `POST /api/auth/session`, its request DTO and JSON metadata, and the user-selector renderer.
  HTTP fixtures already seed isolated stores in-process; no replacement public test route was added.
- `scripts/dev-local.mjs` no longer seeds users or re-enables/promotes existing accounts. A launcher
  check with a stubbed dotnet process verified both a fresh root without generated users and an
  existing disabled non-admin whose state remained byte-for-byte unchanged.
- Updated README, repository agent instructions, local development/password/API/auth feature docs
  and app-authoring skill references. Setup targets the explicit development data root; passwordless
  legacy accounts use recovery. Browser acceptance must use password login.
- Full Core suite: 2,274 passed, 4 opt-in integrations skipped, 0 failed. New HTTP coverage exercises
  Development and Production: valid login and continuation, no account enumeration in the form,
  rejected direct session creation/user-id-only login, wrong password, disabled user and missing
  credential. Exact Core build and development-script syntax check passed.
- A fresh CLI-managed source Core under `/tmp/hosty-password-login-qa` ran in Development on 27071.
  Normal setup created a synthetic account. Real HTTP rejected direct session POST with 405 and
  user-id-only login with 403, without issuing cookies. Chromium's real password form rejected a
  wrong password, accepted the correct one, and subsequently returned `authenticated: true` from
  Core. This replaces the earlier development-selector check as password-login evidence.
- Test Core/browser were stopped after verification; the operator's installation was not restarted.
  The existing 0.117.0 platform version bump covers this batch. Shell transport migration and the
  broader browser acceptance checklist remain unfinished.

### Core-owned account and Shell transport batch (2026-10-01)

- Shell uses an app-bound HttpOnly cookie and a same-origin API handler carrying the app service token
  plus user grant. Callback state, audience mismatch, foreign mutation origins, path traversal,
  credential/header stripping and expiry are covered by tests. SSE revalidates current grants and
  captured role before queued events; revocation and role downgrade close the stream.
- Core serves `/account`, `/account/tokens`, `/account/sources` and `/oauth/consent`, including its own
  static assets. Profile/provider credentials, personal-source choice, device/token management and
  OAuth approval no longer depend on Shell. OAuth optional scopes start unchecked. Shell links to
  these surfaces; another app's permission review goes directly to Core.
- Shell declares no `apps.sources.full`; source contents and workspace mutations are no longer requested
  from its dashboard. It links to authorized source tools. Its assistant handoff server uses the
  existing optional `providers.assistant` permission and never returns provider tokens to script.
- Full Core suite after the source page and CORS tests: 2,314 passed, 4 opt-in integrations skipped,
  0 failed. Final Shell run: 177 Node tests and 69 component/handler/DOM tests passed. Exact Core
  build and Shell production webpack build passed. After the consent-default change, 154 focused
  authentication/management/installation/provider/OAuth tests passed. After the final Core CSS
  correction, the exact Core build and 19 password/account HTTP tests passed. Shell lint reported
  no errors and the two existing navigation warnings.
- On the temporary Development installation, Chromium and Safari passed real password login into
  Shell and its authenticated dashboard. The Core account page also opened with the Core session.
  The Next internal-listen-address callback loop was fixed and covered by regression testing.
- Chromium exercised Core profile, token management and source review. An explicit preparation
  using a synthetic local manifest displayed runtime, settings and required/optional permissions;
  continuation opened its bound Core confirmation. Cancellation installed nothing and granted no
  permissions. Installed live-source review correctly requested runtime adoption through restart.
  Real private-provider credentials and an external private-source update were not exercised.
  The final CSS correction for hidden provider fields has regression coverage but was not redeployed
  for another browser pass.
- The installed CLI's source restart defaulted to port 7070 when `--port` was omitted and the
  replacement failed to bind. Explicit source start with `--port 27071` recovered the temporary
  instance; status confirmed the expected source project, data root and generated browser origin.
  The operator's existing listener was unaffected. Both temporary Core and Shell were stopped
  afterwards, and ports 27071/27172 had no listeners. Fixtures and logs remain under `/tmp`.
- No operator installation restart, commit or PR was performed. Remaining client and platform
  acceptance deliverables above stay open.

### App-owned embedded login batch (2026-10-01)

- Core supports a browser-only `web_message` app-open response with an exact target origin and
  caller state. The SDK verifies popup identity/origin/state and exchanges/revalidates the one-use
  code through the app. The app-only bearer stays in document memory; same-origin `appFetch`
  handles cookie-restricted frames and 401 recovery. Shell no longer requests launch codes.
- Marketplace and Telemetry use the common request transport. Harness browser identity uses the
  same bridge and its own app grant, with current administrator checks. App login deliberately
  does not supply a cross-app MCP seed; the consent decision above remains open.
- SDK: 138 tests passed and package build passed. Core: exact project build passed with four
  existing warnings; 90 focused password/management/delegation/endpoint tests passed. Shell: 177
  Node and 69 component/handler tests passed, production webpack build passed. Marketplace: 104
  tests passed. Telemetry: 10 tests and production webpack build passed.
- Harness: 460 of 461 tests passed in the full run; one existing HTTP gateway test lost its socket.
  The affected gateway file and new app-session suite then passed together (58 tests). The nine new
  cases cover current actor roles, stale-cookie precedence, own-app code validation and refusal to
  treat app identity as MCP authority. This records the transient full-run failure rather than
  presenting that run as green.
- Final Harness TypeScript check, Harness web webpack build and Marketplace webpack build passed.
  An attempted default Marketplace Turbopack build could not bind its internal sandbox port; the
  explicit webpack build succeeded. Version consistency, documentation index and diff checks passed.
- On the separate `/tmp/hosty-password-login-qa` localCommand installation, embedded Marketplace
  sign-in passed in Chromium and native Safari 27. A second Marketplace fixture without
  `apps.install` passed in Chromium with the ordinary iframe sandbox. Core logout invalidated its
  app grant on reload; after normal password login in a separate Core tab, popup recovery succeeded.
  Both fixtures displayed the expected no-catalog state; no external catalog/install was exercised.
- Password entry inside the popup was not completed: the in-app browser exposed no controllable
  popup tab. Native Safari use was stopped after user interaction interrupted the test. The successful
  Safari check used an existing Core session; no broader popup/password acceptance is claimed.
- Temporary Core and all three QA app processes were stopped. Ports 27071/27172/27173/27174 had no
  listeners. Operator Core/Shell and remote hosts were not restarted. Test fixtures remain in `/tmp`.

## Version Outcome

Platform 0.116.0 → 0.117.0; Shell 0.91.0 → 0.92.0; Harness 0.39.0 → 0.40.0;
Marketplace 0.5.1 → 0.6.0; Telemetry 0.11.0 → 0.12.0. JavaScript SDK 0.18.0 → 0.19.0; .NET SDK 0.7.0 → 0.8.0; Demo App 0.11.2 → 0.12.0.
These are working-tree changes, not a released or accepted feature.

### Source-provider settings migration (2026-10-01)

- Basic `/api/profile` now returns ID/email/display name only and edits only display name. Source
  metadata and Git identity use `/api/source-connections`, requiring `apps.sources.full`, the current
  administrator and owner checks. Device authorization resolves the parent browser session inside
  Core; no primary credential or stored provider token is exported.
- Harness settings has Source providers alongside Agent providers, using its restricted same-origin
  server transport. Shell removes provider forms and selectors and links to authorized source apps.
- Core: 134 affected tests passed again after the final permission-description/error-mapping edit;
  exact Core build and `dotnet publish -c Release -r osx-arm64` Native AOT passed (four existing
  Core warnings, no errors). Harness: 468 tests passed, followed by
  50 gateway HTTP tests including the added route/CSRF/credential boundary case. Harness TypeScript
  and webpack production build passed. Shell: 177 Node tests and 64 component tests passed;
  webpack build passed. Shell lint passed with three existing warnings outside this batch.
- Chromium, isolated Core-managed instance `/tmp/hosty-password-login-qa`, Core 27071 / Shell 27172 /
  Harness 27175: used a previously password-authenticated Core session, opened Harness through Core,
  saved synthetic Git attribution and verified persistence after reload. The same source-provider
  settings and values rendered in the Shell iframe. The ordinary Shell profile displayed no source
  fields. An unconfigured provider correctly disabled device sign-in and offered PAT fallback.
- No live GitHub/DevOps authorization or real provider token was used. Provider protocol/renewal
  behavior is covered by deterministic fixtures; native Safari was not repeated for this UI batch.
- Browser tabs and the temporary Core/apps were stopped after verification. The operator instance
  was not restarted. Private-source installation/rebinding and Harness MCP delegation remain
  unchecked deliverables above; this batch does not grant those capabilities implicitly.

### Harness credential separation (2026-10-01)

- Harness keeps its own app grant in memory for source/workspace operations and activity leases,
  separately from the legacy cross-app MCP seed. App grants are never sent to delegated-token
  exchange. Starting an app-authenticated turn drops any previous cross-app seed and reports that
  other applications' tools are unavailable. Ordinary chat and draft handoff no longer require that seed.
- Full Harness suite: 472 tests passed across 58 files. TypeScript check passed. Regression coverage
  verifies source-operation/lease credential selection, no credential persistence, no app-grant
  exchange, and an accepted app-session chat through the real HTTP server.
- On the isolated Core-managed instance, Chromium opened Harness inside Shell and sent a normal
  message. The deterministic fake provider returned its echo and the missing-MCP-authorization
  notice appeared. This verifies app authentication, embedding and chat dispatch; it does not verify
  live Claude/Codex execution or cross-app tools. No web or Core code changed in this batch.
- The consent choice above remains open. Source-provider UI, source operations and ordinary chat
  do not establish authority to call other applications' MCP endpoints.

The browser persistence rule in the preceding historical batches is superseded by
[embedded app sign-in](../embedded-app-sign-in/feature.md): embedded documents store only their
own grant in app-origin `sessionStorage` for the tab, restore it after frame recreation, clear it
on identity rejection and keep it on `reauth_required`. Harness now has protected-settings browser
transport regressions for that boundary. Its existing no-credential-in-durable-session-records
regression remains: server-side transcript storage still contains no app grant or MCP seed.
- Temporary browser tab and Core-managed QA processes were stopped; ports 27071–27175 had no
  listeners. Version consistency, documentation index and whitespace checks passed. The operator
  installation was not restarted; no commit, release or deployment was performed.


### Assistant-specific MCP authorization (2026-10-01)

- Core owns explicit assistant-to-target assignments under the existing host-wide offer policy.
  Existing offers grant no assistant access automatically. Shell exposes these assignments in
  Settings → Agents; neither a blanket MCP permission nor another user-consent screen is added.
- Harness exchanges its own current app grant plus its service credential for a five-minute
  MCP-only token. Core binds caller, target, user, both installations and the grant revision, and
  revalidates the parent session and current user access online. Revocation/regrant never restores
  old tokens. The app-facing directory omits other assistants' assignments. Legacy delegated
  tokens cannot branch to another audience. Core tools retain individual app permission checks.
- JavaScript and .NET SDKs provide explicit MCP introspection helpers; ordinary introspection
  rejects this token format. Demo App uses the MCP helper. Existing external MCP handlers need
  the updated helper before accepting these credentials; generic API authentication stays unchanged.
- Full Core suite: 2,318 passed, four opt-in tests skipped, zero failed. The first full run caught
  two endpoint guardrail failures (missing service authentication was checked after body validation);
  these were fixed before the passing full rerun. After the final directory privacy/revision edit
  and additional legacy chain-lifetime case, 24 focused Core HTTP tests passed. The final exact
  Core project build passed with zero errors.
- `npm test --workspace @haas/hosty-harness`: 473 passed across 58 files.
  `npm test --workspace @hosty-sdk/app`: 139 passed; SDK build passed.
  `dotnet test packages/app-sdk-dotnet/HostySdk.App.Tests/HostySdk.App.Tests.csproj --no-restore`:
  56 passed. The SDK multi-target build passed with 11 existing documentation warnings.
  Shell: 177 Node tests and 65 component tests passed; production webpack builds of Shell and
  Demo App passed. Harness TypeScript and Shell lint passed (three existing Shell warnings).
- Chromium, isolated Core-managed `/tmp/hosty-password-login-qa`: normal password authentication,
  an explicit administrator assignment and the real Harness loopback MCP proxy reached Core
  `list_apps` successfully from both embedded and standalone Harness. Revoking the assignment
  blocked the next turn in the already-open embedded chat; reassigning restored a new call.
  A deterministic fake model adapter initiated the call, but Core token issuance, policy enforcement,
  MCP transport and the tool response were real. No live Claude/Codex or external account was used.
- Native Safari and the live model-provider matrix were not repeated for this batch. They remain
  part of the open acceptance deliverables. Temporary tabs were closed, the test assignment revoked,
  the original QA Harness runtime command restored through Core's update flow, and Core/apps stopped.
  Ports 27071–27175 had no listeners. The operator installation and remote hosts were untouched.
- Final `dotnet publish apps/core/src/Haas.Hosty.Core/Haas.Hosty.Core.csproj -c Release
  -r osx-arm64 --no-restore -m:1 --artifacts-path /tmp/hosty-source-aot-artifacts
  -o /tmp/hosty-assistant-mcp-aot` passed after the final source edit, with four existing Core
  warnings. The earlier sandboxed attempt could not start an MSBuild task host; rerunning with
  local process/pipe access succeeded. Version consistency, documentation index and
  `git diff --check` passed. No commit, release or operator deployment was performed.


### Management mapping, private-source requests and upgrade acceptance (2026-10-01)

- The management allowlist covers the selected catalogue with generic app identities, including a
  non-Shell caller. Added route probes verify missing-grant refusals and authorized dispatch for
  lifecycle/configuration/backup/public-origin/feed/update/log/source/Core/user operations.
  The internal telemetry scrape now requires both read grants; telemetry declares both.
- Harness Source providers includes installation and installed-source rebinding. The restricted
  transport prepares, submits and polls requests; final approval stays on Core. Private-source
  preparation checks `apps.install`, `apps.sources.full` and connection ownership even for unchanged
  bindings and cached plans. Submission, polling and execution recheck permissions; clearing a
  private binding does not erase the request's source-authority requirement.
- Core build and full tests passed after the final runtime fix: 2,349 passed, four opt-in
  Docker/telemetry/VPN tests skipped, zero failed. The affected adoption/mixed/Docker group passed
  134 tests. The exact project build passed with four existing warnings. Native AOT publish for
  `osx-arm64` passed after the final edit. Logs: `/tmp/hosty-adoption-core-full.log`,
  `/tmp/hosty-adoption-focused.log`, `/tmp/hosty-adoption-core-build.log`, `/tmp/hosty-adoption-aot.log`.
- Harness: `npm test --workspace @haas/hosty-harness` passed 475 tests across 59 files; backend
  TypeScript, web lint/TypeScript and production webpack build passed. SDK: 139 tests and build
  passed. A first Harness attempt exposed JSX-preserve imports in the new shared installation UI
  test; its test config now uses automatic JSX and the source entrypoint, followed by the green
  full rerun. A sandboxed worker was stopped before that rerun; neither failed attempt is counted
  as passing evidence.
- Chromium, isolated `/tmp/hosty-password-login-qa`: Harness prepared a synthetic local manifest,
  displayed settings/runtime, submitted a bound Core confirmation and observed request completion.
  CLI confirmed `qa.source-install` installed and stopped with autostart disabled. A previously
  password-authenticated session was used. No real provider account, token or private repository
  was used, so the external private-source acceptance deliverable remains open.
- Safari 27: embedded Harness signed in through Core, loaded source settings, then rejected a
  subsequent API request after Core logout. Without reloading Shell, the normal password form in
  the Core popup restored Harness and protected source-settings reads. A separate Marketplace
  fixture with `apps.read` and no `apps.install` also passed popup sign-in in the ordinary sandbox.
  Synthetic passwords were not saved in Safari. Proof screenshots remain under
  `/tmp/hosty-safari-harness-recovery.jpg` and `/tmp/hosty-safari-ordinary-popup.jpg`.
- Chromium's bare `localhost:27172/dashboard` entry reached the canonical Shell origin. Safari's
  same bare entry initially followed a previous QA instance's obsolete redirect to port 27070;
  the current explicit canonical origin worked. No browser cache was cleared and this run does
  not establish migration of already-cached historical redirects. Current Shell redirects are
  temporary and carry `Cache-Control: no-store`.
- Upgrade fixture `/tmp/hosty-origin-upgrade-qa`, Production environment: built the immutable
  0.116.0 baseline from `git archive HEAD`, started it on 27371, and upgraded using the current exact
  source project with `--keep-apps`. LocalCommand PID 52386 survived the first upgrade with old
  environment and `restartRequired: true`; explicit restart created PID 54891 with both generated
  origins, preserving port 27372 and no public-origin override.
- The real Docker check exposed an adoption bookkeeping defect: a preserved container was marked
  as having applied the new environment. Start now records applied configuration/origin only when
  every service was freshly created, including mixed-runtime results. Regression tests cover legacy
  null/old origins, settings changes and partial adoption. The repeated upgrade preserved the exact
  Marketplace container and original start time, with its old `HOSTY_CORE_PUBLIC_ORIGIN` and
  `restartRequired: true`. Explicit app restart replaced it, injected Core/app generated origins,
  kept host port 32469 and cleared the flag. This verifies runtime migration, not browser acceptance
  of the old Marketplace image. The old Shell was refused because its required `apps.update` is
  unsupported, with the expected compatibility error.
- Both temporary Cores and their applications were stopped. QA ports 27071–27175 and 27371–27372
  have no listeners; the test Docker container is exited. Temporary browser tabs were closed and
  Harness's temporary optional installation grant was removed through ordinary Core confirmation.
  Operator Core/Shell and remote hosts were not restarted. No commit, PR or release was created.


### Remaining first-party browser consumers (2026-10-01)

- Demo App no longer depends on SSR cookie identity for protected UI. Its shared client session,
  role loading/mutations and JSON dialogs use the SDK app transport; invalid explicit bearers
  cannot fall back to cookies. Identity failures retain recovery coordinates and distinguish
  401/403/503. The Demo feature document moved into its feature folder and records this contract.
- Demo: four tests passed; lint and final production webpack build passed. The exact Core project
  built successfully before starting QA; no Core code changed in this batch. Focused handoff
  regressions passed: three Shell client tests, five Shell server tests and 21 Harness store tests.
  These tests cover stable retry identity and replay; they do not replace live provider acceptance.
- Safari 27, Core-managed `/tmp/hosty-password-login-qa`: the ordinary Demo iframe signed in
  through Core and displayed active bearer identity, the assigned directory, protected JSON and
  the Roles page. The Session panel independently displayed the same user via an explicit bearer.
  Standalone Overview and People used the app cookie successfully. The existing Core session had
  been authenticated by password; this batch did not repeat password entry. No role assignments
  were changed. An iframe document replacement requires another app-owned sign-in when cookies
  are unavailable; document-memory credentials intentionally do not survive that replacement.
- The exact bare `localhost:27172/dashboard` entry reached the current generated Shell origin in
  Safari without clearing browser data. The earlier obsolete-port result did not reproduce; this
  is not proof of all historical cached-redirect migrations. Current redirects remain temporary
  and non-cacheable. Screenshot: `/tmp/hosty-demo-embedded-roles.jpg`.
- At the end of this batch, live Shell-to-Harness approval/revocation/replay was unchecked. Automatic approval review
  refused a temporary `providers.assistant` grant to QA Shell and requested explicit authorization
  for that recipient, permission and isolated data root. No grant was applied. The user confirmation
  was subsequently granted explicitly by the owner; the next batch records the resulting check.
  Real GitHub/DevOps/private-repository acceptance remains unchecked.
- Temporary browser tabs and QA Core/apps were stopped; ports 27071–27176 have no listeners.
  Version consistency, generated documentation index and whitespace checks passed. No operator
  restart, external account access, commit or release was performed.


### Live assistant handoff and revocation (2026-10-01)

- The owner explicitly approved a temporary `providers.assistant` grant to `hosty.shell` only in
  `/tmp/hosty-password-login-qa`, followed by revocation. The ordinary Core permission-review and
  confirmation flow applied and then removed it. The QA Harness used its local fake-model runtime;
  no external model account, source provider or remote host was accessed.
- Normal Core password login and Shell's start/callback exchange produced a Shell app cookie in a
  separate origin cookie jar. The HTTP probe then called Shell's actual handoff route with its CSRF
  token. Core issued provider authority and the real Core-managed Harness finalized a durable draft.
  This is protocol acceptance, not an additional browser UI pass or model execution check.
- The probe discarded the successful response body, then repeated the same UUIDv7 and input. The
  returned conversation and frozen result matched the single persisted handoff record. A different
  prompt with the same request identity was rejected without finalizing another conversation.
- This extra conflict probe found that the SDK discarded the provider's HTTP status/code, causing
  Shell to answer 502. `AssistantClient` now throws `AssistantError` with those details and Shell
  preserves it. The repeated live probe returned 409 `request_conflict`; regression coverage also
  checks denied and expired requests.
- After ordinary Core revocation, both the previous request and a fresh request returned 403
  `app_permission_required` in the same Shell session, and the handoff record count did not change.
  The original QA fixture manifest was restored; a read confirmed that the temporary permission
  is absent from granted permissions. Restoring the old optional declaration leaves a review
  notification in this disposable fixture, but does not restore authority.
- QA Core/apps were stopped and ports 27071–27176 have no listeners. No operator installation
  restart, browser changes, commit or release was performed.
- Final verification: `npm test --workspace @hosty-sdk/app` passed 142 tests and SDK build passed.
  `npm test --workspace @haas/hosty-shell` passed 177 Node and 66 component tests; Shell webpack
  build passed. Shell lint had zero errors and three existing warnings. An initial SDK dependency
  approach broke native Node source imports in three Shell suites; the final standalone error type
  restored compatibility before the passing full rerun.
- `npm test --workspace @haas/hosty-harness` passed 475 tests across 59 files with local network
  access. The restricted attempt timed out in five provider-session tests and was interrupted;
  it is not counted as passing evidence. Documentation index, version consistency and whitespace
  checks passed. Existing unreleased Shell/SDK version bumps cover this fix.


### Firefox local browser acceptance (2026-10-01)

- Firefox 157.0 on macOS 27.0, installed `/Applications/Firefox.app`, passed the tested local
  authentication flow on the Core-managed `/tmp/hosty-password-login-qa` instance. The exact Core
  project build succeeded before launch. Runtime status confirmed the source project and QA root.
- Entering `http://localhost:27172/dashboard` automatically reached Core's generated login origin.
  Normal email/password login returned to Shell's canonical origin and loaded the dashboard.
  No DNS/hosts-file changes or browser privacy-setting changes were made; passwords were not saved.
- Embedded Demo App offered app-owned sign-in. Its popup completed using the existing Core session;
  the app showed active `authorization-header` identity, the assigned user directory and no primary
  Core session cookie. Standalone opening through Shell's Core link showed the same user with the
  app's own cookie.
- Logging out at Core invalidated the open Shell session and returned it to password login.
  Reauthentication restored the original Shell workspace. A second Core logout followed by a
  protected JSON request in the already-open standalone Demo navigated to Core login; password
  login returned to Demo, not Shell, and the repeated protected JSON request showed active identity.
  The Shell tab also recovered after the new Core login. No stale-session API success was observed.
- This pass covers localCommand apps, ordinary iframe sign-in, standalone navigation and logout
  recovery. It does not cover password entry inside a popup, permission confirmation, setup/recovery,
  Docker browser integration, other OS versions, or real external providers. The broader acceptance
  checklist remains open. Screenshots: `/tmp/hosty-firefox-embedded.jpg` and
  `/tmp/hosty-firefox-recovered.jpg`.
- Only documentation changed; automated application suites were not repeated. Documentation index,
  version consistency and whitespace checks passed. Test tabs were closed and QA Core/apps stopped;
  ports 27071–27176 have no listeners. Operator Core/Shell and remote hosts were untouched.


### Fresh setup/recovery acceptance (2026-10-01)

- New `/tmp/hosty-fresh-auth-qa` started with no persisted users or configuration, using ports
  27471/27472 and a local distribution override containing the current built Shell. Core seeded
  Shell through its ordinary distribution path and accepted its required permissions. This tests
  source artifacts and clean data initialization, not the published installer or old registry images.
- Real CLI setup-token issuance and public HTTP bootstrap created the first administrator. Anonymous
  management, recovery before setup, invalid and superseded setup tokens, repeat setup issuance,
  wrong-password login, invalid recovery and recovery replay were refused. The initial HTTP helper
  stopped after successful setup because it expected `shellOrigin` instead of `redirectTo`; subsequent
  checks continued on the same installation. Setup replay was subsequently verified on the second
  fresh installation described below.
- Recovery rejected the old password and Core session but exposed a defect: the old Shell app grant
  still authorized management requests. Recovery now atomically rotates the user's authorization
  revision; app codes and grants bind that revision, with online checks and backward-compatible
  absent fields. Regression tests cover old codes, old diagnostic grants, delayed grant writes,
  repeated recovery revisions and fresh identity. Setup/recovery expiry uses a fake clock.
- Published the current Core as a NativeAOT `osx-arm64` binary and initialized a second empty root,
  `/tmp/hosty-aot-auth-qa`, on ports 27571/27572. The same normal CLI-token/public-HTTP flow passed
  first-admin setup, token replacement/replay refusal, password login, seeded Shell identity and
  required grants, recovery, rejection of both old Core and Shell sessions, and new-password login.
  This used the local Shell distribution override, not the published installer or release feed.
- Firefox exercised ordinary password login on the source installation, loaded Shell, then reloaded
  an already-open Shell session after another recovery. It returned to Core login and recovered to
  the dashboard with the new password. Screenshot: `/tmp/hosty-fresh-recovery-firefox.jpg`.
  Setup/recovery pages were fetched and their real HTTP submissions exercised; interactive browser
  password creation/recovery form submission is not claimed by this pass.
- A disposable Core-managed app verified missing required permission refusal, successful start after
  Core-owned approval, unsupported required permission diagnostics, and automatic stopping of an
  already-running app whose manifest gains an unsupported requirement. The probe app was removed.
- Restarting the same NativeAOT binary retained the recovered Core session and rejection of the old
  Shell grant. A configured `http://qa-custom-core.localhost:27571` origin persisted and appeared in
  newly issued recovery links; clearing the setting restored generated local-origin links.
- The source CLI restart built and briefly reported the expected target, but its detached process
  subsequently exited. Source verification resumed with an explicitly retained foreground process;
  this is not recorded as successful sustained detached restart acceptance. NativeAOT persistence
  was tested through an explicit stop/start of the same binary and data root.
- Verification: the focused bootstrap/identity suite passed 44 tests. The complete Core suite passed
  2,353 tests with four opt-in Docker/telemetry/VPN tests skipped and no failures. The exact Core
  project built successfully after the final code edit; NativeAOT publication succeeded with four
  existing warnings. The first publication attempt used an unrestored artifacts directory and
  failed with NETSDK1004; publication then succeeded using the restored isolated artifacts directory.
- Both QA instances and their apps were stopped; ports 27471–27573 have no listeners. Operator
  Core/Shell and remote hosts were untouched. Logs are retained under `/tmp/hosty-aot-*.log` and
  `/tmp/hosty-recovery-*.log`. Published-installer, interactive setup/recovery form, other supported
  OS/runtime and real-provider acceptance remain in the unchecked deliverables above.

### Clean Linux VM published-release acceptance (2026-10-01)

- UTM working VM `Hosty QA - Ubuntu 24.04` runs Ubuntu 24.04.5 ARM64 with Docker
  29.1.3, Compose 2.40.3 and Firefox 157.0. The separate `Hosty QA - Clean Baseline`
  clone remains stopped and contains no Hosty installation. No Mac folders or Docker socket
  are shared with the guest; SSH forwarding is restricted to Mac loopback.
- The official installer from `main` downloaded `cli-dev`, verified its SHA256 checksum,
  installed CLI 0.116.0 and updated the guest shell PATH. First start downloaded Core and
  automatically installed Docker Shell 0.91.0 and Marketplace 0.5.1. Both containers run.
  These published artifacts do not contain this working tree's local-origin/auth changes.
- Seventeen CLI/public-HTTP checks passed: anonymous management refusal, setup and recovery
  token issuance restrictions, superseded setup token rejection, first administrator creation,
  token replay rejection, password login, recovery, old password/session rejection and restored
  management access. Two additional checks confirmed the recovered session and management
  access survive `restart --keep-apps`. Core remained running after the SSH command exited;
  the existing app containers remained running.
- Firefox inside the guest completed ordinary email/password login; `/api/auth/session`
  displayed `authenticated: true` for the synthetic VM administrator. Firefox also loaded
  `http://qa.hosty.localhost:7070/login` without DNS, hosts-file or privacy-setting changes.
  This verifies loopback name resolution, not this feature's generated-origin integration.
- Published Shell browser acceptance failed: `http://localhost:7171` displayed a network
  error and an empty app list. Core returned no CORS allow-origin header for that origin,
  while allowing its advertised `http://127.0.0.1:7171` origin. Opening the advertised origin
  returned to Core login despite the previously verified Core browser session. No authentication
  bypass or origin workaround was applied. Retest this scenario using current Linux artifacts.
- Setup/recovery submissions used HTTP, not interactive browser forms. Current candidate Linux
  Core/CLI and runtime images, interactive setup/recovery forms, full Shell/embedded flows and
  the remaining OS/provider matrix still require acceptance; the deliverable remains unchecked.
- Logs and a Firefox screenshot are retained in
  `/Users/haas/Virtual Machines/Hosty QA Support/published-install-2026-10-01/` and guest
  `~/hosty-qa-results/`. The working VM remains running for further QA. The Mac operator
  installation was untouched. This pass changes documentation only; application builds/tests
  were not repeated.


### Current candidate on Linux ARM64 (2026-10-01)

- Built the uncommitted working-tree Core/CLI 0.117.0 as native Linux ARM64 artifacts in the
  working UTM VM with .NET 10. Built Shell 0.92.0 and Demo App 0.12.0 Docker images locally.
  Fixture manifests change only image references to those local tags. The published installation
  is stopped and retained; the candidate uses the separate `/home/hostyqa/.hosty-candidate` root.
  The clean baseline and Mac operator instance remain untouched.
- `dotnet test` passed 2,353 Core tests with four opt-in tests skipped, and 223 CLI tests.
  The final Core test run used UID 1000: the unreadable-file test cannot establish denial when
  run as container root. Core was republished successfully after the last source edit.
  `npm run shell:test` passed 177 Node tests and 66 component tests with `NODE_ENV=test` and
  the Core browser fixtures mounted into the test image. Both runtime production images built.
- Fixed two blockers exposed by these builds: Shell explicitly selects webpack, whose extension
  aliases resolve SDK TypeScript imports, and live/update-candidate manifests are reread rather
  than trusting an unchanged timestamp and length. Three regression tests now explicitly retain
  the timestamp while changing same-length manifest content.
- Seventeen fresh CLI/public-HTTP setup/recovery checks passed. Three further checks verified
  recovered-session persistence across `core restart --keep-apps`, management access, and all
  required bootstrap Shell grants. These are normal password/bootstrap endpoints, not seeded
  sessions. Interactive setup/recovery submission remains unverified.
- Core automatically installed and started Shell. Demo installed and started through the Core
  CLI. Restart adopted the existing Shell container. Demo had autostart disabled and was stopped
  by the existing boot reconciliation; it was explicitly started again afterwards.
- Firefox 157 followed `localhost:7070/login` to the generated instance-specific Core hostname,
  accepted the recovered password and returned to Shell's generated callback origin. The callback
  failed with `core_token_exchange_unavailable`. An independent container probe reproduced
  `ECONNREFUSED 172.17.0.1:7070`: Core listens only on `127.0.0.1` and `::1`, whereas Docker's
  `host.docker.internal:host-gateway` mapping addresses the bridge gateway. No listener, CORS,
  cookie or authentication workaround was applied. Full Shell and embedded acceptance is blocked.
- Build-time VM networking needed a separate environment repair: the UTM DNS relay resolved on
  the guest but failed inside Docker. The working VM Docker daemon now uses explicit public DNS
  resolvers; this is not an application-origin resolution mechanism or proof of offline operation.
- Evidence is retained under guest `~/hosty-candidate/` and Mac
  `/Users/haas/Virtual Machines/Hosty QA Support/candidate-2026-10-01/`.

### Native Linux transport — approved 2026-10-02

The owner approved option 1: automatically add a Core listener on the local Docker bridge,
keeping browser origins independent and retaining loopback as the ordinary browser/control
transport. The intended operator is not a system administrator; standard local installations
must not require manual bridge, DNS or firewall configuration. Renaming a browser origin or
publishing through ingress must not change container-to-Core transport.

Implementation uses Docker's default bridge metadata (including a custom bridge interface name)
and verifies that its gateway actually belongs to that bridge on this host. No hardcoded subnet
or wildcard bind is permitted. A reloadable Kestrel endpoint is updated at Core startup and Docker app start, leaving the
loopback endpoint running. There is no periodic Docker/network watcher. App starts refresh
discovery and check listener readiness.
The additional listener refuses CLI control routes and retains ordinary API authorization.
Mac/Windows Docker Desktop retain their existing host transport. Native Linux Docker Desktop,
remote daemons and rootless networking must not cause guessed local binds; unsupported automatic
transport produces an actionable diagnostic. Explicit non-loopback/HTTPS listeners retain the
operator's configuration.

Verification covers discovery refusal, listener add/remove, default and per-app bridge requests,
unauthenticated API/control denial, unchanged browser-origin projection, and a one-time real Shell code
exchange in Linux Docker and Mac Docker Desktop. Subsequent platform checks are scoped to changes
in this transport; ordinary feature changes use the shared contract tests. The remaining broad browser/provider acceptance
checklist stays open.


### Automatic Docker transport acceptance (2026-10-02)

- Implemented the approved bridge listener with one Core component and Kestrel endpoint reload.
  Discovery occurs at startup/app start, not on a timer. No proxy, firewall changes, wildcard
  listener or Shell-specific authentication exception was added. Platform version remains 0.117.0
  as part of this uncommitted feature batch.
- `dotnet test` on Linux ARM64 passed 2,378 tests, with four existing opt-in tests skipped. Native
  ARM64 publication succeeded after the last source edit, without trim/AOT warnings. On Mac,
  153 focused transport/origin/manifest regression tests passed. The sandboxed Mac test runner
  initially could not bind its communication socket; the authorized rerun passed.
- The Linux run exposed one more manifest-cache collision: `SaveManifestCopyAsync` now evicts its
  target cache entry after atomic replacement. The reconciliation regression deliberately restores
  the old timestamp before rereading to prove that same-size replacements cannot serve stale data.
- The same `check-docker-core-transport.py` smoke check passed on native Linux and Mac Docker
  Desktop. Both default and per-app networks reached health (200) and were denied anonymous app
  management (401). Linux bridge requests to CLI control returned 404; Desktop requests without
  the control secret returned 401. Linux socket inspection showed loopback and the detected bridge
  only, with no wildcard or LAN-address binding.
- Mac Docker Shell passed 22 setup/login/code-exchange/required-grant/recovery HTTP checks. Linux
  passed nine login/code-exchange/required-grant/recovery HTTP checks against the previously failing
  candidate instance. Both rejected old Core sessions and Shell grants after recovery.
- Linux additionally passed ten checks while renaming both Core and Shell to custom localhost
  origins, restarting Shell to apply its environment, authenticating again, and restoring generated
  origins. No internal transport address changed with those public-origin edits.
- An isolated Linux Core started with its Docker socket initially absent. Making that socket
  available and starting Shell added a reachable bridge listener without restarting Core or adding
  a watcher. The temporary instance was stopped afterwards. This tests availability at app start,
  not automatic mutation of the environment of existing containers.
- Added a narrow Linux CI smoke step, selected by transport source/script/workflow paths. No new
  all-platform matrix runs on ordinary feature changes. Its exact script was executed locally on
  both environments; the GitHub-hosted workflow itself has not run in this uncommitted worktree.
- The Mac QA instance at `/tmp/hosty-docker-transport-qa` is stopped. The Linux candidate remains
  running at `/home/hostyqa/.hosty-candidate`; generated browser origins are restored. Operator
  instances, published release files and the clean VM baseline were not changed.
- This pass did not repeat browser UI automation, interactively submit setup/recovery forms, test
  Windows, or publish a real domain through Cloudflare. Their existing acceptance deliverables
  remain open. Evidence is under guest `~/hosty-candidate/logs/` and Mac
  `/Users/haas/Virtual Machines/Hosty QA Support/transport-2026-10-02/`.

### Firefox Linux login acceptance (2026-10-02)

- Started the existing working Ubuntu VM and its previously built candidate at
  `/home/hostyqa/.hosty-candidate`; Core 0.117.0 and Docker Shell 0.92.0. No source,
  permissions, origin configuration or operator installation changed.
- In Firefox 157, opening `http://localhost:7171` redirected to Core's generated
  hostname and normal password form. The existing synthetic account authenticated
  and returned to Shell's generated hostname. The dashboard displayed VM QA, app
  inventory and live Core state; a browser reload retained the authenticated session.
  The previous `core_token_exchange_unavailable` failure did not recur.
- UTM input automation initially lost focus/characters; the form was corrected
  before submission. Password saving was dismissed. Proof is retained at
  `/tmp/hosty-firefox-qa-2026-10-02/authenticated-shell.png` on the Mac.
- This owner-requested pass covers browser authorization only. Permission approval,
  app launch/embedding, logout and interactive setup/recovery were not exercised;
  the broader acceptance deliverables above remain unchecked. No rebuild or unit
  test rerun was necessary because executable code was unchanged.

### App-requested removal confirmation (2026-10-02)

- Before the fix, adding direct `POST /api/apps/{appId}/remove` to the app-credential denial
  theory reproduced the bypass (1 failed, 9 passed). The corrected boundary now rejects it.
- `dotnet test apps/core/tests/Haas.Hosty.Core.Tests/Haas.Hosty.Core.Tests.csproj --artifacts-path
  /tmp/hosty-removal-build --no-build --no-restore --filter
  'FullyQualifiedName~AppManagementHttpTests|FullyQualifiedName~InstallationApproval|FullyQualifiedName~RemovalApproval|FullyQualifiedName~CoreLifecycleServiceTests.Remove'
  --verbosity quiet`: 94 passed. New HTTP cases cover destructive direct calls, both request
  transports, frozen target/flags, wrong origin/nonce, denial/replay, removed/reinstalled targets,
  revoked app/user grants and trusted operator cleanup of retained data.
- `npm run test --workspace @hosty-sdk/app`: 143 passed;
  `npm run test --workspace @haas/hosty-shell`: 177 Node and 71 component tests passed;
  `npm run test --workspace @haas/hosty-marketplace`: 104 passed.
- Core built with `dotnet build apps/core/src/Haas.Hosty.Core/Haas.Hosty.Core.csproj
  --artifacts-path /tmp/hosty-removal-build --no-restore --verbosity quiet`; SDK built with
  `npm run build --workspace @hosty-sdk/app`. Shell `npm run build` and Marketplace
  `npm run build -- --webpack` passed from isolated source copies under
  `/tmp/hosty-removal-web` to preserve active runtime output. The Shell build caught and prompted
  correction of a test-mock return type; the corrected five removal tests and production build passed.
- A fresh read-only review found no confirmation bypass in the candidate. HTTP tests seed only
  their isolated stores; they are not evidence of browser password login. No live browser removal,
  self-removal, deployment or Core restart was performed in this correction; the running Mac/VM
  installations were preserved. Prior Linux browser acceptance does not verify this new removal UI.
- `node scripts/docs-index.mjs --check`, `node scripts/check-versions.mjs` and `git diff --check`
  passed. Existing feature version bumps remain Platform 0.117.0, Shell 0.92.0 and SDK 0.19.0.
  The Core build reports only the existing NU1900 warning because NuGet vulnerability metadata
  is unavailable in this environment; compilation and tests complete successfully.

### Part C1–C2 verification (2026-10-02)

- Core built through `dotnet test` with isolated artifacts at `/tmp/hosty-lifecycle-policy-check`.
  Lifecycle/provider coverage passed 575 tests; four existing Docker/VPN tests remain opt-in.
  Focused permission/management coverage passed 107 tests, and the new own-state HTTP test passed.
  A real local-command app starts without grants, gets `app_permission_required`, succeeds after
  Core approval, and remains running with denied calls after revocation.
- SDK build and 152 tests passed, including notice role/state classification, direct popup,
  forged embedded target rejection, focus refresh and pending polling. Shell passed 73 existing
  component tests plus the new verified-frame test, and 23 focused problem/sandbox tests.
- Marketplace: 104 tests; Telemetry UI: 10 tests; Harness gateway: 51 tests. TypeScript checks passed
  for all four app surfaces and Harness backend. Restricted-sandbox HTTP/socket runs were rerun
  with local socket access; no failed sandbox run is counted as acceptance.
- Production Next builds passed for Shell, Marketplace, Telemetry UI and Harness UI in
  `/tmp/hosty-permission-notice-web`, with temporary-copy tracing roots for linked dependencies.
  Operator output and running Core/apps were untouched. No native browser or cross-platform rerun
  was performed for this batch; popup behavior is covered by SDK and iframe component tests.
- Version consistency, docs index and whitespace checks passed. Existing uncommitted release
  version bumps cover C1–C2. C4 shipped separately in PR #540 (Harness 0.39.1, platform 0.116.1), merged on
  2026-10-03. This branch includes that main merge and preserves its draft-only provider behavior.

- Final Shell lint and verified-frame regression passed after moving its UI reset out of an effect;
  its isolated production build was repeated successfully. SDK's official production build and
  tests pass. An additional `tsc --noEmit` over all SDK test sources reports existing mock/narrowing
  errors in `install.test.ts`, `scoped-token.test.ts`, `sdk.test.ts` and `theme.test.ts`; those files
  were not changed for Part C. No errors were reported in the new permission tests.

### HTTP named-localhost verification (2026-10-08)

- Platform version is 0.123.2 (patch), with the product channel CLI version aligned.
  The exact Core project builds after the final source edits.
- `dotnet test apps/core/tests/Haas.Hosty.Core.Tests/Haas.Hosty.Core.Tests.csproj
  --artifacts-path /private/tmp/hosty-named-localhost-signin-tests
  --filter FullyQualifiedName~AppSignInIntentHttpTests --no-restore`: 130 passed, zero failures.
  Coverage includes foreign/null Origin, copied intents, ignored parent-Domain nonce cookies,
  immutable mode, nonce-before-login, replay/concurrency/expiry, capacity, access restrictions,
  actual chunked-body bounds, multipart refusal and terminal storage cleanup.
- `dotnet test apps/core/tests/Haas.Hosty.Core.Tests/Haas.Hosty.Core.Tests.csproj
  --artifacts-path apps/core/tests/Haas.Hosty.Core.Tests/bin/named-localhost-verification
  --verbosity minimal`: 2,823 passed, four opt-in integrations skipped, zero failures.
  Separate artifacts under the ignored test `bin` directory let existing manifest tests find
  the repository. The earlier `/private/tmp` full run had six repository-path discovery failures;
  the corrected run passes without changing production or test harness behavior.
- `dotnet publish apps/core/src/Haas.Hosty.Core/Haas.Hosty.Core.csproj -c Release -r osx-arm64
  --artifacts-path /private/tmp/hosty-named-localhost-aot` passes and emits a Mach-O arm64 executable.
  The build has four existing CS9113/CA1416 warnings and no new trim/AOT warnings.
- A fresh isolated Core-managed localCommand Shell and Demo use generated origins and normal
  setup/password authentication, without public-origin overrides or seeded test sessions.
  Chromium and native Safari pass Core password login and the authenticated Shell dashboard.
  Chrome passes Demo's explicit activity popup; Safari's unavailable framed Core session shows
  sign-in recovery, and its gesture popup restores the embedded app. Both retain the app grant
  after leaving and reopening its Shell page. Chrome also displays the standalone app with its
  app-origin cookie. These checks do not establish the broader provider/platform acceptance.
- The operator Core restarts from the same primary source project with `--keep-apps --foreground`.
  Its process identity changes from 90244 to 7525; public status reports 0.123.2, generated
  `http://core.hosty.localhost:7070` accepts a validated intent with storage bootstrap and no
  nonce cookie, and all 13 installed apps remain running.
- Real Chrome relay acceptance uses two attacker-owned intents while the browser retains its
  normally authenticated Core session. A copied GET fails because its Core-origin proof is absent.
  Chrome accepts an exact legacy nonce in a parent-Domain cookie, but the second copied GET still
  fails. Isolated store inspection confirms zero issued codes for both attempts.
- Final restored source passes its exact Core build and all 130 focused intent tests again.
  `node scripts/docs-index.mjs --check`, `node scripts/check-versions.mjs` and `git diff --check`
  pass. The isolated QA Core, Shell, Demo and both fixture listeners are stopped, and only
  agent-created browser tabs/windows are closed. The operator Core remains running.

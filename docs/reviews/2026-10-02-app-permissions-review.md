# App Permissions Review — Known Risks

Date: 2026-10-02
Baseline commit: `90052586283a38643170eb53dc0dcd71b36ad962` (#539 merged)
Baseline working tree: the uncommitted `local-browser-origins` change set on `main` (app permission
catalogue, `AppManagementAuthorization`, Shell server-side Core transport).
Review artifact only: no application changes, commits, or version changes.

## Purpose

This review covered the permission work merged in #535 (provider grants and reviewed provider
access) and #539 (permission observation and permission-only review), plus the uncommitted
`local-browser-origins` work that lets apps call Core management routes on a user's behalf.

The owner selected part of the findings for remediation and listed them below only by reference.
Every other finding is recorded here as a **known risk**. The owner has neither accepted the
behavior as final nor scheduled a fix. Each risk still needs a decision. A risk becomes tracked
work only when it is triaged into the owning feature's `plan.md`; this document carries no status.

## Selected for remediation (2026-10-02)

These findings are being turned into plan deliverables and are not restated below:

- **Source override.** `apps.lifecycle` lets an app point another app's development source at any
  directory. A localCommand profile then runs the live manifest from that directory without review.
  Owner decisions: app-requested overrides go through Core confirmation, and override paths inside
  app directories or container-bound host paths are rejected for every caller.
- **Long-lived app grants.** App grants (7d/30d, 3d/14d for system apps) authorize privileged
  operations without user presence, and back-channel calls extend them. Owner decision: a short
  activity window that only a browser pass through Core renews. The window must never reload the
  page or lose input.
- **Required permissions as launch preconditions.** Owner decision: apps start without their
  required grants, privileged calls fail until approval, and a shared SDK notice opens Core review.
  This supersedes the 2026-10-01 decision in `local-browser-origins`.
- **Upgrade across retired permission names.** Shell 0.91 cannot work with the new Core, and the
  old Core rejects the new Shell manifest. Shell and Core must be upgraded together.
- **App-originated assistant handoffs.** With `immediateHandoffs`, a `providers.assistant` consumer
  can start an agent turn. Owner decision: handoffs from other apps are always drafts.

Fixed in the working tree before this document was written: the permission observer no longer
stops apps on manifest read errors; app-supplied optional-permission drafts no longer pre-check the
Core confirmation page.

## Severity model

Same scale as the [consolidated review](2026-09-06-consolidated-review.md):

- **High:** trust-boundary defect, data loss, or a correctness bug on an ordinary path.
- **Medium:** bounded correctness, reliability, or contract defect.
- **Low:** hardening, efficiency, or documentation.
- **Structural:** coupling that raises the cost of every change in its area.

"Where" says whether the behavior is merged (`main`) or only in the uncommitted working tree
(`WIP`). Locate code by symbol; line numbers drift.

## Known risks

| ID | Severity | Where | Risk |
| --- | --- | --- | --- |
| AP-1 | Medium | WIP | App-initiated removal can delete data without Core confirmation |
| AP-2 | Medium | WIP | `apps.configure` can bind app mounts to arbitrary host paths outside the data root |
| AP-3 | Medium | WIP | Shell's server concentrates administrator authority |
| AP-4 | Medium | main | Provider grants cover every current and future provider in a category |
| AP-5 | Low | main | Any admin-opened app can exhaust the approval store |
| AP-6 | Low | main | Permission plans expose internal binding data to the requesting app |
| AP-7 | Low | main + WIP | One signing key backs several token formats |
| AP-8 | Low | WIP | `GET /install/permissions/{appId}` changes state |
| AP-9 | Low | main | Microphone delegation follows the speech grant |
| AP-10 | Structural | WIP | Management grants are not scoped to target apps |
| AP-11 | Structural | WIP | A permission name can widen without re-consent |

### AP-1 — App-initiated removal can delete data without Core confirmation

`AppManagementAuthorization` maps `POST /api/apps/{appId}/remove` to `apps.install`. The handler
only requires the acting user to be an administrator. `AppRemoveRequest` accepts `DeleteData`,
`DeleteBackups` and `DeleteSource`. An app holding `apps.install` and an administrator's app grant
can therefore remove any app and its data without a Core-owned confirmation. Installation and
update requests, by contrast, always pass through Core confirmation.

Existing `apps.install` grants (Marketplace) acquire removal without re-consent. The owner accepted
that widening on 2026-10-01; the missing confirmation for destructive options is the open part.

Possible directions: route app-initiated removal with any deletion option through Core
confirmation, as installation and update already are.

The owner deferred this on 2026-10-02 until third-party apps request management permissions.

### AP-2 — `apps.configure` can bind app mounts to arbitrary host paths

`apps.configure` covers `POST /api/apps/{appId}/mounts` and the shared-mount binding routes.
`MountPathPolicy.EnsureAllowed` already rejects the Hosty data root, the filesystem root and system
roots. Every other host path is accepted. That includes the operator's home directory, credential
folders such as `~/.ssh`, and development source folders that other apps run from.

Two consequences:
- **Reading secrets:** an app can bind its own declared external mount to such a path and read it
  after its next restart.
- **Code execution:** a writable binding over a live development source can change code that
  another app runs.

Possible directions: registered global mounts stay direct, and arbitrary host paths require Core
confirmation. Optionally reject paths that any app uses as a source override.

The owner deferred this on 2026-10-02 together with AP-1.

### AP-3 — Shell's server concentrates administrator authority

Shell now reaches Core through its own server (`apps/shell/src/app/shell/app-auth-server.ts`). The
server holds Shell's service token and Shell's broad grants: `apps.configure`, `core.configure`,
`core.update`, `users.manage` and the lifecycle permissions. It also receives each user's app grant
with every request. A compromised Shell server process or dependency therefore gains administrator
authority for every administrator who uses Shell during the compromise. Today the grant lifetime
also lets it persist that authority.

This follows from the owner's 2026-10-01 trust model, in which Core owns sign-in and Shell is
replaceable. It is recorded so that the exposure stays explicit.

Possible directions:
- keep the Shell server minimal and its dependencies audited;
- rely on the planned activity window to bound persistence;
- consider short per-request credentials instead of forwarding the app grant.

### AP-4 — Provider grants cover every current and future provider in a category

`providers.speech-to-text` and `providers.assistant` authorize discovery and use of every confirmed
provider in the category, including providers installed later (`ProviderAccessService`). The
consuming app selects the provider. Installing a new provider, for example a cloud speech service,
extends where user audio or prompts can go without new consent. An administrator cannot restrict a
consumer to a particular provider.

This is a documented design choice in
[provider consumption](../features/provider-consumption/feature.md); the risk grows once a non-local
provider exists.

Possible directions: an administrator-selected default provider per category, per-consumer
provider binding, or a notice when a new provider appears.

### AP-5 — Any admin-opened app can exhaust the approval store

`InstallationApprovalStore` holds at most 64 entries for 15 minutes, host-wide. A permission-review
request (`InstallationPrepare.PermissionsAppId`) requires no app permission, only an administrator's
app grant. Any app an administrator has opened can fill the store and block installations, updates
and permission reviews for every caller until the entries expire.

Possible directions: a per caller-app and user quota, and deduplication of permission reviews per
target app.

### AP-6 — Permission plans expose internal binding data to the requesting app

`InstallationApprovalStore.View` returns the full `AppPermissionPlan` to the caller. The plan
includes `Identity`, the internal comparison key: installation time, permission revision, manifest
and install paths, and override and checkout paths. It also includes `Source` (a local manifest
path) and the manifest digest.

Possible directions: keep binding data server-side and return a projection.

### AP-7 — One signing key backs several token formats

`DelegatedTokenSigningKey` signs delegated tokens (`hosty_delegated`), app identity tokens
(`AppIdentityTokenService`), provider credentials (`hosty_provider.1`) and assistant MCP
credentials (`hosty_mcp.1`). Every validator checks its own prefix, and each signing input includes
that prefix, so formats are separated today. A future validator that skips the prefix check would
accept another format's signature.

Possible directions: per-purpose keys derived from one root (HKDF with a purpose label).

### AP-8 — `GET /install/permissions/{appId}` changes state

The Core recovery entry point creates and submits an approval request on a GET, then redirects to
the confirmation page. A cross-site top-level navigation can open a review page in an
administrator's browser and consume approval-store capacity (AP-5). The decision itself still
requires the session-bound nonce and an explicit click.

Possible directions: render a page whose form creates the request with a POST.

### AP-9 — Microphone delegation follows the speech grant

Shell adds `microphone 'src'` to an embedded app's frame when the app holds
`providers.speech-to-text` (`embedded-app-frame.tsx`). Browsers store microphone consent for the
top-level origin. Once the user allows the microphone for any embedded app, every app with the
speech grant can record without a new browser prompt. The permission description does not mention
the microphone.

Owner view (2026-10-02): shared consent is the desired behavior. The browser's recording indicator
and closing the tab bound the exposure. The open question is whether the permission description
should say that it includes microphone access.

### AP-10 — Management grants are not scoped to target apps

`apps.lifecycle`, `apps.configure` and `apps.install` apply to every installed app, including Shell,
Harness and other system apps. A third-party app granted `apps.lifecycle` can stop Shell, and one
granted `apps.configure` can read every app's setting values. The catalogue is intentionally coarse
(owner decision 2026-10-01). The risk grows once third-party apps request these permissions.

Possible directions: target-app scoping for third-party callers, with first-party apps unchanged.

### AP-11 — A permission name can widen without re-consent

Existing grants keep their name when Core changes what the name authorizes. The owner accepted this
once on 2026-10-01: `apps.install` now covers update and removal. No permission-definition
versioning exists, so any future widening applies silently to every app that already holds the
name.

Possible directions: never widen an existing name; introduce a new name and retire the old one,
which forces review through the existing unsupported-name path.

## Verification limits

Static review only: the findings come from reading the code at the baseline above. No build, test
run or live reproduction was performed for this document. The uncommitted working tree was changing
while this review was written; WIP findings describe it as of 2026-10-02.

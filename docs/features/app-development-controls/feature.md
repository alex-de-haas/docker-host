---
created: 2026-10-18
updated: 2026-10-20
summary: Core-owned execution selection runs installed packages or registered workspace manifests on ordinary app data, with scoped access review and recoverable lifecycle operations.
components: [apps/core, apps/cli, apps/harness, apps/shell]
---

# Development Controls For Existing Apps

## Same Installation, Live Workspace Code

An installed application runs from its package release runtime or an explicitly associated registered
workspace. The [workspace execution selector](../workspace-live-activation/feature.md) is the ordinary
operator control. Development runtime profiles are source execution recipes used by workspace
bindings. Native, Docker and mixed recipes support ordinary and system applications. Core itself has
a separate explicit development selection; an app workspace never implicitly restarts Core.

Workspace execution retains the app installation, Core identity domain, ordinary users and data,
operator settings and authorized mount bindings. It creates no child Core and imports no sandbox
users or data. A separate sandbox has its own users, data and lifecycle. Core prepares a candidate
before stopping its current runtime where the adapter supports preparation, then replaces all
services so only the selected target writes ordinary data.

The working tree can contain uncommitted edits. Source mounts, watchers, setup/build commands and
hot reload follow the workspace manifest. Ordinary code edits need no repeated runtime approval.
Browser HMR and runtime readiness remain separate: a profile without HMR can need a page reload.
Source overrides remain supported for existing manual workflows; their retirement belongs to the
[development controls plan](plan.md).

## Workspace Manifest Admission

Core reads the workspace manifest at its bound source path and validates the installed app identity,
supported schema and runtime recipe. The installed package manifest stays unchanged. Core stores
an admitted execution snapshot in its private development journal directory; its raw JSON retains
unknown extension fields. The registry projects the active execution contract while preserving the
installed package version and original install/update source.

Manifest classification follows actual authority:

- Valid release-version and presentation metadata changes need no additional approval.
- Commands, setup/build instructions, environment values and service topology can evolve within
  existing authority. They do not require a package update or a routine review dialog.
- Required Core permissions absent from current grants, new provider roles, host-command execution,
  Docker host networking, capabilities/devices, wider source access, source writes, bound host-mount
  write expansion and new network exposure require concrete approval. New optional declarations
  remain ungranted unless the operator selects them explicitly.
- Unknown extension changes require conservative exact-candidate review. A different app identity or
  unsupported manifest schema is rejected rather than adopted.

Additional-access confirmation uses Core's existing `/api/installations` and `/install/confirm/...`
flow with a `workspaceManifest` request. It requires source and lifecycle authority rather than app
installation authority. The operator sees the concrete added access. Consent is bound to the exact
candidate digest, installed package, installation, source path, recipe, actor and current permission,
settings and mount state. The decision nonce remains exclusive to the authenticated Core page.
A denial grants nothing. Candidate edits, revoked permissions or changed authority require a fresh
review; retries retain their execution request UUID. A client cannot submit its own approval flag.

Approval records scoped consent; it does not update the installed manifest or immediately grant
permissions to the package. The active workspace receives admitted required rights and explicitly
selected optional rights through its execution projection. Switching away removes those temporary
additions. Later revocations are respected rather than restored from a captured grant list.

## Refresh, Stop And Package Return

Start and Restart re-read the workspace manifest, current source authority and current consent.
Harmless changes refresh the separate admitted execution snapshot and registry projection. An
additional-access change is refused before replacement until its concrete review succeeds. Setup
and preparation use the admitted recipe; manifest changes after preparation cannot silently replace
the prepared candidate. Unchanged environment images retain their immutable artifact locks.

Core retains the last launched manifest separately from an admitted replacement. Stop, logs and
health use that launched snapshot even if live JSON is invalid, a service was renamed/removed, or a
restart was interrupted. Core upgrade projection healing also reads the admitted workspace snapshot
instead of overwriting its contract from package metadata.

Selecting a package runtime returns to the **currently installed package** using Core's independent
package-runtime baseline. Switching workspace A to workspace B does not create a previous-workspace
stack. Explicitly selecting another package runtime changes the baseline. Package return does not
restore an old manifest, data archive, settings snapshot or revoked grants. Current source edits,
worktrees, caches and ordinary app data survive. There is no mandatory generic data-compatibility
acknowledgement in the unified switching contract.

## Durable Operations And Authority

Each execution intent has a stable UUID `requestId`, a durable target journal and child development
receipt. Journals record actor, installation, source/worktree, observed HEAD, manifest snapshots,
current phase, preparation, backup and successful request receipts. The app points to its current
child journal. Exact replay observes or resumes that intent. Changed arguments, authority or a later
binding cannot replay an obsolete target onto a newer choice.

Terminal phase and successful receipt share an atomic journal write. A verified healthy start or
package return can finish its receipt after a lost response without restarting the same runtime.
HTTP disconnect does not cancel admitted replacement; Core shutdown can interrupt it and the same
UUID resumes it. Journals contain execution references rather than copies of credentials or data.
A missing/corrupt required journal blocks mutation and is surfaced per app without hiding unrelated
Dashboard rows.

Shell, Harness, local control and direct MCP use the same target selection service. The authenticated
user, app installation and workspace owner are checked again before mutation. Source authority alone
does not grant lifecycle authority. A delegated or read-only connection cannot create it by choosing
a tool policy. Private-source grants are revalidated for new source execution. Stop remains available
after source access is revoked; starting a private package can still require its current source grant.

Harness retains its existing **Ask / Run unprompted / Disabled** policy. Ask presents the concrete
requested tool action; refusal before dispatch changes no runtime. Run unprompted needs no second
routine browser approval. Additional authority still requires the concrete Core confirmation.
Logs are bounded and retain the existing `apps.logs` permission.

The worktree is a persistent ordinary-runtime consumer. Authorized writers can continue editing.
Transitions fence destructive workspace operations; Return does not delete the worktree or an
independent sandbox. Runtime/source consumers remain independent of workspace Close and sandbox
Finish. This coordination is not a per-session filesystem isolation boundary for trusted agents.

## Data And Backups

Before source execution Core verifies a stable backup of managed application data. Shared/external
mounts, remote databases, provider state and external side effects are outside that archive. Unsafe
data links, unavailable backup storage or an unverifiable retained backup prevent execution before
new code starts. A replay reuses a backup only while the saved data baseline remains valid.

Return keeps current data and never restores an archive. Backup restore remains a separate authorized
action that requires the app to be stopped and can discard newer data. It does not reset source,
accept a Git worktree or erase the development journal.

## Legacy Development API

The existing `dev-mode` status/plan/apply APIs, CLI `dev-status` / `dev-plan` / `dev-apply` and direct
MCP `get_app_dev_mode` / `plan_app_dev_mode` / `apply_app_dev_mode` remain compatible for existing
clients and retained recovery receipts. These APIs support `enter`, `restart` and `return`. Their
explicit plan digest binds the actor and current installation/source/runtime/configuration facts.
Harness's legacy tools use `devAction` to distinguish lifecycle intent from transport dispatch.

The raw legacy entry path keeps its installed Docker recipe contract. It allows valid top-level
version changes and JSON formatting/property-order changes, while retaining other fields, unknown
fields and nested versions in the comparison. It does not adopt changed commands/services/rights.
Its captured-previous-runtime recovery and `acceptDataChanges` parameter remain for old callers;
the ordinary package/workspace selector does not submit or expose that compatibility acknowledgement.
Legacy private-source owner checks and generic Start/Restart restrictions remain in force.
A fresh Start or Restart executes the same live manifest that passed the legacy contract check and
records that manifest's digest as applied. Accepted version or formatting differences therefore do
not leave a permanent restart requirement against the installed package. Adopted services retain
their previous applied digest; later source changes still require a fresh start. The installed
package manifest and version remain unchanged.

## Audit

Core records requested selection, additional-access review, progress, refusal and outcome with the
actor, installation, worktree, source HEAD/manifest, review digest and request/operation IDs. Harness
also retains its normal tool approval/dispatch records. Neither an accepted operation nor its audit
record substitutes for observed runtime readiness and browser verification.

## Testing Expectations

- Classify metadata, command/environment/topology changes and optional declarations without new
  authority; require exact review for rights, devices/capabilities, mounts, source writes and exposure.
- Reject invalid identity/schema and conservatively retain unknown fields. Test stale/denied approval,
  permission revocation, actor binding, preparation failure and replay before runtime replacement.
- Execute ordinary/system applications with native, Docker and mixed source recipes. Keep the package
  manifest/version unchanged and report simulated-adapter coverage separately from real runtime QA.
- Refresh a workspace command across service recreation; retain last-launched topology for Stop/logs,
  and return from invalid live JSON without losing current source/data or restoring revoked rights.
- Verify package Docker -> workspace A -> workspace B -> package Docker, explicit package baseline
  changes, healthy interruption recovery and ownership-aware group Return.
- Retain legacy version-only compatibility, strict raw recipe checks and correct applied workspace
  digests after generic and planned restarts, without marking adopted or failed starts as applied.
  Cover stable backups, failed starts, original-UUID recovery, retired IDs, private-source checks and
  corrupt-journal behavior.
- A newer public runtime switch or legacy development selection supersedes an interrupted unified
  package request. Replaying that old UUID must not replace the newer target or perform lifecycle work.
- Configure a selected app worktree across multiple repository bindings; inventory and group
  execution agree, old configuration retries preserve newer choices, and stale/foreign/reinstalled
  bindings or unresolved ambiguity fail before lifecycle effects.
- Use a Core-managed isolated integration environment, normal password authentication and actual
  preview URLs for browser/agent verification. Run affected Core/CLI/Harness/Shell tests and builds,
  Core Native AOT, version consistency and documentation validation.

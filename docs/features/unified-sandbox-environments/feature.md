---
created: 2026-10-29
updated: 2026-10-29
summary: One child Core per sandbox, retired relay contracts and unified Core-instance presentation with ordinary identity, independent builds and process resources.
components: [apps/core, apps/cli, apps/harness, apps/shell, apps/demo-app, packages/app-sdk, scripts]
---

# Unified Sandbox Environments

Every sandbox is a parent-managed child Core with zero or more ordinary applications. The
[environment lifecycle](../app-sandbox-runtimes/feature.md) owns its instance identity, separate
data root and accounts, app installations, resource reservations and cleanup. Harness and the SDK
use the existing environment API and ordinary child authentication. Applications contain no
sandbox-specific identity branches.

## Retired Architecture And Upgrade

The single-app runtime, relay, private browser worker, fixture personas, special service
credentials and authentication endpoints are removed. Core no longer exposes
`/api/sandbox-instances` or `/api/sandbox-runtime`, including internal app routes. Removed
`apps.sandboxes.*` grants confer no environment authority. Existing
`core.environments.read/manage` permissions require ordinary review; no grant conversion occurs.

The TypeScript SDK no longer exports the legacy sandbox client or special identity helpers.
Harness removes the corresponding tools, dispatch and cancellation branches, manifest permissions
and prompts. Demo uses ordinary Core identity and app roles. Generic environment helpers and the
existing sandbox event topic remain because they serve child Cores, not the retired architecture.

The operator deletes existing sandboxes before upgrading. There is no state migration, automatic
drain, compatibility adapter or old-runtime reader. Parent credentials, provider connections and
ordinary app data are not copied into test instances. The child retains the existing trusted-Core
model and shared Docker access; it is not an isolation boundary for hostile Core code.

Artifact versions for this change are Core/CLI **0.163.0**, Shell **0.118.0**, Harness **0.79.0**,
Demo **0.20.0** and TypeScript SDK **0.37.0**. The .NET SDK has no retired-runtime consumer and is
unchanged. Canonical app skills, the served development guide and affected feature documents
describe the single model.

## Existing Creation And Build Independence

Creation, initialization, executable selection, Start/Stop/Restart and child updates retain their
existing behavior:

- `current` privately copies the running parent's prepared executable closure.
- `release` privately copies the installed native Core binary.
- `source` builds the selected authorized workspace project into child-owned output.

The manual dialog uses `release` and has no workspace selector. It copies the locally installed
production Core even when the parent runs workspace code; it neither downloads the latest online
version nor falls back to a workspace if the installed binary is absent. Application selections use
their published distribution channels, independently of the parent's live app workspaces.
Explicit agent requests retain `current`, `release` and authorized `source` modes. Selecting application worktrees
alone does not turn Core into a source build. A continuing child keeps its private executable when
the parent updates. Parent-issued Start/Restart still prepares the selected mode again; this is
not a permanent version pin across every lifecycle operation. An explicit update inside a child
is independent of an update to its parent.

The observed child version is correlated with its running process identity and retained as the
last observed version on Stop. Neither a newly prepared executable nor the parent's version is
substituted for the actual child process. Source association remains separate from version
observation.

## Dashboard And Environment Details

The upper Core instances section contains the connected **Hosty Core** first, then named child
environments. There is no extra Primary marker, separate bottom Sandboxes frame or Refresh
sandboxes button. **Create environment** sits above the section. App, Core and child rows share
the sidebar lime hover across their full width, including actions, in both themes.

Known workspace-backed Core rows show the workspace's human-readable name; copied-build children
show their own observed version. An unavailable workspace is not replaced with an opaque ID or
another workspace's name. A direct source launch without a matching registered workspace retains
its source/branch presentation.

Each child row shows its lifecycle status and actual Core CPU/RAM. The existing sampler and shared
resource stream deliver bounded history; there is no per-row polling. Samples are scoped to the
authorized owner and correlated with PID and process start identity. Stopped/finished children
show no live readings, and child Core usage does not inflate the ordinary Apps total.

The primary action is **Sign Up** before administrator setup, then Stop while running or Start
while stopped. Other actions live in the overflow menu; Open Core appears after administrator
setup. Clicking the child's name or choosing **Environment Details** opens a dedicated dialog
with installed applications, their runtime/health state, and resources/access information. The
Dashboard row has no inline disclosure. Closing the dialog restores keyboard focus to its row.
Initialization and operation errors appear as a compact error icon beside the environment name.
Its tooltip exposes the full message on hover or keyboard focus; Environment Details also keeps
the message visible. Creating, starting, stopping, restarting, deleting and application preparation
or installation progress appear below that environment's status. No global operation banner or
disabled retry button is displayed during an active request. An uncertain response exposes an enabled
exact-request retry below the same status; a pending creation uses a temporary row until its receipt
matches the environment inventory.

The creation dialog has a persistent header/footer and no wizard steps. Accepted creation closes
the dialog, with subsequent initialization progress in the row. Deletion emits a toast naming
the environment. Existing operation IDs, failed-operation recovery, source preservation and
owner-driven Finish remain intact.

## Workspace Restart And Switch Recovery

An app restart from the same active workspace/source/runtime keeps only previously admitted
workspace permissions that are still granted and requested. It does not restore revoked access
or retain removed optional permissions. Package baseline permissions remain separate, so Return
removes temporary workspace authority. New access still needs ordinary Core review. See
[app development controls](../app-development-controls/feature.md).

A Core switch rejected before admission can have no activation record. Shell preserves that
original refusal instead of replacing it with a later missing-record message. It permits fresh
review of the same selection and retains the original request ID for a reviewed retry. Workspace
writer leases still prevent activation while editing/building is active; this change does not
bypass that gate. See [workspace activation](../workspace-live-activation/feature.md).

## Verification Record

Verified on macOS arm64 on 2026-10-29, with Linux application containers:

- `npm run core:test`: 4,345 passed, five optional Docker/VPN cases skipped by existing availability
  gates. Affected environment, cleanup, stream, authorization and resource regressions passed
  200 cases. The final workspace-consent/Return selection passed 36 cases.
- `npm run cli:test`, `npm run sdk:test`, `npm run harness:test` and Demo's identity/role suite:
  334, 699, 1,883 and 10 tests passed respectively.
- Shell component tests: 798 passed before the final focus test; the final affected selection
  passed 90 tests including focus restoration and both reported recovery regressions. Shell's
  206 Node tests passed before the final presentation-only changes.
- Core/CLI, SDK, Shell, Harness web and Demo production builds passed. Shell/Harness lint had no
  errors and retained existing warnings. Core Native AOT passed with no new trim/AOT warnings;
  its smoke process became ready in 1,052 ms with a 61,336,728-byte executable.
- `npm run test:integration -- shell`, `-- sessions`, `-- dependencies` and `-- activation`
  passed. These cover normal password accounts, Docker app identity, workspace isolation and
  revocation, dependencies, cancellation, same-request recovery, helper interruption, live
  events and owner-driven cleanup. One initial dependency run hit a port collision; its repeat
  passed without changing allocation.
- Managed browser checks covered password login, empty-child creation, Sign Up, Environment
  Details, actual child version and separate Core resources, stop/start, deletion and responsive
  light/dark presentation. The final Shell image became healthy in 3.21 seconds. Child Core RSS
  was approximately 144–157 MiB during that run, distinct from the parent process reading.
- Each completed managed fixture confirmed removal of owned processes, listeners, Docker
  resources, data roots, credentials and workspace consumers. Logs and screenshots remain
  outside the repository. No production lifecycle or permission change was used for acceptance.

Native Windows, native Linux-host and amd64 worker acceptance were not run here. They remain
tracked by the existing [host-matrix plan](../app-sandbox-runtimes/plan.md); macOS and Linux
containers do not establish those claims. Separately scoped remote preview and initialization
deliverables also remain in their owning plans.

## Testing Expectations

On 2026-10-29, a manual browser creation from a workspace-backed parent selected the local
production binary, observed child Core 0.162.0, installed published Shell 0.116.4 and Marketplace
0.12.2, reached healthy app state and exposed Sign Up. Creation/deletion progress appeared below the
child status. Finish removed its owned root and containers. The release-selection regression also
checks a missing installed binary refuses fallback and later parent-binary changes do not alter
an already prepared child copy.

Keep meaningful coverage for empty/one/multi-app environments, current/release/source independence,
ordinary users and app roles, absent legacy routes and insufficient legacy grants, ownership,
nested quotas, interruption/replay and complete Finish cleanup. Retain process identity and stale
resource tests, version observation, workspace labels, accessible details/actions and live-event
recovery. Workspace permission tests must cover removed and revoked grants and Return; Core
switch tests must preserve both original refusals and the original retry identity.

Run affected Core/CLI, SDK, Harness, Shell and Demo checks and managed integration suites before
publication. Validate versions and documentation with `node scripts/check-versions.mjs`,
`node scripts/docs-index.mjs --check` and `git diff --check`. Keep source and ordinary data
outside disposable fixture cleanup.


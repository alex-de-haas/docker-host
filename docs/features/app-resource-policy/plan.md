---
status: Draft
created: 2026-10-21
updated: 2026-10-21
summary: Operator-owned Core defaults and per-application resource limits, independent of app manifests and bounded by environment policy.
components: [apps/core, apps/cli, apps/shell]
---

# Core Application Resource Policy

## Goal And Owner Decision

On 2026-10-21 the owner requested that resource limits be removed from app manifests, with
`app.0.1` compatibility restored, and that Core-owned resource management be planned separately.
The operator controls the maximum an application may consume. An application cannot grant itself
more memory, CPU or processes by publishing a manifest. This plan authorizes no implementation;
concrete defaults and migration behavior still require approval.

## Baseline And Target

[Runtime manifests](../runtime-app-manifest/feature.md) ignore service runtime `resources` fields.
Ordinary Docker launches have no Core default memory/CPU/PID cap. Running containers may retain
limits set at their creation; a Core upgrade or keep-apps adoption does not rewrite them.

[Child Core environments](../app-sandbox-runtimes/feature.md) already own bounded allocations:
`CoreEnvironmentResources` admits applications against a parent reservation, divides an app's
share across its Docker services, verifies limits on adoption and retains reservations until
Finish. Sandbox-specific resource controls also remain separate enforceable boundaries.
[Runtime resource usage](../runtime-resource-usage/feature.md) observes Docker and local process
trees; measurement alone is not enforcement.

Add an operator-owned policy to Core for ordinary applications, with instance defaults and
per-application overrides. Reuse the existing lifecycle, settings, observation and environment
boundaries. Keep the app manifest schema unchanged; do not add resource fields, derive grants
from old `resources` values or send these administrative settings into the app's environment.

## Target Behavior

### Ownership And Effective Policy

- Persist policy in Core, scoped to the instance and application installation. App settings and
  published/source manifests do not own it. App updates, runtime switches and dev-mode Return
  preserve operator choices; reinstall/removal semantics must be explicit.
- Only an authenticated operator with the existing appropriate administrative authority can
  read/change policy. App service identities cannot change their own limit. Existing API/CLI/MCP
  authorization must be reviewed before exposing any mutation surface; do not create an implicit
  permission through manifest installation or an app's ordinary settings route.
- Show inherited defaults, explicit overrides, effective allowed values and the policy source.
  Resetting an override restores inheritance. A per-app override may exceed an instance default
  when the operator chooses it, but cannot exceed an enclosing environment's hard allocation.
- Treat memory and CPU values as maximum consumption, not guaranteed/reserved host capacity.
  Existing parent environment admission continues to reserve logical budget where it does today;
  the UI must distinguish that reservation from actual usage and Docker capacity.
- Define one total application budget across all Docker services. Adding a service cannot multiply
  the application's allowance. Reuse or deliberately revise the existing service-share allocator,
  accounting for memory/PID integer rounding, CPU precision and per-service minima. Refuse an
  unrepresentable allocation before stopping the current runtime.

### Defaults And Migration

- A starting proposal is **1 GiB memory and 1 logical CPU per new application**. These values are
  discussion inputs, not approved requirements. PID and swap behavior are open decisions below.
- Version and persist defaults so an upgrade cannot silently choose new limits. Define whether an
  operator's later default change affects inherited apps immediately or creates pending changes.
- Preserve existing installations' effective behavior until the operator explicitly chooses a
  resource policy. Do not silently impose a new cap on working apps or import manifest-authored
  limits as operator-approved overrides. Display existing container caps separately if present.
- Make removal of a cap and resetting to a default distinct actions if unlimited mode is supported.
  Explain unsupported values against actual Docker/VM capabilities rather than promising host RAM
  or CPU that the engine cannot provide.

### Lifecycle And Operator Experience

- Add instance defaults and per-app controls to existing Core/Shell administration and the ordinary
  CLI workflow. Keep labels in user units (GiB/MiB and logical CPUs), and retain precise API values.
- Load settings on entry and refresh after mutation; preserve unsaved edits. No new background
  polling or stream is needed for these rarely changed values. Reuse existing resource observations
  for actual consumption when shown alongside policy.
- Distinguish saved desired policy from verified applied policy. Show when applying requires app
  restart/recreation and obtain that action through existing lifecycle controls. Saving a value
  alone must not unexpectedly kill a running application or claim enforcement succeeded.
- Keep prior applied state and actionable errors after failed admission/recreation. Cover stop/start,
  updates, partial service failure, Core keep-apps adoption, runtime changes, dev-mode Return and
  rollback without losing the operator's settings or weakening a parent limit.
- Start with Docker enforcement. Local/native and mixed profiles keep their supported execution;
  display exactly which services are enforceable. Do not advertise an application-wide hard cap
  for a mixed profile whose native services cannot be capped. Native enforcement requires its own
  explicit design and OS verification; do not invent Docker support for native workloads.
- Surface verified OOM/limit-related failures separately from generic manifest errors when evidence
  exists. Unknown state remains unknown; CPU throttling or high memory samples alone do not prove
  an application was killed by its policy.

## Interactions And Scope

- **Child Core and sandboxes:** enclosing allocation and admission remain authoritative. An app
  override cannot bypass reservations, borrow another environment's budget or weaken Finish cleanup.
  Reconcile the shared allocator without duplicating sandbox ownership or its deliverables.
- **Harness:** api/worker use the same app policy as any other application. There is no worker-specific
  allowance or new manifest extension. Existing run concurrency and security controls remain owned
  by [Harness services](../assistant-shared-docker-runtime/plan.md).
- **Resource usage:** reuse the sampler; its measurements are not limit enforcement. Do not duplicate
  the Dashboard/Telemetry transport or introduce a second collector.
- **Updates/development:** operator policy belongs to the installed app, not its version, worktree or
  selected runtime recipe. Verify destination representability before disrupting a running source.
- **Out of scope:** scheduling, guaranteed host reservations for ordinary apps, autoscaling, disk or
  network quotas, provider-token budgets, new manifest contracts and native OS enforcement.

## Deliverables

- [ ] D1. Approve defaults, units, PID/swap behavior, unlimited/reset semantics, migration, inheritance and multi-service allocation; document the desired/applied contract and runtime support matrix.
- [ ] D2. Persist instance defaults and installation-scoped overrides with versioned migration, effective-policy resolution and operator-only authorization; verify applications and manifest updates cannot grant or replace policy.
- [ ] D3. Implement Docker enforcement through the shared allocation path, including aggregate service budgets, parent-environment ceilings, adoption verification and preflight refusal without disrupting a valid current runtime.
- [ ] D4. Integrate desired/applied policy with install/start/restart/update, partial-service failure, runtime switching and dev-mode Return; preserve operator settings and expose recovery after failed application.
- [ ] D5. Add Core/Shell instance and app settings plus CLI operations, showing inheritance, effective/applied values, pending restart, supported runtimes and evidence-based limit failures without losing unsaved edits.
- [ ] D6. Verify legacy compatibility, unauthorized changes, multi-service and mixed runtimes, environment ceilings, actual Docker caps and restart/recovery behavior in isolated Core-managed environments; confirm Finish cleanup and record platform gaps.
- [ ] D7. Publish current behavior and migration/operator guidance in feature documentation, update related documents and artifact versions, regenerate the index and delete this plan only after all deliverables pass.

## Phases

1. Resolve D1 and approve the plan before implementation.
2. Implement policy, persistence and enforcement (D2-D4) on one branch with focused regressions.
3. Deliver operator surfaces and isolated acceptance (D5-D6), then complete documentation (D7).

One implementation PR owns the feature; phases do not create separate feature releases.

## Open Questions

- Are 1 GiB and 1 logical CPU appropriate initial defaults for new ordinary apps? What PID ceiling
  and swap policy should accompany them, and should operators have an explicit unlimited option?
- Should inherited apps follow a changed instance default on their next explicit start, or require
  a separate reviewed apply? How are legacy uncapped apps and already capped adopted containers
  presented until an operator chooses a policy?
- Is equal service splitting sufficient for v1, or are operator-owned service weights needed inside
  the total application budget? A per-container copy of the app limit is not acceptable.
- Should v1 apply policy only through normal restart/recreation, or support Docker live updates?
  Any live-update design must specify partial failure, desired/applied state and memory-reduction
  consequences before implementation.

## Verification

- Unit tests: default/override precedence, reset, persistence/migration, update/reinstall semantics,
  bounds, finite CPU values, integer rounding, aggregate allocations and parent ceilings.
- Authorization tests: administrator changes succeed; ordinary users, app identities and unrelated
  instances cannot mutate policy. Manifest/resource fields remain inert under `app.0.1`.
- Lifecycle tests: legacy starts and updates, failed preflight before Stop, partial apply/rollback,
  keep-apps adoption, restart, Docker/Local/mixed switches and workspace Return preserve policy.
- Core-managed sandbox: normal setup/login, Shell/CLI settings, disposable multi-service workloads,
  Docker inspection of actual limits, controlled memory/CPU pressure and retained data through
  failure/recovery. Do not exercise pressure workloads against ordinary app data or the live Core.
- Confirm test consumers stop, Finish through the owning lifecycle and verify process/container,
  reservation and scratch-data removal. Report supported OS/engine coverage and untested platforms.
- Run affected Core/CLI/Shell tests/builds and Native AOT, relevant local integration suites, version
  consistency and docs/link validation before publication.

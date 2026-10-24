---
status: Draft
created: 2026-10-22
updated: 2026-10-24
summary: Remove remaining app-specific bootstrap configuration and migrations from generic Core policy while preserving explicit installation choices and headless operation.
components: [apps/core, apps/cli]
---

# Application-neutral Distribution And Compatibility

## Goal And Owner Direction

On 2026-10-22 the owner required Core to remain a platform independent of every standard runtime
application. App IDs are opaque keys, not privileged built-ins. An empty or third-party-only app
registry is a supported installation. The rule is recorded in [AGENTS.md](../../../AGENTS.md#core-platform-boundary)
and [vision decision 53](../../vision.md). This Draft records remaining work and authorizes no
implementation or lifecycle changes.

The [current feature](feature.md) describes distribution catalog and lifecycle behavior. The
[boundary audit](../../reviews/2026-10-22-core-application-boundaries.md) distinguishes catalog data,
scoped historical compatibility and active app-specific runtime decisions. Literal IDs in optional
catalog entries or test inputs are not evidence of a hidden prerequisite; they must never select
platform behavior. The built-in catalog's embedding location does not make its members required.

## Target Behavior

Replace the remaining app-ID branches in deprecated Shell/Collector/Marketplace bootstrap settings
with generic installation data and explicit per-app operator choices. Preserve existing operator
intent through a bounded migration design; do not silently drop settings, install replacements,
rewrite sources or restore removed apps. Generic Core code must not choose an application by vendor
name, repository path or standard ID when a declared interface and reviewed selection are required.

Retired Harness/Marketplace preference keys currently have exact app/key migration handling in
Core. Decide their owning migration path and retirement conditions explicitly. Historical identity
may be migration input only, never a new runtime role, permission, discovery rule or permanent
allowlist. Keep compatibility failures visible without making Core depend on those apps.

Platform help and diagnostics must remain accurate without Shell/Harness. Describe the supported
Core/CLI/API operation and a declared UI destination when available, rather than assuming a named
app is installed. Remove dead Shell launch configuration under the same compatibility checks.

## Ownership And Dependencies

- [Replaceable UI clients D3/D4/D5](../replaceable-ui-clients/plan.md#deliverables) owns browser UI
  discovery, all app-owned navigation routes, selection-aware confirmation/removal warnings and UI
  compatibility. This plan does not duplicate those deliverables.
- [Observability D12](../observability/plan.md#deliverables) owns telemetry provider identity,
  collector-specific provisioning and the sampling gate.
- [Hosty initialization](../hosty-initialization/plan.md) owns its existing approved installation
  journey and acceptance. Its implementation progress is not reset by this separate Draft.
- Explicit CLI commands aimed at a named app, including the optional legacy Shell-update action,
  do not imply a dependency of generic Core. Any removal or replacement of an existing CLI flag
  needs its own compatibility decision; do not silently break it during cleanup.

## Deliverables

- [ ] D1. Agree and implement a bounded migration away from app-ID-specific bootstrap/environment mappings in SystemAppBootstrap and Core launch configuration, keeping optional distribution entries as data and preserving saved per-app selections, autostart, source choices, ports and deliberate absence.
- [ ] D2. Assign and implement retirement of the exact Harness/Marketplace preference migration cases without losing operator configuration; keep historical identity matching confined to migration input and out of generic runtime decisions.
- [ ] D3. Remove stale Shell launch variables after proving they have no active consumer; make platform diagnostic/help copy valid for headless and third-party-only installations. UI navigation and UI-specific review copy remain owned by the linked UI-client plan.
- [ ] D4. Verify custom/empty distribution data, zero standard apps, unrelated app IDs, restart, removal and migration replay; document the resulting reality, delete this plan only after every deliverable passes and regenerate the index.

## Open Decisions

- Which persisted settings and deprecated environment inputs still need migration support, and for
  how long? A code comment saying "one release" is not evidence that every installed host migrated.
- Should distribution defaults remain an embedded data resource or a separate release artifact?
  Either choice must preserve configurable/empty distributions and keep IDs out of runtime policy.
- Which application-owned migration mechanism replaces retired app preferences without expanding
  authority or copying secrets between apps?

## Verification

Use isolated registries and explicit nonstandard app IDs. Exercise no apps, only third-party apps,
removed standard apps and explicit initialization with an empty selection. Verify no implicit install,
UI substitution, privilege, source switch or config overwrite. Test migration retries and interrupted
writes against preserved original state. Run affected Core/CLI checks when implementation is approved;
this planning change requires documentation/link validation only.

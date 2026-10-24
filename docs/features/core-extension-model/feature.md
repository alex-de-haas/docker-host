---
created: 2026-10-10
updated: 2026-10-24
summary: Current boundaries between runtime apps, confirmed provider roles, Core permissions and platform-owned operations.
components: [apps/core, apps/shell]
---

# Core Extension Model

Hosty delivers optional platform functions as ordinary out-of-process runtime apps. Marketplace,
Telemetry, Harness and Whisper use the same installation, update and removal lifecycle as other
apps. Core owns authorization, installation review, manifest validation and privileged lifecycle
operations. There is no general in-process extension loader or universal driver registry.

## App-Neutral Platform Boundary

[Vision decision 53](../../vision.md) records the owner's absolute platform rule: Core remains
usable without the standard application bundle. Application IDs, names, vendors and repository/path
spellings carry no built-in behavioral, ownership or authority semantics. Core-owned APIs and
CLI, authentication, setup and recovery remain available headlessly. App selection and integrations
use registered facts, confirmed roles/interfaces and effective grants. Core does not own or
construct a first-party application's internal UI routes. The reserved `hosty:core` identity is the
platform resource, not a privileged runtime app.

This boundary is not fully implemented in the current source. Legacy coupling remains in the
Shell-specific origin resolver and navigation callers, workspace-owner links into Harness,
identity-specific UI removal warnings, historical bootstrap configuration and collector/provider handling.
The [2026-10-22 audit](../../reviews/2026-10-22-core-application-boundaries.md) records concrete current
locations and failure modes; it does not claim those paths are repaired. Application identities in
catalog/manifest data do not authorize identity-specific platform behavior. Historical exact
identities may appear only in bounded one-time migration data, never in runtime fallback lookup
or permission/role grants.

Navigation and workspace-owner links are owned by
[Replaceable UI Clients D3](../replaceable-ui-clients/plan.md#deliverables). D4 owns selected/last-UI
removal warnings; D8 owns inventory and role-derived lifecycle consequences. Legacy bootstrap
configuration/migration stays with [Removable System Apps](../removable-system-apps/plan.md), and
collector/provider coupling stays with [Observability D12](../observability/plan.md#deliverables).
These existing feature owners retain their approval boundaries; there is no renewed umbrella
implementation plan.

## Roles and permissions

`provides` contains string roles; `interfaces` separately describes endpoints and versions.
Core recognizes consent-bearing `assistant` and `speech-to-text` roles, persists their confirmation
at review, and authorizes category discovery and short-lived provider tokens. Provider selection
and readiness are separate from a role grant. The legacy `otlp-collector` slot selects provisioning
and startup ordering from the installed declaration; it is not a consent-bearing provider role.

`corePermissions` and `optionalCorePermissions` request access. Core checks persisted effective
permissions on management calls together with the acting user's rights; declarations alone confer
no permission. Optional choices and grant changes use Core-owned confirmation. See
[app permission management](../app-permission-management/feature.md),
[provider consumption](../provider-consumption/feature.md) and
[assistant MCP access](../agent-mcp-directory/feature.md).

## Ownership and boundaries

App assignments apply to ordinary and system apps. Installed-app lists and lifecycle actions are
shared. `InstallOrigin = distribution` records Core's distribution provenance, while the manifest
`role: system` remains a separate legacy field. Residual uses include the facade's on-behalf-of
route and the choice of app-session lifetime policy; the field is not a universal permission grant.
The old exchange route rejects cross-app exchange; assistant MCP calls use installation-bound
assistant-to-target grants instead. Core seeds distribution apps once and does not reinstall an
intentionally removed app on every restart.

Core telemetry metrics and logs are pulled by Telemetry; app OTLP producers push to its collector.
The [Core event bus](../core-event-bus/feature.md) carries ephemeral refresh hints, without a durable
replay contract. Local password login and authorization remain Core-owned.

The owner retired the umbrella implementation plan on 2026-10-10. Direction and the transfer of
remaining work are recorded in [vision decision 31](../../vision.md); each contract has a feature owner.

## Testing Expectations

- Verify Core-only startup, setup/login, configuration, CLI/API and recovery with no standard apps,
  plus equivalent declared interfaces from unrelated application identities. App names, vendors and
  repository layouts must not select behavior or grants; first-party internal routes stay app-owned.
- Assert grants and provider-role confirmation independently of manifest requests and system labels.
- Revalidate app permissions, actor rights and provider/target access at their existing enforcement points.
- Cover denied/revoked access and unavailable providers, alongside successful authorized calls.
- Keep telemetry transport and ephemeral-event documentation consistent with their owning implementations.

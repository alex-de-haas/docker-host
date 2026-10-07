---
created: 2026-10-07
updated: 2026-10-07
summary: Core owns a typed source-provider registry with built-in GitHub, owner-scoped connections and Shell account management.
components: [apps/core, apps/shell, apps/harness]
---

# Source Providers

Core's internal `ISourceProvider` contract supplies provider descriptors, device/PAT authorization,
identity checks, token renewal, repository/file resolution, authenticated reads and Git headers.
`SourceProviderRegistry` resolves a stable provider ID or a provider-owned URL; it never selects a
user account. Duplicate IDs fail registration. GitHub is the only registered adapter and composes
`IPublicationProvider` for PR operations. Publication records persist their provider ID; older records
retain GitHub as their default. Shared services resolve the adapter instead of branching by vendor.

Core retains user ownership, live app authorization, credential storage, refresh serialization,
auditing, reviewed repository grants, bounded network transport and local Git execution. Provider
implementation arguments include credentials and stay inside Core. This internal contract is not
an external RPC protocol, SDK provider category, plugin loader or separate running application.

GitHub connections preserve their IDs, credentials, original OAuth registration IDs and private-source
bindings. Azure DevOps is absent from active descriptors and authorization methods. Saved records stay
in the owner-only store and appear as unsupported; checks and use fail explicitly. Owners can rename
or disconnect them. Bound applications retain their grant references and receive an actionable error.
Public generic Git transport remains independent of the private-provider registry.

Shell owns **Settings → Security → Source connections** and Git attribution. Its optional `sources.connections`
permission requires Core review. The existing `apps.sources.full` permission authorizes source work and
sanitized selection, without account-management authority. Both retain current-administrator and
owner checks. A private installation/source-binding update additionally requires `apps.install`, and
Core rechecks effective permissions and ownership at prepare, submit, status and execution.

Shell's manifest installation selects private accounts independently; app Source settings can keep,
replace or clear bindings through a reviewed update. Public installation remains available without
connection-management permission. Harness retains source/PR consumer operations and a read-only
selection proxy. Its old settings deep link explains the move to Shell; management and installation
forms and their proxy routes are removed.

See [user connections](../user-profile-connections/feature.md),
[private app sources](../private-app-sources/feature.md),
[publication](../assistant-pr-lifecycle/feature.md) and
[permission management](../app-permission-management/feature.md) for the owning workflows.

## Testing Expectations

- Exercise device/PAT/refresh flows, original registration retention, registry resolution, URL validation,
  private reads and existing publication retries with deterministic provider fixtures.
- Preserve unsupported Azure records and reject use without remote calls or credential disclosure.
- Verify the management/use permission split, current-owner checks and both supported private-review
  permission combinations, including revocation between review, submission and execution.
- Cover Shell connection forms, copying, cancellation, missing grants and source-selection persistence;
  reject Harness mutations and installations while retaining its consumer selection path.
- Build/test Core and Native AOT, Shell and Harness; validate Core-managed browser surfaces, version
  consistency and the generated documentation index. Live provider consent is a separate user action.

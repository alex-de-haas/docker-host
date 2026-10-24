# Core Application Boundaries Audit — 2026-10-22

## Baseline and scope

This is a static source audit of Core production code on 2026-10-22. The baseline is
commit `20841bebea7eb0e5ac80ee8c0c69abb5e8391d1a` plus the uncommitted source in the
registered Hosty redesign workspace inspected that day. It is not a review of a clean
commit diff, a fresh runtime acceptance report or a guarantee covering every possible
installation. No Core production code changed as part of this audit.

The question is whether Core can serve as an application-neutral platform: standard
applications are optional, their IDs do not imply authority, and private application
routes or implementation details do not become platform contracts implicitly.

The source already handles missing Shell and intentionally removed applications in
several paths. The remaining issues below primarily concern provider replacement,
navigation and compatibility boundaries; they do not establish that Core refuses to
start without standard applications. Existing tests were inspected, not rerun.

## Active coupling

Line numbers identify the inspected working-copy baseline and may move later.

| Area | Verified source | Current behavior and practical consequence | Owning work |
| --- | --- | --- | --- |
| Default browser UI selection | [ShellPublicOriginResolver.cs](../../apps/core/src/Haas.Hosty.Core/ShellPublicOriginResolver.cs), lines 61–75 | Resolves `hosty.shell`, preferring its `web` endpoint. Missing Shell returns null, but another compatible UI cannot take its place. Selection and readiness are not independent here. | [Replaceable UI clients](../features/replaceable-ui-clients/plan.md), D3; D4 covers recovery and D5 bounds compatibility migration. |
| Shell page construction | [ControlIdentityEndpoints.cs](../../apps/core/src/Haas.Hosty.Core/ControlIdentityEndpoints.cs), lines 129–141 and 168–169; [AgentMcpDirectory.cs](../../apps/core/src/Haas.Hosty.Core/AgentMcpDirectory.cs), lines 108–112; [WorkspaceInspectionService.cs](../../apps/core/src/Haas.Hosty.Core/WorkspaceInspectionService.cs), lines 200–207 | Shell-mode open constructs `/workspace?app=...&path=%2F`; the agent directory appends `/settings`; workspace consumers receive `/settings?tab=<appId>`. Core therefore knows private Shell routes. The consumer link is stale after standalone App Details navigation changed. | Replaceable UI clients D3. Removing the current Harness consumer links does not replace this Core contract. |
| Harness workspace destination | [WorkspaceInspectionService.cs](../../apps/core/src/Haas.Hosty.Core/WorkspaceInspectionService.cs), lines 274–283 | The `hosty.harness` owner forcibly maps to `/development?session=...`; other owners use their recorded `SessionPath`. Core must change when this Harness route changes, despite already having a generic destination field. | Replaceable UI clients D3, including the recorded-path and retained-installation migration. |
| Telemetry discovery and sampling | [CoreLifecycleService.cs](../../apps/core/src/Haas.Hosty.Core/CoreLifecycleService.cs), lines 4784–4794; [RuntimeResourceSampler.cs](../../apps/core/src/Haas.Hosty.Core/RuntimeResourceSampler.cs), lines 179–184 | Producer wiring resolves only `hosty.telemetry` and `otlp-http`, with a same-ID self-export exception. Without browser viewers, background resource sampling depends on that app being up. An alternative provider does not receive equivalent discovery or sampling behavior. Absence is a no-op rather than a startup requirement. | [Observability](../features/observability/plan.md), D12. |
| Implementation-specific capability provisioning | [PlatformCapabilities.cs](../../apps/core/src/Haas.Hosty.Core/PlatformCapabilities.cs), lines 45–48; [CollectorBootstrap.cs](../../apps/core/src/Haas.Hosty.Core/CollectorBootstrap.cs), lines 19–26 and 65–70, plus `ConfigYaml` | The generic `otlp-collector` declaration triggers Core-owned otelcol configuration and expected log/trace/store directories, including `/etc/otelcol-contrib` paths. Accepting arbitrary IDs does not make this filesystem and configuration contract implementation-neutral. | Observability D12. |

### Resolver consumers and continuations

The UI resolver is consumed by status, login, setup, invitation, recovery and OIDC
completion in [HostyCoreApplication.cs](../../apps/core/src/Haas.Hosty.Core/HostyCoreApplication.cs),
lines 275–298, 319–350, 366–373 and 401–406; by
[AuthBootstrapEndpoints.cs](../../apps/core/src/Haas.Hosty.Core/AuthBootstrapEndpoints.cs),
lines 31–54; and by [HostInitializationService.cs](../../apps/core/src/Haas.Hosty.Core/HostInitializationService.cs),
line 72. [AuthEndpoints.cs](../../apps/core/src/Haas.Hosty.Core/AuthEndpoints.cs),
lines 381–412, binds validated legacy relative continuations to the Shell origin.

Replacing only the resolver's chosen origin would be insufficient: a different UI
need not implement Shell's page tree. Replaceable UI clients D3 owns the complete
navigation/continuation audit, while D5 owns narrowly scoped legacy migration.
The shared initialization response still names its optional destination `ShellUrl`
([Initialization.cs](../../shared/Initialization.cs), line 13). That is a legacy
contract field rather than an app lookup; any rename requires compatibility work in D3.

## Distribution, compatibility and diagnostic copy

These occurrences need different treatment from live provider discovery. Removing
all matching strings indiscriminately would risk configuration loss or erase valid
optional distribution data.

| Category | Verified source | Interpretation and owning work |
| --- | --- | --- |
| Optional distribution data | [DistributionApps.cs](../../apps/core/src/Haas.Hosty.Core/DistributionApps.cs), lines 74–112 | Embedded Shell, Telemetry, Marketplace and Harness entries describe an optional release catalog. A custom list is supported. Membership does not itself grant authority or lifecycle immunity. Preserve data-driven optional entries; [removable system apps](../features/removable-system-apps/plan.md) D1 bounds bootstrap migration and D4 verifies empty/custom distributions. |
| App-specific bootstrap configuration | [SystemAppBootstrap.cs](../../apps/core/src/Haas.Hosty.Core/SystemAppBootstrap.cs), lines 73–95 and 115–143; [HostyCoreApplication.cs](../../apps/core/src/Haas.Hosty.Core/HostyCoreApplication.cs), lines 917–930 and 993–1021 | Shell/Collector/Marketplace IDs select legacy environment mappings, and Core launch configuration retains Shell source/autostart/runtime fields. These are explicit configuration/compatibility paths, not hidden app presence requirements. Removable system apps D1 owns bounded migration preserving saved selections and deliberate absence. |
| Retired native preferences | [CoreLifecycleService.cs](../../apps/core/src/Haas.Hosty.Core/CoreLifecycleService.cs), lines 3798–3800, with consumers at 656 and 3828–3830; [AppRegistryStore.cs](../../apps/core/src/Haas.Hosty.Core/AppRegistryStore.cs), line 1191 | Exact Harness/Marketplace ID-and-key pairs preserve and hide old settings for migration. They do not discover providers or grant permissions. Removable system apps D2 owns retirement without losing operator configuration. |
| UI-specific approval guidance | [InstallationApprovalEndpoints.cs](../../apps/core/src/Haas.Hosty.Core/InstallationApprovalEndpoints.cs), lines 655, 724–725, 760 and 853 | Configuration and removal text identifies Shell by ID and assumes it is the operator's browser UI. Replaceable UI clients D4 owns selected/last-UI warnings; D3 owns navigation-related guidance. |
| Generic platform help with app names | [PrivateSourceService.cs](../../apps/core/src/Haas.Hosty.Core/PrivateSourceService.cs), lines 28 and 189; [PublicationExternalReferences.cs](../../apps/core/src/Haas.Hosty.Core/PublicationExternalReferences.cs), lines 39 and 44; [McpEndpoints.cs](../../apps/core/src/Haas.Hosty.Core/McpEndpoints.cs), line 391; [PlatformCapabilities.cs](../../apps/core/src/Haas.Hosty.Core/PlatformCapabilities.cs), line 35; [WorkspaceActivationService.cs](../../apps/core/src/Haas.Hosty.Core/WorkspaceActivationService.cs), line 242; [WorkspaceInspectionService.cs](../../apps/core/src/Haas.Hosty.Core/WorkspaceInspectionService.cs), line 277 | Text sends operators to Shell/Harness or names these apps as examples. It can mislead headless or third-party-only users but does not itself change authority. Removable system apps D3 owns application-neutral diagnostic/help copy; UI-specific guidance remains in the UI-client plan. |
| Completion-page help | [HostyCoreApplication.cs](../../apps/core/src/Haas.Hosty.Core/HostyCoreApplication.cs), lines 729, 815 and 897 | Setup/recovery/invitation completion suggests installing Shell when none is resolved. Authentication remains Core-owned. UI-client D3/D4 owns correct navigation and recovery guidance. |
| Unused helpers and launch variable | [CollectorBootstrap.cs](../../apps/core/src/Haas.Hosty.Core/CollectorBootstrap.cs), lines 51–56; [launchSettings.json](../../apps/core/src/Haas.Hosty.Core/Properties/launchSettings.json), line 11 | Exact-ID log/trace sink-path helpers have no production callers found; `HOSTY_SHELL_PORT` is no longer read by Core. Observability D12 owns retiring the collector helpers; removable system apps D3 owns stale launch configuration. |

## Boundaries already expressed generically

- `hosty:core` is the reserved platform audience in
  [AuthLifetimes.cs](../../apps/core/src/Haas.Hosty.Core/AuthLifetimes.cs), line 150,
  and the Core directory identity in [AgentMcpDirectory.cs](../../apps/core/src/Haas.Hosty.Core/AgentMcpDirectory.cs),
  line 64. It is not an optional runtime app and must not be removed as an app-ID exception.
- Installed app records, app identity/service grants, assignments and declared roles
  supply the inspected origin, authorization and lifecycle decisions. The removed
  Shell-specific primary-session CORS provider is not a current dependency.
- Telemetry pull routes in [CoreLogEndpoints.cs](../../apps/core/src/Haas.Hosty.Core/CoreLogEndpoints.cs),
  lines 67–95, and [LifecycleEndpoints.cs](../../apps/core/src/Haas.Hosty.Core/LifecycleEndpoints.cs),
  lines 526–552, resolve an installed caller and existing permissions rather than
  requiring a fixed Telemetry ID.
- No production exact-ID branches for Whisper, Plans or Workspaces were found in
  this scan. Their appearances in tests do not establish special platform treatment.
- Existing source/test cases cover a missing Shell, an empty registry during explicit
  initialization and deliberate app removal. In particular,
  [ShellPublicOriginResolverTests.cs](../../apps/core/tests/Haas.Hosty.Core.Tests/ShellPublicOriginResolverTests.cs),
  lines 12–19, expects null without Shell. This is inspected evidence, not a fresh test run.

## Verification performed and limits

- Read repository instructions and inspected `apps/core/src` using `rg` for exact
  first-party IDs, their constants and references, UI routes, provider roles,
  app-specific configuration and named application assumptions.
- Checked the `shared/*.cs` sources compiled into Core by
  [Haas.Hosty.Core.csproj](../../apps/core/src/Haas.Hosty.Core/Haas.Hosty.Core.csproj),
  line 19. The searched exact app IDs and private routes had no matches there.
- Read matching implementations and their callers, and inspected relevant existing
  tests and feature/plan ownership. Separated fixtures, comments, compatibility data,
  optional catalog entries and unused helpers from active runtime behavior.
- Did not execute Core tests, build Core, restart any process, alter installations or
  exercise an empty/third-party-only Core through a browser. Removable system apps
  D4 and the owning feature acceptance work retain those obligations.
- CLI, runtime app implementations and SDK internals are outside this Core source
  inventory. No claim is made that uninspected behavior is application-neutral.
- This report records the stated snapshot. Tracked work lives only in the linked
  plans; this review does not authorize their implementation.

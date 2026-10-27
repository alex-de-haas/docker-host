---
created: 2026-10-25
updated: 2026-10-26
summary: Starting an app starts its installed required dependencies, waits for readiness and resumes through durable, authorized startup intents.
components: [apps/core, apps/cli, apps/shell]
---

# Dependency-Ordered Startup

Core starts a consumer only when every required dependency is running, the services behind its
consumed endpoints are healthy, and every requested endpoint has a resolved URL. The same rule
applies to manual Start, the start half of Restart, install-and-start, distribution bootstrap, and
autostart. A held request returns `status: waiting` promptly and persists `runtimeState: waiting`;
it does not keep an HTTP or CLI request open until the provider becomes ready.

An accepted start admits the transitive graph of installed required providers. Stopped providers
start before their consumers; running providers remain up, and shared providers join one launch.
Optional dependencies neither start implicitly nor gate startup. Missing dependencies remain an
explicit blocker and are not installed automatically. Version ranges remain informational.
Autostart selects boot roots: a required provider can start for a consumer even with its own
autostart disabled, without changing that stored preference. Unrelated disabled apps stay stopped.
A running consumer stays up when a provider fails.
Endpoint readiness uses the provider's per-service health, so a failing probe on an unrelated
running sidecar does not block a healthy consumed service. The provider must still be running. See [Cross-App Dependencies](../cross-app-dependencies/feature.md).

## Scheduling And Recovery

Autostart retains capability-priority completion barriers and the shared four-slot start queue.
Within a tier, eligible system apps take priority over eligible ordinary apps, then ordinal app ID
breaks ties. A completed provider releases its own consumers immediately; independent slow starts
keep only their own slots. Results follow admission order, independent of completion order.

An unresolved consumer becomes waiting without holding its tier open. Later capability tiers can
therefore start its provider; earlier admitted consumers are reconsidered after each tier. Required
cycles are reported in `lastError` with their app-ID path while unrelated apps continue starting.
Missing, unhealthy and unresolved providers have no arbitrary waiting timeout. Waiting diagnostics
name the dependency chain and missing installation, failed launch, required configuration, stopped
provider or unavailable authority. CLI lifecycle output includes this diagnostic; Shell shows it in
the existing problem details.

After boot, `DependencyStartupService` coalesces registry changes through a bounded channel. The
existing supervisor supplies health changes; there is no additional polling loop. Subscription
startup includes a full waiting-state resync. A repaired dependency graph or a recovered provider
releases eligible consumers. Their app operation lock rechecks that the waiting intent still exists,
so concurrent resume requests cannot duplicate a launch and Stop cannot be undone by a stale scan.
Reviewed updates retain a pending start and recheck the updated graph, including cycle repairs.
Normal configuration, source authority and runtime preparation checks remain in force; an update
requiring new configuration remains stopped until configured and started.
Deferred development starts retain their operation through the app's development journal pointer.
Resume revalidates the installation/source binding, the original actor's current private-source grants,
and any workspace ownership/admission rules before launching. Revoked authority fails closed; ordinary
manual Start still requires the reviewed development controls for private source.

Waiting is durable across a Core crash and is excluded from stranded-operation recovery and crash
supervision. Normal boot autostart policy still applies to roots; disabled apps required by those roots remain
eligible, including running transitive providers adopted after a keep-apps restart. Shutdown
cancels the coordinator and drains admitted work before runtime shutdown.

## Deferred Authority And Attempts

The private app registry retains a start-intent identity, provider installation/Stop generations and
attempt outcomes. These records survive a Core restart, distinguish new requests from stale work,
and contain no bearer credentials. A successful start discards its completed intent so a later
update or runtime change captures its own authority. The coordinator uses one app operation lock at a time and a
four-slot queue, rechecking demand and readiness after lock acquisition. Shared attempts update all
current consumers, and failed attempts require a new Start instead of creating an event/retry loop.

Deferred work revalidates the originating administrator session or scoped MCP credential, app
identity or assistant MCP claims. An exact-target background grant cannot start a different app.
Normal source, configuration and development checks still apply; revoked authority is reported.
Workspace activation persists its explicit provider-selection boundary, so a later graph change
cannot expand the reviewed activation or select another workspace/runtime.

## Operator Controls

Waiting is neither `IsUp`, `IsBusy` nor `IsIdle`: no launch is in flight, but a pending start exists.
Stop cancels that intent, performs ordinary runtime cleanup and clears launch progress. A cancelled
root contributes no new provider demand, while another root can still use the same provider.
Already started providers remain up. A provider's explicit Stop generation prevents old waiting
requests from starting it again. New explicit Start/Restart creates a fresh attempt; registry events
do not continually retry a failed provider. A destructive
restore still requires an explicit Stop first. Start can recheck the dependencies manually.

Shell shows an amber hourglass with “Waiting for dependencies”, includes the app in Attention, and
offers “Cancel start” through the normal Stop action. Its existing dependency diagnostics explain
missing providers, health and unresolved endpoints; cycles use the ordinary error presentation.
Existing app-change events refresh the UI. CLI colours `waiting` yellow and returns the settled state.

## Testing Expectations

- Core lifecycle tests cover automatic transitive/shared provider starts, disabled-provider boot,
  bounded queue cancellation, explicit provider Stop, failure/retry, persisted attempt recovery,
  activation selection boundaries, and required/optional and absent providers, unhealthy and unresolved
  endpoints, reverse-alphabetical chains, later-tier providers, cycles and graph repair, immediate
  slot refill, concurrency bounds, system preference, bootstrap, manual Start/Restart, Stop/resume
  races, crash recovery, readiness notifications and deferred development authority/revocation.
- HTTP tests cover normal administrator, control-plane, app and scoped MCP startup plus deferred
  revocation, assistant tool restrictions and exact-target background-grant refusal. CLI tests preserve
  literal diagnostics.
- Existing configuration, source/runtime authority, local-process and Docker lifecycle coverage
  remains applicable. Dependency summaries and admission agree on readiness.
- Shell tests verify the waiting indicator, Attention classification, enabled cancellation and the
  absence of a busy spinner. CLI tests and builds cover the status vocabulary.
- `npm run test:integration -- dependencies` builds Core/CLI, creates a parent-managed source child
  Core with isolated password authentication, and uses Docker fixtures to check missing and delayed
  providers, automatic provider starts, shared-consumer cancellation, failed-provider retry, reachable
  injected URLs, dependency-ordered boot with disabled providers
  and preservation of waiting intent through a reviewed dependency repair.
  Owner-led Finish verifies removal of the child root and owned Docker resources.
- For browser acceptance, set `HOSTY_DEPENDENCY_SHELL_IMAGE` to a locally built Shell image and
  `HOSTY_DEPENDENCY_BROWSER_HOLD=1`. The fixture writes temporary test login details outside the
  repository, pauses for normal Core/Shell login, and continues cleanup when `browser-hold` is removed.

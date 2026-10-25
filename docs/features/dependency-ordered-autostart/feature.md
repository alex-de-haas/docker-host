---
created: 2026-10-25
updated: 2026-10-25
summary: Required dependencies gate manual and automatic startup with a durable waiting state and event-driven recovery.
components: [apps/core, apps/cli, apps/shell]
---

# Dependency-Ordered Startup

Core starts a consumer only when every required dependency is running, the services behind its
consumed endpoints are healthy, and every requested endpoint has a resolved URL. The same rule
applies to manual Start, the start half of Restart, install-and-start, distribution bootstrap, and
autostart. A held request returns `status: waiting` promptly and persists `runtimeState: waiting`;
it does not keep an HTTP or CLI request open until the provider becomes ready.

Optional dependencies never gate startup. Version ranges remain informational. Core does not
install or start a provider implicitly. A provider disabled for autostart stays disabled; the
consumer waits until the operator starts it. A running consumer stays up when a provider fails.
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
Missing, unhealthy and unresolved providers have no arbitrary waiting timeout.

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
supervision. Normal boot autostart policy still applies, including stopping disabled apps. Shutdown
cancels the coordinator and drains admitted work before runtime shutdown.

## Operator Controls

Waiting is neither `IsUp`, `IsBusy` nor `IsIdle`: no launch is in flight, but a pending start exists.
Stop cancels that intent, performs ordinary runtime cleanup and clears launch progress. A destructive
restore still requires an explicit Stop first. Start can recheck the dependencies manually.

Shell shows an amber hourglass with “Waiting for dependencies”, includes the app in Attention, and
offers “Cancel start” through the normal Stop action. Its existing dependency diagnostics explain
missing providers, health and unresolved endpoints; cycles use the ordinary error presentation.
Existing app-change events refresh the UI. CLI colours `waiting` yellow and returns the settled state.

## Testing Expectations

- Core lifecycle tests cover required/optional and absent providers, unhealthy and unresolved
  endpoints, reverse-alphabetical chains, later-tier providers, cycles and graph repair, immediate
  slot refill, concurrency bounds, system preference, bootstrap, manual Start/Restart, Stop/resume
  races, crash recovery, readiness notifications and deferred development authority/revocation.
- Existing configuration, source/runtime authority, local-process and Docker lifecycle coverage
  remains applicable. Dependency summaries and admission agree on readiness.
- Shell tests verify the waiting indicator, Attention classification, enabled cancellation and the
  absence of a busy spinner. CLI tests and builds cover the status vocabulary.
- `npm run test:integration -- dependencies` builds Core/CLI, creates a parent-managed source child
  Core with isolated password authentication, and uses Docker fixtures to check missing and delayed
  providers, Stop cancellation, automatic resume, reachable injected URLs, dependency-ordered boot
  and preservation of waiting intent through a reviewed dependency repair.
  Owner-led Finish verifies removal of the child root and owned Docker resources.
- For browser acceptance, set `HOSTY_DEPENDENCY_SHELL_IMAGE` to a locally built Shell image and
  `HOSTY_DEPENDENCY_BROWSER_HOLD=1`. The fixture writes temporary test login details outside the
  repository, pauses for normal Core/Shell login, and continues cleanup when `browser-hold` is removed.

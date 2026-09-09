import type { CoreApp, CoreAppServiceHealth, CoreAppSurface } from "../types";

// Deriving Shell's surface tabs from Core's app projection.
//
// Pure on purpose: this is the rule that decides whether an app appears in Shell's chrome at all,
// and it is the part worth testing directly. Shell's suite exercises logic rather than rendering,
// so a rule left inline in a component is a rule with no test.

/**
 * Whether the service behind a surface answers (docs/features/app-readiness/).
 *
 * - `ready` — the owning service is alive and its probe passes, or nothing probes it.
 * - `starting` — Core is still inside the start's readiness budget for it.
 * - `degraded` — alive, but the probe does not pass: the budget expired, or a check that used to
 *   pass no longer does. An expired budget proves nothing about the app, so this is offered, not
 *   refused: the operator may open anyway.
 *
 * No reading at all is `ready`: a Core that reports no readiness (an older one), or one that has not
 * observed this app yet, leaves the lifecycle state to decide — the rule Aspire applies to a resource
 * with no health check. Holding a launch on a missing reading was tried and blocked every row against
 * an older Core; only a reading Core actually made may hold anything.
 */
export type SurfaceReadiness = "ready" | "starting" | "degraded";

/** One placed surface, as Shell's chrome consumes it. */
export type AppSurfaceTab = {
  appId: string;
  /** Stable within its strip: an app may ship several panels, and each needs its own tab. */
  key: string;
  label: string;
  // Null while the surface cannot be reached at all — the app is stopped or mid-verb, the service
  // that serves it is dead, or Core resolved no URL. The tab still exists and says why: a surface
  // that vanished when its app stopped would read as uninstalled. Readiness is the separate,
  // softer question below.
  embeddedUrl: string | null;
  running: boolean;
  /**
   * A lifecycle verb is in flight on the server — true for every operator, in every tab.
   *
   * Distinct from `!running`, which an app mid-start also satisfies: it is not running, but it is on
   * its way, so telling its operator it "isn't running" and offering Start is both wrong and a click
   * that would race the start already under way. Mirrors `runtime-states.isAppBusy`, inlined rather
   * than imported to keep this module free of runtime imports — `node --test` resolves the test's
   * explicit `.ts` specifier but not an extensionless relative one, the same reason `app-problems.ts`
   * inlines its own predicate.
   */
  transitioning: boolean;
  /** Core's own word for the state, so a tab can name it rather than paraphrase it. */
  runtimeState: string;
  /** Whether the service behind this surface answers; decides whether the tab opens on its own. */
  readiness: SurfaceReadiness;
};

const isBusy = (state: string) => state === "starting" || state === "stopping";

/** The reading for the service that owns a surface, when Core named one and has observed it. */
export function findServiceHealth(app: CoreApp, service: string | null | undefined): CoreAppServiceHealth | null {
  if (!service) {
    return null;
  }

  return app.health?.services.find((candidate) => candidate.service === service) ?? null;
}

/**
 * Whether a page served by `service` can be opened at all — the lifecycle question.
 *
 * Decided per service, never from the app-level state: a partial outage turns the app `unknown`,
 * and had this read `runtimeState`, a dead sidecar would close a working endpoint. The app-level
 * state still matters in two ways — a verb in flight blocks every open, and an app Core has no
 * reading for falls back to "is the app running".
 */
export function isServiceUp(app: CoreApp, service: string | null | undefined): boolean {
  if (isBusy(app.runtimeState)) {
    return false;
  }

  const reading = findServiceHealth(app, service);
  return reading ? reading.status === "running" : app.runtimeState === "running";
}

/** Whether the service behind a surface answers — the readiness question. */
export function resolveReadiness(app: CoreApp, service: string | null | undefined): SurfaceReadiness {
  const reading = findServiceHealth(app, service);
  if (reading) {
    return readinessOfHealth(reading.health);
  }

  // No per-service reading: fall back to the fold, which for a single-service app is the same thing;
  // no reading at all leaves the lifecycle state to decide.
  if (!app.health) {
    return "ready";
  }

  return readinessOfHealth(app.health.status === "degraded" || app.health.status === "unhealthy" ? "unhealthy" : app.health.status);
}

function readinessOfHealth(health: string | null | undefined): SurfaceReadiness {
  switch (health) {
    case "starting":
      return "starting";
    case "unhealthy":
      return "degraded";
    default:
      // `healthy`, and null — a service nothing probes, ready the moment it is alive.
      return "ready";
  }
}

/**
 * The URL to embed, or null when there is nothing worth embedding.
 *
 * Core resolves a surface's URL from the app's endpoint, and an endpoint keeps its reserved port
 * while the app is down — so a stopped app still projects a perfectly well-formed URL that nothing
 * answers. Embedding it puts the browser's own connection-error page inside the tab, which is how a
 * stopped app came to look broken rather than stopped. Liveness is therefore part of the rule here,
 * once, instead of each consumer treating "has a URL" as "is up".
 */
function embeddableUrl(app: CoreApp, surface: CoreAppSurface): string | null {
  return isServiceUp(app, surface.service) ? surface.embeddedUrl ?? null : null;
}

function labelFor(app: CoreApp, surface: CoreAppSurface, fallbackIndex: number | null): string {
  const declared = surface.label?.trim();
  if (declared) {
    return declared;
  }

  const appName = app.displayName?.trim() || app.id;
  // A panel that declared no label falls back to the app's name, numbered only when the app ships
  // several — "Demo App" reads better than "Demo App 1" when there is nothing to tell it apart from.
  return fallbackIndex === null ? appName : `${appName} ${fallbackIndex + 1}`;
}

function tabFor(app: CoreApp, surface: CoreAppSurface, key: string, label: string): AppSurfaceTab {
  return {
    appId: app.id,
    key,
    label,
    embeddedUrl: embeddableUrl(app, surface),
    running: app.runtimeState === "running",
    transitioning: isBusy(app.runtimeState),
    runtimeState: app.runtimeState,
    readiness: resolveReadiness(app, surface.service),
  };
}

/**
 * The Settings page's per-app tabs: at most one per app, in installation order.
 *
 * Admin gating is not applied here and must not be: the Settings page itself is administrator-only,
 * so a second copy of that rule is the copy that goes stale.
 */
export function getAppSettingsTabs(apps: readonly CoreApp[]): AppSurfaceTab[] {
  return apps.flatMap((app) => {
    const surface = app.settingsSurface;
    return surface ? [tabFor(app, surface, app.id, labelFor(app, surface, null))] : [];
  });
}

/**
 * The right panel's tabs: any number per app, in declared order.
 *
 * Unlike settings, panels are **not** administrator-only — a panel is a tool an ordinary user may
 * hold, authorized by the app itself as its pages always have been.
 */
export function getAppPanelTabs(apps: readonly CoreApp[]): AppSurfaceTab[] {
  return apps.flatMap((app) => {
    const surfaces = app.panelSurfaces ?? [];
    return surfaces.map((surface, index) =>
      tabFor(app, surface, `${app.id}#${index}`, labelFor(app, surface, surfaces.length > 1 ? index : null)),
    );
  });
}

/**
 * Which tab should be active, given what the operator last chose.
 *
 * Keeps the choice when it still exists and falls back to the first tab, so an app being stopped,
 * updated, or uninstalled cannot leave the strip pointing at nothing — the blank-panel failure.
 */
export function resolveActiveSurfaceTab(tabs: readonly AppSurfaceTab[], preferredKey: string | null): AppSurfaceTab | null {
  if (tabs.length === 0) {
    return null;
  }

  return tabs.find((tab) => tab.key === preferredKey) ?? tabs[0] ?? null;
}

/**
 * Whether a launch (sidebar row, workspace) may proceed for a page served by `service`.
 *
 * The same rule a surface tab opens by, minus the tab: `starting` holds the launch (the page would
 * render a connection error), `degraded` lets it through — the operator clicking a row is the row's
 * "open anyway" — and anything not up is refused outright.
 */
export function resolveLaunchGate(app: CoreApp, service: string | null | undefined): { allowed: boolean; readiness: SurfaceReadiness; up: boolean } {
  const up = isServiceUp(app, service);
  const readiness = resolveReadiness(app, service);
  return { up, readiness, allowed: up && readiness !== "starting" };
}

import type { CoreApp, CoreAppSurface } from "../types";

// Deriving Shell's surface tabs from Core's app projection.
//
// Pure on purpose: this is the rule that decides whether an app appears in Shell's chrome at all,
// and it is the part worth testing directly. Shell's suite exercises logic rather than rendering,
// so a rule left inline in a component is a rule with no test.

/** One placed surface, as Shell's chrome consumes it. */
export type AppSurfaceTab = {
  appId: string;
  /** Stable within its strip: an app may ship several panels, and each needs its own tab. */
  key: string;
  label: string;
  // Null while the app is stopped or its endpoint has no resolved URL yet. The tab still exists and
  // says why — a surface that vanished when its app stopped would read as uninstalled.
  embeddedUrl: string | null;
  running: boolean;
};

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

/**
 * The Settings page's per-app tabs: at most one per app, in installation order.
 *
 * Admin gating is not applied here and must not be: the Settings page itself is administrator-only,
 * so a second copy of that rule is the copy that goes stale.
 */
export function getAppSettingsTabs(apps: readonly CoreApp[]): AppSurfaceTab[] {
  return apps.flatMap((app) => {
    const surface = app.settingsSurface;
    if (!surface) {
      return [];
    }

    return [
      {
        appId: app.id,
        key: app.id,
        label: labelFor(app, surface, null),
        embeddedUrl: surface.embeddedUrl ?? null,
        running: app.runtimeState === "running",
      },
    ];
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
    return surfaces.map((surface, index) => ({
      appId: app.id,
      key: `${app.id}#${index}`,
      label: labelFor(app, surface, surfaces.length > 1 ? index : null),
      embeddedUrl: surface.embeddedUrl ?? null,
      running: app.runtimeState === "running",
    }));
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

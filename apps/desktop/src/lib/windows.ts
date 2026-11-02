import { isSurfaceRoute, routeWithin, type UiFrameSurface } from "@hosty-sdk/app/ui";
import { appPages, focusWindow, initialBounds, pageUrl, windowAppId, type App, type DesktopWindow, type Viewport, type WindowDestination, type Workspace } from "./model";

export const MAX_WINDOWS = 30;
/** Restore only relative routes against the current Core-projected page and installation. */
export function destinationPage(app: App, target: WindowDestination, installationId?: string) {
  if (installationId !== app.installationId || !isSurfaceRoute(target.route)) return null;
  const candidates = appPages(app).map((page, index) => ({ page, index }))
    .filter(({ page }) => (page.endpoint || app.entryEndpoint) === target.endpoint && routeWithin(target.route, page.path))
    .sort((a, b) => b.page.path.length - a.page.path.length);
  const match = candidates[0];
  if (!match) return null;
  const base = pageUrl(app, match.page);
  if (!base) return null;
  return { ...match, url: new URL(target.route, new URL(base).origin).href };
}
export function resolvedDestination(apps: App[], surface: UiFrameSurface) {
  const app = apps.find(item => item.id === surface.appId && item.installationId === surface.installationId);
  if (!app) return null;
  const destination = { endpoint: surface.endpoint, route: surface.route };
  const page = destinationPage(app, destination, surface.installationId);
  return page && new URL(page.url).origin === surface.origin ? { app, destination, page: page.index } : null;
}
export function pageDestination(app: App, index: number): WindowDestination | undefined {
  const page = appPages(app)[index], href = page && pageUrl(app, page);
  if (!href || !app.installationId) return;
  const url = new URL(href);
  return { endpoint: page.endpoint || app.entryEndpoint || "web", route: url.pathname + url.search + url.hash };
}
export function openAppWindow(workspace: Workspace, app: App, viewport: Viewport,
  options: { id: string; fresh?: boolean; destination?: WindowDestination; page?: number }) {
  const existing = !options.fresh && workspace.windows.findLast(win => windowAppId(win) === app.id &&
    (!options.destination || win.installationId === app.installationId && win.destination?.endpoint === options.destination.endpoint
      && (win.currentRoute ?? win.destination.route) === options.destination.route));
  if (existing) return { ...workspace, windows: focusWindow(workspace.windows, existing.id) };
  if (workspace.windows.length >= MAX_WINDOWS) return workspace;
  const window: DesktopWindow = { id: options.id, appId: app.id, installationId: app.installationId || undefined,
    bounds: initialBounds(viewport, workspace.windows.length), mode: "normal", minimized: false, page: options.page ?? 0,
    destination: options.destination ?? pageDestination(app, options.page ?? 0) };
  return { ...workspace, windows: [...workspace.windows, window] };
}
export function windowTitle(window: DesktopWindow, app?: App) {
  if (!app) return "Application";
  const detail = window.title;
  return detail && detail !== app.displayName ? `${app.displayName} — ${detail}` : app.displayName;
}

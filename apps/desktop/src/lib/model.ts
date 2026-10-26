export type Theme = "light" | "dark" | "system";
export type User = { id: string; displayName: string; email?: string; role: string };
export type AppPage = { label: string; path: string; endpoint?: string | null; service?: string | null; embeddedUrl?: string | null };
export type App = {
  id: string; installationId?: string | null; displayName: string; description?: string | null;
  runtimeState: string; lastError?: string | null; iconUrl?: string | null; icon?: string | null;
  entryEndpoint?: string | null; entryPath?: string | null; embeddedUrl?: string | null;
  navigation?: AppPage[]; endpoints?: { key: string; service?: string | null; url?: string | null; browserOrigin?: string | null }[];
  health?: { status?: string; services: { service: string; status: string; health?: string | null }[] } | null;
  framePolicy?: { microphone: boolean; popupEscape: boolean } | null;
  confirmedRoles?: string[];
  interfaces?: Record<string, { key: string; url?: string | null; version?: number | null; capabilities?: string[] | null }[]>;
  grantedCorePermissions?: string[] | null;
};
export type Bounds = { x: number; y: number; width: number; height: number };
export type Viewport = { width: number; height: number };
export type WindowMode = "normal" | "maximized" | "left" | "right";
export type DesktopWindow = { id: string; bounds: Bounds; mode: WindowMode; minimized: boolean; page: number };
export type Workspace = { windows: DesktopWindow[]; pins: string[]; order: string[]; theme: Theme; wallpaper: "coast" | "night" | "custom" };
export const APPLICATIONS = "desktop:applications", APPEARANCE = "desktop:appearance";
export const defaultWorkspace: Workspace = { windows: [], pins: [], order: [], theme: "system", wallpaper: "coast" };
const builtin = (id: string) => id === APPLICATIONS || id === APPEARANCE;
export const isBusy = (app: App) => ["starting", "stopping"].includes(app.runtimeState);
export const isAdministrator = (user: User) => user.role === "host.admin";
export const hasUi = (app: App) => Boolean(app.entryEndpoint || app.embeddedUrl || app.navigation?.length);
export function visibleApps(apps: App[], user: User, ownId: string): App[] {
  return apps.filter(app => app.id !== ownId && hasUi(app) && (isAdministrator(user) || app.runtimeState === "running"));
}
export function appPages(app: App): AppPage[] {
  if (app.navigation?.length) return app.navigation;
  return [{ label: app.displayName, path: app.entryPath || "/", endpoint: app.entryEndpoint, embeddedUrl: app.embeddedUrl,
    service: app.endpoints?.find(endpoint => endpoint.key === app.entryEndpoint)?.service }];
}
export function pageUrl(app: App, page: AppPage): string | null {
  const candidate = page.embeddedUrl || (page.endpoint === app.entryEndpoint ? app.embeddedUrl : null);
  if (!candidate) return null;
  try {
    const url = new URL(candidate);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
    for (const key of ["hosty_launch", "hosty_theme", "hosty_theme_preference", "hosty_navigation", "hosty_tools", "hosty_tool_launcher"]) url.searchParams.delete(key);
    return url.href;
  } catch { return null; }
}
export function pageReady(app: App, page: AppPage): boolean {
  if (isBusy(app)) return false;
  const service = page.service || app.endpoints?.find(endpoint => endpoint.key === page.endpoint)?.service;
  const reading = app.health?.services?.find(item => item.service === service);
  return (reading ? reading.status === "running" : app.runtimeState === "running")
    && (reading ? reading.health : app.health?.status) !== "starting";
}
export function clampBounds(bounds: Bounds, viewport: Viewport): Bounds {
  const maxWidth = Math.max(280, viewport.width - 24), maxHeight = Math.max(220, viewport.height - 132);
  const width = Math.min(maxWidth, Math.max(360, bounds.width));
  const height = Math.min(maxHeight, Math.max(260, bounds.height));
  return { width, height, x: Math.max(12, Math.min(bounds.x, viewport.width - width - 12)),
    y: Math.max(48, Math.min(bounds.y, viewport.height - height - 92)) };
}
export function initialBounds(viewport: Viewport, index = 0): Bounds {
  return clampBounds({ x: 88 + index % 5 * 34, y: 86 + index % 5 * 30,
    width: Math.min(980, viewport.width * .72), height: Math.min(640, viewport.height * .7) }, viewport);
}
export function displayedBounds(window: DesktopWindow, viewport: Viewport): Bounds {
  if (window.mode === "normal") return clampBounds(window.bounds, viewport);
  const width = window.mode === "maximized" ? viewport.width - 24 : (viewport.width - 36) / 2;
  return { x: window.mode === "right" ? viewport.width / 2 + 6 : 12, y: 48, width, height: viewport.height - 140 };
}
export function focusWindow(windows: DesktopWindow[], id: string): DesktopWindow[] {
  const target = windows.find(window => window.id === id);
  return target ? [...windows.filter(window => window.id !== id), { ...target, minimized: false }] : windows;
}
export function restoreWorkspace(raw: string | null, allowedIds: string[], viewport: Viewport): Workspace {
  try {
    const parsed = JSON.parse(raw || "null");
    if (!parsed || typeof parsed !== "object") return { ...defaultWorkspace };
    const allowed = (id: unknown): id is string => typeof id === "string" && (builtin(id) || allowedIds.includes(id));
    const ids = (value: unknown) => Array.isArray(value) ? [...new Set(value.filter(allowed))].slice(0, 100) : [];
    const seen = new Set<string>();
    const windows: DesktopWindow[] = Array.isArray(parsed.windows) ? parsed.windows.slice(0, 30).flatMap((window: DesktopWindow) => {
      if (!window || !allowed(window.id) || seen.has(window.id) || !window.bounds
        || ![window.bounds.x, window.bounds.y, window.bounds.width, window.bounds.height].every(Number.isFinite)) return [];
      seen.add(window.id);
      return [{ id: window.id, bounds: clampBounds(window.bounds, viewport), minimized: window.minimized === true,
        mode: ["normal", "maximized", "left", "right"].includes(window.mode) ? window.mode : "normal" as WindowMode,
        page: Number.isInteger(window.page) && window.page >= 0 ? window.page : 0 }];
    }) : [];
    return { windows, pins: ids(parsed.pins), order: ids(parsed.order),
      theme: ["light", "dark", "system"].includes(parsed.theme) ? parsed.theme : "system",
      wallpaper: ["coast", "night", "custom"].includes(parsed.wallpaper) ? parsed.wallpaper : "coast" };
  } catch { return { ...defaultWorkspace }; }
}
export function dockApps(apps: App[], workspace: Workspace): App[] {
  const order = [...workspace.pins, ...workspace.order];
  return [...apps].sort((a, b) => {
    const ai = order.indexOf(a.id), bi = order.indexOf(b.id);
    return (ai < 0 ? 10000 : ai) - (bi < 0 ? 10000 : bi) || a.displayName.localeCompare(b.displayName);
  });
}
export function storageKey(userId: string) { return `hosty.desktop.workspace.v1:${userId}`; }

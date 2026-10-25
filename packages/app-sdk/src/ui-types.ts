/** A tool within one Core installation; no user credential or conversation identity. */
export type PanelRef = { appId: string; installationId: string; panelId: string };
export type PanelTarget = { panel: PanelRef; route?: string };
export type AppSurfaceRef = { appId: string; installationId: string; endpoint: string; route: string };
export type UiFramePolicy = { microphone: boolean; popupEscape: boolean };
export type UiPeer = { appId: string; installationId: string; origins: string[] };
export type UiBootstrap = {
  version: 1; coreOrigin: string; userId: string; app: UiPeer; canHost: boolean;
  pinnedOpen: boolean; peer?: UiPeer | null;
};
export type UiPanel = {
  panel: PanelRef; label: string; appName: string; icon: string | null;
  endpoint: string; route: string; origin: string | null;
  available: boolean; state: string; canStart: boolean; framePolicy: UiFramePolicy;
};
export type UiFrameSurface = AppSurfaceRef & { origin: string; framePolicy: UiFramePolicy; panelId?: string };
export type UiResolvedPanel = {
  target: PanelTarget; surface: UiFrameSurface | null;
  available: boolean; state: string; standaloneHref: string | null;
};
export type UiEnvironment = {
  mode: "standalone" | "embedded";
  connection: "connecting" | "connected" | "unsupported" | "blocked";
  code?: string;
};
export type SurfaceReadiness = "loading" | "auth-required" | "ready" | "unreported";
export type PresentationResult =
  | { status: "opened"; requestId: string; target: PanelTarget; readiness: SurfaceReadiness; presentationId?: string }
  | { status: "blocked" | "unsupported" | "rejected" | "uncertain" | "unknown"; requestId: string; code: string };
export type PresentationOptions = { placement: "side"; requestId: string; signal?: AbortSignal; reuse?: "exact" | "new" };
export type UiEvent = { type: "environment"; value: UiEnvironment } | { type: "presentation"; value: PresentationResult };

/** UI endpoints preserve typed operational failures without hiding identity refusals. */
export class UiError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status = 409) { super(message); this.code = code; this.status = status; }
}

export function panelKey(panel: PanelRef): string {
  return JSON.stringify([panel.appId, panel.installationId, panel.panelId]);
}

/** Reject traversal before URL normalization can erase it. Query/fragment are opaque navigation. */
export function isSurfaceRoute(route: unknown): route is string {
  if (typeof route !== "string" || route.length > 8192 || !route.startsWith("/") || route.startsWith("//") || /[\\\u0000-\u001f\u007f]/.test(route)) return false;
  const path = route.split(/[?#]/, 1)[0]!;
  if (/%(?:2f|5c|25)/i.test(path) || /%(?![\da-f]{2})/i.test(path)) return false;
  try { return !decodeURIComponent(path).split("/").some(part => part === "." || part === ".."); }
  catch { return false; }
}

export function routeWithin(route: string, declared: string): boolean {
  if (!isSurfaceRoute(route) || !isSurfaceRoute(declared)) return false;
  const path = new URL(route, "https://surface.invalid").pathname;
  const root = new URL(declared, "https://surface.invalid").pathname.replace(/\/$/, "") || "/";
  return root === "/" || path === root || path.startsWith(root + "/");
}

/** Constructs navigation only. Core must advertise pinnedOpen and revalidate at redemption. */
export function buildSurfaceOpenUrl(coreOrigin: string, destination: AppSurfaceRef): string {
  if (!isSurfaceRoute(destination.route) || !destination.installationId || !destination.endpoint || !destination.appId)
    throw new UiError("destination_invalid", "Invalid app surface destination.");
  const core = new URL(coreOrigin);
  if (!["http:", "https:"].includes(core.protocol) || core.username || core.password)
    throw new UiError("core_origin_invalid", "Invalid Core browser origin.");
  const url = new URL(`/api/apps/${encodeURIComponent(destination.appId)}/open`, core.origin);
  url.searchParams.set("installationId", destination.installationId);
  url.searchParams.set("endpoint", destination.endpoint);
  url.searchParams.set("route", destination.route);
  return url.href;
}

export const UI_COMPOSITION_CAPABILITY = "ui.composition.v1";
export type UiChromeOverrides = { navigation?: "show" | "hide"; tools?: { enabled?: boolean; launcher?: "show" | "hide" } };
export type UiChromePolicy = Readonly<{ navigation: "show" | "hide"; tools: Readonly<{ enabled: boolean; launcher: "show" | "hide"; owner: "local" | "host" | "unavailable" }> }>;
export type UiChromeSource = "host" | "url" | "app" | "legacy" | "default";
export type UiChromeSnapshot = UiChromePolicy & Readonly<{
  revision: number; hostRevision: number; rootDisabled: boolean; stale: boolean;
  connection: UiEnvironment["connection"]; capabilities: readonly string[];
  sources: Readonly<{ navigation: UiChromeSource; enabled: UiChromeSource; launcher: UiChromeSource }>;
}>;
export type UiNavigationTarget = { appId: string; installationId: string; entryKey: string };
export type UiNavigationEntry = Readonly<{ key: string; label: string; icon: string | null; endpoint: string | null;
  origin: string | null; route: string | null; available: boolean; state: string; standaloneHref: string | null }>;
export type UiNavigationCatalog = Readonly<{ appId: string; installationId: string; revision: string; entries: readonly UiNavigationEntry[] }>;
export type UiNavigationSnapshot = Readonly<{ status: "loading" | "ready" | "unavailable"; catalog: UiNavigationCatalog | null;
  entries: readonly UiNavigationEntry[]; activeKey: string | null; code?: string }>;
export type UiResolvedNavigation = { target: UiNavigationTarget; surface: UiFrameSurface | null;
  available: boolean; state: string; standaloneHref: string | null };
export const UI_MAIN_NAVIGATION_CAPABILITY = "ui.main-navigation.v1";
export type UiActionOptions = { requestId: string; signal?: AbortSignal };
/** Main placement is explicit; only the resolved navigation entry's query can be overridden. */
export type UiNavigationOptions = UiActionOptions & { placement?: "main"; search?: string };
export function navigationSearch(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string" && value.length <= 4096
    && (value === "" || value.startsWith("?")) && !/[#\u0000-\u001f\u007f]/.test(value);
}
export type UiActionResult = { status: "accepted"; requestId: string }
  | { status: "blocked" | "unsupported" | "rejected" | "uncertain" | "unknown"; requestId: string; code: string };
export type UiNavigationResult = UiActionResult;
export type UiToolPickerResult = UiActionResult;
export type UiRouterAdapter = { endpoint?: string; getRoute(): string; subscribe(listener: () => void): () => void;
  navigate(route: string): void | Promise<void> };

/** Activity is owned by Core, independently of mounted tool frames. */
export type ToolActivityState = "idle" | "working" | "needs-you" | "failed";
export type ToolActivity = { panel: PanelRef; state: ToolActivityState | "no-connection"; count: number | null; label: string | null; reportedAt: string | null; expiresAt: string | null };

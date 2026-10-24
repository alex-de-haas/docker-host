import type {
  HostSettingsTab,
  ShellRouteState,
  ShellSearchParams,
  ShellView,
  SettingsTab,
  WorkspaceRoute,
} from "./types";

// UI chrome preferences, persisted as cookies rather than localStorage so the server can render
// the first paint already in the stored state — a mount-time client read repainted the default
// chrome and animated the correction (the left rail collapsing by itself on every reload). The
// same names were localStorage keys before; the client still reads those once as a migration
// source when the cookie is absent.
export const SIDEBAR_COMPACT_PREF_KEY = "hosty.shell.sidebar.compact";
// The right rail's docked state, remembered like the left rail's: an operator who docked a tool
// beside their work expects it still docked after a reload.
export const RIGHT_PANEL_OPEN_PREF_KEY = "hosty.shell.panel.open";

const SHELL_VIEW_HREFS: Record<ShellView, string> = {
  dashboard: "/dashboard",
  home: "/",
  settings: "/settings",
};

/**
 * A session an arriving link asks the assistant panel to open.
 *
 * A query parameter rather than a path: the panel is chrome present on every page, so "open this
 * session" is a request about the rail rather than a place to navigate to — and a path would have to
 * pick a page to sit under, which is a choice with no right answer.
 */
export function readAssistantSessionParam(value: string | null): string | null {
  const trimmed = value?.trim() ?? "";
  // Session ids are opaque to Shell; only their shape is checked, so a crafted link cannot smuggle
  // anything into the message posted to the panel.
  return /^[a-zA-Z0-9_-]{1,64}$/.test(trimmed) ? trimmed : null;
}

/** What the top strip calls each Shell page, when no app's page fills the content area. */
export const SHELL_VIEW_LABELS: Record<ShellView, string> = {
  dashboard: "Dashboard",
  home: "Hosty",
  settings: "Settings",
};

const ADMIN_SHELL_VIEWS = new Set<ShellView>(["dashboard", "settings"]);

export const HOST_SETTINGS_SECTIONS: {
  id: string;
  label: string;
  tabs: { id: HostSettingsTab; label: string }[];
}[] = [
  { id: "profile", label: "My profile", tabs: [{ id: "profile", label: "Profile" }, { id: "connections", label: "Connections" }, { id: "tokens", label: "Tokens & devices" }] },
  { id: "host", label: "Host", tabs: [{ id: "general", label: "Updates" }, { id: "ingress", label: "Network" }, { id: "mounts", label: "Shared folders" }, { id: "source", label: "Core source" }] },
  { id: "security", label: "Users & security", tabs: [{ id: "users", label: "Users" }, { id: "permissions", label: "App permissions" }, { id: "policies", label: "Policies" }] },
  { id: "shell", label: "Shell", tabs: [{ id: "shell", label: "Shell" }] },
];
const HOST_SETTINGS_TABS = new Set<string>(["core", ...HOST_SETTINGS_SECTIONS.flatMap(section => section.tabs.map(tab => tab.id))]);

export function getHostSettingsSection(tab: string) {
  const resolved = readSettingsTabParam(tab);
  return HOST_SETTINGS_SECTIONS.find(section => section.tabs.some(item => item.id === resolved));
}

// A settings surface the URL does not name resolves to My profile rather than erroring — the same
// principle that makes an unrecognized route fall through instead of blanking the screen. Every
// link Shell builds names its tab explicitly, so nothing depends on which one this is.
export const DEFAULT_HOST_SETTINGS_TAB: HostSettingsTab = "profile";

// Paths that were their own view before Dashboard absorbed Installed Apps and Settings absorbed
// User Management. They still parse, so a bookmark or a documented link keeps working; the client
// then replaces the URL with the canonical one.
const LEGACY_VIEW_PATHS: Record<string, ShellView> = {
  "/installed-apps": "dashboard",
  "/users": "settings",
};

// Personal profile and access tokens belong to every user. The other settings tabs administer the
// host or installed apps, so ordinary users cannot reach them.
const NON_ADMIN_HOST_SETTINGS_TABS = new Set<HostSettingsTab>(["profile", "tokens"]);

export function isNonAdminHostSettingsTab(tab: HostSettingsTab) {
  return NON_ADMIN_HOST_SETTINGS_TABS.has(tab);
}

export function shellViewRequiresAdmin(view: ShellView) {
  return ADMIN_SHELL_VIEWS.has(view);
}

export function getAuthorizedShellView(
  view: ShellView,
  canManageApps: boolean,
  // Raw, because the value may be an app id. An app-settings tab is administrator-only like the
  // rest of the page, so only the known non-admin host tabs pass the check below.
  settingsTab?: string,
): ShellView {
  if (view === "home") return canManageApps ? "dashboard" : "home";
  if (canManageApps || !shellViewRequiresAdmin(view)) {
    return view;
  }

  // Settings is admin-only as a page, not as a whole: personal profile and tokens belong to every user.
  return view === "settings" && settingsTab && isHostSettingsTab(settingsTab) && isNonAdminHostSettingsTab(settingsTab)
    ? view
    : "home";
}

/** Keep the URL aligned with the same tab-aware authorization used for rendering. */
export function getShellAuthorizationRedirect(
  route: ShellRouteState,
  authenticated: boolean,
  canManageApps: boolean,
  searchParams?: ShellSearchParams,
): string | null {
  if (!authenticated || route.workspace) return null;
  const view = getAuthorizedShellView(route.view, canManageApps, route.settingsTab);
  return view === route.view ? null : withAssistantContinuation(getShellViewHref(view), searchParams);
}

// The assistant rail can be requested from any Shell page. Moving to an authorized page must not
// discard that request before the persistent layout has completed the handoff.
function withAssistantContinuation(href: string, searchParams?: ShellSearchParams) {
  const query = new URLSearchParams();
  for (const key of ["assistantSession", "assistantApp", "assistantPanel"]) {
    const value = searchParams?.get(key);
    if (value !== undefined && value !== null) query.set(key, value);
  }
  const search = query.toString();
  return search ? `${href}?${search}` : href;
}

export function readHostSettingsTab(value: string | null | undefined): HostSettingsTab {
  const tab = readSettingsTabParam(value);
  return tab && HOST_SETTINGS_TABS.has(tab) ? (tab as HostSettingsTab) : DEFAULT_HOST_SETTINGS_TAB;
}

export function normalizeShellPath(pathname: string) {
  if (!pathname || pathname === "/") {
    return "/";
  }

  return pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
}

export function normalizeAppPath(path: string | null | undefined) {
  const value = (path || "/").trim();
  if (!value || value === ".") {
    return "/";
  }

  return value.startsWith("/") ? value : `/${value}`;
}

// The app id behind a legacy `/system-apps/<id>` link, or null when this is not one. Returned
// rather than inlined because both the parser and the canonical-redirect builder need it.
export function readLegacySystemAppId(pathname: string): string | null {
  const match = /^\/system-apps\/([^/]+)$/.exec(normalizeShellPath(pathname));
  if (!match) {
    return null;
  }

  try {
    return decodeURIComponent(match[1]);
  } catch {
    // Malformed percent-encoding in a hand-typed link must not crash route parsing during render;
    // the raw segment falls through to the launch flow's ordinary not-installed error.
    return match[1];
  }
}

const APP_DETAILS_SECTIONS = new Set<SettingsTab>([
  "app", "parameters", "permissions", "publicOrigins", "mounts", "source", "backups", "logs",
]);

function readAppDetailsSection(value: string | null | undefined): SettingsTab {
  return value && APP_DETAILS_SECTIONS.has(value as SettingsTab) ? value as SettingsTab : "app";
}

function readAppDetailsRoute(path: string, searchParams: ShellSearchParams): ShellRouteState["appDetails"] {
  const match = /^\/apps\/([^/]+)$/.exec(path);
  let appId: string | null = null;
  if (match) {
    try {
      appId = decodeURIComponent(match[1]);
    } catch {
      // Keep a malformed segment addressable so the ordinary unavailable-app view handles it.
      appId = match[1];
    }
  } else if (path === "/settings") {
    const tab = searchParams.get("tab")?.trim();
    if (tab?.startsWith("manage:")) appId = tab.slice(7).trim();
  }
  return appId ? { appId, section: readAppDetailsSection(searchParams.get("section")) } : undefined;
}

export function readShellRoute(pathname: string, searchParams: ShellSearchParams): ShellRouteState {
  const path = normalizeShellPath(pathname);
  // The raw value, not readHostSettingsTab: an app-settings tab carries the app id here, and
  // collapsing anything unknown to the default made every app tab land on Users — the surface was
  // rendered and unreachable.
  const settingsTab = readSettingsTabParam(searchParams.get("tab"), searchParams.get("section"));
  const appPath = normalizeAppPath(searchParams.get("path"));
  const appDetails = readAppDetailsRoute(path, searchParams);
  if (appDetails) return { view: "dashboard", workspace: null, settingsTab, appDetails };
  if (path === "/settings" && settingsTab === "apps") {
    return { view: "dashboard", workspace: null, settingsTab };
  }

  if (path === "/workspace") {
    const appId = searchParams.get("app")?.trim();
    return {
      view: "home",
      workspace: appId ? { appId, path: appPath } : null,
      settingsTab,
    };
  }

  // `/system-apps/<id>` existed to gate a system app's pages behind an explicit admin route. Core
  // enforces that gate itself — a launch code for a system app requires host.admin — so the client
  // route was a second copy of an authorization decision, and the two collapse into one workspace.
  const legacySystemAppId = readLegacySystemAppId(path);
  if (legacySystemAppId) {
    return {
      view: "home",
      workspace: { appId: legacySystemAppId, path: appPath },
      settingsTab,
    };
  }

  if (path === "/" || path === "/apps") {
    return { view: "home", workspace: null, settingsTab };
  }

  if (path === "/settings") {
    return { view: "settings", workspace: null, settingsTab };
  }

  const legacyView = LEGACY_VIEW_PATHS[path];
  if (legacyView) {
    return { view: legacyView, workspace: null, settingsTab };
  }

  return { view: "dashboard", workspace: null, settingsTab };
}

// The canonical URL for a path that still resolves but is no longer where its surface lives; null
// when the path is already canonical. `/system-apps/<id>?path=/x` keeps `/x` — dropping it would
// silently send a deep link to the app's entry page instead of the page it named.
export function readCanonicalRedirect(
  pathname: string,
  searchParams: ShellSearchParams,
): string | null {
  const path = normalizeShellPath(pathname);

  if (path === "/apps") return withAssistantContinuation(getShellViewHref("home"), searchParams);

  if (path === "/settings") {
    const appDetails = readAppDetailsRoute(path, searchParams);
    if (appDetails) return getManageAppHref(appDetails.appId, appDetails.section);
    if (searchParams.get("tab")?.trim() === "apps") return getShellViewHref("dashboard");
  }

  const legacySystemAppId = readLegacySystemAppId(path);
  if (legacySystemAppId) {
    return getWorkspaceHref(legacySystemAppId, normalizeAppPath(searchParams.get("path")));
  }

  if (path === "/installed-apps") {
    return getShellViewHref("dashboard");
  }

  if (path === "/users") {
    return getSettingsHref("users");
  }

  return null;
}

export function getShellViewHref(view: ShellView) {
  return SHELL_VIEW_HREFS[view];
}

// Where the browser was heading, handed to Core's `/login` so the sign-in returns there instead of to
// Shell's bare origin. Without it a link into a particular page — the device authorization approval
// screen, say, where someone is waiting to approve a pending code — is lost by the very redirect that
// asks them to sign in, and the page they came for has to be found by hand.
//
// Offered only as a relative path, and never one that could be read as an origin of its own. Core
// re-checks the shape before acting on it (`AuthEndpoints.IsAllowedShellReturnTo`) and falls back to the
// bare origin for anything it rejects, so this is a request, not a promise.
export function loginContinuation(pathname: string, search: string) {
  if (!pathname.startsWith("/") || pathname.startsWith("//") ||
    (pathname === "/" && (!search.startsWith("?") || search.length < 2))) {
    return "";
  }

  return `?returnTo=${encodeURIComponent(`${pathname}${search}`)}`;
}

export function getSettingsHref(tab: string) {
  const resolved = readSettingsTabParam(tab);
  const section = getHostSettingsSection(resolved);
  const params = new URLSearchParams();
  params.set("tab", section?.id ?? resolved);
  if (section && section.tabs.length > 1) params.set("section", resolved);
  return `/settings?${params.toString()}`;
}

/**
 * The Settings tab that hosts one app's own configuration page.
 *
 * An app id is carried in the same `tab` parameter as the host tabs rather than a parameter of its
 * own: an app id can never collide with a host tab name (ids are reverse-DNS and contain dots), and
 * one parameter keeps "which tab is open" a single question with a single answer in the URL.
 */
export function getAppSettingsHref(appId: string) {
  const params = new URLSearchParams();
  params.set("tab", appId);
  return `/settings?${params.toString()}`;
}

/** The raw tab value, before it is resolved against host tabs or the installed apps. */
export function readSettingsTabParam(value: string | null | undefined, child?: string | null): string {
  const tab = value?.trim() || DEFAULT_HOST_SETTINGS_TAB;
  if (tab === "core") return "general";
  if (tab === "security" && (child === "tokens" || child === "connections")) return child;
  if (tab === "harness" && child === "shell") return "shell";
  if (tab === "agents" || tab === "harness") return "hosty.harness";
  const section = HOST_SETTINGS_SECTIONS.find(section => section.id === tab);
  return section ? section.tabs.find(item => item.id === child)?.id ?? section.tabs[0].id : tab;
}

export function isHostSettingsTab(value: string): value is HostSettingsTab {
  return HOST_SETTINGS_TABS.has(value);
}

export function getWorkspaceHref(appId: string, appPath: string) {
  const params = new URLSearchParams();
  params.set("app", appId);
  params.set("path", normalizeAppPath(appPath));
  return `/workspace?${params.toString()}`;
}

export function getWorkspaceRouteKey(route: WorkspaceRoute | null) {
  return route ? `${route.appId}:${route.path}` : "none";
}

export function getManageAppHref(appId: string, section = "app") {
  return `/apps/${encodeURIComponent(appId)}?section=${encodeURIComponent(readAppDetailsSection(section))}`;
}

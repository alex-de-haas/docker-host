import type {
  HostSettingsTab,
  ShellRouteState,
  ShellSearchParams,
  ShellView,
  WorkspaceRoute,
} from "./types";

export const SIDEBAR_COMPACT_STORAGE_KEY = "hosty.shell.sidebar.compact";

const SHELL_VIEW_HREFS: Record<ShellView, string> = {
  dashboard: "/dashboard",
  "available-apps": "/apps",
  settings: "/settings",
};

const ADMIN_SHELL_VIEWS = new Set<ShellView>(["dashboard", "settings"]);

const HOST_SETTINGS_TABS = new Set<string>(["users", "tokens", "core", "ingress", "mounts"]);

// A settings surface the URL does not name resolves to Users rather than erroring — the same
// principle that makes an unrecognized route fall through instead of blanking the screen. Every
// link Shell builds names its tab explicitly, so nothing depends on which one this is.
export const DEFAULT_HOST_SETTINGS_TAB: HostSettingsTab = "users";

// Paths that were their own view before Dashboard absorbed Installed Apps and Settings absorbed
// User Management. They still parse, so a bookmark or a documented link keeps working; the client
// then replaces the URL with the canonical one.
const LEGACY_VIEW_PATHS: Record<string, ShellView> = {
  "/installed-apps": "dashboard",
  "/users": "settings",
};

// Settings tabs an ordinary user may reach. Everything else on that page administers the host, but
// access tokens are per-user by construction — Core lets a host.user create, list and revoke their own
// — so sending them to Available Apps would leave a supported role with no way to manage its own
// credentials.
const NON_ADMIN_HOST_SETTINGS_TABS = new Set<HostSettingsTab>(["tokens"]);

export function isNonAdminHostSettingsTab(tab: HostSettingsTab) {
  return NON_ADMIN_HOST_SETTINGS_TABS.has(tab);
}

export function shellViewRequiresAdmin(view: ShellView) {
  return ADMIN_SHELL_VIEWS.has(view);
}

export function getAuthorizedShellView(
  view: ShellView,
  canManageApps: boolean,
  settingsTab?: HostSettingsTab,
): ShellView {
  if (canManageApps || !shellViewRequiresAdmin(view)) {
    return view;
  }

  // Settings is admin-only as a page, not as a whole: one tab on it belongs to every user.
  return view === "settings" && settingsTab && isNonAdminHostSettingsTab(settingsTab)
    ? view
    : "available-apps";
}

export function readHostSettingsTab(value: string | null | undefined): HostSettingsTab {
  const tab = value?.trim();
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

export function readShellRoute(pathname: string, searchParams: ShellSearchParams): ShellRouteState {
  const path = normalizeShellPath(pathname);
  const settingsTab = readHostSettingsTab(searchParams.get("tab"));
  const appPath = normalizeAppPath(searchParams.get("path"));

  if (path === "/workspace") {
    const appId = searchParams.get("app")?.trim();
    return {
      view: "available-apps",
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
      view: "available-apps",
      workspace: { appId: legacySystemAppId, path: appPath },
      settingsTab,
    };
  }

  if (path === "/apps") {
    return { view: "available-apps", workspace: null, settingsTab };
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
  if (!pathname.startsWith("/") || pathname.startsWith("//") || pathname === "/") {
    return "";
  }

  return `?returnTo=${encodeURIComponent(`${pathname}${search}`)}`;
}

export function getSettingsHref(tab: HostSettingsTab) {
  const params = new URLSearchParams();
  params.set("tab", tab);
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
export function readSettingsTabParam(value: string | null | undefined): string {
  return value?.trim() || DEFAULT_HOST_SETTINGS_TAB;
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

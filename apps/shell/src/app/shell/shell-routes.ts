import type { ShellRouteState, ShellSearchParams, ShellView, WorkspaceRoute } from "./types";

export const SIDEBAR_COMPACT_STORAGE_KEY = "hosty.shell.sidebar.compact";

const SHELL_VIEW_HREFS: Record<ShellView, string> = {
  dashboard: "/dashboard",
  "available-apps": "/apps",
  "installed-apps": "/installed-apps",
  users: "/users",
};

const ADMIN_SHELL_VIEWS = new Set<ShellView>([
  "dashboard",
  "installed-apps",
  "users",
]);

export function shellViewRequiresAdmin(view: ShellView) {
  return ADMIN_SHELL_VIEWS.has(view);
}

export function getAuthorizedShellView(view: ShellView, canManageApps: boolean): ShellView {
  return canManageApps || !shellViewRequiresAdmin(view) ? view : "available-apps";
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

export function readShellRoute(pathname: string, searchParams: ShellSearchParams): ShellRouteState {
  const path = normalizeShellPath(pathname);

  if (path === "/workspace") {
    const appId = searchParams.get("app")?.trim();
    if (appId) {
      return {
        view: "available-apps",
        workspace: {
          appId,
          path: normalizeAppPath(searchParams.get("path")),
        },
      };
    }

    return { view: "available-apps", workspace: null };
  }

  // Canonical admin-only deep link for a UI-capable system app's pages. Reuses the same workspace
  // launch/iframe engine as /workspace; the separate route keeps admin guards and links explicit
  // (docs/ideas/system-app-pages.md).
  const systemAppMatch = /^\/system-apps\/([^/]+)$/.exec(path);
  if (systemAppMatch) {
    let appId = systemAppMatch[1];
    try {
      appId = decodeURIComponent(appId);
    } catch {
      // Malformed percent-encoding in a hand-typed link must not crash route parsing during render;
      // the raw segment falls through to the launch flow's ordinary not-installed error.
    }

    return {
      view: "installed-apps",
      workspace: {
        appId,
        path: normalizeAppPath(searchParams.get("path")),
        system: true,
      },
    };
  }

  if (path === "/apps") {
    return { view: "available-apps", workspace: null };
  }

  if (path === "/installed-apps") {
    return { view: "installed-apps", workspace: null };
  }

  if (path === "/users") {
    return { view: "users", workspace: null };
  }

  return { view: "dashboard", workspace: null };
}

export function getShellViewHref(view: ShellView) {
  return SHELL_VIEW_HREFS[view];
}

export function getWorkspaceHref(appId: string, appPath: string) {
  const params = new URLSearchParams();
  params.set("app", appId);
  params.set("path", normalizeAppPath(appPath));
  return `/workspace?${params.toString()}`;
}

export function getSystemAppHref(appId: string, appPath: string) {
  const params = new URLSearchParams();
  params.set("path", normalizeAppPath(appPath));
  return `/system-apps/${encodeURIComponent(appId)}?${params.toString()}`;
}

export function getWorkspaceRouteKey(route: WorkspaceRoute | null) {
  return route ? `${route.appId}:${route.path}` : "none";
}

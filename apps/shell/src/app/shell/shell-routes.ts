import type { ShellRouteState, ShellSearchParams, ShellView, WorkspaceRoute } from "./types";

export const SIDEBAR_COMPACT_STORAGE_KEY = "hosty.shell.sidebar.compact";

const SHELL_VIEW_HREFS: Record<ShellView, string> = {
  dashboard: "/dashboard",
  "available-apps": "/apps",
  "installed-apps": "/installed-apps",
  users: "/users",
};

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

export function getWorkspaceRouteKey(route: WorkspaceRoute | null) {
  return route ? `${route.appId}:${route.path}` : "none";
}

"use client";

import { useEffect, useState } from "react";
import { fetchCore } from "./core-transport.js";
import { watchWorkspaceInventory } from "./events/workspace-inventory-events";
import type { CoreApp } from "./types";
import type { CoreLaunch } from "./core-development";

export type ActivationWorkspace = {
  id: string;
  state: string;
  name?: string;
  owner: { label: string };
  worktrees: {
    id: string;
    path: string;
    state: string;
    branch: string;
    apps: { appId: string; subpath?: string | null }[];
  }[];
};
export type WorkspaceSource = { id: string; label: string };

const normalizePath = (path: string) => path.replaceAll("\\", "/").replace(/\/+$/, "");

export function workspaceSource(app: CoreApp, workspaces: ActivationWorkspace[]): WorkspaceSource | undefined {
  if (!app.runtimeProfiles?.some(profile => profile.key === app.selectedRuntime && profile.development)) return;
  const source = app.sourceLivePath || app.sourceOverridePath || app.sourceManagedPath;
  if (!source) return;
  const matches = workspaces.filter(workspace => workspace.state !== "released" && workspace.worktrees.some(tree =>
    tree.state === "active" && tree.apps.some(binding => binding.appId === app.id &&
      [tree.path, binding.subpath ? `${tree.path}/${binding.subpath}` : tree.path]
        .some(path => normalizePath(path) === normalizePath(source)))));
  // Do not infer an active workspace from its mere existence or an ambiguous path.
  if (matches.length !== 1) return;
  return { id: matches[0].id, label: matches[0].name || matches[0].owner.label || "Workspace" };
}

// Core can run from any registered repository tree, including one bound only to apps.
// Match the factual project, never the source configured for the next restart or a branch name.
export function coreWorkspaceSource(launch: Pick<CoreLaunch, "mode" | "projectPath"> | null | undefined, workspaces: ActivationWorkspace[]): WorkspaceSource | undefined {
  if (launch?.mode !== "dev" || !launch.projectPath) return;
  const project = absoluteSourcePath(launch.projectPath);
  if (!project) return;
  const matches = workspaces.filter(workspace => workspace.state !== "released" && workspace.worktrees.some(tree => {
    if (tree.state !== "active") return false;
    const path = absoluteSourcePath(tree.path);
    return path !== null && project.startsWith(`${path}/`);
  }));
  if (matches.length !== 1) return;
  return { id: matches[0].id, label: matches[0].name || matches[0].owner.label || "Workspace" };
}

function absoluteSourcePath(value: string): string | null {
  const path = normalizePath(value);
  if (!path.startsWith("/") && !/^[a-z]:\//i.test(path)) return null;
  if (path.split("/").some(part => part === "." || part === "..")) return null;
  return /^[a-z]:\//i.test(path) ? path.toLowerCase() : path;
}

export function useWorkspaceSources(coreOrigin: string, apps: CoreApp[], enabled: boolean, coreLaunch?: Pick<CoreLaunch, "mode" | "projectPath"> | null) {
  const sourcesKey = enabled ? JSON.stringify(apps.filter(app => app.runtimeProfiles?.some(
    profile => profile.key === app.selectedRuntime && profile.development,
  )).map(app => [app.id, app.selectedRuntime, app.sourceLivePath, app.sourceOverridePath, app.sourceManagedPath]).sort()) : "[]";
  const coreProject = enabled && coreLaunch?.mode === "dev" ? coreLaunch.projectPath : null;
  const key = JSON.stringify([coreOrigin, sourcesKey, coreProject, enabled]);
  const [result, setResult] = useState<{ key: string; workspaces: ActivationWorkspace[] } | null>(null);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    const unsubscribe = watchWorkspaceInventory(coreOrigin, async () => {
      try {
        const response = await fetchCore(`${coreOrigin}/api/development/activation-workspaces`, { credentials: "include", signal: controller.signal });
        if (response.status === 401 || response.status === 403) {
          if (!controller.signal.aborted) setResult({ key, workspaces: [] });
          return "forbidden";
        }
        if (!response.ok) return "unavailable";
        const workspaces = (await response.json()).workspaces as ActivationWorkspace[];
        if (!controller.signal.aborted && Array.isArray(workspaces)) {
          setResult({ key, workspaces });
          return "authorized";
        }
      } catch { /* Retain the last inventory until the ordinary stream can resync. */ }
      return "unavailable";
    });
    return () => { unsubscribe(); controller.abort(); };
  }, [coreOrigin, sourcesKey, coreProject, key, enabled]);
  return result?.key === key ? result.workspaces : [];
}

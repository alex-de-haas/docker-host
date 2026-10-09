import type { AppBinding, Workspace, Worktree } from "./types";
export type Filter = "active" | "all" | "changed" | "attention" | "released";
export function changeCount(tree: Worktree): number | null {
  return tree.state === "active" && tree.observation?.state === "ok" ? tree.observation.sessionFiles?.length ?? 0 : null;
}
export function filterWorkspaces(items: Workspace[], query: string, filter: Filter) {
  const text = query.trim().toLocaleLowerCase();
  return items.filter(w => (filter === "all" || filter === "active" && w.state !== "released" || filter === "released" && w.state === "released"
    || filter === "attention" && w.state === "attention" || filter === "changed" && w.worktrees.some(t => (changeCount(t) ?? 0) > 0))
    && [w.id, w.owner.label, w.owner.reference, ...w.worktrees.flatMap(t => [t.repository, t.branch, ...t.apps.map(a => a.name)])].join(" ").toLocaleLowerCase().includes(text));
}
export function fileApps(path: string, apps: AppBinding[]) {
  return apps.filter(app => { const prefix = app.subpath?.replace(/^\.\//, "").replace(/\/$/, ""); return !prefix || path === prefix || path.startsWith(prefix + "/"); });
}
export function workspaceLink(workspace: string, worktree?: string) {
  return "/?" + new URLSearchParams({ workspace, ...(worktree ? { worktree } : {}) });
}
export function safeLink(value: string | null, httpsOnly = false): string | undefined {
  try { const url = new URL(value ?? ""); return (url.protocol === "https:" || !httpsOnly && url.protocol === "http:") && !url.username && !url.password ? url.href : undefined; }
  catch { return undefined; }
}
export function isStale(at: string | undefined, now: number) { return !at || !Number.isFinite(Date.parse(at)) || now - Date.parse(at) > 90_000; }

export function repositoryName(repository: string): string {
  return repository.replace(/[\\/]+$/, "").replace(/[\\/]\.git$/, "").split(/[\\/]/).pop()?.replace(/\.git$/, "") || repository;
}

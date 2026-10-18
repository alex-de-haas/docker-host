"use client";
import { appFetch } from "@hosty-sdk/app/browser-auth";
import { useCallback, useEffect, useState } from "react";

export type Workflow = { state: string; revision: number; completedAt?: string; closure?: string | null; operations?: { id: string; kind: string; state: string; expectedRevision: number; error?: string }[] };
export type Change = { path: string; status: string; binary?: boolean; lineStats?: { additions: number; deletions: number } | null };
export type PullRequest = { url: string; unavailable?: string; publishedHead?: string; observation?: {
  at: string; state: string; title?: string; commentCount?: number; head?: string; draft: boolean;
  reviewDecision?: string; unresolvedThreads: number; checks?: { name: string; state: string }[]; error?: string;
} | null };
export type Worktree = { id: string; workspaceId: string; repository: string; branch: string; state: string;
  apps: { appId: string; name: string; localGit?: boolean }[]; sessionChanges?: Change[]; pullRequests: PullRequest[];
  observation?: { at: string; state: string; conflict?: boolean; head?: string; error?: string; sessionFiles?: string[];
    local?: { files: Change[]; truncated: boolean; lineStats?: { additions: number; deletions: number } } };
  detailError?: string; leases: string[]; };
export type DevelopmentWorkspace = { id: string; state: string; workflow: Workflow;
  owner: { kind: string; label: string; reference: string; appId?: string }; worktrees: Worktree[] };
export type Diff = { path: string; combined: string; truncated: boolean; binary: boolean; image?: unknown };
export async function developmentRequest<T>(path = "", body?: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
  const response = await appFetch(`/api/development-workspaces${path}`, { method: body ? "POST" : "GET", signal,
    cache: "no-store", ...(body ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}) });
  const value = await response.json();
  if (!response.ok) throw new Error(value.message ?? `Workspace request failed (${response.status}).`);
  return value;
}
export function useDevelopmentInventory(enabled: boolean) {
  const [workspaces, setWorkspaces] = useState<DevelopmentWorkspace[]>([]);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision(n => n + 1), []);
  useEffect(() => {
    if (!enabled) return;
    const abort = new AbortController(); let loading = false;
    const load = async () => {
      if (loading) return; loading = true;
      try {
        const value = await developmentRequest<{ workspaces: DevelopmentWorkspace[] }>("", undefined, abort.signal);
        if (!abort.signal.aborted) { setWorkspaces(value.workspaces); setError(""); }
      } catch (e) { if (!abort.signal.aborted) { setWorkspaces([]); setError(e instanceof Error ? e.message : String(e)); } }
      finally { loading = false; }
    };
    void load(); const timer = setInterval(() => { if (document.visibilityState === "visible") void load(); }, 10000);
    return () => { abort.abort(); clearInterval(timer); };
  }, [enabled, revision]);
  return { workspaces, error, refresh };
}
export function repositoryName(repository: string) { return repository.replace(/\.git$/, "").split("/").filter(Boolean).pop() ?? repository; }
export function changeTotals(files: Change[]) {
  if (files.some(f => !f.binary && !f.lineStats)) return null;
  return files.reduce((total, f) => ({ additions: total.additions + (f.lineStats?.additions ?? 0), deletions: total.deletions + (f.lineStats?.deletions ?? 0) }), { additions: 0, deletions: 0 });
}

"use client";
import { appFetch } from "@hosty-sdk/app/browser-auth";
import { subscribeWorkspaceEvents } from "./workspace-events";
import { activityTime } from "@/lib/attention";
import { useCallback, useEffect, useState } from "react";

export type Workflow = { state: string; revision: number; completedAt?: string; closure?: string | null; operations?: { id: string; kind: string; state: string; expectedRevision: number; error?: string }[] };
export const workflowIsActive = (workflow: Workflow) => workflow.state === "in-progress" && !workflow.closure;
export function workflowLabel(workflow: Workflow): string {
  if (["deleting", "deleted"].includes(workflow.state)) return workflow.state;
  if (workflow.closure === "closing") return "pausing";
  if (workflow.state === "completed") return "completed";
  if (workflow.closure === "closed" || workflow.state === "deferred") return "paused";
  return workflow.state.replaceAll("-", " ");
}
export type Change = { path: string; status: string; binary?: boolean; lineStats?: { additions: number; deletions: number } | null };
export type PullRequest = { url: string; unavailable?: string; publishedHead?: string; observation?: {
  at: string; state: string; title?: string; commentCount?: number; head?: string; draft: boolean;
  reviewDecision?: string; unresolvedThreads: number; checks?: { name: string; state: string }[]; error?: string;
} | null };
export type Worktree = { observationHealth?: string; observationRevision?: string; id: string; workspaceId: string; repository: string; branch: string; state: string;
  apps: { appId: string; name: string; localGit?: boolean }[]; sessionChanges?: Change[]; pullRequests: PullRequest[];
  observation?: { at: string; state: string; conflict?: boolean; head?: string; error?: string; sessionFiles?: string[];
    local?: { files: Change[]; truncated: boolean; lineStats?: { additions: number; deletions: number } } };
  detailError?: string; path?: string; hasSandboxConsumers?: boolean; consumers?: { kind: string; reference: string; name?: string; managementUrl?: string }[]; leases: string[]; };
export type DevelopmentWorkspace = { id: string; state: string; updatedAt?: string | null; workflow: Workflow;
  owner: { kind: string; label: string; reference: string; appId?: string }; worktrees: Worktree[] };
export function orderWorkspaces(workspaces: readonly DevelopmentWorkspace[]): DevelopmentWorkspace[] {
  return [...workspaces].sort((left, right) => activityTime(right) - activityTime(left) || left.id.localeCompare(right.id));
}
export type Diff = { path: string; combined: string; truncated: boolean; binary: boolean; image?: unknown; contentKind?: "patch" | "text" };
export class DevelopmentRequestError extends Error {
  constructor(message: string, readonly code?: string) { super(message); }
}
export async function developmentRequest<T>(path = "", body?: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
  const response = await appFetch(`/api/development-workspaces${path}`, { method: body ? "POST" : "GET", signal,
    cache: "no-store", ...(body ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}) });
  const value = await response.json();
  if (!response.ok) throw new DevelopmentRequestError(value.message ?? `Workspace request failed (${response.status}).`, value.code);
  return value;
}
export function useDevelopmentInventory(enabled: boolean) {
  const [workspaces, setWorkspaces] = useState<DevelopmentWorkspace[]>([]);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision(n => n + 1), []);
  useEffect(() => {
    if (!enabled) return;
    const abort = new AbortController(); let generation = 0;
    const load = async () => {
      const current = ++generation;
      try {
        const value = await developmentRequest<{ workspaces: DevelopmentWorkspace[] }>("", undefined, abort.signal);
        if (!abort.signal.aborted && generation === current) { setWorkspaces(value.workspaces); setError(""); }
      } catch (e) { if (!abort.signal.aborted && generation === current) { setWorkspaces([]); setError(e instanceof Error ? e.message : String(e)); } }

    };
    const unsubscribe = subscribeWorkspaceEvents("/api/development-workspaces/events", load, () => {
      generation++; setWorkspaces([]); setError("Workspace updates disconnected. Reconnecting…");
    });
    return () => { generation++; abort.abort(); unsubscribe(); };
  }, [enabled, revision]);
  return { workspaces, error, refresh };
}
export function repositoryName(repository: string) { return repository.replace(/\.git$/, "").split("/").filter(Boolean).pop() ?? repository; }
export function changeTotals(files: Change[]) {
  if (files.some(f => !f.binary && !f.lineStats)) return null;
  return files.reduce((total, f) => ({ additions: total.additions + (f.lineStats?.additions ?? 0), deletions: total.deletions + (f.lineStats?.deletions ?? 0) }), { additions: 0, deletions: 0 });
}

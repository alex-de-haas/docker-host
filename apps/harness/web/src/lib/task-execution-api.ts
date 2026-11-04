"use client";
import { useEffect, useState } from "react";
import { call } from "./api";
import { subscribeWorkspaceEvents } from "./workspace-events";
export type TaskExecutionSummary = {
  revision: string;
  roots: Array<{ taskRef: { id: string }; title: string; number: string; status: string; path: string }>;
  sessions: Array<{ appId: string; installationId: string; ownerId: string; sessionId: string; executionId: string;
    executor: { kind: "option" | "configuration" | "none"; name: string } | null; title: string; status: string;
    associationState: "attached" | "pending" | "failed" | "detached" | "unavailable"; historyPath: string | null; error?: string }>;
  nextCursor: string | null;
};
export function useTaskExecutionSummary(workspaceId: string, participationRevision?: number) {
  const [state, setState] = useState<{ workspaceId: string; summary: TaskExecutionSummary | null; error: string }>({ workspaceId, summary: null, error: "" });
  useEffect(() => {
    let disposed = false, generation = 0;
    const refresh = async () => {
      const own = ++generation;
      try {
        let cursor: string | null = null, result: TaskExecutionSummary | null = null;
        do {
          const page: TaskExecutionSummary = await (await call(`/task-orchestration/v1/workspaces/${encodeURIComponent(workspaceId)}/execution-summary?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`)).json();
          if (disposed || own !== generation) return;
          if (result && result.revision !== page.revision) throw new Error("Task history changed while loading. Refresh to read the current history.");
          result = result ? { ...page, sessions: [...result.sessions, ...page.sessions] } : page; cursor = page.nextCursor;
        } while (cursor && !disposed);
        if (!disposed && own === generation) { setState({ workspaceId, summary: result, error: "" }); }
      } catch (failure) { if (!disposed && own === generation) { setState({ workspaceId, summary: null, error: failure instanceof Error ? failure.message : "Task history is unavailable." }); } }
    };
    void refresh();
    const stop = subscribeWorkspaceEvents("/api/tasks/v1/events", refresh, () => { if (!disposed) setState(current => ({ workspaceId, summary: current.workspaceId === workspaceId ? current.summary : null, error: "Task history updates are unavailable. Refresh the workspace to retry." })); });
    return () => { disposed = true; generation++; stop(); };
  }, [workspaceId, participationRevision]);
  return state.workspaceId === workspaceId ? { summary: state.summary, error: state.error } : { summary: null, error: "" };
}

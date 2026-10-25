"use client";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { AssistantApiError, createWorkspaceSession, listSessions, workspaceAction, type AssistantSession } from "@/lib/assistant-api";
import { developmentRequest, DevelopmentRequestError, type DevelopmentWorkspace } from "@/lib/development-api";
export type Action = { kind: "new" | "attach" | "detach" | "grant" | "revoke"; sessionId?: string; input: Record<string, unknown> };
function readPending(key: string | null, workspaceId?: string): Action | null {
  try {
    const saved = JSON.parse(key ? sessionStorage.getItem(key) ?? "null" : "null") as Action | null;
    return saved && ["new", "attach", "detach", "grant", "revoke"].includes(saved.kind) && saved.input?.workspaceId === workspaceId && typeof saved.input.requestId === "string" ? saved : null;
  } catch { return null; }
}
export function useWorkspaceSessionActions(workspace: DevelopmentWorkspace | undefined, refresh: () => void, onSelect?: (session: AssistantSession) => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const key = workspace?.participation?.viewerUserId ? `hosty.workspace-action:${workspace?.participation?.viewerUserId}:${workspace?.id}` : null;
  const [pending, setPending] = useState<Action | null>(() => readPending(key, workspace?.id));
  const identity = useMemo(() => ({ key }), [key]);
  const currentIdentity = useRef(identity);
  const executing = useRef(false);
  useLayoutEffect(() => { currentIdentity.current = identity; executing.current = false; }, [identity]);
  const [savedIdentity, setSavedIdentity] = useState(identity);
  if (identity !== savedIdentity) {
    setSavedIdentity(identity); setPending(readPending(key, workspace?.id)); setBusy(false); setError("");
  }
  const retry = pending !== null;
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const run = async (action: Action) => {
    if (executing.current || !workspace?.participation) return;
    executing.current = true;
    const isCurrent = () => mounted.current && currentIdentity.current === identity;
    setPending(action); setBusy(true); setError("");
    try { if (key) sessionStorage.setItem(key, JSON.stringify(action)); } catch { /* Optional browser recovery. */ }
    try {
      if (action.kind === "new") {
        const session = await createWorkspaceSession(action.input as { workspaceId: string; requestId: string; expectedRevision: number });
        if (isCurrent()) onSelect?.(session);
      } else if (action.kind === "attach" || action.kind === "detach") {
        await workspaceAction(action.sessionId!, action.kind, action.input);
        if (action.kind === "attach") {
          const record = (await listSessions()).find(s => s.id === action.sessionId);
          if (record && isCurrent()) onSelect?.(record);
        }
      } else await developmentRequest(`/${workspace?.id}/participants/${action.kind}`, action.input);
      try { if (key) sessionStorage.removeItem(key); } catch { /* Receipt remains recoverable. */ }
      if (!isCurrent()) return;
      setPending(null); refresh();
    } catch (cause) {
      if (!isCurrent()) return;
      setError(cause instanceof Error ? cause.message : String(cause));
      if ((cause instanceof DevelopmentRequestError || cause instanceof AssistantApiError) && ["workspace_revision_conflict", "revision_conflict"].includes(cause.code ?? "")) {
        try { if (key) sessionStorage.removeItem(key); } catch { /* Optional browser recovery. */ }
        setPending(null); refresh();
      }
    } finally { if (isCurrent()) { executing.current = false; setBusy(false); } }
  };
  const command = (kind: Action["kind"], extra: Record<string, unknown> = {}, target?: string) => workspace?.participation ? run({ kind, sessionId: target,
    input: { workspaceId: workspace.id, requestId: crypto.randomUUID(), expectedRevision: workspace.participation.revision, ...extra } }) : Promise.resolve();
  return { busy, error, retry, pending, run, command };
}
export type WorkspaceSessionActions = ReturnType<typeof useWorkspaceSessionActions>;

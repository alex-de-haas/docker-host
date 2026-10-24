"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { developmentRequest } from "./development-api";
import { subscribeWorkspaceEvents } from "./workspace-events";

export type WorkspaceApplicationChoice = {
  kind: string; runtime?: string | null; workspaceId?: string | null; worktreeId?: string | null;
  name?: string | null; available?: boolean; unavailable?: string | null;
};
export type WorkspaceApplication = {
  appId: string; name: string; version?: string | null; runtimeState?: string | null; operationStatus?: string | null;
  health?: string | null; current?: WorkspaceApplicationChoice | null; target?: WorkspaceApplicationChoice | null;
  source?: { path?: string | null; branch?: string | null; state?: string | null } | null;
  canSwitch: boolean; unavailable?: string | null;
};
export type WorkspaceApplicationStatus = {
  label: string; tone: "success" | "warning" | "info" | "destructive" | "muted"; busy: boolean;
};
const text = (value: unknown) => typeof value === "string" ? value.trim() : "";

/** Execution identity comes from Core's exact target, never matching names, branches or paths. */
export function workspaceApplicationIsCurrent(app: WorkspaceApplication): boolean {
  const { current, target } = app;
  return current?.kind === "workspace" && target?.kind === "workspace" &&
    !!text(current.workspaceId) && current.workspaceId === target.workspaceId &&
    !!text(current.worktreeId) && current.worktreeId === target.worktreeId;
}

export function workspaceApplicationTarget(app: WorkspaceApplication): {
  kind: "workspace" | "package" | "source" | "unknown"; label: string; detail: string;
} {
  const current = app.current;
  if (current?.kind === "workspace") {
    const detail = text(current.name) || "Name unavailable";
    return { kind: "workspace", label: `Workspace · ${detail}`, detail };
  }
  if (current?.kind === "package") {
    const label = ["Package", text(app.version), text(current.runtime)].filter(Boolean).join(" · ");
    return { kind: "package", label, detail: label };
  }
  if (text(app.source?.path) || text(app.source?.branch) || ["clean", "changes", "no-git"].includes(text(app.source?.state))) {
    const path = text(app.source?.path);
    const name = path.replaceAll("\\", "/").split("/").filter(Boolean).pop() || path;
    const detail = text(app.source?.branch) || name;
    return { kind: "source", label: ["Source", detail].filter(Boolean).join(" · "), detail: detail || "Details unavailable" };
  }
  return { kind: "unknown", label: "Target unavailable", detail: "Target unavailable" };
}

export function workspaceApplicationTargetLabel(app: WorkspaceApplication): string {
  return workspaceApplicationTarget(app).label;
}

/** Update-operation results never replace the application's independent lifecycle state. */
export function workspaceApplicationStatus(app: WorkspaceApplication): WorkspaceApplicationStatus {
  const state = text(app.runtimeState).toLowerCase();
  if (["starting", "stopping", "restarting"].includes(state)) {
    return { label: state.charAt(0).toUpperCase() + state.slice(1), tone: "info", busy: true };
  }
  if (state === "running") {
    const health = text(app.health).toLowerCase();
    if (health === "degraded") return { label: "Running · degraded", tone: "warning", busy: false };
    if (["unhealthy", "failed", "error"].includes(health)) return { label: `Running · ${health}`, tone: "destructive", busy: false };
    if (health === "starting") return { label: "Running · starting", tone: "info", busy: true };
    return { label: "Running", tone: "success", busy: false };
  }
  if (["failed", "error", "offline", "unhealthy"].includes(state)) {
    return { label: state.charAt(0).toUpperCase() + state.slice(1), tone: "destructive", busy: false };
  }
  if (state === "stopped" || state === "installed") return { label: state === "stopped" ? "Stopped" : "Installed", tone: "muted", busy: false };
  return { label: "Unknown", tone: "warning", busy: false };
}

type Scope = { workspaceId: string };
type Snapshot = { scope: Scope | null; applications: WorkspaceApplication[]; loading: boolean; error: string };
const empty: WorkspaceApplication[] = [];
export function useWorkspaceApplications(workspaceId: string, enabled: boolean) {
  // A new identity also invalidates snapshots when the same workspace is reopened.
  const scope = useMemo(() => enabled && workspaceId ? { workspaceId } : null, [enabled, workspaceId]);
  const [snapshot, setSnapshot] = useState<Snapshot>({ scope: null, applications: empty, loading: false, error: "" });
  const loader = useRef<(() => Promise<boolean>) | null>(null);
  const refresh = useCallback(() => { void loader.current?.(); }, []);
  useEffect(() => {
    if (!scope) {
      loader.current = null;
      return;
    }
    let active = true, generation = 0;
    let controller: AbortController | undefined;
    const load = async () => {
      if (!active) return true;
      const current = ++generation;
      controller?.abort();
      const request = new AbortController(); controller = request;
      // A background read keeps the last verified frame; transport activity is not a target change.
      setSnapshot(previous => previous.scope === scope && !previous.loading && !previous.error ? previous
        : { scope, applications: empty, loading: true, error: "" });
      try {
        const value = await developmentRequest<{ apps: WorkspaceApplication[] }>(`/${scope.workspaceId}/applications`, undefined, request.signal);
        if (!Array.isArray(value?.apps) || value.apps.some(app => !app || typeof app.appId !== "string" || !app.appId || typeof app.name !== "string" || typeof app.canSwitch !== "boolean")) {
          throw new Error("Core returned an invalid application snapshot.");
        }
        if (active && current === generation && !request.signal.aborted) setSnapshot({ scope, applications: value.apps, loading: false, error: "" });
        return true;
      } catch (cause) {
        if (!active || current !== generation || request.signal.aborted) return true;
        setSnapshot({ scope, applications: empty, loading: false, error: cause instanceof Error ? cause.message : "Application status is unavailable." });
        return false;
      } finally { if (controller === request) controller = undefined; }
    };
    loader.current = load;
    const unsubscribe = subscribeWorkspaceEvents("/api/development-workspaces/events", load, () => {
      generation++; controller?.abort(); controller = undefined;
      if (active) setSnapshot(previous => ({ scope, applications: empty, loading: false,
        error: previous.scope === scope && previous.error ? previous.error : "Application updates disconnected. Reconnecting…" }));
    });
    return () => {
      active = false; generation++; controller?.abort();
      if (loader.current === load) loader.current = null;
      unsubscribe();
    };
  }, [scope]);
  if (!scope) return { applications: empty, loading: false, error: "", refresh };
  return snapshot.scope === scope ? { applications: snapshot.applications, loading: snapshot.loading, error: snapshot.error, refresh }
    : { applications: empty, loading: true, error: "", refresh };
}

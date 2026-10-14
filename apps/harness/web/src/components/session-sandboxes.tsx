"use client";
import { useEffect, useState } from "react";
import type { CoreEnvironment, SandboxInstance } from "@hosty-sdk/app/sandbox/server";
import { workspaceAction } from "@/lib/assistant-api";
import { Button } from "@/components/ui/button";

export function SessionSandboxes({ sessionId }: { sessionId: string }) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<SandboxInstance[]>([]);
  const [environments, setEnvironments] = useState<CoreEnvironment[]>([]);
  const [appPreviews, setAppPreviews] = useState<Record<string, { name: string; url: string }[]>>({});
  const [environmentError, setEnvironmentError] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    if (!open) return;
    let active = true;
    const load = () => workspaceAction<{ instances: SandboxInstance[] }>(sessionId, "sandbox-list").then(result => {
      if (active) { setItems(result.instances); setError(""); }
    }).catch(cause => { if (active) { setItems([]); setError(cause instanceof Error ? cause.message : "Sandbox inventory unavailable."); } });
    const loadEnvironments = () => workspaceAction<{ environments: CoreEnvironment[] }>(sessionId, "environment-list").then(result => {
      if (active) { setEnvironments(result.environments.filter(item => item.state !== "finished")); setEnvironmentError(""); }
      for (const environment of result.environments.filter(item => item.state === "running")) {
        void workspaceAction<{ status: number; body?: { apps?: { displayName: string; entryEndpoint?: string; entryPath?: string;
          endpoints: { key: string; browserOrigin?: string; availability?: string }[] }[] } }>(sessionId, "environment-api",
          { environmentId: environment.id, method: "GET", path: "/api/apps" }).then(response => {
          const previews = response.status === 200 ? (response.body?.apps ?? []).flatMap(app => {
            const endpoint = app.endpoints.find(item => item.key === app.entryEndpoint && item.availability === "running");
            if (!endpoint?.browserOrigin) return [];
            try {
              const url = new URL(app.entryPath || "/", endpoint.browserOrigin);
              return ["http:", "https:"].includes(url.protocol) && url.origin === new URL(endpoint.browserOrigin).origin
                ? [{ name: app.displayName, url: url.href }] : [];
            } catch { return []; }
          }) : [];
          if (active) setAppPreviews(current => ({ ...current, [environment.id]: previews }));
        }).catch(() => { if (active) setAppPreviews(current => ({ ...current, [environment.id]: [] })); });
      }
    }).catch(cause => { if (active) setEnvironmentError(cause instanceof Error ? cause.message : "Child Core inventory unavailable."); });
    void loadEnvironments();
    void load(); const timer = setInterval(() => { if (document.visibilityState === "visible") { void load(); void loadEnvironments(); } }, 5000);
    return () => { active = false; clearInterval(timer); };
  }, [open, sessionId]);
  return <details className="shrink-0 border-b text-sm" open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary className="cursor-pointer px-3 py-2">Sandbox previews</summary>
    <div className="max-h-64 space-y-3 overflow-y-auto px-3 pb-3">
      <p className="text-xs text-muted-foreground">Ask the agent to prepare an app from its worktree or a pinned artifact. Each sandbox has separate test users and data.</p>
      {environmentError && <p role="alert" className="text-destructive">{environmentError}</p>}
      {environments.map(item => <div key={item.id} className="flex flex-wrap items-center justify-between gap-2 rounded border p-2">
        <div><p className="font-medium">{item.label} · {item.state}</p><p className="text-xs text-muted-foreground">Separate Core · {item.mode} · Port {item.port}</p>{item.error && <p role="status" className="text-xs text-destructive">{item.error}</p>}</div>
        {item.state === "running" && <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" asChild><a href={`${item.previewUrl}/login`} target="_blank" rel="noreferrer">Open test Core</a></Button>
          {(appPreviews[item.id] ?? []).map(app => <Button key={app.url} variant="outline" size="sm" asChild><a href={app.url} target="_blank" rel="noreferrer">Open {app.name}</a></Button>)}
        </div>}
      </div>)}
      {error && <p role="alert" className="text-destructive">{error}</p>}
      {!items.length && !environments.length && !error && !environmentError && <p className="text-muted-foreground">No sandbox instances in this session.</p>}
      {items.map(item => <div key={item.id} className="flex flex-wrap items-center justify-between gap-2 rounded border p-2"><div><p className="font-medium">{item.appId} · {item.state}</p><p className="text-xs text-muted-foreground">{item.source.kind === "worktree" ? "Session worktree" : "Independent artifact"} · {item.users.length} test users</p>{item.errorCode && <p role="status" className="text-xs text-destructive">{item.errorCode}</p>}</div>
        {item.previewUrl && item.state === "ready" && <Button variant="outline" size="sm" asChild><a href={`${item.previewUrl}?hosty_sandbox_persona=core`} target="_blank" rel="noreferrer">Open preview</a></Button>}</div>)}
    </div>
  </details>;
}

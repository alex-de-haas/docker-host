"use client";
import { useEffect, useState } from "react";
import type { CoreEnvironment, SandboxInstance } from "@hosty-sdk/app/sandbox/server";
import { workspaceAction } from "@/lib/assistant-api";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { HostyLoader } from "../../../../../shared/web/hosty-states";
import { HostyMark } from "../../../../../shared/web/hosty-mark";

type AppPreviews = { state: "ready" | "unavailable"; apps: { name: string; url: string }[] };

export function SessionSandboxes({ sessionId }: { sessionId: string }) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<SandboxInstance[]>([]);
  const [environments, setEnvironments] = useState<CoreEnvironment[]>([]);
  const [appPreviews, setAppPreviews] = useState<Record<string, AppPreviews>>({});
  const [environmentError, setEnvironmentError] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [environmentLoading, setEnvironmentLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!open) return;
    let active = true;
    const load = () => workspaceAction<{ instances: SandboxInstance[] }>(sessionId, "sandbox-list").then(result => {
      if (active) { setItems(result.instances); setError(""); }
    }).catch(cause => { if (active) { setItems([]); setError(cause instanceof Error ? cause.message : "Sandbox inventory unavailable."); } })
      .finally(() => { if (active) setLoading(false); });
    const loadEnvironments = () => workspaceAction<{ environments: CoreEnvironment[] }>(sessionId, "environment-list").then(result => {
      if (!active) return;
      setEnvironments(result.environments.filter(item => item.state !== "finished")); setEnvironmentError("");
      for (const environment of result.environments.filter(item => item.state === "running")) {
        void workspaceAction<{ status: number; body?: { apps?: { displayName: string; entryEndpoint?: string; entryPath?: string;
          endpoints: { key: string; browserOrigin?: string; availability?: string }[] }[] } }>(sessionId, "environment-api",
          { environmentId: environment.id, method: "GET", path: "/api/apps" }).then(response => {
          const observed = response.status === 200 && Array.isArray(response.body?.apps);
          const previews = observed ? response.body!.apps!.flatMap(app => {
            const endpoint = app.endpoints.find(item => item.key === app.entryEndpoint && item.availability === "running");
            if (!endpoint?.browserOrigin) return [];
            try {
              const url = new URL(app.entryPath || "/", endpoint.browserOrigin);
              return ["http:", "https:"].includes(url.protocol) && url.origin === new URL(endpoint.browserOrigin).origin
                ? [{ name: app.displayName, url: url.href }] : [];
            } catch { return []; }
          }) : [];
          if (active) setAppPreviews(current => ({ ...current, [environment.id]: { state: observed ? "ready" : "unavailable", apps: previews } }));
        }).catch(() => { if (active) setAppPreviews(current => ({ ...current, [environment.id]: { state: "unavailable", apps: [] } })); });
      }
    }).catch(cause => { if (active) { setEnvironments([]); setAppPreviews({}); setEnvironmentError(cause instanceof Error ? cause.message : "Child Core inventory unavailable."); } })
      .finally(() => { if (active) setEnvironmentLoading(false); });
    void loadEnvironments();
    void load(); const timer = setInterval(() => { if (document.visibilityState === "visible") { void load(); void loadEnvironments(); } }, 5000);
    return () => { active = false; clearInterval(timer); };
  }, [open, sessionId, revision]);
  const retry = () => { setLoading(true); setEnvironmentLoading(true); setError(""); setEnvironmentError(""); setRevision(value => value + 1); };
  return <details className="shrink-0 border-b text-sm" open={open} onToggle={event => {
    const next = event.currentTarget.open;
    if (next && !open) { setLoading(true); setEnvironmentLoading(true); }
    setOpen(next);
  }}>
    <summary className="cursor-pointer px-3 py-2">Sandbox previews</summary>
    <div className="max-h-64 space-y-3 overflow-y-auto px-3 pb-3">
      <p className="text-xs text-muted-foreground">Ask the agent to prepare an app from its worktree or a pinned artifact. Each sandbox has separate test users and data.</p>
      {open && (loading || environmentLoading) && <p role="status" className="flex items-center gap-2 text-muted-foreground"><HostyLoader label={null} className="size-4" />Loading sandbox inventory…</p>}
      {(error || environmentError) && <Alert variant="destructive"><AlertTitle>Sandbox inventory unavailable</AlertTitle><AlertDescription>
        {environmentError && <p>{environmentError}</p>}{error && <p>{error}</p>}<Button variant="outline" size="sm" onClick={retry}>Retry inventory</Button>
      </AlertDescription></Alert>}
      {environments.map(item => <div key={item.id} className="flex flex-wrap items-center justify-between gap-2 rounded border p-2">
        <div><p className="font-semibold">{item.label} · {item.state}</p><p className="text-xs tabular-nums text-muted-foreground">Separate Core · {item.mode} · Port {item.port}</p>{item.error && <p role="status" className="text-xs text-destructive-foreground">{item.error}</p>}</div>
        {item.state === "running" && <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" asChild><a href={`${item.previewUrl}/login`} target="_blank" rel="noreferrer">Open test Core</a></Button>
          {appPreviews[item.id]?.apps.map(app => <Button key={app.url} variant="outline" size="sm" asChild><a href={app.url} target="_blank" rel="noreferrer">Open {app.name}</a></Button>)}
          {!appPreviews[item.id] ? <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground"><HostyLoader label={null} className="size-3.5" />Loading application previews…</p>
            : appPreviews[item.id].state === "unavailable" ? <p role="status" className="text-xs text-muted-foreground">Application previews unavailable.</p>
            : !appPreviews[item.id].apps.length ? <p className="text-xs text-muted-foreground">No running application preview endpoints.</p> : null}
        </div>}
      </div>)}
      {open && !loading && !environmentLoading && !items.length && !environments.length && !error && !environmentError && <Empty className="gap-3 border p-4 md:p-4"><EmptyHeader>
        <EmptyMedia><HostyMark appId="hosty.harness" tile className="size-10" /></EmptyMedia>
        <EmptyTitle>No sandbox instances in this session</EmptyTitle><EmptyDescription>Created sandbox previews appear here.</EmptyDescription>
      </EmptyHeader></Empty>}
      {items.map(item => <div key={item.id} className="flex flex-wrap items-center justify-between gap-2 rounded border p-2"><div><p className="font-mono text-xs">{item.appId} · {item.state}</p><p className="text-xs tabular-nums text-muted-foreground">{item.source.kind === "worktree" ? "Session worktree" : "Independent artifact"} · {item.users.length} test users</p>{item.errorCode && <p role="status" className="text-xs text-destructive-foreground">{item.errorCode}</p>}</div>
        {item.previewUrl && item.state === "ready" && <Button variant="outline" size="sm" asChild><a href={`${item.previewUrl}?hosty_sandbox_persona=core`} target="_blank" rel="noreferrer">Open preview</a></Button>}</div>)}
    </div>
  </details>;
}

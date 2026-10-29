"use client";
import { useEffect, useState } from "react";
import type { CoreEnvironment } from "@hosty-sdk/app/sandbox/server";
import { workspaceAction } from "@/lib/assistant-api";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { HostyLoader } from "../../../../../shared/web/hosty-states";
import { HostyMark } from "../../../../../shared/web/hosty-mark";

type AppPreviews = { state: "ready" | "unavailable"; apps: { name: string; url: string }[] };

export function SessionSandboxes({ sessionId }: { sessionId: string }) {
  const [open, setOpen] = useState(false);
  const [environments, setEnvironments] = useState<CoreEnvironment[]>([]);
  const [appPreviews, setAppPreviews] = useState<Record<string, AppPreviews>>({});
  const [environmentError, setEnvironmentError] = useState("");
  const [environmentLoading, setEnvironmentLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!open) return;
    let active = true;
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
    const timer = setInterval(() => { if (document.visibilityState === "visible") { void loadEnvironments(); } }, 5000);
    return () => { active = false; clearInterval(timer); };
  }, [open, sessionId, revision]);
  const retry = () => { setEnvironmentLoading(true); setEnvironmentError(""); setRevision(value => value + 1); };
  return <details className="shrink-0 border-b text-sm" open={open} onToggle={event => {
    const next = event.currentTarget.open;
    if (next && !open) { setEnvironmentLoading(true); }
    setOpen(next);
  }}>
    <summary className="cursor-pointer px-3 py-2">Sandbox previews</summary>
    <div className="max-h-64 space-y-3 overflow-y-auto px-3 pb-3">
      <p className="text-xs text-muted-foreground">Ask the agent to prepare an app from its worktree or a pinned artifact. Each sandbox has separate test users and data.</p>
      {open && environmentLoading && <p role="status" className="flex items-center gap-2 text-muted-foreground"><HostyLoader label={null} className="size-4" />Loading sandbox inventory…</p>}
      {environmentError && <Alert variant="destructive"><AlertTitle>Sandbox inventory unavailable</AlertTitle><AlertDescription>
        {environmentError && <p>{environmentError}</p>}<Button variant="outline" size="sm" onClick={retry}>Retry inventory</Button>
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
      {open && !environmentLoading && !environments.length && !environmentError && <Empty className="gap-3 border p-4 md:p-4"><EmptyHeader>
        <EmptyMedia><HostyMark appId="hosty.harness" tile className="size-10" /></EmptyMedia>
        <EmptyTitle>No sandbox instances in this session</EmptyTitle><EmptyDescription>Created sandbox previews appear here.</EmptyDescription>
      </EmptyHeader></Empty>}
    </div>
  </details>;
}

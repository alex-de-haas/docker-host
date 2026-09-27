"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Frame, FrameHeader, FramePanel } from "@/components/reui/frame";
import { useShellActions } from "../shell-context";
import { readCoreError, redirectToCoreLoginIfAuthRequired } from "../core-api";
import { defaultSourceDiffSettings } from "../source/source-diff-settings";
import SourceImageView from "../source/source-image-view";
import type { SourceDiff } from "../source/source-preview-data";
const SourceDiffView = dynamic(() => import("../source/source-diff-view"), { ssr: false });

type Workspace = {
  id: string; path: string; state: string; sessionPath: string; targetBranch: string;
  owner: { appId: string; sessionId: string; userId: string }; leases: string[];
  apps: { appId: string; subpath?: string | null }[];
  operations: { id: string; kind: string; state: string; error?: string; command?: Record<string, unknown> }[];
  observation?: { state: string; at: string; head?: string; ahead?: number; behind?: number; error?: string;
    sessionFiles?: string[]; local?: { files: { path: string; status: string }[] } };
};
export function DevelopmentWorkspaces() {
  const { coreOrigin, sendCsrfJson } = useShellActions();
  const [items, setItems] = useState<Workspace[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const pending = useRef<{ id: string; kind: string; body: Record<string, unknown> } | null>(null);
  const load = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch(`${coreOrigin}/api/development/workspaces`, { credentials: "include", cache: "no-store", signal });
    redirectToCoreLoginIfAuthRequired(response, coreOrigin);
    if (!response.ok) throw new Error(await readCoreError(response));
    return (await response.json() as { workspaces: Workspace[] }).workspaces;
  }, [coreOrigin]);
  useEffect(() => {
    const controller = new AbortController();
    const refresh = () => load(controller.signal).then(value => { if (!controller.signal.aborted) setItems(value); }).catch(e => { if (!controller.signal.aborted) setError(e.message); });
    void refresh(); const timer = setInterval(() => { if (document.visibilityState === "visible") void refresh(); }, 20000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [load]);
  const operate = async (w: Workspace, kind: string, extra: Record<string, unknown> = {}, retry = false) => {
    const request = retry && pending.current ? pending.current : { id: w.id, kind, body: { ...extra, requestId: crypto.randomUUID(), ...(["commit", "merge", "abort-merge", "cleanup"].includes(kind) ? { expectedHead: w.observation?.head } : {}) } };
    pending.current = request; setBusy(true); setError("");
    try {
      const response = await sendCsrfJson(`${coreOrigin}/api/development/workspaces/${request.id}/operations/${request.kind}`, request.body);
      const result = await response.json() as Workspace;
      pending.current = null; setItems(await load());
      const operation = result.operations.find(o => o.id === request.body.requestId);
      if (operation && operation.state !== "succeeded") setError(operation.error ?? `Operation ${operation.state}.`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  return <Frame role="region" aria-label="Development workspaces">
    <FrameHeader className="flex items-center justify-between p-3"><h2 className="font-medium">Development workspaces</h2>
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => void load().then(value => { setItems(value); setError(""); }).catch(e => setError(e.message))}>Refresh</Button>
    </FrameHeader>
    <FramePanel className="space-y-3 p-3">
      {error && <p role="alert" className="text-destructive">{error}</p>}
      {pending.current && error && <Button size="sm" disabled={busy} onClick={() => { const w = items.find(i => i.id === pending.current?.id); if (w) void operate(w, "", {}, true); }}>Retry same request</Button>}
      {!items.length && !error && <p className="text-sm text-muted-foreground">No active development workspaces.</p>}
      {items.map(w => <details key={w.id} className="rounded border p-3">
        <summary className="cursor-pointer text-sm">{w.apps.map(a => a.appId).join(", ")} · {w.owner.appId} · {w.owner.sessionId} · {w.state}</summary>
        <div className="mt-3 space-y-3 text-sm">
          <p className="break-all font-mono text-xs">{w.path}</p>
          <p>Target: {w.targetBranch} · HEAD: {w.observation?.head?.slice(0, 8) ?? "unknown"} · {w.observation?.ahead ?? "?"} ahead / {w.observation?.behind ?? "?"} behind last fetched target</p>
          <p>Observed: {w.observation ? new Date(w.observation.at).toLocaleString() : "not yet"}</p>
          {w.observation?.error && <p role="alert">{w.observation.error}</p>}
          <div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" disabled={busy} onClick={() => void operate(w, "refresh")}>Fetch target</Button>
            <Button size="sm" variant="outline" disabled={busy || w.leases.length > 0 || !w.observation?.head} onClick={() => void operate(w, "cleanup")}>Remove merged worktree</Button>
          </div>
          {w.leases.length > 0 && <details><summary className="cursor-pointer">In use: {w.leases.length} activity lease(s)</summary>
            <p className="my-2">Release a stale lease only after verifying that its agent or consumer has stopped.</p>
            {w.leases.map(lease => <Button key={lease} className="m-1" size="sm" variant="outline" disabled={busy} onClick={() => void operate(w, "release-lease", { leaseId: lease })}>Release {lease.slice(0, 8)}</Button>)}
          </details>}
          {w.operations.filter(op => op.state === "pending" && op.command).map(op => <Button key={op.id} size="sm" disabled={busy} onClick={() => {
            pending.current = { id: w.id, kind: op.kind, body: op.command! }; void operate(w, op.kind, {}, true);
          }}>Recover interrupted {op.kind}</Button>)}
          <WorkspaceFiles key={w.id} workspace={w} />
        </div>
      </details>)}
    </FramePanel>
  </Frame>;
}
function WorkspaceFiles({ workspace: w }: { workspace: Workspace }) {
  const { coreOrigin, sendCsrfJson } = useShellActions();
  const [view, setView] = useState("session"); const [app, setApp] = useState("");
  const [diff, setDiff] = useState<SourceDiff | null>(null); const [error, setError] = useState("");
  const generation = useRef(0);
  const files = view === "session" ? w.observation?.sessionFiles ?? [] : w.observation?.local?.files.map(f => f.path) ?? [];
  const scope = w.apps.find(a => a.appId === app)?.subpath;
  const visible = app && scope ? files.filter(p => p === scope || p.startsWith(scope + "/")) : files;
  const show = async (path: string) => {
    const current = ++generation.current; setDiff(null); setError("");
    try { const response = await sendCsrfJson(`${coreOrigin}/api/development/workspaces/${w.id}/diff`, { path, view }); const value = await response.json() as SourceDiff; if (current === generation.current) setDiff(value); }
    catch (cause) { if (current === generation.current) setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  return <div className="space-y-2">
    <div className="flex flex-wrap gap-2">
      <select aria-label="Change view" className="rounded border bg-background p-1" value={view} onChange={e => { ++generation.current; setView(e.target.value); setDiff(null); }}><option value="session">All session changes</option><option value="local">Uncommitted changes</option></select>
      <select aria-label="App scope" className="rounded border bg-background p-1" value={app} onChange={e => setApp(e.target.value)}><option value="">Entire repository</option>{w.apps.map(a => <option key={a.appId} value={a.appId}>{a.appId}</option>)}</select>
    </div>
    <ul>{visible.map(path => <li key={path}><button className="break-all text-left font-mono text-xs hover:underline" onClick={() => void show(path)}>{path}</button></li>)}</ul>
    {visible.length === 0 && w.observation?.state === "ok" && <p className="text-muted-foreground">No changes in this view.</p>}
    {error && <p role="alert">{error}</p>}
    {diff && (diff.image ? <SourceImageView path={diff.path} before={diff.image.before} after={diff.image.after} /> : diff.binary ? <p>Binary file; inspect locally.</p> : <SourceDiffView settings={defaultSourceDiffSettings} path={diff.path} content={diff.combined} untracked={diff.newFile && !diff.combined.startsWith("diff --git ")} truncated={diff.truncated} />)}
  </div>;
}

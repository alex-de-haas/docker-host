"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { workspaceAction, type AssistantSession, type Workspace } from "@/lib/assistant-api";

export function SessionWorkspaces({ session, running }: { session: AssistantSession; running: boolean }) {
  const [open, setOpen] = useState(false);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [appId, setAppId] = useState("");
  const pending = useRef<{ action: string; input: Record<string, unknown> } | null>(null);
  const refresh = useCallback(async () => {
    const result = await workspaceAction<{ workspaces: Workspace[] }>(session.id, "list");
    setWorkspaces(result.workspaces); setError("");
  }, [session.id]);
  useEffect(() => {
    if (!open) return;
    let active = true;
    const load = () => workspaceAction<{ workspaces: Workspace[] }>(session.id, "list").then(result => {
      if (active) { setWorkspaces(result.workspaces); if (!pending.current) setError(""); }
    }).catch(cause => { if (active) setError(cause.message); });
    void load();
    const timer = setInterval(() => { if (document.visibilityState === "visible") void load(); }, 20000);
    return () => { active = false; clearInterval(timer); };
  }, [open, session.id]);
  const run = async (action: string, input: Record<string, unknown>, retry = false) => {
    const request = retry && pending.current ? pending.current : { action, input: { ...input, requestId: crypto.randomUUID() } };
    pending.current = request; setBusy(true); setError("");
    try {
      const result = await workspaceAction<Workspace>(session.id, request.action, request.input);
      pending.current = null;
      await refresh();
      const operation = result.operations?.find(o => o.id === request.input.requestId);
      if (operation && operation.state !== "succeeded") setError(operation.error ?? `Operation ${operation.state}. Inspect the current worktree before continuing.`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  return <details className="shrink-0 border-b text-sm" open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary className="cursor-pointer px-3 py-2">Source workspaces</summary>
    <div className="max-h-80 space-y-3 overflow-y-auto px-3 pb-3">
      <p className="text-xs text-muted-foreground">Prepare a worktree when you want source changes. The installed application keeps its current runtime and data.</p>
      <div className="flex flex-wrap gap-2">
        <select className="max-w-full rounded border bg-background p-1" aria-label="Source app" value={appId} onChange={e => setAppId(e.target.value)}>
          <option value="">Choose an attached app</option>
          {(session.appIds ?? []).map(id => <option key={id} value={id}>{id}</option>)}
        </select>
        <Button size="sm" variant="outline" disabled={!appId || busy || running} onClick={() => void run("prepare", { appId })}>Prepare worktree</Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void refresh().catch(e => setError(e.message))}>Refresh</Button>
      </div>
      {error && <div role="alert" className="text-destructive">{error}{pending.current && <Button size="sm" variant="outline" disabled={busy} onClick={() => void run("", {}, true)}>Retry same request</Button>}</div>}
      {workspaces.length === 0 && !error && <p className="text-muted-foreground">No worktrees for this session.</p>}
      {workspaces.map(workspace => <WorkspaceCard key={workspace.id} workspace={workspace} sessionId={session.id} busy={busy || running}
        cleanup={() => void run("cleanup", { workspaceId: workspace.id, expectedHead: workspace.observation?.head })}
        refresh={() => void run("refresh", { workspaceId: workspace.id })} />)}
    </div>
  </details>;
}

function WorkspaceCard({ workspace: w, sessionId, busy, cleanup, refresh }: {
  workspace: Workspace; sessionId: string; busy: boolean; cleanup: () => void; refresh: () => void;
}) {
  const [view, setView] = useState("session");
  const [preview, setPreview] = useState<{ path: string; combined: string; truncated?: boolean; binary?: boolean; image?: unknown } | null>(null);
  const [error, setError] = useState("");
  const generation = useRef(0);
  const files = view === "session" ? w.observation?.sessionFiles ?? [] : w.observation?.local?.files.map(f => f.path) ?? [];
  const show = async (path: string) => {
    const current = ++generation.current; setPreview(null); setError("");
    try {
      const result = await workspaceAction<NonNullable<typeof preview>>(sessionId, "diff", { workspaceId: w.id, path, view });
      if (current === generation.current) setPreview(result);
    } catch (cause) { if (current === generation.current) setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  return <section className="space-y-2 rounded border p-2" aria-label={`Workspace ${w.id.slice(0, 8)}`}>
    <p className="break-all font-medium">{w.apps.map(a => a.appId).join(", ")} · {w.state}</p>
    <p className="break-all font-mono text-xs">{w.path}</p>
    <p className="text-xs">{w.targetBranch} · {w.observation?.head?.slice(0, 8) ?? "Unknown HEAD"} · {w.leases.length > 0 ? "In use" : "No active leases"}</p>
    {w.observation?.error && <p role="alert">{w.observation.error}</p>}
    {w.state === "active" && <>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" disabled={busy} onClick={refresh}>Fetch target</Button>
        <Button size="sm" variant="outline" disabled={busy || w.leases.length > 0 || !w.observation?.head} onClick={cleanup}>Remove merged worktree</Button>
      </div>
      <select aria-label="Workspace diff view" className="rounded border bg-background p-1" value={view} onChange={e => { ++generation.current; setView(e.target.value); setPreview(null); setError(""); }}>
        <option value="session">All session changes</option><option value="local">Uncommitted changes</option>
      </select>
      <ul>{files.map(path => <li key={path}><button className="break-all text-left font-mono text-xs hover:underline" onClick={() => void show(path)}>{path}</button></li>)}</ul>
      {files.length === 0 && w.observation?.state === "ok" && <p className="text-muted-foreground">No changes in this view.</p>}
      {error && <p role="alert">{error}</p>}
      {preview && <div aria-label={`Changes in ${preview.path}`}>
        {preview.truncated ? <p>Diff exceeds the preview limit. Inspect it in your Git client.</p> : preview.binary || preview.image ? <p>Binary or image change. Inspect this file in Shell or your editor.</p> : <pre className="overflow-auto rounded bg-muted p-2 text-xs">{preview.combined || "No text changes."}</pre>}
      </div>}
    </>}
    {w.pullRequests?.map(url => <a key={url} href={url} target="_blank" rel="noreferrer" className="block break-all underline">Pull request</a>)}
  </section>;
}

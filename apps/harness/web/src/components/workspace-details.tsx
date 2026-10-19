"use client";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { FileDiff, MoreHorizontal, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { developmentRequest, repositoryName, changeTotals, workflowIsActive, workflowLabel, type DevelopmentWorkspace, type Worktree, type Diff, type Workflow } from "@/lib/development-api";
import { LocalRepositoryActions } from "./local-repository-actions";
import { AppDevMode } from "./app-dev-mode";
import { LocalAppHandoff } from "./local-app-handoff";
import { WorkspaceConsumers } from "./workspace-consumers";
import { WorkspaceLeaseRecovery } from "./workspace-lease-recovery";
import { WorkspacePreviews } from "./workspace-previews";
import { PullRequestStatus } from "./pull-request-status";
import { PullRequestChecks } from "./pull-request-checks";

const WorkspaceDiffView = dynamic(() => import("./workspace-diff-view"), {
  ssr: false, loading: () => <p role="status" className="p-3 text-sm text-muted-foreground">Loading diff viewer…</p>,
});

type PendingAction = { kind: string; requestId: string; expectedRevision: number };
function readPendingAction(workspaceId: string): PendingAction | null {
  try {
    const raw = localStorage.getItem(`hosty.workspace.action.${workspaceId}`);
    const value = raw ? JSON.parse(raw) : null;
    return value && ["complete", "resume", "pause", "defer", "delete", "close"].includes(value.kind) && typeof value.requestId === "string" && Number.isSafeInteger(value.expectedRevision) ? value : null;
  } catch { return null; }
}
const safeLink = (value: string) => { try { const u = new URL(value); return ["https:", "http:"].includes(u.protocol) && !u.username && !u.password ? u.href : undefined; } catch { return undefined; } };
export function WorkspaceDetails({ workspace, title, sessionId, running, refresh, deleteConversation }: {
  workspace: DevelopmentWorkspace; title: string; sessionId?: string; running?: boolean;
  refresh: () => void; deleteConversation?: () => Promise<void>;
}) {
  const [trees, setTrees] = useState<Worktree[]>(() => workspace.worktrees.map(t => ({ ...t, sessionChanges: undefined })));
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");
  const [busy, setBusy] = useState(false);
  const [recovering, setRecovering] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [withConversation, setWithConversation] = useState(false);
  const [diffChoices, setDiffChoices] = useState<Record<string, { view: string; path: string }>>({});
  const [diffTree, setDiffTree] = useState<string | null>(null);
  const [localResult, setLocalResult] = useState<{ base: Workflow; value: Workflow } | null>(null);
  const state = localResult?.base === workspace.workflow ? localResult.value : workspace.workflow;
  const [localPending, setPending] = useState<PendingAction | null>(() => readPendingAction(workspace.id));
  const operation = state.operations?.find(o => o.state === "pending");
  const pending = operation ? { kind: operation.kind, requestId: operation.id, expectedRevision: operation.expectedRevision }
    : state.operations?.some(o => o.id === localPending?.requestId && o.state === "succeeded") ? null : localPending;
  const [now, setNow] = useState(Date.now);
  const executing = useRef(false);
  const diffTrigger = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(timer);
  }, []);
  const [detailRefresh, setDetailRefresh] = useState(0);
  const detailVersion = workflowIsActive(state) ? workspace : `${workspace.id}:${state.revision}:${state.closure ?? ""}:${state.state}`;
  const refreshed = useRef(0);
  const loadDetails = useEffectEvent((signal: AbortSignal, fresh: boolean) => Promise.all(workspace.worktrees.map(t =>
    developmentRequest<Worktree>(`/${workspace.id}/worktrees/${t.id}${fresh ? "?refresh=true" : ""}`, undefined, signal))));
  useEffect(() => {
    const abort = new AbortController();
    const fresh = refreshed.current !== detailRefresh; refreshed.current = detailRefresh;
    void loadDetails(abort.signal, fresh)
      .then(values => { if (!abort.signal.aborted) { setTrees(values); setLoadError(""); } })
      .catch(e => { if (!abort.signal.aborted) { setTrees([]); setLoadError(e.message); } });
    return () => abort.abort();
  }, [detailVersion, detailRefresh]);
  const run = async (kind: string, retry = false) => {
    if (executing.current || recovering || (pending && !retry)) return; executing.current = true; setBusy(true); setError("");
    const request = retry && pending ? pending : { kind, requestId: crypto.randomUUID(), expectedRevision: state.revision };
    setPending(request);
    try { localStorage.setItem(`hosty.workspace.action.${workspace.id}`, JSON.stringify(request)); } catch { /* Keep request in memory. */ }
    try {
      const result = await developmentRequest<Workflow>(`/${workspace.id}/workflow/${request.kind}`, { requestId: request.requestId, expectedRevision: request.expectedRevision });
      setLocalResult({ base: workspace.workflow, value: result });
      setPending(null); setConfirmDelete(false);
      try { localStorage.removeItem(`hosty.workspace.action.${workspace.id}`); } catch { /* Optional local recovery journal. */ }
      if (result.state === "deleted" && withConversation && deleteConversation) await deleteConversation();
      refresh();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); refresh(); }
    finally { executing.current = false; setBusy(false); }
  };
  const externalClose = workspace.owner.kind === "external" && !!pending && ["pause", "close", "defer"].includes(pending.kind) && state.closure === "closing" && trees.some(t => t.leases.length > 0);
  const currentDiff = trees.find(t => t.id === diffTree);
  return <aside aria-label="Workspace details" className="h-full overflow-y-auto">
    <div className="flex items-start gap-2 border-b p-4">
      <div className="min-w-0 flex-1"><h2 className="break-words text-base font-semibold">{title || "Workspace"}</h2>
        <p className="mt-1 text-xs text-muted-foreground">{workflowLabel(state)}{state.completedAt ? ` · ${new Date(state.completedAt).toLocaleDateString()}` : ""}</p></div>
      <Button size="icon-sm" variant="ghost" aria-label="Refresh workspace" onClick={() => { setDetailRefresh(n => n + 1); refresh(); }}><RefreshCw className="size-4" /></Button>
      <DropdownMenu><DropdownMenuTrigger asChild><Button size="icon-sm" variant="ghost" aria-label="Workspace actions"><MoreHorizontal /></Button></DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem disabled={busy || recovering || !!pending || running || !["in-progress", "deferred"].includes(state.state)} onSelect={() => void run("complete")}>Complete workspace</DropdownMenuItem>
          <DropdownMenuItem disabled={busy || recovering || !!pending || !workflowIsActive(state)} onSelect={() => void run("pause")}>Pause workspace</DropdownMenuItem>
          <DropdownMenuItem disabled={busy || recovering || !!pending || ["deleting", "deleted"].includes(state.state) || !(state.closure === "closed" || ["completed", "deferred"].includes(state.state))} onSelect={() => void run("resume")}>Resume workspace</DropdownMenuItem>
          <DropdownMenuItem disabled={busy || recovering || !!pending || running || !["completed", "deleting"].includes(state.state)} onSelect={() => setConfirmDelete(true)}>Delete workspace…</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
    <div className="space-y-5 p-4">
      {workspace.owner.kind === "external" && <p className="text-xs text-muted-foreground">External work: {workspace.owner.label}. Conversation and agent activity are not synchronized.</p>}
      {running && <p className="text-xs text-muted-foreground">The agent is running. Pause workspace stops its owned execution and preserves unfinished changes.</p>}
      {(state.closure || state.state === "deferred") && !["deleting", "deleted"].includes(state.state) && <p role="status" className="text-xs text-muted-foreground">{state.closure === "closing" ? "Pausing: new development work is blocked while execution stop is verified." : "Paused: source, previews and conversation are retained. Resume to continue development."}</p>}
      {(!externalClose || loadError) && (error || loadError || operation?.error) && <p role="alert" className="text-sm text-destructive">{error || loadError || operation?.error}</p>}
      {pending && !externalClose && <div className="space-y-2 text-xs"><p>Pending action: {["close", "defer"].includes(pending.kind) ? "pause" : pending.kind}. Retry uses the original request.</p>
        <Button variant="outline" size="sm" disabled={busy || recovering} onClick={() => void run(pending.kind, true)}>Retry action</Button>
        {state.state !== "deleting" && state.closure !== "closing" && <Button variant="ghost" size="sm" disabled={busy || recovering} onClick={() => { setPending(null); try { localStorage.removeItem(`hosty.workspace.action.${workspace.id}`); } catch {} }}>Dismiss</Button>}
      </div>}
      {state.state === "completed" && <Button variant="outline" size="sm" disabled={busy || recovering || !!pending || running} onClick={() => setConfirmDelete(true)}>Delete workspace…</Button>}
      {workspace.owner.kind === "external" && <WorkspaceLeaseRecovery key={`lease:${workspace.id}`} workspaceId={workspace.id}
        trees={trees} closure={state.closure} closeRequest={!!pending && ["pause", "close", "defer"].includes(pending.kind) ? pending : null}
        disabled={busy || !!running} refresh={() => { setDetailRefresh(n => n + 1); refresh(); }} onBusyChange={setRecovering} onClosed={result => {
          setLocalResult({ base: workspace.workflow, value: result }); setPending(null); setError("");
          try { localStorage.removeItem(`hosty.workspace.action.${workspace.id}`); } catch { /* Core keeps the close receipt. */ }
          refresh();
        }} />}
      <WorkspacePreviews key={`previews:${workspace.id}`} workspaceId={workspace.id} canStart={!state.closure && state.state === "in-progress"} disabled={busy || recovering} refresh={refresh} />
      <WorkspaceConsumers trees={trees} />
      {trees.map(tree => {
        const known = tree.sessionChanges !== undefined && tree.observation?.state === "ok" && !tree.detailError;
        const files = tree.sessionChanges ?? [];
        const totals = known ? changeTotals(files) : null;
        return <section key={tree.id} className="space-y-1.5">
          <h3 className="truncate text-sm font-medium" title={tree.repository}>{repositoryName(tree.repository)}</h3>
          <p className="truncate text-xs text-muted-foreground" title={tree.branch}>{tree.branch}</p>
          {tree.apps.length > 0 && <p className="text-xs text-muted-foreground">{tree.apps.map(app => app.name).join(" · ")}</p>}
          <p className="text-xs text-muted-foreground">{tree.observation?.at && Number.isFinite(Date.parse(tree.observation.at))
            ? <>Observed <time dateTime={tree.observation.at}>{new Date(tree.observation.at).toLocaleString()}</time>{tree.observationHealth === "watching" ? " · Watching" : tree.observationHealth === "paused" ? " · Paused" : tree.observationHealth === "pending" ? " · Updating" : " · Observation recovering"}</>
            : "Observation unavailable"}</p>
          <button type="button" disabled={tree.state !== "active"} onClick={event => { diffTrigger.current = event.currentTarget; setDiffTree(tree.id); }} className="flex w-full flex-wrap items-center gap-2 rounded py-1 text-left text-sm hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring">
            <FileDiff className="size-4" />Changes {totals ? <><span className="ml-auto text-emerald-700 dark:text-emerald-400">+{totals.additions}</span><span className="text-red-600 dark:text-red-400">−{totals.deletions}</span></> : <span className="ml-auto text-xs text-muted-foreground">Statistics unavailable</span>}
            <span className="text-xs text-muted-foreground">{known ? `(${files.length} ${files.length === 1 ? "file" : "files"})` : ""}</span>
          </button>
          {sessionId && tree.apps.filter(app => app.localGit).map(app => <div key={app.appId} className="flex flex-col gap-2">
            <LocalAppHandoff sessionId={sessionId} appId={app.appId} workspaceId={tree.id} observation={tree.observation?.at}
              disabled={!!running || busy || tree.state !== "active"} refresh={refresh} />
            <LocalRepositoryActions sessionId={sessionId} appId={app.appId} tree={tree}
              disabled={!!running || busy || tree.state !== "active"} refresh={refresh} />
          </div>)}
          {sessionId && tree.apps.map(app => <AppDevMode key={`${sessionId}:${app.appId}:${tree.id}`} sessionId={sessionId} appId={app.appId} worktreeId={tree.id}
            observation={tree.observation?.at} disabled={!!running || busy || tree.state !== "active"} refresh={refresh} />)}
          {(tree.detailError || tree.observation?.error) && <p role="status" className="text-xs text-destructive">{tree.detailError || tree.observation?.error}</p>}
        </section>;
      })}
      {trees.some(t => t.pullRequests.length) && <section className="space-y-3 border-t pt-4"><h3 className="text-sm text-muted-foreground">Pull requests</h3>
        {trees.flatMap(tree => tree.pullRequests.map(pr => {
          const o = pr.observation, stale = !o || !Number.isFinite(Date.parse(o.at)) || now - Date.parse(o.at) > 90000;
          const number = pr.url.match(/\/pull\/(\d+)(?:[/?#]|$)/)?.[1];
          const repository = repositoryName(pr.url.split("/pull/")[0]);
          return <div key={`${tree.id}:${pr.url}`} className="space-y-1 text-sm"><a href={safeLink(pr.url)} target="_blank" rel="noreferrer" className="flex items-start gap-2 hover:underline"><PullRequestStatus pr={pr} stale={stale} /><span className="line-clamp-2">{number && <span className="text-muted-foreground">#{number} · </span>}{o?.title || "Pull request"}</span></a>
            <p className="pl-6 text-xs text-muted-foreground">{repository} · <PullRequestChecks pr={pr} stale={stale} label={`${repository}${number ? ` #${number}` : ""}`} /> · {o?.commentCount === undefined ? "Comments unknown" : `${o.commentCount} discussion comments`}</p>
            <p className="pl-6 text-xs text-muted-foreground">{o?.state ?? "State unknown"}{o?.draft ? " · Draft" : ""}{stale ? " · Stale / unobserved" : ""}{o?.reviewDecision ? ` · ${o.reviewDecision}` : ""}{o?.unresolvedThreads ? ` · ${o.unresolvedThreads} unresolved threads` : ""}</p>
            {(pr.unavailable || o?.error) && <p className="pl-6 text-xs text-destructive">{pr.unavailable || o?.error}</p>}
          </div>;
        }))}
      </section>}
    </div>
    <Dialog open={!!currentDiff} onOpenChange={open => { if (!open) setDiffTree(null); }}>
      <DialogContent onCloseAutoFocus={event => { event.preventDefault(); diffTrigger.current?.focus(); }} className="flex h-[85dvh] max-w-[95vw] flex-col sm:max-w-5xl"><DialogTitle>{currentDiff ? repositoryName(currentDiff.repository) : "Changes"}</DialogTitle><DialogDescription>Changes from the original workspace base, including committed work.</DialogDescription>
        {currentDiff && <WorkspaceDiff key={currentDiff.id} workspaceId={workspace.id} tree={currentDiff}
          choice={diffChoices[currentDiff.id] ?? { view: "session", path: "" }}
          onChoice={choice => setDiffChoices(previous => ({ ...previous, [currentDiff.id]: choice }))} />}
      </DialogContent>
    </Dialog>
    <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}><DialogContent><DialogTitle>Delete workspace?</DialogTitle><DialogDescription>Finish this workspace’s sandboxes and remove their temporary data, then remove its merged worktrees. Core verifies that no other process still uses the source. Published pull requests stay available.</DialogDescription>
      <ul className="list-disc pl-5 text-sm">{workspace.worktrees.map(t => <li key={t.id}>{repositoryName(t.repository)}</li>)}</ul>
      {deleteConversation && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={withConversation} onChange={e => setWithConversation(e.target.checked)} />Also delete this conversation after cleanup succeeds</label>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <Button disabled={busy || recovering || running || (!!pending && pending.kind !== "delete")} onClick={() => void run("delete", pending?.kind === "delete")}>{busy ? "Deleting…" : "Delete workspace"}</Button>
    </DialogContent></Dialog>
  </aside>;
}
function WorkspaceDiff({ workspaceId, tree, choice, onChoice }: { workspaceId: string; tree: Worktree;
  choice: { view: string; path: string }; onChoice: (choice: { view: string; path: string }) => void }) {
  const { view, path } = choice;
  const [layout, setLayout] = useState<"unified" | "split">("unified");
  const [wrap, setWrap] = useState(true);
  const [result, setResult] = useState<{ key: string; diff?: Diff; error?: string } | null>(null);
  const files = view === "session" ? tree.sessionChanges ?? [] : tree.observation?.local?.files ?? [];
  const selected = files.some(f => f.path === path) ? path : files[0]?.path;
  const key = `${view}:${selected}`;
  const diff = result?.key === key ? result.diff : null;
  const error = result?.key === key ? result.error : null;
  useEffect(() => {
    if (!selected) return;
    const abort = new AbortController();
    void developmentRequest<Diff>(`/${workspaceId}/worktrees/${tree.id}/diff?${new URLSearchParams({ path: selected, view })}`, undefined, abort.signal)
      .then(diff => { if (!abort.signal.aborted) setResult({ key, diff }); }).catch(e => { if (!abort.signal.aborted) setResult({ key, error: e.message }); });
    return () => abort.abort();
  }, [workspaceId, tree.id, view, selected, key]);
  return <><div className="flex flex-wrap items-center gap-2"><select aria-label="Diff scope" className="w-fit rounded border bg-background p-2 text-sm" value={view} onChange={e => onChoice({ ...choice, view: e.target.value })}><option value="session">All workspace changes</option><option value="local">Uncommitted changes</option></select>
      <div role="group" aria-label="Diff layout" className="flex gap-1">
        <Button size="sm" variant={layout === "unified" ? "secondary" : "ghost"} aria-pressed={layout === "unified"} onClick={() => setLayout("unified")}>Unified</Button>
        <Button size="sm" variant={layout === "split" ? "secondary" : "ghost"} aria-pressed={layout === "split"} onClick={() => setLayout("split")}>Split</Button>
      </div>
      <Button size="sm" variant={wrap ? "secondary" : "ghost"} aria-pressed={wrap} onClick={() => setWrap(!wrap)}>Wrap lines</Button>
    </div>
    <div className="flex min-h-0 flex-1 flex-col gap-3 sm:flex-row"><nav aria-label="Changed files" className="max-h-32 shrink-0 overflow-auto sm:max-h-none sm:w-56">{files.map(f => <button key={f.path} type="button" aria-current={selected === f.path ? "true" : undefined} onClick={() => onChoice({ ...choice, path: f.path })} className={`block w-full break-all rounded px-2 py-1.5 text-left text-xs hover:bg-muted ${selected === f.path ? "bg-muted" : ""}`}>{f.path}</button>)}</nav>
      <div className="min-h-0 min-w-0 flex-1 overflow-auto rounded border bg-background">{error ? <p role="alert" className="p-3 text-sm">{error}</p> : !selected ? <p className="p-3 text-sm">No changes in this scope.</p> : !diff ? <p role="status" className="p-3 text-sm">Loading diff…</p> : <WorkspaceDiffView diff={diff} layout={layout} wrap={wrap} />}</div>
    </div></>;
}

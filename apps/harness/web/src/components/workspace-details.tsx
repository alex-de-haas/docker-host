"use client";
import { useEffect, useRef, useState } from "react";
import { GitPullRequest, FileDiff, MoreHorizontal, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { developmentRequest, repositoryName, changeTotals, type DevelopmentWorkspace, type Worktree, type Diff, type Workflow } from "@/lib/development-api";
import { WorkspacePreviews } from "./workspace-previews";

type PendingAction = { kind: string; requestId: string; expectedRevision: number };
function readPendingAction(workspaceId: string): PendingAction | null {
  try {
    const raw = localStorage.getItem(`hosty.workspace.action.${workspaceId}`);
    const value = raw ? JSON.parse(raw) : null;
    return value && ["complete", "resume", "defer", "delete", "close"].includes(value.kind) && typeof value.requestId === "string" && Number.isSafeInteger(value.expectedRevision) ? value : null;
  } catch { return null; }
}
const safeLink = (value: string) => { try { const u = new URL(value); return ["https:", "http:"].includes(u.protocol) && !u.username && !u.password ? u.href : undefined; } catch { return undefined; } };
export function WorkspaceDetails({ workspace, title, running, refresh, deleteConversation }: {
  workspace: DevelopmentWorkspace; title: string; sessionId?: string; running?: boolean;
  refresh: () => void; deleteConversation?: () => Promise<void>;
}) {
  const [trees, setTrees] = useState<Worktree[]>(() => workspace.worktrees.map(t => ({ ...t, sessionChanges: undefined })));
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
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
  useEffect(() => {
    const abort = new AbortController();
    void Promise.all(workspace.worktrees.map(t => developmentRequest<Worktree>(`/${workspace.id}/worktrees/${t.id}`, undefined, abort.signal)))
      .then(values => { if (!abort.signal.aborted) { setTrees(values); } })
      .catch(e => { if (!abort.signal.aborted) { setTrees([]); setError(e.message); } });
    return () => abort.abort();
  }, [workspace]);
  const run = async (kind: string, retry = false) => {
    if (executing.current) return; executing.current = true; setBusy(true); setError("");
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
  const currentDiff = trees.find(t => t.id === diffTree);
  return <aside aria-label="Workspace details" className="h-full overflow-y-auto">
    <div className="flex items-start gap-2 border-b p-4">
      <div className="min-w-0 flex-1"><h2 className="break-words text-base font-semibold">{title || "Workspace"}</h2>
        <p className="mt-1 text-xs text-muted-foreground">{state.state.replaceAll("-", " ")}{state.closure ? ` · ${state.closure}` : ""}{state.completedAt ? ` · ${new Date(state.completedAt).toLocaleDateString()}` : ""}</p></div>
      <Button size="icon-sm" variant="ghost" aria-label="Refresh workspace" onClick={refresh}><RefreshCw className="size-4" /></Button>
      <DropdownMenu><DropdownMenuTrigger asChild><Button size="icon-sm" variant="ghost" aria-label="Workspace actions"><MoreHorizontal /></Button></DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem disabled={busy || !!pending || running || state.state !== "in-progress"} onSelect={() => void run("complete")}>Complete workspace</DropdownMenuItem>
          <DropdownMenuItem disabled={busy || !!pending || running || state.state !== "in-progress"} onSelect={() => void run("defer")}>Defer workspace</DropdownMenuItem>
          <DropdownMenuItem disabled={busy || !!pending || !!state.closure || ["deleting", "deleted"].includes(state.state)} onSelect={() => void run("close")}>Close workspace</DropdownMenuItem>
          <DropdownMenuItem disabled={busy || !!pending || !(state.closure === "closed" || ["completed", "deferred"].includes(state.state))} onSelect={() => void run("resume")}>Resume workspace</DropdownMenuItem>
          <DropdownMenuItem disabled={busy || running || !["completed", "deleting"].includes(state.state)} onSelect={() => setConfirmDelete(true)}>Delete workspace…</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
    <div className="space-y-5 p-4">
      {workspace.owner.kind === "external" && <p className="text-xs text-muted-foreground">External work: {workspace.owner.label}. Conversation and agent activity are not synchronized.</p>}
      {running && <p className="text-xs text-muted-foreground">The agent is running. Close workspace stops its owned execution and preserves unfinished changes.</p>}
      {state.closure && <p role="status" className="text-xs text-muted-foreground">{state.closure === "closing" ? "Closing: new development work is blocked while execution stop is verified." : "Closed: source, previews and conversation are retained. Resume to continue development."}</p>}
      {(error || operation?.error) && <p role="alert" className="text-sm text-destructive">{error || operation?.error}</p>}
      {pending && <div className="space-y-2 text-xs"><p>Pending action: {pending.kind}. Retry uses the original request.</p>
        <Button variant="outline" size="sm" disabled={busy} onClick={() => void run(pending.kind, true)}>Retry action</Button>
        {state.state !== "deleting" && state.closure !== "closing" && <Button variant="ghost" size="sm" disabled={busy} onClick={() => { setPending(null); try { localStorage.removeItem(`hosty.workspace.action.${workspace.id}`); } catch {} }}>Dismiss</Button>}
      </div>}
      {state.state === "completed" && <Button variant="outline" size="sm" disabled={busy || running} onClick={() => setConfirmDelete(true)}>Delete workspace…</Button>}
      {trees.map(tree => {
        const known = tree.sessionChanges !== undefined && tree.observation?.state === "ok" && !tree.detailError;
        const files = tree.sessionChanges ?? [];
        const totals = known ? changeTotals(files) : null;
        return <section key={tree.id} className="space-y-1.5">
          <h3 className="truncate text-sm font-medium" title={tree.repository}>{repositoryName(tree.repository)}</h3>
          <p className="truncate text-xs text-muted-foreground" title={tree.branch}>{tree.branch}</p>
          {tree.apps.length > 0 && <p className="text-xs text-muted-foreground">{tree.apps.map(app => app.name).join(" · ")}</p>}
          <p className="text-xs text-muted-foreground">{tree.observation?.at && Number.isFinite(Date.parse(tree.observation.at))
            ? <>Observed <time dateTime={tree.observation.at}>{new Date(tree.observation.at).toLocaleString()}</time>{now - Date.parse(tree.observation.at) > 90000 ? " · Stale" : ""}</>
            : "Observation unavailable"}</p>
          <button type="button" disabled={tree.state !== "active"} onClick={event => { diffTrigger.current = event.currentTarget; setDiffTree(tree.id); }} className="flex w-full flex-wrap items-center gap-2 rounded py-1 text-left text-sm hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring">
            <FileDiff className="size-4" />Changes {totals ? <><span className="ml-auto text-emerald-700 dark:text-emerald-400">+{totals.additions}</span><span className="text-red-600 dark:text-red-400">−{totals.deletions}</span></> : <span className="ml-auto text-xs text-muted-foreground">Statistics unavailable</span>}
            <span className="text-xs text-muted-foreground">{known ? `(${files.length} ${files.length === 1 ? "file" : "files"})` : ""}</span>
          </button>
          {(tree.detailError || tree.observation?.error) && <p role="status" className="text-xs text-destructive">{tree.detailError || tree.observation?.error}</p>}
        </section>;
      })}
      <WorkspacePreviews key={workspace.id} workspaceId={workspace.id} />
      {trees.some(t => t.pullRequests.length) && <section className="space-y-3 border-t pt-4"><h3 className="text-sm text-muted-foreground">Pull requests</h3>
        {trees.flatMap(tree => tree.pullRequests.map(pr => {
          const o = pr.observation, stale = !o || now - Date.parse(o.at) > 90000;
          const checks = o?.checks, passed = checks?.filter(c => ["SUCCESS", "NEUTRAL", "SKIPPED"].includes(c.state)).length;
          return <div key={`${tree.id}:${pr.url}`} className="space-y-1 text-sm"><a href={safeLink(pr.url)} target="_blank" rel="noreferrer" className="flex items-start gap-2 hover:underline"><GitPullRequest className="mt-0.5 size-4 shrink-0 text-violet-500" /><span className="line-clamp-2">{o?.title || `Pull request #${pr.url.split("/").pop()}`}</span></a>
            <p className="pl-6 text-xs text-muted-foreground">{repositoryName(tree.repository)} · CI {checks ? `${passed}/${checks.length}` : "unknown"} · {o?.commentCount === undefined ? "Comments unknown" : `${o.commentCount} discussion comments`}</p>
            <p className="pl-6 text-xs text-muted-foreground">{o?.state ?? "State unknown"}{o?.draft ? " · Draft" : ""}{stale ? " · Stale / unobserved" : ""}{o?.reviewDecision ? ` · ${o.reviewDecision}` : ""}{o?.unresolvedThreads ? ` · ${o.unresolvedThreads} unresolved threads` : ""}</p>
            {checks?.filter(c => !["SUCCESS", "NEUTRAL", "SKIPPED"].includes(c.state)).map((c,i) => <p key={i} className="pl-6 text-xs">{c.name}: {c.state}</p>)}
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
      <Button disabled={busy || running} onClick={() => void run("delete", pending?.kind === "delete")}>{busy ? "Deleting…" : "Delete workspace"}</Button>
    </DialogContent></Dialog>
  </aside>;
}
function WorkspaceDiff({ workspaceId, tree, choice, onChoice }: { workspaceId: string; tree: Worktree;
  choice: { view: string; path: string }; onChoice: (choice: { view: string; path: string }) => void }) {
  const { view, path } = choice;
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
  return <><select aria-label="Diff scope" className="w-fit rounded border bg-background p-2 text-sm" value={view} onChange={e => onChoice({ ...choice, view: e.target.value })}><option value="session">All workspace changes</option><option value="local">Uncommitted changes</option></select>
    <div className="flex min-h-0 flex-1 flex-col gap-3 sm:flex-row"><nav aria-label="Changed files" className="max-h-32 shrink-0 overflow-auto sm:max-h-none sm:w-56">{files.map(f => <button key={f.path} type="button" aria-current={selected === f.path ? "true" : undefined} onClick={() => onChoice({ ...choice, path: f.path })} className={`block w-full break-all rounded px-2 py-1.5 text-left text-xs hover:bg-muted ${selected === f.path ? "bg-muted" : ""}`}>{f.path}</button>)}</nav>
      <div className="min-h-0 min-w-0 flex-1 overflow-auto rounded bg-muted p-3 text-xs">{error ? <p role="alert">{error}</p> : !selected ? "No changes in this scope." : !diff ? "Loading diff…" : diff.truncated ? "Diff exceeds the preview limit. Inspect it in your Git client." : diff.binary || diff.image ? "Binary file changed. Inspect it in your editor." : <pre>{diff.combined || "No text changes."}</pre>}</div>
    </div></>;
}

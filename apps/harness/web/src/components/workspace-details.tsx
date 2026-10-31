"use client";
import { subscribePullRequests } from "@/lib/pull-requests-events";
import { prRequest } from "@/lib/pull-requests-api";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import type { WorkspaceSessionActions } from "@/lib/use-workspace-session-actions";
import { FeedbackInbox } from "./feedback-inbox";
import { WorkspaceSessions } from "./workspace-sessions";
import { WorkspaceReview, type ReviewChoice } from "./workspace-review";
import { FileDiff, FolderGit2, GitBranch, MoreHorizontal, Pencil, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { developmentRequest, DevelopmentRequestError, repositoryName, changeTotals, workflowIsActive, workflowLabel, type DevelopmentWorkspace, type Worktree, type Workflow } from "@/lib/development-api";
import { LocalRepositoryActions } from "./local-repository-actions";
import { LocalAppHandoff } from "./local-app-handoff";
import { WorkspaceActivation } from "./workspace-activation";
import { WorkspaceConsumers } from "./workspace-consumers";
import { WorkspaceDelete } from "./workspace-delete";
import { WorkspaceLeaseRecovery } from "./workspace-lease-recovery";
import { WorkspacePreviews } from "./workspace-previews";
import { WorkspacePullRequest } from "./workspace-pull-request";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { HostyLoader } from "../../../../../shared/web/hosty-states";
import { ContextAppIcon } from "@/components/context-app-icon";
import type { AssistantSession, ContextApp } from "@/lib/assistant-api";

type PendingAction = { kind: string; requestId: string; expectedRevision: number };
const actionProgress: Record<string, string> = {
  complete: "Completing workspace…", delete: "Deleting workspace…", resume: "Resuming workspace…",
  pause: "Pausing workspace…", close: "Pausing workspace…", defer: "Pausing workspace…",
};
function readPendingAction(workspaceId: string): PendingAction | null {
  try {
    const raw = localStorage.getItem(`hosty.workspace.action.${workspaceId}`);
    const value = raw ? JSON.parse(raw) : null;
    return value && ["complete", "resume", "pause", "defer", "delete", "close"].includes(value.kind) && typeof value.requestId === "string" && Number.isSafeInteger(value.expectedRevision) ? value : null;
  } catch { return null; }
}
export function WorkspaceDetails({ workspace, title, sessionId, running, refresh, deleteConversation, onReview, onSessionSelected, sessionActions, appMetadata = [] }: {
  workspace: DevelopmentWorkspace; title: string; sessionId?: string; running?: boolean; appMetadata?: readonly ContextApp[];
  sessionActions?: WorkspaceSessionActions;
  onSessionSelected?: (session: AssistantSession) => void;
  refresh: () => void; deleteConversation?: () => Promise<void>; onReview?: (tree: Worktree, choice?: ReviewChoice) => void;
}) {
  const canManage = workspace.permissions?.manage !== false;
  const updatePrConsumer = useEffectEvent(() => refresh());
  const hasTrackedPr = workspace.worktrees.some(tree => tree.pullRequests.length > 0);
  const activePrConsumer = hasTrackedPr && workflowIsActive(workspace.workflow);
  useEffect(() => {
    if (!activePrConsumer) return;
    const abort = new AbortController(); let unsubscribe: (() => void) | undefined;
    void prRequest<{ storageScope: string }>("/repositories", undefined, abort.signal).then(scope => {
      if (abort.signal.aborted) return;
      unsubscribe = subscribePullRequests(scope.storageScope, { scope: { workspaces: [workspace.id] },
        sync: async () => updatePrConsumer(), failed: () => { /* The existing workspace card reports unavailable observations. */ } });
    }).catch(() => { /* Older Core installations retain their existing workspace event stream. */ });
    return () => { abort.abort(); unsubscribe?.(); };
  }, [workspace.id, activePrConsumer]);
  const [trees, setTrees] = useState<Worktree[]>(() => workspace.worktrees.map(t => ({ ...t, sessionChanges: undefined })));
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");
  const [leaseRefusal, setLeaseRefusal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [recovering, setRecovering] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [diffChoices, setDiffChoices] = useState<Record<string, ReviewChoice>>({});
  const [diffTree, setDiffTree] = useState<string | null>(null);
  const [localResult, setLocalResult] = useState<{ base: Workflow; value: Workflow } | null>(null);
  const state = localResult?.base === workspace.workflow ? localResult.value : workspace.workflow;
  const [localPending, setPending] = useState<PendingAction | null>(() => readPendingAction(workspace.id));
  const operation = state.operations?.find(o => o.state === "pending" || o.state === "unknown");
  const discardOperation = operation?.kind === "discard" ? operation : undefined;
  const pending = discardOperation ? null : operation ? { kind: operation.kind, requestId: operation.id, expectedRevision: operation.expectedRevision }
    : localPending && state.operations?.some(o => o.id === localPending.requestId && o.kind === localPending.kind && o.expectedRevision === localPending.expectedRevision && o.state === "succeeded") ? null : localPending;
  const [now, setNow] = useState(Date.now);
  const executing = useRef(false);
  const diffTrigger = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(timer);
  }, []);
  const [detailRefresh, setDetailRefresh] = useState(0);
  // Inventory responses create new objects even when only a different workspace changed.
  // Retain details until this workspace's source, consumer, lease or PR facts change.
  const detailVersion = JSON.stringify([workspace.id, state.revision, state.closure, state.state,
    workflowIsActive(state) ? workspace.worktrees : null]);
  const refreshed = useRef(0);
  const loadedDetails = useRef<string | null>(null);
  const detailRequest = useRef<{ version: string; abort: AbortController } | null>(null);
  const loadDetails = useEffectEvent((signal: AbortSignal, fresh: boolean) => Promise.all(workspace.worktrees.map(t =>
    developmentRequest<Worktree>(`/${workspace.id}/worktrees/${t.id}${fresh ? "?refresh=true" : ""}`, undefined, signal))));
  useEffect(() => () => {
    detailRequest.current?.abort.abort(); detailRequest.current = null; loadedDetails.current = null;
  }, [workspace.id]);
  useEffect(() => {
    const fresh = refreshed.current !== detailRefresh; refreshed.current = detailRefresh;
    if (!fresh && (loadedDetails.current === detailVersion || detailRequest.current?.version === detailVersion)) return;
    detailRequest.current?.abort.abort(); loadedDetails.current = null;
    const abort = new AbortController();
    const request = { version: detailVersion, abort }; detailRequest.current = request;
    void loadDetails(abort.signal, fresh)
      .then(values => {
        if (!abort.signal.aborted) { loadedDetails.current = detailVersion; setTrees(values); setLoadError(""); }
      })
      .catch(e => { if (!abort.signal.aborted) { loadedDetails.current = null; setTrees([]); setLoadError(e.message); } })
      .finally(() => { if (detailRequest.current === request) detailRequest.current = null; });
    // A failed read retries on the next inventory; identical successful/in-flight reads are reused.
  }, [workspace, detailVersion, detailRefresh]);
  const run = async (kind: string, retry = false) => {
    if (executing.current || recovering || (pending && !retry)) return; executing.current = true; setBusy(true); setError(""); setLeaseRefusal(false);
    const request = retry && pending ? pending : { kind, requestId: crypto.randomUUID(), expectedRevision: state.revision };
    setPending(request);
    try { localStorage.setItem(`hosty.workspace.action.${workspace.id}`, JSON.stringify(request)); } catch { /* Keep request in memory. */ }
    try {
      const result = await developmentRequest<Workflow>(`/${workspace.id}/workflow/${request.kind}`, { requestId: request.requestId, expectedRevision: request.expectedRevision });
      setLocalResult({ base: workspace.workflow, value: result });
      setPending(null); setConfirmDelete(false);
      try { localStorage.removeItem(`hosty.workspace.action.${workspace.id}`); } catch { /* Optional local recovery journal. */ }
      refresh();
    } catch (e) {
      let confirmed = false;
      if (e instanceof DevelopmentRequestError && e.status && e.status >= 400 && e.status < 500 && ![408, 425, 429].includes(e.status)) {
        try {
          // A refusal can precede admission or follow durable cleanup intent. Core's receipt decides.
          const observed = await developmentRequest<Workflow>(`/${workspace.id}/workflow`);
          if (typeof observed?.state !== "string" || !Number.isSafeInteger(observed.revision) || observed.revision < 0) throw new Error("Invalid workflow response.");
          setLocalResult({ base: workspace.workflow, value: observed });
          const receipt = observed.operations?.find(operation => operation.id === request.requestId);
          confirmed = receipt?.state === "succeeded" && receipt.kind === request.kind && receipt.expectedRevision === request.expectedRevision;
          if (confirmed || (!receipt && observed.state !== "deleting" && observed.closure !== "closing")) {
            setPending(null); setConfirmDelete(false);
            try { localStorage.removeItem(`hosty.workspace.action.${workspace.id}`); } catch { /* Optional local recovery journal. */ }
          }
        } catch { /* Unavailable evidence keeps the original request recoverable. */ }
      }
      setLeaseRefusal(!confirmed && e instanceof DevelopmentRequestError && e.code === "workspace_in_use");
      setError(confirmed ? "" : e instanceof Error ? e.message : String(e)); refresh();
    }
    finally { executing.current = false; setBusy(false); }
  };
  const externalClose = canManage && !!pending && ["pause", "close", "defer"].includes(pending.kind) && state.closure === "closing" && trees.some(t => t.leases.length > 0);
  const currentDiff = trees.find(t => t.id === diffTree);
  return <aside aria-label="Workspace details" className="h-full overflow-y-auto">
    <div className="border-b p-4">
      <div className="mb-3 flex items-center justify-between gap-2"><p className="text-xs font-semibold text-muted-foreground">Workspace</p>
        <Badge variant="outline" className="bg-muted text-xs font-medium">{workflowLabel(state)}</Badge></div>
      <div className="flex items-start gap-1.5">
      <div className="min-w-0 flex-1"><WorkspaceName key={workspace.id} workspace={workspace} fallback={title} refresh={refresh} />
        {state.completedAt && <p className="mt-1 text-xs text-muted-foreground">Completed {new Date(state.completedAt).toLocaleDateString()}</p>}</div>
      <Button size="icon-sm" variant="ghost" aria-label="Refresh workspace" onClick={() => { setDetailRefresh(n => n + 1); refresh(); }}><RefreshCw className="size-3.5" /></Button>
      {canManage && <DropdownMenu><DropdownMenuTrigger asChild><Button size="icon-sm" variant="ghost" aria-label="Workspace actions"><MoreHorizontal /></Button></DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem disabled={busy || recovering || !!discardOperation || !!pending || running || !["in-progress", "deferred"].includes(state.state)} onSelect={() => void run("complete")}>Complete workspace</DropdownMenuItem>
          <DropdownMenuItem disabled={busy || recovering || !!discardOperation || !!pending || !workflowIsActive(state)} onSelect={() => void run("pause")}>Pause workspace</DropdownMenuItem>
          <DropdownMenuItem disabled={busy || recovering || !!discardOperation || !!pending || ["deleting", "deleted"].includes(state.state) || !(state.closure === "closed" || ["completed", "deferred"].includes(state.state))} onSelect={() => void run("resume")}>Resume workspace</DropdownMenuItem>
          <DropdownMenuItem variant="destructive" onSelect={() => setConfirmDelete(true)}>Delete workspace…</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>}
      </div>
      <WorkspaceObservation trees={trees} now={now} />
    </div>
    <div className="space-y-4 p-4">
      {workspace.participation && <WorkspaceSessions actions={sessionActions} workspace={workspace} sessionId={sessionId} running={running} refresh={refresh} onSelect={onSessionSelected} />}
      {workspace.owner.kind === "external" && <p className="text-xs text-muted-foreground">External work: {workspace.owner.label}. The external conversation and its agent activity are not synchronized.</p>}
      {running && <p className="text-xs text-muted-foreground">An agent is running. Pause workspace fences all participants and waits for confirmed execution stops.</p>}
      {(state.closure || state.state === "deferred") && !["deleting", "deleted"].includes(state.state) && <p role="status" className="text-xs text-muted-foreground">{state.closure === "closing" ? "Pausing: new development work is blocked while execution stop is verified." : "Paused: source, previews and conversation are retained. Resume to continue development."}</p>}
      {(!externalClose || loadError) && (error || loadError || operation?.error) && <p role="alert" className="text-sm text-destructive-foreground">{error || loadError || operation?.error}</p>}
      {discardOperation && <div className="space-y-2 text-xs"><p>Workspace removal is pending. Recover the original confirmed request.</p><Button variant="outline" size="sm" disabled={busy || recovering} onClick={() => setConfirmDelete(true)}>Recover removal</Button></div>}
      {busy && <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground"><HostyLoader label={null} className="size-4" />{actionProgress[pending?.kind ?? ""] ?? "Updating workspace…"}</p>}
      {leaseRefusal && !busy && !recovering && !pending && canManage && workflowIsActive(state) && trees.some(tree => tree.leases.length) && <div className="space-y-2 text-xs">
        <p>Pause this workspace, then confirm that all agent executions and their commands have stopped. Source files are retained.</p>
        <Button variant="outline" size="sm" onClick={() => void run("pause")}>Pause workspace</Button>
      </div>}
      {pending && !busy && !externalClose && <div className="space-y-2 text-xs"><p>{operation?.state === "pending" ? "Pending action" : "Action outcome unconfirmed"}: {["close", "defer"].includes(pending.kind) ? "pause" : pending.kind}. Retry uses the original request.</p>
        <Button variant="outline" size="sm" disabled={busy || recovering} onClick={() => void run(pending.kind, true)}>Retry action</Button>
        {!operation && state.state !== "deleting" && state.closure !== "closing" && <Button variant="ghost" size="sm" disabled={busy || recovering} onClick={() => { setPending(null); try { localStorage.removeItem(`hosty.workspace.action.${workspace.id}`); } catch {} }}>Dismiss</Button>}
      </div>}
      {canManage && <WorkspaceLeaseRecovery key={`lease:${workspace.id}`} workspaceId={workspace.id}
        trees={trees} closure={state.closure} closeRequest={!!pending && ["pause", "close", "defer"].includes(pending.kind) ? pending : null}
        disabled={busy || !!running} refresh={() => { setDetailRefresh(n => n + 1); refresh(); }} onBusyChange={setRecovering} onClosed={result => {
          setLocalResult({ base: workspace.workflow, value: result }); setPending(null); setError("");
          try { localStorage.removeItem(`hosty.workspace.action.${workspace.id}`); } catch { /* Core keeps the close receipt. */ }
          refresh();
        }} />}
      {trees.map(tree => {
        const known = tree.sessionChanges !== undefined && tree.observation?.state === "ok" && !tree.detailError;
        const files = tree.sessionChanges ?? [];
        const totals = known ? changeTotals(files) : null;
        return <section key={tree.id} aria-label={`${repositoryName(tree.repository)} repository`} className="min-w-0 space-y-3 rounded-xl border bg-card p-3">
          <div className="flex min-w-0 items-center gap-2"><FolderGit2 className="size-4 shrink-0 text-muted-foreground" aria-hidden /><h3 className="truncate text-sm font-semibold" title={tree.repository}>{repositoryName(tree.repository)}</h3></div>
          {tree.apps.length > 0 && <div aria-label="Bound applications" className="flex flex-wrap gap-1.5">{tree.apps.map(app => <span key={app.appId} className="inline-flex min-w-0 items-center gap-1.5 rounded-md border bg-muted/50 px-1.5 py-1 text-xs font-medium" title={app.appId}><ContextAppIcon app={appMetadata.find(metadata => metadata.id === app.appId)} className="size-4" /><span className="truncate">{app.name}</span></span>)}</div>}
          <p className="flex min-w-0 items-center gap-1.5 font-mono text-xs text-muted-foreground" title={`${tree.branch}${tree.targetBranch ? ` → ${tree.targetBranch}` : ""}`}><GitBranch className="size-3.5 shrink-0" aria-hidden /><span className="min-w-0 truncate" title={tree.branch}>{tree.branch}</span>{tree.targetBranch && <><span className="shrink-0" aria-hidden>→</span><span className="max-w-1/2 shrink-0 truncate" title={tree.targetBranch}>{tree.targetBranch}</span></>}</p>
          {(tree.observation?.ahead !== undefined || tree.observation?.behind !== undefined) && <p className="text-xs tabular-nums text-muted-foreground">{tree.observation.ahead !== undefined ? `${tree.observation.ahead} ahead` : ""}{tree.observation.ahead !== undefined && tree.observation.behind !== undefined ? " · " : ""}{tree.observation.behind !== undefined ? `${tree.observation.behind} behind` : ""}</p>}
          <p className="text-xs text-muted-foreground">{tree.observation?.at && Number.isFinite(Date.parse(tree.observation.at))
            ? <>Observed <time dateTime={tree.observation.at}>{new Date(tree.observation.at).toLocaleString()}</time>{tree.observationHealth === "watching" ? " · Watching" : tree.observationHealth === "paused" ? " · Paused" : tree.observationHealth === "pending" ? " · Updating" : " · Observation recovering"}</>
            : "Observation unavailable"}</p>
          <Button type="button" variant="ghost" disabled={tree.state !== "active"} onClick={event => { diffTrigger.current = event.currentTarget; if (onReview) onReview(tree); else setDiffTree(tree.id); }} className="h-auto w-full min-w-0 flex-wrap justify-start gap-2 rounded-lg border bg-muted/40 px-2.5 py-2.5 text-left text-xs">
            <FileDiff className="size-3.5" />Workspace changes {totals ? <><span className="ml-auto font-mono font-normal tabular-nums text-success-foreground">+{totals.additions}</span><span className="font-mono font-normal tabular-nums text-destructive-foreground">−{totals.deletions}</span></> : <span className="ml-auto text-xs text-muted-foreground">Statistics unavailable</span>}
            <span className="text-xs font-normal tabular-nums text-muted-foreground">{known ? `(${files.length} ${files.length === 1 ? "file" : "files"})` : ""}</span>
          </Button>
          {sessionId && tree.apps.filter(app => app.localGit).map(app => <div key={app.appId} className="flex flex-col gap-2">
            <LocalAppHandoff sessionId={sessionId} appId={app.appId} workspaceId={tree.id} observation={tree.observation?.at}
              disabled={!!running || busy || tree.state !== "active"} refresh={refresh} />
            <LocalRepositoryActions compact sessionId={sessionId} appId={app.appId} tree={tree}
              disabled={!!running || busy || tree.state !== "active"} refresh={refresh} />
          </div>)}
          {(tree.detailError || tree.observation?.error) && <p role="status" className="text-xs text-destructive-foreground">{tree.detailError || tree.observation?.error}</p>}
        </section>;
      })}
      {trees.some(t => t.pullRequests.length) && <section className="space-y-3 border-t pt-4"><h3 className="text-xs font-semibold text-muted-foreground">Pull requests</h3>
        {trees.flatMap(tree => tree.pullRequests.map(pr => <WorkspacePullRequest key={`${tree.id}:${pr.url}`} tree={tree} pr={pr} now={now} onReview={button => {
          diffTrigger.current = button;
          const choice = { view: `pr:${pr.url}`, path: "" };
          if (onReview) onReview(tree, choice);
          else { setDiffChoices(previous => ({ ...previous, [tree.id]: choice })); setDiffTree(tree.id); }
        }} />))}
      </section>}
      <FeedbackInbox key={"feedback:" + workspace.id} workspaceId={workspace.id} sessionId={sessionId} running={running} disabled={!canManage || busy || recovering || !workflowIsActive(state)} />
      <WorkspacePreviews key={`previews:${workspace.id}`} workspaceId={workspace.id} canStart={!state.closure && state.state === "in-progress"} disabled={busy || recovering} refresh={refresh} />
      {trees.some(tree => tree.apps.length || tree.leases.length || tree.consumers?.length) && <div className="space-y-3 border-t pt-4"><h3 className="text-xs font-semibold text-muted-foreground">Used by</h3>
      <WorkspaceActivation key={workspace.id} workspaceId={workspace.id} appMetadata={appMetadata} apps={[...new Map(trees.flatMap(tree => tree.apps).map(app => [app.appId, app])).values()]}
        disabled={busy || recovering} canUse={workflowIsActive(state)} refresh={refresh} /><WorkspaceConsumers trees={trees} /></div>}
    </div>
    {currentDiff && <div className="fixed inset-0 z-40 flex bg-background"><WorkspaceReview workspaceId={workspace.id} tree={currentDiff}
      choice={diffChoices[currentDiff.id] ?? { view: "session", path: "" }}
      onChoice={choice => setDiffChoices(previous => ({ ...previous, [currentDiff.id]: choice }))}
      onBack={() => { setDiffTree(null); requestAnimationFrame(() => diffTrigger.current?.focus()); }} /></div>}
    {confirmDelete && <WorkspaceDelete key={workspace.id} workspaceId={workspace.id} name={workspace.name ?? title}
      pendingRequestId={discardOperation?.id ?? (pending?.kind === "delete" ? pending.requestId : undefined)}
      onClose={() => setConfirmDelete(false)} refresh={refresh} deleteConversation={deleteConversation} />}

  </aside>;
}
function WorkspaceName({ workspace, fallback, refresh }: { workspace: DevelopmentWorkspace; fallback: string; refresh: () => void }) {
  const canonical = workspace.name || workspace.owner.label || fallback || "Workspace";
  const [saved, setSaved] = useState<{ base: string; name: string } | null>(null);
  const name = saved?.base === canonical ? saved.name : canonical;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const request = useRef<{ requestId: string; name: string } | null>(null);
  const rename = async () => {
    const next = draft.trim();
    if (busy || !next) return;
    if (next === name) { setEditing(false); return; }
    setBusy(true); setError("");
    if (request.current?.name !== next) request.current = { requestId: crypto.randomUUID(), name: next };
    try {
      const value = await developmentRequest<{ name: string }>(`/${workspace.id}/name`, request.current);
      setSaved({ base: canonical, name: value.name }); setEditing(false); request.current = null; refresh();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  if (workspace.participation?.role === "contributor") return <h2 className="text-sm font-medium">{name}</h2>;
  return editing ? <form className="space-y-2" onSubmit={event => { event.preventDefault(); void rename(); }}>
    <label className="sr-only" htmlFor={`workspace-name-${workspace.id}`}>Workspace name</label>
    <Input id={`workspace-name-${workspace.id}`} autoFocus maxLength={120} value={draft} disabled={busy}
      className="w-full rounded border bg-background px-2 py-1" onChange={event => setDraft(event.target.value)} />
    <div className="flex gap-2"><Button type="submit" size="sm" disabled={busy || !draft.trim()}>{busy ? "Saving…" : "Save name"}</Button>
      <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => setEditing(false)}>Cancel</Button></div>
    {error && <p role="alert" className="text-xs text-destructive-foreground">{error}</p>}
  </form> : <div className="flex min-w-0 items-start gap-2"><h2 className="min-w-0 flex-1 break-words text-lg font-semibold tracking-[-0.01em]">{name}</h2>
    <Button variant="ghost" size="icon-sm" aria-label="Rename workspace" onClick={() => { setDraft(name); setError(""); setEditing(true); }}><Pencil className="size-3.5" /></Button>
  </div>;
}

function WorkspaceObservation({ trees, now }: { trees: Worktree[]; now: number }) {
  const observed = trees.map(tree => tree.observation?.at).filter((at): at is string => !!at && Number.isFinite(Date.parse(at)));
  const oldest = observed.length ? observed.reduce((left, right) => Date.parse(left) < Date.parse(right) ? left : right) : null;
  const health = trees.length && observed.length === trees.length
    ? trees.every(tree => tree.observationHealth === "watching") ? "watching"
      : trees.every(tree => tree.observationHealth === "paused") ? "paused"
        : trees.some(tree => tree.observationHealth === "pending") ? "updating" : "observation recovering"
    : "observation unavailable";
  const age = oldest ? Math.max(0, Math.floor((now - Date.parse(oldest)) / 1000)) : null;
  const relative = age == null ? null : age < 60 ? `${age} s ago` : age < 3600 ? `${Math.floor(age / 60)} min ago` : age < 86400 ? `${Math.floor(age / 3600)} h ago` : `${Math.floor(age / 86400)} d ago`;
  return <p aria-label="Workspace observation" className="mt-2 text-xs tabular-nums text-muted-foreground">{trees.length} {trees.length === 1 ? "repository" : "repositories"} · {health}{oldest && <> · observed <time dateTime={oldest} title={new Date(oldest).toLocaleString()}>{relative}</time>{trees.length > 1 && " or later"}</>}</p>;
}

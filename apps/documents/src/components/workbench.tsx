"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { observeSources } from "@/lib/source-events";
import { CatalogView } from "./catalog-view";
import { appFetch } from "@hosty-sdk/app/browser-auth";
import { deliverableChanges, lineDiff, mapBounded, planLink } from "@/lib/model";
import { type PlanDetail, type RepositoryDocuments, type SourceRepository, type WorkspacePlan } from "@/lib/types";
import { DocumentMetadata, Progress, VersionBrief, formatTime } from "./plan-metadata";
import { TrackedDocument } from "./document";
import { LoadingIndicator } from "./loading-indicator";
import { WorkspaceOwner, WorkspaceSessionLink, WorkspacePullRequests } from "./workspace-owner";
import { DiscussPlan } from "./discuss-plan";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Frame, FrameDescription, FrameHeader, FramePanel, FrameTitle } from "@/components/reui/frame";
import { ArrowLeftIcon, GitBranchIcon, RefreshCwIcon } from "lucide-react";

import { TranslateDocument } from "./translate-document";



async function read<T>(url: string, signal: AbortSignal): Promise<T> {
  const response = await appFetch(url, { signal, cache: "no-store" });
  if (!response.ok) { const body = await response.json().catch(() => null) as { message?: string } | null; throw new Error(body?.message ?? `Documents returned HTTP ${response.status}.`); }
  return response.json() as Promise<T>;
}
export function DocumentsWorkbench() {
  const query = useSearchParams();
  const [epoch, setEpoch] = useState(0);
  const [refreshEpoch, setRefreshEpoch] = useState(0);
  const [live, setLive] = useState("Connecting live updates…");
  const documentPath = query.get("document");
  const repositoryId = query.get("repository");
  const workspaceId = query.get("workspace");
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const stop = observeSources(repositoryId, () => { if (!timer) timer=setTimeout(()=>{timer=null;setEpoch(value=>value+1);},200); }, setLive);
    return () => {stop();if(timer)clearTimeout(timer);};
  }, [repositoryId]);
  function navigate(url: string) {
    const destination = new URL(url, window.location.origin);
    // A document deep link carries its catalog filters so Back/Home can restore the same scope.
    if (destination.searchParams.has("document")) {
      for (const key of ["view", "q", "app", "status", "layout", "page"]) {
        if (!destination.searchParams.has(key) && query.has(key)) destination.searchParams.set(key, query.get(key)!);
      }
      destination.searchParams.set("catalogRepository", query.get("catalogRepository") ?? (documentPath ? repositoryId ?? "" : query.get("repository") ?? ""));
    } else if (documentPath) {
      for (const key of ["view", "q", "app", "status", "layout", "page"]) if (query.has(key)) destination.searchParams.set(key, query.get(key)!);
      const original = query.get("catalogRepository");
      if (original !== null) { if (original) destination.searchParams.set("repository", original); else destination.searchParams.delete("repository"); }
    }
    window.history.pushState(null, "", destination.pathname + destination.search + destination.hash);
    window.scrollTo({ top: 0 });
  }
  function refresh() { setRefreshEpoch(value => value + 1); }
  return <main className={`mx-auto flex max-w-[1500px] flex-col px-4 py-4 text-sm sm:px-6 lg:px-8 ${documentPath && repositoryId ? "h-dvh min-h-0 gap-2 overflow-hidden" : "gap-4"}`}>
    <p role="status" className="shrink-0 text-xs text-muted-foreground">{live}</p>
    {documentPath && repositoryId ? <Detail key={`${repositoryId}:${documentPath}`} repositoryId={repositoryId} path={documentPath} workspaceId={workspaceId} epoch={epoch} refreshEpoch={refreshEpoch} navigate={navigate} onRefresh={refresh} /> : <Overview query={new URLSearchParams(query.toString())} epoch={epoch} refreshEpoch={refreshEpoch} navigate={navigate} onRefresh={refresh} />}
  </main>;
}
function Overview({ query, epoch, refreshEpoch, navigate, onRefresh }: { query: URLSearchParams; epoch: number; refreshEpoch: number; navigate: (url: string) => void; onRefresh: () => void }) {
  const [repositories, setRepositories] = useState<SourceRepository[]>([]);
  const [loaded, setLoaded] = useState<Record<string, RepositoryDocuments>>({});
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState<{ completed: number; total: number | null } | null>({ completed: 0, total: null });
  const firstEpoch = useRef(refreshEpoch);
  const firstLoadCompleted = useRef(false);
  useEffect(() => {
    const controller = new AbortController();
    let running = false;
    let refresh = refreshEpoch !== firstEpoch.current;
    firstEpoch.current = refreshEpoch;
    async function load() {
      if (running) return;
      running = true;
      const showLoading = refresh || !firstLoadCompleted.current;
      if (showLoading) setLoading({ completed: 0, total: null });
      try {
        const { repositories: items } = await read<{ repositories: SourceRepository[] }>("/api/repositories", controller.signal);
        if (controller.signal.aborted) return;
        setRepositories(items); setError(null);
        if (showLoading) setLoading({ completed: 0, total: items.length });
        await mapBounded(items, 3, async repository => {
          let result: RepositoryDocuments;
          try { result = await read<RepositoryDocuments>(`/api/repositories/${encodeURIComponent(repository.id)}${refresh ? "?refresh=true" : ""}`, controller.signal); }
          catch (failure) { result = { repository, plans: [], workspaces: [], state: "unavailable", error: (failure as Error).message }; }
          if (!controller.signal.aborted) {
            setLoaded(previous => ({ ...previous, [result.repository.id]: result }));
            if (showLoading) setLoading(previous => previous ? { ...previous, completed: previous.completed + 1 } : null);
            setRepositories(previous => previous.map(item => item.id === repository.id ? result.repository : item));
            if (result.repository.id !== repository.id) {
              canonicalRepositoryUrl(repository.id, result.repository.id);
            }
          }
        });
        refresh = false;
      } catch (failure) { if (!controller.signal.aborted) { setError((failure as Error).message); setRepositories([]); setLoaded({}); } }
      finally { running = false; if (!controller.signal.aborted) { firstLoadCompleted.current = true; setLoading(null); } }
    }
    void load();
    const refreshVisible = () => { if (document.visibilityState === "visible") void load(); };
    document.addEventListener("visibilitychange", refreshVisible);
    return () => { controller.abort(); document.removeEventListener("visibilitychange", refreshVisible); };
  }, [epoch, refreshEpoch]);
  const loadingMessage = loading ? loading.total === null ? "Loading sources…" : `Loading repositories… ${loading.completed}/${loading.total}` : null;
  const unavailableRepositories = Object.fromEntries(repositories.flatMap(repository => {
    const result = loaded[repository.id];
    return result?.error || result?.state === "unavailable" ? [[repository.id, result.error || "Tracked branch is unavailable."]] : [];
  }));
  return <CatalogView repositories={repositories} loaded={loaded} query={query} loading={loadingMessage} error={error} navigate={navigate} refresh={onRefresh} unavailableRepositories={unavailableRepositories} />;
}

function Detail({ repositoryId, path, workspaceId, epoch, refreshEpoch, navigate, onRefresh }: { repositoryId: string; path: string; workspaceId: string | null; epoch: number; refreshEpoch: number; navigate: (url: string) => void; onRefresh: () => void }) {
  const [detail, setDetail] = useState<PlanDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const firstEpoch = useRef(refreshEpoch);
  useEffect(() => {
    const controller = new AbortController();
    let running = false;
    let refresh = refreshEpoch !== firstEpoch.current;
    firstEpoch.current = refreshEpoch;
    async function load() {
      if (running) return;
      running = true;
      try {
        const result = await read<PlanDetail>(`/api/document?${new URLSearchParams({ repository: repositoryId, path, ...(workspaceId ? { workspace: workspaceId } : {}), ...(refresh ? { refresh: "true" } : {}) })}`, controller.signal);
        if (!controller.signal.aborted) { setDetail(result); setError(null); canonicalRepositoryUrl(repositoryId, result.repository.id); }
        refresh = false;
      } catch (failure) { if (!controller.signal.aborted) { setDetail(null); setError((failure as Error).message); } }
      finally { running = false; }
    }
    void load();
    const refreshVisible = () => { if (document.visibilityState === "visible") void load(); };
    document.addEventListener("visibilitychange", refreshVisible);
    return () => { controller.abort(); document.removeEventListener("visibilitychange", refreshVisible); };
  }, [repositoryId, path, workspaceId, epoch, refreshEpoch]);
  const current = detail?.path === path ? detail : null;
  return <>
    <div className="shrink-0"><DiscussPlan key={`${repositoryId}:${path}:${workspaceId ?? "target"}`} detail={current} workspaceId={workspaceId}
      back={<Button variant="ghost" className="min-w-0 shrink" asChild><a href={`/?${new URLSearchParams({ repository: repositoryId })}`} title="Documentation home" onClick={event => { event.preventDefault(); navigate(`/?${new URLSearchParams({ repository: repositoryId })}`); }}><ArrowLeftIcon data-icon="inline-start" /><span className="truncate">Documentation home</span></a></Button>}
      refresh={<Button variant="outline" className="shrink-0" aria-label="Refresh sources" title="Refresh sources" onClick={onRefresh}><RefreshCwIcon data-icon="inline-start" /><span className="hidden sm:inline">Refresh sources</span></Button>}
    /></div>
    {error && <Alert variant="destructive"><AlertTitle>Document unavailable</AlertTitle><AlertDescription>{error}</AlertDescription></Alert>}
    {!current && !error && <LoadingIndicator message="Loading document versions…" />}
    {current && <nav aria-label="Feature documents" className="flex shrink-0 gap-2 border-b pb-2">
      {[{ path: current.path, title: current.document?.title ?? current.path, kind: current.document?.kind }, ...(current.related ?? [])].sort((a,b)=>a.path.localeCompare(b.path)).map(item => <Button key={item.path} variant={item.path===path?"secondary":"ghost"} size="sm" onClick={()=>navigate(planLink(repositoryId,item.path,workspaceId??undefined))}>{item.kind==="feature"?"Feature":item.kind==="plan"?"Plan":"Document"}</Button>)}
      {current.workspaces.length>0 && <Button variant="ghost" size="sm" onClick={()=>navigate(planLink(repositoryId,path,current.workspaces[0].workspace.id))}>Changes <Badge variant="secondary">{current.workspaces.length}</Badge></Button>}
    </nav>}
    {current && <PlanVersions detail={current} workspaceId={workspaceId} navigate={navigate} />}
  </>;
}
function DocumentPath({ detail }: { detail: PlanDetail }) {
  const label = `${repoName(detail.repository)} / ${detail.path}`;
  return <p className="min-w-0 truncate text-xs text-muted-foreground" title={label}><span className="hidden lg:inline">{repoName(detail.repository)} / </span>{detail.path}</p>;
}
export function PlanVersions({ detail, workspaceId, navigate }: { detail: PlanDetail; workspaceId: string | null; navigate: (url: string) => void }) {
  const selected = detail.workspaces.find(version => version.workspace.id === workspaceId);
  const unavailable = workspaceId !== null && !selected;
  const repositoryId = detail.repository.id;
  return <Tabs value={workspaceId ?? "tracked"} onValueChange={value => navigate(planLink(repositoryId, detail.path, value === "tracked" ? undefined : value))} className="min-h-0 min-w-0 flex-1 gap-2 overflow-hidden">
    <div className="min-w-0 shrink-0 overflow-x-auto border-b pb-1">
      <TabsList variant="line" aria-label="Document versions">
        <TabsTrigger value="tracked" className="shrink-0"><GitBranchIcon />Tracked branch<span className="max-w-40 truncate text-muted-foreground" title={detail.repository.branch}>{detail.repository.branch}</span></TabsTrigger>
        {detail.workspaces.map(({ workspace }) => <TabsTrigger key={workspace.id} value={workspace.id} className="shrink-0" title={workspace.branch}>
          <GitBranchIcon /><span className="max-w-48 truncate">{workspace.ownerLabel?.trim() || "Workspace"}</span><span className="text-xs text-muted-foreground">{workspace.id.slice(0, 8)}</span>
        </TabsTrigger>)}
        {unavailable && <TabsTrigger value={workspaceId} className="shrink-0">Unavailable workspace</TabsTrigger>}
      </TabsList>
    </div>
    <TabsContent value="tracked" className="min-h-0 min-w-0 overflow-hidden">
      <Frame className="h-full min-h-0"><FrameHeader className="shrink-0 gap-2 sm:flex-row sm:items-center sm:justify-between"><DocumentPath detail={detail} />{detail.document && <div className="flex shrink-0 items-center gap-3"><Badge variant="secondary">{detail.document.status ?? "Document"}</Badge><Progress document={detail.document} /></div>}</FrameHeader><FramePanel className="min-h-0 flex-1 overflow-y-auto overscroll-contain focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring" role="region" aria-label="Document content" tabIndex={0}>
        <TrackedDocument document={detail.document} error={detail.error} repositoryId={repositoryId} navigate={navigate}>{detail.document && <div className="flex min-w-0 flex-col gap-4">
          <DocumentMetadata document={detail.document} repository={detail.repository} />
          <TranslateDocument document={detail.document} repositoryId={repositoryId} workspaceId={null} navigate={navigate} />
        </div>}</TrackedDocument>
      </FramePanel></Frame>
    </TabsContent>
    {detail.workspaces.map(version => <TabsContent key={version.workspace.id} value={version.workspace.id} className="min-h-0 min-w-0 overflow-hidden">
      <Frame className="h-full min-h-0"><FrameHeader className="shrink-0 gap-1"><DocumentPath detail={detail} /><FrameTitle><h2 className="truncate" title={version.workspace.branch}>{version.workspace.branch}</h2></FrameTitle><VersionBrief version={version} /><FrameDescription>Changes against this workspace’s own base.</FrameDescription></FrameHeader><FramePanel className="min-h-0 flex-1 overflow-y-auto overscroll-contain focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring" role="region" aria-label="Workspace content" tabIndex={0}>
        <div className="flex min-w-0 flex-col gap-4">
          {version.document && <DocumentMetadata document={version.document} repository={detail.repository} />}
          <WorkspaceDocument version={version} repositoryId={repositoryId} navigate={navigate} />
        </div>
      </FramePanel></Frame>
    </TabsContent>)}
    {unavailable && <TabsContent value={workspaceId} className="min-h-0 overflow-y-auto"><Alert><AlertTitle>Workspace version unavailable</AlertTitle><AlertDescription>The selected workspace no longer changes this document. Select the tracked branch or another workspace.</AlertDescription></Alert></TabsContent>}
  </Tabs>;
}
export function WorkspaceDocument({ version, repositoryId, navigate }: { version: WorkspacePlan; repositoryId: string; navigate: (url: string) => void }) {
  const [view, setView] = useState<"document" | "diff">("diff");
  const changes = useMemo(() => deliverableChanges(version.base, version.document), [version.base, version.document]);
  const diff = useMemo(() => lineDiff(version.base?.content ?? "", version.document?.content ?? ""), [version.base, version.document]);
  return <div className="flex min-w-0 flex-col gap-4"><div className="flex flex-col items-start gap-3"><WorkspaceOwner workspace={version.workspace} /><p className="text-xs text-muted-foreground">Workspace {version.workspace.state}. Observed {formatTime(version.workspace.observationAt)}{version.workspace.observationState ? ` (${version.workspace.observationState})` : ""}.</p><p className="text-xs text-muted-foreground">Last change {formatTime(version.change.modifiedAt)}.</p>
    <WorkspaceSessionLink workspace={version.workspace} button /><WorkspacePullRequests workspace={version.workspace} />
    {version.change.targetChanged && <Alert><AlertTitle>Tracked branch changed</AlertTitle><AlertDescription>The tracked branch also changed this document since the workspace base. The diff below shows this workspace’s own changes.</AlertDescription></Alert>}
  </div>
    <div className="flex flex-col gap-1 text-xs text-muted-foreground"><p>Base: {version.base?.status ?? "absent or unknown"}{version.base?.progress ? `, ${version.base.progress.done}/${version.base.progress.total} deliverables` : ""}</p><p>Workspace: {version.document?.status ?? (version.change.kind === "deleted" ? "document deleted" : "unknown")}{version.document?.progress ? `, ${version.document.progress.done}/${version.document.progress.total} deliverables` : ""}</p></div>
    {version.error && <Alert variant="destructive"><AlertDescription>{version.error}</AlertDescription></Alert>}
    {(version.label === "completing" || version.label === "removed") && <Alert><AlertDescription><VersionBrief version={version} /></AlertDescription></Alert>}
    {changes && changes.length > 0 && <section className="flex min-w-0 flex-col gap-2"><h3 className="font-semibold">Deliverable changes</h3><Table><TableHeader><TableRow><TableHead>ID</TableHead><TableHead>Change</TableHead><TableHead>Deliverable</TableHead></TableRow></TableHeader><TableBody>{changes.map(change => <TableRow key={change.id}><TableCell><strong>{change.id}</strong></TableCell><TableCell>{change.kind}{change.previousText !== undefined && change.kind !== "modified" ? ", text edited" : ""}</TableCell><TableCell className="whitespace-normal">{change.text}{change.previousText !== undefined && <p className="text-xs text-muted-foreground">Previously: <del>{change.previousText}</del></p>}</TableCell></TableRow>)}</TableBody></Table></section>}
    <nav aria-label="Workspace document view"><ToggleGroup type="single" variant="outline" value={view} onValueChange={value => { if (value) setView(value as "document" | "diff"); }} aria-label="Workspace document view" className="flex-wrap"><ToggleGroupItem value="diff">Diff against its base</ToggleGroupItem><ToggleGroupItem value="document">Workspace document</ToggleGroupItem></ToggleGroup></nav>
    {view === "document" ? version.document ? <TranslateDocument document={version.document} repositoryId={repositoryId} workspaceId={version.workspace.id} navigate={navigate} /> : <Alert><AlertDescription>The workspace deleted this document.</AlertDescription></Alert> : <>
      {(!version.base && version.label !== "new" && !version.error) && <Alert><AlertDescription>Base document unavailable.</AlertDescription></Alert>}
      {version.error ? null : <><p className="text-xs text-muted-foreground">Base {version.workspace.baseCommit?.slice(0, 12) ?? "unknown"} to worktree</p>{diff.abbreviated && <Alert><AlertDescription>This large diff is abbreviated. Open the document to read the current version.</AlertDescription></Alert>}<pre className="diff" aria-label="Workspace changes against its base">{diff.lines.map((line, index) => <span key={index} className="diff-line" data-kind={line.kind}><span className="diff-marker" aria-hidden="true">{line.kind === "added" ? "+" : line.kind === "removed" ? "−" : " "}</span>{line.text}{"\n"}</span>)}</pre></>}
    </>}
  </div>;
}
function repoName(repository: SourceRepository): string {
  try { return new URL(repository.repository).pathname.replace(/^\//, "").replace(/\.git$/, ""); } catch { return repository.repository; }
}
function canonicalRepositoryUrl(provisional: string, canonical: string) {
  if (provisional === canonical) return;
  const url = new URL(window.location.href);
  if (url.searchParams.get("repository") !== provisional) return;
  url.searchParams.set("repository", canonical);
  window.history.replaceState(null, "", url);
}

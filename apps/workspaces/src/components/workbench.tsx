"use client";
import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { appFetch } from "@hosty-sdk/app/browser-auth";
import { ArrowLeft, ArrowUpRight, FolderGit2, GitBranch, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { changeCount, repositoryName, fileApps, filterWorkspaces, isStale, safeLink, workspaceLink, type Filter } from "@/lib/model";
import type { Diff, Inventory, PullRequest, Workspace, Worktree } from "@/lib/types";

function useRead<T>(url: string, epoch: number) {
  const [state, setState] = useState<{ url: string; data?: T; error?: string }>({ url });
  useEffect(() => {
    const controller = new AbortController();
    let pending = false;
    async function load() {
      if (pending) return;
      pending = true;
      try {
        const response = await appFetch(url, { signal: controller.signal, cache: "no-store" });
        const body = await response.json();
        if (!response.ok) throw new Error(body.message ?? `Workspace read returned HTTP ${response.status}.`);
        if (!controller.signal.aborted) setState({ url, data: body });
      } catch (error) {
        // A revoked grant clears previously displayed source, including a visible diff.
        if (!controller.signal.aborted) setState({ url, error: error instanceof Error ? error.message : "Workspace read failed." });
      } finally { pending = false; }
    }
    void load();
    const timer = setInterval(() => { if (document.visibilityState === "visible") void load(); }, 20_000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [url, epoch]);
  return state.url === url ? state : { url };
}
function time(value?: string | null) { return value ? new Date(value).toLocaleString() : "Not observed"; }
function short(value?: string | null) { return value?.slice(0, 10) ?? "Unknown"; }
function navigate(url: string) { window.history.pushState(null, "", url); }
function Message({ children, error = false }: { children: React.ReactNode; error?: boolean }) {
  return <p role={error ? "alert" : "status"} className={`rounded-md border p-4 text-sm ${error ? "border-destructive/30 text-destructive" : "text-muted-foreground"}`}>{children}</p>;
}
export function WorkspacesWorkbench() {
  const query = useSearchParams();
  const selected = query.get("workspace");
  const [epoch, setEpoch] = useState(0);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<Filter>("active");
  const { data, error } = useRead<Inventory>("/api/workspaces", epoch);
  const items = filterWorkspaces(data?.workspaces ?? [], search, filter);
  const workspace = data?.workspaces.find(w => w.id === selected);
  return <main className="mx-auto max-w-[1680px] px-4 py-5 text-sm sm:px-6">
    <header className="hosty-shell-chrome mb-5 flex items-center gap-3"><FolderGit2 className="size-7" /><div><h1 className="text-xl font-semibold tracking-tight">Workspaces</h1><p className="text-muted-foreground">Sessions, repositories and the work in progress.</p></div></header>
    <div className="mb-4 flex flex-wrap items-center justify-between gap-3"><p className="text-muted-foreground">{data ? `${data.workspaces.length} workspaces · ${data.workspaces.reduce((n, w) => n + w.worktrees.length, 0)} worktrees` : "Workspace inventory"}</p><Button variant="outline" size="sm" onClick={() => setEpoch(n => n + 1)}><RefreshCw className="size-4" />Refresh view</Button></div>
    {error ? <Message error>{error}</Message> : !data ? <Message>Reading workspace inventory…</Message> : <div className="grid min-h-[65vh] gap-6 lg:grid-cols-[300px_minmax(0,1fr)]">
      <aside className={`min-w-0 space-y-3 ${selected ? "hidden lg:block" : ""}`} aria-label="Workspace inventory">
        <Input aria-label="Search workspaces" placeholder="Search repository or session…" value={search} onChange={e => setSearch(e.target.value)} />
        <select aria-label="Workspace filter" className="h-9 w-full rounded-md border bg-background px-3" value={filter} onChange={e => setFilter(e.target.value as Filter)}>
          <option value="active">Current workspaces</option><option value="all">All workspaces</option><option value="changed">With changes</option><option value="attention">Need attention</option><option value="released">Released history</option>
        </select>
        <ul className="divide-y rounded-lg border">{items.map(w => <li key={w.id}><button type="button" aria-current={selected === w.id ? "true" : undefined} onClick={() => navigate(workspaceLink(w.id))}
          className={`w-full min-w-0 space-y-2 p-3 text-left focus-visible:outline-2 focus-visible:outline-ring ${selected === w.id ? "bg-accent" : "hover:bg-muted/60"}`}>
          <div className="flex items-center justify-between gap-2"><span className="truncate font-medium">{w.owner.label || "External agent"}</span><Badge variant="outline">{w.state}</Badge></div>
          <p className="truncate text-xs text-muted-foreground" title={w.owner.reference}>{w.owner.reference}</p>
          <p className="truncate text-xs" title={w.worktrees.map(t => t.repository).join("\n")}>{w.worktrees[0] ? repositoryName(w.worktrees[0].repository) : "No repository"}{w.worktrees.length > 1 ? ` + ${w.worktrees.length - 1} more` : ""}</p>
          <p className="text-xs text-muted-foreground">{w.worktrees.length} worktrees · {w.worktrees.some(t => changeCount(t) === null) ? "Some changes unknown" : `${w.worktrees.reduce((n, t) => n + (changeCount(t) ?? 0), 0)} changed files`}</p>
        </button></li>)}</ul>
        {items.length === 0 && <Message>{data.workspaces.length ? "No workspaces match these filters." : "No authorized workspaces yet. A workspace appears here when a session starts source work."}</Message>}
      </aside>
      <section className="min-w-0" aria-label="Workspace details">{selected ? workspace ? <WorkspaceDetails key={workspace.id} workspace={workspace} selectedTree={query.get("worktree")} epoch={epoch} now={Date.parse(data.observedAt)} />
        : <Message>This workspace is unavailable or your source access has changed. <button className="underline" onClick={() => navigate("/")}>Return to the inventory</button>.</Message>
        : <div className="flex min-h-60 flex-col items-center justify-center gap-3 rounded-lg border border-dashed p-8 text-center"><FolderGit2 className="size-9 text-muted-foreground" /><h2 className="text-lg font-medium">Choose a workspace</h2><p className="max-w-sm text-muted-foreground">Inspect its repository worktrees, source changes and pull requests. Clean workspaces stay in this list.</p></div>}</section>
    </div>}
  </main>;
}
function WorkspaceDetails({ workspace: w, selectedTree, epoch, now }: { workspace: Workspace; selectedTree: string | null; epoch: number; now: number }) {
  const tree = selectedTree ? w.worktrees.find(t => t.id === selectedTree) : w.worktrees[0];
  const session = safeLink(w.owner.sessionUrl);
  return <div className="space-y-5">
    <Button className="lg:hidden" variant="ghost" size="sm" onClick={() => navigate("/")}><ArrowLeft className="size-4" />All workspaces</Button>
    <header className="flex flex-wrap items-start justify-between gap-4"><div className="min-w-0"><h2 className="text-xl font-semibold">{w.owner.label}</h2><p className="mt-1 break-all text-muted-foreground">{w.owner.kind === "external" ? "External work reference" : "Session"}: {w.owner.reference}</p><p className="mt-1 break-all font-mono text-xs text-muted-foreground">Workspace {w.id}</p></div>
      {session && <Button variant="outline" asChild><a href={session} target="_blank" rel="noreferrer">Open session<ArrowUpRight className="size-4" /></a></Button>}</header>
    {w.owner.sessionUnavailable && <Message>{w.owner.sessionUnavailable}</Message>}
    <div className="flex flex-wrap gap-2" role="group" aria-label="Repository worktrees">{w.worktrees.map(t => <Button key={t.id} variant={tree?.id === t.id ? "secondary" : "outline"} aria-pressed={tree?.id === t.id}
      title={t.repository} onClick={() => navigate(workspaceLink(w.id, t.id))}><GitBranch className="size-4" /><span className="max-w-56 truncate">{repositoryName(t.repository)}</span><span className="text-xs text-muted-foreground">{t.state}</span></Button>)}</div>
    {tree ? <TreeDetails key={tree.id} tree={tree} epoch={epoch} now={now} /> : <Message>The requested worktree is not in this workspace. Select a repository above.</Message>}
  </div>;
}
function TreeDetails({ tree, epoch, now }: { tree: Worktree; epoch: number; now: number }) {
  const { data: t, error } = useRead<Worktree>(`/api/workspaces/${tree.workspaceId}/worktrees/${tree.id}`, epoch);
  if (error) return <Message error>{error}</Message>;
  if (!t) return <Message>Reading this worktree…</Message>;
  const o = t.observation;
  return <div className="space-y-4">
    <div className="space-y-2 rounded-lg border p-4"><p className="break-all font-medium">{t.repository}</p><dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-5 gap-y-2 text-xs">
      <dt className="text-muted-foreground">Working branch</dt><dd className="break-all font-mono">{t.branch}</dd>
      <dt className="text-muted-foreground">Target branch</dt><dd className="break-all font-mono">{t.targetBranch}</dd>
      <dt className="text-muted-foreground">HEAD / original base</dt><dd className="break-all font-mono">{short(o?.head)} / {short(t.originalBase)}</dd>
      <dt className="text-muted-foreground">Integration base</dt><dd className="break-all font-mono">{short(t.integrationBase)}</dd>
      <dt className="text-muted-foreground">Path on Core host</dt><dd className="break-all font-mono">{t.path}</dd>
      <dt className="text-muted-foreground">Observed</dt><dd>{time(o?.at)}{isStale(o?.at, now) ? " · stale or unknown" : ""}</dd>
    </dl></div>
    {t.state !== "active" && <Message>Worktree is {t.state}. Any recorded observation is historical; current source changes are unknown.</Message>}
    {o?.error && <Message error>{o.error}</Message>}{t.detailError && <Message error>{t.detailError}</Message>}
    {o?.conflict && <Message error>Merge conflicts need resolution in this worktree.</Message>}
    <Tabs defaultValue="changes"><TabsList className="max-w-full overflow-x-auto"><TabsTrigger value="changes">Changes</TabsTrigger><TabsTrigger value="prs">Pull requests ({t.pullRequests.length})</TabsTrigger><TabsTrigger value="apps">Applications</TabsTrigger><TabsTrigger value="activity">Activity</TabsTrigger></TabsList>
      <TabsContent value="changes" className="mt-4 space-y-4"><p className="text-xs text-muted-foreground">Current-target divergence: {o?.ahead ?? "?"} ahead / {o?.behind ?? "?"} behind {t.targetBranch} ({short(o?.targetHead)}). Uses the last fetched target; refreshing this view does not fetch Git.</p>
        {t.state === "active" && o?.state === "ok" && !t.detailError ? <Changes tree={t} epoch={epoch} /> : <Message>Changes are unavailable for this worktree.</Message>}
        <details className="rounded-lg border p-4"><summary className="cursor-pointer font-medium">Commits since original base ({t.commits.length}{t.commitsTruncated ? "+" : ""})</summary><ul className="mt-3 divide-y">{t.commits.map(c => <li key={c.sha} className="py-3"><p className="break-words">{c.subject}</p><p className="mt-1 text-xs text-muted-foreground"><span className="font-mono">{short(c.sha)}</span> · {c.author} · {time(c.at)}</p></li>)}</ul>{!t.commits.length && <p className="mt-3 text-muted-foreground">{t.state === "active" && o?.state === "ok" && !t.detailError ? "No commits since preparation." : "Commit history is unavailable."}</p>}{t.commitsTruncated && <p>Showing the latest 100 commits.</p>}</details>
      </TabsContent>
      <TabsContent value="prs" className="mt-4 space-y-3">{t.pullRequests.length ? t.pullRequests.map(p => <Pr key={p.url} pr={p} now={now} head={o?.head} />) : <Message>No pull request references recorded for this worktree.</Message>}</TabsContent>
      <TabsContent value="apps" className="mt-4 space-y-3"><p className="text-muted-foreground">Bindings describe app directories. Shared files can affect other applications too.</p>{t.apps.map(a => <div key={a.appId} className="rounded-md border p-4"><p className="font-medium">{a.name} {!a.installed && <Badge variant="outline">Installation unavailable</Badge>}</p><p className="mt-1 font-mono text-xs">{a.appId} · {a.subpath || "Repository root"}</p></div>)}<p className="text-xs text-muted-foreground">A binding does not mean the application runs from this worktree.</p></TabsContent>
      <TabsContent value="activity" className="mt-4 space-y-5"><section><h3 className="font-medium">Known source consumers</h3><ul className="mt-2 space-y-1">{t.consumers.map(c => <li key={c.kind + c.reference}>{c.reference} · {c.kind === "local-service" ? "Running local service" : "Selected source override"}</li>)}</ul>{!t.consumers.length && <p className="mt-2 text-muted-foreground">No registered local service or source selection found.</p>}<p className="mt-2 text-xs text-muted-foreground">This does not inventory all native processes or Docker mounts.</p></section>
        <section><h3 className="font-medium">Activity leases ({t.leases.length})</h3><ul className="mt-2 space-y-1 font-mono text-xs">{t.leases.map(l => <li className="break-all" key={l}>{l}</li>)}</ul><p className="mt-2 text-xs text-muted-foreground">A retained lease does not prove that an agent is running. Local agents are not isolated by this viewer.</p></section>
        <section><h3 className="font-medium">Recorded Core operations</h3><p className="mt-1 text-xs text-muted-foreground">Pending or unknown outcomes need recovery with the original request ID in the owning session.</p><ul className="mt-3 divide-y rounded-md border">{t.operations.map(op => <li key={op.id} className="space-y-1 p-3"><p>{op.kind} <Badge variant="outline">{op.state}</Badge></p><p className="break-all font-mono text-xs text-muted-foreground">{op.id}</p>{op.error && <p className="text-destructive">{op.error}</p>}</li>)}</ul>{!t.operations.length && <p className="mt-2 text-muted-foreground">No operations recorded.</p>}</section>
      </TabsContent>
    </Tabs>
  </div>;
}
function Changes({ tree, epoch }: { tree: Worktree; epoch: number }) {
  const [view, setView] = useState("session");
  const [path, setPath] = useState<string | null>(null);
  const files = view === "local" ? tree.observation?.local?.files ?? [] : tree.sessionChanges;
  const selected = files.find(f => f.path === path);
  return <div className="space-y-3"><div className="flex flex-wrap items-center justify-between gap-2"><select aria-label="Change comparison" className="h-9 max-w-full rounded-md border bg-background px-2" value={view} onChange={e => { setView(e.target.value); setPath(null); }}><option value="session">Original base → current files</option><option value="local">Local uncommitted changes</option></select><span className="text-xs text-muted-foreground">{files.length} files</span></div>
    {!files.length ? <Message>No changes in this comparison.</Message> : <div className="overflow-hidden rounded-lg border"><ul className="max-h-64 divide-y overflow-y-auto" aria-label="Changed files">{files.map(f => { const matches = fileApps(f.path, tree.apps); return <li key={f.path}><button className={`flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring ${selected?.path === f.path ? "bg-accent" : ""}`} aria-pressed={selected?.path === f.path} onClick={() => setPath(f.path)}><span className="w-6 shrink-0 font-mono text-xs text-muted-foreground">{f.status}</span><span className="min-w-0 flex-1 break-all font-mono text-xs">{f.path}</span><span className="hidden max-w-36 truncate text-xs text-muted-foreground sm:block" title={matches.map(a => a.name).join(", ")}>{matches.length > 1 ? "Shared binding" : matches[0]?.name ?? "Shared / unmapped"}</span></button></li>; })}</ul></div>}
    {selected ? <DiffView key={tree.id + view + selected.path} tree={tree} path={selected.path} view={view} epoch={epoch} /> : files.length > 0 && <p className="text-xs text-muted-foreground">Select a file to read its diff.</p>}
  </div>;
}
function DiffView({ tree, path, view, epoch }: { tree: Worktree; path: string; view: string; epoch: number }) {
  const { data, error } = useRead<Diff>(`/api/workspaces/${tree.workspaceId}/worktrees/${tree.id}/diff?${new URLSearchParams({ path, view })}`, epoch);
  if (error) return <Message error>{error}</Message>;
  if (!data) return <Message>Reading file diff…</Message>;
  if (data.binary || data.image) return <Message>Binary or image change. Inspect this file in your source editor.</Message>;
  return <section aria-label={`Diff for ${path}`} className="overflow-hidden rounded-lg border"><h4 className="break-all border-b bg-muted/40 px-4 py-2 font-mono text-xs">{path}</h4>{data.truncated && <Message>Diff exceeds the preview limit. Inspect the full change in your source editor.</Message>}<pre className="max-h-[65vh] overflow-auto py-3 text-xs leading-6">{data.combined ? data.combined.split("\n").map((line, i) => <span key={i} className="diff-line" data-kind={line.startsWith("+") && !line.startsWith("+++") ? "added" : line.startsWith("-") && !line.startsWith("---") ? "removed" : "context"}>{line || " "}</span>) : <span className="px-4 text-muted-foreground">No text changes.</span>}</pre></section>;
}
function Pr({ pr, now, head }: { pr: PullRequest; now: number; head?: string | null }) {
  const o = pr.observation;
  return <section className="space-y-3 rounded-lg border p-4"><a href={safeLink(pr.url, true)} target="_blank" rel="noreferrer" className="inline-flex max-w-full items-center gap-2 break-all font-medium underline underline-offset-4">{pr.url}<ArrowUpRight className="size-4 shrink-0" /></a>
    <div className="flex flex-wrap gap-2"><Badge variant="outline">{o ? o.draft ? "Draft" : o.state : "Provider state unknown"}</Badge><Badge variant="outline">{isStale(o?.at, now) ? "Stale / unobserved" : "Recently observed"}</Badge></div>
    {pr.unavailable && <p className="text-muted-foreground">{pr.unavailable}</p>}{o?.error && <p className="text-destructive">{o.error}</p>}
    {pr.publishedHead && <p className="text-xs text-muted-foreground">Published HEAD {short(pr.publishedHead)}{head !== pr.publishedHead ? " · differs from this worktree" : ""}</p>}
    {o && <><p className="text-xs text-muted-foreground">Observed {time(o.at)} · Review: {o.reviewDecision || "unknown"} · {o.unresolvedThreads} unresolved threads</p><ul className="divide-y">{o.checks?.map((c, i) => <li key={c.name + i} className="flex justify-between gap-4 py-2"><span>{c.name}</span><span>{c.state}</span></li>)}</ul>{!o.checks?.length && <p className="text-muted-foreground">No check results recorded.</p>}</>}
  </section>;
}

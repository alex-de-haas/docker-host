"use client";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import dynamic from "next/dynamic";
import { useHostyUi } from "@hosty-sdk/app/ui/react";
import { HostyLoader } from "../../../../../shared/web/hosty-states";
import { ArrowLeft, ArrowUpRight, GitPullRequest, RefreshCw, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { PullRequestMarkdown } from "@/components/pull-request-markdown";
import { cn } from "@/lib/utils";
import { checkSummary, prKey, prPath, prRequest, PrError, type PrChecks, type PrDetail, type PrDiff, type PrPage,
  type PrReceipt, type PrRef, type PrRepositories, type PrReview } from "@/lib/pull-requests-api";
import { PullRequestSummary } from "./pull-request-summary";
import { PullRequestStateIcon } from "./pull-request-status";
import { PullRequestCheckSummary } from "./pull-request-check-summary";
import { PullRequestActions } from "./pull-request-actions";
import { compactCi } from "@/lib/pull-requests-api";
import { subscribePullRequests } from "@/lib/pull-requests-events";

const DiffView = dynamic(() => import("./workspace-diff-view"), { ssr: false, loading: () => <p className="p-4 text-sm">Loading diff…</p> });
type Filters = { search: string; repository: string; app: string; author: string; bot: string; draft: string; ci: string; review: string };
const emptyFilters: Filters = { search: "", repository: "", app: "", author: "", bot: "", draft: "", ci: "", review: "" };
const keys = Object.keys(emptyFilters) as (keyof Filters)[];
const selectClass = "h-8 min-w-0 rounded-md border bg-background px-2 text-xs";
function routeSelection(): PrRef | null {
  const query = new URLSearchParams(window.location.search), repositoryId = query.get("repo"), number = Number(query.get("pr"));
  return repositoryId && /^[a-f0-9]{64}$/.test(repositoryId) && Number.isSafeInteger(number) && number > 0 ? { repositoryId, number } : null;
}
function ProviderLink({ href, children }: { href?: string | null; children: React.ReactNode }) {
  const safe = href && /^https:\/\//.test(href) ? href : undefined;
  return safe ? <a className="inline-flex items-center gap-1 underline underline-offset-2" href={safe} target="_blank" rel="noopener noreferrer">{children}<ArrowUpRight className="size-3" /></a> : <>{children}</>;
}
function Receipt({ receipt }: { receipt: PrReceipt }) {
  return <p className="text-xs text-muted-foreground" role="status">
    {receipt.freshness !== "fresh" && <span className="capitalize">{receipt.freshness} · </span>}
    {receipt.lastSuccessAt ? <>Observed <time dateTime={receipt.lastSuccessAt}>{new Date(receipt.lastSuccessAt).toLocaleTimeString()}</time></> : "Waiting for the first observation"}
    {receipt.completeness !== "complete" && ` · ${receipt.completeness} coverage`}
    {receipt.nextAttemptAt && ` · next attempt ${new Date(receipt.nextAttemptAt).toLocaleTimeString()}`}
    {receipt.reason && ` · ${receipt.reason}`}
  </p>;
}

const wideSnapshot = () => typeof window.matchMedia === "function" && window.matchMedia("(min-width: 900px)").matches;
const subscribeWide = (changed: () => void) => {
  if (typeof window.matchMedia !== "function") return () => {};
  const media = window.matchMedia("(min-width: 900px)"); media.addEventListener("change", changed);
  return () => media.removeEventListener("change", changed);
};
export function PullRequests({ compact = false }: { compact?: boolean }) {
  const ui = useHostyUi();
  const wide = useSyncExternalStore(subscribeWide, wideSnapshot, () => false);
  const [inventory, setInventory] = useState<(PrRepositories & { storageScope?: string }) | null>(null);
  const [page, setPage] = useState<PrPage | null>(null), [cursor, setCursor] = useState<string | null>(null);
  const [filters, setFilters] = useState<Filters>(emptyFilters), [applied, setApplied] = useState<Filters>(emptyFilters);
  const [selected, setSelected] = useState<PrRef | null>(null), [error, setError] = useState("");
  const [status, setStatus] = useState(""), [refreshing, setRefreshing] = useState(false), [revision, setRevision] = useState(0);
  const [fallback, setFallback] = useState<string | null>(null);
  const initialized = useRef(false), request = useRef(0), alive = useRef(true);
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    alive.current = true;
    const selection = () => setSelected(routeSelection()); selection();
    window.addEventListener("popstate", selection);
    return () => { alive.current = false; window.removeEventListener("popstate", selection); };
  }, []);
  useEffect(() => {
    const timer = setTimeout(() => { setApplied(filters); setCursor(null); }, 250);
    return () => clearTimeout(timer);
  }, [filters]);
  const query = useMemo(() => {
    const params = new URLSearchParams({ limit: compact ? "30" : "50" });
    for (const key of keys) if (applied[key]) params.set(key, applied[key]);
    if (cursor) params.set("cursor", cursor);
    return `?${params}`;
  }, [applied, compact, cursor]);
  const load = useCallback(async () => {
    const generation = ++request.current;
    try {
      const [repos, result] = await Promise.all([
        prRequest<PrRepositories & { storageScope?: string }>("/repositories"), prRequest<PrPage>(query),
      ]);
      if (!alive.current || generation !== request.current) return;
      setInventory(repos); setPage(result); setError(""); setRevision(n => n + 1);
      if (!initialized.current) {
        initialized.current = true;
        let stored: Partial<Filters> = {};
        try { if (repos.storageScope) stored = JSON.parse(localStorage.getItem(`hosty:pr-filters:${repos.storageScope}`) ?? "{}"); } catch { /* Display preferences are optional. */ }
        const url = new URLSearchParams(window.location.search), next = { ...emptyFilters };
        for (const key of keys) next[key] = url.has(key) ? url.get(key)! : typeof stored[key] === "string" ? stored[key]! : "";
        setFilters(next); setApplied(next);
      }
    } catch (e) {
      if (!alive.current || generation !== request.current) return;
      if (e instanceof PrError && e.code === "pr_cursor_expired") { setCursor(null); return; }
      if (e instanceof PrError && [401, 403].includes(e.status ?? 0)) { setPage(null); setInventory(null); setSelected(null); }
      setError(e instanceof Error ? e.message : "Pull requests are unavailable.");
    }
  }, [query]);
  // Snapshot loading only updates state after asynchronous authorized requests.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!inventory?.storageScope || !initialized.current) return;
    try { localStorage.setItem(`hosty:pr-filters:${inventory.storageScope}`, JSON.stringify(filters)); } catch { /* Keep the live filter. */ }
  }, [filters, inventory?.storageScope]);
  const refs = useMemo(() => {
    const values = new Map((compact || !selected || wide ? page?.items ?? [] : []).map(pr => [prKey(pr), { repositoryId: pr.repositoryId, number: pr.number }]));
    if (selected && !compact) values.set(prKey(selected), selected);
    return [...values.values()].sort((a, b) => prKey(a).localeCompare(prKey(b)));
  }, [page, selected, compact, wide]);
  const scopeKey = JSON.stringify(refs);
  useEffect(() => {
    if (!inventory?.storageScope) return;
    return subscribePullRequests(inventory.storageScope, { scope: { allInstalled: true, pullRequests: JSON.parse(scopeKey) }, sync: load,
      failed: message => { setError(message); if (message.includes("access changed")) { setPage(null); setInventory(null); setSelected(null); } } });
  }, [inventory?.storageScope, scopeKey, load]);
  useEffect(() => {
    if (!inventory) return;
    const route = new URL(window.location.href);
    ui.reportSurfaceState({ route: route.pathname + route.search, state: "ready" });
  }, [inventory, selected, ui]);

  async function choose(pr: PrRef) {
    const search = `?repo=${encodeURIComponent(pr.repositoryId)}&pr=${pr.number}`;
    if (compact) {
      const entry = ui.getNavigation().entries.find(e => e.route === "/pull-requests");
      try {
        if (entry && (await ui.navigate(entry.key, { placement: "main", search, requestId: crypto.randomUUID() })).status === "accepted") { setSelected(pr); return; }
      } catch { /* The explicit separate-window link preserves this panel. */ }
      setFallback(`/pull-requests${search}`); return;
    }
    const url = new URL(window.location.href); url.searchParams.set("repo", pr.repositoryId); url.searchParams.set("pr", String(pr.number));
    window.history.pushState({}, "", url); setSelected(pr);
  }
  function back() {
    const url = new URL(window.location.href); url.searchParams.delete("repo"); url.searchParams.delete("pr");
    window.history.pushState({}, "", url); setSelected(null);
  }
  async function refresh() {
    setRefreshing(true); setStatus("");
    try {
      const result = await prRequest<{ state: string; nextAttemptAt?: string }>("/refresh", {
        requestId: crypto.randomUUID(), repositories: inventory?.repositories.map(r => r.id) ?? [], pullRequests: refs,
      });
      setStatus(result.state === "deferred" ? `Refresh deferred${result.nextAttemptAt ? ` until ${new Date(result.nextAttemptAt).toLocaleTimeString()}` : ""}.` : "Refresh queued.");
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : "Refresh failed."); }
    finally { setRefreshing(false); }
  }
  const repositories = inventory?.repositories ?? [];
  const apps = [...new Map(repositories.flatMap(r => r.apps).map(a => [a.id, a])).values()];
  const change = (key: keyof Filters, value: string) => setFilters(current => ({ ...current, [key]: value }));
  return <main className="flex h-dvh min-h-0 flex-col bg-background">
    <header className={cn("flex shrink-0 items-center justify-between gap-3 border-b", compact ? "px-3 py-2" : "px-5 py-4")}>
      <div className="flex items-center gap-2"><GitPullRequest className="size-4 text-muted-foreground" /><h1 className={compact ? "text-sm font-semibold" : "text-lg font-semibold"}>Pull requests</h1>
        {page && <Badge variant="secondary">{page.total ?? `${page.loaded}+`}</Badge>}</div>
      <Button variant="ghost" size="icon-sm" aria-label="Refresh pull requests" disabled={refreshing} onClick={() => void refresh()}><RefreshCw className={cn("size-4", refreshing && "animate-spin")} /></Button>
    </header>
    <div className="flex min-h-0 flex-1">
      <section className={cn("flex min-h-0 min-w-0 flex-col", compact ? "w-full" : selected ? "hidden w-full min-[900px]:flex min-[900px]:w-[360px] min-[900px]:shrink-0 min-[900px]:border-r" : "w-full min-[900px]:w-[360px] min-[900px]:shrink-0 min-[900px]:border-r")} aria-label="Pull request list">
        <div className="space-y-2 border-b p-3">
          <label className="relative block"><Search className="absolute top-2.5 left-2 size-3.5 text-muted-foreground" /><span className="sr-only">Search pull requests</span><Input className="h-8 pl-7 text-xs" value={filters.search} placeholder="Search title or #number" onChange={e => change("search", e.target.value)} /></label>
          <div className="grid grid-cols-2 gap-2">
            <select className={selectClass} aria-label="Repository" value={filters.repository} onChange={e => change("repository", e.target.value)}><option value="">All repositories</option>{repositories.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}</select>
            <select className={selectClass} aria-label="CI status" value={filters.ci} onChange={e => change("ci", e.target.value)}><option value="">Any CI status</option>{["pending", "failed", "passed", "completed", "cancelled", "unknown"].map(s => <option key={s} value={s}>{s}</option>)}</select>
          </div>
          <details><summary className="cursor-pointer text-xs text-muted-foreground">More filters</summary><div className="mt-2 grid grid-cols-2 gap-2">
            <select className={selectClass} aria-label="Application" value={filters.app} onChange={e => change("app", e.target.value)}><option value="">All applications</option>{apps.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select>
            <Input className="h-8 text-xs" aria-label="Author" placeholder="Author login" value={filters.author} onChange={e => change("author", e.target.value)} />
            <select className={selectClass} aria-label="Author type" value={filters.bot} onChange={e => change("bot", e.target.value)}><option value="">All authors</option><option value="true">Bots</option><option value="false">People</option></select>
            <select className={selectClass} aria-label="Draft state" value={filters.draft} onChange={e => change("draft", e.target.value)}><option value="">Open and draft</option><option value="true">Drafts</option><option value="false">Ready for review</option></select>
            <select className={selectClass} aria-label="Review state" value={filters.review} onChange={e => change("review", e.target.value)}><option value="">Any review state</option><option value="APPROVED">Approved</option><option value="CHANGES_REQUESTED">Changes requested</option><option value="REVIEW_REQUIRED">Review required</option></select>
            <Button size="sm" variant="ghost" onClick={() => setFilters(emptyFilters)}>Clear filters</Button>
          </div></details>
        </div>
        <div ref={list} className="min-h-0 flex-1 overflow-auto">
          {error && <p role="alert" className="border-b p-3 text-xs text-destructive">{error}</p>}
          {status && <p role="status" className="px-3 py-2 text-xs text-muted-foreground">{status}</p>}
          {fallback && <p className="border-b p-3 text-xs"><a className="underline" href={fallback} target="_blank" rel="noopener noreferrer">Open PR details in a separate window ↗</a></p>}
          {!page && !error && <p className="p-5 text-sm text-muted-foreground">Loading pull requests…</p>}
          {page?.items.length === 0 && <p className="p-5 text-sm text-muted-foreground">{page.receipt.completeness === "complete" ? "No open pull requests match these filters." : "No matching pull requests loaded yet. Repository coverage may be incomplete."}</p>}
          <div role="list" aria-label="Active pull requests">{page?.items.map(pr => {
            const repo = repositories.find(r => r.id === pr.repositoryId), ci = compactCi(pr);
            return <div key={prKey(pr)} role="listitem"><button type="button" aria-current={selected && prKey(selected) === prKey(pr) ? "true" : undefined}
              className={cn("flex w-full min-w-0 items-center gap-2 border-b px-3 py-3 text-left outline-none hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring", selected && prKey(selected) === prKey(pr) && "bg-muted")}
              onClick={() => void choose(pr)} onKeyDown={e => { if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); const buttons = [...(list.current?.querySelectorAll<HTMLButtonElement>("[role=listitem] button") ?? [])]; const at = buttons.indexOf(e.currentTarget); buttons[at + (e.key === "ArrowDown" ? 1 : -1)]?.focus(); } }}>
              <PullRequestSummary icon={<PullRequestStateIcon state={pr.state} draft={pr.draft} ci={ci.label} ciColor={ci.color} stale={ci.stale} />}
                title={pr.title} number={pr.number} repository={repo?.name ?? "Repository"} identity={pr.state === "merged" ? "Merged" : pr.state === "closed" ? "Closed" : pr.author || "Unknown author"} ci={ci.label} ciColor={ci.color}
                extra={<>{pr.draft && <span> · Draft</span>}<span className="sr-only"> · {checkSummary(pr.checks)}</span></>} />
            </button></div>;
          })}</div>
          {page && <div className="space-y-2 p-3"><Receipt receipt={page.receipt} /><div className="flex gap-2">{cursor && <Button size="sm" variant="outline" onClick={() => setCursor(null)}>First page</Button>}{page.cursor && <Button size="sm" variant="outline" onClick={() => setCursor(page.cursor!)}>Next page</Button>}</div></div>}
          {!!inventory?.coverage.length && <details className="border-t p-3"><summary className="cursor-pointer text-xs text-muted-foreground">Repository coverage · {inventory.coverage.length} notices</summary><ul className="mt-2 space-y-3">{inventory.coverage.map((c, i) => <li key={i} className="text-xs"><p className="font-medium">{c.apps.map(a => a.name).join(", ")}</p><p className="text-muted-foreground">{c.message}</p></li>)}</ul></details>}
        </div>
      </section>
      {!compact && <section className={cn("min-h-0 min-w-0 flex-1 overflow-auto", !selected && "hidden min-[900px]:block")} aria-label="Pull request details">
        {selected ? <PrDetails key={prKey(selected)} selected={selected} revision={revision} onBack={back} onChanged={() => void load()} /> : <div className="flex h-full min-h-64 flex-col items-center justify-center gap-3 p-8 text-center text-muted-foreground"><GitPullRequest className="size-8" /><p>Select a pull request to inspect its description, checks and changes.</p></div>}
      </section>}
    </div>
  </main>;
}

function PrDetails({ selected, revision, onBack, onChanged }: { selected: PrRef; revision: number; onBack: () => void; onChanged: () => void }) {
  const [detail, setDetail] = useState<PrDetail | null>(null), [error, setError] = useState("");
  const [tab, setTab] = useState("overview"), [checks, setChecks] = useState<PrChecks | null>(null), [review, setReview] = useState<PrReview | null>(null);
  const [diff, setDiff] = useState<PrDiff | null>(null), [file, setFile] = useState(0), [loading, setLoading] = useState(false);
  const [more, setMore] = useState(false);
  const [sectionRevision, setSectionRevision] = useState("");
  const requestGeneration = useRef(0);
  const pages = useRef({ head: "", checks: 1, review: 1 });
  useEffect(() => {
    const abort = new AbortController();
    void prRequest<PrDetail>(prPath(selected), undefined, abort.signal).then(value => { if (!abort.signal.aborted) { setDetail(value); setError(""); } })
      .catch(e => { if (!abort.signal.aborted) { setError(e.message); if (e instanceof PrError && [401, 403, 404].includes(e.status ?? 0)) setDetail(null); } });
    return () => abort.abort();
  }, [selected, revision]);
  const pr = detail?.pullRequest;
  const head = pr?.head, basis = pr?.base;
  // An exact-revision diff is immutable; CI/review notifications do not invalidate it.
  const mutableRevision = tab === "changes" ? 0 : revision;
  useEffect(() => {
    if (!head || !basis || tab === "overview") return;
    const abort = new AbortController();
    const path = prPath(selected);
    const generation = ++requestGeneration.current;
    if (pages.current.head !== head) pages.current = { head, checks: 1, review: 1 };
    const accept = <T,>(setter: (value: T) => void) => (value: T) => {
      if (!abort.signal.aborted && generation === requestGeneration.current) { setter(value); setSectionRevision(`${head}:${basis}:${tab}`); }
    };
    // Revalidate the pages the reader expanded, retaining their extent across live updates.
    async function checksSnapshot() {
      let value = await prRequest<PrChecks>(path + "/checks", undefined, abort.signal);
      for (let i = 1; i < pages.current.checks && value.cursor; i++) {
        const next = await prRequest<PrChecks>(`${path}/checks?cursor=${encodeURIComponent(value.cursor)}`, undefined, abort.signal);
        value = { ...next, items: [...value.items, ...next.items] };
      }
      accept(setChecks)(value);
    }
    async function reviewSnapshot() {
      let value = await prRequest<PrReview>(path + "/review", undefined, abort.signal);
      for (let i = 1; i < pages.current.review && value.cursor; i++) {
        const next = await prRequest<PrReview>(`${path}/review?cursor=${encodeURIComponent(value.cursor)}`, undefined, abort.signal);
        value = { ...next, items: [...value.items, ...next.items] };
      }
      accept(setReview)(value);
    }
    const load = tab === "checks" ? checksSnapshot() : tab === "review" ? reviewSnapshot()
      : prRequest<PrDiff>(`${path}/diff?head=${encodeURIComponent(head)}&base=${encodeURIComponent(basis)}`, undefined, abort.signal).then(accept(v => { setDiff(v); setFile(index => Math.min(index, Math.max(0, v.files.length - 1))); }));
    void load.catch(e => { if (!abort.signal.aborted) { setError(e.message); setChecks(null); setReview(null); setDiff(null); } }).finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
  }, [selected, tab, head, basis, mutableRevision]); // Checks and review still revalidate without a new head.
  const sectionCurrent = sectionRevision === `${head}:${basis}:${tab}`;
  async function next() {
    const generation = requestGeneration.current;
    setMore(true);
    try {
      if (tab === "checks" && checks?.cursor) {
        const result = await prRequest<PrChecks>(`${prPath(selected)}/checks?cursor=${encodeURIComponent(checks.cursor)}`);
        if (generation === requestGeneration.current) { pages.current.checks++; setChecks({ ...result, items: [...checks.items, ...result.items] }); }
      } else if (tab === "review" && review?.cursor) {
        const result = await prRequest<PrReview>(`${prPath(selected)}/review?cursor=${encodeURIComponent(review.cursor)}`);
        if (generation === requestGeneration.current) { pages.current.review++; setReview({ ...result, items: [...review.items, ...result.items] }); }
      }
    } catch (e) { setError(e instanceof Error ? e.message : "More details are unavailable."); }
    finally { setMore(false); }
  }
  if (!pr) return <article className="relative flex h-full min-h-64 items-center justify-center p-5">
    <Button variant="ghost" size="sm" className="absolute top-5 left-5 min-[900px]:hidden" onClick={onBack}><ArrowLeft />All pull requests</Button>
    {error ? <p role="alert" className="text-sm text-destructive">{error}</p>
      : <div role="status"><HostyLoader className="size-10" label="Loading PR details" /></div>}
  </article>;
  const chosen = diff?.files[file];
  return <article className="flex min-h-full flex-col">
    <header className="space-y-3 border-b p-5">
      <Button variant="ghost" size="sm" className="min-[900px]:hidden" onClick={onBack}><ArrowLeft />All pull requests</Button>
      <div className="flex flex-wrap items-center gap-2"><Badge variant="outline">{pr.draft ? "Draft" : pr.state}</Badge><span className="text-sm text-muted-foreground">#{pr.number} · {pr.author}{pr.bot && " · Bot"}</span><span className="ml-auto text-xs"><ProviderLink href={pr.url}>GitHub</ProviderLink></span></div>
        <h2 className="text-xl font-semibold leading-snug">{pr.title}</h2><p className="break-all font-mono text-xs text-muted-foreground">{pr.headBranch} → {pr.baseBranch} · {pr.head.slice(0, 12)}</p><Receipt receipt={pr.receipt} /><PullRequestActions pr={pr} onChanged={onChanged} />
    </header>
    <nav className="flex gap-1 border-b px-4 py-2" aria-label="PR detail sections">{["overview", "checks", "review", "changes"].map(t => <Button key={t} size="sm" variant={tab === t ? "secondary" : "ghost"} aria-current={tab === t ? "page" : undefined} onClick={() => { if (t !== tab) { setTab(t); setLoading(t !== "overview"); setError(""); } }} className="capitalize">{t}</Button>)}</nav>
    {error && <p role="alert" className="p-5 text-sm text-destructive">{error}</p>}
    {(loading || pr && tab !== "overview" && !sectionCurrent && !error) && <p className="p-5 text-sm text-muted-foreground" role="status">Refreshing details…</p>}
    {tab === "overview" && detail && <div className="space-y-5 p-5"><Button variant="ghost" className="h-auto w-full max-w-xl justify-start p-0 hover:bg-transparent" aria-label="Show CI checks" onClick={() => { setTab("checks"); setLoading(true); setError(""); }}><PullRequestCheckSummary checks={detail.pullRequest.checks} stale={detail.pullRequest.receipt.freshness !== "fresh"} /></Button><dl className="grid grid-cols-2 gap-4 text-sm"><div><dt className="text-xs text-muted-foreground">Review</dt><dd>{detail.pullRequest.reviewDecision?.replaceAll("_", " ").toLowerCase() || "Unknown"}</dd></div><div><dt className="text-xs text-muted-foreground">Merge status</dt><dd>{detail.pullRequest.mergeState?.toLowerCase() || "Unknown"}</dd></div><div><dt className="text-xs text-muted-foreground">Discussion comments</dt><dd>{detail.pullRequest.commentCount ?? "Unknown"}</dd></div></dl>
      <div className="border-t pt-5"><h3 className="mb-3 text-sm font-semibold">Description</h3>{detail.description ? <PullRequestMarkdown text={detail.description} /> : <p className="text-sm text-muted-foreground">No description provided.</p>}{detail.descriptionTruncated && <p className="mt-3 text-xs text-muted-foreground">Description truncated. <ProviderLink href={detail.pullRequest.url}>Read the complete description</ProviderLink></p>}</div>
      {detail.links.map(link => <p key={`${link.kind}:${link.id}`} className="text-xs">{link.kind === "workspace" ? <a className="underline" href={`/development?workspace=${encodeURIComponent(link.id)}`}>{link.label}</a> : link.label}</p>)}
    </div>}
    {tab === "checks" && sectionCurrent && checks && <div className="space-y-3 p-5"><p className="text-sm">{checkSummary(checks)}</p><ul className="divide-y">{checks.items.map(c => <li key={c.id} className="flex items-start justify-between gap-3 py-3 text-sm"><ProviderLink href={c.url}>{c.name}</ProviderLink><Badge variant="outline">{c.state}</Badge></li>)}</ul>{checks.cursor && <Button variant="outline" disabled={more} onClick={() => void next()}>Load more checks</Button>}</div>}
    {tab === "review" && sectionCurrent && review && <div className="space-y-4 p-5"><Receipt receipt={review.receipt} /><p className="text-xs text-muted-foreground">{review.items.length} of {review.total ?? "unknown"} review threads. Each preview shows the first comment; replies open on GitHub.</p>{review.items.map(t => <section key={t.id} className="space-y-3 rounded-lg border p-4"><div className="flex items-center justify-between gap-3 text-xs"><ProviderLink href={t.url}>{t.author || "Review thread"}</ProviderLink><Badge variant="outline">{t.state}</Badge></div>{t.body && <PullRequestMarkdown text={t.body} />}</section>)}{review.cursor && <Button variant="outline" disabled={more} onClick={() => void next()}>Load more threads</Button>}</div>}
    {tab === "changes" && sectionCurrent && diff && <div><div className="space-y-2 border-b p-4"><Receipt receipt={diff.receipt} /><p className="break-all font-mono text-xs text-muted-foreground">{diff.mergeBase.slice(0, 12)}…{diff.head.slice(0, 12)}</p><select aria-label="Changed file" className={cn(selectClass, "w-full")} value={file} onChange={e => setFile(Number(e.target.value))}>{diff.files.map((f, i) => <option key={f.path} value={i}>{f.path} (+{f.additions} −{f.deletions})</option>)}</select></div>
      {chosen?.patch ? <DiffView key={`${diff.head}:${chosen.path}`} diff={{ path: chosen.path, head: diff.head, combined: chosen.patch, binary: false, truncated: false, contentKind: "patch" }} layout="unified" wrap /> : <p className="p-5 text-sm text-muted-foreground">{chosen ? "This file has no complete patch preview. Open the PR on GitHub to inspect it." : "No changed files reported."}</p>}
    </div>}
  </article>;
}

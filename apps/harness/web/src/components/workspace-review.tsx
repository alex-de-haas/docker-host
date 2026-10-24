"use client";
import { useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { ArrowLeft, ChevronLeft, ChevronRight, Check, ExternalLink, FileDiff, MessageSquare } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { ReviewThreadCard, type ReviewThreadActions } from "./review-thread";
import { developmentRequest, repositoryName, changeTotals, type Worktree } from "@/lib/development-api";
import { readReview, readReviewDiff, reviewFiles, fileThreads, reviewReference, type ReviewChoice, type ReviewInventory, type ReviewDiff } from "@/lib/workspace-review-api";
import { ReviewCommentComposer } from "./review-comment-composer";
import type { ReviewCommentLocation } from "@/lib/review-selection";
import { submitReviewAction, submitReviewComment } from "@/lib/workspace-review-actions";
import { reviewThreadLocation } from "@/lib/review-threads";
import { HostyLoader, HostyEmptySlots } from "../../../../../shared/web/hosty-states";
import { cn } from "@/lib/utils";
const WorkspaceDiffView = dynamic(() => import("./workspace-diff-view"), { ssr: false, loading: () => <ReviewLoading>Loading diff viewer…</ReviewLoading> });
export type { ReviewChoice } from "@/lib/workspace-review-api";
const viewedStorageKey = "hosty.review-viewed";
function readViewed(): Record<string, string> {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(viewedStorageKey) ?? "null");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  } catch { return {}; }
}
function saveViewed(key: string, revision: string) {
  try {
    const value = readViewed();
    if (revision) value[key] = revision;
    else delete value[key];
    if (Object.keys(value).length) sessionStorage.setItem(viewedStorageKey, JSON.stringify(value));
    else sessionStorage.removeItem(viewedStorageKey);
  } catch { /* Viewed remains available in the mounted review when browser storage is unavailable. */ }
}
export function WorkspaceReview({ workspaceId, tree: initialTree, choice, onChoice, onBack, onAsk }: {
  workspaceId: string; tree: Worktree; choice: ReviewChoice; onChoice: (choice: ReviewChoice) => void; onBack: () => void; onAsk?: (reference: string) => void;
}) {
  const [refreshed, setRefreshed] = useState<Worktree | null>(null);
  const tree = refreshed ?? initialTree;
  const { view, path, comparePr } = choice;
  const [commentOpen, setCommentOpen] = useState(false);
  const commentTrigger = useRef<HTMLButtonElement>(null);
  const [commentFocus, setCommentFocus] = useState<{ scope: string; token: string } | null>(null);
  const [commentSelection, setCommentSelection] = useState<{ revision: string; location: ReviewCommentLocation } | null>(null);
  const [refreshing, setRefreshing] = useState(false), [refreshError, setRefreshError] = useState("");
  const refreshAbort = useRef<AbortController | null>(null);
  const [retry, setRetry] = useState(0), [diffRetry, setDiffRetry] = useState(0);
  const [layout, setLayout] = useState<"unified" | "split">("unified"), [wrap, setWrap] = useState(true), [fileOpen, setFileOpen] = useState(!!choice.path);
  const [viewed, setViewed] = useState<Record<string, string>>(readViewed);
  const [inventoryResult, setInventoryResult] = useState<{ key: string; value?: ReviewInventory; error?: string } | null>(null);
  const [result, setResult] = useState<{ key: string; value?: ReviewDiff; error?: string } | null>(null);
  const inventoryKey = JSON.stringify([workspaceId, tree.id, tree.observationRevision, tree.observation?.at, view, comparePr, retry]);
  const inventory = inventoryResult?.key === inventoryKey ? inventoryResult.value : undefined;
  const inventoryError = inventoryResult?.key === inventoryKey ? inventoryResult.error : undefined;
  const files = inventory ? reviewFiles(inventory) : [];
  const selected = path || files[0]?.path;
  const selectedFile = files.find(file => file.path === selected);
  const index = files.findIndex(file => file.path === selected);
  const revision = inventory?.source.revision ?? "";
  const key = JSON.stringify([inventoryKey, revision, selected, diffRetry]);
  const diffResult = result?.key === key ? result.value : undefined;
  const diff = diffResult?.diff;
  const error = result?.key === key ? result.error : undefined;
  const back = useRef<HTMLButtonElement>(null);
  const fileKey = (name: string) => JSON.stringify([inventory?.viewerId ?? null, workspaceId, tree.id, view, comparePr ?? null, name]);
  const markViewed = (checked: boolean) => {
    if (!selected || (!diff && !selectedFile?.reviewOnly)) return;
    const key = fileKey(selected), next = checked ? revision : "";
    setViewed(previous => ({ ...previous, [key]: next }));
    // Only an authenticated viewer can restore progress; unknown legacy viewers stay local.
    if (inventory?.viewerId) saveViewed(key, next);
  };
  const totals = changeTotals(files.filter(file => !file.reviewOnly));
  useEffect(() => { back.current?.focus(); return () => refreshAbort.current?.abort(); }, []);
  useEffect(() => {
    const controller = new AbortController();
    void readReview(workspaceId, tree, view, controller.signal, comparePr).then(value => { if (!controller.signal.aborted) setInventoryResult({ key: inventoryKey, value }); })
      .catch(cause => { if (!controller.signal.aborted) setInventoryResult({ key: inventoryKey, error: cause instanceof Error ? cause.message : String(cause) }); });
    return () => controller.abort();
  // The key includes every source observation used by the compatibility path.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inventoryKey]);
  useEffect(() => {
    if (!inventory || !selected || !selectedFile || selectedFile.reviewOnly) return;
    const controller = new AbortController();
    void readReviewDiff(workspaceId, tree, view, selected, inventory, controller.signal).then(value => {
      if (!controller.signal.aborted) {
        if (value.source.revision !== inventory.source.revision) throw new Error("The review source changed. Refresh files before reviewing it.");
        setResult({ key, value });
      }
    }).catch(cause => { if (!controller.signal.aborted) setResult({ key, error: cause instanceof Error ? cause.message : String(cause) }); });
    return () => controller.abort();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const refresh = () => {
    refreshAbort.current?.abort(); const controller = new AbortController(); refreshAbort.current = controller;
    setRefreshing(true); setRefreshError("");
    void developmentRequest<Worktree>(`/${workspaceId}/worktrees/${tree.id}?refresh=true`, undefined, controller.signal)
      .then(value => { if (!controller.signal.aborted) { setRefreshed(value); setRetry(n => n + 1); } })
      .catch(cause => { if (!controller.signal.aborted) setRefreshError(cause instanceof Error ? cause.message : String(cause)); })
      .finally(() => { if (!controller.signal.aborted) setRefreshing(false); });
  };
  const select = (next: string) => { onChoice({ ...choice, path: next }); setFileOpen(true); };
  const source = inventory?.source;
  const canAct = !!source?.published && !inventory?.truncated && !inventory?.unavailable && inventory?.observation?.state === "open";
  const action = (kind: "reply" | "resolve") => async (thread: { id: string }, requestId: string, body?: string) => {
    if (!source) return;
    await submitReviewAction(workspaceId, tree.id, source, kind, thread.id, requestId, body, canAct);
    setRetry(n => n + 1);
  };
  const actions: ReviewThreadActions = {
    onThreadAsk: onAsk && source ? thread => onAsk(`Review thread reference\n${JSON.stringify({ source: source.scope, pullRequest: source.pullRequestUrl, threadId: thread.id, file: thread.path, start: { side: thread.startDiffSide ?? thread.diffSide, line: thread.startLine ?? thread.line }, end: { side: thread.diffSide, line: thread.line }, originalStartLine: thread.originalStartLine, originalLine: thread.originalLine, location: reviewThreadLocation(thread), headRevision: source.head, revision: source.revision, outdated: !!thread.outdated }, null, 2)}`) : undefined,
    canStartThreadActions: canAct,
    threadStorageScope: JSON.stringify([inventory?.viewerId, workspaceId, tree.id, source?.pullRequestUrl]),
    onReply: source?.published ? (thread, body, requestId) => action("reply")(thread, requestId, body) : undefined,
    onResolve: source?.published ? (thread, requestId) => action("resolve")(thread, requestId) : undefined,
    threadActionsUnavailable: "Reply and Resolve require a complete, current observation of an open PR. Refresh this review or open GitHub.",
  };
  const threads = inventory && selected ? fileThreads(inventory, selected, diffResult) : [];
  const globalThreads = inventory?.threads.filter(thread => !thread.path) ?? [];
  const publishedPr = source?.pullRequestUrl;
  const evidencePr = publishedPr ?? source?.publishedComparisonUrl;
  const prNumber = evidencePr?.split("/").at(-1) ?? "PR";
  const commentScope = source?.published && source.pullRequestUrl ? JSON.stringify([inventory?.viewerId, workspaceId, tree.id, source.pullRequestUrl]) : null;
  const evidenceChoices = tree.pullRequests.filter(pr => !pr.observation || pr.observation.state === "open" || pr.url === comparePr);
  return <section aria-label="Workspace review" onKeyDown={event => { if (event.key === "Escape" && !event.defaultPrevented && !(event.target instanceof Element && event.target.closest('[role="menu"], [role="listbox"], [data-slot="popover-content"], [data-slot="dialog-content"]'))) { event.preventDefault(); onBack(); } }} className="harness-review flex min-h-0 min-w-0 flex-1 flex-col bg-background">
    <header className="flex shrink-0 flex-wrap items-center gap-2 border-b px-3 py-2"><Button ref={back} size="sm" variant="ghost" onClick={onBack}><ArrowLeft className="size-4" />Back to session</Button><span className="text-muted-foreground">/</span><h2 className="min-w-0 truncate text-sm font-semibold">{repositoryName(tree.repository)} · Review</h2>{source?.published && <Badge variant="outline">Published PR</Badge>}{source?.published && source.notPublished && <Badge variant="outline">Local changes not published</Badge>}{source?.published && <Button ref={commentTrigger} size="sm" variant="outline" onClick={() => { if (commentScope) setCommentFocus({ scope: commentScope, token: crypto.randomUUID() }); setCommentOpen(true); }}>New comment</Button>}</header>
    {refreshError && <p role="alert" className="border-b p-3 text-sm text-destructive-foreground">{refreshError}</p>}
    {commentOpen && source?.published && commentScope && <ReviewCommentComposer storageScope={commentScope} focusRequest={commentFocus?.scope === commentScope ? commentFocus.token : null} onFocusHandled={() => setCommentFocus(current => current?.scope === commentScope ? null : current)} head={source.head ?? ""} location={commentSelection?.revision === revision && commentSelection.location.path === selected ? commentSelection.location : null} prNumber={prNumber} pullRequestUrl={source.pullRequestUrl!} canStart={canAct} onAsk={onAsk} onClose={reason => { setCommentOpen(false); if (reason === "dismiss") commentTrigger.current?.focus(); }} onPosted={() => setRetry(n => n + 1)} onSubmit={(pending, recovering) => submitReviewComment(workspaceId, tree.id, { ...source, head: pending.head }, { ...pending.location, body: pending.body }, pending.requestId, canAct, recovering)} />}
    <div className="flex min-h-0 flex-1">
      <nav aria-label="Changed files" className={cn("min-h-0 w-full shrink-0 overflow-y-auto border-r md:w-64", fileOpen && "hidden md:block")}>
        <div className="space-y-3 border-b p-3"><label className="block text-xs font-semibold" htmlFor={`review-scope-${tree.id}`}>What to review</label>
          <Select value={view} onValueChange={value => { onChoice({ ...choice, view: value }); setFileOpen(false); }}><SelectTrigger id={`review-scope-${tree.id}`} aria-label="Diff scope" className="w-full"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="session">All workspace changes</SelectItem><SelectItem value="local">Uncommitted changes</SelectItem><SelectItem value="target">Since {tree.targetBranch || "target branch"}</SelectItem>{tree.pullRequests.filter(pr => !pr.observation || pr.observation.state === "open" || view === `pr:${pr.url}`).map(pr => <SelectItem key={pr.url} value={`pr:${pr.url}`}>{pr.observation?.state === "merged" ? "Merged PR" : pr.observation?.state === "closed" ? "Closed PR" : pr.observation?.draft ? "Draft PR" : "PR"}: {pr.observation?.title || pr.url}</SelectItem>)}</SelectContent></Select>
          {!view.startsWith("pr:") && (evidenceChoices.length ? <div className="space-y-1"><label className="block text-xs font-semibold" htmlFor={`review-evidence-${tree.id}`}>Published-line comparison</label><Select value={comparePr || "none"} onValueChange={value => onChoice({ ...choice, comparePr: value === "none" ? undefined : value })}><SelectTrigger id={`review-evidence-${tree.id}`} aria-label="Published-line comparison" className="w-full"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="none">No PR comparison</SelectItem>{evidenceChoices.map(pr => <SelectItem key={pr.url} value={pr.url}>PR #{pr.url.split("/").at(-1)}: {pr.observation?.title || pr.url}</SelectItem>)}</SelectContent></Select><p className="text-xs text-muted-foreground">Choose the PR head used to mark unpublished working lines.</p></div> : <p className="text-xs text-muted-foreground">Unpublished-line markers require a bound PR.</p>)}
          <Button size="sm" variant="outline" disabled={refreshing} onClick={refresh}>{refreshing ? "Refreshing…" : "Refresh files"}</Button>
          {source && <><p className="text-xs text-muted-foreground">{source.label}</p><p className="break-all font-mono text-xs text-muted-foreground">{(source.mergeBase ?? source.base)?.slice(0, 12) || "Base unavailable"} → {source.published ? source.head?.slice(0, 12) || "Head unavailable" : `Working tree${source.head ? ` (HEAD ${source.head.slice(0, 12)})` : ""}`}</p><p className="text-xs text-muted-foreground">Observed: {source.observedAt ? new Date(source.observedAt).toLocaleString() : "unavailable"}. Refresh after source edits.</p>{source.published && source.notPublished && <p className="text-xs text-muted-foreground">Workspace contents differ from the published head.</p>}</>}
          {publishedPr && /^https:\/\//.test(publishedPr) && <a href={publishedPr} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-xs underline">Open PR on GitHub<ExternalLink className="size-3" /></a>}
          {inventory && <><p className="flex flex-wrap gap-2 text-xs tabular-nums"><span>{files.length} files</span>{totals ? <><span className="text-success-foreground">+{totals.additions}</span><span className="text-destructive-foreground">−{totals.deletions}</span></> : <span className="text-muted-foreground">Statistics unavailable</span>}</p><p className="text-xs tabular-nums text-muted-foreground">{files.filter(file => viewed[fileKey(file.path)] === revision).length} of {files.length} viewed · {inventory.threads.filter(thread => !thread.resolved).length} unresolved</p></>}
          {inventory?.truncated && <p role="status" className="text-xs text-warning-foreground">This inventory is incomplete.</p>}{inventory?.unavailable && <p role="alert" className="text-xs text-destructive-foreground">{inventory.unavailable}</p>}
          {inventoryError && <div role="alert" className="space-y-2 text-xs"><p>{inventoryError}</p><Button variant="outline" size="sm" onClick={() => setRetry(n => n + 1)}>Retry review</Button></div>}
        </div>
        {!inventory && !inventoryError && <ReviewLoading>Loading review…</ReviewLoading>}
        {files.map(file => <Button key={file.path} type="button" variant="ghost" title={file.path} aria-current={selected === file.path ? "true" : undefined} onClick={() => select(file.path)} className={cn("h-auto w-full justify-start gap-2 rounded-none px-3 py-3 text-left", selected === file.path && "bg-brand-soft")}>
          {viewed[fileKey(file.path)] === revision ? <Check className="size-4 shrink-0" aria-label="Viewed" /> : <FileDiff className="size-4 shrink-0 text-muted-foreground" />}<span className="min-w-0 flex-1 break-all whitespace-normal font-mono text-xs font-normal">{file.path}{file.reviewOnly && <span className="block font-sans text-muted-foreground">Comments only</span>}</span>
          {inventory && inventory.threads.some(thread => thread.path === file.path) && <span className="flex items-center gap-1 text-xs tabular-nums" aria-label={`${inventory.threads.filter(thread => thread.path === file.path).length} threads`}><MessageSquare className="size-3" />{inventory.threads.filter(thread => thread.path === file.path).length}</span>}
          {file.lineStats && <span className="shrink-0 font-mono text-xs font-normal tabular-nums"><span className="text-success-foreground">+{file.lineStats.additions}</span><br /><span className="text-destructive-foreground">−{file.lineStats.deletions}</span></span>}
        </Button>)}
        {inventory && !files.length && <div className="flex flex-col items-center gap-2 p-5 text-center text-sm text-muted-foreground"><HostyEmptySlots className="size-10" /><p>No changes in this scope.</p></div>}
        {globalThreads.length > 0 && <div className="space-y-2 p-3"><h3 className="text-xs font-semibold">Other review threads</h3>{globalThreads.map(thread => <ReviewThreadCard key={thread.id} thread={thread} {...actions} />)}</div>}
      </nav>
      <div className={cn("min-h-0 min-w-0 flex-1 flex-col", fileOpen ? "flex" : "hidden md:flex")}>
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b px-3 py-2"><Button className="md:hidden" size="sm" variant="ghost" onClick={() => setFileOpen(false)}><ArrowLeft className="size-4" />Files</Button><span className="order-last min-w-0 basis-full flex-1 break-all font-mono text-xs md:order-none md:basis-auto">{selected ?? "No file selected"}</span><label className="flex items-center gap-1.5 text-xs"><Checkbox disabled={!diff && !selectedFile?.reviewOnly} checked={!!selected && viewed[fileKey(selected)] === revision} onCheckedChange={checked => markViewed(checked === true)} />Viewed</label><Button size="icon-sm" variant="ghost" aria-label="Previous file" disabled={index <= 0} onClick={() => select(files[index - 1].path)}><ChevronLeft /></Button><Button size="icon-sm" variant="ghost" aria-label="Next file" disabled={index < 0 || index >= files.length - 1} onClick={() => select(files[index + 1].path)}><ChevronRight /></Button></div>
        <div className="flex shrink-0 flex-wrap items-center gap-1 border-b px-3 py-1"><div role="group" aria-label="Diff layout" className="flex gap-1">{(["unified", "split"] as const).map(value => <Button key={value} size="sm" variant={layout === value ? "secondary" : "ghost"} aria-pressed={layout === value} onClick={() => setLayout(value)}>{value === "unified" ? "Unified" : "Split"}</Button>)}</div><Button size="sm" variant={wrap ? "secondary" : "ghost"} aria-pressed={wrap} onClick={() => setWrap(!wrap)}>Wrap lines</Button></div>
        <div className="min-h-0 min-w-0 flex-1 overflow-auto">
          {error && <div role="alert" className="space-y-2 p-3 text-sm"><p>{error}</p><Button variant="outline" size="sm" onClick={() => setDiffRetry(n => n + 1)}>Retry diff</Button></div>}
          {diff && source ? <WorkspaceDiffView key={key} diff={diff} layout={layout} wrap={wrap} threads={threads} {...actions} publishedEvidence={diffResult?.publishedEvidence} commenting={evidencePr ? { prNumber, enabled: canAct && !diff.truncated && !diff.binary, reason: source.published ? "Refresh an open PR and select a complete published diff." : "Open the published PR diff to comment. Push striped working lines first, or ask Harness." } : undefined} onComment={location => { setCommentSelection({ revision, location }); if (commentScope) setCommentFocus({ scope: commentScope, token: crypto.randomUUID() }); setCommentOpen(true); }} onAsk={onAsk ? range => onAsk(reviewReference({ ...source, base: source.base ?? diff.head ?? null }, diff.path, range)) : undefined} /> : <>
            {!error && !selectedFile?.reviewOnly && <p role="status" className="flex min-w-0 items-start gap-2 p-3 text-sm text-muted-foreground wrap-anywhere">{!inventoryError && (!inventory || !!selected && !!selectedFile) && <HostyLoader label={null} className="mt-0.5 size-4 shrink-0" />}{inventoryError ? "Review unavailable. Open Files to retry or choose another scope." : !inventory ? "Loading review…" : selected && !selectedFile ? "This file has no changes in this scope, or is no longer available. Choose another file or refresh the review." : selected ? "Loading diff…" : "No changes in this scope."}</p>}
            {!!threads.length && <div className="space-y-2 p-3"><p className="text-xs text-muted-foreground">Reviewed lines are unavailable in this preview.</p>{threads.map(thread => <ReviewThreadCard key={thread.id} thread={thread} {...actions} />)}</div>}
          </>}
        </div>
      </div>
    </div>
  </section>;
}

function ReviewLoading({ children }: { children: React.ReactNode }) {
  return <p role="status" className="flex items-center gap-2 p-3 text-sm text-muted-foreground"><HostyLoader label={null} className="size-4 shrink-0" />{children}</p>;
}

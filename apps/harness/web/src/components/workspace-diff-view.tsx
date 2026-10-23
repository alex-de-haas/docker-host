"use client";
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore, type CSSProperties } from "react";
import { preloadHighlighter } from "@pierre/diffs";
import { FileDiff, type DiffLineAnnotation, type FileDiffOptions, type SelectedLineRange } from "@pierre/diffs/react";
import { Button } from "@/components/ui/button";
import { ReviewThreadCard, type ReviewThreadActions } from "@/components/review-thread";
import type { Diff } from "@/lib/development-api";
import { prepareWorkspaceDiff } from "@/lib/workspace-diff";
import { commentLocation, markUnpublishedRows, unpublishedLineCSS, type ReviewCommentLocation } from "@/lib/review-selection";
import type { PublishedEvidence } from "@/lib/workspace-review-api";
import { placeReviewThreads, type ReviewThread } from "@/lib/review-threads";

const noThreads: ReviewThread[] = [];
const style = { "--diffs-font-family": "var(--font-mono)", "--diffs-font-size": "13px", "--diffs-line-height": "20px", "--diffs-selection-base": "var(--brand-strong)", "--diffs-bg-selection-number-override": "var(--brand-strong)", "--diffs-selection-number-fg": "#0f1b2d" } as CSSProperties;
const readTheme = () => document.documentElement.classList.contains("dark") ? "dark" : "light";
const serverTheme = () => "light" as const;
function subscribeTheme(notify: () => void) {
  const observer = new MutationObserver(notify);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  return () => observer.disconnect();
}
function ThreadGroup({ title, description, threads, actions }: { title: string; description?: string; threads: ReviewThread[]; actions: ReviewThreadActions }) {
  return threads.length ? <section aria-label={title} className="space-y-2 border-b p-3">
    <h3 className="text-xs font-semibold">{title} <span className="font-normal tabular-nums text-muted-foreground">({threads.length})</span></h3>
    {description && <p className="text-xs text-muted-foreground">{description}</p>}
    {threads.map(thread => <ReviewThreadCard key={thread.id} thread={thread} {...actions} />)}
  </section> : null;
}

export default function WorkspaceDiffView({ diff, layout, wrap, onAsk, threads = noThreads, onThreadAsk, onResolve, onReply, threadActionsUnavailable, canStartThreadActions, threadStorageScope, publishedEvidence, commenting, onComment }: {
  diff: Diff; layout: "unified" | "split"; wrap: boolean; onAsk?: (range: SelectedLineRange) => void; threads?: ReviewThread[]; publishedEvidence?: PublishedEvidence | null;
  commenting?: { prNumber: string; enabled: boolean; reason?: string }; onComment?: (location: ReviewCommentLocation) => void;
} & ReviewThreadActions) {
  const [selection, setSelection] = useState<SelectedLineRange | null>(null);
  const theme = useSyncExternalStore(subscribeTheme, readTheme, serverTheme);
  const [highlighter, setHighlighter] = useState<"loading" | "ready" | "failed">("loading");
  useEffect(() => {
    let active = true;
    void preloadHighlighter({ themes: ["pierre-light", "pierre-dark"], langs: ["text"] }).then(
      () => { if (active) setHighlighter("ready"); },
      () => { if (active) setHighlighter("failed"); },
    );
    return () => { active = false; };
  }, []);
  const preview = useMemo(() => prepareWorkspaceDiff(diff), [diff]);
  const placement = useMemo(() => placeReviewThreads(threads, preview.kind === "diff" && highlighter === "ready" ? preview.file : undefined), [threads, preview, highlighter]);
  const annotations = useMemo(() => {
    const groups = new Map<string, DiffLineAnnotation<ReviewThread[]>>();
    for (const { thread, side, lineNumber } of placement.inline) {
      const key = `${side}:${lineNumber}`;
      const group = groups.get(key);
      if (group) group.metadata.push(thread);
      else groups.set(key, { side, lineNumber, metadata: [thread] });
    }
    return [...groups.values()];
  }, [placement]);
  const selectedLocation = selection && preview.kind === "diff" ? commentLocation(preview.file, selection) : null;
  const options = useMemo<FileDiffOptions<ReviewThread[], undefined>>(() => ({
    diffStyle: layout, overflow: wrap ? "wrap" : "scroll", diffIndicators: "bars", lineDiffType: "word-alt",
    enableLineSelection: !!onAsk || !!commenting, onLineSelectionEnd: setSelection,
    hunkSeparators: "line-info-basic", disableFileHeader: true,
    unsafeCSS: unpublishedLineCSS,
    onPostRender: (node, _instance, phase) => { if (phase !== "unmount") markUnpublishedRows(node, publishedEvidence); },
    theme: { light: "pierre-light", dark: "pierre-dark" }, themeType: theme,
  }), [layout, wrap, theme, onAsk, commenting, publishedEvidence]);
  const renderAnnotation = useCallback((annotation: DiffLineAnnotation<ReviewThread[]>) => <div className="space-y-2 p-2">{annotation.metadata.map(thread => <ReviewThreadCard key={thread.id} thread={thread} onThreadAsk={onThreadAsk} onResolve={onResolve} onReply={onReply} threadActionsUnavailable={threadActionsUnavailable} canStartThreadActions={canStartThreadActions} threadStorageScope={threadStorageScope} />)}</div>, [onThreadAsk, onResolve, onReply, threadActionsUnavailable, canStartThreadActions, threadStorageScope]);
  const actions = { onThreadAsk, onResolve, onReply, threadActionsUnavailable, canStartThreadActions, threadStorageScope };
  return <div role="region" aria-label={`Changes in ${diff.path}`} className="min-w-0">
    {publishedEvidence && <p className="border-b px-3 py-2 text-xs text-muted-foreground" role="status">{publishedEvidence.complete ? publishedEvidence.unpublishedRanges.length ? `Striped working lines are not in PR #${publishedEvidence.pullRequestUrl.split("/").at(-1)} head ${publishedEvidence.head.slice(0, 12)}. Push before commenting, or ask Harness.` : "All working lines in this file match the selected published head." : `Unpublished-line evidence is unavailable: ${publishedEvidence.unavailable || "refresh the review to retry"}.`}</p>}
    <ThreadGroup title="File comments" threads={placement.file} actions={actions} />
    <ThreadGroup title="Outdated threads" description="These comments belong to an earlier revision and are not attached to current lines." threads={placement.outdated} actions={actions} />
    <ThreadGroup title="Threads outside this preview" description="The exact reviewed lines are unavailable in this preview. Their comments and actions are retained here." threads={placement.unplaced} actions={actions} />
    {preview.kind === "text" ? <div className="space-y-2 p-3 text-xs">
      <p className="text-muted-foreground">{preview.message}</p>
      {preview.content && <pre className="overflow-x-auto font-mono text-xs">{preview.content}</pre>}
    </div> : highlighter === "loading" ? <p role="status" className="p-3 text-sm text-muted-foreground">Loading diff viewer…</p> : highlighter === "failed" ? <div className="space-y-2 p-3 text-xs">
      <p className="text-muted-foreground">The diff viewer could not load. The original preview is shown below.</p>
      <pre className="overflow-x-auto font-mono text-xs">{diff.combined}</pre>
    </div> : <>
      {selection && <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2 border-b bg-background p-2 text-xs"><span className="tabular-nums">Lines {selection.start}–{selection.end}</span>{onAsk && <Button size="sm" variant="outline" onClick={() => onAsk(selection)}>Ask Harness</Button>}{commenting && <Button size="sm" variant="outline" disabled={!commenting.enabled || !selectedLocation || !onComment} title={!commenting.enabled ? commenting.reason : !selectedLocation ? "Select a single-side range inside one rendered PR hunk." : undefined} onClick={() => { if (selectedLocation) onComment?.(selectedLocation); }}>Comment on #{commenting.prNumber}</Button>}<Button size="sm" variant="ghost" onClick={() => setSelection(null)}>Clear selection</Button>{commenting && (!commenting.enabled || !selectedLocation) && <p className="basis-full text-muted-foreground">{!commenting.enabled ? commenting.reason : "Select lines on one side inside a published PR hunk."}</p>}</div>}
      <FileDiff fileDiff={preview.file} options={options} selectedLines={selection} lineAnnotations={annotations} renderAnnotation={renderAnnotation} style={style} />
    </>}
  </div>;
}

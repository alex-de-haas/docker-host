"use client";
import { useEffect, useMemo, useState, useSyncExternalStore, type CSSProperties } from "react";
import { preloadHighlighter } from "@pierre/diffs";
import { FileDiff, type FileDiffOptions } from "@pierre/diffs/react";
import type { Diff } from "@/lib/development-api";
import { prepareWorkspaceDiff } from "@/lib/workspace-diff";

const style = { "--diffs-font-family": "var(--font-mono)", "--diffs-font-size": "12px", "--diffs-line-height": "20px" } as CSSProperties;
const readTheme = () => document.documentElement.classList.contains("dark") ? "dark" : "light";
const serverTheme = () => "light" as const;
function subscribeTheme(notify: () => void) {
  const observer = new MutationObserver(notify);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  return () => observer.disconnect();
}

export default function WorkspaceDiffView({ diff, untracked, layout, wrap }: {
  diff: Diff; untracked: boolean; layout: "unified" | "split"; wrap: boolean;
}) {
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
  const preview = useMemo(() => prepareWorkspaceDiff(diff, untracked), [diff, untracked]);
  const options = useMemo<FileDiffOptions<undefined, undefined>>(() => ({
    diffStyle: layout, overflow: wrap ? "wrap" : "scroll", diffIndicators: "bars", lineDiffType: "word-alt",
    hunkSeparators: "line-info-basic", disableFileHeader: true,
    theme: { light: "pierre-light", dark: "pierre-dark" }, themeType: theme,
  }), [layout, wrap, theme]);
  if (preview.kind === "text") return <div className="space-y-2 p-3 text-xs">
    <p className="text-muted-foreground">{preview.message}</p>
    {preview.content && <pre className="overflow-x-auto">{preview.content}</pre>}
  </div>;
  if (highlighter === "loading") return <p role="status" className="p-3 text-sm text-muted-foreground">Loading diff viewer…</p>;
  if (highlighter === "failed") return <div className="space-y-2 p-3 text-xs">
    <p className="text-muted-foreground">The diff viewer could not load. The original preview is shown below.</p>
    <pre className="overflow-x-auto">{diff.combined}</pre>
  </div>;
  return <div role="region" aria-label={`Changes in ${diff.path}`} className="min-w-0">
    <FileDiff fileDiff={preview.file} options={options} style={style} />
  </div>;
}

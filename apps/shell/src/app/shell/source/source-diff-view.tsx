"use client";

import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { preloadHighlighter } from "@pierre/diffs";
import { FileDiff, type FileDiffOptions } from "@pierre/diffs/react";
import { useTheme } from "next-themes";
import { prepareSourceDiff, type SourceDiffInput } from "./source-diff-data";

const diffStyle = {
  "--diffs-font-family": "var(--font-mono)",
  "--diffs-font-size": "12px",
  "--diffs-line-height": "20px",
} as CSSProperties;

export default function SourceDiffView({ path, content, untracked, truncated }: SourceDiffInput) {
  const { resolvedTheme } = useTheme();
  const [highlighter, setHighlighter] = useState<"loading" | "ready" | "failed">("loading");
  useEffect(() => {
    let active = true;
    // Have the themes ready before mounting, including for unknown file extensions.
    void preloadHighlighter({ themes: ["pierre-light", "pierre-dark"], langs: ["text"] }).then(
      () => { if (active) setHighlighter("ready"); },
      () => { if (active) setHighlighter("failed"); },
    );
    return () => { active = false; };
  }, []);
  const preview = useMemo(() => prepareSourceDiff({ path, content, untracked, truncated }), [path, content, untracked, truncated]);
  const options = useMemo<FileDiffOptions<undefined, undefined>>(() => ({
    diffStyle: "unified",
    diffIndicators: "classic",
    theme: { light: "pierre-light", dark: "pierre-dark" },
    themeType: resolvedTheme === "dark" ? "dark" : "light",
    disableFileHeader: true,
    overflow: "scroll",
    hunkSeparators: "metadata",
  }), [resolvedTheme]);

  if (preview.kind === "text") return <div className="space-y-2">
    <p className="px-3 py-2 text-xs text-muted-foreground">{preview.message}</p>
    {content && !(untracked && content === "New binary file") && <pre className="overflow-x-auto bg-muted p-3 text-xs">{content}</pre>}
  </div>;

  if (highlighter === "loading") return <p role="status" className="p-3 text-sm text-muted-foreground">Loading diff viewer…</p>;
  if (highlighter === "failed") return <div className="space-y-2">
    <p className="px-3 py-2 text-xs text-muted-foreground">The diff viewer could not load. The original preview is shown below.</p>
    <pre className="overflow-x-auto bg-muted p-3 text-xs">{content}</pre>
  </div>;

  return <div role="region" aria-label={`Changes in ${path}`} className="min-w-0">
    <FileDiff fileDiff={preview.file} options={options} style={diffStyle} />
  </div>;
}

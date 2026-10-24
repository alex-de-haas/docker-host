import { cn } from "@/lib/utils";
import type { SourceLineStats } from "./source-preview-data";

export function SourceChangeSummary({ fileCount, truncated, lineStats, className }: {
  fileCount: number; truncated?: boolean; lineStats?: SourceLineStats | null; className?: string;
}) {
  return <span className={cn("flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-xs text-muted-foreground", className)}>
    {fileCount > 0 && lineStats && <span className="inline-flex shrink-0 gap-2 whitespace-nowrap font-mono tabular-nums"
      role="img" aria-label={`${lineStats.additions} lines added, ${lineStats.deletions} lines deleted`}>
      <span aria-hidden="true" className="text-green-700 dark:text-green-400">+{lineStats.additions}</span>
      <span aria-hidden="true" className="text-red-700 dark:text-red-400">−{lineStats.deletions}</span>
    </span>}
    <span className="whitespace-nowrap">{fileCount}{truncated ? "+" : ""} files</span>
  </span>;
}

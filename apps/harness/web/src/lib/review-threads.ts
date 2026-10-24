import type { FileDiffMetadata } from "@pierre/diffs";

export type ReviewThreadComment = {
  id: string;
  body: string;
  authorLogin?: string | null;
  authorKind?: string | null;
  createdAt?: string | null;
  url?: string | null;
  databaseId?: number | null;
};

export type ReviewThread = {
  id: string;
  path: string;
  line?: number | null;
  resolved: boolean;
  comments: string[];
  originalLine?: number | null;
  startLine?: number | null;
  originalStartLine?: number | null;
  diffSide?: string | null;
  startDiffSide?: string | null;
  outdated?: boolean;
  subjectType?: string | null;
  commentsComplete?: boolean;
  details?: ReviewThreadComment[];
  // This is independent evidence of overlap, never evidence that a review is fixed.
  changedLocally?: boolean;
};

export type PlacedReviewThread = { thread: ReviewThread; lineNumber: number; side: "additions" | "deletions" };
export type ReviewThreadPlacement = {
  inline: PlacedReviewThread[];
  file: ReviewThread[];
  outdated: ReviewThread[];
  unplaced: ReviewThread[];
};

const positiveLine = (line: number | null | undefined): line is number => typeof line === "number" && Number.isSafeInteger(line) && line > 0;

// GitHub coordinates refer to the published patch. Never reuse original/outdated coordinates
// as if they belonged to the current head, or attach a comment to a hidden gap in a partial diff.
export function placeReviewThreads(threads: ReviewThread[], file?: FileDiffMetadata): ReviewThreadPlacement {
  const result: ReviewThreadPlacement = { inline: [], file: [], outdated: [], unplaced: [] };
  for (const thread of threads) {
    if (thread.outdated) { result.outdated.push(thread); continue; }
    if (thread.subjectType?.toUpperCase() === "FILE") { result.file.push(thread); continue; }
    const side = thread.diffSide === "RIGHT" ? "additions" : thread.diffSide === "LEFT" ? "deletions" : null;
    const end = thread.line;
    const start = thread.startLine ?? end;
    const matchingPath = file && (thread.path === file.name || (side === "deletions" && thread.path === file.prevName));
    const matchingSide = !thread.startDiffSide || thread.startDiffSide === thread.diffSide;
    const hunk = side && positiveLine(start) && positiveLine(end) && start <= end && matchingPath && matchingSide
      ? file.hunks.find(h => {
        const first = side === "additions" ? h.additionStart : h.deletionStart;
        const count = side === "additions" ? h.additionCount : h.deletionCount;
        return count > 0 && start >= first && end < first + count;
      }) : undefined;
    if (hunk && side && positiveLine(end)) result.inline.push({ thread, lineNumber: end, side });
    else result.unplaced.push(thread);
  }
  return result;
}

export function reviewThreadLocation(thread: ReviewThread): string {
  const line = thread.outdated ? thread.originalLine ?? thread.line : thread.line;
  const start = thread.outdated ? thread.originalStartLine ?? thread.startLine : thread.startLine;
  const side = thread.diffSide === "LEFT" ? "old" : thread.diffSide === "RIGHT" ? "new" : undefined;
  if (thread.subjectType?.toUpperCase() === "FILE") return `${thread.path} · File`;
  if (!positiveLine(line)) return thread.path;
  const range = positiveLine(start) && start !== line ? `${start}–${line}` : `${line}`;
  return `${thread.path}:${range}${side ? ` · ${side}` : ""}`;
}

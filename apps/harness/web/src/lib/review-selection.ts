import type { FileDiffMetadata, SelectedLineRange } from "@pierre/diffs";
import type { PublishedEvidence } from "./workspace-review-api";
export type ReviewCommentLocation = { path: string; diffSide: "LEFT" | "RIGHT"; startLine: number; line: number };
export function commentLocation(file: FileDiffMetadata, range: SelectedLineRange): ReviewCommentLocation | null {
  const side = range.side ?? "additions", endSide = range.endSide ?? side;
  const startLine = Math.min(range.start, range.end), line = Math.max(range.start, range.end);
  if (side !== endSide || !Number.isSafeInteger(startLine) || !Number.isSafeInteger(line) || startLine < 1) return null;
  const hunk = file.hunks.some(h => {
    const first = side === "additions" ? h.additionStart : h.deletionStart;
    const count = side === "additions" ? h.additionCount : h.deletionCount;
    return count > 0 && startLine >= first && line < first + count;
  });
  return hunk ? { path: file.name, diffSide: side === "deletions" ? "LEFT" : "RIGHT", startLine, line } : null;
}
// The viewer owns this DOM and explicitly calls its post-render extension after updates.
export function markUnpublishedRows(container: HTMLElement, evidence?: PublishedEvidence | null) {
  const root = container.shadowRoot ?? container;
  root.querySelectorAll<HTMLElement>("[data-hosty-unpublished]").forEach(row => { row.removeAttribute("data-hosty-unpublished"); row.removeAttribute("title"); });
  if (!evidence?.complete) return;
  const ranges = evidence.unpublishedRanges;
  const selector = '[data-additions] [data-line], [data-additions] [data-column-number], [data-unified] [data-line]:not([data-line-type="change-deletion"]), [data-unified] [data-column-number]:not([data-line-type="change-deletion"])';
  root.querySelectorAll<HTMLElement>(selector).forEach(row => {
    const line = Number(row.getAttribute("data-line") ?? row.getAttribute("data-column-number"));
    if (Number.isSafeInteger(line) && ranges.some(range => line >= range.startLine && line <= range.endLine)) {
      row.setAttribute("data-hosty-unpublished", ""); row.title = "Not in the selected PR head. Push before commenting, or ask Harness.";
    }
  });
}
export const unpublishedLineCSS = '[data-hosty-unpublished]{box-shadow:inset 3px 0 color-mix(in srgb,var(--diffs-fg) 30%,transparent);background-image:repeating-linear-gradient(135deg,transparent 0 3px,color-mix(in srgb,var(--diffs-fg) 9%,transparent) 3px 5px);background-size:8px 100%;background-repeat:no-repeat}';

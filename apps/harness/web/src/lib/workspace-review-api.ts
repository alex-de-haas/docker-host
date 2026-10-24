"use client";
import { developmentRequest, DevelopmentRequestError, type Change, type Diff, type PullRequest, type Worktree } from "./development-api";
import type { ReviewThread } from "./review-threads";
export type ReviewSource = {
  scope: string; label: string; base: string | null; head: string | null; mergeBase?: string | null;
  targetBranch?: string | null; pullRequestUrl?: string | null; observedAt: string; revision: string;
  publishedComparisonUrl?: string | null; publishedComparisonHead?: string | null;
  published: boolean; localHead?: string | null; notPublished: boolean;
};
export type ReviewFile = Change & { reviewOnly?: boolean };
export type ReviewInventory = { viewerId?: string; source: ReviewSource; files: ReviewFile[]; threads: ReviewThread[];
  truncated: boolean; unavailable?: string | null; observation?: PullRequest["observation"]; legacy?: boolean };
export type PublishedEvidence = { pullRequestUrl: string; head: string; complete: boolean; unpublishedRanges: { startLine: number; endLine: number }[]; unavailable?: string | null };
export type ReviewDiff = { publishedEvidence?: PublishedEvidence | null; source: ReviewSource; diff: Diff; localRanges: { startLine: number; endLine: number }[]; localRangesComplete: boolean };
export type ReviewChoice = { view: string; path: string; comparePr?: string };
export function reviewQuery(view: string, comparePr?: string): URLSearchParams {
  return new URLSearchParams(view.startsWith("pr:") ? { scope: "pull-request", pullRequestUrl: view.slice(3) } : { scope: view, ...(comparePr ? { pullRequestUrl: comparePr } : {}) });
}
export function reviewRoot(workspaceId: string, treeId: string) { return `/${workspaceId}/worktrees/${treeId}`; }
export async function readReview(workspaceId: string, tree: Worktree, view: string, signal: AbortSignal, comparePr?: string): Promise<ReviewInventory> {
  try {
    const result = await developmentRequest<ReviewInventory>(`${reviewRoot(workspaceId, tree.id)}/review?${reviewQuery(view, comparePr)}`, undefined, signal);
    if (!result?.source?.revision || !Array.isArray(result.files) || !Array.isArray(result.threads)) throw new Error("Core returned an invalid review response.");
    if (comparePr && !view.startsWith("pr:") && (result.source.publishedComparisonUrl !== comparePr || !result.source.publishedComparisonHead)) throw new Error("Core did not return the selected published-line comparison. Refresh or choose no PR comparison.");
    return result;
  } catch (error) {
    // Compatibility is only for an absent endpoint, never for denied access or a malformed reply.
    if (!(error instanceof DevelopmentRequestError) || error.status !== 404 || !["workspace_failed", "not_found"].includes(error.code ?? "")) throw error;
    if (comparePr || !["local", "session"].includes(view)) throw new DevelopmentRequestError("PR and target-branch review are unavailable on this Core. Workspace changes remain available.", "review_api_unavailable", 409);
    return { legacy: true, source: { scope: view, label: view === "session" ? "All workspace changes" : "Uncommitted changes", base: null,
      head: tree.observation?.head ?? null, observedAt: tree.observation?.at ?? "", revision: tree.observationRevision ?? tree.observation?.at ?? "legacy",
      published: false, notPublished: true }, files: view === "session" ? tree.sessionChanges ?? [] : tree.observation?.local?.files ?? [], threads: [], truncated: !!tree.observation?.local?.truncated };
  }
}
export async function readReviewDiff(workspaceId: string, tree: Worktree, view: string, path: string, inventory: ReviewInventory, signal: AbortSignal): Promise<ReviewDiff> {
  if (inventory.legacy) return { source: inventory.source,
    diff: await developmentRequest<Diff>(`${reviewRoot(workspaceId, tree.id)}/diff?${new URLSearchParams({ path, view })}`, undefined, signal), localRanges: [], localRangesComplete: false };
  const query = reviewQuery(view, inventory.source.publishedComparisonUrl ?? undefined); query.set("path", path); query.set("revision", inventory.source.revision);
  const result = await developmentRequest<ReviewDiff>(`${reviewRoot(workspaceId, tree.id)}/review/diff?${query}`, undefined, signal);
  if (!result?.source?.revision || !result.diff || result.diff.path !== path || typeof result.diff.combined !== "string" || !Array.isArray(result.localRanges)
    || typeof result.localRangesComplete !== "boolean" || result.localRanges.some(range => !Number.isSafeInteger(range.startLine) || !Number.isSafeInteger(range.endLine) || range.startLine < 1 || range.endLine < range.startLine))
    throw new Error("Core returned an invalid review diff response.");
  const evidence = result.publishedEvidence;
  if (inventory.source.publishedComparisonUrl && !evidence) throw new Error("Core did not return published-line evidence. Refresh this review.");
  if (evidence && (typeof evidence.complete !== "boolean" || !evidence.pullRequestUrl || !evidence.head || !Array.isArray(evidence.unpublishedRanges)
    || evidence.unpublishedRanges.some(range => !Number.isSafeInteger(range.startLine) || !Number.isSafeInteger(range.endLine) || range.startLine < 1 || range.endLine < range.startLine)
    || evidence.pullRequestUrl !== inventory.source.publishedComparisonUrl || evidence.head !== inventory.source.publishedComparisonHead))
    throw new Error("Core returned invalid published-line evidence. Refresh the review.");
  return result;
}
export function reviewFiles(inventory: ReviewInventory): ReviewFile[] {
  const files = [...inventory.files]; const paths = new Set(files.map(file => file.path));
  // Reviews of unchanged, renamed or removed files must remain selectable.
  for (const thread of inventory.threads) if (thread.path && !paths.has(thread.path)) {
    paths.add(thread.path); files.push({ path: thread.path, status: "", reviewOnly: true });
  }
  return files;
}
export function fileThreads(inventory: ReviewInventory, path: string, result?: ReviewDiff | null): ReviewThread[] {
  return inventory.threads.filter(thread => thread.path === path).map(thread => {
    const end = thread.line, start = thread.startLine ?? end;
    const changedLocally = result?.source.published && result.localRangesComplete && !thread.outdated && thread.diffSide === "RIGHT"
      && (!thread.startDiffSide || thread.startDiffSide === "RIGHT") && start != null && end != null && Number.isSafeInteger(start) && Number.isSafeInteger(end) && start > 0 && start <= end
      && result.localRanges.some(range => end >= range.startLine && start <= range.endLine);
    return { ...thread, changedLocally: !!changedLocally };
  });
}
export function reviewReference(source: ReviewSource, path: string, range: { start: number; end: number; side?: string; endSide?: string }): string {
  return `Review reference\n${JSON.stringify({ source: source.scope, pullRequest: source.pullRequestUrl ?? null, file: path,
    start: { side: range.side ?? "additions", line: range.start }, end: { side: range.endSide ?? range.side ?? "additions", line: range.end },
    baseRevision: source.mergeBase ?? source.base, headRevision: source.head, revision: source.revision,
    published: source.published }, null, 2)}`;
}

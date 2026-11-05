import type { PullRequest } from "./development-api";
import { checkResult } from "./pull-request-checks";
export function checkCounts(pr: PullRequest) {
  const checks = !pr.unavailable ? pr.observation?.checks : undefined;
  const counts = { passed: 0, failed: 0, pending: 0, skipped: 0, unknown: 0, total: checks?.length ?? 0, completed: 0 };
  for (const check of checks ?? []) {
    const result = checkResult(check.state);
    const skipped = ["SKIPPED", "NEUTRAL"].includes(check.state.toUpperCase());
    counts[skipped ? "skipped" : result.kind]++; if (result.completed) counts.completed++;
  }
  return { ...counts, available: checks !== undefined };
}
export const isTerminalPullRequest = (state?: string) => state === "merged" || state === "closed";
export const hasRetainedCi = (pr: PullRequest, stale: boolean) => !!pr.historical || stale && isTerminalPullRequest(pr.observation?.state);
export function ciPresentation(pr: PullRequest, stale: boolean) {
  const counts = checkCounts(pr);
  if (!pr.observation || pr.unavailable) return { label: "CI unknown", color: "text-muted-foreground", kind: "unknown" as const, counts };
  if (stale || pr.historical) return { label: hasRetainedCi(pr, stale) ? "CI last observed" : "CI outdated", color: "text-muted-foreground", kind: "unknown" as const, counts };
  const completion = completionPresentation(pr, stale);
  if (completion) return { ...completion, counts };
  if (!counts.available || pr.observation?.error) return { label: "CI unknown", color: "text-muted-foreground", kind: "unknown" as const, counts };
  if (!counts.total) return { label: "No CI checks", color: "text-muted-foreground", kind: "unknown" as const, counts };
  if (counts.failed) return { label: `CI ${counts.failed} failed`, color: "text-destructive-foreground", kind: "failed" as const, counts };
  if (counts.pending) return { label: `CI ${counts.completed} of ${counts.total} · ${counts.pending} running`, color: "text-info-foreground", kind: "pending" as const, counts };
  if (counts.unknown) return { label: "CI unknown", color: "text-muted-foreground", kind: "unknown" as const, counts };
  if (counts.passed) return { label: "CI passed", color: "text-success-foreground", kind: "passed" as const, counts };
  return { label: "CI skipped", color: "text-muted-foreground", kind: "unknown" as const, counts };
}
export function prStateLabel(pr: PullRequest): string {
  if (!pr.observation || pr.unavailable) return "State unknown";
  const state = pr.observation.state;
  return state === "open" ? pr.observation.draft ? "Draft" : "Open" : state === "merged" ? "Merged" : state === "closed" ? "Closed" : "State unknown";
}
export const reviewDecisionLabel = (value: string) => value.toLowerCase().replaceAll("_", " ").replace(/^./, c => c.toUpperCase());

// Completion evidence belongs to the merge commit; the check list above it describes the PR head.
export function completionPresentation(pr: PullRequest, stale: boolean) {
  const issue = pr.observation?.completionIssue;
  if (!issue || pr.unavailable || pr.observation?.state !== "merged" || pr.observation.complete) return null;
  const ci = issue.kind === "check" || issue.kind === "workflow";
  const subject = ci ? "post-merge CI" : "publication";
  if (stale || pr.historical) return { label: "Post-merge status last observed", kind: "unknown" as const, color: "text-muted-foreground",
    message: `PR merged. The last observation could not confirm ${subject} (${issue.requirement}). Current results have not been checked yet.` };
  if (issue.state === "missing" || issue.state === "pending") return { label: ci ? "Waiting for post-merge CI" : "Waiting for publication", kind: "pending" as const, color: "text-info-foreground",
    message: `PR merged. Waiting for ${subject}: ${issue.requirement}. ${issue.state === "missing" ? "No result reported yet." : "Still in progress."}` };
  if (issue.state === "failed") return { label: ci ? "Post-merge CI failed" : "Publication failed", kind: "failed" as const, color: "text-destructive-foreground",
    message: `PR merged. ${ci ? "Post-merge CI" : "Publication"} reported an unsuccessful result: ${issue.requirement}.` };
  return { label: "Post-merge status unavailable", kind: "unknown" as const, color: "text-muted-foreground",
    message: `PR merged. Could not confirm ${subject}: ${issue.requirement}. Check again or inspect the result on GitHub.` };
}

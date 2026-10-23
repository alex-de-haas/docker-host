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
export function ciPresentation(pr: PullRequest, stale: boolean) {
  const counts = checkCounts(pr);
  if (!pr.observation || pr.unavailable) return { label: "CI unknown", color: "text-muted-foreground", kind: "unknown" as const, counts };
  if (stale || pr.historical) return { label: pr.historical ? "CI last observed" : "CI outdated", color: "text-muted-foreground", kind: "unknown" as const, counts };
  if (!counts.available || pr.observation?.error || pr.observation?.complete === false) return { label: "CI unknown", color: "text-muted-foreground", kind: "unknown" as const, counts };
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

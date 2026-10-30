"use client";
import { appFetch } from "@hosty-sdk/app/browser-auth";

export type PrReceipt = { schemaVersion: 1; revision: string; observedAt?: string; lastSuccessAt?: string; nextAttemptAt?: string;
  freshness: "fresh" | "stale" | "refreshing" | "delayed" | "unavailable"; completeness: "complete" | "partial" | "unknown"; reason?: string };
export type PrApp = { id: string; name: string };
export type PrRepository = { id: string; provider: string; name: string; url: string; apps: PrApp[]; receipt: PrReceipt };
export type PrRepositories = { repositories: PrRepository[]; coverage: { apps: PrApp[]; state: string; message: string }[]; receipt: PrReceipt };
export type PrRef = { repositoryId: string; number: number };
export type PrCheck = { id: string; name: string; state: "passed" | "failed" | "running" | "pending" | "skipped" | "neutral" | "cancelled" | "unknown"; url?: string };
export type PrChecks = { items: PrCheck[]; total: number | null; completeness: string; cursor?: string | null };
export type PrSummary = PrRef & { providerId: string; title: string; url: string; author: string; bot: boolean; draft: boolean;
  state: string; updatedAt: string; head: string; base: string; headBranch: string; baseBranch: string; reviewDecision: string;
  mergeState: string; commentCount?: number | null; checks: PrChecks; receipt: PrReceipt };
export type PrPage = { items: PrSummary[]; cursor?: string | null; loaded: number; total?: number | null; receipt: PrReceipt };
export type PrDetail = { pullRequest: PrSummary; description?: string | null; descriptionTruncated: boolean;
  links: { kind: string; id: string; label: string }[]; receipt: PrReceipt };
export type PrReview = { items: { id: string; author: string; state: string; body?: string; url?: string }[]; total?: number;
  cursor?: string | null; receipt: PrReceipt };
export type PrDiff = { head: string; base: string; mergeBase: string; receipt: PrReceipt;
  files: { path: string; status: string; previousPath?: string; patch?: string | null; additions: number; deletions: number }[] };
export type PrScope = { allInstalled?: boolean; repositories?: string[]; pullRequests?: PrRef[]; workspaces?: string[] };
export class PrError extends Error {
  constructor(message: string, readonly code?: string, readonly status?: number) { super(message); }
}
export async function prRequest<T>(path = "", body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await appFetch(`/api/pull-requests${path}`, { method: body === undefined ? "GET" : "POST", signal,
    cache: "no-store", credentials: "include", ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
  const value = await response.json();
  if (!response.ok) throw new PrError(value.message ?? "Pull requests are unavailable.", value.code, response.status);
  return value;
}
export const prKey = (pr: PrRef) => `${pr.repositoryId}:${pr.number}`;
export const prPath = (pr: PrRef) => `/${encodeURIComponent(pr.repositoryId)}/${pr.number}`;
export function checkCounts(checks: PrChecks) {
  const counts = { passed: 0, failed: 0, running: 0, pending: 0, skipped: 0, neutral: 0, cancelled: 0, unknown: 0 };
  for (const check of checks.items) counts[check.state in counts ? check.state : "unknown"]++;
  const completed = counts.passed + counts.failed + counts.skipped + counts.neutral + counts.cancelled;
  return { ...counts, completed, total: checks.total, partial: checks.completeness !== "complete" };
}
export function checkSummary(checks: PrChecks) {
  const c = checkCounts(checks);
  if (checks.completeness === "unknown") return "CI unknown";
  if (c.total === 0 && checks.completeness === "complete") return "No checks reported";
  return [`${c.completed}/${c.total ?? "?"} completed`, `${c.passed} passed`, c.failed && `${c.failed} failed`,
    c.running + c.pending > 0 && `${c.running + c.pending} active`, c.skipped && `${c.skipped} skipped`,
    c.neutral && `${c.neutral} neutral`, c.cancelled && `${c.cancelled} cancelled`, c.unknown && `${c.unknown} unknown`,
    c.partial && "partial"].filter(Boolean).join(" · ");
}

export type PrAction = "merge" | "update-branch";
export type PrActions = { head: string; base: string; state: string; draft: boolean; mergeState: string;
  merge: { enabled: boolean; reason?: string }; updateBranch: { enabled: boolean; reason?: string };
  autoMerge: "enabled" | "disabled" | "unavailable"; autoMergeMethod?: string; observedAt: string; pendingCommand?: PrCommand; pendingResult?: PrCommandResult };
export type PrCommand = { requestId: string; action: PrAction; head: string; base: string };
export type PrCommandResult = { requestId: string; action: PrAction; state: "pending" | "unknown" | "failed" | "merged" | "updated" | "enqueued"; message: string };
export function compactCi(pr: PrSummary) {
  const c = checkCounts(pr.checks);
  const stale = pr.receipt.freshness !== "fresh";
  const label = stale ? "CI outdated" : pr.checks.completeness === "unknown" ? "CI unknown" :
    c.total === 0 && !c.partial ? "No CI checks" : `CI ${c.completed}/${c.total ?? "?"}${c.partial ? "+" : ""}${c.failed ? ` · ${c.failed} failed` : c.pending + c.running ? ` · ${c.pending + c.running} running` : c.cancelled ? ` · ${c.cancelled} cancelled` : ""}`;
  const color = stale || c.partial || c.unknown || !c.total ? "text-muted-foreground" : c.failed || c.cancelled ? "text-destructive-foreground" :
    c.pending + c.running ? "text-info-foreground" : c.passed ? "text-success-foreground" : "text-muted-foreground";
  return { label, color, stale };
}

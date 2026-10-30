import { checkCounts, type PrChecks } from "@/lib/pull-requests-api";
import { cn } from "@/lib/utils";

export function PullRequestCheckSummary({ checks, stale = false, actionLabel = "Show checks" }: { checks: PrChecks; stale?: boolean; actionLabel?: string }) {
  const c = checkCounts(checks), unknown = checks.completeness === "unknown";
  const summary = unknown ? "unknown" : `${c.completed}/${c.total ?? "?"}${c.partial ? "+ observed" : ""}`;
  const outcomes = unknown ? "Check results unavailable" : [
    `${c.passed} passed`, `${c.pending + c.running} in progress`, `${c.skipped} skipped`,
    c.failed && `${c.failed} failed`, c.neutral && `${c.neutral} neutral`, c.cancelled && `${c.cancelled} cancelled`,
    c.unknown && `${c.unknown} unknown`, c.partial && "partial results", stale && "outdated",
  ].filter(Boolean).join(" · ");
  return <span className="flex min-w-0 flex-1 flex-col gap-2">
    <span className="flex items-center justify-between gap-2 text-xs"><span>CI {summary}</span><span className="text-muted-foreground">{actionLabel}</span></span>
    <span className="flex h-1.5 w-full gap-0.5 overflow-hidden rounded-full" aria-hidden>
      {checks.items.length ? checks.items.map(check => <span key={check.id} className={cn("min-w-px flex-1", stale ? "bg-muted-foreground/30" :
        check.state === "passed" ? "bg-success-foreground" : check.state === "failed" || check.state === "cancelled" ? "bg-destructive" :
        check.state === "running" || check.state === "pending" ? "bg-info-foreground" : "bg-muted-foreground/30")} />) : <span className="flex-1 bg-muted-foreground/20" />}
      {c.partial && checks.items.length > 0 && <span className="flex-1 bg-muted-foreground/20" />}
    </span><span className="text-left text-xs font-normal text-muted-foreground">{outcomes}</span>
  </span>;
}

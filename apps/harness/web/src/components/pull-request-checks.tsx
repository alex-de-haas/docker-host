"use client";
import { CheckCircle2, CircleHelp, Clock3, XCircle } from "lucide-react";
import type { PullRequest } from "@/lib/development-api";
import { checkResult } from "@/lib/pull-request-checks";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverDescription, PopoverHeader, PopoverTitle, PopoverTrigger } from "@/components/ui/popover";

const indicators = {
  passed: { Icon: CheckCircle2, color: "text-success" },
  failed: { Icon: XCircle, color: "text-destructive" },
  pending: { Icon: Clock3, color: "text-warning" },
  unknown: { Icon: CircleHelp, color: "text-muted-foreground" },
};

export function PullRequestChecks({ pr, stale, label }: { pr: PullRequest; stale: boolean; label: string }) {
  const checks = pr.unavailable ? undefined : pr.observation?.checks;
  const completed = checks?.filter(check => checkResult(check.state).completed).length ?? 0;
  const summary = checks ? `${completed}/${checks.length}` : "unknown";
  return <Popover>
    <PopoverTrigger asChild><Button type="button" variant="link" size="sm" className="h-auto p-0"
      aria-label={`${label}: CI ${summary}, show checks`} title="Completed checks / total checks">CI {summary}</Button></PopoverTrigger>
    <PopoverContent align="start" collisionPadding={12} aria-label={`${label}: CI checks`}
      className="flex max-h-[min(24rem,var(--radix-popover-content-available-height))] w-[min(24rem,calc(100vw-2rem))] flex-col gap-3 overflow-y-auto">
      <PopoverHeader><PopoverTitle>CI checks</PopoverTitle><PopoverDescription>{label}{checks ? ` · ${completed}/${checks.length} completed` : ""}</PopoverDescription></PopoverHeader>
      {stale && <p className="text-xs text-muted-foreground">These results are outdated or have not been observed yet.</p>}
      {(pr.unavailable || pr.observation?.error) && <p className="text-xs text-destructive">{pr.unavailable || pr.observation?.error}</p>}
      {!checks ? <p className="text-sm text-muted-foreground">Check results are unavailable.</p> : checks.length === 0
        ? <p className="text-sm text-muted-foreground">No CI checks reported.</p>
        : <ul className="flex flex-col gap-2 text-sm">{checks.map((check, index) => {
          const result = checkResult(check.state), { Icon, color } = indicators[result.kind];
          return <li key={`${index}:${check.name}`} className="flex items-start gap-2">
            <Icon aria-hidden="true" className={cn("mt-0.5 size-4 shrink-0", color)} />
            <span className="min-w-0 flex-1 break-words">{check.name}</span>
            <span className="shrink-0 text-xs text-muted-foreground">{result.label}</span>
          </li>;
        })}</ul>}
    </PopoverContent>
  </Popover>;
}

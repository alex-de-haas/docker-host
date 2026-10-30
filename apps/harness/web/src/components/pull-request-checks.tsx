"use client";
import { useState, useSyncExternalStore } from "react";
import { CheckCircle2, CircleHelp, Clock3, XCircle, X, MinusCircle } from "lucide-react";
import type { PullRequest } from "@/lib/development-api";
import { checkResult } from "@/lib/pull-request-checks";
import { PullRequestCheckSummary } from "./pull-request-check-summary";
import type { PrCheck } from "@/lib/pull-requests-api";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverDescription, PopoverHeader, PopoverTitle, PopoverTrigger } from "@/components/ui/popover";

const indicators = {
  passed: { Icon: CheckCircle2, color: "text-success-foreground" },
  failed: { Icon: XCircle, color: "text-destructive-foreground" },
  pending: { Icon: Clock3, color: "text-info-foreground" },
  unknown: { Icon: CircleHelp, color: "text-muted-foreground" },
};

const phoneQuery = "(max-width: 599px)";
const readPhone = () => window.matchMedia?.(phoneQuery).matches ?? false;
const subscribePhone = (notify: () => void) => {
  const media = window.matchMedia?.(phoneQuery); media?.addEventListener("change", notify);
  return () => media?.removeEventListener("change", notify);
};
const serverPhone = () => false;
export function PullRequestChecks({ pr, stale, label, segmented = false }: { pr: PullRequest; stale: boolean; label: string; segmented?: boolean }) {
  const phone = useSyncExternalStore(subscribePhone, readPhone, serverPhone);
  const [expanded, setExpanded] = useState(false);
  const checks = pr.unavailable ? undefined : pr.observation?.checks;
  const completed = checks?.filter(check => checkResult(check.state).completed).length ?? 0;
  const summary = checks ? `${completed}/${checks.length}` : "unknown";
  const cached = stale || !!pr.historical;
  const normalized: PrCheck[] = (checks ?? []).map((check, index) => ({ id: String(index), name: check.name,
    state: check.state.toUpperCase() === "NEUTRAL" ? "neutral" : check.state.toUpperCase() === "SKIPPED" ? "skipped" :
      check.state.toUpperCase() === "CANCELLED" ? "cancelled" : checkResult(check.state).kind }));
  const triggerContent = segmented ? <PullRequestCheckSummary checks={{ items: normalized, total: checks?.length ?? null, completeness: checks ? "complete" : "unknown" }} stale={cached} /> : <>CI {summary}</>;
  const triggerClass = segmented ? "h-auto w-full justify-start p-0 hover:bg-transparent" : "h-auto p-0";
  const content = <>
      {stale && <p className="text-xs text-muted-foreground">These results are outdated or have not been observed yet.</p>}
      {(pr.unavailable || pr.observation?.error) && <p className="text-xs text-destructive-foreground">{pr.unavailable || pr.observation?.error}</p>}
      {!checks ? <p className="text-sm text-muted-foreground">Check results are unavailable.</p> : checks.length === 0
        ? <p className="text-sm text-muted-foreground">No CI checks reported.</p>
        : <ul className="flex flex-col gap-2 text-sm">{checks.map((check, index) => {
          const result = checkResult(check.state), skipped = ["SKIPPED", "NEUTRAL"].includes(check.state.toUpperCase());
          const { Icon: StatusIcon, color } = indicators[result.kind], Icon = skipped ? MinusCircle : StatusIcon;
          return <li key={`${index}:${check.name}`} className="flex items-start gap-2">
            <Icon aria-hidden="true" className={cn("mt-0.5 size-4 shrink-0", cached || skipped ? "text-muted-foreground" : color)} />
            <span className="min-w-0 flex-1 wrap-anywhere">{check.name}</span>
            <span className="shrink-0 text-xs text-muted-foreground">{result.label}</span>
          </li>;
        })}</ul>}
  </>;
  if (phone) return <div className="inline-block w-full">
    <Button variant={segmented ? "ghost" : "link"} size="sm" className={triggerClass} aria-label={`${label}: CI ${summary}, show checks`} aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>{triggerContent}</Button>
    {expanded && <div role="region" aria-label={`${label}: CI checks`} className="mt-2 block space-y-2 rounded-md border bg-background p-3">{content}<Button size="sm" variant="ghost" onClick={() => setExpanded(false)}>Hide checks</Button></div>}
  </div>;
  return <Popover open={expanded} onOpenChange={setExpanded}>
    <PopoverTrigger asChild><Button type="button" variant={segmented ? "ghost" : "link"} size="sm" className={triggerClass}
      aria-label={`${label}: CI ${summary}, show checks`} title="Completed checks / total checks">{triggerContent}</Button></PopoverTrigger>
    <PopoverContent side="left" sideOffset={12} align="start" collisionPadding={12} aria-label={`${label}: CI checks`}
      className="flex max-h-[min(24rem,var(--radix-popover-content-available-height))] w-[min(24rem,calc(100vw-2rem))] flex-col gap-3 overflow-y-auto">
      <div className="flex items-start gap-2"><PopoverHeader className="min-w-0 flex-1"><PopoverTitle>CI checks</PopoverTitle><PopoverDescription>{label}{checks ? ` · ${completed}/${checks.length} completed` : ""}</PopoverDescription></PopoverHeader><Button type="button" size="icon-sm" variant="ghost" aria-label="Close CI checks" onClick={() => setExpanded(false)}><X className="size-3.5" /></Button></div>
      {content}

    </PopoverContent>
  </Popover>;
}

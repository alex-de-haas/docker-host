"use client";

import { useId, type ReactNode } from "react";
import { Bot, ChevronDown, ChevronRight } from "lucide-react";
import { Markdown } from "@/components/markdown";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";

export type SubagentStatus = { label: string; detail?: string; failed?: boolean };

const summaryOrder = ["Running", "Waiting for input", "Queued", "Starting", "Completed", "Failed", "Cancelled", "Unknown"];

export function SubagentGroup({ label, parent, statuses, children }: { label: string; parent?: string; statuses: SubagentStatus[]; children: ReactNode }) {
  const counts = new Map<string, number>();
  const sorted = [...statuses].sort((a, b) =>
    summaryOrder.indexOf(a.label) - summaryOrder.indexOf(b.label) || (a.detail ?? "").localeCompare(b.detail ?? ""));
  for (const status of sorted) {
    const label = status.detail && status.label !== "Unknown" ? `${status.label} (${status.detail})` : status.label;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const summary = Array.from(counts, ([label, count]) => `${count} ${label.toLowerCase()}`).join(" · ");

  return <Collapsible asChild>
    <section aria-label={label} className="min-w-0">
      <CollapsibleTrigger asChild>
        <Button type="button" variant="ghost" size="sm" className="group h-auto min-h-8 w-full min-w-0 justify-start gap-2 px-2 text-left text-xs text-muted-foreground">
          <Bot className="size-3.5 shrink-0" aria-hidden />
          <span className="shrink-0 font-medium tabular-nums">{statuses.length} {statuses.length === 1 ? "subagent" : "subagents"}</span>
          <span className="min-w-0 truncate font-normal tabular-nums">
            {parent && parent !== "Main agent" && <span>From {parent} · </span>}{summary}
          </span>
          <ChevronDown className="ml-auto size-3.5 shrink-0 group-data-[state=open]:rotate-180" aria-hidden />
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="ml-3 flex min-w-0 flex-col gap-1 border-l pl-3 pt-1">
        {children}
      </CollapsibleContent>
    </section>
  </Collapsible>;
}

export function SubagentRow({ label, status, children }: { label: string; status: SubagentStatus; children: ReactNode }) {
  const statusDetailId = useId();
  return <Collapsible className="min-w-0">
    <CollapsibleTrigger asChild>
      <Button type="button" variant="ghost" size="sm" className="group h-auto min-h-8 w-full min-w-0 justify-start gap-2 px-1 text-left text-xs"
        aria-label={`${label}: ${status.label}. Show output`} aria-describedby={status.detail ? statusDetailId : undefined}>
        <ChevronRight className="size-3.5 shrink-0 group-data-[state=open]:rotate-90" aria-hidden />
        <span className="min-w-0 truncate" title={label}>{label}</span>
        <Badge variant="outline" className={status.failed ? "text-destructive-foreground" : undefined}>{status.label}</Badge>
        {status.detail && <span id={statusDetailId} className="min-w-0 truncate font-normal text-muted-foreground" title={status.detail}>{status.detail}</span>}
      </Button>
    </CollapsibleTrigger>
    <CollapsibleContent className="ml-2 min-w-0 border-l px-3 py-2">
      {children}
    </CollapsibleContent>
  </Collapsible>;
}

export function SubagentExchange({ prompt, result, promptTruncated, resultTruncated }: {
  prompt?: string; result?: string; promptTruncated?: boolean; resultTruncated?: boolean;
}) {
  return <dl className="flex min-w-0 flex-col gap-1 text-sm">
    <dt className="text-xs font-medium text-muted-foreground">Prompt{promptTruncated && " (partial)"}</dt>
    <dd className="whitespace-pre-wrap wrap-anywhere">{prompt ?? "Prompt unavailable."}</dd>
    <dt className="mt-2 text-xs font-medium text-muted-foreground">Final response{resultTruncated && " (partial)"}</dt>
    <dd className="min-w-0 wrap-anywhere">{result ? <Markdown text={result} /> : "No final response recorded."}</dd>
  </dl>;
}

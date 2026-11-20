"use client";

import { useId } from "react";
import { Bot, ChevronDown, ChevronRight } from "lucide-react";
import { Markdown } from "@/components/markdown";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { isNativeDecision, nativeAgentStatus, type NativeAgent, type NativeAgentGroup } from "@/lib/native-subagents";
import { transcriptItems, type TranscriptItem } from "@/lib/transcript-items";
import { ToolActivity, ToolRow, TranscriptEvent, type TranscriptReviewContext } from "./transcript";

type TranscriptDisplay = { appNames?: Record<string, string>; reviewContext?: TranscriptReviewContext };

const summaryOrder = ["Running", "Waiting for input", "Queued", "Completed", "Failed", "Cancelled", "Unknown"];

export function NativeSubagents({ group, connected, unobservedRunId, ...display }: TranscriptDisplay & {
  group: NativeAgentGroup; connected: boolean; unobservedRunId?: string;
}) {
  const agents = group.agents.map(agent => ({
    agent, status: nativeAgentStatus(agent, connected && agent.source.runId !== unobservedRunId),
  }));
  const counts = new Map<string, number>();
  const statuses = agents.map(({ status }) => status).sort((a, b) =>
    summaryOrder.indexOf(a.label) - summaryOrder.indexOf(b.label) || (a.detail ?? "").localeCompare(b.detail ?? ""));
  for (const status of statuses) {
    const label = status.detail && status.label !== "Unknown" ? `${status.label} (${status.detail})` : status.label;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const parent = group.agents[0]?.parentLabel;
  const summary = Array.from(counts, ([label, count]) => `${count} ${label.toLowerCase()}`).join(" · ");

  return <Collapsible asChild>
    <section aria-label="Provider subagents" className="min-w-0">
      <CollapsibleTrigger asChild>
        <Button type="button" variant="ghost" size="sm" className="group h-auto min-h-8 w-full min-w-0 justify-start gap-2 px-2 text-left text-xs text-muted-foreground">
          <Bot className="size-3.5 shrink-0" aria-hidden />
          <span className="shrink-0 font-medium tabular-nums">{agents.length} {agents.length === 1 ? "subagent" : "subagents"}</span>
          <span className="min-w-0 truncate font-normal tabular-nums">
            {parent && parent !== "Main agent" && <span>From {parent} · </span>}{summary}
          </span>
          <ChevronDown className="ml-auto size-3.5 shrink-0 group-data-[state=open]:rotate-180" aria-hidden />
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="ml-3 flex min-w-0 flex-col gap-1 border-l pl-3 pt-1">
        {agents.map(({ agent, status }) => <SubagentRow key={agent.key} agent={agent} status={status} {...display} />)}
      </CollapsibleContent>
    </section>
  </Collapsible>;
}

function SubagentRow({ agent, status, ...display }: TranscriptDisplay & { agent: NativeAgent; status: ReturnType<typeof nativeAgentStatus> }) {
  const statusDetailId = useId();
  return <Collapsible className="min-w-0">
    <CollapsibleTrigger asChild>
      <Button type="button" variant="ghost" size="sm" className="group h-auto min-h-8 w-full min-w-0 justify-start gap-2 px-1 text-left text-xs"
        aria-label={`${agent.label}: ${status.label}. Show output`} aria-describedby={status.detail ? statusDetailId : undefined}>
        <ChevronRight className="size-3.5 shrink-0 group-data-[state=open]:rotate-90" aria-hidden />
        <span className="min-w-0 truncate" title={agent.label}>{agent.label}</span>
        <Badge variant="outline" className={status.failed ? "text-destructive-foreground" : undefined}>{status.label}</Badge>
        {status.detail && <span id={statusDetailId} className="min-w-0 truncate font-normal text-muted-foreground" title={status.detail}>{status.detail}</span>}
      </Button>
    </CollapsibleTrigger>
    <CollapsibleContent className="ml-2 min-w-0 border-l px-3 py-2">
      <SubagentDetails agent={agent} {...display} />
    </CollapsibleContent>
  </Collapsible>;
}

function SubagentDetails({ agent, appNames, reviewContext }: TranscriptDisplay & { agent: NativeAgent }) {
  const launch = transcriptItems(agent.launchEvents ?? [], new Set());
  const items = transcriptItems(agent.events.filter(event => !isNativeDecision(event) && event.seq !== agent.resultMessageSeq), new Set());
  return <div className="flex min-w-0 flex-col gap-3">
    <p className="text-xs text-muted-foreground">From {agent.parentLabel} · {agent.lastAction}</p>
    <dl className="flex min-w-0 flex-col gap-1 text-sm">
      <dt className="text-xs font-medium text-muted-foreground">Prompt{agent.promptTruncated && " (partial)"}</dt>
      <dd className="whitespace-pre-wrap wrap-anywhere">{agent.prompt ?? "Prompt unavailable."}</dd>
      <dt className="mt-2 text-xs font-medium text-muted-foreground">Final response{agent.resultTruncated && " (partial)"}</dt>
      <dd className="min-w-0 wrap-anywhere">{agent.result ? <Markdown text={agent.result} /> : "No final response recorded."}</dd>
    </dl>
    {(items.length > 0 || agent.streamed) && <div className="flex min-w-0 flex-col gap-2">
      <p className="text-xs font-medium text-muted-foreground">Activity</p>
      <ChildTranscript items={items} appNames={appNames} reviewContext={reviewContext} />
      {agent.streamed && <div className="rounded-lg bg-muted/60 px-3 py-2"><Markdown text={agent.streamed} streaming /></div>}
    </div>}
    {launch.length > 0 && <div className="min-w-0">
      <p className="text-xs font-medium text-muted-foreground">Launch by {agent.parentLabel}</p>
      <ChildTranscript items={launch} launch appNames={appNames} reviewContext={reviewContext} />
    </div>}
  </div>;
}

function ChildTranscript({ items, launch, appNames, reviewContext }: TranscriptDisplay & { items: TranscriptItem[]; launch?: boolean }) {
  return items.map(item => {
    if (item.kind === "event") return <TranscriptEvent key={item.key} event={item.event} decision={null} answers={null} denyReason={false}
      onDecide={async () => {}} onAnswer={async () => {}} appNames={appNames} reviewContext={reviewContext} />;
    if (launch) return item.events.map(event => <ToolRow key={event.seq} toolName={String(event.toolName)}
      input={event.input} mcp={event.mcp} appNames={appNames} output={item.toolResults[event.seq]} />);
    return <ToolActivity key={item.key} events={item.events} appNames={appNames} reviewContext={reviewContext}
      commandResults={item.commandResults} toolResults={item.toolResults} approvals={item.approvals} />;
  });
}

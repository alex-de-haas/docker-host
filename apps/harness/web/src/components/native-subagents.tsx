"use client";

import { ChevronRight, GitBranch } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Markdown } from "@/components/markdown";
import { nativeAgentStatus, isNativeDecision, type NativeAgentGroup } from "@/lib/native-subagents";
import { transcriptItems } from "@/lib/transcript-items";
import { ToolActivity, TranscriptEvent, type TranscriptReviewContext } from "./transcript";

export function NativeSubagents({ group, connected, appNames, reviewContext }: {
  group: NativeAgentGroup; connected: boolean; appNames?: Record<string, string>; reviewContext?: TranscriptReviewContext;
}) {
  return <section aria-label="Provider subagents" className="flex min-w-0 flex-col gap-2 rounded-lg border p-3">
    <div className="flex items-center gap-2 text-sm font-medium"><GitBranch className="size-4" aria-hidden />
      {group.agents.length} {group.agents.length === 1 ? "subagent" : "subagents"}
    </div>
    {group.agents.map(agent => {
      const status = nativeAgentStatus(agent, connected);
      const items = transcriptItems(agent.events.filter(event => !isNativeDecision(event)), new Set());
      return <Collapsible key={agent.key}>
        <CollapsibleTrigger asChild>
          <Button variant="ghost" className="group h-auto w-full justify-start gap-2 px-1 py-2 text-left" aria-label={`${agent.label}: ${status.label}. Show output`}>
            <ChevronRight aria-hidden data-icon="inline-start" className="shrink-0 group-data-[state=open]:rotate-90" />
            <span className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="flex flex-wrap items-center gap-2"><span className="truncate">{agent.label}</span>
                <Badge variant="secondary">{status.label}</Badge>
                {status.detail && <span className="text-xs text-muted-foreground">{status.detail}</span>}
              </span>
              <span className="truncate text-xs font-normal text-muted-foreground">From {agent.parentLabel} · {agent.lastAction}</span>
            </span>
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent className="flex flex-col gap-3 pb-2 pl-5 pt-2">
          <p className="text-xs text-muted-foreground">Output from {agent.label}</p>
          {items.map(item => item.kind === "activity"
            ? <ToolActivity key={item.key} events={item.events} appNames={appNames} reviewContext={reviewContext} commandResults={item.commandResults} toolResults={item.toolResults} approvals={item.approvals} />
            : <TranscriptEvent key={item.key} event={item.event} decision={null} answers={null} denyReason={false}
              onDecide={async () => {}} onAnswer={async () => {}} appNames={appNames} reviewContext={reviewContext} />)}
          {agent.streamed && <div className="rounded-lg bg-muted/60 px-3 py-2"><Markdown text={agent.streamed} streaming /></div>}
          {!items.length && !agent.streamed && <p className="text-xs text-muted-foreground">No output recorded yet.</p>}
        </CollapsibleContent>
      </Collapsible>;
    })}
  </section>;
}

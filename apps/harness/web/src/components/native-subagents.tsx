"use client";

import { Markdown } from "@/components/markdown";
import { SubagentExchange, SubagentGroup, SubagentRow } from "./subagent-disclosure";
import { isNativeDecision, nativeAgentStatus, type NativeAgent, type NativeAgentGroup } from "@/lib/native-subagents";
import { transcriptItems, type TranscriptItem } from "@/lib/transcript-items";
import { ToolActivity, ToolRow, TranscriptEvent, type TranscriptReviewContext } from "./transcript";

type TranscriptDisplay = { appNames?: Record<string, string>; reviewContext?: TranscriptReviewContext };

export function NativeSubagents({ group, connected, unobservedRunId, ...display }: TranscriptDisplay & {
  group: NativeAgentGroup; connected: boolean; unobservedRunId?: string;
}) {
  const agents = group.agents.map(agent => ({
    agent, status: nativeAgentStatus(agent, connected && agent.source.runId !== unobservedRunId),
  }));
  return <SubagentGroup label="Provider subagents" parent={group.agents[0]?.parentLabel} statuses={agents.map(({ status }) => status)}>
    {agents.map(({ agent, status }) => <SubagentRow key={agent.key} label={agent.label} status={status}>
      <SubagentDetails agent={agent} {...display} />
    </SubagentRow>)}
  </SubagentGroup>;
}

function SubagentDetails({ agent, appNames, reviewContext }: TranscriptDisplay & { agent: NativeAgent }) {
  const launch = transcriptItems(agent.launchEvents ?? [], new Set());
  const items = transcriptItems(agent.events.filter(event => !isNativeDecision(event) && event.seq !== agent.resultMessageSeq), new Set());
  return <div className="flex min-w-0 flex-col gap-3">
    <p className="text-xs text-muted-foreground">From {agent.parentLabel} · {agent.lastAction}</p>
    <SubagentExchange prompt={agent.prompt} promptTruncated={agent.promptTruncated} result={agent.result} resultTruncated={agent.resultTruncated} />
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

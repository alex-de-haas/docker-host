"use client";

import { Files } from "lucide-react";
import type { ContextUsage } from "../../../src/harness/context-usage";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { ContextMcpDetail } from "./context-mcp-detail";
import { UsageRing } from "@/components/usage-ring";

const tokens = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
const percent = new Intl.NumberFormat("en", { maximumFractionDigits: 1 });

export function ContextUsageIndicator({ usage, connected = true }: { usage: ContextUsage | null; connected?: boolean }) {
  const hasDetail = Boolean(usage?.mcp || usage?.sources);
  const percentage = usage?.maxTokens ? usage.usedTokens / usage.maxTokens * 100 : null;
  const count = usage ? `${usage.estimated ? "≈ " : ""}${tokens.format(usage.usedTokens)}` : "";
  const summary = usage
    ? percentage === null ? `${count} tokens · limit unavailable`
      : `${count} / ${tokens.format(usage.maxTokens!)} · ${percent.format(percentage)}%`
    : "Not available";
  const description = usage
    ? `${usage.estimated ? "Estimated context usage" : "Context usage"}: ${usage.usedTokens.toLocaleString("en")} tokens${usage.maxTokens ? ` of ${usage.maxTokens.toLocaleString("en")}` : "; context limit unavailable"}. Last measured ${new Date(usage.observedAt).toLocaleString()}. ${connected ? "Updates as the agent reports usage." : "Disconnected; showing the last measurement."} The window may reflect the provider's compaction limit.`
    : `${connected ? "" : "Disconnected. "}Context usage has not been reported for this session.`;
  const button = <button type="button" aria-label={`Context usage: ${summary}${percentage === null ? "" : " used"}${hasDetail ? usage?.sources ? ". View local context estimates" : ". View MCP detail" : ""}`}
    data-slot="context-usage" className="flex h-9 min-w-9 shrink-0 cursor-pointer items-center justify-center gap-1 rounded-md px-1 font-normal text-muted-foreground outline-none focus-visible:outline-2 focus-visible:outline-brand">
    <UsageRing value={percentage} label="Context window used" valueText={percentage === null ? undefined : `${percent.format(percentage)}% used · ${summary}`}
      className={percentage !== null && percentage >= 100 ? "text-destructive-foreground" : percentage !== null && percentage >= 80 ? "text-warning-foreground" : "text-muted-foreground"}>
      <Files />
    </UsageRing>
    <span aria-hidden="true" className="font-mono text-xs tabular-nums">{percentage === null ? "?" : <>{percent.format(percentage)}%<span className="hidden @min-[640px]/composer:inline"> used</span></>}</span>
  </button>;
  return <TooltipProvider delayDuration={250}>
    <Tooltip>
      {usage && hasDetail ? <ContextMcpDetail detail={usage.mcp} sources={usage.sources} observedAt={usage.observedAt} connected={connected}>
        <TooltipTrigger asChild>{button}</TooltipTrigger>
      </ContextMcpDetail> : <TooltipTrigger asChild>{button}</TooltipTrigger>}
      <TooltipContent className="max-w-xs">
        <p className="font-medium">Context · {summary}</p>
        <p>{description}</p>
        {hasDetail && <p>{usage?.sources ? "Open for local instruction, MCP server and tool estimates." : "Open for MCP server and tool detail."}</p>}
      </TooltipContent>
    </Tooltip>
  </TooltipProvider>;
}

"use client";

import type { ContextUsage } from "../../../src/harness/context-usage";
import { Progress } from "@/components/ui/progress";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

const tokens = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
const percent = new Intl.NumberFormat("en", { maximumFractionDigits: 1 });

export function ContextUsageIndicator({ usage, connected = true }: { usage: ContextUsage | null; connected?: boolean }) {
  const percentage = usage?.maxTokens ? usage.usedTokens / usage.maxTokens * 100 : null;
  const count = usage ? `${usage.estimated ? "≈ " : ""}${tokens.format(usage.usedTokens)}` : "";
  const summary = usage
    ? percentage === null ? `${count} tokens · limit unavailable`
      : `${count} / ${tokens.format(usage.maxTokens!)} · ${percent.format(percentage)}%`
    : "Not available";
  const description = usage
    ? `${usage.estimated ? "Estimated context usage" : "Context usage"}: ${usage.usedTokens.toLocaleString("en")} tokens${usage.maxTokens ? ` of ${usage.maxTokens.toLocaleString("en")}` : ""}. Last measured ${new Date(usage.observedAt).toLocaleString()}. ${connected ? "Updates as the agent reports usage." : "Disconnected; showing the last measurement."} The window may reflect the provider's compaction limit.`
    : "Context usage has not been reported for this session.";

  return (
    <TooltipProvider delayDuration={250}>
      <Tooltip>
        <TooltipTrigger asChild>
          <div tabIndex={0} role="group" aria-label={`Context usage: ${summary}`}
            data-slot="context-usage" className="flex min-w-0 flex-col gap-1 rounded-sm text-xs text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={event => event.preventDefault()}>
            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
              <span>Context</span>
              <span className="tabular-nums">{summary}</span>
            </div>
            {percentage !== null && <Progress value={Math.min(100, percentage)} role="meter" aria-label="Context window used"
              aria-valuetext={`${percent.format(percentage)}% · ${summary}`} className="h-1" />}
          </div>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs">{description}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
